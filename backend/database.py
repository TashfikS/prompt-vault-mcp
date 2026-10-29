"""Multi-Tier SQLAlchemy database routing for PromptHold.

Architecture:
- Free / Community Tier: Stored in Supabase PostgreSQL (or local SQLite fallback when credentials pending).
- Paid Tiers (Pro, Team, Enterprise): Stored in Neon Serverless PostgreSQL.
"""

from __future__ import annotations

import hashlib
import logging
import os
from collections.abc import Generator
from pathlib import Path
from typing import Any

from dotenv import find_dotenv, load_dotenv
from fastapi import Request
from sqlalchemy import create_engine, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

logger = logging.getLogger("prompthold.database")

# Ensure .env from root directory is loaded
root_env = Path(__file__).resolve().parent.parent / ".env"
if root_env.exists():
    load_dotenv(root_env)
load_dotenv(find_dotenv(usecwd=True))


def normalize_db_url(raw_url: str | None) -> str:
    """Normalize PostgreSQL connection strings for psycopg3."""
    if not raw_url:
        return ""
    url = raw_url.strip().strip("'\"")
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+psycopg://", 1)
    if url.startswith("postgresql://") and "+psycopg" not in url and "+psycopg2" not in url:
        try:
            import psycopg  # noqa: F401
            return url.replace("postgresql://", "postgresql+psycopg://", 1)
        except ImportError:
            return url
    return url


def is_supabase_configured() -> bool:
    """Return True if a valid live Supabase database URL is provided."""
    raw = (os.getenv("SUPABASE_DATABASE_URL") or os.getenv("SUPABASE_DB_URL") or "").strip().strip("'\"")
    if not raw:
        return False
    # Check if still an unedited example placeholder
    placeholders = ["[YOUR-PASSWORD]", "[PASSWORD]", "[PROJECT-REF]", "[YOUR-PROJECT-REF]", "example.com"]
    return not any(p in raw for p in placeholders)


# -----------------------------------------------------------------------------
# 1. Database URLs & Engines Setup
# -----------------------------------------------------------------------------

_default_sqlite = "sqlite:///./prompt_vault.db" if os.path.exists("./prompt_vault.db") else "sqlite:///./prompthold.db"

# Neon Database URL (Paid tiers: Pro, Team, Enterprise)
_raw_neon_url = os.getenv("NEON_DATABASE_URL") or os.getenv("DATABASE_URL") or _default_sqlite
NEON_DATABASE_URL = normalize_db_url(_raw_neon_url)
DATABASE_URL = NEON_DATABASE_URL

# Supabase Database URL (Free / Community tier)
_raw_supabase_url = (os.getenv("SUPABASE_DATABASE_URL") or os.getenv("SUPABASE_DB_URL") or "").strip()
if is_supabase_configured():
    SUPABASE_DATABASE_URL = normalize_db_url(_raw_supabase_url)
    logger.info("Supabase database configured for Free/Community tier.")
else:
    # Safe local fallback until user inputs Supabase credentials in .env
    SUPABASE_DATABASE_URL = "sqlite:///./prompthold_community.db"
    logger.warning(
        "[PromptHold DB Router] SUPABASE_DATABASE_URL is not set yet in .env. "
        "Free/Community tier data will use local SQLite (prompthold_community.db) until Supabase credentials are provided."
    )

neon_connect_args: dict[str, Any] = (
    {"check_same_thread": False}
    if NEON_DATABASE_URL.startswith("sqlite")
    else {"prepare_threshold": None}
)
supabase_connect_args: dict[str, Any] = (
    {"check_same_thread": False}
    if SUPABASE_DATABASE_URL.startswith("sqlite")
    else {"prepare_threshold": None}
)

engine_neon = create_engine(
    NEON_DATABASE_URL,
    connect_args=neon_connect_args,
    pool_pre_ping=True,
    pool_recycle=300 if not NEON_DATABASE_URL.startswith("sqlite") else -1,
)

engine_supabase = create_engine(
    SUPABASE_DATABASE_URL,
    connect_args=supabase_connect_args,
    pool_pre_ping=True,
    pool_recycle=300 if not SUPABASE_DATABASE_URL.startswith("sqlite") else -1,
)

# Primary default engine and sessionmaker (for backward compatibility)
engine = engine_neon
SessionNeon = sessionmaker(bind=engine_neon, autoflush=False, autocommit=False)
SessionSupabase = sessionmaker(bind=engine_supabase, autoflush=False, autocommit=False)
SessionLocal = SessionNeon


