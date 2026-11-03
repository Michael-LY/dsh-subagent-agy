"""Shared async Playwright selectors and Gemini page helpers.

The worker keeps long-lived pages; these helpers are deliberately stateless so
chat and research page objects can share them. Every selector is a candidate
list because Gemini's DOM changes over time.
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

GEMINI_URL = "https://gemini.google.com/app"

EDITOR_SELECTORS = [
    "rich-textarea div[contenteditable='true']",
    "div[contenteditable='true'][role='textbox']",
    "div[contenteditable='true']",
    "div.ql-editor",
]
ACCOUNT_SELECTORS = [
    "a[href*='accounts.google.com/SignOutOptions']",
    "button[aria-label*='Google Account']",
    "[aria-label*='Google 账号']",
    "[aria-label*='Google 帳號']",
]
RESPONSE_SELECTORS = [
    "message-content",
    ".model-response-text",
    "model-response",
    "div.markdown",
]
STOP_SELECTORS = [
    "button[aria-label*='Stop' i]",
    "button[aria-label*='停止']",
    "button:has-text('Stop generating')",
    "button:has-text('停止生成')",
]
SEND_SELECTORS = [
    "button[aria-label*='Send' i]",
    "button[aria-label*='发送']",
    "button.send-button",
]
ACTION_SELECTORS = [
    "button[aria-label*='Copy' i]",
    "button[aria-label*='复制']",
    "button[aria-label*='Good response' i]",
    "button[aria-label*='Regenerate' i]",
    "button[aria-label*='重新生成']",
]
TOOLS_SELECTORS = [
    "button[aria-label*='Tools' i]",
    "button[aria-label*='工具']",
    "button[aria-label*='Add files' i]",
    "button[aria-label*='添加文件']",
    "button:has-text('Tools')",
    "button:has-text('工具')",
]
DEEP_RESEARCH_RE = re.compile(r"^(deep research|deep research mode|深度研究)$", re.I)
START_RESEARCH_RE = re.compile(r"start research|begin research|开始研究|開始研究|approve|批准", re.I)
EXPORT_SELECTORS = [
    "button:has-text('Export to Docs')",
    "button:has-text('导出到文档')",
    "button:has-text('Copy contents')",
    "button:has-text('复制内容')",
]
SIGN_IN_RE = re.compile(r"sign in to save activity|登录以保存活动", re.I)

LOGIN_STATE_FILENAME = "login-state.json"


class LoginRequired(RuntimeError):
    """The persistent browser profile is not signed in."""


def write_json_file(path: str | os.PathLike[str], payload: Any) -> None:
    """Write one small JSON result atomically enough for the host reader."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f"{target.name}.tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    os.replace(temporary, target)


