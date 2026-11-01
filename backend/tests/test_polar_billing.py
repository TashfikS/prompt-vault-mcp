"""Integration tests for Polar.sh billing, checkout sessions, and webhook handling."""

import hashlib
import hmac
import json
import time
import pytest
from httpx import AsyncClient
from sqlalchemy.orm import Session

from models import User


@pytest.mark.asyncio
async def test_billing_config_public(client: AsyncClient):
    """Anonymous visitors and clients can inspect Polar billing provider configuration."""
    res = await client.get("/api/billing/config")
    assert res.status_code == 200
    data = res.json()
    assert data["provider"] == "polar"
    assert "configured" in data
    assert "environment" in data


@pytest.mark.asyncio
async def test_checkout_requires_authentication(client: AsyncClient):
    """Anonymous callers cannot initiate checkout sessions."""
    res = await client.post("/api/billing/checkout", json={"plan": "pro"})
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_checkout_invalid_plan(client: AsyncClient, test_users_and_groups):
    """Callers cannot initiate checkouts for non-existent plans."""
    tokens = test_users_and_groups["tokens"]
    headers = {"Authorization": f"Bearer {tokens['member']}"}
    res = await client.post("/api/billing/checkout", headers=headers, json={"plan": "ultra_vip"})
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_checkout_session_mock_mode(client: AsyncClient, test_users_and_groups):
    """When Polar credentials are not configured, checkout returns a clear development response."""
    tokens = test_users_and_groups["tokens"]
    headers = {"Authorization": f"Bearer {tokens['member']}"}

    res = await client.post("/api/billing/checkout", headers=headers, json={"plan": "pro"})
    assert res.status_code == 200
    data = res.json()
    assert data["plan"] == "pro"
    assert data["mode"] == "mock"
    assert "dev_mock_checkout" in data["session_id"]
    assert "Polar credentials" in data["message"]


@pytest.mark.asyncio
async def test_customer_portal_mock_mode(client: AsyncClient, test_users_and_groups):
    """Customer portal endpoint responds gracefully when no active subscription is linked."""
    tokens = test_users_and_groups["tokens"]
    headers = {"Authorization": f"Bearer {tokens['member']}"}

    res = await client.post("/api/billing/portal", headers=headers)
    assert res.status_code == 200
    data = res.json()
    assert data["mode"] == "mock"
    assert data["portal_url"] is None


@pytest.mark.asyncio
async def test_webhook_order_paid_upgrades_user(client: AsyncClient, db: Session, test_users_and_groups):
    """When Polar sends an order.paid webhook, the target user is upgraded to the paid plan."""
    member_user = test_users_and_groups["member"]
    # Ensure starting on community tier
    member_user.plan = "community"
    db.commit()

    webhook_payload = {
        "type": "order.paid",
        "data": {
            "id": "ord_polar_test_123",
            "customer_id": "cust_polar_test_999",
            "customer": {
                "id": "cust_polar_test_999",
                "email": member_user.email,
            },
            "product_id": "prod_pro_123",
            "metadata": {
                "user_id": member_user.id,
                "plan": "pro",
            },
        },
    }

    res = await client.post("/api/webhooks/polar", json=webhook_payload)
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "upgraded"
    assert data["plan"] == "pro"

    # Verify user in database now reflects 'pro'
    db.refresh(member_user)
    assert member_user.plan == "pro"
    assert member_user.polar_customer_id == "cust_polar_test_999"


@pytest.mark.asyncio
async def test_webhook_subscription_canceled_downgrades_user(client: AsyncClient, db: Session, test_users_and_groups):
    """When a subscription is canceled/revoked on Polar, the user reverts to community tier."""
    member_user = test_users_and_groups["member"]
    member_user.plan = "pro"
    db.commit()

    webhook_payload = {
        "type": "subscription.canceled",
        "data": {
            "id": "sub_polar_test_456",
            "customer": {
                "email": member_user.email,
            },
            "metadata": {
                "user_id": member_user.id,
            },
        },
    }

    res = await client.post("/api/webhooks/polar", json=webhook_payload)
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "downgraded"
    assert data["plan"] == "community"

    db.refresh(member_user)
    assert member_user.plan == "community"


