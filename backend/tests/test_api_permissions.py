"""Integration tests for PromptHold REST API and RBAC permissions matrix."""

import pytest
from httpx import AsyncClient
from sqlalchemy.orm import Session

from permissions import ensure_personal_group
from models import Group, Prompt, PromptVersion


@pytest.mark.asyncio
async def test_get_me_profile(client: AsyncClient, test_users_and_groups):
    tokens = test_users_and_groups["tokens"]
    headers = {"Authorization": f"Bearer {tokens['owner']}"}

    res = await client.get("/api/me", headers=headers)
    assert res.status_code == 200
    data = res.json()
    assert data["email"] == "owner@test.com"
    assert data["is_workspace_admin"] is False
    assert len(data["groups"]) >= 1


@pytest.mark.asyncio
async def test_personal_space_privacy_and_isolation(client: AsyncClient, db: Session, test_users_and_groups):
    """Verify that personal spaces are strictly private and isolated, even from Admins."""
    fixtures = test_users_and_groups
    tokens = fixtures["tokens"]
    owner = fixtures["owner"]
    member = fixtures["member"]

    owner_personal = ensure_personal_group(db, owner)

    # Owner creates a private prompt in their personal space
    owner_headers = {"Authorization": f"Bearer {tokens['owner']}"}
    create_res = await client.post(
        "/api/prompts",
        headers=owner_headers,
        json={
            "group_id": owner_personal.id,
            "title": "My Secret Personal Prompt",
            "content": "Secret instructions for {{task}}",
            "description": "Private notes",
        },
    )
    assert create_res.status_code == 201
    personal_prompt_id = create_res.json()["id"]

    # Member attempts to list prompts in Owner's personal space -> returns empty list (no prompts leaked)
    member_headers = {"Authorization": f"Bearer {tokens['member']}"}
    list_res = await client.get(f"/api/prompts?group_id={owner_personal.id}", headers=member_headers)
    assert list_res.status_code == 200
    assert list_res.json() == []

    # Member attempts to read the personal prompt's versions directly (IDOR check) -> 404 access denied
    get_res = await client.get(f"/api/prompts/{personal_prompt_id}/versions", headers=member_headers)
    assert get_res.status_code == 404

    # Member attempts to edit personal prompt directly -> 404 access denied
    put_res = await client.put(f"/api/prompts/{personal_prompt_id}", headers=member_headers, json={"content": "hacked"})
    assert put_res.status_code == 404

    # Workspace Admin attempts to access the personal prompt -> 404 access denied
    admin_headers = {"Authorization": f"Bearer {tokens['admin']}"}
    admin_get_res = await client.get(f"/api/prompts/{personal_prompt_id}/versions", headers=admin_headers)
    assert admin_get_res.status_code == 404


@pytest.mark.asyncio
async def test_prompt_creation_permissions(client: AsyncClient, test_users_and_groups):
    """Verify who can and cannot create prompts in a team group."""
    fixtures = test_users_and_groups
    tokens = fixtures["tokens"]
    team_group = fixtures["team_group"]

    payload = {
        "group_id": team_group.id,
        "title": "New Team Prompt",
        "content": "Analyze {{code}} for issues.",
        "description": "Team template",
    }

    # Owner can create
    res_owner = await client.post("/api/prompts", headers={"Authorization": f"Bearer {tokens['owner']}"}, json=payload)
    assert res_owner.status_code == 201

    # Member can create
    payload["title"] = "Member Created Prompt"
    res_member = await client.post("/api/prompts", headers={"Authorization": f"Bearer {tokens['member']}"}, json=payload)
    assert res_member.status_code == 201

    # Guest CANNOT create prompts (403)
    payload["title"] = "Guest Created Prompt"
    res_guest = await client.post("/api/prompts", headers={"Authorization": f"Bearer {tokens['guest']}"}, json=payload)
    assert res_guest.status_code == 403
    assert "Guests have view-only access" in res_guest.json()["detail"]

    # Outsider CANNOT create prompts (403)
    payload["title"] = "Outsider Created Prompt"
    res_outsider = await client.post("/api/prompts", headers={"Authorization": f"Bearer {tokens['outsider']}"}, json=payload)
    assert res_outsider.status_code == 403