def record_login_state(profile_dir: str | os.PathLike[str], signed_in: bool, error: str | None = None) -> None:
    """Persist the last live login observation for the host status endpoint."""
    payload = {
        "signedIn": bool(signed_in),
        "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    if error:
        payload["error"] = error
    try:
        write_json_file(Path(profile_dir) / LOGIN_STATE_FILENAME, payload)
    except Exception:
        pass


async def find_visible(page, selectors: list[str], timeout_ms: int = 0):
    """Return the first visible locator from a candidate list, or None."""
    deadline = time.monotonic() + max(0, timeout_ms) / 1000
    while True:
        for selector in selectors:
            try:
                locator = page.locator(selector).first
                if await locator.count() > 0 and await locator.is_visible():
                    return locator
            except Exception:
                continue
        if time.monotonic() >= deadline:
            return None
        await page.wait_for_timeout(250)


async def count_visible(page, selectors: list[str], max_per_selector: int = 3) -> int:
    """Count visible matches across a selector list."""
    total = 0
    for selector in selectors:
        try:
            locator = page.locator(selector)
            count = await locator.count()
            for index in range(min(count, max_per_selector)):
                if await locator.nth(index).is_visible():
                    total += 1
        except Exception:
            continue
    return total


async def deep_response_texts(page) -> list[str]:
    """Fallback text extraction that walks open shadow roots in the page."""
    try:
        texts = await page.evaluate(
            """() => {
              const seen = new Set();
              const out = [];
              const walk = (root) => {
                for (const el of root.querySelectorAll('*')) {
                  if (el.shadowRoot && !seen.has(el.shadowRoot)) {
                    seen.add(el.shadowRoot);
                    walk(el.shadowRoot);
                  }
                  const tag = (el.tagName || '').toLowerCase();
                  const cls = el.classList;
                  const isResponse = tag === 'message-content' || tag === 'model-response'
                    || (cls && (cls.contains('model-response-text') || cls.contains('markdown')));
                  if (!isResponse) continue;
                  const text = (el.innerText || '').trim();
                  if (text) out.push(text);
                }
              };
              walk(document);
              return out;
            }"""
        )
        return [text for text in (texts or []) if isinstance(text, str) and text.strip()]
    except Exception:
        return []


async def response_texts(page) -> list[str]:
    """Return all assistant response texts using selectors, then shadow-root fallback."""
    for selector in RESPONSE_SELECTORS:
        try:
            locator = page.locator(selector)
            count = await locator.count()
            if count == 0:
                continue
            texts = []
            for index in range(count):
                try:
                    text = (await locator.nth(index).inner_text() or "").strip()
                except Exception:
                    text = ""
                if text:
                    texts.append(text)
            if texts:
                return texts
        except Exception:
            continue
    return await deep_response_texts(page)


async def is_logged_in(page) -> bool:
    """Best-effort signed-in detection with selector-drift fallback."""
    try:
        if "accounts.google.com" in (page.url or ""):
            return False
        if await page.locator(", ".join(ACCOUNT_SELECTORS)).count() > 0:
            return True
        editor = page.locator(", ".join(EDITOR_SELECTORS))
        sign_in = await page.get_by_text(SIGN_IN_RE).count()
        return await editor.count() > 0 and await editor.first.is_visible() and sign_in == 0
    except Exception:
        return False


async def wait_editor(page, timeout_ms: int = 30_000):
    editor = await find_visible(page, EDITOR_SELECTORS, timeout_ms=timeout_ms)
    if editor is None:
        raise RuntimeError("composer_not_found")
    return editor


async def type_and_submit(page, text: str) -> None:
    """Type into Gemini's rich editor and submit with Enter/Send fallback."""
    editor = await wait_editor(page)
    await editor.click()
    await page.wait_for_timeout(250)
    await page.keyboard.insert_text(text)
    await page.wait_for_timeout(400)
    await page.keyboard.press("Enter")
    await page.wait_for_timeout(700)
    try:
        remaining = (await page.locator(EDITOR_SELECTORS[0]).first.inner_text() or "").strip()
    except Exception:
        remaining = ""
    if remaining:
        send = await find_visible(page, SEND_SELECTORS, timeout_ms=3000)
        if send is not None:
            await send.click()
            await page.wait_for_timeout(700)


async def wait_for_reply(page, before_count: int, timeout_sec: int = 180) -> dict[str, Any]:
    """Wait for one new chat reply and return its text."""
    deadline = time.monotonic() + max(10, timeout_sec)
    started_at = time.monotonic()
    last_text = ""
    last_change = time.monotonic()
    saw_stop = False
    started = False
    while time.monotonic() < deadline:
        try:
            texts = await response_texts(page)
            if len(texts) > before_count and texts:
                current = texts[-1]
                if current != last_text:
                    last_text = current
                    last_change = time.monotonic()
                started = True
            stop_count = await count_visible(page, STOP_SELECTORS)
            if stop_count > 0:
                saw_stop = True
            action_count = await count_visible(page, ACTION_SELECTORS)
            stable_for = time.monotonic() - last_change
            if last_text and stable_for >= 2.5 and (stop_count == 0 or action_count > 0):
                return {
                    "reply": last_text,
                    "sawStop": saw_stop,
                    "elapsedSec": round(time.monotonic() - started_at, 2),
                }
            if not started and time.monotonic() - started_at > 90:
                raise TimeoutError("no_response_started")
        except TimeoutError:
            raise
        except Exception:
            pass
        await page.wait_for_timeout(500)
    raise TimeoutError("timeout waiting for reply")


async def open_deep_research(page) -> None:
    tools = await find_visible(page, TOOLS_SELECTORS)
    if tools is not None:
        await tools.click()
        await page.wait_for_timeout(800)
    for selector in [
        "[role='menuitem']:has-text('Deep research')",
        "[role='menuitem']:has-text('Deep Research')",
        "[role='menuitem']:has-text('深度研究')",
        "button:has-text('Deep research')",
        "button:has-text('深度研究')",
    ]:
        try:
            item = page.locator(selector).first
            if await item.count() > 0 and await item.is_visible():
                await item.click()
                await page.wait_for_timeout(800)
                return
        except Exception:
            continue
    try:
        item = page.get_by_text(DEEP_RESEARCH_RE).first
        if await item.count() > 0 and await item.is_visible():
            await item.click()
            await page.wait_for_timeout(800)
            return
    except Exception:
        pass
    raise RuntimeError("deep_research_unavailable")


async def submit_deep_research_topic(page, topic: str) -> None:
    await type_and_submit(page, topic)
    await page.wait_for_timeout(1500)


async def wait_for_plan_and_start(page, timeout_sec: int) -> bool:
    deadline = time.monotonic() + min(180, max(10, timeout_sec))
    while time.monotonic() < deadline:
        try:
            button = page.get_by_role("button", name=START_RESEARCH_RE).first
            if await button.count() > 0 and await button.is_visible():
                await button.click()
                return True
        except Exception:
            pass
        await page.wait_for_timeout(3000)
    return False


async def wait_for_report(page, timeout_sec: int) -> bool:
    # 与 run_research.py 保持一致：只认 Export 出现，或看到 Stop 后连续 12 秒
    # 不再出现。不要用「文本 N 秒不变」判定完成——Deep Research 中途停顿会被误判。
    deadline = time.monotonic() + max(60, timeout_sec)
    saw_stop = False
    quiet_since = None
    while time.monotonic() < deadline:
        try:
            export_count = await count_visible(page, EXPORT_SELECTORS)
            if export_count > 0:
                return True
            stop_count = await count_visible(page, STOP_SELECTORS)
            if stop_count > 0:
                saw_stop = True
                quiet_since = None
            elif saw_stop:
                quiet_since = quiet_since or time.monotonic()
                if time.monotonic() - quiet_since > 12:
                    return True
        except Exception:
            pass
        await page.wait_for_timeout(5000)
    return False


async def extract_report(page) -> str:
    texts = await response_texts(page)
    if texts:
        candidate = texts[-1].strip()
        if len(candidate) >= 40:
            return candidate
    return ""


async def save_debug(page, profile_dir: str, prefix: str = "debug") -> None:
    try:
        target = Path(profile_dir)
        target.mkdir(parents=True, exist_ok=True)
        path = target / f"{prefix}-{int(time.time())}.png"
        await page.screenshot(path=str(path), full_page=False)
    except Exception:
        pass
