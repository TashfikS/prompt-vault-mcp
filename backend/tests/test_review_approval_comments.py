"""Unit and integration tests for proposal reviews, comments, and proposer self-approval policy."""

import pytest
from httpx import AsyncClient
from sqlalchemy.orm import Session

from models import Group, PromptProposal, ProposalApproval, ProposalComment
from mcp_server import (
    comment_on_proposal,
    create_prompt_from_chat,
    list_pending_proposals,
    review_proposal,
)


@pytest.mark.asyncio
async def test_group_self_approval_setting_toggle(client: AsyncClient, test_users_and_groups):
    """Verify group owner can toggle allow_self_approval on group settings."""
    tokens = test_users_and_groups["tokens"]
    owner_headers = {"Authorization": f"Bearer {tokens['owner']}"}
    group_id = test_users_and_groups["team_group"].id

    # 1. Update allow_self_approval to True
    res = await client.patch(
        f"/api/groups/{group_id}/settings",
        json={"allow_self_approval": True, "required_approvals": 2},
        headers=owner_headers,
    )
    assert res.status_code == 200
    data = res.json()
    assert data["allow_self_approval"] is True
    assert data["required_approvals"] == 2

    # 2. Check list_groups includes allow_self_approval
    res_groups = await client.get("/api/groups", headers=owner_headers)
    assert res_groups.status_code == 200
    found_grp = next(g for g in res_groups.json() if g["id"] == group_id)
    assert found_grp["allow_self_approval"] is True

    # 3. Toggle back to False
    res2 = await client.patch(
        f"/api/groups/{group_id}/settings",
        json={"allow_self_approval": False},
        headers=owner_headers,
    )
    assert res2.status_code == 200
    assert res2.json()["allow_self_approval"] is False


@pytest.mark.asyncio
async def test_proposer_self_approval_blocked_by_default(client: AsyncClient, test_users_and_groups):
    """Verify that by default (allow_self_approval=False), proposer cannot vote on their own proposal."""
    tokens = test_users_and_groups["tokens"]
    member_headers = {"Authorization": f"Bearer {tokens['member']}"}
    owner_headers = {"Authorization": f"Bearer {tokens['owner']}"}
    group_id = test_users_and_groups["team_group"].id
    prompt_id = test_users_and_groups["team_prompt"].id

    # Ensure allow_self_approval is False
    await client.patch(
        f"/api/groups/{group_id}/settings",
        json={"allow_self_approval": False, "required_approvals": 1},
        headers=owner_headers,
    )

    # Member submits a proposal
    prop_res = await client.post(
        f"/api/prompts/{prompt_id}/proposals",
        json={"title": "Self Approve Test", "content": "Updated content by member", "change_note": "Test note"},
        headers=member_headers,
    )
    assert prop_res.status_code == 201
    proposal_id = prop_res.json()["id"]

    # Member tries to approve own proposal -> blocked!
    approve_res = await client.post(
        f"/api/proposals/{proposal_id}/approve",
        headers=member_headers,
    )
    assert approve_res.status_code == 400
    assert "self-approval is disabled" in approve_res.json()["detail"].lower()


@pytest.mark.asyncio
async def test_proposer_self_approval_allowed_when_enabled(client: AsyncClient, test_users_and_groups):
    """Verify that when allow_self_approval=True, proposer CAN vote on their own proposal."""
    tokens = test_users_and_groups["tokens"]
    member_headers = {"Authorization": f"Bearer {tokens['member']}"}
    owner_headers = {"Authorization": f"Bearer {tokens['owner']}"}
    group_id = test_users_and_groups["team_group"].id
    prompt_id = test_users_and_groups["team_prompt"].id

    # Owner enables self-approval and sets threshold = 1
    await client.patch(
        f"/api/groups/{group_id}/settings",
        json={"allow_self_approval": True, "required_approvals": 1},
        headers=owner_headers,
    )

    # Member submits a proposal
    prop_res = await client.post(
        f"/api/prompts/{prompt_id}/proposals",
        json={"title": "Self Approval Enabled", "content": "Updated content with self approve", "change_note": "Self approve note"},
        headers=member_headers,
    )
    assert prop_res.status_code == 201
    proposal_id = prop_res.json()["id"]

    # Member approves own proposal -> succeeds and merges!
    approve_res = await client.post(
        f"/api/proposals/{proposal_id}/approve",
        json={"comment": "Self-approved by author"},
        headers=member_headers,
    )
    assert approve_res.status_code == 200
    data = approve_res.json()
    assert data["status"] == "APPROVED"
    assert data["merged"] is True


