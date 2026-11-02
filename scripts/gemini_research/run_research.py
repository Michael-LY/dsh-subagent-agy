"""Trigger Gemini web Deep Research with a persisted browser profile.

The panel passes the research topic through --topic (or --topic-file) and reads
a small JSON file written by --out. The flow is deliberately tolerant of UI
changes: every interaction tries several selectors, and failures save a
screenshot next to the Chrome profile for debugging.
"""

import argparse
import json
import os
import re
import sys
import time

from playwright.sync_api import sync_playwright

from browser import browser_label, default_browser_channel

GEMINI_URL = "https://gemini.google.com/app"
EDITOR_SELECTOR = "rich-textarea div[contenteditable='true'], div.ql-editor"
ACCOUNT_SELECTOR = (
    "a[href*='accounts.google.com/SignOutOptions'], "
    "button[aria-label*='Google Account'], "
    "[aria-label*='Google 账号'], "
    "[aria-label*='Google 帳號']"
)
START_RESEARCH_RE = re.compile(r"start research|begin research|开始研究|開始研究|approve|批准", re.I)
TOOLS_SELECTORS = [
    "button[aria-label*='Tools' i]",
    "button[aria-label*='工具']",
    "button[aria-label*='Add files' i]",
    "button[aria-label*='添加文件']",
    "button:has-text('Tools')",
    "button:has-text('工具')",
]
DEEP_RESEARCH_RE = re.compile(r"^(deep research|deep research mode|深度研究)$", re.I)
STOP_SELECTORS = [
    "button[aria-label*='Stop' i]",
    "button[aria-label*='停止']",
    "button:has-text('Stop generating')",
    "button:has-text('停止生成')",
]
EXPORT_SELECTORS = [
    "button:has-text('Export to Docs')",
    "button:has-text('导出到文档')",
    "button:has-text('Copy contents')",
    "button:has-text('复制内容')",
]
SEND_SELECTORS = [
    "button[aria-label*='Send' i]",
    "button[aria-label*='发送']",
    "button:has-text('Send')",
]


def log(message):
    print(f"[gemini-research] {message}", file=sys.stderr, flush=True)


def find_visible(page, selectors):
    for selector in selectors:
        try:
            locator = page.locator(selector).first
            if locator.count() > 0 and locator.is_visible():
                return locator
        except Exception:
            continue
    return None


def write_result(path, payload):
    try:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
    except Exception:
        pass


def is_logged_in(page):
    try:
        if "accounts.google.com" in (page.url or ""):
            return False
        if page.locator(ACCOUNT_SELECTOR).count() > 0:
            return True
        # Selector drift fallback: a visible editor with no sign-in prompt is
        # treated as signed in; the account menu is only one positive signal.
        has_editor = page.locator(EDITOR_SELECTOR).count() > 0
        sign_in = page.get_by_text(re.compile(r"sign in to save activity|登录以保存活动", re.I)).count()
        return has_editor and sign_in == 0
    except Exception:
        return False


def open_deep_research(page):
    tools = find_visible(page, TOOLS_SELECTORS)
    if tools is not None:
        tools.click()
        page.wait_for_timeout(800)

    # The menu item is usually plain text inside a popover.
    try:
        item = page.get_by_text(DEEP_RESEARCH_RE).first
        if item.count() > 0 and item.is_visible():
            item.click()
            page.wait_for_timeout(800)
            return True
    except Exception:
        pass

    # Some UI versions expose Deep Research as an aria-labelled button directly.
    try:
        direct = page.locator("button[aria-label*='Deep Research' i], button[aria-label*='深度研究']").first
        if direct.count() > 0 and direct.is_visible():
            direct.click()
            page.wait_for_timeout(800)
            return True
    except Exception:
        pass

    raise RuntimeError("deep_research_unavailable")


def submit_topic(page, topic):
    editor = page.locator(EDITOR_SELECTOR).first
    editor.wait_for(state="visible", timeout=30000)
    editor.click()
    page.wait_for_timeout(300)
    # insert_text triggers the editor's input events better than fill() on Quill.
    page.keyboard.insert_text(topic)
    page.wait_for_timeout(500)
    page.keyboard.press("Enter")
    page.wait_for_timeout(1500)

    # Enter may insert a newline in some editor versions; click Send if the
    # editor still holds the prompt.
    try:
        remaining = (page.locator(EDITOR_SELECTOR).first.inner_text() or "").strip()
        if remaining:
            send = find_visible(page, SEND_SELECTORS)
            if send is not None:
                send.click()
                page.wait_for_timeout(1000)
    except Exception:
        pass