@pytest.mark.asyncio
async def test_proposal_lifecycle_and_self_approval_prevention(client: AsyncClient, test_users_and_groups):
    """Verify proposal submission, self-approval blocking, and peer auto-merging."""
    fixtures = test_users_and_groups
    tokens = fixtures["tokens"]
    team_group = fixtures["team_group"]
    team_prompt = fixtures["team_prompt"]

    # 1. Guest attempts to edit prompt -> 403
    guest_headers = {"Authorization": f"Bearer {tokens['guest']}"}
    res_guest_edit = await client.put(
        f"/api/prompts/{team_prompt.id}",
        headers=guest_headers,
        json={"content": "Guest edit attempt"},
    )
    assert res_guest_edit.status_code == 403

    # 2. Member submits an edit -> creates a PENDING proposal
    member_headers = {"Authorization": f"Bearer {tokens['member']}"}
    res_member_edit = await client.put(
        f"/api/prompts/{team_prompt.id}",
        headers=member_headers,
        json={
            "content": "Updated code review for {{language}} and performance.",
            "change_note": "Added performance check",
        },
    )
    assert res_member_edit.status_code == 200
    edit_data = res_member_edit.json()
    assert edit_data["proposal_created"] is True
    proposal_id = edit_data["proposal_id"]

    # 3. Proposer attempts to approve their own proposal -> 400 Bad Request
    res_self_approve = await client.post(
        f"/api/proposals/{proposal_id}/approve",
        headers=member_headers,
    )
    assert res_self_approve.status_code == 400
    assert "You cannot approve your own proposal" in res_self_approve.json()["detail"]

    # 4. Guest attempts to approve proposal -> 403
    res_guest_approve = await client.post(
        f"/api/proposals/{proposal_id}/approve",
        headers=guest_headers,
    )
    assert res_guest_approve.status_code == 403
    assert "Guests cannot approve proposals" in res_guest_approve.json()["detail"]

    # 5. Peer Member (member2) approves -> meets threshold (1) and auto-merges
    member2_headers = {"Authorization": f"Bearer {tokens['member2']}"}
    res_peer_approve = await client.post(
        f"/api/proposals/{proposal_id}/approve",
        headers=member2_headers,
    )
    assert res_peer_approve.status_code == 200
    approve_data = res_peer_approve.json()
    assert approve_data["status"] == "APPROVED"
    assert approve_data["merged"] is True
    assert approve_data["version_number"] == 2

    # 6. Verify prompt is now at version 2 with updated content
    list_res = await client.get(f"/api/prompts?group_id={team_group.id}", headers=member_headers)
    assert list_res.status_code == 200
    prompts = list_res.json()
    matched = [p for p in prompts if p["id"] == team_prompt.id]
    assert len(matched) == 1
    assert matched[0]["current_version_number"] == 2


@pytest.mark.asyncio
async def test_active_version_rollback_permissions(client: AsyncClient, test_users_and_groups):
    """Verify that only the Group Owner can switch active versions (rollback)."""
    fixtures = test_users_and_groups
    tokens = fixtures["tokens"]
    team_prompt = fixtures["team_prompt"]

    # Member attempts rollback -> 403
    member_headers = {"Authorization": f"Bearer {tokens['member']}"}
    res_member_rb = await client.post(
        f"/api/prompts/{team_prompt.id}/rollback/1",
        headers=member_headers,
    )
    assert res_member_rb.status_code == 403
    assert "Only the Group Owner can switch the active version" in res_member_rb.json()["detail"]

    # Guest attempts rollback -> 403
    guest_headers = {"Authorization": f"Bearer {tokens['guest']}"}
    res_guest_rb = await client.post(
        f"/api/prompts/{team_prompt.id}/rollback/1",
        headers=guest_headers,
    )
    assert res_guest_rb.status_code == 403

    # Owner performs rollback -> 200
    owner_headers = {"Authorization": f"Bearer {tokens['owner']}"}
    res_owner_rb = await client.post(
        f"/api/prompts/{team_prompt.id}/rollback/1",
        headers=owner_headers,
    )
    assert res_owner_rb.status_code == 200
    assert res_owner_rb.json()["version_number"] == 1


