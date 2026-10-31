"""Tests for Native OAuth 2.0 / 2.1 Authorization Server implementation.

Covers:
- RFC 8414 Authorization Server Metadata
- RFC 9728 Protected Resource Metadata for MCP
- RFC 7591 Dynamic Client Registration (DCR)
- RFC 7636 PKCE (Proof Key for Code Exchange) with S256
- Browser Authorization Consent Flow (GET & POST /oauth/authorize)
- Token Exchange Endpoint (POST /oauth/token)
- End-to-end authentication with issued Bearer access token
"""

import base64
import hashlib
import secrets
from urllib.parse import parse_qs, urlparse

import pytest
from httpx import AsyncClient


def _generate_pkce_pair() -> tuple[str, str]:
    """Generate RFC 7636 code_verifier and code_challenge pair."""
    code_verifier = secrets.token_urlsafe(32)
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return code_verifier, code_challenge


@pytest.mark.asyncio
async def test_oauth_server_metadata_discovery(client: AsyncClient):
    """Verify RFC 8414 OAuth 2.0 Authorization Server Metadata document."""
    resp = await client.get("/.well-known/oauth-authorization-server")
    assert resp.status_code == 200
    data = resp.json()

    assert data["issuer"] == "http://testserver"
    assert data["authorization_endpoint"] == "http://testserver/oauth/authorize"
    assert data["token_endpoint"] == "http://testserver/oauth/token"
    assert data["registration_endpoint"] == "http://testserver/oauth/register"
    assert "code" in data["response_types_supported"]
    assert "authorization_code" in data["grant_types_supported"]
    assert "S256" in data["code_challenge_methods_supported"]
    assert "prompts" in data["scopes_supported"]


@pytest.mark.asyncio
async def test_openid_configuration_metadata(client: AsyncClient):
    """Verify OpenID Connect discovery metadata alias."""
    resp = await client.get("/.well-known/openid-configuration")
    assert resp.status_code == 200
    data = resp.json()
    assert data["authorization_endpoint"] == "http://testserver/oauth/authorize"
    assert data["token_endpoint"] == "http://testserver/oauth/token"


@pytest.mark.asyncio
async def test_oauth_protected_resource_metadata(client: AsyncClient):
    """Verify RFC 9728 Protected Resource Metadata for MCP."""
    resp = await client.get("/.well-known/oauth-protected-resource")
    assert resp.status_code == 200
    data = resp.json()

    assert data["resource"] == "http://testserver/mcp"
    assert "http://testserver" in data["authorization_servers"]
    assert "prompts" in data["scopes_supported"]
    assert "header" in data["bearer_methods_supported"]


@pytest.mark.asyncio
async def test_dynamic_client_registration(client: AsyncClient):
    """Verify RFC 7591 Dynamic Client Registration (DCR) for Claude and AI clients."""
    payload = {
        "client_name": "Claude Desktop",
        "redirect_uris": ["https://claude.ai/api/mcp/oauth_callback"],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
    }
    resp = await client.post("/oauth/register", json=payload)
    assert resp.status_code == 201
    data = resp.json()

    assert data["client_id"].startswith("ph_client_")
    assert data["client_name"] == "Claude Desktop"
    assert data["redirect_uris"] == ["https://claude.ai/api/mcp/oauth_callback"]
    assert "authorization_code" in data["grant_types"]


