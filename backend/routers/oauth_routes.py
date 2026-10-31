"""oauth routes API routes."""

import base64
import html
import json
from datetime import datetime
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse


from fastapi import APIRouter, Depends, Form, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from sqlalchemy.orm import Session

from database import (
    SessionNeon,
    SessionSupabase,
    get_db,
    is_test_session,
)
from auth import (verify_password)
from models import (OAuthAuthorizationCode,
                    OAuthClient, User)
from oauth import (create_authorization_code, exchange_authorization_code, get_oauth_protected_resource_metadata,
                   get_oauth_server_metadata, get_or_create_client, is_redirect_uri_allowed, register_oauth_client,
                   render_oauth_authorize_html)

from deps import (_get_public_base_url, maybe_user)

router = APIRouter()


@router.get("/.well-known/oauth-authorization-server", tags=["OAuth"])
async def oauth_authorization_server_metadata(request: Request):
    """RFC 8414 OAuth 2.0 Authorization Server Metadata document for Claude.ai and AI connectors."""
    base_url = _get_public_base_url(request)
    return get_oauth_server_metadata(base_url)


@router.get("/.well-known/openid-configuration", tags=["OAuth"])
async def openid_configuration_metadata(request: Request):
    """OpenID Connect Discovery metadata endpoint alias."""
    base_url = _get_public_base_url(request)
    return get_oauth_server_metadata(base_url)


@router.get("/.well-known/oauth-protected-resource", tags=["OAuth"])
async def oauth_protected_resource_metadata(request: Request):
    """RFC 9728 OAuth 2.0 Protected Resource Metadata document for Model Context Protocol (MCP)."""
    base_url = _get_public_base_url(request)
    return get_oauth_protected_resource_metadata(base_url)


