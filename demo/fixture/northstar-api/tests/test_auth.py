"""Checks the session cookie the fictional Northstar Notes API issues."""

import unittest

from src.auth import CookieSettings, build_session_cookie


class SessionCookieTest(unittest.TestCase):
    def test_cookie_is_secure_when_configured(self) -> None:
        cookie = build_session_cookie("token", CookieSettings(secure_cookies=True))
        self.assertTrue(cookie["secure"])


if __name__ == "__main__":
    unittest.main()
