"""Password hashing, login sessions and lightweight schema upgrades for PromptVault accounts."""

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from models import ApiKey, AuthSession, Group, PromptChunk, User

PBKDF2_ITERATIONS = 100_000
SESSION_LIFETIME = timedelta(days=14)
DEMO_PASSWORD = "demo1234"
DEMO_EMAILS = (
    "alice@example.com",
    "evan@example.com",
    "bob@example.com",
    "diana@example.com",
    "charlie@example.com",
    "fiona@example.com",
    "george@example.com",
    "hannah@example.com",
    "ian@example.com",
    "julia@example.com",
    "kevin@example.com",
    "laura@example.com",
    "mike@example.com",
)


try:
    from argon2 import PasswordHasher
    from argon2.exceptions import InvalidHashError, VerifyMismatchError
    _argon2_hasher: PasswordHasher | None = PasswordHasher(
        time_cost=3,
        memory_cost=65536,
        parallelism=4,
        hash_len=32,
        salt_len=16,
    )
except ImportError:  # pragma: no cover
    _argon2_hasher = None


def hash_password(password: str, force_pbkdf2: bool = False) -> str:
    """Return an OWASP-recommended Argon2id hash, falling back to PBKDF2-SHA256 if requested or if argon2-cffi is absent."""
    if _argon2_hasher is not None and not force_pbkdf2:
        return _argon2_hasher.hash(password)
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt}${digest.hex()}"


DUMMY_PASSWORD_HASH = hash_password("pv_constant_time_dummy_secret_key_0123456789")


def is_hash_upgrade_needed(stored_hash: str | None) -> bool:
    """Check if a stored password hash should be transparently migrated to Argon2id upon successful sign-in."""
    if not stored_hash:
        return False
    if not stored_hash.startswith("$argon2"):
        return _argon2_hasher is not None
    if _argon2_hasher is not None:
        try:
            return _argon2_hasher.check_needs_rehash(stored_hash)
        except Exception:
            return False
    return False


def verify_password(password: str, stored_hash: str | None) -> bool:
    """Verify password against either Argon2id or legacy PBKDF2-SHA256 hashes in constant time."""
    if not stored_hash:
        return False
    if stored_hash.startswith("$argon2"):
        if _argon2_hasher is None:
            return False
        try:
            return _argon2_hasher.verify(stored_hash, password)
        except (VerifyMismatchError, InvalidHashError, Exception):
            return False

    try:
        algorithm, iterations, salt, expected = stored_hash.split("$")
    except ValueError:
        return False
    if algorithm != "pbkdf2_sha256":
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), int(iterations))
    return hmac.compare_digest(digest.hex(), expected)


def generate_api_key() -> str:
    return f"pv_live_{secrets.token_urlsafe(24)}"


def hash_api_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def hash_session_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def mask_api_key(raw_key: str) -> str:
    if len(raw_key) <= 14:
        return f"{raw_key[:4]}••••••••"
    return f"{raw_key[:11]}••••••••{raw_key[-4:]}"


def create_api_key_record(
    db: Session,
    user: User,
    name: str,
    description: str = "",
    scope_type: str = "GLOBAL",
    group_id: str | None = None,
    access_level: str = "READ_WRITE",
) -> tuple[ApiKey, str]:
    """Generate a new API key, persist its hash + metadata, and return (record, one_time_raw_key)."""
    raw_key = generate_api_key()
    normalized_access = "READ_ONLY" if access_level == "READ_ONLY" else "READ_WRITE"
    record = ApiKey(
        user_id=user.id,
        name=name.strip() or "Personal API Key",
        description=description.strip(),
        key_prefix=mask_api_key(raw_key),
        key_hash=hash_api_key(raw_key),
        scope_type=scope_type,
        access_level=normalized_access,
        group_id=group_id if scope_type == "GROUP" else None,
        is_active=True,
    )
    db.add(record)
    user.api_key = None
    db.commit()
    db.refresh(record)
    try:
        from database import cache_token_plan
        cache_token_plan(raw_key, getattr(user, "plan", "community") or "community")
    except Exception:
        pass
    return record, raw_key