@pytest.mark.asyncio
async def test_webhook_signature_verification_failure(client: AsyncClient, monkeypatch):
    """If POLAR_WEBHOOK_SECRET is set, payloads with invalid/missing signatures are rejected."""
    monkeypatch.setenv("POLAR_WEBHOOK_SECRET", "polar_sec_test_secret_key_12345")

    res = await client.post(
        "/api/webhooks/polar",
        content=b'{"type": "order.paid"}',
        headers={"Content-Type": "application/json"},
    )
    # Missing required svix signature headers
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_webhook_rejects_unsigned_events_in_production(client: AsyncClient, monkeypatch, test_users_and_groups):
    """Without POLAR_WEBHOOK_SECRET, production must not let anyone forge plan upgrades."""
    import polar_billing
    monkeypatch.delenv("POLAR_WEBHOOK_SECRET", raising=False)
    monkeypatch.setattr(polar_billing, "IS_PRODUCTION", True)
    member_user = test_users_and_groups["member"]
    res = await client.post("/api/webhooks/polar", json={
        "type": "order.paid", "data": {"metadata": {"user_id": member_user.id, "plan": "team"}}})
    assert res.status_code == 503


@pytest.mark.asyncio
async def test_webhook_maps_annual_team_product_and_seats(client: AsyncClient, db: Session, test_users_and_groups, monkeypatch):
    """The paid product decides plan + interval, and seat changes on an active plan are stored."""
    monkeypatch.setenv("POLAR_TEAM_ANNUAL_PRODUCT_ID", "prod_team_year")
    member = test_users_and_groups["member"]
    event = {"type": "subscription.active", "data": {
        "id": "sub_1", "customer_id": "cust_1", "product_id": "prod_team_year", "recurring_interval": "year",
        "seats": 4, "metadata": {"user_id": member.id, "plan": "pro"},  # stale metadata must not win
    }}
    res = await client.post("/api/webhooks/polar", json=event)
    assert res.json()["plan"] == "team"
    db.refresh(member)
    assert (member.plan, member.billing_interval, member.billed_seats) == ("team", "year", 4)

    event["type"] = "subscription.updated"
    event["data"]["seats"] = 6
    res = await client.post("/api/webhooks/polar", json=event)
    assert res.json()["status"] == "already_active"
    db.refresh(member)
    assert member.billed_seats == 6


def test_checkout_passes_interval_product_and_seats(monkeypatch, test_users_and_groups):
    import polar_billing

    calls = {}

    class _Checkouts:
        def create(self, **kw):
            calls.update(kw)
            return type("C", (), {"url": "https://polar.test/c", "id": "chk_1"})()

    monkeypatch.setattr(polar_billing, "get_polar_client", lambda: type("P", (), {"checkouts": _Checkouts()})())
    monkeypatch.setenv("POLAR_TEAM_ANNUAL_PRODUCT_ID", "prod_team_year")
    monkeypatch.delenv("POLAR_PRO_ANNUAL_PRODUCT_ID", raising=False)
    user = test_users_and_groups["owner"]
    out = polar_billing.create_checkout_session(user, "team", interval="year", seats=3)
    assert out["mode"] == "live" and calls["products"] == ["prod_team_year"] and calls["seats"] == 3

    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        polar_billing.create_checkout_session(user, "pro", interval="year")
    assert exc.value.status_code == 503


# --- Per-environment settings (POLAR_SANDBOX_* / POLAR_PRODUCTION_*) ---------------------------

_POLAR_KEYS = ["ENVIRONMENT", "ACCESS_TOKEN", "WEBHOOK_SECRET", "PRO_PRODUCT_ID", "PRO_ANNUAL_PRODUCT_ID",
               "TEAM_PRODUCT_ID", "TEAM_ANNUAL_PRODUCT_ID", "CHECKOUT_SUCCESS_URL"]


@pytest.fixture
def clean_polar_env(monkeypatch):
    for key in _POLAR_KEYS:
        for prefix in ("POLAR_", "POLAR_SANDBOX_", "POLAR_PRODUCTION_"):
            monkeypatch.delenv(prefix + key, raising=False)
    return monkeypatch


