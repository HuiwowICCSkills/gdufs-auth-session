#!/usr/bin/env python3
"""
Shared GDUFS unified-authentication and library-VPN session manager.

The script owns authentication only.  Other skills consume the resulting
cookie/session file instead of logging in again, which avoids the GDUFS
session limit and prevents multiple tools from invalidating each other.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import os
import random
import re
import sys
import tempfile
import time
import urllib.parse
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import requests
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad
from lxml import html as lxml_html


AUTH_BASE = "https://authserver.gdufs.edu.cn"
AUTH_LOGIN = AUTH_BASE + "/authserver/login"
LIB_BASE = "https://library.gdufs.edu.cn"
VPN_BASE = "https://libvpn.gdufs.edu.cn"
VPN_CALLBACK = VPN_BASE + "/api/acl_user/financeLoginsgdwy?mark=POLYINFO"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/155.0.0.0 Safari/537.36"
)

AES_CHARS = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678"
SESSION_VERSION = 1
LOCK_STALE_SECONDS = 240


class AuthError(RuntimeError):
    pass


def _user_cache_root() -> Path:
    if os.name == "nt":
        return Path.home() / ".gdufs-auth"
    return Path.home() / ".cache" / "gdufs-auth"


def _user_config_root() -> Path:
    if os.name == "nt":
        return Path.home() / ".gdufs-auth"
    return Path.home() / ".config" / "gdufs-auth"


DEFAULT_SESSION_PATH = _user_cache_root() / "session.json"
DEFAULT_CONFIG_PATH = _user_config_root() / "config.json"
DEFAULT_PREFERENCE_PATH = _user_cache_root() / "browser_sources.json"
PREFERENCE_VERSION = 1


def _random_string(length: int) -> str:
    return "".join(random.choice(AES_CHARS) for _ in range(length))


def mask_account(value: str) -> str:
    value = (value or "").strip()
    if len(value) <= 4:
        return "*" * len(value)
    return value[:3] + "*" * (len(value) - 3)


def _atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=path.name + ".",
        suffix=".tmp",
        dir=str(path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
        os.replace(temp_name, path)
    finally:
        try:
            Path(temp_name).unlink(missing_ok=True)
        except OSError:
            pass
    if os.name != "nt":
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass


@contextmanager
def session_lock(session_path: Path):
    lock_path = session_path.with_suffix(session_path.suffix + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 60
    handle = None
    while True:
        try:
            handle = os.open(
                str(lock_path),
                os.O_CREAT | os.O_EXCL | os.O_WRONLY,
            )
            break
        except FileExistsError:
            try:
                age = time.time() - lock_path.stat().st_mtime
                if age > LOCK_STALE_SECONDS:
                    lock_path.unlink(missing_ok=True)
                    continue
            except OSError:
                pass
            if time.monotonic() >= deadline:
                raise AuthError(
                    f"Timed out waiting for session lock: {lock_path}"
                )
            time.sleep(0.5)
    try:
        os.write(handle, str(os.getpid()).encode("ascii", errors="ignore"))
        yield
    finally:
        try:
            os.close(handle)
        except OSError:
            pass
        try:
            lock_path.unlink(missing_ok=True)
        except OSError:
            pass


def load_credentials(
    config_path: Path | None = None,
) -> tuple[str, str, bool, int]:
    path = (
        Path(
            os.environ.get("GDUFS_AUTH_CONFIG")
            or config_path
            or DEFAULT_CONFIG_PATH
        )
        .expanduser()
        .resolve()
    )
    data: dict[str, Any] = {}
    if path.is_file():
        data = json.loads(path.read_text(encoding="utf-8"))
    username = str(
        data.get("username") or os.environ.get("GDUFS_USERNAME") or ""
    ).strip()
    password = str(
        data.get("password") or os.environ.get("GDUFS_PASSWORD") or ""
    )
    if not username or not password:
        raise AuthError(
            "Missing credentials. Set GDUFS_USERNAME/GDUFS_PASSWORD or "
            f"provide a config file at {path}."
        )
    verify_ssl = bool(data.get("verify_ssl", True))
    timeout = int(data.get("timeout_seconds", 30))
    return username, password, verify_ssl, timeout


def session_path(value: str | None = None) -> Path:
    raw = value or os.environ.get("GDUFS_AUTH_SESSION") or str(
        DEFAULT_SESSION_PATH
    )
    return Path(raw).expanduser().resolve()


def _file_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()[:16]


def session_key(value: str | None = None) -> str:
    if value:
        return value
    env_key = os.environ.get("CODEX_THREAD_ID") or os.environ.get("CODEX_SESSION_ID")
    if env_key:
        return env_key
    saved = _load_session(DEFAULT_SESSION_PATH)
    if saved:
        material = str(saved.get("saved_at", "")) + str(
            saved.get("username_masked", "")
        )
        if material:
            return "gdufs-" + _file_hash(material)
    return "default"


def preference_path(value: str | None = None) -> Path:
    raw = (
        value
        or os.environ.get("GDUFS_BROWSER_PREFERENCES")
        or str(DEFAULT_PREFERENCE_PATH)
    )
    return Path(raw).expanduser().resolve()


def load_browser_preferences(path: Path | None = None) -> dict[str, Any]:
    target = path or preference_path()
    if not target.is_file():
        return {"version": PREFERENCE_VERSION, "sessions": {}}
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"version": PREFERENCE_VERSION, "sessions": {}}
    if data.get("version") != PREFERENCE_VERSION or not isinstance(
        data.get("sessions"), dict
    ):
        return {"version": PREFERENCE_VERSION, "sessions": {}}
    return data


def save_browser_preferences(
    data: dict[str, Any],
    path: Path | None = None,
) -> None:
    _atomic_write_json(path or preference_path(), data)


def get_browser_preference(
    key: str | None = None,
) -> dict[str, Any]:
    resolved = session_key(key)
    data = load_browser_preferences()
    item = data["sessions"].get(resolved)
    if not item:
        return {
            "status": "unset",
            "session_key": resolved,
            "preferences": str(preference_path()),
        }
    return {
        "status": "set",
        "enabled": bool(item.get("enabled")),
        "asked_at": item.get("asked_at"),
        "session_key": resolved,
        "preferences": str(preference_path()),
    }


def set_browser_preference(
    enabled: bool,
    key: str | None = None,
) -> dict[str, Any]:
    resolved = session_key(key)
    data = load_browser_preferences()
    data["sessions"][resolved] = {
        "enabled": bool(enabled),
        "asked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    save_browser_preferences(data)
    return {
        "status": "set",
        "enabled": bool(enabled),
        "session_key": resolved,
        "preferences": str(preference_path()),
    }


def reset_browser_preference(key: str | None = None) -> dict[str, Any]:
    resolved = session_key(key)
    data = load_browser_preferences()
    data["sessions"].pop(resolved, None)
    save_browser_preferences(data)
    return {
        "status": "reset",
        "session_key": resolved,
        "preferences": str(preference_path()),
    }


def _session_cookie_dict(session: requests.Session) -> list[dict[str, Any]]:
    cookies = []
    for cookie in session.cookies:
        cookies.append(
            {
                "name": cookie.name,
                "value": cookie.value,
                "domain": cookie.domain,
                "path": cookie.path or "/",
                "secure": bool(cookie.secure),
                "expires": cookie.expires,
            }
        )
    return cookies


def _load_session(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if data.get("version") != SESSION_VERSION:
        return None
    if not isinstance(data.get("cookies"), list):
        return None
    return data


def _requests_session_from_saved(
    saved: dict[str, Any],
) -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept-Language": "zh-CN,zh;q=0.9",
        }
    )
    for cookie in saved.get("cookies", []):
        if not cookie.get("name") or cookie.get("value") is None:
            continue
        session.cookies.set(
            cookie["name"],
            cookie["value"],
            domain=cookie.get("domain") or None,
            path=cookie.get("path") or "/",
        )
    return session


def vpn_status(
    session: requests.Session,
    verify_ssl: bool = True,
    timeout: int = 30,
) -> dict[str, Any]:
    response = session.post(
        VPN_BASE + "/api/acl_ipInterval_shunt/ipissuccess",
        data={},
        verify=verify_ssl,
        timeout=timeout,
    )
    return response.json()


class GdufsAuthAutoLogin:
    """Ported from Systina12/gdufs-auth-autologin-python (MIT)."""

    def __init__(
        self,
        session: requests.Session,
        username: str,
        password: str,
        verify_ssl: bool = True,
        timeout: int = 30,
    ) -> None:
        self.session = session
        self.username = username
        self.password = password
        self.verify_ssl = verify_ssl
        self.timeout = timeout
        self.session.headers.update(
            {
                "User-Agent": USER_AGENT,
                "Accept": (
                    "text/html,application/xhtml+xml,application/xml;q=0.9,"
                    "image/avif,image/webp,image/apng,*/*;q=0.8,"
                    "application/signed-exchange;v=b3;q=0.7"
                ),
                "Accept-Language": "zh-CN,zh;q=0.9",
                "Upgrade-Insecure-Requests": "1",
                "Sec-Fetch-Site": "same-origin",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Dest": "document",
            }
        )
        self.session.get(
            AUTH_BASE,
            verify=self.verify_ssl,
            timeout=self.timeout,
        )

    def _pre_login_chain(self) -> None:
        urls = [
            AUTH_LOGIN,
            AUTH_BASE + "/authserver/tenant/info",
            AUTH_BASE
            + "/authserver/bfp/info?bfp=E6BB3635294256FEA4CCA29448B155A2&_="
            + str(int(time.time() * 1000)),
            AUTH_BASE
            + "/authserver/checkNeedCaptcha.htl?username="
            + urllib.parse.quote(self.username, safe="")
            + "&_="
            + str(int(time.time() * 1000)),
            AUTH_BASE
            + "/authserver/common/openSliderCaptcha.htl?_="
            + str(int(time.time() * 1000)),
        ]
        for url in urls:
            try:
                self.session.get(
                    url,
                    verify=self.verify_ssl,
                    timeout=self.timeout,
                )
            except requests.RequestException:
                pass
        try:
            self.session.cookies.set(
                name="org.springframework.web.servlet.i18n.CookieLocaleResolver.LOCALE",
                value="zh_CN",
                domain="authserver.gdufs.edu.cn",
                path="/",
            )
        except Exception:
            pass

    def _get_param(self, text: str, param_id: str) -> str:
        tree = lxml_html.fromstring(text)
        elem = tree.xpath(
            f'//form[@id="pwdFromId"]//input[@id="{param_id}"]'
        )
        if not elem:
            raise AuthError(
                f"param '{param_id}' not found in form#pwdFromId"
            )
        value = elem[0].get("value")
        if value is None:
            raise AuthError(f"param '{param_id}' has no value attribute")
        return value

    def _encrypt_password(self, password: str, salt: str) -> str:
        plaintext = (_random_string(64) + password).encode("utf-8")
        key = salt.encode("utf-8")
        iv = _random_string(16).encode("utf-8")
        cipher = AES.new(key, AES.MODE_CBC, iv=iv)
        ciphertext = cipher.encrypt(pad(plaintext, AES.block_size))
        return base64.b64encode(ciphertext).decode("ascii")

    def login(
        self,
        login_url: str | None = None,
        service: str | None = None,
    ) -> requests.Response:
        if login_url is None:
            login_url = AUTH_LOGIN
            if service:
                login_url += "?service=" + urllib.parse.quote(
                    service,
                    safe="",
                )
        if "service=" not in login_url:
            self._pre_login_chain()
        response = self.session.get(
            login_url,
            verify=self.verify_ssl,
            timeout=self.timeout,
        )
        text = response.text
        data = {
            "username": self.username,
            "password": self._encrypt_password(
                self.password,
                self._get_param(text, "pwdEncryptSalt"),
            ),
            "captcha": "",
            "_eventId": self._get_param(text, "_eventId"),
            "cllt": self._get_param(text, "cllt"),
            "dllt": self._get_param(text, "dllt"),
            "lt": self._get_param(text, "lt"),
            "execution": self._get_param(text, "execution"),
        }
        login_response = self.session.post(
            login_url,
            data=data,
            verify=self.verify_ssl,
            timeout=self.timeout,
            allow_redirects=False,
        )
        if login_response.status_code not in (301, 302, 303, 307, 308):
            raise AuthError(
                f"SSO login failed: HTTP {login_response.status_code}"
            )
        location = login_response.headers.get("Location")
        if not location:
            raise AuthError("SSO login failed: no Location header")
        return self.session.get(
            urllib.parse.urljoin(login_url, location),
            verify=self.verify_ssl,
            timeout=self.timeout,
            allow_redirects=True,
        )


def _extract_caslogin_url(page_html: str) -> str:
    match = re.search(r"caslogin\('([^']+)'\)", page_html)
    if not match:
        raise AuthError("智慧广外登录页中未找到 caslogin target")
    target = urllib.parse.unquote(match.group(1))
    ts_match = re.search(r"var\s+ts\s*=\s*'([^']+)'", page_html)
    ts = ts_match.group(1) if ts_match else str(int(time.time() * 1000))
    if "?" in target:
        head, tail = target.split("?", 1)
        signed = head + "&" + tail + "&__ts__=" + ts
    else:
        signed = target + "&__ts__=" + ts
    encoded = base64.b64encode(signed.encode("utf-8")).decode("ascii")
    return (
        LIB_BASE
        + "/wx/casAuth/toCaslogin?target="
        + urllib.parse.quote(encoded, safe="")
    )


def _submit_cas_form(
    session: requests.Session,
    page_html: str,
    current_url: str,
    verify_ssl: bool,
    timeout: int,
) -> requests.Response | None:
    try:
        doc = lxml_html.fromstring(page_html)
    except Exception:
        return None
    forms = doc.xpath('//form[@id="casform"]')
    if not forms:
        return None
    form = forms[0]
    payload: dict[str, str] = {}
    for inp in form.xpath(".//input"):
        name = inp.get("name")
        if name:
            payload[name] = inp.get("value") or ""
    if "/caslogin.do" in current_url:
        action = payload.get("service") or ""
    else:
        action = form.get("action") or ""
        action = urllib.parse.urljoin(current_url, action)
        query = urllib.parse.urlsplit(current_url).query
        if query and "?" not in action:
            action += "?" + query
    if not action:
        return None
    return session.post(
        action,
        data=payload,
        verify=verify_ssl,
        timeout=timeout,
        allow_redirects=True,
    )


def login_gdufs(
    username: str,
    password: str,
    verify_ssl: bool = True,
    timeout: int = 30,
) -> tuple[requests.Session, requests.Response]:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept-Language": "zh-CN,zh;q=0.9",
        }
    )
    entry = (
        LIB_BASE
        + "/wx/login?service="
        + urllib.parse.quote(VPN_CALLBACK, safe="")
    )
    library_page = session.get(
        entry,
        verify=verify_ssl,
        timeout=timeout,
        allow_redirects=True,
    )
    cas_url = _extract_caslogin_url(library_page.text)
    cas_response = session.get(
        cas_url,
        verify=verify_ssl,
        timeout=timeout,
        allow_redirects=False,
    )
    if cas_response.status_code not in (301, 302, 303, 307, 308):
        raise AuthError("casAuth did not return an authserver redirect")
    auth_url = urllib.parse.urljoin(
        cas_url,
        cas_response.headers.get("Location", ""),
    )
    login = GdufsAuthAutoLogin(
        session,
        username,
        password,
        verify_ssl=verify_ssl,
        timeout=timeout,
    )
    response = login.login(login_url=auth_url)
    for _ in range(3):
        submitted = _submit_cas_form(
            session,
            response.text,
            response.url,
            verify_ssl,
            timeout,
        )
        if submitted is None:
            break
        response = submitted
    status = vpn_status(session, verify_ssl=verify_ssl, timeout=timeout)
    return session, response


def save_session(
    path: Path,
    username: str,
    session: requests.Session,
    status: dict[str, Any],
) -> dict[str, Any]:
    cookies = _session_cookie_dict(session)
    data = {
        "version": SESSION_VERSION,
        "saved_at": time.strftime(
            "%Y-%m-%dT%H:%M:%SZ",
            time.gmtime(),
        ),
        "username_masked": mask_account(username),
        "cookies": cookies,
        "vpn_status": status,
    }
    _atomic_write_json(path, data)
    return data


def cmd_login(args: argparse.Namespace) -> int:
    path = session_path(args.session)
    username, password, verify_ssl, timeout = load_credentials(args.config)
    with session_lock(path):
        session, final = login_gdufs(
            username,
            password,
            verify_ssl=verify_ssl,
            timeout=timeout,
        )
        status = vpn_status(session, verify_ssl=verify_ssl, timeout=timeout)
        data = save_session(path, username, session, status)
    print(
        json.dumps(
            {
                "status": "saved",
                "session": str(path),
                "username": data["username_masked"],
                "vpn_status": status,
                "final_url": final.url,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    path = session_path(args.session)
    saved = _load_session(path)
    if not saved:
        print(
            json.dumps(
                {"status": "missing", "session": str(path)},
                ensure_ascii=False,
            )
        )
        return 1
    username, _password, verify_ssl, timeout = load_credentials(
        args.config
    )
    session = _requests_session_from_saved(saved)
    status = vpn_status(session, verify_ssl=verify_ssl, timeout=timeout)
    valid = status.get("islogin") == "true"
    print(
        json.dumps(
            {
                "status": "valid" if valid else "expired",
                "valid": valid,
                "session": str(path),
                "saved_at": saved.get("saved_at"),
                "username": saved.get("username_masked")
                or mask_account(username),
                "vpn_status": status,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if valid else 1


def cmd_ensure(args: argparse.Namespace) -> int:
    path = session_path(args.session)
    saved = _load_session(path)
    if saved:
        try:
            username, _password, verify_ssl, timeout = load_credentials(
                args.config
            )
            session = _requests_session_from_saved(saved)
            status = vpn_status(
                session,
                verify_ssl=verify_ssl,
                timeout=timeout,
            )
            if status.get("islogin") == "true":
                print(
                    json.dumps(
                        {
                            "status": "reused",
                            "valid": True,
                            "session": str(path),
                            "saved_at": saved.get("saved_at"),
                            "username": saved.get("username_masked")
                            or mask_account(username),
                            "vpn_status": status,
                        },
                        ensure_ascii=False,
                        indent=2,
                    )
                )
                return 0
        except (AuthError, requests.RequestException, ValueError):
            pass
    return cmd_login(args)


def cmd_cookies(args: argparse.Namespace) -> int:
    path = session_path(args.session)
    saved = _load_session(path)
    if not saved:
        raise AuthError(f"Session file not found: {path}")
    payload = json.dumps(saved.get("cookies", []), ensure_ascii=False, indent=2)
    if args.out:
        out = Path(args.out).expanduser().resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(payload, encoding="utf-8")
        print(json.dumps({"out": str(out), "cookies": len(saved["cookies"])}, ensure_ascii=False))
    else:
        print(payload)
    return 0


def cmd_inspect(args: argparse.Namespace) -> int:
    path = session_path(args.session)
    saved = _load_session(path)
    if not saved:
        raise AuthError(f"Session file not found: {path}")
    print(
        json.dumps(
            {
                "session": str(path),
                "version": saved.get("version"),
                "saved_at": saved.get("saved_at"),
                "username": saved.get("username_masked"),
                "cookie_names": sorted(
                    {
                        (item.get("name"), item.get("domain"))
                        for item in saved.get("cookies", [])
                    }
                ),
                "vpn_status": saved.get("vpn_status"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def cmd_clear(args: argparse.Namespace) -> int:
    path = session_path(args.session)
    path.unlink(missing_ok=True)
    path.with_suffix(path.suffix + ".lock").unlink(missing_ok=True)
    print(json.dumps({"status": "cleared", "session": str(path)}, ensure_ascii=False))
    return 0


def cmd_browser_preference(args: argparse.Namespace) -> int:
    if args.action == "get":
        result = get_browser_preference(args.session_key)
    elif args.action == "set":
        enabled = str(args.enabled).strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        result = set_browser_preference(enabled, args.session_key)
    else:
        result = reset_browser_preference(args.session_key)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("login", "status", "ensure", "inspect", "clear"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--session")
        cmd.add_argument("--config")
    cookies = sub.add_parser("cookies")
    cookies.add_argument("--session")
    cookies.add_argument("--config")
    cookies.add_argument("--out")
    browser = sub.add_parser("browser-preference")
    browser_sub = browser.add_subparsers(dest="action", required=True)
    browser_get = browser_sub.add_parser("get")
    browser_get.add_argument("--session-key")
    browser_set = browser_sub.add_parser("set")
    browser_set.add_argument("--session-key")
    browser_set.add_argument(
        "--enabled",
        required=True,
        choices=["true", "false", "1", "0", "yes", "no", "on", "off"],
    )
    browser_reset = browser_sub.add_parser("reset")
    browser_reset.add_argument("--session-key")
    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        return {
            "login": cmd_login,
            "status": cmd_status,
            "ensure": cmd_ensure,
            "cookies": cmd_cookies,
            "inspect": cmd_inspect,
            "clear": cmd_clear,
            "browser-preference": cmd_browser_preference,
        }[args.command](args)
    except (AuthError, requests.RequestException, ValueError) as exc:
        print(
            json.dumps(
                {"status": "error", "error": str(exc)},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
