"""Native OAuth 2.0 / 2.1 Authorization Server implementation for PromptHold.

Conforms to:
- RFC 8414 (OAuth 2.0 Authorization Server Metadata)
- RFC 9728 (OAuth 2.0 Protected Resource Metadata)
- RFC 7591 (OAuth 2.0 Dynamic Client Registration)
- RFC 7636 (PKCE: Proof Key for Code Exchange)
- RFC 6749 (The OAuth 2.0 Authorization Framework)
"""

import base64
import hashlib
import hmac
import html
import json
import secrets
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlencode, urlparse, parse_qsl

from sqlalchemy.orm import Session

from auth import create_api_key_record, user_for_session_token, verify_password
from models import ApiKey, OAuthAuthorizationCode, OAuthClient, User


def get_oauth_server_metadata(base_url: str) -> dict[str, Any]:
    """RFC 8414 OAuth 2.0 Authorization Server Metadata document."""
    clean_base = base_url.rstrip("/")
    return {
        "issuer": clean_base,
        "authorization_endpoint": f"{clean_base}/oauth/authorize",
        "token_endpoint": f"{clean_base}/oauth/token",
        "registration_endpoint": f"{clean_base}/oauth/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256", "plain"],
        "token_endpoint_auth_methods_supported": [
            "client_secret_post",
            "client_secret_basic",
            "none",
        ],
        "scopes_supported": ["prompts", "read", "write"],
        "service_documentation": f"{clean_base}/",
        "ui_locales_supported": ["en"],
    }


def get_oauth_protected_resource_metadata(base_url: str) -> dict[str, Any]:
    """RFC 9728 OAuth 2.0 Protected Resource Metadata document for MCP."""
    clean_base = base_url.rstrip("/")
    return {
        "resource": f"{clean_base}/mcp",
        "authorization_servers": [clean_base],
        "scopes_supported": ["prompts", "read", "write"],
        "bearer_methods_supported": ["header"],
    }


def register_oauth_client(
    db: Session,
    client_name: str = "AI Assistant",
    redirect_uris: list[str] | None = None,
    grant_types: list[str] | None = None,
    response_types: list[str] | None = None,
) -> OAuthClient:
    """RFC 7591 Dynamic Client Registration (DCR)."""
    client_id = f"ph_client_{secrets.token_hex(16)}"
    client_secret = f"ph_sec_{secrets.token_urlsafe(32)}"
    uris = redirect_uris or []
    grants = grant_types or ["authorization_code", "refresh_token"]
    responses = response_types or ["code"]

    client = OAuthClient(
        id=client_id,
        client_secret=client_secret,
        client_name=(client_name or "AI Assistant").strip()[:160],
        redirect_uris_json=json.dumps(uris),
        grant_types_json=json.dumps(grants),
        response_types_json=json.dumps(responses),
        created_at=datetime.utcnow(),
    )
    db.add(client)
    db.commit()
    db.refresh(client)
    return client


def get_or_create_client(db: Session, client_id: str, redirect_uri: str = "") -> OAuthClient:
    """Retrieve existing client or auto-provision well-known AI client IDs."""
    client = db.query(OAuthClient).filter_by(id=client_id).first()
    if client is not None:
        return client

    # Auto-provision standard AI clients (Claude, ChatGPT, Gemini, Cursor)
    known_names = {
        "claude": "Anthropic Claude",
        "claude.ai": "Anthropic Claude.ai",
        "chatgpt": "OpenAI ChatGPT",
        "gemini": "Google Gemini",
        "cursor": "Cursor IDE",
    }
    name = known_names.get(client_id.lower(), client_id)
    uris = [redirect_uri] if redirect_uri else []

    client = OAuthClient(
        id=client_id,
        client_secret=None,
        client_name=name,
        redirect_uris_json=json.dumps(uris),
        grant_types_json=json.dumps(["authorization_code", "refresh_token"]),
        response_types_json=json.dumps(["code"]),
        created_at=datetime.utcnow(),
    )
    db.add(client)
    db.commit()
    db.refresh(client)
    return client


def verify_pkce(code_verifier: str | None, code_challenge: str | None, method: str | None = "S256") -> bool:
    """Verify PKCE code_verifier against code_challenge per RFC 7636."""
    if not code_challenge:
        return True
    if not code_verifier:
        return False

    clean_method = (method or "S256").upper()
    if clean_method == "PLAIN":
        return hmac.compare_digest(code_verifier.strip(), code_challenge.strip())
    elif clean_method == "S256":
        digest = hashlib.sha256(code_verifier.strip().encode("ascii")).digest()
        computed = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
        target = code_challenge.strip().rstrip("=")
        return hmac.compare_digest(computed, target)
    return False


