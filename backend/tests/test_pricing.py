"""Integration tests for PromptHold pricing tiers and subscription plan updates."""

import pytest
from httpx import AsyncClient
from sqlalchemy.orm import Session

from models import Prompt, User


@pytest.mark.asyncio
async def test_get_pricing_public(client: AsyncClient):
    """Anonymous visitors can view the pricing tiers."""
    res = await client.get("/api/pricing")
    assert res.status_code == 200
    data = res.json()
    assert "tiers" in data
    tier_ids = [t["id"] for t in data["tiers"]]
    assert tier_ids == ["community", "pro", "team", "enterprise"]
    assert data["current_plan"] == "community"


@pytest.mark.asyncio
async def test_get_pricing_authenticated(client: AsyncClient, test_users_and_groups):
    """Authenticated users see their current plan and prompt usage stats."""
    tokens = test_users_and_groups["tokens"]
    headers = {"Authorization": f"Bearer {tokens['owner']}"}

    res = await client.get("/api/pricing", headers=headers)
    assert res.status_code == 200
    data = res.json()
    assert "tiers" in data
    assert "usage" in data
    assert data["usage"] is not None
    assert "prompts_count" in data["usage"]


@pytest.mark.asyncio
async def test_update_plan(client: AsyncClient, test_users_and_groups):
    """Users can switch their subscription plan."""
    tokens = test_users_and_groups["tokens"]
    headers = {"Authorization": f"Bearer {tokens['member']}"}

    # Switch to Pro
    res = await client.patch("/api/me/plan", headers=headers, json={"plan": "pro"})
    assert res.status_code == 200
    assert res.json()["plan"] == "pro"

    # Verify /api/me reflects the new plan
    me_res = await client.get("/api/me", headers=headers)
    assert me_res.status_code == 200
    assert me_res.json()["plan"] == "pro"

    # Invalid plan rejected
    bad_res = await client.patch("/api/me/plan", headers=headers, json={"plan": "ultra_vip"})
    assert bad_res.status_code == 422  # validation error


@pytest.mark.asyncio
async def test_prompt_quota_enforced(client: AsyncClient, db: Session, test_users_and_groups):
    """Verify that community plan quota is enforced."""
    fixtures = test_users_and_groups
    member = fixtures["member"]
    tokens = fixtures["tokens"]
    team_group = fixtures["team_group"]
    headers = {"Authorization": f"Bearer {tokens['member']}"}

    # Ensure member is on community plan
    member.plan = "community"
    db.commit()

    # Pre-populate prompts up to limit of 20
    existing = db.query(Prompt).filter(Prompt.created_by == member.id, Prompt.is_archived.is_(False)).count()
    for i in range(20 - existing):
        db.add(Prompt(group_id=team_group.id, title=f"Filler {i}", current_version_number=1, created_by=member.id))
    db.commit()

    # 21st prompt creation should fail with 403 quota reached
    res = await client.post(
        "/api/prompts",
        headers=headers,
        json={
            "group_id": team_group.id,
            "title": "Exceeding prompt",
            "content": "Will fail",
        },
    )
    assert res.status_code == 403
    assert "Prompt limit reached" in res.json()["detail"]

    # Upgrade to Pro and retry -> now succeeds!
    await client.patch("/api/me/plan", headers=headers, json={"plan": "pro"})
    res2 = await client.post(
        "/api/prompts",
        headers=headers,
        json={
            "group_id": team_group.id,
            "title": "Now allowed on Pro",
            "content": "Success",
        },
    )
    assert res2.status_code == 201