@pytest.mark.asyncio
async def test_group_member_management_permissions(client: AsyncClient, test_users_and_groups):
    """Verify that only Group Owners / Workspace Admins can invite or manage members."""
    fixtures = test_users_and_groups
    tokens = fixtures["tokens"]
    team_group = fixtures["team_group"]
    outsider = fixtures["outsider"]

    invite_payload = {
        "user_id": outsider.id,
        "role": "MEMBER",
    }

    # Member attempts to invite -> 403
    member_headers = {"Authorization": f"Bearer {tokens['member']}"}
    res_member_inv = await client.post(
        f"/api/groups/{team_group.id}/members",
        headers=member_headers,
        json=invite_payload,
    )
    assert res_member_inv.status_code == 403

    # Group Owner invites outsider -> 201
    owner_headers = {"Authorization": f"Bearer {tokens['owner']}"}
    res_owner_inv = await client.post(
        f"/api/groups/{team_group.id}/members",
        headers=owner_headers,
        json=invite_payload,
    )
    assert res_owner_inv.status_code in {200, 201}


@pytest.mark.asyncio
async def test_owner_direct_write_and_uuid_version_tracking(client: AsyncClient, test_users_and_groups):
    """Verify Group Owner saves new versions directly (without proposals) and updates current_version_id UUID."""
    fixtures = test_users_and_groups
    tokens = fixtures["tokens"]
    team_prompt = fixtures["team_prompt"]
    owner_headers = {"Authorization": f"Bearer {tokens['owner']}"}

    # Owner edits team prompt directly -> creates vN+1 immediately
    res_edit = await client.put(
        f"/api/prompts/{team_prompt.id}",
        headers=owner_headers,
        json={
            "content": "Direct owner update for {{language}} with security rules.",
            "change_note": "Owner direct publish",
        },
    )
    assert res_edit.status_code == 200
    data = res_edit.json()
    assert data.get("proposal_created") is not True
    assert data["version_number"] >= 2
    assert data["id"] is not None
    latest_ver_uuid = data["id"]

    # Verify versions endpoint returns matching UUID ranked first (active version on top) and ETag support
    ver_res = await client.get(f"/api/prompts/{team_prompt.id}/versions", headers=owner_headers)
    assert ver_res.status_code == 200
    etag = ver_res.headers.get("etag")
    assert etag is not None
    versions = ver_res.json()
    assert len(versions) >= 2
    assert versions[0]["id"] == latest_ver_uuid


    # Verify ETag 304 Not Modified on /versions
    ver_304 = await client.get(
        f"/api/prompts/{team_prompt.id}/versions",
        headers={**owner_headers, "If-None-Match": etag},
    )
    assert ver_304.status_code == 304

    # Verify ETag 304 Not Modified on /api/prompts
    list_res = await client.get("/api/prompts", headers=owner_headers)
    assert list_res.status_code == 200
    list_etag = list_res.headers.get("etag")
    assert list_etag is not None
    list_304 = await client.get(
        "/api/prompts",
        headers={**owner_headers, "If-None-Match": list_etag},
    )
    assert list_304.status_code == 304


@pytest.mark.asyncio
async def test_group_settings_patch_and_duplicate_prompt(client: AsyncClient, db: Session, test_users_and_groups):
    """Verify PATCH /api/groups/{id}/settings and POST /api/prompts/{id}/duplicate."""
    fixtures = test_users_and_groups
    tokens = fixtures["tokens"]
    owner = fixtures["owner"]
    team_group = fixtures["team_group"]
    team_prompt = fixtures["team_prompt"]
    owner_headers = {"Authorization": f"Bearer {tokens['owner']}"}

    # Update group required_approvals via PATCH (per AGENTS.md §4.3)
    patch_res = await client.patch(
        f"/api/groups/{team_group.id}/settings",
        headers=owner_headers,
        json={"required_approvals": 2},
    )
    assert patch_res.status_code == 200
    assert patch_res.json()["required_approvals"] == 2

    # Duplicate prompt to owner's Personal space
    owner_personal = ensure_personal_group(db, owner)
    dup_res = await client.post(
        f"/api/prompts/{team_prompt.id}/duplicate",
        headers=owner_headers,
        json={
            "target_group_id": owner_personal.id,
            "new_title": "Personal Copy of Code Review",
            "mode": "copy",
        },
    )
    assert dup_res.status_code in {200, 201}
    dup_data = dup_res.json()
    assert dup_data["title"] == "Personal Copy of Code Review"
    assert dup_data["group_id"] == owner_personal.id


