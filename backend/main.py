import base64
import csv
import hashlib
import io
import json
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from dotenv import load_dotenv
load_dotenv()

from fastapi import Cookie, Depends, FastAPI, File, Form, Header, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import (
    Base,
    PAID_PLANS,
    SessionLocal,
    SessionNeon,
    SessionSupabase,
    cache_token_plan,
    engine,
    engine_neon,
    engine_supabase,
    get_db,
    get_db_bind_url,
    get_db_for_plan,
    get_sessionmaker_for_plan,
    is_community_plan,
    is_supabase_configured,
    is_test_session,
    migrate_user_tier,
)
from auth import (DUMMY_PASSWORD_HASH, SESSION_LIFETIME, create_api_key_record, create_session,
                  delete_all_user_sessions, delete_session, ensure_demo_passwords, hash_password, is_hash_upgrade_needed,
                  resolve_api_key, upgrade_schema, user_for_session_token, verify_firebase_id_token, verify_password)
from cache import (create_github_issue_for_feedback, invalidate_prompt_cache, set_cached_active_version_uuid,
                   set_cached_version_by_uuid)
from permissions import (can_access_group_with_key, can_user_approve_proposals, can_user_direct_write_prompt,
                         can_user_manage_group_members, can_user_view_group, ensure_all_personal_groups,
                         ensure_personal_group, extract_variables, get_scoped_group_ids, get_user_group_ids,
                         get_user_group_role, group_display_name, require_workspace_admin)
from models import (ApiKey, AuditLog, FeedbackSubmission, Group, GroupMembership, OAuthAuthorizationCode,
                    OAuthClient, Prompt, PromptChunk, PromptProposal, PromptVersion, ProposalApproval,
                    SharedDiffLink, User)
from oauth import (create_authorization_code, exchange_authorization_code, get_oauth_protected_resource_metadata,
                   get_oauth_server_metadata, get_or_create_client, register_oauth_client,
                   render_oauth_authorize_html)
from search import hybrid_search_prompts, sync_prompt_embeddings
from schemas import (AssignMemberRequest, ChangePasswordRequest, CheckoutSessionRequest, CreateApiKeyRequest, CreateDiffShareRequest,
                     FeedbackCreateRequest, FirebaseAuthRequest, GroupCreate, GroupSettingsUpdate, LoginRequest,
                     PlanUpdateRequest, PromptCreateRequest, PromptDuplicateRequest, PromptUpdateRequest,
                     ProposalCreateRequest, RegisterRequest, UpdateProfileRequest)
from polar_billing import (create_checkout_session, create_customer_portal_session, is_polar_configured,
                           process_polar_event, verify_polar_webhook_signature)
from security import (AUTO_MIGRATE_DB, IS_PRODUCTION, MAX_BATCH_PROMPTS_PER_FILE, MAX_UPLOAD_FILES,
                      MAX_UPLOAD_FILE_BYTES, SecurityHeadersMiddleware, escape_like, get_allowed_origins,
                      get_client_ip, rate_limiter, record_audit_log, sanitize_filename, should_seed_demo_data,
                      validate_text_upload_content)
from fastmcp.server.http import create_sse_app
from seed import seed_initial_data
from mcp_server import mcp, register_session_key

FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
SESSION_COOKIE_NAME = "ph_session"
mcp_asgi = mcp.http_app(path="/")
mcp_sse_asgi = create_sse_app(server=mcp, message_path="/messages", sse_path="/sse")


@asynccontextmanager
async def lifespan(application: FastAPI):
    if AUTO_MIGRATE_DB:
        # 1. Initialize Neon tables & schema upgrades (Paid Tiers)
        try:
            Base.metadata.create_all(bind=engine_neon)
            upgrade_schema(engine_neon)
        except Exception as exc:
            import logging
            logging.getLogger("uvicorn.error").warning("Neon automatic DDL migration skipped: %s", exc)

        # 2. Initialize Supabase tables & schema upgrades (Free/Community Tier)
        try:
            Base.metadata.create_all(bind=engine_supabase)
            upgrade_schema(engine_supabase)
        except Exception as exc:
            import logging
            logging.getLogger("uvicorn.error").warning("Supabase automatic DDL migration skipped: %s", exc)

    # 3. Seed Neon database with demo team accounts if enabled
    try:
        with SessionNeon() as db_neon:
            if should_seed_demo_data():
                seed_initial_data(db_neon)
                ensure_demo_passwords(db_neon)
            ensure_all_personal_groups(db_neon)
    except Exception as exc:
        import logging
        logging.getLogger("uvicorn.error").warning("Neon seed initialization warning: %s", exc)

    # 4. Ensure personal spaces and demo data in Supabase as well
    try:
        with SessionSupabase() as db_supa:
            if should_seed_demo_data():
                seed_initial_data(db_supa)
                ensure_demo_passwords(db_supa)
            ensure_all_personal_groups(db_supa)
    except Exception as exc:
        import logging
        logging.getLogger("uvicorn.error").warning("Supabase seed initialization warning: %s", exc)

    async with mcp_asgi.lifespan(application):
        async with mcp_sse_asgi.lifespan(application):
            yield


app = FastAPI(
    title="PromptHold RBAC & Version Control",
    version="2.0.0",
    lifespan=lifespan,
    docs_url=None if IS_PRODUCTION else "/docs",
    redoc_url=None if IS_PRODUCTION else "/redoc",
    openapi_url="/openapi.json",
)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_allowed_origins(),
    allow_origin_regex=r"https://(prompthold|prompt-vault)(-[a-z0-9_-]+)?((\.[a-z0-9_-]+)?)\.(pages\.dev|workers\.dev|onrender\.com|hf\.space)",
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept", "X-Requested-With", "If-None-Match"],
    expose_headers=["ETag", "Mcp-Session-Id"],
)


@app.middleware("http")
async def mcp_session_key_capture_middleware(request: Request, call_next):
    session_id = request.headers.get("mcp-session-id")
    api_key = (
        (request.headers.get("Authorization") or "").replace("Bearer ", "").replace("bearer ", "").strip()
        or request.headers.get("X-API-Key", "").strip()
        or request.query_params.get("api_key", "").strip()
        or request.query_params.get("token", "").strip()
    )
    if not api_key:
        match = re.search(r"/(?:s|k|key)/([^/?#]+)", request.url.path)
        if match:
            api_key = match.group(1).strip()

    response = await call_next(request)

    resp_sess = response.headers.get("mcp-session-id") or session_id
    if resp_sess and api_key:
        register_session_key(resp_sess, api_key)
    return response


@app.get("/api/openapi.json", include_in_schema=False)
def get_api_openapi_json() -> dict:
    """Provide /api/openapi.json as an alias for Custom GPT and tool-calling agents."""
    return app.openapi()


def _bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    return token.strip() if scheme.lower() == "bearer" and token.strip() else None


def _get_public_base_url(request: Request) -> str:
    env_url = (os.getenv("PUBLIC_BASE_URL") or os.getenv("APP_URL") or "").strip()
    if env_url:
        return env_url.rstrip("/")
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme or "https"
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or str(request.url.netloc)
    return f"{proto}://{host}".rstrip("/")


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        max_age=int(SESSION_LIFETIME.total_seconds()),
        httponly=True,
        secure=IS_PRODUCTION,
        samesite="lax",
        path="/",
    )


def _clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key=SESSION_COOKIE_NAME, path="/", httponly=True, samesite="lax")


def current_user(
    request: Request,
    authorization: str | None = Header(default=None),
    session_cookie: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
    db: Session = Depends(get_db),
) -> User:
    """Accept a web login session token (Bearer or HttpOnly cookie) or a scoped API key."""
    bearer = _bearer_token(authorization)
    cookie_token = (session_cookie or request.cookies.get("pv_session") or "").strip() or None
    token = bearer or cookie_token
    if token is None:
        raise HTTPException(status_code=401, detail="Please sign in to continue.")

    # Enforce CSRF defense when authenticating solely via cookie on state-changing requests
    if not bearer and cookie_token and request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        xrw = request.headers.get("x-requested-with", "")
        origin = request.headers.get("origin", "").rstrip("/")
        if xrw not in {"PromptHold", "PromptVault"} and origin not in set(get_allowed_origins()):
            raise HTTPException(status_code=403, detail="CSRF verification failed: missing X-Requested-With header or untrusted Origin.")

    session_user = user_for_session_token(db, token)
    if session_user is not None:
        session_user._active_api_key = None  # type: ignore[attr-defined]
        return session_user

    # Multi-tier probe across Supabase and Neon if not found in current db
    if not is_test_session(db):
        bind_url = get_db_bind_url(db)
        alt_factory = SessionSupabase if bind_url == str(engine_neon.url) else SessionNeon
        try:
            with alt_factory() as alt_db:
                alt_session_user = user_for_session_token(alt_db, token)
                if alt_session_user is not None:
                    alt_session_user._active_api_key = None
                    return alt_session_user
        except Exception:
            pass

    client_ip = get_client_ip(request)
    if rate_limiter.count_recent(f"invalid_auth:{client_ip}", window_seconds=60) >= 20:
        raise HTTPException(status_code=429, detail="Too many invalid authentication attempts. Please wait a minute.")

    resolved = resolve_api_key(db, token)
    if resolved is not None:
        key_user, key_record = resolved
        key_user._active_api_key = key_record  # type: ignore[attr-defined]
        return key_user

    if not is_test_session(db):
        bind_url = get_db_bind_url(db)
        alt_factory = SessionSupabase if bind_url == str(engine_neon.url) else SessionNeon
        try:
            with alt_factory() as alt_db:
                alt_resolved = resolve_api_key(alt_db, token)
                if alt_resolved is not None:
                    key_user, key_record = alt_resolved
                    key_user._active_api_key = key_record  # type: ignore[attr-defined]
                    return key_user
        except Exception:
            pass

    rate_limiter.record_hit(f"invalid_auth:{client_ip}")
    raise HTTPException(status_code=401, detail="Your session or API key is invalid or has expired. Please sign in again.")


def maybe_user(
    request: Request,
    authorization: str | None = Header(default=None),
    session_cookie: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
    db: Session = Depends(get_db),
) -> User | None:
    bearer = _bearer_token(authorization)
    cookie_token = (session_cookie or request.cookies.get("pv_session") or "").strip() or None
    token = bearer or cookie_token
    if not token:
        return None
    session_user = user_for_session_token(db, token)
    if session_user is not None:
        return session_user
    if not is_test_session(db):
        bind_url = get_db_bind_url(db)
        alt_factory = SessionSupabase if bind_url == str(engine_neon.url) else SessionNeon
        try:
            with alt_factory() as alt_db:
                alt_user = user_for_session_token(alt_db, token)
                if alt_user is not None:
                    return alt_user
        except Exception:
            pass
    res = resolve_api_key(db, token)
    if res is not None:
        user, key = res
        setattr(user, "_active_api_key", key)
        return user
    if not is_test_session(db):
        bind_url = get_db_bind_url(db)
        alt_factory = SessionSupabase if bind_url == str(engine_neon.url) else SessionNeon
        try:
            with alt_factory() as alt_db:
                alt_res = resolve_api_key(alt_db, token)
                if alt_res is not None:
                    user, key = alt_res
                    setattr(user, "_active_api_key", key)
                    return user
        except Exception:
            pass
    return None


