"""Request dependencies and auth helpers shared by all routers."""

import os
from pathlib import Path


from fastapi import Cookie, Depends, Header, HTTPException, Request, Response
from sqlalchemy.orm import Session

from database import (
    SessionNeon,
    SessionSupabase,
    cache_token_plan,
    engine_neon,
    get_db,
    get_db_bind_url,
    is_test_session,
)
from auth import (SESSION_LIFETIME, create_session,
                  resolve_api_key, user_for_session_token)
from models import (ApiKey, User)
from security import (IS_PRODUCTION, get_allowed_origins,
                      get_client_ip, rate_limiter)


FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
SESSION_COOKIE_NAME = "ph_session"


def _bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    return token.strip() if scheme.lower() == "bearer" and token.strip() else None


def _get_public_base_url(request: Request) -> str:
    forwarded_host = request.headers.get("x-forwarded-host")
    if forwarded_host:
        proto = request.headers.get("x-forwarded-proto") or "https"
        return f"{proto}://{forwarded_host}".rstrip("/")
    env_url = (os.getenv("PUBLIC_BASE_URL") or os.getenv("APP_URL") or "").strip()
    if env_url:
        return env_url.rstrip("/")
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme or "https"
    host = request.headers.get("host") or str(request.url.netloc)
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
        if xrw not in {"PromptFolders", "PromptVault"} and origin not in set(get_allowed_origins()):
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