@pytest.mark.asyncio
async def test_oauth_authorize_get_consent_screens(client: AsyncClient, test_users_and_groups):
    """Verify consent page renders correctly for unauthenticated and authenticated users."""
    redirect_uri = "https://claude.ai/api/mcp/oauth_callback"

    # 1. Unauthenticated visitor: Should show sign-in inputs
    resp_unauth = await client.get(
        "/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": "claude",
            "redirect_uri": redirect_uri,
            "state": "state_unauth",
            "code_challenge": _generate_pkce_pair()[1],
        },
    )
    assert resp_unauth.status_code == 200
    assert "text/html" in resp_unauth.headers["content-type"]
    assert "Connect to PromptHold" in resp_unauth.text
    assert "Anthropic Claude" in resp_unauth.text
    assert "name=\"email\"" in resp_unauth.text
    assert "name=\"password\"" in resp_unauth.text

    # 2. Authenticated user (with session token): Shows signed-in identity
    owner_token = test_users_and_groups["tokens"]["owner"]
    resp_auth = await client.get(
        "/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": "claude",
            "redirect_uri": redirect_uri,
            "state": "state_auth",
            "code_challenge": _generate_pkce_pair()[1],
        },
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert resp_auth.status_code == 200
    assert "Signed in as" in resp_auth.text
    assert "Group Owner" in resp_auth.text
    assert "owner@test.com" in resp_auth.text
    assert "Authorize Access" in resp_auth.text


@pytest.mark.asyncio
async def test_oauth_authorize_post_cancellation(client: AsyncClient):
    """Verify user cancelling consent redirects back with access_denied."""
    redirect_uri = "https://claude.ai/api/mcp/oauth_callback"
    resp = await client.post(
        "/oauth/authorize",
        data={
            "action": "cancel",
            "client_id": "claude",
            "redirect_uri": redirect_uri,
            "state": "cancelled_state_456",
        },
    )
    assert resp.status_code == 302
    location = resp.headers["location"]
    parsed = urlparse(location)
    qs = parse_qs(parsed.query)

    assert qs["error"][0] == "access_denied"
    assert qs["state"][0] == "cancelled_state_456"


@pytest.mark.asyncio
async def test_oauth_pkce_flow_and_token_exchange(client: AsyncClient, test_users_and_groups):
    """Verify complete end-to-end PKCE authorization code exchange and API access."""
    redirect_uri = "https://claude.ai/api/mcp/oauth_callback"
    verifier, challenge = _generate_pkce_pair()

    # 1. Authorize with email/password and PKCE challenge
    resp_auth = await client.post(
        "/oauth/authorize",
        data={
            "action": "authorize",
            "client_id": "claude",
            "redirect_uri": redirect_uri,
            "state": "random_pkce_state",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "scope": "prompts",
            "email": "owner@test.com",
            "password": "Password123",
        },
    )
    assert resp_auth.status_code == 302
    location = resp_auth.headers["location"]
    parsed = urlparse(location)
    qs = parse_qs(parsed.query)

    assert "code" in qs
    assert qs["state"][0] == "random_pkce_state"
    auth_code = qs["code"][0]
    assert auth_code.startswith("ph_code_")

    # 2. Exchange code for access token using code_verifier
    token_resp = await client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": auth_code,
            "client_id": "claude",
            "redirect_uri": redirect_uri,
            "code_verifier": verifier,
        },
    )
    assert token_resp.status_code == 200
    tokens = token_resp.json()

    assert "access_token" in tokens
    assert tokens["token_type"] == "Bearer"
    assert "refresh_token" not in tokens
    assert tokens["scope"] == "prompts"

    issued_access_token = tokens["access_token"]
    assert issued_access_token.startswith("pv_live_") or issued_access_token.startswith("ph_")

    # 3. Access authenticated PromptHold API using the OAuth Bearer token
    me_resp = await client.get(
        "/api/me",
        headers={"Authorization": f"Bearer {issued_access_token}"},
    )
    assert me_resp.status_code == 200
    me_data = me_resp.json()
    assert me_data["email"] == "owner@test.com"
    assert me_data["name"] == "Group Owner"

    # 4. Access prompts list using the OAuth Bearer token
    prompts_resp = await client.get(
        "/api/prompts",
        headers={"Authorization": f"Bearer {issued_access_token}"},
    )
    assert prompts_resp.status_code == 200
    prompts_list = prompts_resp.json()
    assert len(prompts_list) >= 1
    assert any(p["title"] == "Code Reviewer Prompt" for p in prompts_list)