def create_authorization_code(
    db: Session,
    client_id: str,
    user_id: str,
    redirect_uri: str,
    code_challenge: str | None = None,
    code_challenge_method: str | None = "S256",
    scope: str = "prompts",
) -> str:
    """Generate and record a single-use authorization code with 10-minute expiry."""
    code = f"ph_code_{secrets.token_urlsafe(32)}"
    expires_at = datetime.utcnow() + timedelta(minutes=10)

    auth_code = OAuthAuthorizationCode(
        code=code,
        client_id=client_id,
        user_id=user_id,
        redirect_uri=redirect_uri,
        code_challenge=code_challenge,
        code_challenge_method=code_challenge_method or "S256",
        scope=scope or "prompts",
        is_used=False,
        expires_at=expires_at,
        created_at=datetime.utcnow(),
    )
    db.add(auth_code)
    db.commit()
    return code


def exchange_authorization_code(
    db: Session,
    code: str,
    client_id: str,
    redirect_uri: str,
    code_verifier: str | None = None,
) -> dict[str, Any]:
    """Validate authorization code and PKCE, then issue scoped access tokens."""
    auth_code = db.query(OAuthAuthorizationCode).filter_by(code=code.strip()).first()
    if auth_code is None:
        raise ValueError("Invalid authorization code.")
    if auth_code.is_used:
        raise ValueError("Authorization code has already been used.")
    if auth_code.expires_at < datetime.utcnow():
        raise ValueError("Authorization code has expired.")
    if client_id and auth_code.client_id != client_id.strip():
        raise ValueError("client_id does not match the authorization code.")
    if redirect_uri and auth_code.redirect_uri.rstrip("/") != redirect_uri.strip().rstrip("/"):
        raise ValueError("redirect_uri does not match the original authorization request.")

    if auth_code.code_challenge:
        if not verify_pkce(code_verifier, auth_code.code_challenge, auth_code.code_challenge_method):
            raise ValueError("PKCE verification failed: invalid code_verifier.")

    # Mark authorization code as used immediately to prevent replay attacks
    auth_code.is_used = True
    db.commit()

    user = db.query(User).filter_by(id=auth_code.user_id).first()
    if user is None:
        raise ValueError("User associated with authorization code not found.")

    # Issue a scoped PromptHold API key dedicated to this OAuth client
    effective_client_id = client_id.strip() if client_id else auth_code.client_id
    client = db.query(OAuthClient).filter_by(id=effective_client_id).first()
    client_display = client.client_name if client else "OAuth Client"

    key_record, raw_token = create_api_key_record(
        db=db,
        user=user,
        name=f"OAuth: {client_display}",
        description=f"Auto-provisioned OAuth token for {client_display}",
        scope_type="GLOBAL",
        access_level="READ_WRITE",
    )
    refresh_token = f"ph_refr_{secrets.token_urlsafe(32)}"

    return {
        "access_token": raw_token,
        "token_type": "Bearer",
        "expires_in": 30 * 86400,  # 30 days
        "refresh_token": refresh_token,
        "scope": auth_code.scope or "prompts",
    }


