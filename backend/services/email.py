"""Transactional email (verification and password reset) via the Resend HTTP API.

Configure ``RESEND_API_KEY`` and ``EMAIL_FROM`` (e.g. ``PromptHold <no-reply@prompthold.com>``).
Without a key, development logs the message instead of sending it; production
logs an error so a missing key is noticed rather than silently dropping mail.
"""

from __future__ import annotations

import html
import logging
import os

import httpx

logger = logging.getLogger("uvicorn.error")

RESEND_ENDPOINT = "https://api.resend.com/emails"


def is_email_configured() -> bool:
    return bool(os.getenv("RESEND_API_KEY", "").strip())


def link_base_url(fallback: str) -> str:
    """Base URL for links in emails.

    Production must use the configured PUBLIC_BASE_URL/APP_URL: deriving it from
    request headers would let a forged Host send reset links to an attacker's site.
    """
    from security import IS_PRODUCTION

    env_url = (os.getenv("PUBLIC_BASE_URL") or os.getenv("APP_URL") or "").strip().rstrip("/")
    if env_url:
        return env_url
    if IS_PRODUCTION:
        logger.error("PUBLIC_BASE_URL is not set; refusing to build email links from request headers in production")
        raise RuntimeError("PUBLIC_BASE_URL must be set in production to send account emails.")
    return fallback.rstrip("/")


def send_email(to: str, subject: str, text: str, html_body: str) -> bool:
    """Send one email. Returns True when handed to the provider; never raises."""
    api_key = os.getenv("RESEND_API_KEY", "").strip()
    sender = os.getenv("EMAIL_FROM", "").strip() or "PromptHold <onboarding@resend.dev>"
    if not api_key:
        from security import IS_PRODUCTION

        if IS_PRODUCTION:
            logger.error("RESEND_API_KEY is not set; could not send '%s' email", subject)
        else:
            logger.warning("[dev email] To: %s | Subject: %s\n%s", to, subject, text)
        return False
    try:
        resp = httpx.post(
            RESEND_ENDPOINT,
            headers={"Authorization": f"Bearer {api_key}"},
            json={"from": sender, "to": [to], "subject": subject, "text": text, "html": html_body},
            timeout=10.0,
        )
        if resp.status_code >= 300:
            logger.error("Resend rejected '%s' email: HTTP %s %s", subject, resp.status_code, resp.text[:300])
            return False
        return True
    except Exception:
        logger.exception("Failed to send '%s' email", subject)
        return False


def _render(heading: str, intro: str, button: str, url: str, footer: str) -> tuple[str, str]:
    text = f"{heading}\n\n{intro}\n\n{url}\n\n{footer}\n"
    safe_url = html.escape(url, quote=True)
    body = (
        '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;color:#0f172a">'
        f"<h2>{html.escape(heading)}</h2><p>{html.escape(intro)}</p>"
        f'<p><a href="{safe_url}" style="display:inline-block;background:#4f46e5;color:#fff;'
        f'padding:10px 18px;border-radius:8px;text-decoration:none">{html.escape(button)}</a></p>'
        f'<p style="font-size:12px;color:#64748b">Or paste this link: {safe_url}</p>'
        f'<p style="font-size:12px;color:#64748b">{html.escape(footer)}</p></div>'
    )
    return text, body


def send_verification_email(to: str, name: str, url: str) -> bool:
    text, body = _render(
        "Confirm your email",
        f"Hi {name}, confirm this address to finish setting up your PromptHold account.",
        "Confirm email",
        url,
        "This link expires in 48 hours. If you didn't sign up, ignore this email.",
    )
    return send_email(to, "Confirm your PromptHold email", text, body)


def send_password_reset_email(to: str, name: str, url: str) -> bool:
    text, body = _render(
        "Reset your password",
        f"Hi {name}, someone asked to reset the password for your PromptHold account.",
        "Choose a new password",
        url,
        "This link expires in 1 hour and works once. If you didn't ask for this, ignore this email.",
    )
    return send_email(to, "Reset your PromptHold password", text, body)
