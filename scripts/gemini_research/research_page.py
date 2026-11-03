"""Persistent Gemini Deep Research page used by the worker.

Research gets its own page so it can run concurrently with chat in the same
browser context. Each research job starts from a fresh Gemini chat.
"""

from __future__ import annotations

from typing import Any

from selectors import (
    GEMINI_URL,
    LoginRequired,
    extract_report,
    is_logged_in,
    open_deep_research,
    record_login_state,
    save_debug,
    submit_deep_research_topic,
    wait_for_plan_and_start,
    wait_for_report,
)


class ResearchPage:
    def __init__(self, context, profile_dir: str):
        self.context = context
        self.profile_dir = profile_dir
        self.page = None

    async def ensure_page(self):
        if self.page is None or self.page.is_closed():
            self.page = await self.context.new_page()
            await self.page.goto(GEMINI_URL, wait_until="domcontentloaded", timeout=60000)
            await self.page.wait_for_timeout(1500)
        return self.page

    async def run(self, topic: str, timeout_sec: int = 900) -> dict[str, Any]:
        page = await self.ensure_page()
        await page.goto(GEMINI_URL, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(2500)
        if not await is_logged_in(page):
            record_login_state(self.profile_dir, False, "login_required")
            raise LoginRequired("login_required")
        record_login_state(self.profile_dir, True)
        try:
            await open_deep_research(page)
            await submit_deep_research_topic(page, topic)
            await wait_for_plan_and_start(page, timeout_sec)
            if not await wait_for_report(page, timeout_sec):
                await save_debug(page, self.profile_dir, "debug-research")
                raise TimeoutError("timeout waiting for report")
            report = await extract_report(page)
            if len(report.strip()) < 40:
                await save_debug(page, self.profile_dir, "debug-research")
                raise RuntimeError("empty report")
            return {"report": report}
        except LoginRequired:
            raise
        except Exception:
            await save_debug(page, self.profile_dir, "debug-research")
            raise

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
