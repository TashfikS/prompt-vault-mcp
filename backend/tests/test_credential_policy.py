"""Email-domain and password rules for sign-up, password reset and password change."""

import hashlib

import httpx
import pytest
from httpx import AsyncClient

from services import credential_policy
from services.credential_policy import (BREACHED_PASSWORD_MESSAGE, email_domain_problem, is_password_breached,
                                        validate_password_rules)

GOOD_PASSWORD = "purple tiger eats cold pizza"


def _signup(email="person@corp.com", password=GOOD_PASSWORD):
    return {"name": "Person", "email": email, "password": password, "accept_terms": True}


def _sha1_parts(password: str) -> tuple[str, str]:
    digest = hashlib.sha1(password.encode()).hexdigest().upper()
    return digest[:5], digest[5:]


class FakeResponse:
    def __init__(self, text: str, status: int = 200):
        self.text = text
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("error", request=None, response=None)


@pytest.fixture
def pwned_on(monkeypatch):
    monkeypatch.setenv("PWNED_PASSWORD_CHECK", "1")


# --- Email domains -----------------------------------------------------------------------------

@pytest.mark.parametrize("email", [
    "a@example.com", "a@example.org", "a@example.net", "a@EXAMPLE.COM",
    "a@foo.example", "a@site.test", "a@host.invalid", "a@box.localhost", "a@printer.local",
])
def test_reserved_domains_rejected(email, monkeypatch):
    monkeypatch.delenv("ALLOWED_TEST_EMAIL_DOMAINS", raising=False)
    assert "can't receive mail" in email_domain_problem(email)


@pytest.mark.parametrize("email", ["a@mailinator.com", "a@sub.mailinator.com", "a@guerrillamail.com"])
def test_disposable_domains_rejected(email):
    assert "Disposable" in email_domain_problem(email)


@pytest.mark.parametrize("email", ["a@gmail.com", "a@corp.com", "a@mail.company.co.uk", "first.last@university.edu"])
def test_real_domains_allowed(email):
    assert email_domain_problem(email) is None


def test_test_domain_allowlist(monkeypatch):
    monkeypatch.setenv("ALLOWED_TEST_EMAIL_DOMAINS", "example.com, ci.example.org")
    assert email_domain_problem("a@example.com") is None
    assert email_domain_problem("a@ci.example.org") is None
    assert email_domain_problem("a@example.net") is not None


@pytest.mark.asyncio
async def test_register_rejects_reserved_email(client: AsyncClient, monkeypatch):
    monkeypatch.delenv("ALLOWED_TEST_EMAIL_DOMAINS", raising=False)
    res = await client.post("/api/auth/register", json=_signup(email="someone@example.com"))
    assert res.status_code == 422
    assert "can't receive mail" in str(res.json())


# --- Password length ---------------------------------------------------------------------------

def test_password_length_rules():
    with pytest.raises(ValueError, match="at least 12"):
        validate_password_rules("Short1!")
    with pytest.raises(ValueError, match="at most"):
        validate_password_rules("x" * 201)
    # No composition rules: lowercase words with spaces are fine.
    assert validate_password_rules(GOOD_PASSWORD) == GOOD_PASSWORD


@pytest.mark.asyncio
async def test_register_rejects_short_password(client: AsyncClient):
    res = await client.post("/api/auth/register", json=_signup(password="Ab1!efgh"))
    assert res.status_code == 422
    assert "at least 12 characters" in str(res.json())


@pytest.mark.asyncio
async def test_register_accepts_passphrase_without_symbols(client: AsyncClient):
    res = await client.post("/api/auth/register", json=_signup(email="phrase@corp.com"))
    assert res.status_code == 201, res.text


# --- Breached passwords (Have I Been Pwned, k-anonymity) ---------------------------------------

def test_breached_password_detected_and_only_prefix_sent(pwned_on, monkeypatch):
    prefix, suffix = _sha1_parts("Summer2026!")
    calls = []

    def fake_get(url, headers, timeout):
        calls.append((url, headers, timeout))
        # Real responses include padding lines with a count of 0.
        return FakeResponse(f"0000000000000000000000000000000000A:0\r\n{suffix}:24000\r\n")

    monkeypatch.setattr(credential_policy.httpx, "get", fake_get)
    assert is_password_breached("Summer2026!") is True
    (url, headers, timeout), = calls
    assert url.endswith("/range/" + prefix)  # only 5 hex chars of the hash leave the server
    assert "Summer2026!" not in url and suffix not in url
    assert headers["Add-Padding"] == "true"
    assert timeout <= 2.0


def test_padding_entry_is_not_a_match(pwned_on, monkeypatch):
    _, suffix = _sha1_parts(GOOD_PASSWORD)
    monkeypatch.setattr(credential_policy.httpx, "get", lambda *a, **k: FakeResponse(f"{suffix}:0\r\n"))
    assert is_password_breached(GOOD_PASSWORD) is False


@pytest.mark.parametrize("failure", [httpx.ConnectTimeout("slow"), httpx.ConnectError("down")])
def test_check_fails_open_when_service_unavailable(pwned_on, monkeypatch, failure):
    def boom(*a, **k):
        raise failure
    monkeypatch.setattr(credential_policy.httpx, "get", boom)
    assert is_password_breached(GOOD_PASSWORD) is False


def test_check_fails_open_on_server_error(pwned_on, monkeypatch):
    monkeypatch.setattr(credential_policy.httpx, "get", lambda *a, **k: FakeResponse("", status=503))
    assert is_password_breached(GOOD_PASSWORD) is False


def test_check_can_be_disabled(monkeypatch):
    monkeypatch.setenv("PWNED_PASSWORD_CHECK", "0")

    def must_not_call(*a, **k):
        raise AssertionError("network call while disabled")
    monkeypatch.setattr(credential_policy.httpx, "get", must_not_call)
    assert is_password_breached("Password1234") is False


@pytest.mark.asyncio
async def test_register_rejects_breached_password(client: AsyncClient, pwned_on, monkeypatch):
    monkeypatch.setattr(credential_policy, "is_password_breached", lambda pw: True)
    import routers.auth_routes as auth_routes
    monkeypatch.setattr(auth_routes, "is_password_breached", lambda pw: True)
    res = await client.post("/api/auth/register", json=_signup(email="leaky@corp.com"))
    assert res.status_code == 400
    assert res.json()["detail"] == BREACHED_PASSWORD_MESSAGE


@pytest.mark.asyncio
async def test_change_password_rejects_breached_password(client: AsyncClient, test_users_and_groups, monkeypatch):
    import routers.account as account
    monkeypatch.setattr(account, "is_password_breached", lambda pw: True)
    headers = {"Authorization": f"Bearer {test_users_and_groups['tokens']['member']}"}
    res = await client.post("/api/me/change-password", headers=headers,
                            json={"current_password": "Password1234", "new_password": GOOD_PASSWORD})
    assert res.status_code == 400
    assert res.json()["detail"] == BREACHED_PASSWORD_MESSAGE
