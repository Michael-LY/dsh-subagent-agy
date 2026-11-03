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
MODEL_BUTTON_SELECTORS = [
    "[data-test-id='bard-mode-menu-button']",
    "button[data-test-id='bard-mode-menu-button']",
]
MODEL_OPTION_SELECTOR = "gem-menu-item[data-test-id^='bard-mode-option-']"
THINKING_ENTRY_SELECTORS = [
    "gem-menu-item:has-text('思考等级')",
    "gem-menu-item:has-text('Thinking level')",
    "gem-menu-item:has-text('Thinking')",
]
THINKING_ITEM_SELECTOR = "gem-menu-item"
MODEL_TOKEN_MAP = {
    "flash-lite": ("3.5 flash-lite", "flash-lite", "flash lite"),
    "flash": ("3.8 flash", "flash"),
    "pro": ("3.1 pro", "pro"),
    "argon": ("4 argon", "argon"),
}
DEFAULT_THINKING_OPTIONS = [
    {"id": "low", "label": "低（快速高效）", "tokens": ["低", "快速高效", "low", "quick and efficient"]},
    {"id": "medium", "label": "中（深度适中）", "tokens": ["中", "深度适中", "medium", "balanced depth"]},
    {"id": "high", "label": "高（超级详尽）", "tokens": ["高", "超级详尽", "high", "extra thorough"]},
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


class ModelUnavailable(RuntimeError):
    """The requested model cannot be selected on the current page."""

    code = "model_unavailable"


class ThinkingUnavailable(RuntimeError):
    """The requested thinking level cannot be selected on the current page."""

    code = "thinking_unavailable"


def write_json_file(path: str | os.PathLike[str], payload: Any) -> None:
    """Write one small JSON result atomically enough for the host reader."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f"{target.name}.{os.getpid()}.{time.time_ns()}.tmp")
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
        remaining = (await editor.inner_text() or "").strip()
    except Exception:
        remaining = ""
    if remaining:
        send = await find_visible(page, SEND_SELECTORS, timeout_ms=3000)
        if send is not None:
            await send.click()
            await page.wait_for_timeout(700)


def _normalise_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip()).lower()


def _model_tokens(model: str | None, label: str | None = None) -> list[str]:
    tokens: list[str] = []
    for value in (model, label):
        if value:
            tokens.extend([str(value), str(value).replace("-", " "), str(value).replace("_", " ")])
    tokens.extend(MODEL_TOKEN_MAP.get(str(model or "").lower(), ()))
    return list(dict.fromkeys(token.strip().lower() for token in tokens if token and token.strip()))


def _model_id_from_label(label: str) -> str:
    text = _normalise_text(label)
    if "flash-lite" in text or "flash lite" in text:
        return "flash-lite"
    if "flash" in text:
        return "flash"
    if "pro" in text:
        return "pro"
    if "argon" in text:
        return "argon"
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")[:64] or "default"


async def _model_button(page):
    return await find_visible(page, MODEL_BUTTON_SELECTORS, timeout_ms=5000)


async def current_model_text(page) -> str:
    button = await _model_button(page)
    if button is None:
        return ""
    try:
        aria = await button.get_attribute("aria-label") or ""
        text = (await button.inner_text() or "").strip()
        return f"{aria} {text}".strip()
    except Exception:
        return ""


async def _visible_model_options(page) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        locator = page.locator(MODEL_OPTION_SELECTOR)
        count = await locator.count()
    except Exception:
        return rows
    for index in range(min(count, 20)):
        item = locator.nth(index)
        try:
            if not await item.is_visible():
                continue
            text = (await item.inner_text() or "").strip().replace("\n", " ")
            if not text:
                continue
            rows.append({"index": index, "text": text, "testid": await item.get_attribute("data-test-id")})
        except Exception:
            continue
    return rows


async def _thinking_entry(page):
    for selector in THINKING_ENTRY_SELECTORS:
        try:
            locator = page.locator(selector).first
            if await locator.count() > 0 and await locator.is_visible():
                return locator
        except Exception:
            continue
    return None


async def _visible_thinking_items(page) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        locator = page.locator(THINKING_ITEM_SELECTOR)
        count = await locator.count()
    except Exception:
        return rows
    for index in range(min(count, 30)):
        item = locator.nth(index)
        try:
            if not await item.is_visible():
                continue
            text = (await item.inner_text() or "").strip().replace("\n", " ")
            testid = await item.get_attribute("data-test-id") or ""
            if not text or testid.startswith("bard-mode-option-"):
                continue
            if _normalise_text(text) in ("思考等级", "thinking level", "thinking"):
                continue
            classes = (await item.get_attribute("class") or "").split()
            rows.append({"index": index, "text": text, "testid": testid, "selected": "selected" in classes})
        except Exception:
            continue
    return rows


async def list_model_catalog(page) -> dict[str, Any]:
    """Read the live model menu and thinking-level submenu without changing it."""
    button = await _model_button(page)
    if button is None:
        raise ModelUnavailable("找不到 Gemini 模型选择控件")
    await button.click()
    await page.wait_for_timeout(900)
    try:
        options = await _visible_model_options(page)
        if not options:
            raise ModelUnavailable("模型菜单为空")
        models = []
        thinking_levels = []
        entry = await _thinking_entry(page)
        if entry is not None:
            await entry.click()
            await page.wait_for_timeout(800)
            items = await _visible_thinking_items(page)
            if len(items) == 3:
                thinking_levels = [level["id"] for level in DEFAULT_THINKING_OPTIONS]
        for option in options:
            label = option["text"]
            models.append({
                "id": _model_id_from_label(label),
                "label": label,
                "displayName": label,
                "tokens": _model_tokens(_model_id_from_label(label), label),
                "thinkingLevels": thinking_levels,
            })
        return {
            "models": models,
            "thinking": DEFAULT_THINKING_OPTIONS if thinking_levels else [],
            "deepThink": {"supported": False, "label": "Deep Think"},
            "source": "live",
            "current": await current_model_text(page),
        }
    finally:
        try:
            await page.keyboard.press("Escape")
            await page.keyboard.press("Escape")
        except Exception:
            pass


async def select_model(page, model: str | None, label: str | None = None) -> dict[str, Any]:
    """Select one model by exact stable id; verify the trigger afterwards."""
    if not model:
        return {"applied": False, "reason": "default"}
    button = await _model_button(page)
    if button is None:
        raise ModelUnavailable("找不到 Gemini 模型选择控件")
    await button.click()
    await page.wait_for_timeout(900)
    try:
        options = await _visible_model_options(page)
        if not options:
            raise ModelUnavailable("模型菜单为空")
        exact = [option for option in options if _model_id_from_label(option["text"]) == model]
        if len(exact) != 1:
            raise ModelUnavailable(f"找不到唯一模型选项：{label or model}")
        best = exact[0]
        await page.locator(MODEL_OPTION_SELECTOR).nth(best["index"]).click()
        await page.wait_for_timeout(1000)
        current = await current_model_text(page)
        if _model_id_from_label(current) != model:
            raise ModelUnavailable(f"模型选择未生效：{label or model}")
        return {"applied": True, "model": model, "label": best["text"]}
    finally:
        try:
            await page.keyboard.press("Escape")
        except Exception:
            pass


async def select_thinking(page, thinking: str | None) -> dict[str, Any]:
    """Select low/medium/high from the 3-item 思考等级 submenu."""
    if not thinking:
        return {"applied": False, "reason": "default"}
    button = await _model_button(page)
    if button is None:
        raise ThinkingUnavailable("找不到 Gemini 模型选择控件")
    await button.click()
    await page.wait_for_timeout(900)
    try:
        entry = await _thinking_entry(page)
        if entry is None:
            raise ThinkingUnavailable("当前页面没有思考等级控件")
        await entry.click()
        await page.wait_for_timeout(800)
        items = await _visible_thinking_items(page)
        if len(items) != 3:
            raise ThinkingUnavailable(f"思考等级不是 3 档（实际 {len(items)} 档）")
        index = {"low": 0, "medium": 1, "high": 2}.get(str(thinking).lower())
        if index is None:
            wanted = _normalise_text(thinking)
            index = next((i for i, item in enumerate(items) if wanted in _normalise_text(item["text"])), None)
        if index is None:
            raise ThinkingUnavailable(f"找不到思考等级：{thinking}")
        expected = DEFAULT_THINKING_OPTIONS[index]
        if not any(token in _normalise_text(items[index]["text"]) for token in expected["tokens"]):
            raise ThinkingUnavailable(f"思考等级文本不符合预期：{items[index]['text']}")
        await page.locator(THINKING_ITEM_SELECTOR).nth(items[index]["index"]).click()
        await page.wait_for_timeout(700)
        # Read back the selected item from the menu; button text does not always
        # expose the current thinking level (notably low/default).
        try:
            await page.keyboard.press("Escape")
            await button.click()
            await page.wait_for_timeout(800)
            check_entry = await _thinking_entry(page)
            if check_entry is not None:
                await check_entry.click()
                await page.wait_for_timeout(700)
                check_items = await _visible_thinking_items(page)
                selected = [item for item in check_items if item.get("selected")]
                if len(check_items) == 3 and selected:
                    if _normalise_text(selected[0]["text"]) != _normalise_text(items[index]["text"]):
                        raise ThinkingUnavailable("思考等级回读不一致")
        except ThinkingUnavailable:
            raise
        except Exception:
            # Read-back is best-effort; click itself remains the source of truth.
            pass
        return {"applied": True, "thinking": expected["id"], "label": items[index]["text"]}
    finally:
        try:
            await page.keyboard.press("Escape")
        except Exception:
            pass


async def apply_generation_options(
    page,
    model: str | None = None,
    thinking: str | None = None,
    model_label: str | None = None,
) -> dict[str, Any]:
    """Apply model then thinking level; report what actually stuck."""
    result: dict[str, Any] = {
        "modelApplied": False,
        "thinkingApplied": False,
        "currentModel": await current_model_text(page),
    }
    if model:
        await select_model(page, model, label=model_label)
        result["modelApplied"] = True
    if thinking:
        await select_thinking(page, thinking)
        result["thinkingApplied"] = True
    result["currentModel"] = await current_model_text(page)
    return result


def should_finish_reply(
    *,
    last_text: str,
    stable_for: float,
    stop_count: int,
    saw_stop: bool,
    action_in_latest: int,
    min_stable_sec: float = 2.5,
) -> bool:
    """Pure completion policy for one chat reply.

    Stop visible is a hard veto: never finish while generation is still
    running. After it disappears, either we saw it during this reply or the
    newest response bubble itself exposes its action toolbar.
    """
    return (
        bool(last_text)
        and stable_for >= min_stable_sec
        and stop_count == 0
        and (saw_stop or action_in_latest > 0)
    )


async def count_actions_in_latest_response(page, max_per_selector: int = 3) -> int:
    """Count action buttons scoped to the newest response bubble only.

    Page-wide counts are wrong in multi-turn conversations: every historical
    answer keeps its copy/regenerate buttons visible.
    """
    for container_selector in ("model-response", "message-content", ".model-response-text", "div.markdown"):
        try:
            nodes = page.locator(container_selector)
            count = await nodes.count()
            if count == 0:
                continue
            node = nodes.nth(count - 1)
            if not await node.is_visible():
                continue
            total = 0
            candidates = [node]
            try:
                parent = node.locator("xpath=ancestor::model-response[1]")
                if await parent.count() > 0:
                    candidates.append(parent.first)
            except Exception:
                pass
            for candidate in candidates:
                for action_selector in ACTION_SELECTORS:
                    try:
                        actions = candidate.locator(action_selector)
                        action_count = await actions.count()
                        for index in range(min(action_count, max_per_selector)):
                            if await actions.nth(index).is_visible():
                                total += 1
                    except Exception:
                        continue
                if total > 0:
                    return total
        except Exception:
            continue
    return 0


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
            action_in_latest = await count_actions_in_latest_response(page)
            stable_for = time.monotonic() - last_change
            if should_finish_reply(
                last_text=last_text,
                stable_for=stable_for,
                stop_count=stop_count,
                saw_stop=saw_stop,
                action_in_latest=action_in_latest,
            ):
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