def test_environment_selects_matching_prefixed_settings(clean_polar_env):
    import polar_billing as pb
    m = clean_polar_env
    m.setenv("POLAR_SANDBOX_ACCESS_TOKEN", "sandbox-token")
    m.setenv("POLAR_PRODUCTION_ACCESS_TOKEN", "live-token")
    m.setenv("POLAR_SANDBOX_PRO_PRODUCT_ID", "sb-pro")
    m.setenv("POLAR_PRODUCTION_PRO_PRODUCT_ID", "live-pro")
    m.setenv("POLAR_SANDBOX_WEBHOOK_SECRET", "sb-secret")
    m.setenv("POLAR_PRODUCTION_WEBHOOK_SECRET", "live-secret")

    m.setenv("POLAR_ENVIRONMENT", "sandbox")
    assert pb.polar_environment() == "sandbox"
    assert pb.polar_setting("ACCESS_TOKEN") == "sandbox-token"
    assert pb.get_product_id_for_plan("pro", "month") == "sb-pro"
    assert pb.plan_for_product_id("sb-pro") == ("pro", "month")
    assert pb.plan_for_product_id("live-pro") is None  # a live product must not grant a plan in sandbox
    assert pb.polar_setting("WEBHOOK_SECRET") == "sb-secret"

    m.setenv("POLAR_ENVIRONMENT", "production")
    assert pb.polar_environment() == "production"
    assert pb.polar_setting("ACCESS_TOKEN") == "live-token"
    assert pb.get_product_id_for_plan("pro", "month") == "live-pro"
    assert pb.plan_for_product_id("live-pro") == ("pro", "month")
    assert pb.plan_for_product_id("sb-pro") is None
    assert pb.polar_setting("WEBHOOK_SECRET") == "live-secret"


def test_unprefixed_names_still_work_as_fallback(clean_polar_env):
    import polar_billing as pb
    m = clean_polar_env
    m.setenv("POLAR_ENVIRONMENT", "production")
    m.setenv("POLAR_ACCESS_TOKEN", "plain-token")
    m.setenv("POLAR_TEAM_ANNUAL_PRODUCT_ID", "plain-team-year")
    assert pb.is_polar_configured()
    assert pb.polar_setting("ACCESS_TOKEN") == "plain-token"
    assert pb.get_product_id_for_plan("team", "year") == "plain-team-year"
    # A prefixed value wins over the plain one.
    m.setenv("POLAR_PRODUCTION_ACCESS_TOKEN", "prefixed-token")
    assert pb.polar_setting("ACCESS_TOKEN") == "prefixed-token"


@pytest.mark.parametrize("value", ["", "sandbox", "SANDBOX", "live", "prod", "staging"])
def test_only_explicit_production_uses_live_polar(clean_polar_env, value):
    import polar_billing as pb
    clean_polar_env.setenv("POLAR_ENVIRONMENT", value)
    assert pb.polar_environment() == "sandbox"


def test_client_uses_active_environment(clean_polar_env):
    import polar_billing as pb
    m = clean_polar_env
    m.setenv("POLAR_ENVIRONMENT", "production")
    m.setenv("POLAR_PRODUCTION_ACCESS_TOKEN", "live-token")
    client = pb.get_polar_client()
    assert (client.access_token, client.environment, client.base_url) == ("live-token", "production", "https://api.polar.sh")
    m.setenv("POLAR_ENVIRONMENT", "sandbox")
    m.setenv("POLAR_SANDBOX_ACCESS_TOKEN", "sandbox-token")
    assert pb.get_polar_client().base_url == "https://sandbox-api.polar.sh"


def test_rest_client_posts_checkout_and_reads_url(clean_polar_env, monkeypatch):
    """Checkout goes straight to Polar's REST API (the SDK cannot parse its own Checkout response)."""
    import httpx
    import polar_billing as pb
    clean_polar_env.setenv("POLAR_SANDBOX_ACCESS_TOKEN", "tok")
    sent = {}

    def fake_post(url, json, timeout, headers):
        sent.update(url=url, json=json, auth=headers["Authorization"])
        return httpx.Response(201, json={"id": "chk_9", "url": "https://sandbox.polar.sh/checkout/x", "status": "open"})

    monkeypatch.setattr(httpx, "post", fake_post)
    checkout = pb.get_polar_client().checkouts.create(products=["p1"], seats=2, metadata={"user_id": "u"})
    assert (checkout.id, checkout.url) == ("chk_9", "https://sandbox.polar.sh/checkout/x")
    assert sent == {"url": "https://sandbox-api.polar.sh/v1/checkouts/", "json": {"products": ["p1"], "seats": 2, "metadata": {"user_id": "u"}}, "auth": "Bearer tok"}

    monkeypatch.setattr(httpx, "post", lambda *a, **k: httpx.Response(422, json={"detail": "bad product"}))
    with pytest.raises(RuntimeError, match="422"):
        pb.get_polar_client().checkouts.create(products=["nope"])
