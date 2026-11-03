"""Persistent Gemini browser worker.

One worker owns one Playwright persistent context and two long-lived pages:
chat and research. The Node host talks to it over JSONL on stdin/stdout; all
diagnostics go to stderr. The process starts lazily from the Node client and is
disposed by an explicit shutdown command or process-tree kill.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import threading
import traceback
from typing import Any

from playwright.async_api import async_playwright

from browser import browser_label, default_browser_channel
from chat_page import ChatPage
from research_page import ResearchPage
from selectors import LoginRequired, ModelUnavailable, ThinkingUnavailable, record_login_state

DEFAULT_CHAT_TIMEOUT_SEC = 180
DEFAULT_RESEARCH_TIMEOUT_SEC = 900
HEARTBEAT_INTERVAL_SEC = 10


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def log(message: str) -> None:
    print(f"[gemini-worker] {message}", file=sys.stderr, flush=True)


class Worker:
    def __init__(self, profile_dir: str, headless: bool):
        self.profile_dir = profile_dir
        self.headless = headless
        self.context = None
        self.chat = None
        self.research = None
        self.tasks: dict[str, asyncio.Task] = {}

    async def run(self) -> int:
        channel = default_browser_channel()
        log(f"browser={browser_label(channel)} profile={self.profile_dir}")
        async with async_playwright() as playwright:
            self.context = await playwright.chromium.launch_persistent_context(
                user_data_dir=self.profile_dir,
                headless=self.headless,
                channel=channel,
                args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
                viewport={"width": 1440, "height": 960},
            )
            self.chat = ChatPage(self.context, self.profile_dir)
            self.research = ResearchPage(self.context, self.profile_dir)
            emit({"type": "ready", "pid": os.getpid(), "browser": browser_label(channel)})

            loop = asyncio.get_running_loop()
            incoming: asyncio.Queue = asyncio.Queue()
            threading.Thread(target=self._read_stdin, args=(loop, incoming), daemon=True).start()
            heartbeat = asyncio.create_task(self._heartbeat())
            try:
                while True:
                    line = await incoming.get()
                    if line is None:
                        break
                    try:
                        message = json.loads(line)
                    except Exception:
                        log(f"ignoring non-JSON stdin line: {line.strip()[:200]}")
                        continue
                    if message.get("type") == "shutdown":
                        break
                    if message.get("type") == "cancel":
                        task = self.tasks.get(str(message.get("id")))
                        if task is not None:
                            task.cancel()
                        continue
                    if message.get("type") != "request":
                        continue
                    request_id = str(message.get("id") or "")
                    task = asyncio.create_task(self._handle(message, request_id))
                    self.tasks[request_id] = task
                    task.add_done_callback(lambda _task, key=request_id: self.tasks.pop(key, None))
            finally:
                heartbeat.cancel()
                for task in list(self.tasks.values()):
                    task.cancel()
                await asyncio.gather(*self.tasks.values(), return_exceptions=True)
                await self._close_pages()
                try:
                    await self.context.close()
                except Exception:
                    pass
        return 0

    def _read_stdin(self, loop, incoming: asyncio.Queue) -> None:
        try:
            for line in sys.stdin:
                loop.call_soon_threadsafe(incoming.put_nowait, line)
        finally:
            loop.call_soon_threadsafe(incoming.put_nowait, None)

    async def _heartbeat(self) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL_SEC)
            emit({"type": "heartbeat", "ts": int(asyncio.get_running_loop().time() * 1000)})

    async def _close_pages(self) -> None:
        if self.chat is not None:
            await self.chat.close()
        if self.research is not None:
            await self.research.close()

    async def _handle(self, message: dict[str, Any], request_id: str) -> None:
        command = str(message.get("command") or "")
        payload = message.get("payload") if isinstance(message.get("payload"), dict) else {}
        try:
            if command == "chat.send":
                data = await self.chat.send(
                    str(payload.get("message") or ""),
                    int(payload.get("timeoutSec") or DEFAULT_CHAT_TIMEOUT_SEC),
                    str(payload.get("conversationUrl") or "") or None,
                    model=str(payload.get("model") or "") or None,
                    model_label=str(payload.get("modelLabel") or "") or None,
                    thinking=str(payload.get("thinking") or "") or None,
                )
            elif command == "chat.new":
                data = await self.chat.new_chat()
            elif command == "research.run":
                data = await self.research.run(
                    str(payload.get("topic") or ""),
                    int(payload.get("timeoutSec") or DEFAULT_RESEARCH_TIMEOUT_SEC),
                    model=str(payload.get("model") or "") or None,
                    model_label=str(payload.get("modelLabel") or "") or None,
                    thinking=str(payload.get("thinking") or "") or None,
                )
            elif command == "models.list":
                mode = str(payload.get("mode") or "chat")
                target = self.research if mode == "research" else self.chat
                data = await target.list_models()
            elif command == "status":
                data = {
                    "chat": await self.chat.status() if self.chat is not None else {"signedIn": None, "pageReady": False},
                    "research": await self.research.status() if self.research is not None else {"signedIn": None, "pageReady": False},
                }
            else:
                raise ValueError(f"unknown worker command: {command}")
            emit({"type": "result", "id": request_id, "ok": True, "data": data})
        except LoginRequired:
            record_login_state(self.profile_dir, False, "login_required")
            emit({
                "type": "result",
                "id": request_id,
                "ok": False,
                "error": {"code": "login_required", "message": "Gemini 网页登录已失效，请重新初始化登录"},
            })
        except asyncio.CancelledError:
            emit({
                "type": "result",
                "id": request_id,
                "ok": False,
                "error": {"code": "cancelled", "message": "worker request cancelled"},
            })
            if command.startswith("chat") and self.chat is not None:
                await asyncio.shield(self.chat.close())
            elif command.startswith("research") and self.research is not None:
                await asyncio.shield(self.research.close())
            raise
        except Exception as error:
            log(traceback.format_exc())
            emit({
                "type": "result",
                "id": request_id,
                "ok": False,
                "error": {"code": getattr(error, "code", "worker_error"), "message": str(error)},
            })


def main() -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args()
    profile = os.path.abspath(args.profile)
    os.makedirs(profile, exist_ok=True)
    try:
        return asyncio.run(Worker(profile, bool(args.headless)).run())
    except KeyboardInterrupt:
        return 0
    except Exception:
        log(traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