def resolve_api_key(db: Session, token: str) -> tuple[User, ApiKey | None] | None:
    """Authenticate an API key token and return (user, api_key_record)."""
    hashed = hash_api_key(token)
    record = db.query(ApiKey).filter_by(key_hash=hashed, is_active=True).first()
    if record is not None:
        user = db.query(User).filter_by(id=record.user_id).first()
        if user is None:
            return None
        record.last_used_at = datetime.utcnow()
        db.commit()
        try:
            from database import cache_token_plan
            cache_token_plan(token, getattr(user, "plan", "community") or "community")
        except Exception:
            pass
        return user, record
    return None


def create_session(db: Session, user: User) -> str:
    raw_token = secrets.token_urlsafe(32)
    token_hash = hash_session_token(raw_token)
    db.add(AuthSession(token=token_hash, user_id=user.id, expires_at=datetime.utcnow() + SESSION_LIFETIME))
    db.commit()
    try:
        from database import cache_token_plan
        cache_token_plan(raw_token, getattr(user, "plan", "community") or "community")
    except Exception:
        pass
    return raw_token


def user_for_session_token(db: Session, token: str) -> User | None:
    token_hash = hash_session_token(token)
    session = db.query(AuthSession).filter_by(token=token_hash).first()
    if session is None:
        # Seamless one-time upgrade for any legacy unhashed session token
        legacy = db.query(AuthSession).filter_by(token=token).first()
        if legacy is None:
            return None
        if legacy.expires_at < datetime.utcnow():
            db.delete(legacy)
            db.commit()
            return None
        user_id = legacy.user_id
        expires_at = legacy.expires_at
        db.delete(legacy)
        db.flush()
        session = AuthSession(token=token_hash, user_id=user_id, expires_at=expires_at)
        db.add(session)
        db.commit()
    if session.expires_at < datetime.utcnow():
        db.delete(session)
        db.commit()
        return None
    user = db.query(User).filter_by(id=session.user_id).first()
    if user is not None:
        try:
            from database import cache_token_plan
            cache_token_plan(token, getattr(user, "plan", "community") or "community")
        except Exception:
            pass
    return user


def delete_session(db: Session, token: str) -> None:
    token_hash = hash_session_token(token)
    db.query(AuthSession).filter(AuthSession.token.in_([token_hash, token])).delete(synchronize_session=False)
    db.commit()
    try:
        from database import invalidate_token_plan
        invalidate_token_plan(token)
    except Exception:
        pass


def delete_all_user_sessions(db: Session, user_id: str) -> int:
    count = db.query(AuthSession).filter_by(user_id=user_id).delete(synchronize_session=False)
    db.commit()
    return count


