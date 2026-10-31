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
from schemas import (FirebaseAuthRequest, ForgotPasswordRequest, LoginRequest,
                     RegisterRequest, ResetPasswordRequest, TokenRequest)
from security import (IS_PRODUCTION, get_client_ip, rate_limiter, record_audit_log)
from plans import TERMS_VERSION
from services.account_tokens import (find_user_by_reset_token, find_user_by_verify_token, issue_reset_token,
                                     issue_verify_token, mark_email_verified)
from services.email import link_base_url, send_password_reset_email, send_verification_email
from services.credential_policy import BREACHED_PASSWORD_MESSAGE, is_password_breached

from deps import (SESSION_COOKIE_NAME, _bearer_token, _clear_session_cookie, current_user, _get_public_base_url,
                  _require_web_session, _auth_response)

router = APIRouter()


@router.post("/api/auth/register", status_code=201)
def register(payload: RegisterRequest, request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    client_ip = get_client_ip(request)
    rate_limiter.check(f"register_ip:{client_ip}", limit=5, window_seconds=60,
                       detail="Too many registration attempts from this IP. Please wait a minute.")
    email = payload.email.strip().lower()
    if is_password_breached(payload.password):
        raise HTTPException(status_code=400, detail=BREACHED_PASSWORD_MESSAGE)

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
        now = datetime.utcnow()
        user = User(name=payload.name.strip(), email=email, is_workspace_admin=is_admin,
                    password_hash=hash_password(payload.password), plan=plan,
                    terms_accepted_at=now, terms_version=TERMS_VERSION,
                    marketing_opt_in=payload.marketing_opt_in,
                    marketing_opt_in_at=now if payload.marketing_opt_in else None)
        raw_verify = issue_verify_token(user)
        target_db.add(user)
        target_db.commit()
        ensure_personal_group(target_db, user)
        record_audit_log(target_db, "AUTH_REGISTER", user_id=user.id, ip_address=client_ip,
                         details=f"Registered {email} (terms {TERMS_VERSION}, marketing={payload.marketing_opt_in})")
        _send_verification(request, user, raw_verify)
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
            # Terms are accepted on the SSO button's consent notice; Google/GitHub already proved the email.
            now = datetime.utcnow()
            user = User(name=verified["name"][:160], email=email, is_workspace_admin=is_admin, password_hash=None, plan="community",
                        email_verified_at=now, terms_accepted_at=now, terms_version=TERMS_VERSION)
            target_db.add(user)
            target_db.commit()
            ensure_personal_group(target_db, user)
            record_audit_log(target_db, "AUTH_FIREBASE_SSO_REGISTER", user_id=user.id, ip_address=client_ip, details=f"SSO register {email}")
        else:
            if user.email_verified_at is None:
                # The provider proved this person owns the email. A password set by whoever registered the
                # address without verifying it must stop working, or a squatter keeps access.
                user.password_hash = None
                mark_email_verified(user)
                target_db.commit()
                delete_all_user_sessions(target_db, user.id)
                record_audit_log(target_db, "AUTH_EMAIL_CLAIMED_SSO", user_id=user.id, ip_address=client_ip,
                                 details=f"Unverified account {email} claimed via SSO; password and sessions cleared")
            record_audit_log(target_db, "AUTH_FIREBASE_SSO", user_id=user.id, ip_address=client_ip, details=f"SSO login {email}")
        return _auth_response(target_db, user, response)
    finally:
        if close_target:
            target_db.close()


def _send_verification(request: Request, user: User, raw_token: str) -> None:
    try:
        base = link_base_url(_get_public_base_url(request))
    except RuntimeError:
        return
    send_verification_email(user.email, user.name, f"{base}/?verify_token={raw_token}")


def _find_user_any_tier(db: Session, lookup) -> tuple[User | None, Session, bool]:
    """Run ``lookup(session)`` against the request DB in tests, otherwise Supabase then Neon.

    Returns (user, session, should_close). The caller closes the session when asked to.
    """
    if is_test_session(db):
        return lookup(db), db, False
    for factory in (SessionSupabase, SessionNeon):
        try:
            session = factory()
        except Exception:
            continue
        try:
            found = lookup(session)
        except Exception:
            session.close()
            continue
        if found is not None:
            return found, session, True
        session.close()
    return None, db, False


@router.post("/api/auth/verify-email")
def verify_email(payload: TokenRequest, request: Request, db: Session = Depends(get_db)) -> dict:
    client_ip = get_client_ip(request)
    rate_limiter.check(f"verify_ip:{client_ip}", limit=20, window_seconds=60,
                       detail="Too many attempts. Please wait a minute.")
    user, target_db, close = _find_user_any_tier(db, lambda s: find_user_by_verify_token(s, payload.token.strip()))
    try:
        if user is None:
            raise HTTPException(status_code=400, detail="This confirmation link is invalid or has expired. Request a new one from your account.")
        mark_email_verified(user)
        target_db.commit()
        record_audit_log(target_db, "AUTH_EMAIL_VERIFIED", user_id=user.id, ip_address=client_ip, details=f"Verified {user.email}")
        return {"verified": True, "email": user.email}
    finally:
        if close:
            target_db.close()


@router.post("/api/auth/resend-verification")
def resend_verification(request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_web_session(user)
    if user.email_verified_at is not None:
        return {"sent": False, "already_verified": True}
    rate_limiter.check(f"resend_verify:{user.id}", limit=3, window_seconds=600,
                       detail="We've sent a few confirmation emails already. Check your inbox and spam, or try again in 10 minutes.")
    raw = issue_verify_token(user)
    db.commit()
    _send_verification(request, user, raw)
    return {"sent": True}


@router.post("/api/auth/forgot-password")
def forgot_password(payload: ForgotPasswordRequest, request: Request, db: Session = Depends(get_db)) -> dict:
    """Always answers the same way so the endpoint can't be used to discover which emails have accounts."""
    client_ip = get_client_ip(request)
    rate_limiter.check(f"forgot_ip:{client_ip}", limit=5, window_seconds=600,
                       detail="Too many reset requests. Please wait 10 minutes and try again.")
    email = payload.email.strip().lower()
    generic = {"sent": True, "message": "If an account uses that email, we've sent a link to reset the password."}
    try:
        base = link_base_url(_get_public_base_url(request))
    except RuntimeError:
        return generic
    user, target_db, close = _find_user_any_tier(db, lambda s: s.query(User).filter(User.email == email).first())
    try:
        if user is None:
            return generic
        rate_limiter.check(f"forgot_email:{email}", limit=3, window_seconds=3600, detail=generic["message"])
        raw = issue_reset_token(user)
        target_db.commit()
        send_password_reset_email(user.email, user.name, f"{base}/?reset_token={raw}")
        record_audit_log(target_db, "AUTH_PASSWORD_RESET_REQUESTED", user_id=user.id, ip_address=client_ip, details=f"Reset requested for {email}")
        return generic
    except HTTPException:
        return generic
    finally:
        if close:
            target_db.close()


@router.post("/api/auth/reset-password")
def reset_password(payload: ResetPasswordRequest, request: Request, db: Session = Depends(get_db)) -> dict:
    client_ip = get_client_ip(request)
    rate_limiter.check(f"reset_ip:{client_ip}", limit=10, window_seconds=600,
                       detail="Too many attempts. Please wait a few minutes.")
    if is_password_breached(payload.new_password):
        raise HTTPException(status_code=400, detail=BREACHED_PASSWORD_MESSAGE)
    user, target_db, close = _find_user_any_tier(db, lambda s: find_user_by_reset_token(s, payload.token.strip()))
    try:
        if user is None:
            raise HTTPException(status_code=400, detail="This reset link is invalid or has expired. Request a new one.")
        user.password_hash = hash_password(payload.new_password)
        user.reset_token_hash = None
        user.reset_token_expires_at = None
        user.failed_login_attempts = 0
        user.locked_until = None
        # Following the emailed link proves ownership of the address.
        mark_email_verified(user)
        target_db.commit()
        delete_all_user_sessions(target_db, user.id)
        record_audit_log(target_db, "AUTH_PASSWORD_RESET", user_id=user.id, ip_address=client_ip,
                         details=f"Password reset for {user.email}; all sessions signed out")
        return {"reset": True}
    finally:
        if close:
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