@pytest.mark.asyncio
async def test_oauth_security_and_replay_rejection(client: AsyncClient, test_users_and_groups):
    """Verify security controls: replay prevention and invalid PKCE verifier rejection."""
    redirect_uri = "https://claude.ai/api/mcp/oauth_callback"
    verifier, challenge = _generate_pkce_pair()

    # Pre-authorized session request
    owner_token = test_users_and_groups["tokens"]["owner"]
    resp_auth = await client.post(
        "/oauth/authorize",
        data={
            "action": "authorize",
            "client_id": "claude",
            "redirect_uri": redirect_uri,
            "state": "session_state",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "scope": "prompts",
        },
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert resp_auth.status_code == 302
    parsed = urlparse(resp_auth.headers["location"])
    auth_code = parse_qs(parsed.query)["code"][0]

    # Test 1: Exchange with invalid code_verifier must fail with 400
    bad_token_resp = await client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": auth_code,
            "client_id": "claude",
            "redirect_uri": redirect_uri,
            "code_verifier": "completely_wrong_verifier_1234567890",
        },
    )
    assert bad_token_resp.status_code == 400
    assert bad_token_resp.json()["error"] == "invalid_grant"

    # Test 2: Exchange with valid code_verifier succeeds
    good_token_resp = await client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": auth_code,
            "client_id": "claude",
            "redirect_uri": redirect_uri,
            "code_verifier": verifier,
        },
    )
    assert good_token_resp.status_code == 200

    # Test 3: Replay attack (reusing the same code) must fail immediately with 400
    replay_resp = await client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": auth_code,
            "client_id": "claude",
            "redirect_uri": redirect_uri,
            "code_verifier": verifier,
        },
    )
    assert replay_resp.status_code == 400
    assert replay_resp.json()["error"] == "invalid_grant"
    assert "already been used" in replay_resp.json()["error_description"]


@pytest.mark.asyncio
async def test_oauth_rejects_untrusted_redirect_uri(client: AsyncClient, test_users_and_groups):
    """A logged-in user must never have an authorization code sent to an attacker-controlled redirect_uri."""
    owner_token = test_users_and_groups["tokens"]["owner"]
    _, challenge = _generate_pkce_pair()
    for client_id in ("claude", "attacker-made-up-id"):
        resp = await client.post(
            "/oauth/authorize",
            data={"action": "authorize", "client_id": client_id, "redirect_uri": "https://evil.example/cb",
                  "code_challenge": challenge, "code_challenge_method": "S256"},
            headers={"Authorization": f"Bearer {owner_token}"},
        )
        assert resp.status_code == 400
        assert "location" not in resp.headers

    reg = (await client.post("/oauth/register", json={"redirect_uris": ["https://app.example/cb"]})).json()
    resp = await client.get("/oauth/authorize", params={
        "client_id": reg["client_id"], "redirect_uri": "https://evil.example/cb", "code_challenge": challenge})
    assert resp.status_code == 400

    bad_reg = await client.post("/oauth/register", json={"redirect_uris": ["javascript:alert(1)"]})
    assert bad_reg.status_code == 400


@pytest.mark.asyncio
async def test_oauth_requires_pkce(client: AsyncClient, test_users_and_groups):
    owner_token = test_users_and_groups["tokens"]["owner"]
    resp = await client.post(
        "/oauth/authorize",
        data={"action": "authorize", "client_id": "claude", "redirect_uri": "https://claude.ai/api/mcp/oauth_callback"},
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert resp.status_code == 400
    assert "location" not in resp.headers


@pytest.mark.asyncio
async def test_anonymous_mcp_request_gets_oauth_challenge(client: AsyncClient):
    """MCP clients discover OAuth from a 401 with RFC 9728 resource metadata."""
    resp = await client.post("/mcp/", json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    assert resp.status_code == 401
    assert 'resource_metadata="http://testserver/.well-known/oauth-protected-resource"' in resp.headers["www-authenticate"]
