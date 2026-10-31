"""Sign-up consent, email verification and password reset."""

from datetime import datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.orm import Session

from models import User
from services import account_tokens

SIGNUP = {"name": "New Person", "email": "new@example.com", "password": "Password123", "accept_terms": True}


@pytest.fixture
def captured_emails(monkeypatch):
    """Capture outgoing links instead of sending email."""
    sent: list[dict] = []
    import routers.auth_routes as routes

    monkeypatch.setattr(routes, "send_verification_email", lambda to, name, url: sent.append({"kind": "verify", "to": to, "url": url}) or True)
    monkeypatch.setattr(routes, "send_password_reset_email", lambda to, name, url: sent.append({"kind": "reset", "to": to, "url": url}) or True)
    return sent


def _token(url: str, param: str) -> str:
    return url.split(f"{param}=", 1)[1]


@pytest.mark.asyncio
async def test_register_requires_terms(client: AsyncClient, db: Session):
    body = {k: v for k, v in SIGNUP.items() if k != "accept_terms"}
    assert (await client.post("/api/auth/register", json=body)).status_code == 422
    assert (await client.post("/api/auth/register", json={**body, "accept_terms": False})).status_code == 422
    assert db.query(User).filter_by(email="new@example.com").first() is None


@pytest.mark.asyncio
async def test_register_records_consent_and_sends_verification(client: AsyncClient, db: Session, captured_emails):
    res = await client.post("/api/auth/register", json={**SIGNUP, "marketing_opt_in": True})
    assert res.status_code == 201
    user = db.query(User).filter_by(email="new@example.com").one()
    assert user.terms_accepted_at is not None and user.terms_version
    assert user.marketing_opt_in is True and user.marketing_opt_in_at is not None
    assert user.email_verified_at is None
    assert [e["kind"] for e in captured_emails] == ["verify"]
    assert user.verify_token_hash and user.verify_token_hash not in captured_emails[0]["url"]  # only the hash is stored

    me = await client.get("/api/me", headers={"Authorization": f"Bearer {res.json()['token']}"})
    assert me.json()["email_verified"] is False


@pytest.mark.asyncio
async def test_marketing_defaults_off(client: AsyncClient, db: Session, captured_emails):
    assert (await client.post("/api/auth/register", json=SIGNUP)).status_code == 201
    user = db.query(User).filter_by(email="new@example.com").one()
    assert user.marketing_opt_in is False and user.marketing_opt_in_at is None


@pytest.mark.asyncio
async def test_verify_email_link_is_single_use(client: AsyncClient, db: Session, captured_emails):
    await client.post("/api/auth/register", json=SIGNUP)
    token = _token(captured_emails[0]["url"], "verify_token")
    ok = await client.post("/api/auth/verify-email", json={"token": token})
    assert ok.status_code == 200 and ok.json()["verified"] is True
    assert db.query(User).filter_by(email="new@example.com").one().email_verified_at is not None
    assert (await client.post("/api/auth/verify-email", json={"token": token})).status_code == 400


@pytest.mark.asyncio
async def test_expired_verify_token_rejected(client: AsyncClient, db: Session, captured_emails):
    await client.post("/api/auth/register", json=SIGNUP)
    user = db.query(User).filter_by(email="new@example.com").one()
    user.verify_token_expires_at = datetime.utcnow() - timedelta(minutes=1)
    db.commit()
    token = _token(captured_emails[0]["url"], "verify_token")
    assert (await client.post("/api/auth/verify-email", json={"token": token})).status_code == 400


@pytest.mark.asyncio
async def test_checkout_blocked_until_verified(client: AsyncClient, db: Session, captured_emails):
    reg = await client.post("/api/auth/register", json=SIGNUP)
    headers = {"Authorization": f"Bearer {reg.json()['token']}"}
    blocked = await client.post("/api/billing/checkout", headers=headers, json={"plan": "pro"})
    assert blocked.status_code == 403 and "Confirm your email" in blocked.json()["detail"]
    await client.post("/api/auth/verify-email", json={"token": _token(captured_emails[0]["url"], "verify_token")})
    assert (await client.post("/api/billing/checkout", headers=headers, json={"plan": "pro"})).status_code == 200