def _active_key(user: User) -> ApiKey | None:
    return getattr(user, "_active_api_key", None)


def _require_web_session(user: User) -> None:
    """Block API keys from performing account, RBAC, or security administration actions."""
    if _active_key(user) is not None:
        raise HTTPException(status_code=403, detail="This action requires an interactive web session and cannot be performed with an API key.")


def _require_write_permission(user: User) -> None:
    """Enforce READ_ONLY vs READ_WRITE access level when authenticated via an API key."""
    key = _active_key(user)
    if key is not None and getattr(key, "access_level", "READ_WRITE") == "READ_ONLY":
        raise HTTPException(status_code=403, detail="This API key has Read-Only access and cannot modify prompts or submit proposals.")


def _auth_response(db: Session, user: User, response: Response) -> dict:
    token = create_session(db, user)
    cache_token_plan(token, getattr(user, "plan", "community") or "community")
    _set_session_cookie(response, token)
    return {"token": token,
            "user": {"id": user.id, "name": user.name, "email": user.email, "is_workspace_admin": user.is_workspace_admin}}


@app.post("/api/auth/register", status_code=201)
def register(payload: RegisterRequest, request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    client_ip = get_client_ip(request)
    rate_limiter.check(f"register_ip:{client_ip}", limit=5, window_seconds=60,
                       detail="Too many registration attempts from this IP. Please wait a minute.")
    email = payload.email.strip().lower()

    is_test_env = is_test_session(db)

    if is_test_env:
        target_db = db
        close_target = False
    else:
        target_factory = get_sessionmaker_for_plan(payload.plan)
        target_db = target_factory()
        close_target = True

    try:
        if target_db.query(User).filter(User.email == email).first():
            raise HTTPException(status_code=409, detail="An account with this email already exists. Try signing in.")
        if not is_test_env:
            alt_factory = SessionNeon if is_community_plan(payload.plan) else SessionSupabase
            try:
                with alt_factory() as alt_db:
                    if alt_db.query(User).filter(User.email == email).first():
                        raise HTTPException(status_code=409, detail="An account with this email already exists. Try signing in.")
            except Exception:
                pass

        initial_admin_email = os.getenv("INITIAL_ADMIN_EMAIL", "").strip().lower()
        if initial_admin_email:
            is_admin = email == initial_admin_email
        else:
            is_admin = (not IS_PRODUCTION) and (target_db.query(User).count() == 0)
        user = User(name=payload.name.strip(), email=email, is_workspace_admin=is_admin,
                    password_hash=hash_password(payload.password), plan=payload.plan)
        target_db.add(user)
        target_db.commit()
        ensure_personal_group(target_db, user)
        record_audit_log(target_db, "AUTH_REGISTER", user_id=user.id, ip_address=client_ip, details=f"Registered {email}")
        return _auth_response(target_db, user, response)
    finally:
        if close_target:
            target_db.close()


@app.post("/api/auth/login")
def login(payload: LoginRequest, request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    client_ip = get_client_ip(request)
    email = payload.email.strip().lower()
    rate_limiter.check(f"login_ip:{client_ip}", limit=10, window_seconds=60,
                       detail="Too many sign-in attempts. Please wait 60 seconds and try again.")
    lockout_bucket = f"login_fail:{client_ip}:{email}"
    if rate_limiter.count_recent(lockout_bucket, window_seconds=300) >= 5:
        raise HTTPException(status_code=429, detail="Account temporarily locked due to repeated failed sign-in attempts. Try again in 5 minutes.")

    is_test_env = is_test_session(db)

    user = None
    target_db = db
    close_target = False

    if is_test_env:
        user = db.query(User).filter(User.email == email).first()
    else:
        n_user = None
        s_user = None
        n_db = None
        s_db = None
        try:
            n_db = SessionNeon()
            n_user = n_db.query(User).filter(User.email == email).first()
        except Exception:
            if n_db:
                n_db.close()
                n_db = None

        try:
            s_db = SessionSupabase()
            s_user = s_db.query(User).filter(User.email == email).first()
        except Exception:
            if s_db:
                s_db.close()
                s_db = None

        if n_user and (not s_user or getattr(n_user, "plan", "") in PAID_PLANS):
            user = n_user
            target_db = n_db
            close_target = True
            if s_db:
                s_db.close()
        elif s_user:
            user = s_user
            target_db = s_db
            close_target = True
            if n_db:
                n_db.close()
        elif n_user:
            user = n_user
            target_db = n_db
            close_target = True

    now_utc = datetime.utcnow()
    if user is not None and user.locked_until and user.locked_until > now_utc:
        remaining_secs = int((user.locked_until - now_utc).total_seconds())
        remaining_mins = max(1, (remaining_secs + 59) // 60)
        record_audit_log(target_db, "AUTH_LOGIN_BLOCKED_LOCKED", user_id=user.id, ip_address=client_ip,
                         details=f"Account locked until {user.locked_until}")
        raise HTTPException(
            status_code=429,
            detail=f"Account is temporarily locked due to repeated failed sign-in attempts. Please try again in {remaining_mins} minute(s)."
        )

    try:
        password_ok = verify_password(payload.password, user.password_hash if user else DUMMY_PASSWORD_HASH)
        if user is None or not password_ok:
            rate_limiter.record_hit(lockout_bucket)
            if user is not None:
                user.failed_login_attempts = (getattr(user, "failed_login_attempts", 0) or 0) + 1
                if user.failed_login_attempts >= 5:
                    user.locked_until = now_utc + timedelta(minutes=15)
                    record_audit_log(target_db, "AUTH_ACCOUNT_LOCKED", user_id=user.id, ip_address=client_ip,
                                     details=f"Locked after {user.failed_login_attempts} failed attempts")
                target_db.commit()
            record_audit_log(target_db, "AUTH_LOGIN_FAILED", user_id=user.id if user else None, ip_address=client_ip, details=f"Failed login for {email}")
            raise HTTPException(status_code=401, detail="Incorrect email or password.")

        rate_limiter.clear_bucket(lockout_bucket)
        user.failed_login_attempts = 0
        user.locked_until = None
        user.last_login_at = now_utc
        if is_hash_upgrade_needed(user.password_hash):
            user.password_hash = hash_password(payload.password)
        target_db.commit()
        record_audit_log(target_db, "AUTH_LOGIN_SUCCESS", user_id=user.id, ip_address=client_ip, details=f"Signed in {email}")
        return _auth_response(target_db, user, response)
    finally:
        if close_target:
            target_db.close()


@app.post("/api/auth/firebase")
def firebase_sso_login(payload: FirebaseAuthRequest, request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    """Authenticate or auto-provision a user via Firebase Auth (Google / GitHub SSO)."""
    client_ip = get_client_ip(request)
    rate_limiter.check(f"login_ip:{client_ip}", limit=15, window_seconds=60,
                       detail="Too many sign-in attempts. Please wait a minute.")
    verified = verify_firebase_id_token(payload.id_token)
    if verified is None:
        raise HTTPException(status_code=401, detail="Firebase SSO verification failed or FIREBASE_WEB_API_KEY is not configured.")
    email = verified["email"]

    is_test_env = is_test_session(db)

    user = None
    target_db = db
    close_target = False

    if is_test_env:
        user = db.query(User).filter(User.email == email).first()
    else:
        try:
            s_db = SessionSupabase()
            found = s_db.query(User).filter(User.email == email).first()
            if found:
                user = found
                target_db = s_db
                close_target = True
            else:
                s_db.close()
        except Exception:
            pass

        if user is None:
            try:
                n_db = SessionNeon()
                found = n_db.query(User).filter(User.email == email).first()
                if found:
                    user = found
                    target_db = n_db
                    close_target = True
                else:
                    n_db.close()
            except Exception:
                pass

        if user is None:
            target_db = SessionSupabase()
            close_target = True

    try:
        if user is None:
            initial_admin_email = os.getenv("INITIAL_ADMIN_EMAIL", "").strip().lower()
            is_admin = (email == initial_admin_email) if initial_admin_email else False
            user = User(name=verified["name"][:160], email=email, is_workspace_admin=is_admin, password_hash=None, plan="community")
            target_db.add(user)
            target_db.commit()
            ensure_personal_group(target_db, user)
            record_audit_log(target_db, "AUTH_FIREBASE_SSO_REGISTER", user_id=user.id, ip_address=client_ip, details=f"SSO register {email}")
        else:
            record_audit_log(target_db, "AUTH_FIREBASE_SSO", user_id=user.id, ip_address=client_ip, details=f"SSO login {email}")
        return _auth_response(target_db, user, response)
    finally:
        if close_target:
            target_db.close()


@app.post("/api/auth/logout")
def logout(
    response: Response,
    authorization: str | None = Header(default=None),
    session_cookie: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
    db: Session = Depends(get_db),
) -> dict:
    token = _bearer_token(authorization) or (session_cookie.strip() if session_cookie else None)
    if token:
        delete_session(db, token)
    _clear_session_cookie(response)
    return {"logged_out": True}


@app.delete("/api/auth/sessions")
def logout_all_sessions(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict:
    """Invalidate all active login sessions for the current user across all devices."""
    _require_web_session(user)
    revoked = delete_all_user_sessions(db, user.id)
    _clear_session_cookie(response)
    record_audit_log(db, "AUTH_LOGOUT_ALL", user_id=user.id, ip_address=get_client_ip(request), details=f"Revoked {revoked} session(s)")
    return {"logged_out_all": True, "sessions_revoked": revoked}


# ---------------------------------------------------------
# Native OAuth 2.0 / 2.1 RFC Standards Implementation
# RFC 8414, RFC 9728, RFC 7591, RFC 7636, RFC 6749
# ---------------------------------------------------------

@app.get("/.well-known/oauth-authorization-server", tags=["OAuth"])
async def oauth_authorization_server_metadata(request: Request):
    """RFC 8414 OAuth 2.0 Authorization Server Metadata document for Claude.ai and AI connectors."""
    base_url = _get_public_base_url(request)
    return get_oauth_server_metadata(base_url)


@app.get("/.well-known/openid-configuration", tags=["OAuth"])
async def openid_configuration_metadata(request: Request):
    """OpenID Connect Discovery metadata endpoint alias."""
    base_url = _get_public_base_url(request)
    return get_oauth_server_metadata(base_url)


@app.get("/.well-known/oauth-protected-resource", tags=["OAuth"])
async def oauth_protected_resource_metadata(request: Request):
    """RFC 9728 OAuth 2.0 Protected Resource Metadata document for Model Context Protocol (MCP)."""
    base_url = _get_public_base_url(request)
    return get_oauth_protected_resource_metadata(base_url)


@app.post("/oauth/register", status_code=201, tags=["OAuth"])
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

    client = register_oauth_client(
        db=db,
        client_name=client_name,
        redirect_uris=redirect_uris,
        grant_types=grant_types,
        response_types=response_types,
    )
    return {
        "client_id": client.id,
        "client_secret": client.client_secret,
        "client_name": client.client_name,
        "redirect_uris": redirect_uris,
        "grant_types": grant_types,
        "response_types": response_types,
        "token_endpoint_auth_method": "none" if not client.client_secret else "client_secret_post",
    }


@app.get("/oauth/authorize", response_class=HTMLResponse, tags=["OAuth"])
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
    if response_type != "code":
        err_target = f"{redirect_uri}{'&' if '?' in redirect_uri else '?'}error=unsupported_response_type&error_description=Only+code+response_type+is+supported"
        if state:
            err_target += f"&state={urlencode({'s': state})[2:]}"
        return RedirectResponse(url=err_target, status_code=302)

    client = get_or_create_client(db, client_id, redirect_uri)
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


@app.post("/oauth/authorize", tags=["OAuth"])
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
    client = get_or_create_client(db, client_id, redirect_uri)

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

    # If not already signed in via session, authenticate email & password
    auth_user = user
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

        candidate = db.query(User).filter_by(email=email.strip().lower()).first()
        if candidate is None or not candidate.password_hash or not verify_password(password, candidate.password_hash):
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

    # Issue single-use authorization code
    code = create_authorization_code(
        db=db,
        client_id=client.id,
        user_id=auth_user.id,
        redirect_uri=redirect_uri,
        code_challenge=code_challenge,
        code_challenge_method=code_challenge_method,
        scope=scope,
    )

    parsed = urlparse(redirect_uri)
    q = dict(parse_qsl(parsed.query))
    q["code"] = code
    if state:
        q["state"] = state
    target = urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, urlencode(q), parsed.fragment))
    return RedirectResponse(url=target, status_code=302)


@app.post("/oauth/token", tags=["OAuth"])
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

    try:
        token_data = exchange_authorization_code(
            db=db,
            code=code,
            client_id=client_id,
            redirect_uri=redirect_uri,
            code_verifier=code_verifier,
        )
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


def _version_read(db: Session, version: PromptVersion, author_name: str | None = None) -> dict:
    if author_name is None:
        author = db.query(User).filter_by(id=version.author_id).first() if version.author_id else None
        resolved_author = author.name if author else "Unknown"
    else:
        resolved_author = author_name or "Unknown"
    return {"id": version.id, "prompt_id": version.prompt_id, "version_number": version.version_number,
            "content": version.content, "variables": json.loads(version.variables_json),
            "change_note": version.change_Note, "source_filename": version.source_filename,
            "author_id": version.author_id, "author_name": resolved_author,
            "created_at": version.created_at.isoformat() + "Z"}


PLAN_TIERS = [
    {
        "id": "community",
        "name": "Community",
        "tagline": "Individual developers exploring version-controlled prompts and MCP in-chat access.",
        "price_monthly": 0,
        "price_annual": 0,
        "price_label": "$0",
        "max_prompts": 20,
        "max_versions_per_prompt": 10,
        "max_groups": 1,
        "free_guests_per_editor": 0,
        "mcp_monthly_calls": 1000,
        "storage_type": "Free Cloud Database (Supabase / SQLite)",
        "features": [
            "1 User (Private Personal Space)",
            "Up to 20 active prompts",
            "Last 10 versions per prompt",
            "Direct Save (instant versioning)",
            "FastMCP In-Chat Drawer & Personal API Key",
            "Word & sentence basic diff viewer",
        ],
    },
    {
        "id": "pro",
        "name": "Pro",
        "tagline": "Power prompt crafters and freelancers managing extensive prompt libraries.",
        "price_monthly": 5,
        "price_annual": 4,  # $48/year
        "price_label": "$5/mo",
        "max_prompts": 100,
        "max_versions_per_prompt": 50,
        "max_groups": 1,
        "free_guests_per_editor": 0,
        "mcp_monthly_calls": 10000,
        "storage_type": "Cloud DB + Bring Your Own Storage (Google Drive / Local)",
        "features": [
            "Everything in Community",
            "Up to 100 active prompts",
            "Up to 50 versions per prompt",
            "Word & Sentence Diff Viewer (Split & Inline)",
            "Shareable Zero-Config Diff Links",
            "Batch File Upload (.txt, .md, .csv, .json)",
            "Bring Your Own Storage (Google Drive & local sync)",
        ],
    },
    {
        "id": "team",
        "name": "Team",
        "badge": "Most Popular",
        "tagline": "Startups and product teams collaborating with approval workflows and RBAC.",
        "price_monthly": 12,
        "price_annual": 10,  # $120/year
        "price_label": "$10/editor/mo",
        "max_prompts": 500,
        "max_versions_per_prompt": 100,
        "max_groups": 5,
        "free_guests_per_editor": 2,
        "mcp_monthly_calls": 50000,
        "storage_type": "Team Cloud DB + Google Drive Team Sync",
        "features": [
            "Everything in Pro",
            "No seat minimums (starts at 1 editor)",
            "2 Free Read-Only Guests per paid editor",
            "Up to 500 prompts across 5 Team Groups",
            "Proposal & Approval Workflow (required_approvals)",
            "Central Review Requests Inbox & auto-merge",
            "3 Team MCP API Keys for automated agents",
            "Team Cloud & Google Drive Sync",
        ],
    },
    {
        "id": "enterprise",
        "name": "Enterprise",
        "tagline": "Organizations requiring self-hosting, strict compliance, and custom infrastructure.",
        "price_monthly": None,
        "price_annual": None,
        "price_label": "Contact Us",
        "max_prompts": 10000,
        "max_versions_per_prompt": 1000,
        "max_groups": 100,
        "free_guests_per_editor": 10,
        "mcp_monthly_calls": 1000000,
        "storage_type": "Self-Hosted Docker / VPC / Private PostgreSQL",
        "features": [
            "Everything in Team",
            "Self-Hosted Deployment (Docker / VPC / On-Prem)",
            "Dedicated PostgreSQL or custom DB cluster",
            "SSO / SAML 2.0 (Okta, Google Workspace, Azure AD)",
            "Custom prompt & version quotas",
            "Full Compliance & Audit Logs Export",
            "Dedicated SLA & onboarding support",
        ],
    },
]

PLAN_LIMITS_MAP = {tier["id"]: tier for tier in PLAN_TIERS}


def _check_prompt_quota(db: Session, user: User, group_id: str, new_prompts_count: int = 1) -> None:
    if user.is_workspace_admin:
        return
    user_plan = getattr(user, "plan", "community") or "community"
    plan_info = PLAN_LIMITS_MAP.get(user_plan, PLAN_LIMITS_MAP["community"])
    max_prompts = plan_info.get("max_prompts", 20)
    existing_count = db.query(Prompt).filter(Prompt.created_by == user.id, Prompt.is_archived.is_(False)).count()
    if existing_count + new_prompts_count > max_prompts:
        raise HTTPException(
            status_code=403,
            detail=f"Prompt limit reached ({existing_count}/{max_prompts}) for the {plan_info['name']} plan. Please upgrade to Pro or Team for more space.",
        )


def _check_version_quota(db: Session, user: User, prompt: Prompt) -> None:
    if user.is_workspace_admin:
        return
    user_plan = getattr(user, "plan", "community") or "community"
    plan_info = PLAN_LIMITS_MAP.get(user_plan, PLAN_LIMITS_MAP["community"])
    max_versions = plan_info.get("max_versions_per_prompt", 10)
    max_ver = db.query(func.max(PromptVersion.version_number)).filter_by(prompt_id=prompt.id).scalar() or 0
    if max_ver >= max_versions:
        raise HTTPException(
            status_code=403,
            detail=f"This prompt has reached the maximum of {max_versions} versions on the {plan_info['name']} plan. Please upgrade to preserve more versions.",
        )


def _check_group_quota(db: Session, user: User) -> None:
    if user.is_workspace_admin:
        return
    user_plan = getattr(user, "plan", "community") or "community"
    plan_info = PLAN_LIMITS_MAP.get(user_plan, PLAN_LIMITS_MAP["community"])
    max_groups = plan_info.get("max_groups", 1)
    created_team_groups = db.query(Group).filter(Group.created_by == user.id, Group.personal_owner_id.is_(None)).count()
    if created_team_groups >= max_groups:
        raise HTTPException(
            status_code=403,
            detail=f"You have reached your limit of {max_groups} team group(s) on the {plan_info['name']} plan. Please upgrade to Team for more spaces.",
        )


def _create_prompt(db: Session, user: User, group_id: str, title: str, content: str,
                   description: str = "", change_note: str = "Initial creation", source_filename: str | None = None) -> Prompt:
    safe_title = (title.strip() or "Untitled prompt")[:240]
    safe_desc = (description or "")[:2000]
    safe_note = (change_note or "Initial creation")[:500]
    safe_source = sanitize_filename(source_filename) if source_filename else None
    prompt = Prompt(group_id=group_id, title=safe_title, description=safe_desc,
                    current_version_number=1, created_by=user.id)
    db.add(prompt)
    db.flush()
    v1 = PromptVersion(prompt_id=prompt.id, version_number=1, content=content,
                       variables_json=json.dumps(extract_variables(content)), change_Note=safe_note,
                       source_filename=safe_source, author_id=user.id)
    db.add(v1)
    db.flush()
    prompt.current_version_id = v1.id
    set_cached_version_by_uuid(v1.id, {"id": v1.id, "content": v1.content})
    set_cached_active_version_uuid(prompt.id, v1.id)
    sync_prompt_embeddings(db, prompt, v1)
    return prompt


@app.get("/api/health")
def health_check(db: Session = Depends(get_db)) -> dict:
    """Fast health check endpoint reporting status for both Neon (Paid) and Supabase (Community) tiers."""
    from sqlalchemy import text
    db_ok = True
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        db_ok = False

    neon_status = "connected"
    try:
        with SessionNeon() as n_db:
            n_db.execute(text("SELECT 1"))
    except Exception:
        neon_status = "unreachable"

    supa_status = "connected" if is_supabase_configured() else "local_fallback (prompthold_community.db)"
    try:
        with SessionSupabase() as s_db:
            s_db.execute(text("SELECT 1"))
    except Exception:
        supa_status = "unreachable"

    return {
        "status": "ok" if db_ok else "degraded",
        "service": "prompt-vault-mcp",
        "version": "2.0.0",
        "database": "connected" if db_ok else "unreachable",
        "tiers": {
            "paid": {
                "provider": "Neon PostgreSQL",
                "plans": ["pro", "team", "enterprise"],
                "status": neon_status,
            },
            "community": {
                "provider": "Supabase PostgreSQL" if is_supabase_configured() else "SQLite Fallback",
                "configured": is_supabase_configured(),
                "plans": ["community"],
                "status": supa_status,
            },
        },
    }


def _accessible_prompt(db: Session, user: User, prompt_id: str) -> Prompt:
    prompt = db.query(Prompt).filter_by(id=prompt_id).first()
    if prompt is None or not can_access_group_with_key(db, user, prompt.group_id, _active_key(user)):
        raise HTTPException(status_code=404, detail="Prompt not found")
    return prompt


def _api_key_read(db: Session, record: ApiKey) -> dict:
    group = db.query(Group).filter_by(id=record.group_id).first() if record.group_id else None
    is_personal = bool(group and group.personal_owner_id is not None)
    if record.scope_type == "GLOBAL":
        scope_label = "All Spaces + Personal"
    elif group:
        scope_label = "Personal" if is_personal else group.name
    else:
        scope_label = "Removed Group"
    return {
        "id": record.id,
        "name": record.name,
        "description": record.description,
        "key_prefix": record.key_prefix,
        "scope_type": record.scope_type,
        "access_level": getattr(record, "access_level", "READ_WRITE"),
        "group_id": record.group_id,
        "group_name": scope_label,
        "is_personal_group": is_personal,
        "is_active": record.is_active,
        "created_at": record.created_at.isoformat() + "Z",
        "last_used_at": (record.last_used_at.isoformat() + "Z") if record.last_used_at else None,
        "revoked_at": (record.revoked_at.isoformat() + "Z") if record.revoked_at else None,
    }


@app.get("/api/users")
def list_users(db: Session = Depends(get_db), user: User = Depends(current_user)) -> list[dict]:
    """List teammates visible to the caller (all users for Workspace Admins; shared-group teammates for standard users)."""
    _require_web_session(user)
    if user.is_workspace_admin:
        users = db.query(User).order_by(User.name).all()
    else:
        my_group_ids = [
            row[0]
            for row in db.query(GroupMembership.group_id)
            .join(Group, Group.id == GroupMembership.group_id)
            .filter(GroupMembership.user_id == user.id, Group.personal_owner_id.is_(None))
            .all()
        ]
        if my_group_ids:
            teammate_ids = {
                row[0]
                for row in db.query(GroupMembership.user_id)
                .filter(GroupMembership.group_id.in_(my_group_ids))
                .all()
            }
            teammate_ids.add(user.id)
            users = db.query(User).filter(User.id.in_(teammate_ids)).order_by(User.name).all()
        else:
            users = [user]
    return [{"id": u.id, "name": u.name, "email": u.email, "is_workspace_admin": u.is_workspace_admin} for u in users]


@app.get("/api/me")
def get_me(db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    memberships = db.query(GroupMembership, Group).join(Group).filter(GroupMembership.user_id == user.id).all()
    latest_key = db.query(ApiKey).filter_by(user_id=user.id, is_active=True).order_by(ApiKey.created_at.desc()).first()
    plan_name = getattr(user, "plan", "community") or "community"
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "is_workspace_admin": user.is_workspace_admin,
        "plan": plan_name,
        "api_key": latest_key.key_prefix if latest_key else None,
        "onboarding_completed": bool(user.onboarding_completed),
        "last_login_at": user.last_login_at.isoformat() if getattr(user, "last_login_at", None) else None,
        "created_at": user.created_at.isoformat() if getattr(user, "created_at", None) else None,
        "groups": [
            {"id": m.group_id, "name": group_display_name(group), "role": m.role,
             "is_personal": group.personal_owner_id is not None}
            for m, group in memberships
        ],
    }


@app.put("/api/me/profile")
@app.put("/api/users/profile")
def update_profile(
    payload: UpdateProfileRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict:
    """Update profile details (e.g. display name) for the authenticated user."""
    _require_web_session(user)
    new_name = payload.name.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Name cannot be blank.")
    user.name = new_name
    db.commit()
    db.refresh(user)
    record_audit_log(
        db,
        "USER_PROFILE_UPDATED",
        user_id=user.id,
        ip_address=get_client_ip(request),
        details=f"Updated display name to '{new_name}'",
    )
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "is_workspace_admin": user.is_workspace_admin,
        "plan": getattr(user, "plan", "community") or "community",
    }


@app.post("/api/me/change-password")
@app.post("/api/users/change-password")
def change_password(
    payload: ChangePasswordRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict:
    """Safely rotate password after verifying current credentials and complexity requirements."""
    _require_web_session(user)
    client_ip = get_client_ip(request)

    # 1. Verify current password
    if not verify_password(payload.current_password, user.password_hash):
        record_audit_log(
            db,
            "AUTH_PASSWORD_CHANGE_FAILED",
            user_id=user.id,
            ip_address=client_ip,
            details="Incorrect current password submitted",
        )
        raise HTTPException(status_code=400, detail="Current password is incorrect.")

    # 2. Check that new password is not identical to current
    if payload.current_password == payload.new_password:
        raise HTTPException(status_code=400, detail="New password must be different from your current password.")

    # 3. Update password hash (using Argon2id) and reset any lockout state
    user.password_hash = hash_password(payload.new_password)
    user.failed_login_attempts = 0
    user.locked_until = None
    db.commit()

    record_audit_log(
        db,
        "AUTH_PASSWORD_CHANGED",
        user_id=user.id,
        ip_address=client_ip,
        details="Password rotated successfully",
    )
    return {"message": "Password changed successfully."}


@app.get("/api/pricing")
def get_pricing_plans(db: Session = Depends(get_db), user: User | None = Depends(maybe_user)) -> dict:
    """Return all available plans, limits, and current user's usage if authenticated."""
    current_plan = getattr(user, "plan", "community") if user else "community"
    plan_info = PLAN_LIMITS_MAP.get(current_plan, PLAN_LIMITS_MAP["community"])
    usage = None
    if user is not None:
        prompts_count = db.query(Prompt).filter(Prompt.created_by == user.id, Prompt.is_archived.is_(False)).count()
        usage = {
            "prompts_count": prompts_count,
            "max_prompts": plan_info["max_prompts"],
        }
    return {
        "tiers": PLAN_TIERS,
        "current_plan": current_plan,
        "usage": usage,
    }


@app.patch("/api/me/plan")
@app.post("/api/me/plan")
def update_my_plan(payload: PlanUpdateRequest, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    """Update subscription plan for the current user."""
    _require_web_session(user)
    if payload.plan not in PLAN_LIMITS_MAP:
        raise HTTPException(status_code=400, detail="Invalid plan selected.")
    old_plan = getattr(user, "plan", "community") or "community"
    is_test_env = is_test_session(db)
    if not is_test_env and not user.is_workspace_admin and payload.plan in PAID_PLANS and user.plan != payload.plan:
        raise HTTPException(
            status_code=403,
            detail="Upgrading to a paid subscription requires payment verification or workspace administrator authorization."
        )

    # If transitioning across database tiers (Community <-> Paid), migrate the user's data!
    if not is_test_env and is_community_plan(old_plan) != is_community_plan(payload.plan):
        migrate_user_tier(user.id, old_plan, payload.plan)
        new_factory = get_sessionmaker_for_plan(payload.plan)
        with new_factory() as new_db:
            migrated_user = new_db.query(User).filter_by(id=user.id).first()
            if migrated_user:
                migrated_user.plan = payload.plan
                new_db.commit()
                record_audit_log(
                    new_db,
                    "PLAN_CHANGED",
                    user_id=user.id,
                    ip_address=get_client_ip(request),
                    target_type="user",
                    target_id=user.id,
                    details=f"Migrated tier database and updated plan from {old_plan} to {payload.plan}",
                )
        user.plan = payload.plan
    else:
        user.plan = payload.plan
        db.commit()
        db.refresh(user)
        record_audit_log(
            db,
            "PLAN_CHANGED",
            user_id=user.id,
            ip_address=get_client_ip(request),
            target_type="user",
            target_id=user.id,
            details=f"Changed subscription plan from {old_plan} to {payload.plan}",
        )
    return {
        "message": f"Successfully updated your plan to {payload.plan.title()}.",
        "plan": user.plan,
        "user": {
            "id": user.id,
            "name": user.name,
            "email": user.email,
            "plan": user.plan,
            "is_workspace_admin": user.is_workspace_admin,
        },
    }


@app.get("/api/billing/config")
def get_billing_configuration() -> dict:
    """Return public Polar billing configuration status."""
    return {
        "provider": "polar",
        "configured": is_polar_configured(),
        "environment": os.getenv("POLAR_ENVIRONMENT", "sandbox").strip().lower(),
    }


@app.post("/api/billing/checkout")
def create_billing_checkout(
    payload: CheckoutSessionRequest,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict:
    """Generate a Polar checkout session URL to upgrade to a paid subscription."""
    _require_web_session(user)
    return create_checkout_session(user=user, plan=payload.plan, success_url=payload.success_url)


@app.post("/api/billing/portal")
def create_billing_portal(
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict:
    """Generate a Polar customer portal session URL to self-manage or cancel subscriptions."""
    _require_web_session(user)
    return create_customer_portal_session(user=user)


@app.post("/api/webhooks/polar")
async def handle_polar_webhook(
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """Receive and process incoming verified webhooks from Polar.sh."""
    raw_body = await request.body()
    headers_dict = dict(request.headers)
    event_dict = verify_polar_webhook_signature(raw_body, headers_dict)
    return process_polar_event(event_dict, db)


@app.get("/api/api-keys")
def list_api_keys(db: Session = Depends(get_db), user: User = Depends(current_user)) -> list[dict]:
    """List all active API keys for the signed-in user. Raw secrets are never returned here."""
    _require_web_session(user)
    records = (
        db.query(ApiKey)
        .filter_by(user_id=user.id, is_active=True)
        .order_by(ApiKey.created_at.desc())
        .all()
    )
    return [_api_key_read(db, record) for record in records]


@app.post("/api/api-keys", status_code=201)
def create_api_key(payload: CreateApiKeyRequest, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    """Generate a new API key (Global or Group-scoped). Returns the full raw secret ONLY once."""
    _require_web_session(user)
    ensure_personal_group(db, user)
    group_id: str | None = None
    if payload.scope_type == "GROUP":
        group_id = (payload.group_id or "").strip()
        if not can_user_view_group(db, user, group_id):
            raise HTTPException(status_code=403, detail="You do not have access to the selected group.")
    record, raw_key = create_api_key_record(
        db=db,
        user=user,
        name=payload.name,
        description=payload.description,
        scope_type=payload.scope_type,
        group_id=group_id,
        access_level=payload.access_level,
    )
    record_audit_log(
        db,
        "API_KEY_CREATED",
        user_id=user.id,
        ip_address=get_client_ip(request),
        target_type="api_key",
        target_id=record.id,
        details=f"Created {record.scope_type} ({record.access_level}) key '{record.name}'",
    )
    data = _api_key_read(db, record)
    data["raw_key"] = raw_key
    return data


@app.post("/api/api-keys/{key_id}/revoke")
def revoke_api_key(key_id: str, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    """Revoke an active API key by deleting it permanently (no revoked history is kept)."""
    _require_web_session(user)
    record = db.query(ApiKey).filter_by(id=key_id, user_id=user.id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="API key not found.")
    name = record.name
    db.delete(record)
    db.commit()
    record_audit_log(db, "API_KEY_REVOKED", user_id=user.id, ip_address=get_client_ip(request), target_type="api_key", target_id=key_id, details=f"Revoked key '{name}'")
    return {"revoked": True, "id": key_id, "name": name}


@app.delete("/api/api-keys/{key_id}")
def delete_api_key(key_id: str, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    """Delete an API key record from history."""
    _require_web_session(user)
    record = db.query(ApiKey).filter_by(id=key_id, user_id=user.id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="API key not found.")
    name = record.name
    db.delete(record)
    db.commit()
    record_audit_log(db, "API_KEY_DELETED", user_id=user.id, ip_address=get_client_ip(request), target_type="api_key", target_id=key_id, details=f"Deleted key '{name}'")
    return {"deleted": True, "id": key_id}


@app.post("/api/me/onboarding")
def complete_onboarding(db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    """Mark the first-login product tour as finished (or skipped) for the current user."""
    _require_web_session(user)
    user.onboarding_completed = True
    db.commit()
    return {"onboarding_completed": True}


@app.get("/api/groups")
def list_groups(db: Session = Depends(get_db), user: User = Depends(current_user)) -> list[dict]:
    ensure_personal_group(db, user)
    ids = get_scoped_group_ids(db, user, _active_key(user))
    groups = db.query(Group).filter(Group.id.in_(ids)).order_by(Group.name).all() if ids else []
    groups.sort(key=lambda group: group.personal_owner_id is None)
    result = []
    for group in groups:
        members = db.query(GroupMembership, User).join(User).filter(GroupMembership.group_id == group.id).order_by(User.name).all()
        result.append({"id": group.id, "name": group_display_name(group), "description": group.description,
                       "is_personal": group.personal_owner_id is not None,
                       "required_approvals": getattr(group, "required_approvals", 1),
                       "members": [{"user_id": membership.user_id, "name": member.name, "email": member.email,
                                    "role": membership.role, "added_at": (membership.added_at.isoformat() if getattr(membership, "added_at", None) else datetime.utcnow().isoformat()) + "Z"}
                                   for membership, member in members]})
    return result


@app.put("/api/groups/{group_id}/settings")
@app.patch("/api/groups/{group_id}/settings")
def update_group_settings(group_id: str, payload: GroupSettingsUpdate, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_web_session(user)
    can_user_manage_group_members(db, user, group_id)
    group = db.query(Group).filter_by(id=group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found.")
    if group.personal_owner_id:
        raise HTTPException(status_code=400, detail="Personal space does not require approval settings.")
    group.required_approvals = payload.required_approvals
    db.commit()
    record_audit_log(db, "GROUP_SETTINGS_UPDATED", user_id=user.id, ip_address=get_client_ip(request), target_type="group", target_id=group.id, details=f"required_approvals={group.required_approvals}")
    return {"group_id": group.id, "required_approvals": group.required_approvals}


@app.post("/api/groups", status_code=201)
def create_group(payload: GroupCreate, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    """Any signed-in user may create a group. The creator leads it, unless a Workspace Admin picks another leader."""
    _require_web_session(user)
    _check_group_quota(db, user)
    name = payload.name.strip()
    if not name or name.lower().startswith("personal"):
        raise HTTPException(status_code=400, detail="Please choose a different group name.")
    if db.query(Group).filter_by(name=name).first():
        raise HTTPException(status_code=409, detail="A group with this name already exists.")
    leader = user
    if payload.manager_user_id and payload.manager_user_id != user.id:
        require_workspace_admin(user)
        leader = db.query(User).filter_by(id=payload.manager_user_id).first()
        if not leader:
            raise HTTPException(status_code=404, detail="Selected user not found.")
    group = Group(name=name, description=payload.description.strip(), created_by=user.id)
    db.add(group)
    db.flush()
    db.add(GroupMembership(user_id=leader.id, group_id=group.id, role="GROUP_MANAGER"))
    db.commit()
    record_audit_log(db, "GROUP_CREATED", user_id=user.id, ip_address=get_client_ip(request), target_type="group", target_id=group.id, details=f"Created group '{group.name}'")
    return {"id": group.id, "name": group.name, "description": group.description}


@app.post("/api/groups/{group_id}/members", status_code=201)
def add_member(group_id: str, payload: AssignMemberRequest, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_web_session(user)
    can_user_manage_group_members(db, user, group_id)
    group = db.query(Group).filter_by(id=group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found.")
    if group.personal_owner_id:
        raise HTTPException(status_code=400, detail="Your Personal space is private. Create a group to share prompts with others.")
    if payload.role == "GROUP_MANAGER" and not user.is_workspace_admin:
        raise HTTPException(status_code=403, detail="Only a Workspace Admin can assign Group Managers.")
    if payload.user_id:
        target = db.query(User).filter_by(id=payload.user_id).first()
    else:
        target = db.query(User).filter(User.email == (payload.email or "").strip().lower()).first()
    if not target:
        raise HTTPException(status_code=404, detail="No PromptHold account uses that email yet. Ask them to sign up first, then add them.")
    membership = db.query(GroupMembership).filter_by(user_id=target.id, group_id=group_id).first()
    if membership:
        if membership.role == "GROUP_MANAGER" and not user.is_workspace_admin:
            raise HTTPException(status_code=403, detail="Only a Workspace Admin can change a Group Manager's membership.")
        if payload.role == "GROUP_MANAGER" and not user.is_workspace_admin:
            raise HTTPException(status_code=403, detail="Only a Workspace Admin can assign Group Managers.")
        membership.role = payload.role
    else:
        membership = GroupMembership(user_id=target.id, group_id=group_id, role=payload.role)
        db.add(membership)
    db.commit()
    record_audit_log(db, "GROUP_MEMBER_ASSIGNED", user_id=user.id, ip_address=get_client_ip(request), target_type="group", target_id=group_id, details=f"Assigned {target.email} as {membership.role}")
    return {"user_id": target.id, "name": target.name, "role": membership.role}


@app.delete("/api/groups/{group_id}/members/{target_user_id}")
def remove_member(group_id: str, target_user_id: str, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_web_session(user)
    can_user_manage_group_members(db, user, group_id)
    group = db.query(Group).filter_by(id=group_id).first()
    if group and group.personal_owner_id:
        raise HTTPException(status_code=400, detail="You cannot leave your own Personal space.")
    membership = db.query(GroupMembership).filter_by(group_id=group_id, user_id=target_user_id).first()
    if not membership:
        raise HTTPException(status_code=404, detail="Group membership not found.")
    if membership.role == "GROUP_MANAGER" and not user.is_workspace_admin:
        raise HTTPException(status_code=403, detail="Only a Workspace Admin can remove a Group Manager.")
    db.delete(membership)
    db.commit()
    record_audit_log(db, "GROUP_MEMBER_REMOVED", user_id=user.id, ip_address=get_client_ip(request), target_type="group", target_id=group_id, details=f"Removed user {target_user_id}")
    return {"removed": True}


@app.get("/api/prompts")
def list_prompts(
    request: Request,
    response: Response,
    group_id: str | None = None,
    search: str = "",
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    accessible_ids = get_scoped_group_ids(db, user, _active_key(user))
    if not accessible_ids:
        return []

    ver_count_subq = (
        db.query(
            PromptVersion.prompt_id.label("p_id"),
            func.count(PromptVersion.id).label("v_count"),
        )
        .group_by(PromptVersion.prompt_id)
        .subquery()
    )

    query = (
        db.query(Prompt, Group, PromptVersion, func.coalesce(ver_count_subq.c.v_count, 1))
        .join(Group, Prompt.group_id == Group.id)
        .join(
            PromptVersion,
            (PromptVersion.id == Prompt.current_version_id)
            | (
                Prompt.current_version_id.is_(None)
                & (PromptVersion.prompt_id == Prompt.id)
                & (PromptVersion.version_number == Prompt.current_version_number)
            ),
        )
        .outerjoin(ver_count_subq, ver_count_subq.c.p_id == Prompt.id)
        .filter(Prompt.group_id.in_(accessible_ids), Prompt.is_archived.is_(False))
    )
    if group_id:
        query = query.filter(Prompt.group_id == group_id)
    if search.strip():
        return hybrid_search_prompts(
            db=db,
            query_text=search.strip(),
            accessible_group_ids=accessible_ids,
            group_id_filter=group_id,
            limit=500,
        )

    rows = query.order_by(Prompt.updated_at.desc()).limit(500).all()

    # Compute fast ETag from active version UUIDs + updated_at timestamps
    etag_seed = "|".join(f"{p.id}:{v.id}:{int(p.updated_at.timestamp())}:{vc}" for p, _, v, vc in rows)
    etag_value = f'W/"{hashlib.sha256(etag_seed.encode("utf-8")).hexdigest()[:24]}"'
    if request.headers.get("if-none-match") == etag_value:
        return Response(status_code=304, headers={"ETag": etag_value})

    response.headers["ETag"] = etag_value
    response.headers["Cache-Control"] = "private, must-revalidate"

    result = []
    for prompt, group, version, v_count in rows:
        result.append(
            {
                "id": prompt.id,
                "group_id": prompt.group_id,
                "group_name": group_display_name(group),
                "title": prompt.title,
                "description": prompt.description,
                "current_version_number": prompt.current_version_number,
                "current_version_id": version.id,
                "updated_at": prompt.updated_at.isoformat() + "Z",
                "content": version.content,
                "variables": json.loads(version.variables_json),
                "version_count": int(v_count or 1),
            }
        )
    return result


@app.post("/api/prompts", status_code=201)
def create_prompt(payload: PromptCreateRequest, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_write_permission(user)
    if not can_access_group_with_key(db, user, payload.group_id, _active_key(user)):
        raise HTTPException(status_code=403, detail="You (or this scoped API key) cannot create prompts in this group.")
    role = get_user_group_role(db, user, payload.group_id)
    if role == "GUEST":
        raise HTTPException(status_code=403, detail="Guests have view-only access and cannot create prompts.")
    _check_prompt_quota(db, user, payload.group_id)
    prompt = _create_prompt(db, user, payload.group_id, payload.title, payload.content, payload.description,
                            payload.change_note, payload.source_filename)
    db.commit()
    db.refresh(prompt)
    return {
        "id": prompt.id,
        "title": prompt.title,
        "group_id": prompt.group_id,
        "current_version_number": 1,
        "current_version_id": prompt.current_version_id,
    }


@app.post("/api/prompts/upload-files", status_code=201)
async def upload_files(request: Request, group_id: str = Form(...), prompt_id: str | None = Form(None),
                       change_note: str = Form("Uploaded from file"), files: list[UploadFile] = File(...),
                       db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_write_permission(user)
    rate_limiter.check(f"upload_user:{user.id}", limit=15, window_seconds=60,
                       detail="Too many file upload requests. Please wait a minute and try again.")
    if len(files) > MAX_UPLOAD_FILES:
        raise HTTPException(status_code=400, detail=f"You can upload at most {MAX_UPLOAD_FILES} files at once.")
    safe_change_note = (change_note or "Uploaded from file").strip()[:500]
    if not can_access_group_with_key(db, user, group_id, _active_key(user)):
        raise HTTPException(status_code=403, detail="You (or this scoped API key) cannot upload prompts to this group.")
    role = get_user_group_role(db, user, group_id)
    if role == "GUEST":
        raise HTTPException(status_code=403, detail="Guests have view-only access and cannot upload prompts.")
    if prompt_id:
        target = _accessible_prompt(db, user, prompt_id)
        if target.group_id != group_id:
            raise HTTPException(status_code=400, detail="The selected prompt does not belong to this group.")
    created: list[str] = []
    updated: list[str] = []
    proposed: list[str] = []
    try:
        for upload in files:
            filename = sanitize_filename(upload.filename)
            suffix = Path(filename).suffix.lower()
            raw = await upload.read(MAX_UPLOAD_FILE_BYTES + 1)
            if len(raw) > MAX_UPLOAD_FILE_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"{filename} exceeds the maximum allowed size of {MAX_UPLOAD_FILE_BYTES // (1024 * 1024)} MB.",
                )
            text = validate_text_upload_content(raw, filename)
            if suffix in {".txt", ".md"}:
                if len(text) > 100_000:
                    raise HTTPException(status_code=400, detail=f"{filename} exceeds 100,000 characters.")
                if prompt_id:
                    if not can_user_direct_write_prompt(db, user, target.group_id):
                        proposal = PromptProposal(
                            prompt_id=target.id,
                            group_id=target.group_id,
                            proposer_id=user.id,
                            title=target.title,
                            description=target.description,
                            content=text,
                            change_note=f"{safe_change_note} ({filename})"[:500],
                            status="PENDING",
                        )
                        db.add(proposal)
                        db.flush()
                        proposed.append(proposal.id)
                    else:
                        _check_version_quota(db, user, target)
                        max_ver = db.query(func.max(PromptVersion.version_number)).filter_by(prompt_id=target.id).scalar() or 0
                        target.current_version_number = max_ver + 1
                        variables_list = extract_variables(text)
                        new_ver = PromptVersion(
                            prompt_id=target.id,
                            version_number=target.current_version_number,
                            content=text,
                            variables_json=json.dumps(variables_list),
                            change_Note=safe_change_note,
                            source_filename=filename,
                            author_id=user.id,
                        )
                        db.add(new_ver)
                        db.flush()
                        target.current_version_id = new_ver.id
                        target.updated_at = datetime.utcnow()
                        invalidate_prompt_cache(target.id)
                        set_cached_version_by_uuid(
                            new_ver.id,
                            {
                                "id": new_ver.id,
                                "prompt_id": target.id,
                                "title": target.title,
                                "version_number": new_ver.version_number,
                                "content": new_ver.content,
                                "variables": variables_list,
                            },
                        )
                        set_cached_active_version_uuid(target.id, new_ver.id)
                        sync_prompt_embeddings(db, target, new_ver)
                        updated.append(target.id)
                else:
                    _check_prompt_quota(db, user, group_id, 1)
                    prompt = _create_prompt(db, user, group_id, Path(filename).stem, text,
                                            change_note=safe_change_note, source_filename=filename)
                    created.append(prompt.id)
            elif suffix == ".json":
                try:
                    rows = json.loads(text)
                except json.JSONDecodeError as exc:
                    raise HTTPException(status_code=400, detail=f"{filename} contains invalid JSON.") from exc
                if isinstance(rows, dict):
                    rows = rows.get("prompts", [rows])
                if not isinstance(rows, list):
                    raise HTTPException(status_code=400, detail=f"{filename} must contain a list of prompt objects.")
                if len(rows) > MAX_BATCH_PROMPTS_PER_FILE:
                    raise HTTPException(status_code=400, detail=f"{filename} contains more than {MAX_BATCH_PROMPTS_PER_FILE} prompts.")
                for row in rows:
                    if not isinstance(row, dict) or not row.get("title") or not isinstance(row.get("content"), str):
                        raise HTTPException(status_code=400, detail=f"Every row in {filename} needs title and content fields.")
                    if len(row["content"]) > 100_000:
                        raise HTTPException(status_code=400, detail=f"A prompt in {filename} exceeds 100,000 characters.")
                    _check_prompt_quota(db, user, group_id, 1)
                    prompt = _create_prompt(db, user, group_id, str(row["title"]), row["content"],
                                            str(row.get("description", "")), safe_change_note, filename)
                    created.append(prompt.id)
            elif suffix == ".csv":
                reader = csv.DictReader(io.StringIO(text))
                if not reader.fieldnames or not {"title", "content"}.issubset({field.strip().lower() for field in reader.fieldnames}):
                    raise HTTPException(status_code=400, detail=f"{filename} needs title and content columns.")
                row_count = 0
                for row in reader:
                    row_count += 1
                    if row_count > MAX_BATCH_PROMPTS_PER_FILE:
                        raise HTTPException(status_code=400, detail=f"{filename} contains more than {MAX_BATCH_PROMPTS_PER_FILE} rows.")
                    normalized = {str(key).strip().lower(): value for key, value in row.items() if key}
                    if not normalized.get("title") or normalized.get("content") is None:
                        continue
                    if len(normalized["content"]) > 100_000:
                        raise HTTPException(status_code=400, detail=f"A row in {filename} exceeds 100,000 characters.")
                    _check_prompt_quota(db, user, group_id, 1)
                    prompt = _create_prompt(db, user, group_id, normalized["title"], normalized["content"],
                                            normalized.get("description", ""), safe_change_note, filename)
                    created.append(prompt.id)
            else:
                raise HTTPException(status_code=400, detail=f"Unsupported file type: {filename}")
        db.commit()
    except HTTPException:
        if created or updated or proposed:
            db.rollback()
        raise
    except Exception:
        db.rollback()
        raise
    return {"created_prompt_ids": created, "updated_prompt_ids": updated, "proposal_ids": proposed}


@app.put("/api/prompts/{prompt_id}")
def update_prompt(prompt_id: str, payload: PromptUpdateRequest, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_write_permission(user)
    prompt = _accessible_prompt(db, user, prompt_id)
    role = get_user_group_role(db, user, prompt.group_id)
    if role == "GUEST":
        raise HTTPException(status_code=403, detail="Guests have view-only access and cannot edit prompts.")

    if not can_user_direct_write_prompt(db, user, prompt.group_id):
        proposal = PromptProposal(
            prompt_id=prompt.id,
            group_id=prompt.group_id,
            proposer_id=user.id,
            title=payload.title.strip() if payload.title else prompt.title,
            description=payload.description if payload.description is not None else prompt.description,
            content=payload.content,
            change_note=payload.change_note or "Proposed change",
            status="PENDING",
        )
        db.add(proposal)
        db.commit()
        db.refresh(proposal)
        return {
            "proposal_created": True,
            "proposal_id": proposal.id,
            "message": "Your changes have been submitted as a proposal for review.",
        }

    _check_version_quota(db, user, prompt)

    if payload.title is not None:
        prompt.title = payload.title.strip()
    if payload.description is not None:
        prompt.description = payload.description
    max_ver = db.query(func.max(PromptVersion.version_number)).filter_by(prompt_id=prompt.id).scalar() or 0
    prompt.current_version_number = max_ver + 1
    prompt.updated_at = datetime.utcnow()
    safe_source = sanitize_filename(payload.source_filename) if payload.source_filename else None
    variables_list = extract_variables(payload.content)
    version = PromptVersion(
        prompt_id=prompt.id,
        version_number=prompt.current_version_number,
        content=payload.content,
        variables_json=json.dumps(variables_list),
        change_Note=payload.change_note,
        source_filename=safe_source,
        author_id=user.id,
    )
    db.add(version)
    db.flush()
    prompt.current_version_id = version.id
    db.commit()

    invalidate_prompt_cache(prompt.id)
    set_cached_version_by_uuid(
        version.id,
        {
            "id": version.id,
            "prompt_id": prompt.id,
            "title": prompt.title,
            "version_number": version.version_number,
            "content": version.content,
            "variables": variables_list,
        },
    )
    set_cached_active_version_uuid(prompt.id, version.id)
    sync_prompt_embeddings(db, prompt, version)
    return _version_read(db, version, author_name=user.name)


@app.post("/api/prompts/{prompt_id}/rollback/{version_number}")
def rollback_prompt(prompt_id: str, version_number: int, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_write_permission(user)
    prompt = _accessible_prompt(db, user, prompt_id)
    role = get_user_group_role(db, user, prompt.group_id)
    if role != "GROUP_MANAGER":
        raise HTTPException(status_code=403, detail="Only the Group Owner can switch the active version.")
    target = db.query(PromptVersion).filter_by(prompt_id=prompt.id, version_number=version_number).first()
    if target is None:
        raise HTTPException(status_code=404, detail="Version not found.")
    prompt.current_version_number = version_number
    prompt.current_version_id = target.id
    prompt.updated_at = datetime.utcnow()
    db.commit()

    invalidate_prompt_cache(prompt.id)
    set_cached_active_version_uuid(prompt.id, target.id)
    sync_prompt_embeddings(db, prompt, target)
    record_audit_log(db, "PROMPT_ROLLBACK", user_id=user.id, ip_address=get_client_ip(request), target_type="prompt", target_id=prompt.id, details=f"Switched active version to v{version_number} ({target.id})")
    return _version_read(db, target)


@app.post("/api/prompts/{prompt_id}/duplicate", status_code=201)
def duplicate_or_move_prompt_route(
    prompt_id: str,
    payload: PromptDuplicateRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict:
    _require_write_permission(user)
    prompt = _accessible_prompt(db, user, prompt_id)

    # Check caller's role in the source group
    source_role = get_user_group_role(db, user, prompt.group_id)
    if source_role == "GUEST" or source_role not in {"GROUP_MANAGER", "MEMBER"}:
        raise HTTPException(
            status_code=403,
            detail="Guests have view-only access and cannot duplicate or move prompts. Only Members and Owners can duplicate or move prompts.",
        )

    # Check caller's role in the target group
    target_group = db.query(Group).filter_by(id=payload.target_group_id).first()
    if target_group is None or not can_access_group_with_key(db, user, payload.target_group_id, _active_key(user)):
        raise HTTPException(status_code=403, detail="You do not have access to the target group.")

    target_role = get_user_group_role(db, user, payload.target_group_id)
    if target_role == "GUEST" or target_role not in {"GROUP_MANAGER", "MEMBER"}:
        raise HTTPException(
            status_code=403,
            detail="Guests have view-only access and cannot add prompts to the target group. You must be a Member or Owner of the target group.",
        )

    source_group = db.query(Group).filter_by(id=prompt.group_id).first()
    src_name = group_display_name(source_group) if source_group else "Source group"
    tgt_name = group_display_name(target_group)

    if payload.mode == "move":
        if prompt.group_id == payload.target_group_id:
            raise HTTPException(status_code=400, detail="The prompt is already in this space.")
        old_group_id = prompt.group_id
        prompt.group_id = payload.target_group_id
        if payload.title and payload.title.strip():
            prompt.title = payload.title.strip()[:240]
        prompt.updated_at = datetime.utcnow()
        # Transfer any pending proposals for this prompt
        db.query(PromptProposal).filter_by(prompt_id=prompt.id).update({"group_id": payload.target_group_id})
        db.commit()
        db.refresh(prompt)
        invalidate_prompt_cache(prompt.id)
        record_audit_log(
            db,
            "PROMPT_MOVED",
            user_id=user.id,
            ip_address=get_client_ip(request),
            target_type="prompt",
            target_id=prompt.id,
            details=f"Moved from {old_group_id} to {payload.target_group_id}",
        )
        return {
            "id": prompt.id,
            "title": prompt.title,
            "group_id": prompt.group_id,
            "group_name": tgt_name,
            "current_version_number": prompt.current_version_number,
            "mode": "move",
            "message": f"Prompt successfully moved to {tgt_name}.",
        }

    # Otherwise mode == "copy" (Duplicate)
    active_version = None
    if prompt.current_version_id:
        active_version = db.query(PromptVersion).filter_by(id=prompt.current_version_id).first()
    if not active_version:
        active_version = (
            db.query(PromptVersion)
            .filter_by(prompt_id=prompt.id, version_number=prompt.current_version_number)
            .first()
        )
    if not active_version:
        active_version = (
            db.query(PromptVersion)
            .filter_by(prompt_id=prompt.id)
            .order_by(PromptVersion.version_number.desc())
            .first()
        )
    if not active_version:
        raise HTTPException(status_code=400, detail="Source prompt has no content to duplicate.")

    _check_prompt_quota(db, user, payload.target_group_id, 1)

    if payload.title and payload.title.strip():
        new_title = payload.title.strip()[:240]
    else:
        if prompt.group_id == payload.target_group_id:
            new_title = f"{prompt.title} (Copy)"[:240]
        else:
            new_title = prompt.title[:240]

    change_note = f"Duplicated from {src_name} (v{prompt.current_version_number})"
    new_prompt = _create_prompt(
        db=db,
        user=user,
        group_id=payload.target_group_id,
        title=new_title,
        content=active_version.content,
        description=prompt.description,
        change_note=change_note,
        source_filename=active_version.source_filename,
    )
    db.commit()
    db.refresh(new_prompt)
    record_audit_log(
        db,
        "PROMPT_DUPLICATED",
        user_id=user.id,
        ip_address=get_client_ip(request),
        target_type="prompt",
        target_id=new_prompt.id,
        details=f"Duplicated from {prompt.id} ({prompt.title}) to {target_group.id}",
    )
    return {
        "id": new_prompt.id,
        "title": new_prompt.title,
        "group_id": new_prompt.group_id,
        "group_name": tgt_name,
        "current_version_number": 1,
        "mode": "copy",
        "message": f"Prompt successfully duplicated to {tgt_name}.",
    }


def _proposal_read(db: Session, proposal: PromptProposal, current_user_id: str, user_role: str | None) -> dict:
    proposer = db.query(User).filter_by(id=proposal.proposer_id).first()
    approvals_list = []
    has_approved = False
    for a in proposal.approvals:
        u = db.query(User).filter_by(id=a.user_id).first()
        if a.user_id == current_user_id:
            has_approved = True
        approvals_list.append({
            "id": a.id,
            "user_id": a.user_id,
            "user_name": u.name if u else "Unknown",
            "created_at": a.created_at.isoformat() + "Z",
        })
    group = db.query(Group).filter_by(id=proposal.group_id).first()
    required = getattr(group, "required_approvals", 1) if group else 1
    can_approve = (user_role in {"GROUP_MANAGER", "MEMBER"}) and (not has_approved) and (proposal.status == "PENDING") and (proposal.proposer_id != current_user_id)

    return {
        "id": proposal.id,
        "prompt_id": proposal.prompt_id,
        "group_id": proposal.group_id,
        "proposer_id": proposal.proposer_id,
        "proposer_name": proposer.name if proposer else "Unknown",
        "proposer_email": proposer.email if proposer else "",
        "title": proposal.title,
        "description": proposal.description,
        "content": proposal.content,
        "change_note": proposal.change_note,
        "status": proposal.status,
        "created_at": proposal.created_at.isoformat() + "Z",
        "approvals": approvals_list,
        "approvals_count": len(approvals_list),
        "required_approvals": required,
        "can_approve": can_approve,
        "has_approved": has_approved,
    }


@app.get("/api/proposals")
def list_all_proposals(
    group_id: str | None = None,
    status: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> list[dict]:
    group_ids = get_scoped_group_ids(db, user, _active_key(user))
    if group_id:
        if group_id not in group_ids:
            raise HTTPException(status_code=403, detail="You do not have access to this group.")
        target_group_ids = [group_id]
    else:
        target_group_ids = group_ids

    query = db.query(PromptProposal).filter(PromptProposal.group_id.in_(target_group_ids))
    if status:
        query = query.filter(PromptProposal.status == status.upper())

    proposals = query.order_by(PromptProposal.created_at.desc()).all()
    results = []
    for p in proposals:
        role = get_user_group_role(db, user, p.group_id)
        read_data = _proposal_read(db, p, user.id, role)
        prompt = db.query(Prompt).filter_by(id=p.prompt_id).first()
        group = db.query(Group).filter_by(id=p.group_id).first()
        read_data["prompt_title"] = prompt.title if prompt else p.title
        read_data["group_name"] = group.name if group else "Unknown"
        read_data["current_version_number"] = prompt.current_version_number if prompt else 1
        active_ver = None
        if prompt and prompt.current_version_id:
            active_ver = db.query(PromptVersion).filter_by(id=prompt.current_version_id).first()
        if not active_ver and prompt:
            active_ver = (
                db.query(PromptVersion)
                .filter_by(prompt_id=p.prompt_id, version_number=prompt.current_version_number)
                .first()
            )
        read_data["current_content"] = active_ver.content if active_ver else ""
        results.append(read_data)
    return results


@app.get("/api/prompts/{prompt_id}/proposals")
def list_proposals(prompt_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)) -> list[dict]:
    prompt = _accessible_prompt(db, user, prompt_id)
    role = get_user_group_role(db, user, prompt.group_id)
    proposals = db.query(PromptProposal).filter_by(prompt_id=prompt.id).order_by(PromptProposal.created_at.desc()).all()
    return [_proposal_read(db, p, user.id, role) for p in proposals]


@app.post("/api/prompts/{prompt_id}/proposals", status_code=201)
def create_proposal(prompt_id: str, payload: ProposalCreateRequest, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_write_permission(user)
    prompt = _accessible_prompt(db, user, prompt_id)
    role = get_user_group_role(db, user, prompt.group_id)
    if role == "GUEST":
        raise HTTPException(status_code=403, detail="Guests have view-only access and cannot propose changes.")
    proposal = PromptProposal(
        prompt_id=prompt.id,
        group_id=prompt.group_id,
        proposer_id=user.id,
        title=payload.title.strip(),
        description=payload.description.strip(),
        content=payload.content,
        change_note=payload.change_note.strip() or "Proposed change",
        status="PENDING",
    )
    db.add(proposal)
    db.commit()
    db.refresh(proposal)
    return {"id": proposal.id, "status": proposal.status, "message": "Proposal submitted for review."}


@app.post("/api/proposals/{proposal_id}/approve")
def approve_proposal(proposal_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_write_permission(user)
    proposal = db.query(PromptProposal).filter_by(id=proposal_id).first()
    if not proposal:
        raise HTTPException(status_code=404, detail="Proposal not found.")
    prompt = _accessible_prompt(db, user, proposal.prompt_id)
    if not can_user_approve_proposals(db, user, prompt.group_id):
        raise HTTPException(status_code=403, detail="Guests cannot approve proposals.")
    if proposal.status != "PENDING":
        raise HTTPException(status_code=400, detail=f"Proposal is already {proposal.status.lower()}.")
    if proposal.proposer_id == user.id:
        raise HTTPException(status_code=400, detail="You cannot approve your own proposal.")

    existing_approval = db.query(ProposalApproval).filter_by(proposal_id=proposal.id, user_id=user.id).first()
    if existing_approval:
        raise HTTPException(status_code=400, detail="You have already approved this proposal.")

    approval = ProposalApproval(proposal_id=proposal.id, user_id=user.id)
    db.add(approval)
    db.flush()

    total_approvals = db.query(ProposalApproval).filter_by(proposal_id=proposal.id).count()
    group = db.query(Group).filter_by(id=proposal.group_id).first()
    required = getattr(group, "required_approvals", 1) if group else 1

    if total_approvals >= required:
        proposal.status = "APPROVED"
        max_ver = db.query(func.max(PromptVersion.version_number)).filter_by(prompt_id=prompt.id).scalar() or 0
        prompt.current_version_number = max_ver + 1
        prompt.title = proposal.title
        if proposal.description:
            prompt.description = proposal.description
        prompt.updated_at = datetime.utcnow()
        variables_list = extract_variables(proposal.content)
        new_version = PromptVersion(
            prompt_id=prompt.id,
            version_number=prompt.current_version_number,
            content=proposal.content,
            variables_json=json.dumps(variables_list),
            change_Note=f"[Approved] {proposal.change_note}"[:500],
            author_id=proposal.proposer_id,
        )
        db.add(new_version)
        db.flush()
        prompt.current_version_id = new_version.id
        db.commit()

        invalidate_prompt_cache(prompt.id)
        set_cached_version_by_uuid(
            new_version.id,
            {
                "id": new_version.id,
                "prompt_id": prompt.id,
                "title": prompt.title,
                "version_number": new_version.version_number,
                "content": new_version.content,
                "variables": variables_list,
            },
        )
        set_cached_active_version_uuid(prompt.id, new_version.id)
        sync_prompt_embeddings(db, prompt, new_version)
        return {
            "status": "APPROVED",
            "merged": True,
            "approvals_count": total_approvals,
            "required_approvals": required,
            "version_number": prompt.current_version_number,
            "version_id": new_version.id,
        }
    else:
        db.commit()
        return {
            "status": "PENDING",
            "merged": False,
            "approvals_count": total_approvals,
            "required_approvals": required,
        }


@app.post("/api/proposals/{proposal_id}/reject")
def reject_proposal(proposal_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_write_permission(user)
    proposal = db.query(PromptProposal).filter_by(id=proposal_id).first()
    if not proposal:
        raise HTTPException(status_code=404, detail="Proposal not found.")
    prompt = _accessible_prompt(db, user, proposal.prompt_id)
    if not can_user_approve_proposals(db, user, prompt.group_id):
        raise HTTPException(status_code=403, detail="Guests cannot reject proposals.")
    if proposal.status != "PENDING":
        raise HTTPException(status_code=400, detail=f"Proposal is already {proposal.status.lower()}.")
    proposal.status = "REJECTED"
    db.commit()
    return {"status": "REJECTED"}


@app.get("/api/prompts/{prompt_id}/versions")
def prompt_versions(
    prompt_id: str,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    prompt = _accessible_prompt(db, user, prompt_id)
    rows = (
        db.query(PromptVersion, User.name)
        .outerjoin(User, PromptVersion.author_id == User.id)
        .filter(PromptVersion.prompt_id == prompt.id)
        .order_by(PromptVersion.version_number.desc())
        .all()
    )

    etag_seed = f"{prompt.id}:{prompt.current_version_id}:{prompt.current_version_number}:{len(rows)}"
    etag_value = f'W/"{hashlib.sha256(etag_seed.encode("utf-8")).hexdigest()[:24]}"'
    if request.headers.get("if-none-match") == etag_value:
        return Response(status_code=304, headers={"ETag": etag_value})

    response.headers["ETag"] = etag_value
    response.headers["Cache-Control"] = "private, must-revalidate"

    active_pair = None
    others = []
    for v, author_name in rows:
        is_active = (v.id == prompt.current_version_id) if prompt.current_version_id else (v.version_number == prompt.current_version_number)
        if is_active and active_pair is None:
            active_pair = (v, author_name)
        else:
            others.append((v, author_name))
    ranked = ([active_pair] if active_pair else []) + others
    return [_version_read(db, version, author_name=author_name or "Unknown") for version, author_name in ranked]


@app.post("/api/diff-shares", status_code=201)
def create_diff_share(payload: CreateDiffShareRequest, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_write_permission(user)
    prompt = _accessible_prompt(db, user, payload.prompt_id)
    role = get_user_group_role(db, user, prompt.group_id)
    if role == "GUEST":
        raise HTTPException(status_code=403, detail="Guests cannot create external share links.")
    for number in (payload.base_version, payload.target_version):
        if not db.query(PromptVersion.id).filter_by(prompt_id=prompt.id, version_number=number).first():
            raise HTTPException(status_code=404, detail=f"Version {number} not found.")
    days = payload.expires_in_days or 7
    expires_at = datetime.utcnow() + timedelta(days=days)
    record = SharedDiffLink(
        prompt_id=prompt.id,
        base_version=payload.base_version,
        target_version=payload.target_version,
        diff_granularity=payload.diff_granularity,
        view_mode=payload.view_mode,
        created_by=user.id,
        expires_at=expires_at,
        is_revoked=False,
    )
    db.add(record)
    db.commit()
    record_audit_log(db, "DIFF_SHARE_CREATED", user_id=user.id, ip_address=get_client_ip(request), target_type="diff_share", target_id=record.id, details=f"Prompt {prompt.id} v{record.base_version}..v{record.target_version} (expires {days}d)")
    return {
        "share_id": record.id,
        "expires_at": expires_at.isoformat() + "Z",
        "share_url": f"/share/diff/{record.id}?base={record.base_version}&target={record.target_version}&granularity={record.diff_granularity}&mode={record.view_mode}",
    }


@app.delete("/api/diff-shares/{share_id}")
def revoke_diff_share(share_id: str, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_web_session(user)
    record = db.query(SharedDiffLink).filter_by(id=share_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="Shared comparison not found.")
    prompt = _accessible_prompt(db, user, record.prompt_id)
    role = get_user_group_role(db, user, prompt.group_id)
    if record.created_by != user.id and role != "GROUP_MANAGER" and not user.is_workspace_admin:
        raise HTTPException(status_code=403, detail="Only the creator or Group Owner can revoke this shared link.")
    record.is_revoked = True
    db.commit()
    record_audit_log(db, "DIFF_SHARE_REVOKED", user_id=user.id, ip_address=get_client_ip(request), target_type="diff_share", target_id=record.id)
    return {"revoked": True, "share_id": share_id}


@app.get("/api/diff-shares/{share_id}")
def get_diff_share(share_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    rate_limiter.check(f"diff_share_ip:{get_client_ip(request)}", limit=30, window_seconds=60,
                       detail="Too many shared comparison requests. Please wait a minute.")
    record = db.query(SharedDiffLink).filter_by(id=share_id[:64]).first()
    active_db = db
    alt_db_to_close = None
    if record is None and not is_test_session(db):
        bind_url = get_db_bind_url(db)
        alt_factory = SessionNeon if bind_url != str(engine_neon.url) else SessionSupabase
        try:
            alt_db = alt_factory()
            alt_record = alt_db.query(SharedDiffLink).filter_by(id=share_id[:64]).first()
            if alt_record is not None:
                record = alt_record
                active_db = alt_db
                alt_db_to_close = alt_db
        except Exception:
            pass
    try:
        if record is None or getattr(record, "is_revoked", False):
            raise HTTPException(status_code=404, detail="Shared comparison not found or has been revoked.")
        if record.expires_at and record.expires_at < datetime.utcnow():
            raise HTTPException(status_code=410, detail="This shared comparison link has expired.")
        prompt = active_db.query(Prompt).filter_by(id=record.prompt_id).first()
        base = active_db.query(PromptVersion).filter_by(prompt_id=record.prompt_id, version_number=record.base_version).first()
        target = active_db.query(PromptVersion).filter_by(prompt_id=record.prompt_id, version_number=record.target_version).first()
        group = active_db.query(Group).filter_by(id=prompt.group_id).first() if prompt else None
        if not prompt or not base or not target:
            raise HTTPException(status_code=404, detail="The comparison versions are unavailable.")
        return {"share_id": record.id, "prompt": {"id": prompt.id, "title": prompt.title, "group_id": prompt.group_id,
                 "group_name": group_display_name(group) if group else ""}, "base_version": _version_read(active_db, base),
                "target_version": _version_read(active_db, target), "diff_granularity": record.diff_granularity,
                "view_mode": record.view_mode,
                "expires_at": (record.expires_at.isoformat() + "Z") if record.expires_at else None}
    finally:
        if alt_db_to_close is not None:
            alt_db_to_close.close()


@app.post("/api/feedback", status_code=201)
def submit_feedback(
    payload: FeedbackCreateRequest,
    request: Request,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    """Submit user feedback, a complaint, a bug report, or a contact message and automatically create a GitHub Issue."""
    client_ip = get_client_ip(request)
    rate_limiter.check(
        f"feedback_ip:{client_ip}",
        limit=10,
        window_seconds=300,
        detail="Too many feedback submissions from this IP. Please wait a few minutes.",
    )

    # Resolve optional authenticated user without failing if submitted from login page
    auth_user: User | None = None
    try:
        auth_user = current_user(
            request=request,
            authorization=authorization,
            session_cookie=request.cookies.get(SESSION_COOKIE_NAME),
            db=db,
        )
    except HTTPException:
        auth_user = None

    contact_name = (payload.contact_name or (auth_user.name if auth_user else "Anonymous User")).strip()[:120]
    contact_email = (payload.contact_email or (auth_user.email if auth_user else "")).strip()[:254]

    submission = FeedbackSubmission(
        user_id=auth_user.id if auth_user else None,
        category=payload.category,
        subject=payload.subject,
        message=payload.message,
        reporter_name=contact_name,
        reporter_email=contact_email,
        page_url=(payload.page_url or "")[:500],
        status="OPEN",
    )
    db.add(submission)
    db.flush()

    gh_issue = create_github_issue_for_feedback(
        category=payload.category,
        subject=payload.subject,
        message=payload.message,
        contact_name=contact_name,
        contact_email=contact_email,
        page_url=payload.page_url,
        submission_id=submission.id,
    )
    if gh_issue.get("created"):
        submission.github_issue_number = gh_issue.get("issue_number")
        submission.github_issue_url = gh_issue.get("issue_url")
        submission.status = "GITHUB_SYNCED"

    db.commit()
    db.refresh(submission)
    record_audit_log(
        db,
        "FEEDBACK_SUBMITTED",
        user_id=auth_user.id if auth_user else None,
        ip_address=client_ip,
        target_type="feedback",
        target_id=submission.id,
        details=f"[{payload.category}] {payload.subject[:80]} (gh_issue={submission.github_issue_number})",
    )
    return {
        "id": submission.id,
        "category": submission.category,
        "subject": submission.subject,
        "status": submission.status,
        "github_issue_created": bool(gh_issue.get("created")),
        "github_issue_number": submission.github_issue_number,
        "github_issue_url": submission.github_issue_url,
        "created_at": submission.created_at.isoformat() + "Z",
        "message": (
            f"Thank you! Your {payload.category.lower().replace('_', ' ')} has been logged as Issue #{submission.github_issue_number}."
            if submission.github_issue_number
            else "Thank you! Your feedback has been saved and queued for our team."
        ),
    }


@app.get("/api/feedback")
def list_feedback_submissions(
    limit: int = 100,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> list[dict]:
    """List user complaints, bug reports, and contact submissions (Workspace Admins only)."""
    _require_web_session(user)
    require_workspace_admin(user)
    safe_limit = max(1, min(limit, 500))
    items = db.query(FeedbackSubmission).order_by(FeedbackSubmission.created_at.desc()).limit(safe_limit).all()
    return [
        {
            "id": item.id,
            "user_id": item.user_id,
            "category": item.category,
            "subject": item.subject,
            "message": item.message,
            "contact_name": item.reporter_name,
            "contact_email": item.reporter_email,
            "page_url": item.page_url,
            "github_issue_number": item.github_issue_number,
            "github_issue_url": item.github_issue_url,
            "status": item.status,
            "created_at": item.created_at.isoformat() + "Z",
        }
        for item in items
    ]


@app.get("/api/audit-logs")
def list_audit_logs(limit: int = 100, db: Session = Depends(get_db), user: User = Depends(current_user)) -> list[dict]:
    """Return recent security audit log entries (Workspace Admins only)."""
    _require_web_session(user)
    require_workspace_admin(user)
    safe_limit = max(1, min(limit, 500))
    logs = db.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(safe_limit).all()
    return [
        {
            "id": entry.id,
            "user_id": entry.user_id,
            "action": entry.action,
            "ip_address": entry.ip_address,
            "target_type": entry.target_type,
            "target_id": entry.target_id,
            "details": entry.details,
            "created_at": entry.created_at.isoformat() + "Z",
        }
        for entry in logs
    ]


@app.get("/share/diff/{share_id}")
def share_fallback(share_id: str):
    """Help direct API-server share links open the SPA when a dist build exists."""
    if not (FRONTEND_DIST / "index.html").exists():
        raise HTTPException(status_code=404, detail="Build the frontend to open shared links directly.")
    from fastapi.responses import FileResponse
    return FileResponse(FRONTEND_DIST / "index.html")


app.mount("/sse", mcp_sse_asgi, name="sse")
app.mount("/mcp", mcp_asgi, name="mcp")
if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
