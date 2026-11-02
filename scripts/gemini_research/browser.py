"""Resolve the system default browser to a Playwright Chromium channel.

Windows keeps the default browser choice under the http/https URL association
keys. Only Chromium-based defaults (Chrome / Edge) can share the persistent
Playwright profile used by the research scripts.
"""

import sys


def default_browser_channel():
    if sys.platform != "win32":
        return None
    try:
        import winreg

        key_path = r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            prog_id = str(winreg.QueryValueEx(key, "ProgId")[0]).lower()
    except Exception:
        return None

    if "msedge" in prog_id:
        return "msedge"
    if "chrome" in prog_id:
        return "chrome"
    return None


def browser_label(channel):
    if channel == "msedge":
        return "Microsoft Edge（系统默认）"
    if channel == "chrome":
        return "Google Chrome（系统默认）"
    return "Playwright Chromium（未识别系统默认浏览器，使用内置）"