def upgrade_schema(engine: Engine) -> None:
    """Add columns introduced after the original schema to existing databases."""
    inspector = inspect(engine)
    is_postgres = engine.dialect.name == "postgresql"
    bool_false = "FALSE" if is_postgres else "0"
    ts_type = "TIMESTAMP" if is_postgres else "DATETIME"
    user_columns = {column["name"] for column in inspector.get_columns("users")}
    group_columns = {column["name"] for column in inspector.get_columns("groups")}
    api_key_columns = {column["name"] for column in inspector.get_columns("api_keys")}
    diff_share_columns = {column["name"] for column in inspector.get_columns("shared_diff_links")}
    prompt_columns = {column["name"] for column in inspector.get_columns("prompts")}
    with engine.begin() as connection:
        if "password_hash" not in user_columns:
            connection.execute(text("ALTER TABLE users ADD COLUMN password_hash VARCHAR(255)"))
        if "onboarding_completed" not in user_columns:
            connection.execute(text(f"ALTER TABLE users ADD COLUMN onboarding_completed BOOLEAN NOT NULL DEFAULT {bool_false}"))
        if "plan" not in user_columns:
            connection.execute(text("ALTER TABLE users ADD COLUMN plan VARCHAR(32) NOT NULL DEFAULT 'community'"))
        if "polar_customer_id" not in user_columns:
            connection.execute(text("ALTER TABLE users ADD COLUMN polar_customer_id VARCHAR(100)"))
        if "polar_subscription_id" not in user_columns:
            connection.execute(text("ALTER TABLE users ADD COLUMN polar_subscription_id VARCHAR(100)"))
        if "failed_login_attempts" not in user_columns:
            connection.execute(text("ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0"))
        if "locked_until" not in user_columns:
            connection.execute(text(f"ALTER TABLE users ADD COLUMN locked_until {ts_type}"))
        if "last_login_at" not in user_columns:
            connection.execute(text(f"ALTER TABLE users ADD COLUMN last_login_at {ts_type}"))
        if "personal_owner_id" not in group_columns:
            connection.execute(text("ALTER TABLE groups ADD COLUMN personal_owner_id VARCHAR(36) REFERENCES users(id)"))
        if "required_approvals" not in group_columns:
            connection.execute(text("ALTER TABLE groups ADD COLUMN required_approvals INTEGER DEFAULT 1"))
        if "access_level" not in api_key_columns:
            connection.execute(text("ALTER TABLE api_keys ADD COLUMN access_level VARCHAR(32) NOT NULL DEFAULT 'READ_WRITE'"))
        if "expires_at" not in diff_share_columns:
            connection.execute(text(f"ALTER TABLE shared_diff_links ADD COLUMN expires_at {ts_type}"))
        if "is_revoked" not in diff_share_columns:
            connection.execute(text(f"ALTER TABLE shared_diff_links ADD COLUMN is_revoked BOOLEAN NOT NULL DEFAULT {bool_false}"))
        if "current_version_id" not in prompt_columns:
            connection.execute(text("ALTER TABLE prompts ADD COLUMN current_version_id VARCHAR(36)"))
        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_prompt_version_lookup ON prompt_versions (prompt_id, version_number)"))
        # Backfill current_version_id UUID pointer for any prompt where it is NULL
        connection.execute(text("""
            UPDATE prompts
            SET current_version_id = (
                SELECT pv.id FROM prompt_versions pv
                WHERE pv.prompt_id = prompts.id AND pv.version_number = prompts.current_version_number
                LIMIT 1
            )
            WHERE current_version_id IS NULL
        """))
        # Ensure prompt_chunks table exists for hybrid search
        PromptChunk.__table__.create(bind=connection, checkfirst=True)
        if is_postgres:
            try:
                connection.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
            except Exception:
                pass
            try:
                connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            except Exception:
                pass


def verify_firebase_id_token(id_token: str) -> dict[str, str] | None:
    """Verify a Firebase Auth ID token using Firebase's official REST lookup endpoint or Google tokeninfo."""
    import json
    import os
    import urllib.parse
    import urllib.request

    if not id_token.strip():
        return None

    api_key = os.getenv("FIREBASE_WEB_API_KEY", "").strip()
    if api_key:
        url = f"https://identitytoolkit.googleapis.com/v1/accounts:lookup?key={api_key}"
        payload = json.dumps({"idToken": id_token.strip()}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=5.0) as resp:  # nosec B310
                data = json.loads(resp.read().decode("utf-8"))
                users = data.get("users") or []
                if users:
                    account = users[0]
                    email = (account.get("email") or "").strip().lower()
                    if email and account.get("emailVerified", True):
                        name = (account.get("displayName") or email.split("@")[0]).strip()
                        return {"email": email, "name": name}
        except Exception:
            pass

    # Universal Google OAuth / Firebase ID token verification
    url = f"https://oauth2.googleapis.com/tokeninfo?id_token={urllib.parse.quote(id_token.strip())}"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=5.0) as resp:  # nosec B310
            data = json.loads(resp.read().decode("utf-8"))
            email = (data.get("email") or "").strip().lower()
            if email and (data.get("email_verified") in (True, "true")):
                name = (data.get("name") or email.split("@")[0]).strip()
                return {"email": email, "name": name}
    except Exception:
        pass

    return None


def ensure_demo_passwords(db: Session) -> None:
    """Give the seeded demo accounts a known password and ensure no legacy default keys exist."""
    changed = False
    # Revoked API key history is not retained
    if db.query(ApiKey).filter_by(is_active=False).count() > 0:
        db.query(ApiKey).filter_by(is_active=False).delete()
        changed = True
    for user in db.query(User).filter(User.email.in_(DEMO_EMAILS), User.password_hash.is_(None)).all():
        user.password_hash = hash_password(DEMO_PASSWORD)
        changed = True
    # Do not keep auto-generated "Default Global Key"; users create their own keys from the beginning.
    default_keys = db.query(ApiKey).filter_by(name="Default Global Key").all()
    if default_keys:
        for key in default_keys:
            db.delete(key)
        changed = True
    for user in db.query(User).filter(User.api_key.isnot(None)).all():
        user.api_key = None
        changed = True
    if changed:
        db.commit()


