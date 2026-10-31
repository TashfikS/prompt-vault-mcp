"""Every limit advertised on the pricing page is enforced server-side."""

from datetime import datetime

import pytest
from httpx import AsyncClient
from sqlalchemy.orm import Session

from auth import create_api_key_record, hash_password
from models import Group, GroupMembership, User
from plans import PLAN_LIMITS_MAP, PLAN_TIERS


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_catalogue_prices_and_no_unbuilt_features():
    pro, team = PLAN_LIMITS_MAP["pro"], PLAN_LIMITS_MAP["team"]
    assert (pro["price_monthly"], pro["price_annual"]) == (7, 5)
    assert (team["price_monthly"], team["price_annual"]) == (12, 10) and team["per_seat"]
    advertised = " ".join(f for t in PLAN_TIERS for f in t["features"]).lower()
    for unbuilt in ("drive", "saml", "self-host", "on-prem"):
        assert unbuilt not in advertised


@pytest.mark.asyncio
async def test_share_links_require_paid_plan(client: AsyncClient, test_users_and_groups, db: Session):
    f = test_users_and_groups
    body = {"prompt_id": f["team_prompt"].id, "base_version": 1, "target_version": 1}
    res = await client.post("/api/diff-shares", headers=_h(f["tokens"]["owner"]), json=body)
    assert res.status_code == 403 and "Pro plan" in res.json()["detail"]
    f["owner"].plan = "pro"
    db.commit()
    assert (await client.post("/api/diff-shares", headers=_h(f["tokens"]["owner"]), json=body)).status_code == 201


@pytest.mark.asyncio
async def test_batch_upload_requires_paid_plan(client: AsyncClient, test_users_and_groups, db: Session):
    f = test_users_and_groups
    personal = db.query(Group).filter_by(personal_owner_id=f["owner"].id).one()
    files = [("files", ("a.txt", b"first prompt", "text/plain")), ("files", ("b.txt", b"second prompt", "text/plain"))]
    res = await client.post("/api/prompts/upload-files", headers=_h(f["tokens"]["owner"]),
                            data={"group_id": personal.id}, files=files)
    assert res.status_code == 403
    single = await client.post("/api/prompts/upload-files", headers=_h(f["tokens"]["owner"]),
                               data={"group_id": personal.id}, files=files[:1])
    assert single.status_code == 201  # one file at a time stays free
    f["owner"].plan = "pro"
    db.commit()
    res = await client.post("/api/prompts/upload-files", headers=_h(f["tokens"]["owner"]),
                            data={"group_id": personal.id}, files=files)
    assert res.status_code == 201


@pytest.mark.asyncio
async def test_api_key_quota(client: AsyncClient, test_users_and_groups):
    token = test_users_and_groups["tokens"]["member"]
    limit = PLAN_LIMITS_MAP["community"]["max_api_keys"]
    for i in range(limit):
        assert (await client.post("/api/api-keys", headers=_h(token), json={"name": f"k{i}"})).status_code == 201
    over = await client.post("/api/api-keys", headers=_h(token), json={"name": "one too many"})
    assert over.status_code == 403 and "API keys" in over.json()["detail"]


def test_mcp_monthly_quota(db: Session, test_users_and_groups, monkeypatch):
    import mcp_server
    from services import limits

    class _Proxy:
        def __getattr__(self, name):
            return getattr(db, name)

        def close(self):
            pass

    monkeypatch.setattr(mcp_server, "SessionLocal", lambda: _Proxy())
    member = test_users_and_groups["member"]
    _, key = create_api_key_record(db, user=member, name="MCP", scope_type="GLOBAL", access_level="READ_WRITE")
    db.commit()

    mcp_server.list_my_accessible_prompts(api_key=key)
    db.refresh(member)
    assert member.mcp_usage_count == 1 and member.mcp_usage_month == datetime.utcnow().strftime("%Y-%m")

    member.mcp_usage_count = PLAN_LIMITS_MAP["community"]["mcp_monthly_calls"]
    db.commit()
    with pytest.raises(ValueError, match="MCP calls"):
        mcp_server.list_my_accessible_prompts(api_key=key)

    # A new month starts from zero.
    member.mcp_usage_month = "2000-01"
    db.commit()
    mcp_server.list_my_accessible_prompts(api_key=key)
    db.refresh(member)
    assert limits.mcp_usage(member) == 1


def _new_user(db: Session, email: str) -> User:
    u = User(name=email.split("@")[0], email=email, password_hash=hash_password("Password123"), email_verified_at=datetime.utcnow())
    db.add(u)
    db.flush()
    return u


@pytest.mark.asyncio
async def test_team_seats_and_guest_allowance(client: AsyncClient, test_users_and_groups, db: Session):
    """Fixture team: owner + 2 members are editors (3), 1 guest. Admin-free path: owner manages the group."""
    f = test_users_and_groups
    owner = f["owner"]
    owner.plan = "team"
    owner.billed_seats = 3
    db.commit()
    group = db.query(Group).filter_by(name="Engineering Team").one()
    headers = _h(f["tokens"]["owner"])

    newbie = _new_user(db, "newbie@test.com")
    db.commit()
    no_seat = await client.post(f"/api/groups/{group.id}/members", headers=headers, json={"email": newbie.email, "role": "MEMBER"})
    assert no_seat.status_code == 403 and "seat" in no_seat.json()["detail"]

    # 3 seats x 2 free guests = 6; one guest already present, so 5 more fit.
    for i in range(5):
        g = _new_user(db, f"guest{i}@test.com")
        db.commit()
        ok = await client.post(f"/api/groups/{group.id}/members", headers=headers, json={"email": g.email, "role": "GUEST"})
        assert ok.status_code == 201, ok.text
    extra = _new_user(db, "guest-extra@test.com")
    db.commit()
    full = await client.post(f"/api/groups/{group.id}/members", headers=headers, json={"email": extra.email, "role": "GUEST"})
    assert full.status_code == 403 and "guest" in full.json()["detail"]

    # Buying a seat makes room for the editor.
    owner.billed_seats = 4
    db.commit()
    assert (await client.post(f"/api/groups/{group.id}/members", headers=headers, json={"email": newbie.email, "role": "MEMBER"})).status_code == 201

    # Changing an existing editor's role never needs a new seat.
    member2 = f["member2"]
    assert (await client.post(f"/api/groups/{group.id}/members", headers=headers, json={"email": member2.email, "role": "MEMBER"})).status_code == 201


@pytest.mark.asyncio
async def test_pricing_usage_reports_limits(client: AsyncClient, test_users_and_groups, db: Session):
    f = test_users_and_groups
    f["owner"].plan = "team"
    db.commit()
    usage = (await client.get("/api/pricing", headers=_h(f["tokens"]["owner"]))).json()["usage"]
    for key in ("mcp_calls", "mcp_monthly_calls", "api_keys", "max_api_keys", "seats", "editors", "guests", "max_guests"):
        assert key in usage
    assert usage["editors"] == 3 and usage["guests"] == 1


@pytest.mark.asyncio
async def test_audit_log_export_admin_only(client: AsyncClient, test_users_and_groups):
    t = test_users_and_groups["tokens"]
    assert (await client.get("/api/audit-logs/export", headers=_h(t["owner"]))).status_code == 403
    res = await client.get("/api/audit-logs/export", headers=_h(t["admin"]))
    assert res.status_code == 200 and res.text.startswith("created_at,action")
