"""Rules for new emails and passwords (sign-up, password reset, password change).

Passwords follow NIST SP 800-63B: a minimum length and a breached-password check,
with no upper/lower/symbol composition rules. Emails must use a domain that can
actually receive mail: reserved example/test domains and disposable inboxes are
rejected.
"""

import hashlib
import logging
import os

import httpx
from disposable_email_domains import blocklist as DISPOSABLE_DOMAINS

logger = logging.getLogger(__name__)

PASSWORD_MIN_LENGTH = 12
PASSWORD_MAX_LENGTH = 200

PWNED_RANGE_URL = "https://api.pwnedpasswords.com/range/"
PWNED_TIMEOUT_SECONDS = 2.0

# RFC 2606 / RFC 6761: these can never receive real mail.
RESERVED_DOMAINS = frozenset({"example.com", "example.net", "example.org"})
RESERVED_TLDS = frozenset({"example", "test", "invalid", "localhost", "local"})

BREACHED_PASSWORD_MESSAGE = (
    "This password is too common: it has appeared in other websites' data breaches, "
    "so attackers try it first. Please choose a different one."
)


def validate_password_rules(password: str) -> str:
    """Length-only rule (used by the Pydantic request schemas)."""
    if len(password) < PASSWORD_MIN_LENGTH:
        raise ValueError(f"Password must be at least {PASSWORD_MIN_LENGTH} characters long.")
    if len(password) > PASSWORD_MAX_LENGTH:
        raise ValueError(f"Password must be at most {PASSWORD_MAX_LENGTH} characters long.")
    return password


def _allowed_test_domains() -> set[str]:
    """Domains exempt from the reserved/disposable check (tests and local e2e only)."""
    raw = os.getenv("ALLOWED_TEST_EMAIL_DOMAINS", "")
    return {d.strip().lower() for d in raw.split(",") if d.strip()}


def email_domain_problem(email: str) -> str | None:
    """Return a user-facing reason the email's domain is not allowed, or None if it is fine."""
    domain = email.rsplit("@", 1)[-1].strip().lower().rstrip(".")
    if not domain or "." not in domain:
        return "Please enter a valid email address."
    if domain in _allowed_test_domains():
        return None
    if domain in RESERVED_DOMAINS or domain.rsplit(".", 1)[-1] in RESERVED_TLDS:
        return "This email domain can't receive mail. Please use your real email address."
    # Match the domain and every parent domain (e.g. "x.mailinator.com" -> "mailinator.com").
    parts = domain.split(".")
    for i in range(len(parts) - 1):
        if ".".join(parts[i:]) in DISPOSABLE_DOMAINS:
            return "Disposable email addresses aren't supported. Please use a permanent email address."
    return None


def pwned_check_enabled() -> bool:
    return os.getenv("PWNED_PASSWORD_CHECK", "1").strip().lower() not in {"0", "false", "no", "off"}


def is_password_breached(password: str) -> bool:
    """Check Have I Been Pwned using k-anonymity: only the first 5 hex chars of the SHA-1 leave the server.

    Fails open (returns False) when the check is disabled, times out or errors, so an outside
    outage never blocks sign-up. Never logs the password or its hash.
    """
    if not pwned_check_enabled():
        return False
    digest = hashlib.sha1(password.encode("utf-8"), usedforsecurity=False).hexdigest().upper()
    prefix, suffix = digest[:5], digest[5:]
    try:
        resp = httpx.get(
            PWNED_RANGE_URL + prefix,
            headers={"Add-Padding": "true", "User-Agent": "PromptFolders-password-check"},
            timeout=PWNED_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
    except Exception as exc:  # network error, timeout, non-2xx
        logger.warning("Breached-password check unavailable, allowing password: %s", type(exc).__name__)
        return False
    for line in resp.text.splitlines():
        candidate, _, count = line.partition(":")
        # Padding entries have a count of 0 and must be ignored.
        if candidate.strip() == suffix and count.strip() not in {"", "0"}:
            return True
    return False
