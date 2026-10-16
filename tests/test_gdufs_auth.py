from __future__ import annotations

import base64
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "gdufs_auth",
    ROOT / "scripts" / "gdufs_auth.py",
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class GdufsAuthTests(unittest.TestCase):
    def test_mask_account(self) -> None:
        self.assertEqual(MODULE.mask_account("20250001"), "202*****")
        self.assertEqual(MODULE.mask_account("abc"), "***")

    def test_extract_caslogin_url(self) -> None:
        page = (
            "<script>var ts='123456'; "
            "caslogin('https%3A%2F%2Fexample.org%2Fcb%3Fmark%3DX');"
            "</script>"
        )
        url = MODULE._extract_caslogin_url(page)
        query = parse_qs(urlparse(url).query)
        decoded = base64.b64decode(query["target"][0]).decode()
        self.assertEqual(
            decoded,
            "https://example.org/cb&mark=X&__ts__=123456",
        )

    def test_session_round_trip_without_password(self) -> None:
        class Cookie:
            name = "vpn-cookie"
            value = "secret-cookie"
            domain = ".libvpn.gdufs.edu.cn"
            path = "/"
            secure = True
            expires = None

        class Session:
            cookies = [Cookie()]

        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "session.json"
            data = MODULE.save_session(
                path,
                "20250001",
                Session(),
                {"islogin": "true"},
            )
            self.assertNotIn("password", json.dumps(data).lower())
            self.assertEqual(data["username_masked"], "202*****")
            self.assertEqual(data["cookies"][0]["name"], "vpn-cookie")
            loaded = MODULE._load_session(path)
            self.assertEqual(loaded["vpn_status"]["islogin"], "true")

    def test_load_credentials_from_explicit_config(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "config.json"
            path.write_text(
                json.dumps(
                    {
                        "username": "20250001",
                        "password": "not-printed",
                        "verify_ssl": False,
                        "timeout_seconds": 12,
                    }
                ),
                encoding="utf-8",
            )
            username, password, verify_ssl, timeout = (
                MODULE.load_credentials(path)
            )
            self.assertEqual(username, "20250001")
            self.assertEqual(password, "not-printed")
            self.assertFalse(verify_ssl)
            self.assertEqual(timeout, 12)

    def test_requests_session_restores_cookie(self) -> None:
        saved = {
            "cookies": [
                {
                    "name": "vpn-cookie",
                    "value": "secret",
                    "domain": ".libvpn.gdufs.edu.cn",
                    "path": "/",
                }
            ]
        }
        session = MODULE._requests_session_from_saved(saved)
        self.assertEqual(
            session.cookies.get("vpn-cookie", domain=".libvpn.gdufs.edu.cn"),
            "secret",
        )


if __name__ == "__main__":
    unittest.main()
