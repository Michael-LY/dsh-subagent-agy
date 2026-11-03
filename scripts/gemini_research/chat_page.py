"""Persistent Gemini chat page used by the worker.

The page stays mounted across turns so the conversation context lives in the
browser itself; no per-message cold start or URL reload is required.
"""

from __future__ import annotations

import re
from typing import Any

from selectors import (
    GEMINI_URL,
    LoginRequired,
    is_logged_in,
    record_login_state,
    response_texts,
    type_and_submit,
    wait_for_reply,
)

CONVERSATION_URL_RE = re.compile(r"^https://gemini\.google\.com/app/([A-Za-z0-9_-]+)")


class ChatPage:
    def __init__(self, context, profile_dir: str):
        self.context = context
        self.profile_dir = profile_dir
        self.page = None

    async def ensure_page(self, conversation_url: str | None = None):
        target = conversation_url if conversation_url and CONVERSATION_URL_RE.match(conversation_url) else GEMINI_URL
        if self.page is None or self.page.is_closed():
            self.page = await self.context.new_page()
            await self.page.goto(target, wait_until="domcontentloaded", timeout=60000)
            await self.page.wait_for_timeout(1500)
        elif target != GEMINI_URL:
            current_match = CONVERSATION_URL_RE.match(self.page.url or "")
            target_match = CONVERSATION_URL_RE.match(target)
            if target_match and (current_match is None or current_match.group(1) != target_match.group(1)):
                await self.page.goto(target, wait_until="domcontentloaded", timeout=60000)
                await self.page.wait_for_timeout(1500)
        # Normal chat is allowed without Google sign-in (Gemini web supports
        # it), but the status must say so: no history and no Deep Research.
        signed_in = await is_logged_in(self.page)
        record_login_state(self.profile_dir, signed_in, None if signed_in else "logged_out_chat")
        return self.page

    async def send(self, message: str, timeout_sec: int = 180, conversation_url: str | None = None) -> dict[str, Any]:
        page = await self.ensure_page(conversation_url)
        before_count = len(await response_texts(page))
        await type_and_submit(page, message)
        result = await wait_for_reply(page, before_count, timeout_sec)
        conversation_url = page.url if CONVERSATION_URL_RE.match(page.url or "") else None
        return {
            "reply": result["reply"],
            "sawStop": result["sawStop"],
            "elapsedSec": result["elapsedSec"],
            "conversationUrl": conversation_url,
            "signedIn": await is_logged_in(page),
        }

    async def new_chat(self) -> dict[str, Any]:
        page = await self.ensure_page()
        await page.goto(GEMINI_URL, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(1500)
        return {"conversationUrl": page.url if CONVERSATION_URL_RE.match(page.url or "") else None}

    async def status(self) -> dict[str, Any]:
        if self.page is None or self.page.is_closed():
            return {"signedIn": None, "pageReady": False}
        return {"signedIn": await is_logged_in(self.page), "pageReady": True}

    async def close(self) -> None:
        if self.page is not None and not self.page.is_closed():
            try:
                await self.page.close()
            except Exception:
                pass
        self.page = None
