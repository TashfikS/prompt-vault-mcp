"""auth routes API routes."""

import os
from datetime import datetime, timedelta


from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Request, Response
from sqlalchemy.orm import Session

from database import (
    PAID_PLANS,
    SessionNeon,
    SessionSupabase,
    get_db,
    get_sessionmaker_for_plan,
    is_test_session,
)
from auth import (DUMMY_PASSWORD_HASH, delete_all_user_sessions, delete_session, hash_password, is_hash_upgrade_needed,
                  verify_firebase_id_token, verify_password)
from permissions import (ensure_personal_group)
from models import (User)
from schemas import (FirebaseAuthRequest, LoginRequest,
                     RegisterRequest)
from security import (IS_PRODUCTION, get_client_ip, rate_limiter, record_audit_log)

from deps import (SESSION_COOKIE_NAME, _bearer_token, _clear_session_cookie, current_user, _require_web_session, _auth_response)

router = APIRouter()


@router.post("/api/auth/register", status_code=201)
def register(payload: RegisterRequest, request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    client_ip = get_client_ip(request)
    rate_limiter.check(f"register_ip:{client_ip}", limit=5, window_seconds=60,
                       detail="Too many registration attempts from this IP. Please wait a minute.")
    email = payload.email.strip().lower()

    is_test_env = is_test_session(db)
    # New accounts always start on Community; paid plans are only granted by verified Polar webhooks.
    plan = "community"

    if is_test_env:
        target_db = db
        close_target = False
    else:
        target_db = get_sessionmaker_for_plan(plan)()
        close_target = True

    try:
        if target_db.query(User).filter(User.email == email).first():
            raise HTTPException(status_code=409, detail="An account with this email already exists. Try signing in.")
        if not is_test_env:
            exists_elsewhere = False
            try:
                with SessionNeon() as alt_db:
                    exists_elsewhere = alt_db.query(User.id).filter(User.email == email).first() is not None
            except Exception:
                pass
            if exists_elsewhere:
                raise HTTPException(status_code=409, detail="An account with this email already exists. Try signing in.")

        # Password sign-up never proves email ownership, so it cannot claim INITIAL_ADMIN_EMAIL in production
        # (that is granted via verified Firebase SSO instead). Locally the first account becomes admin.
        initial_admin_email = os.getenv("INITIAL_ADMIN_EMAIL", "").strip().lower()
        if IS_PRODUCTION:
            is_admin = False
        elif initial_admin_email:
            is_admin = email == initial_admin_email
        else:
            is_admin = target_db.query(User).count() == 0
        user = User(name=payload.name.strip(), email=email, is_workspace_admin=is_admin,
                    password_hash=hash_password(payload.password), plan=plan)
        target_db.add(user)
        target_db.commit()
        ensure_personal_group(target_db, user)
        record_audit_log(target_db, "AUTH_REGISTER", user_id=user.id, ip_address=client_ip, details=f"Registered {email}")
        return _auth_response(target_db, user, response)
    finally:
        if close_target:
            target_db.close()


@router.post("/api/auth/login")
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


@router.post("/api/auth/firebase")
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


@router.post("/api/auth/logout")
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


@router.delete("/api/auth/sessions")
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

