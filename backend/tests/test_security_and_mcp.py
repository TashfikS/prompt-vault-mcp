"""Security and API key authorization tests for PromptHold."""

import pytest
from httpx import AsyncClient
from sqlalchemy.orm import Session

from auth import create_api_key_record


@pytest.mark.asyncio
async def test_unauthenticated_requests_denied(client: AsyncClient):
    """Verify that protected endpoints reject anonymous requests with 401 Unauthorized."""
    endpoints = [
        "/api/me",
        "/api/prompts",
        "/api/groups",
        "/api/proposals",
    ]
    for endpoint in endpoints:
        res = await client.get(endpoint)
        assert res.status_code == 401
        assert "Please sign in to continue" in res.json()["detail"]


@pytest.mark.asyncio
async def test_invalid_bearer_token(client: AsyncClient):
    headers = {"Authorization": "Bearer invalid_fake_token_12345"}
    res = await client.get("/api/me", headers=headers)
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_api_key_authentication_and_scoping(client: AsyncClient, db: Session, test_users_and_groups):
    """Verify API key authentication, group scoping, and read-only enforcement."""
    fixtures = test_users_and_groups
    owner = fixtures["owner"]
    team_group = fixtures["team_group"]

    # 1. Create a Global Read-Write API key
    _, global_key_raw = create_api_key_record(
        db,
        user=owner,
        name="Global Key",
        scope_type="GLOBAL",
        access_level="READ_WRITE",
    )

    global_headers = {"Authorization": f"Bearer {global_key_raw}"}
    res_list = await client.get("/api/prompts", headers=global_headers)
    assert res_list.status_code == 200

    # 2. Create a READ_ONLY API key
    _, readonly_key_raw = create_api_key_record(
        db,
        user=owner,
        name="Read Only Key",
        scope_type="GLOBAL",
        access_level="READ_ONLY",
    )
    db.commit()

    readonly_headers = {"Authorization": f"Bearer {readonly_key_raw}"}
    # Can read
    res_ro_get = await client.get("/api/prompts", headers=readonly_headers)
    assert res_ro_get.status_code == 200

    # Cannot write (403)
    res_ro_write = await client.post(
        "/api/prompts",
        headers=readonly_headers,
        json={
            "group_id": team_group.id,
            "title": "Blocked Prompt",
            "content": "Test content",
        },
    )
    assert res_ro_write.status_code == 403
    assert "Read-Only access" in res_ro_write.json()["detail"]