@router.post("/oauth/register", status_code=201, tags=["OAuth"])
async def oauth_dynamic_client_registration(
    request: Request,
    db: Session = Depends(get_db),
):
    """RFC 7591 Dynamic Client Registration (DCR) for Claude.ai and AI assistants."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    client_name = body.get("client_name") or "AI Assistant"
    redirect_uris = body.get("redirect_uris") or []
    grant_types = body.get("grant_types") or ["authorization_code", "refresh_token"]
    response_types = body.get("response_types") or ["code"]

    try:
        client = register_oauth_client(
            db=db,
            client_name=client_name,
            redirect_uris=redirect_uris,
            grant_types=grant_types,
            response_types=response_types,
        )
    except ValueError as err:
        return JSONResponse({"error": "invalid_redirect_uri", "error_description": str(err)}, status_code=400)
    return {
        "client_id": client.id,
        "client_secret": client.client_secret,
        "client_name": client.client_name,
        "redirect_uris": json.loads(client.redirect_uris_json),
        "grant_types": grant_types,
        "response_types": response_types,
        "token_endpoint_auth_method": "none" if not client.client_secret else "client_secret_post",
    }


def _oauth_error_page(message: str) -> HTMLResponse:
    """Show OAuth request errors in-page; never redirect to an unverified redirect_uri."""
    return HTMLResponse(
        f"<!doctype html><title>Authorization error</title><p style='font-family:sans-serif;padding:24px'>"
        f"Authorization request rejected: {html.escape(message)}</p>",
        status_code=400,
    )


@router.get("/oauth/authorize", response_class=HTMLResponse, tags=["OAuth"])
async def oauth_authorize_get(
    request: Request,
    client_id: str,
    redirect_uri: str,
    response_type: str = "code",
    state: str = "",
    code_challenge: str | None = None,
    code_challenge_method: str | None = "S256",
    scope: str = "prompts",
    db: Session = Depends(get_db),
    user: User | None = Depends(maybe_user),
):
    """Browser consent screen for OAuth 2.0 / 2.1 authorization request."""
    client = get_or_create_client(db, client_id)
    if client is None or not is_redirect_uri_allowed(client, redirect_uri):
        return _oauth_error_page("Unknown client or unregistered redirect_uri.")
    if not code_challenge or (code_challenge_method or "S256").upper() != "S256":
        return _oauth_error_page("PKCE with code_challenge_method=S256 is required.")
    if response_type != "code":
        err_target = f"{redirect_uri}{'&' if '?' in redirect_uri else '?'}error=unsupported_response_type&error_description=Only+code+response_type+is+supported"
        if state:
            err_target += f"&state={urlencode({'s': state})[2:]}"
        return RedirectResponse(url=err_target, status_code=302)

    html_page = render_oauth_authorize_html(
        client_name=client.client_name,
        client_id=client.id,
        redirect_uri=redirect_uri,
        state=state,
        code_challenge=code_challenge,
        code_challenge_method=code_challenge_method,
        scope=scope,
        logged_in_user=user,
    )
    return HTMLResponse(content=html_page, status_code=200)


@router.post("/oauth/authorize", tags=["OAuth"])
async def oauth_authorize_post(
    request: Request,
    action: str = Form("authorize"),
    client_id: str = Form(...),
    redirect_uri: str = Form(...),
    state: str = Form(""),
    code_challenge: str | None = Form(None),
    code_challenge_method: str | None = Form("S256"),
    scope: str = Form("prompts"),
    email: str | None = Form(None),
    password: str | None = Form(None),
    db: Session = Depends(get_db),
    user: User | None = Depends(maybe_user),
):
    """Handle approval or cancellation from the OAuth authorization consent screen."""
    client = get_or_create_client(db, client_id)
    if client is None or not is_redirect_uri_allowed(client, redirect_uri):
        return _oauth_error_page("Unknown client or unregistered redirect_uri.")

    # If user cancelled, redirect with access_denied
    if action == "cancel":
        parsed = urlparse(redirect_uri)
        q = dict(parse_qsl(parsed.query))
        q["error"] = "access_denied"
        q["error_description"] = "User denied the authorization request"
        if state:
            q["state"] = state
        target = urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, urlencode(q), parsed.fragment))
        return RedirectResponse(url=target, status_code=302)

    auth_user = user
    active_db = db
    close_active_db = False

    if auth_user is None:
        if not email or not password:
            html_page = render_oauth_authorize_html(
                client_name=client.client_name,
                client_id=client.id,
                redirect_uri=redirect_uri,
                state=state,
                code_challenge=code_challenge,
                code_challenge_method=code_challenge_method,
                scope=scope,
                logged_in_user=None,
                error_message="Please enter your email and password to authorize access.",
            )
            return HTMLResponse(content=html_page, status_code=400)

        clean_email = email.strip().lower()
        candidate = None
        if is_test_session(db):
            c = db.query(User).filter_by(email=clean_email).first()
            if c and c.password_hash and verify_password(password, c.password_hash):
                candidate = c
        else:
            try:
                n_db = SessionNeon()
                n_user = n_db.query(User).filter_by(email=clean_email).first()
                if n_user and n_user.password_hash and verify_password(password, n_user.password_hash):
                    candidate = n_user
                    active_db = n_db
                    close_active_db = True
            except Exception:
                pass

            if not candidate:
                try:
                    s_db = SessionSupabase()
                    s_user = s_db.query(User).filter_by(email=clean_email).first()
                    if s_user and s_user.password_hash and verify_password(password, s_user.password_hash):
                        candidate = s_user
                        active_db = s_db
                        close_active_db = True
                except Exception:
                    pass

        if candidate is None:
            if close_active_db and active_db:
                active_db.close()
            html_page = render_oauth_authorize_html(
                client_name=client.client_name,
                client_id=client.id,
                redirect_uri=redirect_uri,
                state=state,
                code_challenge=code_challenge,
                code_challenge_method=code_challenge_method,
                scope=scope,
                logged_in_user=None,
                error_message="Invalid email or password. Please try again.",
            )
            return HTMLResponse(content=html_page, status_code=400)
        auth_user = candidate

    if not code_challenge or (code_challenge_method or "S256").upper() != "S256":
        if close_active_db and active_db:
            active_db.close()
        return _oauth_error_page("PKCE with code_challenge_method=S256 is required.")

    # Issue single-use authorization code
    try:
        target_client = get_or_create_client(active_db, client.id)
        if target_client is None:  # DCR client registered in the other tier database: mirror it
            target_client = OAuthClient(id=client.id, client_secret=client.client_secret, client_name=client.client_name,
                                        redirect_uris_json=client.redirect_uris_json, grant_types_json=client.grant_types_json,
                                        response_types_json=client.response_types_json, created_at=datetime.utcnow())
            active_db.add(target_client)
            active_db.commit()
        code = create_authorization_code(
            db=active_db,
            client_id=target_client.id,
            user_id=auth_user.id,
            redirect_uri=redirect_uri,
            code_challenge=code_challenge,
            code_challenge_method=code_challenge_method,
            scope=scope,
        )
    finally:
        if close_active_db and active_db:
            active_db.close()

    parsed = urlparse(redirect_uri)
    q = dict(parse_qsl(parsed.query))
    q["code"] = code
    if state:
        q["state"] = state
    target = urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, urlencode(q), parsed.fragment))
    return RedirectResponse(url=target, status_code=302)


@router.post("/oauth/token", tags=["OAuth"])
async def oauth_token_exchange(
    request: Request,
    db: Session = Depends(get_db),
):
    """RFC 6749 / RFC 7636 OAuth token endpoint supporting authorization_code with PKCE."""
    content_type = request.headers.get("content-type", "")
    params: dict[str, Any] = {}
    if "application/json" in content_type:
        try:
            params = await request.json()
        except Exception:
            params = {}
    else:
        try:
            form = await request.form()
            params = dict(form)
        except Exception:
            params = {}

    # Check HTTP Basic auth header for client credentials (client_secret_basic)
    auth_header = request.headers.get("authorization", "")
    client_id = params.get("client_id", "").strip()
    if auth_header.lower().startswith("basic "):
        try:
            b64_val = auth_header[6:].strip()
            decoded = base64.b64decode(b64_val).decode("utf-8")
            if ":" in decoded:
                basic_client_id, _ = decoded.split(":", 1)
                if not client_id:
                    client_id = basic_client_id.strip()
        except Exception:
            pass

    grant_type = params.get("grant_type", "").strip()
    code = params.get("code", "").strip()
    redirect_uri = params.get("redirect_uri", "").strip()
    code_verifier = params.get("code_verifier")

    if grant_type != "authorization_code":
        return Response(
            content=json.dumps({
                "error": "unsupported_grant_type",
                "error_description": f"Grant type '{grant_type}' is not supported. Use 'authorization_code'.",
            }),
            status_code=400,
            media_type="application/json",
        )

    if not code:
        return Response(
            content=json.dumps({
                "error": "invalid_request",
                "error_description": "Missing required parameter: code.",
            }),
            status_code=400,
            media_type="application/json",
        )

    target_db = db
    close_target = False
    if not is_test_session(db):
        auth_code_record = db.query(OAuthAuthorizationCode).filter_by(code=code.strip()).first()
        if not auth_code_record:
            try:
                n_db = SessionNeon()
                if n_db.query(OAuthAuthorizationCode).filter_by(code=code.strip()).first():
                    target_db = n_db
                    close_target = True
            except Exception:
                pass
            if not close_target:
                try:
                    s_db = SessionSupabase()
                    if s_db.query(OAuthAuthorizationCode).filter_by(code=code.strip()).first():
                        target_db = s_db
                        close_target = True
                except Exception:
                    pass

    try:
        try:
            token_data = exchange_authorization_code(
                db=target_db,
                code=code,
                client_id=client_id,
                redirect_uri=redirect_uri,
                code_verifier=code_verifier,
            )
        finally:
            if close_target and target_db:
                target_db.close()
        return Response(
            content=json.dumps(token_data),
            status_code=200,
            media_type="application/json",
            headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
        )
    except ValueError as err:
        return Response(
            content=json.dumps({
                "error": "invalid_grant",
                "error_description": str(err),
            }),
            status_code=400,
            media_type="application/json",
            headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
        )
    except Exception as exc:
        return Response(
            content=json.dumps({
                "error": "server_error",
                "error_description": "An unexpected error occurred during token exchange.",
            }),
            status_code=500,
            media_type="application/json",
        )