def render_oauth_authorize_html(
    client_name: str,
    client_id: str,
    redirect_uri: str,
    state: str,
    code_challenge: str | None,
    code_challenge_method: str | None,
    scope: str,
    logged_in_user: User | None = None,
    error_message: str = "",
) -> str:
    """Render an elegant, responsive HTML authorization consent screen."""
    safe_client_name = html.escape(client_name or "AI Assistant")
    safe_client_id = html.escape(client_id)
    safe_redirect_uri = html.escape(redirect_uri)
    safe_state = html.escape(state)
    safe_code_challenge = html.escape(code_challenge or "")
    safe_code_challenge_method = html.escape(code_challenge_method or "S256")
    safe_scope = html.escape(scope or "prompts")
    safe_error = html.escape(error_message)

    user_card_html = ""
    form_inputs_html = ""

    if logged_in_user is not None:
        user_card_html = f"""
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin-bottom:18px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;font-weight:600;">Signed in as</div>
            <div style="font-size:14px;font-weight:700;color:#0f172a;margin-top:2px;">{html.escape(logged_in_user.name)}</div>
            <div style="font-size:12px;color:#64748b;">{html.escape(logged_in_user.email)}</div>
        </div>
        """
        form_inputs_html = """
        <div style="display:flex;gap:10px;margin-top:20px;">
            <button type="submit" name="action" value="cancel" style="flex:1;padding:10px 14px;background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>
            <button type="submit" name="action" value="authorize" style="flex:2;padding:10px 14px;background:#2563eb;color:#ffffff;border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 1px 2px rgba(37,99,235,0.2);">Authorize Access</button>
        </div>
        """
    else:
        user_card_html = """
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin-bottom:16px;">
            <div style="font-size:12px;color:#475569;margin-bottom:12px;font-weight:500;">Please sign in with your PromptHold account to grant access:</div>
            <div style="margin-bottom:10px;">
                <label style="display:block;font-size:11px;font-weight:600;color:#475569;margin-bottom:4px;">Email Address</label>
                <input type="email" name="email" required style="width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;outline:none;" placeholder="you@example.com" />
            </div>
            <div>
                <label style="display:block;font-size:11px;font-weight:600;color:#475569;margin-bottom:4px;">Password</label>
                <input type="password" name="password" required style="width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;outline:none;" placeholder="••••••••" />
            </div>
        </div>
        """
        form_inputs_html = """
        <div style="display:flex;gap:10px;margin-top:20px;">
            <button type="submit" name="action" value="cancel" style="flex:1;padding:10px 14px;background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>
            <button type="submit" name="action" value="authorize" style="flex:2;padding:10px 14px;background:#2563eb;color:#ffffff;border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 1px 2px rgba(37,99,235,0.2);">Sign In &amp; Authorize</button>
        </div>
        """

    error_banner = ""
    if safe_error:
        error_banner = f"""
        <div style="background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:10px;padding:10px 14px;font-size:12px;margin-bottom:14px;font-weight:500;">
            {safe_error}
        </div>
        """

    return f"""<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Authorize {safe_client_name} — PromptHold</title>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background: #f1f5f9;
            color: #0f172a;
            margin: 0;
            padding: 24px 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            box-sizing: border-box;
        }}
        .card {{
            background: #ffffff;
            border: 1px solid #e2e8f0;
            border-radius: 16px;
            max-width: 440px;
            width: 100%;
            padding: 28px 24px;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05);
        }}
        .scope-item {{
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 13px;
            color: #334155;
            margin-bottom: 8px;
        }}
        .scope-bullet {{
            width: 6px;
            height: 6px;
            background: #2563eb;
            border-radius: 50%;
            flex-shrink: 0;
        }}
    </style>
</head>
<body>
    <div class="card">
        <div style="text-align:center;margin-bottom:20px;">
            <div style="display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;background:#eff6ff;color:#2563eb;border-radius:12px;margin-bottom:12px;">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
            </div>
            <h1 style="font-size:18px;font-weight:700;margin:0 0 6px 0;color:#0f172a;">Connect to PromptHold</h1>
            <p style="font-size:13px;color:#64748b;margin:0;">
                <strong>{safe_client_name}</strong> wants permission to use your saved prompts.
            </p>
        </div>

        {error_banner}

        <div style="background:#fafafa;border:1px solid #f1f5f9;border-radius:12px;padding:12px 14px;margin-bottom:18px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;font-weight:600;margin-bottom:8px;">Permissions Requested</div>
            <div class="scope-item">
                <span class="scope-bullet"></span>
                <span>Read active prompts from authorized spaces</span>
            </div>
            <div class="scope-item" style="margin-bottom:0;">
                <span class="scope-bullet"></span>
                <span>Fill prompt variables and save new versions from chat</span>
            </div>
        </div>

        <form method="POST" action="/oauth/authorize">
            <input type="hidden" name="client_id" value="{safe_client_id}" />
            <input type="hidden" name="redirect_uri" value="{safe_redirect_uri}" />
            <input type="hidden" name="state" value="{safe_state}" />
            <input type="hidden" name="code_challenge" value="{safe_code_challenge}" />
            <input type="hidden" name="code_challenge_method" value="{safe_code_challenge_method}" />
            <input type="hidden" name="scope" value="{safe_scope}" />

            {user_card_html}
            {form_inputs_html}
        </form>

        <div style="text-align:center;margin-top:18px;font-size:11px;color:#94a3b8;">
            PromptHold RBAC &amp; Version Control &bull; Secure OAuth 2.1 Connection
        </div>
    </div>
</body>
</html>
"""