class Base(DeclarativeBase):
    """Base class for mapped models."""


# -----------------------------------------------------------------------------
# 2. Plan / Tier Classification Helpers
# -----------------------------------------------------------------------------

COMMUNITY_PLAN = "community"
PAID_PLANS = {"pro", "team", "enterprise"}


def is_community_plan(plan: str | None) -> bool:
    """Check if the given subscription plan belongs to the free/community tier."""
    if not plan:
        return True
    return plan.strip().lower() == COMMUNITY_PLAN


def get_engine_for_plan(plan: str | None) -> Engine:
    """Return engine_supabase for community plan, engine_neon for paid plans."""
    return engine_supabase if is_community_plan(plan) else engine_neon


def get_sessionmaker_for_plan(plan: str | None) -> sessionmaker[Session]:
    """Return SessionSupabase for community plan, SessionNeon for paid plans."""
    return SessionSupabase if is_community_plan(plan) else SessionNeon


def get_db_for_plan(plan: str | None) -> Session:
    """Instantiate and return a new session targeting the correct database tier."""
    return get_sessionmaker_for_plan(plan)()


def get_db_bind_url(db: Session) -> str:
    """Safely inspect session bind URL whether bind is an Engine or Connection."""
    bind = db.get_bind()
    url = getattr(bind, "url", None)
    if url is None and hasattr(bind, "engine"):
        url = getattr(bind.engine, "url", None)
    return str(url) if url else ""


def is_test_session(db: Session) -> bool:
    """Return True if session is running inside test fixture (in-memory SQLite)."""
    url = get_db_bind_url(db)
    return url.startswith("sqlite:///:memory:") or url == ""


# -----------------------------------------------------------------------------
# 3. In-Memory Token-to-Tier Routing Cache
# -----------------------------------------------------------------------------

_token_plan_cache: dict[str, str] = {}


def cache_token_plan(token: str, plan: str) -> None:
    """Associate a session token or API key with its database plan in cache."""
    if not token:
        return
    clean_token = token.strip()
    clean_plan = plan.strip().lower()
    _token_plan_cache[clean_token] = clean_plan
    token_h = hashlib.sha256(clean_token.encode("utf-8")).hexdigest()
    _token_plan_cache[token_h] = clean_plan


def get_cached_token_plan(token: str) -> str | None:
    """Retrieve the cached plan for a raw or hashed token."""
    if not token:
        return None
    clean_token = token.strip()
    if clean_token in _token_plan_cache:
        return _token_plan_cache[clean_token]
    token_h = hashlib.sha256(clean_token.encode("utf-8")).hexdigest()
    return _token_plan_cache.get(token_h)


def invalidate_token_plan(token: str) -> None:
    """Remove a token from the tier routing cache."""
    if not token:
        return
    clean_token = token.strip()
    _token_plan_cache.pop(clean_token, None)
    token_h = hashlib.sha256(clean_token.encode("utf-8")).hexdigest()
    _token_plan_cache.pop(token_h, None)


def resolve_token_plan(token: str) -> str:
    """Determine whether an authentication token belongs to Supabase (community) or Neon (paid)."""
    if not token:
        return COMMUNITY_PLAN

    cached = get_cached_token_plan(token)
    if cached is not None:
        return cached

    clean_token = token.strip()
    token_h = hashlib.sha256(clean_token.encode("utf-8")).hexdigest()

    # Local import to prevent circular dependency
    from models import ApiKey, AuthSession, User

    # 1. Probe Supabase (Free/Community tier)
    try:
        with SessionSupabase() as s_db:
            sess = s_db.query(AuthSession).filter(AuthSession.token.in_([token_h, clean_token])).first()
            if sess is not None:
                user = s_db.query(User).filter_by(id=sess.user_id).first()
                plan = getattr(user, "plan", COMMUNITY_PLAN) or COMMUNITY_PLAN
                cache_token_plan(token, plan)
                return plan

            key = s_db.query(ApiKey).filter_by(key_hash=token_h, is_active=True).first()
            if key is not None:
                user = s_db.query(User).filter_by(id=key.user_id).first()
                plan = getattr(user, "plan", COMMUNITY_PLAN) or COMMUNITY_PLAN
                cache_token_plan(token, plan)
                return plan
    except Exception:
        pass

    # 2. Probe Neon (Paid tiers: Pro, Team, Enterprise)
    try:
        with SessionNeon() as n_db:
            sess = n_db.query(AuthSession).filter(AuthSession.token.in_([token_h, clean_token])).first()
            if sess is not None:
                user = n_db.query(User).filter_by(id=sess.user_id).first()
                plan = getattr(user, "plan", "team") or "team"
                cache_token_plan(token, plan)
                return plan

            key = n_db.query(ApiKey).filter_by(key_hash=token_h, is_active=True).first()
            if key is not None:
                user = n_db.query(User).filter_by(id=key.user_id).first()
                plan = getattr(user, "plan", "team") or "team"
                cache_token_plan(token, plan)
                return plan
    except Exception:
        pass

    return COMMUNITY_PLAN