@pytest.mark.asyncio
async def test_proposal_comments_api(client: AsyncClient, test_users_and_groups):
    """Verify adding comments to proposals and inspecting them."""
    tokens = test_users_and_groups["tokens"]
    member_headers = {"Authorization": f"Bearer {tokens['member']}"}
    owner_headers = {"Authorization": f"Bearer {tokens['owner']}"}
    prompt_id = test_users_and_groups["team_prompt"].id

    # Member creates proposal
    prop_res = await client.post(
        f"/api/prompts/{prompt_id}/proposals",
        json={"title": "Comments Test", "content": "Content to discuss", "change_note": "Discussion note"},
        headers=member_headers,
    )
    assert prop_res.status_code == 201
    proposal_id = prop_res.json()["id"]

    # Owner posts a comment
    c1_res = await client.post(
        f"/api/proposals/{proposal_id}/comments",
        json={"comment": "Please simplify the variable naming."},
        headers=owner_headers,
    )
    assert c1_res.status_code == 201
    assert c1_res.json()["comment"] == "Please simplify the variable naming."

    # Member replies
    c2_res = await client.post(
        f"/api/proposals/{proposal_id}/comments",
        json={"comment": "Done, updated as requested."},
        headers=member_headers,
    )
    assert c2_res.status_code == 201
    assert c2_res.json()["comment"] == "Done, updated as requested."

    # Fetch comments
    list_res = await client.get(f"/api/proposals/{proposal_id}/comments", headers=owner_headers)
    assert list_res.status_code == 200
    comments = list_res.json()
    assert len(comments) == 2
    assert comments[0]["comment"] == "Please simplify the variable naming."
    assert comments[1]["comment"] == "Done, updated as requested."

    # Check that getAllProposals includes comments
    proposals_res = await client.get("/api/proposals", headers=owner_headers)
    assert proposals_res.status_code == 200
    target_prop = next(p for p in proposals_res.json() if p["id"] == proposal_id)
    assert len(target_prop["comments"]) == 2


@pytest.mark.asyncio
async def test_member_new_prompt_creation_goes_to_proposal(client: AsyncClient, test_users_and_groups):
    """Verify that when a Member creates a prompt in a team group, it creates a proposal awaiting approval."""
    tokens = test_users_and_groups["tokens"]
    member_headers = {"Authorization": f"Bearer {tokens['member']}"}
    owner_headers = {"Authorization": f"Bearer {tokens['owner']}"}
    group_id = test_users_and_groups["team_group"].id

    # Member creates a prompt in the team space
    create_res = await client.post(
        "/api/prompts",
        json={
            "group_id": group_id,
            "title": "Brand New Team Prompt",
            "content": "Hello {{world}}, this is a proposal.",
            "description": "Team prompt requiring review",
            "change_note": "Initial proposal",
        },
        headers=member_headers,
    )
    assert create_res.status_code == 201
    data = create_res.json()
    assert data["proposal_created"] is True
    proposal_id = data["proposal_id"]

    # Check that the prompt is not yet listed in active team prompts
    active_prompts_res = await client.get(f"/api/prompts?group_id={group_id}", headers=member_headers)
    assert active_prompts_res.status_code == 200
    assert not any(p["title"] == "Brand New Team Prompt" for p in active_prompts_res.json())

    # Owner approves the creation proposal
    approve_res = await client.post(
        f"/api/proposals/{proposal_id}/approve",
        json={"comment": "Approved new prompt!"},
        headers=owner_headers,
    )
    assert approve_res.status_code == 200
    assert approve_res.json()["status"] == "APPROVED"
    assert approve_res.json()["merged"] is True

    # Now prompt is published and active!
    active_prompts_after = await client.get(f"/api/prompts?group_id={group_id}", headers=member_headers)
    assert active_prompts_after.status_code == 200
    published = next(p for p in active_prompts_after.json() if p["title"] == "Brand New Team Prompt")
    assert published["current_version_number"] == 1


def test_mcp_proposal_review_and_comments(test_users_and_groups, db: Session, monkeypatch):
    """Test FastMCP tools: create_prompt_from_chat, list_pending_proposals, review_proposal, comment_on_proposal."""
    from auth import create_api_key_record
    import mcp_server

    class _NonClosingSessionProxy:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc_val, exc_tb):
            return False

        def __getattr__(self, name):
            return getattr(db, name)

        def close(self):
            pass

    monkeypatch.setattr(mcp_server, "SessionLocal", lambda: _NonClosingSessionProxy())

    member = test_users_and_groups["member"]
    owner = test_users_and_groups["owner"]
    group = test_users_and_groups["team_group"]

    _, member_key = create_api_key_record(db, user=member, name="Member Key", scope_type="GLOBAL", access_level="READ_WRITE")
    _, owner_key = create_api_key_record(db, user=owner, name="Owner Key", scope_type="GLOBAL", access_level="READ_WRITE")
    db.commit()

    # 1. Member creates a new prompt from chat -> creates proposal
    created_res = create_prompt_from_chat(
        title="MCP Proposed Prompt",
        content="AI generated template {{user_input}}",
        group_id=group.id,
        api_key=member_key,
    )
    assert created_res["proposal_created"] is True
    proposal_id = created_res["proposal_id"]

    # 2. Owner lists pending proposals
    pending = list_pending_proposals(api_key=owner_key)
    proposals_list = pending["proposals"]
    assert any(p["proposal_id"] == proposal_id for p in proposals_list)

    # 3. Owner posts a comment via MCP
    comment_res = comment_on_proposal(
        proposal_id=proposal_id,
        comment="Looks great, approving from Claude.",
        api_key=owner_key,
    )
    assert comment_res["author"] == owner.name
    assert "Looks great" in comment_res["comment"]

    # 4. Member tries self-approval via MCP when disabled -> error
    with pytest.raises(ValueError, match="self-approval is disabled"):
        review_proposal(
            proposal_id=proposal_id,
            action="APPROVE",
            api_key=member_key,
        )

    # 5. Owner approves via MCP -> auto-merges
    review_res = review_proposal(
        proposal_id=proposal_id,
        action="APPROVE",
        comment="Approved via Claude Desktop",
        api_key=owner_key,
    )
    assert review_res["status"] == "APPROVED"
    assert review_res["merged"] is True
    assert review_res["version_number"] == 1