@pytest.mark.asyncio
async def test_forgot_password_does_not_reveal_accounts(client: AsyncClient, db: Session, captured_emails):
    await client.post("/api/auth/register", json=SIGNUP)
    known = await client.post("/api/auth/forgot-password", json={"email": "new@example.com"})
    unknown = await client.post("/api/auth/forgot-password", json={"email": "nobody@example.com"})
    assert known.status_code == unknown.status_code == 200
    assert known.json() == unknown.json()
    assert [e["kind"] for e in captured_emails] == ["verify", "reset"]


@pytest.mark.asyncio
async def test_reset_password_flow(client: AsyncClient, db: Session, captured_emails):
    reg = await client.post("/api/auth/register", json=SIGNUP)
    old_token = reg.json()["token"]
    await client.post("/api/auth/forgot-password", json={"email": "new@example.com"})
    raw = _token(captured_emails[-1]["url"], "reset_token")

    weak = await client.post("/api/auth/reset-password", json={"token": raw, "new_password": "short"})
    assert weak.status_code == 422

    ok = await client.post("/api/auth/reset-password", json={"token": raw, "new_password": "BrandNew456"})
    assert ok.status_code == 200
    # Old sessions are signed out, the new password works, the old one doesn't, the link is spent.
    assert (await client.get("/api/me", headers={"Authorization": f"Bearer {old_token}"})).status_code == 401
    assert (await client.post("/api/auth/login", json={"email": "new@example.com", "password": "BrandNew456"})).status_code == 200
    assert (await client.post("/api/auth/login", json={"email": "new@example.com", "password": "Password123"})).status_code == 401
    assert (await client.post("/api/auth/reset-password", json={"token": raw, "new_password": "Another789"})).status_code == 400
    # Proving inbox access via the reset link also verifies the email.
    assert db.query(User).filter_by(email="new@example.com").one().email_verified_at is not None


@pytest.mark.asyncio
async def test_expired_reset_token_rejected(client: AsyncClient, db: Session, captured_emails):
    await client.post("/api/auth/register", json=SIGNUP)
    await client.post("/api/auth/forgot-password", json={"email": "new@example.com"})
    user = db.query(User).filter_by(email="new@example.com").one()
    user.reset_token_expires_at = datetime.utcnow() - timedelta(seconds=1)
    db.commit()
    raw = _token(captured_emails[-1]["url"], "reset_token")
    assert (await client.post("/api/auth/reset-password", json={"token": raw, "new_password": "BrandNew456"})).status_code == 400


@pytest.mark.asyncio
async def test_sso_claims_unverified_squatted_account(client: AsyncClient, db: Session, captured_emails, monkeypatch):
    """Someone registered the address without owning it; the real owner signs in with Google."""
    squat = await client.post("/api/auth/register", json={**SIGNUP, "email": "owner@corp.com"})
    squat_token = squat.json()["token"]
    import routers.auth_routes as routes

    monkeypatch.setattr(routes, "verify_firebase_id_token", lambda _t: {"email": "owner@corp.com", "name": "Real Owner"})
    sso = await client.post("/api/auth/firebase", json={"id_token": "x" * 20})
    assert sso.status_code == 200
    user = db.query(User).filter_by(email="owner@corp.com").one()
    assert user.email_verified_at is not None and user.password_hash is None
    assert (await client.get("/api/me", headers={"Authorization": f"Bearer {squat_token}"})).status_code == 401
    assert (await client.post("/api/auth/login", json={"email": "owner@corp.com", "password": "Password123"})).status_code == 401


@pytest.mark.asyncio
async def test_marketing_preference_toggle(client: AsyncClient, db: Session, captured_emails):
    reg = await client.post("/api/auth/register", json=SIGNUP)
    headers = {"Authorization": f"Bearer {reg.json()['token']}"}
    on = await client.put("/api/me/marketing", headers=headers, json={"marketing_opt_in": True})
    assert on.json()["marketing_opt_in"] is True
    user = db.query(User).filter_by(email="new@example.com").one()
    assert user.marketing_opt_in_at is not None
    await client.put("/api/me/marketing", headers=headers, json={"marketing_opt_in": False})
    db.refresh(user)
    assert user.marketing_opt_in is False and user.marketing_opt_in_at is None


def test_tokens_store_only_hashes():
    user = User(name="x", email="x@x.com")
    raw = account_tokens.issue_reset_token(user)
    assert raw not in (user.reset_token_hash or "") and len(user.reset_token_hash) == 64