# -----------------------------------------------------------------------------
# 4. Seamless Data Migration Across Database Tiers (Plan Upgrade/Downgrade)
# -----------------------------------------------------------------------------

def migrate_user_tier(user_id: str, from_plan: str, to_plan: str) -> None:
    """Migrate a user and their prompts, versions, API keys, and sessions between Supabase and Neon."""
    from_community = is_community_plan(from_plan)
    to_community = is_community_plan(to_plan)
    if from_community == to_community:
        # Both are in the same database tier (e.g. Pro -> Team in Neon)
        return

    from models import (
        ApiKey,
        AuthSession,
        Group,
        GroupMembership,
        Prompt,
        PromptProposal,
        PromptVersion,
        ProposalApproval,
        User,
    )

    src_factory = get_sessionmaker_for_plan(from_plan)
    dst_factory = get_sessionmaker_for_plan(to_plan)

    with src_factory() as src_db, dst_factory() as dst_db:
        src_user = src_db.query(User).filter_by(id=user_id).first()
        if not src_user:
            return

        # 1. Migrate or update User record in destination
        dst_user = dst_db.query(User).filter_by(id=user_id).first()
        if not dst_user:
            dst_user = User(
                id=src_user.id,
                name=src_user.name,
                email=src_user.email,
                is_workspace_admin=src_user.is_workspace_admin,
                api_key=src_user.api_key,
                password_hash=src_user.password_hash,
                onboarding_completed=src_user.onboarding_completed,
                plan=to_plan,
                failed_login_attempts=getattr(src_user, "failed_login_attempts", 0) or 0,
                locked_until=getattr(src_user, "locked_until", None),
                last_login_at=getattr(src_user, "last_login_at", None),
                created_at=src_user.created_at,
            )
            dst_db.add(dst_user)
        else:
            dst_user.plan = to_plan
            dst_user.name = src_user.name
            dst_user.password_hash = src_user.password_hash
            dst_user.failed_login_attempts = getattr(src_user, "failed_login_attempts", 0) or 0
            dst_user.locked_until = getattr(src_user, "locked_until", None)
            dst_user.last_login_at = getattr(src_user, "last_login_at", None)
        dst_db.flush()

        # 2. Migrate User's Groups (Personal space & created groups)
        user_groups = src_db.query(Group).filter(
            (Group.personal_owner_id == user_id) | (Group.created_by == user_id)
        ).all()
        for g in user_groups:
            existing_g = dst_db.query(Group).filter_by(id=g.id).first()
            if not existing_g:
                dst_g = Group(
                    id=g.id,
                    name=g.name,
                    description=g.description,
                    created_by=g.created_by,
                    created_at=g.created_at,
                    personal_owner_id=g.personal_owner_id,
                    required_approvals=g.required_approvals,
                )
                dst_db.add(dst_g)
        dst_db.flush()

        # 3. Migrate Group Memberships
        memberships = src_db.query(GroupMembership).filter_by(user_id=user_id).all()
        for m in memberships:
            if not dst_db.query(Group).filter_by(id=m.group_id).first():
                continue
            existing_m = dst_db.query(GroupMembership).filter_by(id=m.id).first()
            if not existing_m:
                dst_m = GroupMembership(
                    id=m.id,
                    user_id=m.user_id,
                    group_id=m.group_id,
                    role=m.role,
                    added_at=m.added_at,
                )
                dst_db.add(dst_m)
        dst_db.flush()

        # 4. Migrate Prompts & Prompt Versions
        user_prompts = src_db.query(Prompt).filter_by(created_by=user_id).all()
        for p in user_prompts:
            if not dst_db.query(Group).filter_by(id=p.group_id).first():
                continue
            existing_p = dst_db.query(Prompt).filter_by(id=p.id).first()
            if not existing_p:
                dst_p = Prompt(
                    id=p.id,
                    group_id=p.group_id,
                    title=p.title,
                    description=p.description,
                    current_version_number=p.current_version_number,
                    current_version_id=p.current_version_id,
                    created_by=p.created_by,
                    updated_at=p.updated_at,
                    is_archived=p.is_archived,
                )
                dst_db.add(dst_p)
                dst_db.flush()

            versions = src_db.query(PromptVersion).filter_by(prompt_id=p.id).all()
            for v in versions:
                existing_v = dst_db.query(PromptVersion).filter_by(id=v.id).first()
                if not existing_v:
                    dst_v = PromptVersion(
                        id=v.id,
                        prompt_id=v.prompt_id,
                        version_number=v.version_number,
                        content=v.content,
                        variables_json=v.variables_json,
                        change_Note=v.change_Note,
                        source_filename=v.source_filename,
                        author_id=v.author_id,
                        created_at=v.created_at,
                    )
                    dst_db.add(dst_v)
            dst_db.flush()

        # 5. Migrate ApiKeys
        keys = src_db.query(ApiKey).filter_by(user_id=user_id).all()
        for k in keys:
            existing_k = dst_db.query(ApiKey).filter_by(id=k.id).first()
            if not existing_k:
                dst_k = ApiKey(
                    id=k.id,
                    user_id=k.user_id,
                    name=k.name,
                    description=k.description,
                    key_prefix=k.key_prefix,
                    key_hash=k.key_hash,
                    scope_type=k.scope_type,
                    access_level=k.access_level,
                    group_id=k.group_id,
                    is_active=k.is_active,
                    last_used_at=k.last_used_at,
                    revoked_at=k.revoked_at,
                    created_at=k.created_at,
                )
                dst_db.add(dst_k)
                cache_token_plan(k.key_hash, to_plan)

        # 6. Migrate AuthSessions
        sessions = src_db.query(AuthSession).filter_by(user_id=user_id).all()
        for s in sessions:
            existing_s = dst_db.query(AuthSession).filter_by(token=s.token).first()
            if not existing_s:
                dst_s = AuthSession(
                    token=s.token,
                    user_id=s.user_id,
                    created_at=s.created_at,
                    expires_at=s.expires_at,
                )
                dst_db.add(dst_s)
            cache_token_plan(s.token, to_plan)

        dst_db.commit()

        # 7. Clean up transferred entities from source database
        try:
            src_db.query(AuthSession).filter_by(user_id=user_id).delete(synchronize_session=False)
            src_db.query(ApiKey).filter_by(user_id=user_id).delete(synchronize_session=False)
            for p in user_prompts:
                src_db.query(PromptVersion).filter_by(prompt_id=p.id).delete(synchronize_session=False)
                src_db.query(Prompt).filter_by(id=p.id).delete(synchronize_session=False)
            src_db.query(GroupMembership).filter_by(user_id=user_id).delete(synchronize_session=False)
            src_db.query(Group).filter_by(personal_owner_id=user_id).delete(synchronize_session=False)
            src_db.query(User).filter_by(id=user_id).delete(synchronize_session=False)
            src_db.commit()
        except Exception as e:
            logger.error("Error cleaning up source database after migration: %s", e)
            src_db.rollback()


# -----------------------------------------------------------------------------
# 5. Dynamic FastAPI Database Dependency
# -----------------------------------------------------------------------------

def get_db(request: Request = None) -> Generator[Session, None, None]:
    """Dynamically route database queries: Supabase for community tier, Neon for paid tiers."""
    plan = None

    if request is not None:
        if hasattr(request.state, "db_plan"):
            plan = request.state.db_plan
        else:
            # Check Authorization header
            auth_header = request.headers.get("authorization", "")
            cookie_token = request.cookies.get("ph_session") or request.cookies.get("pv_session")
            token = None
            if auth_header and auth_header.lower().startswith("bearer "):
                token = auth_header[7:].strip()
            elif cookie_token:
                token = cookie_token.strip()

            if token:
                plan = resolve_token_plan(token)

    session_maker = get_sessionmaker_for_plan(plan)
    db = session_maker()
    try:
        yield db
    finally:
        db.close()
