"""Session-cookie helpers for the fictional Northstar Notes API."""

from dataclasses import dataclass


@dataclass(frozen=True)
class CookieSettings:
    secure_cookies: bool
    lifetime_seconds: int = 3600


def build_session_cookie(token: str, settings: CookieSettings) -> dict[str, object]:
    """Build the cookie attributes returned after a successful sign-in."""
    return {
        "value": token,
        "httponly": True,
        "secure": False,
        "samesite": "lax",
        "max_age": settings.lifetime_seconds,
    }