def wait_for_plan_and_start(page, timeout_sec):
    deadline = time.time() + min(180, timeout_sec)
    while time.time() < deadline:
        try:
            button = page.get_by_role("button", name=START_RESEARCH_RE).first
            if button.count() > 0 and button.is_visible():
                button.click()
                log("research plan accepted")
                return True
        except Exception:
            pass
        page.wait_for_timeout(3000)
    log("no plan approval button found; assuming research already started")
    return False


def count_visible(page, selectors):
    total = 0
    for selector in selectors:
        try:
            locator = page.locator(selector)
            for index in range(min(locator.count(), 3)):
                if locator.nth(index).is_visible():
                    total += 1
        except Exception:
            continue
    return total


def wait_for_report(page, timeout_sec):
    deadline = time.time() + max(60, timeout_sec)
    saw_stop = False
    quiet_since = None
    while time.time() < deadline:
        try:
            stop_count = count_visible(page, STOP_SELECTORS)
            export_count = count_visible(page, EXPORT_SELECTORS)
            if export_count > 0:
                return True
            if stop_count > 0:
                saw_stop = True
                quiet_since = None
            elif saw_stop:
                quiet_since = quiet_since or time.time()
                if time.time() - quiet_since > 12:
                    return True
        except Exception:
            pass
        page.wait_for_timeout(5000)
    return False


def extract_report(page):
    for selector in ["message-content", ".model-response-text", "[data-test-id='conversation-turn']"]:
        try:
            nodes = page.locator(selector)
            count = nodes.count()
            if count > 0:
                text = nodes.nth(count - 1).inner_text().strip()
                if len(text) >= 40:
                    return text
        except Exception:
            continue

    # Fallback: largest visible text block in the main area.
    try:
        return page.evaluate(
            """() => {
              const nodes = [...document.querySelectorAll('main *')];
              let best = '';
              for (const node of nodes) {
                const text = (node.innerText || '').trim();
                if (text.length > best.length) best = text;
              }
              return best;
            }"""
        )
    except Exception:
        return ""


def save_debug(page, profile):
    try:
        os.makedirs(profile, exist_ok=True)
        path = os.path.join(profile, f"debug-{int(time.time())}.png")
        page.screenshot(path=path, full_page=False)
        log(f"screenshot: {path}")
    except Exception:
        pass


def fail(out, error, page=None, profile=None):
    if page is not None and profile:
        save_debug(page, profile)
    write_result(out, {"ok": False, "error": error})
    print(json.dumps({"ok": False, "error": error}, ensure_ascii=False), flush=True)
    return 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--topic")
    parser.add_argument("--topic-file")
    parser.add_argument("--out", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args()

    topic = args.topic or ""
    if args.topic_file:
        with open(args.topic_file, "r", encoding="utf-8") as handle:
            topic = handle.read()
    topic = topic.strip()
    if not topic:
        return fail(args.out, "topic is empty")

    profile = os.path.abspath(args.profile)
    os.makedirs(profile, exist_ok=True)
    channel = default_browser_channel()
    log(f"browser: {browser_label(channel)}")

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=profile,
            headless=bool(args.headless),
            channel=channel,
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
            viewport={"width": 1440, "height": 960},
        )
        page = context.pages[0] if context.pages else context.new_page()
        try:
            page.goto(GEMINI_URL, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(3000)
            if not is_logged_in(page):
                try:
                    os.remove(os.path.join(profile, "login-ok.json"))
                except Exception:
                    pass
                return fail(args.out, "login_required", page, profile)

            open_deep_research(page)
            submit_topic(page, topic)
            wait_for_plan_and_start(page, args.timeout)
            if not wait_for_report(page, args.timeout):
                return fail(args.out, "timeout waiting for report", page, profile)

            report = extract_report(page)
            if len(report.strip()) < 40:
                return fail(args.out, "empty report", page, profile)

            write_result(args.out, {"ok": True, "report": report})
            print(json.dumps({"ok": True, "chars": len(report)}, ensure_ascii=False), flush=True)
            return 0
        except Exception as error:
            return fail(args.out, str(error), page, profile)
        finally:
            try:
                context.close()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