@pytest.mark.asyncio
async def test_health_check_endpoint(client: AsyncClient):
    """Verify /api/health returns 200 OK and database connectivity status."""
    res = await client.get("/api/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert data["service"] == "prompt-vault-mcp"
    assert data["database"] == "connected"


@pytest.mark.asyncio
async def test_feedback_submission_and_admin_listing(client: AsyncClient, test_users_and_groups, monkeypatch):
    """Verify anonymous/authenticated feedback submissions, GitHub issue creation, and admin-only listing."""
    import main as main_module

    # Mock GitHub Issue creation to simulate a live GitHub API response
    def fake_create_github_issue(**kwargs):
        return {
            "created": True,
            "issue_number": 42,
            "issue_url": "https://github.com/example/prompt-vault-mcp/issues/42",
            "error": None,
        }

    import routers.sharing as sharing_routes
    monkeypatch.setattr(sharing_routes, "create_github_issue_for_feedback", fake_create_github_issue)

    res_submit = await client.post(
        "/api/feedback",
        json={
            "category": "bug",
            "subject": "Diff viewer button alignment on mobile",
            "message": "When viewing side-by-side diffs on narrow screens, the toolbar wraps.",
            "contact_name": "Tester",
            "contact_email": "tester@example.com",
            "page_url": "http://localhost:5173/?view=prompts",
        },
    )
    assert res_submit.status_code == 201
    sub_data = res_submit.json()
    assert sub_data["github_issue_created"] is True
    assert sub_data["github_issue_number"] == 42
    assert sub_data["github_issue_url"] == "https://github.com/example/prompt-vault-mcp/issues/42"

    # Standard user cannot list feedback submissions -> 403
    tokens = test_users_and_groups["tokens"]
    member_res = await client.get("/api/feedback", headers={"Authorization": f"Bearer {tokens['member']}"})
    assert member_res.status_code == 403

    # Workspace Admin can list feedback submissions -> 200
    admin_res = await client.get("/api/feedback", headers={"Authorization": f"Bearer {tokens['admin']}"})
    assert admin_res.status_code == 200
    items = admin_res.json()
    assert len(items) >= 1
    assert items[0]["github_issue_number"] == 42


@pytest.mark.asyncio
async def test_firebase_sso_login(client: AsyncClient, monkeypatch):
    """Verify POST /api/auth/firebase creates a user, personal space, and session token."""
    import main as main_module

    def fake_verify_firebase_token(id_token: str) -> dict:
        return {
            "email": "firebase_sso_user@example.com",
            "name": "Firebase SSO User",
            "email_verified": True,
            "uid": "firebase-uid-123",
        }

    import routers.auth_routes as auth_routes
    monkeypatch.setattr(auth_routes, "verify_firebase_id_token", fake_verify_firebase_token)

    res = await client.post(
        "/api/auth/firebase",
        json={"id_token": "mock_firebase_jwt_token_1234567890", "display_name": "Firebase SSO User"},
    )
    assert res.status_code == 200
    data = res.json()
    assert "token" in data
    assert data["user"]["email"] == "firebase_sso_user@example.com"


def test_mcp_server_tools(db: Session, test_users_and_groups, monkeypatch):
    """Verify FastMCP tools enforce RBAC boundaries, compile variables, and distinguish Owner vs Member writes."""
    import mcp_server

    # Point mcp_server.SessionLocal to the test session without closing it
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

    fixtures = test_users_and_groups
    owner = fixtures["owner"]
    member = fixtures["member"]
    team_prompt = fixtures["team_prompt"]

    _, owner_key = create_api_key_record(db, user=owner, name="Owner MCP Key", scope_type="GLOBAL", access_level="READ_WRITE")
    _, member_key = create_api_key_record(db, user=member, name="Member MCP Key", scope_type="GLOBAL", access_level="READ_WRITE")
    db.commit()

    # 1. List accessible prompts via MCP
    listed = mcp_server.list_my_accessible_prompts(api_key=owner_key)
    assert len(listed["prompts"]) >= 1
    prompt_ids = [p["id"] for p in listed["prompts"]]
    assert team_prompt.id in prompt_ids

    # 2. Compile prompt with variables via MCP
    compiled = mcp_server.get_and_fill_prompt(
        api_key=owner_key,
        prompt_id=team_prompt.id,
        variables={"language": "Python"},
    )
    assert "Python" in compiled["content"]
    assert compiled["prompt_id"] == team_prompt.id

    # 3. Group Owner saves directly from MCP chat -> creates new version immediately
    owner_save = mcp_server.save_prompt_version_from_chat(
        api_key=owner_key,
        prompt_id=team_prompt.id,
        new_content="Review {{language}} code for security and types.",
        change_note="Updated from MCP client",
    )
    assert owner_save.get("proposal_created") is not True
    assert owner_save["version_number"] >= 2
    assert owner_save["version_id"] is not None

    # 4. Group Member saves from MCP chat -> creates review proposal
    member_save = mcp_server.save_prompt_version_from_chat(
        api_key=member_key,
        prompt_id=team_prompt.id,
        new_content="Review {{language}} code for latency.",
        change_note="Member MCP edit",
    )
    assert member_save["proposal_created"] is True
    assert member_save["status"] == "PENDING"
    assert "proposal_id" in member_save


@pytest.mark.asyncio
async def test_upload_binary_content_rejected(client: AsyncClient, test_users_and_groups):
    """Verify that disguised binary/executable uploads are rejected with HTTP 400."""
    fixtures = test_users_and_groups
    owner_token = fixtures["tokens"]["owner"]
    team_group = fixtures["team_group"]
    headers = {"Authorization": f"Bearer {owner_token}"}

    # 1. Disguised ELF binary as .txt
    elf_payload = b"\x7fELF\x02\x01\x01\x00some_compiled_code"
    files = [("files", ("exploit.txt", elf_payload, "text/plain"))]
    data = {"group_id": team_group.id, "change_note": "malicious upload"}
    res = await client.post("/api/prompts/upload-files", data=data, files=files, headers=headers)
    assert res.status_code == 400
    assert "binary, executable, or compressed archive" in res.json()["detail"]

    # 2. Disguised Windows EXE as .md
    exe_payload = b"MZ\x90\x00\x03\x00\x00\x00dos_header"
    files = [("files", ("malware.md", exe_payload, "text/markdown"))]
    res = await client.post("/api/prompts/upload-files", data=data, files=files, headers=headers)
    assert res.status_code == 400
    assert "binary, executable, or compressed archive" in res.json()["detail"]

    # 3. Text file containing null bytes
    null_payload = b"Prompt header\x00hidden binary payload"
    files = [("files", ("null_byte.txt", null_payload, "text/plain"))]
    res = await client.post("/api/prompts/upload-files", data=data, files=files, headers=headers)
    assert res.status_code == 400
    assert "contains binary null bytes" in res.json()["detail"]

    # 4. Valid text upload succeeds
    valid_payload = b"A valid prompt with {{variable}} for test."
    files = [("files", ("valid_prompt.md", valid_payload, "text/markdown"))]
    res = await client.post("/api/prompts/upload-files", data=data, files=files, headers=headers)
    assert res.status_code == 201
    assert len(res.json()["created_prompt_ids"]) == 1