@pytest.mark.asyncio
async def test_shared_diff_links(client: AsyncClient, test_users_and_groups):
    """Verify zero-config shareable diff links creation and public retrieval."""
    fixtures = test_users_and_groups
    tokens = fixtures["tokens"]
    team_prompt = fixtures["team_prompt"]
    owner_headers = {"Authorization": f"Bearer {tokens['owner']}"}

    # Ensure at least 2 versions exist
    await client.put(
        f"/api/prompts/{team_prompt.id}",
        headers=owner_headers,
        json={"content": "Second version for diff link {{language}}", "change_note": "v2 for diff"},
    )

    create_share = await client.post(
        "/api/diff-shares",
        headers=owner_headers,
        json={
            "prompt_id": team_prompt.id,
            "base_version": 1,
            "target_version": 2,
            "diff_granularity": "word",
            "view_mode": "split",
        },
    )
    assert create_share.status_code in {200, 201}
    share_id = create_share.json()["share_id"]

    # Retrieve without authentication (open endpoint)
    get_share = await client.get(f"/api/diff-shares/{share_id}")
    assert get_share.status_code == 200
    share_data = get_share.json()
    assert share_data["prompt"]["id"] == team_prompt.id
    assert share_data["base_version"]["version_number"] == 1
    assert share_data["target_version"]["version_number"] == 2


@pytest.mark.asyncio
async def test_profile_update_and_change_password(client: AsyncClient, test_users_and_groups):
    """Verify authenticated user can update display name and rotate password securely."""
    fixtures = test_users_and_groups
    tokens = fixtures["tokens"]
    member_headers = {"Authorization": f"Bearer {tokens['member']}"}

    # 1. Update Profile Display Name
    update_res = await client.put(
        "/api/me/profile",
        headers=member_headers,
        json={"name": "Updated Member Name"},
    )
    assert update_res.status_code == 200
    assert update_res.json()["name"] == "Updated Member Name"

    # Verify reflected in /api/me
    me_res = await client.get("/api/me", headers=member_headers)
    assert me_res.status_code == 200
    assert me_res.json()["name"] == "Updated Member Name"

    # 2. Change Password Failure - Wrong current password
    fail_res = await client.post(
        "/api/me/change-password",
        headers=member_headers,
        json={"current_password": "WrongPassword123", "new_password": "NewSecretPassword99!"},
    )
    assert fail_res.status_code == 400
    assert "Current password is incorrect" in fail_res.json()["detail"]

    # 3. Change Password Failure - Same password
    same_res = await client.post(
        "/api/me/change-password",
        headers=member_headers,
        json={"current_password": "Password123", "new_password": "Password123"},
    )
    assert same_res.status_code == 400
    assert "must be different" in same_res.json()["detail"]

    # 4. Change Password Success
    success_res = await client.post(
        "/api/me/change-password",
        headers=member_headers,
        json={"current_password": "Password123", "new_password": "NewSecretPassword99!"},
    )
    assert success_res.status_code == 200
    assert "Password changed successfully" in success_res.json()["message"]

    # 5. Verify sign in with new password works
    login_new = await client.post(
        "/api/auth/login",
        json={"email": "member@test.com", "password": "NewSecretPassword99!"},
    )
    assert login_new.status_code == 200
    assert "token" in login_new.json()


@pytest.mark.asyncio
async def test_persistent_account_lockout(client: AsyncClient, test_users_and_groups, db: Session):
    """Verify 5 failed login attempts lock account persistently in DB."""
    # Register a dedicated user for lockout testing
    reg = await client.post(
        "/api/auth/register",
        json={
            "name": "Lockout Candidate",
            "email": "lockout_user@example.com",
            "password": "InitialPassword123!",
            "plan": "community",
        },
    )
    assert reg.status_code == 201

    # Attempt 5 incorrect logins
    for i in range(5):
        fail = await client.post(
            "/api/auth/login",
            json={"email": "lockout_user@example.com", "password": "WrongPassword123!"},
        )
        assert fail.status_code == 401

    # 6th attempt should return 429 Locked
    blocked = await client.post(
        "/api/auth/login",
        json={"email": "lockout_user@example.com", "password": "WrongPassword123!"},
    )
    assert blocked.status_code == 429
    assert "temporarily locked" in blocked.json()["detail"]


