"""Open the system default browser and persist a Google Gemini login profile.

Run once before using the Gemini web Deep Research panel. The script polls until
the Gemini app looks signed in, then exits and leaves the persistent profile on
disk. It never receives or stores credentials itself.
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


def is_logged_in(page):
    try:
        if "accounts.google.com" in (page.url or ""):
            return False
        if page.locator(ACCOUNT_SELECTOR).count() > 0:
            return True
        editor = page.locator(EDITOR_SELECTOR)
        sign_in = page.get_by_text(re.compile(r"sign in to save activity|登录以保存活动", re.I)).count()
        return editor.count() > 0 and editor.first.is_visible() and sign_in == 0
    except Exception:
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True, help="persistent browser user_data_dir (system default browser)")
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()

    profile = os.path.abspath(args.profile)
    os.makedirs(profile, exist_ok=True)
    deadline = time.time() + max(30, args.timeout)
    channel = default_browser_channel()
    print(json.dumps({"browser": browser_label(channel)}, ensure_ascii=False), file=sys.stderr, flush=True)

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=profile,
            headless=False,
            channel=channel,
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
            viewport={"width": 1280, "height": 860},
        )
        try:
            page = context.pages[0] if context.pages else context.new_page()
            try:
                page.goto(GEMINI_URL, wait_until="domcontentloaded", timeout=60000)
            except Exception as error:
                print(json.dumps({"ok": False, "error": f"goto failed: {error}"}), flush=True)
                return 1

            def has_session_cookie():
                try:
                    names = {cookie.get("name") for cookie in context.cookies()}
                    return "SID" in names or "__Secure-1PSID" in names
                except Exception:
                    return False

            while time.time() < deadline:
                if has_session_cookie() or is_logged_in(page):
                    try:
                        with open(os.path.join(profile, "login-ok.json"), "w", encoding="utf-8") as handle:
                            json.dump({"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "url": page.url, "browser": browser_label(channel)}, handle)
                    except Exception:
                        pass
                    print(json.dumps({"ok": True, "url": page.url, "browser": browser_label(channel)}, ensure_ascii=False), flush=True)
                    return 0
                try:
                    if page.is_closed():
                        print(json.dumps({"ok": False, "error": "browser window closed before login was detected"}, ensure_ascii=False), flush=True)
                        return 1
                except Exception:
                    pass
                time.sleep(1)

            print(json.dumps({"ok": False, "error": "timeout waiting for Google login"}, ensure_ascii=False), flush=True)
            return 1
        finally:
            try:
                context.close()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
