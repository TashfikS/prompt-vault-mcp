"""Multi-Tier SQLAlchemy database routing for PromptHold.

Architecture:
- Free / Community Tier: Stored in Supabase PostgreSQL (or local SQLite fallback when credentials pending).
- Paid Tiers (Pro, Team, Enterprise): Stored in Neon Serverless PostgreSQL.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
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
elif NEON_DATABASE_URL and not NEON_DATABASE_URL.startswith("sqlite"):
    # Single-database deployment mode: when a persistent PostgreSQL database is provided (Neon or custom DB)
    # but separate Supabase credentials are not, share the persistent PostgreSQL DB across all tiers
    # so data is never lost on ephemeral container restarts (e.g. Render / Hugging Face free tiers).
    SUPABASE_DATABASE_URL = NEON_DATABASE_URL
    logger.info(
        "[PromptHold DB Router] SUPABASE_DATABASE_URL not set; using persistent PostgreSQL database for Community tier."
    )
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
    else {"prepare_threshold": None, "connect_timeout": 5}
)
supabase_connect_args: dict[str, Any] = (
    {"check_same_thread": False}
    if SUPABASE_DATABASE_URL.startswith("sqlite")
    else {"prepare_threshold": None, "connect_timeout": 5}
)

neon_engine_kwargs: dict[str, Any] = {
    "connect_args": neon_connect_args,
    "pool_pre_ping": True,
}
if not NEON_DATABASE_URL.startswith("sqlite"):
    neon_engine_kwargs["pool_recycle"] = 300
    neon_engine_kwargs["pool_size"] = 5
    neon_engine_kwargs["max_overflow"] = 5
    neon_engine_kwargs["pool_timeout"] = 10

engine_neon = create_engine(NEON_DATABASE_URL, **neon_engine_kwargs)

supabase_engine_kwargs: dict[str, Any] = {
    "connect_args": supabase_connect_args,
    "pool_pre_ping": True,
}
if not SUPABASE_DATABASE_URL.startswith("sqlite"):
    supabase_engine_kwargs["pool_recycle"] = 300
    supabase_engine_kwargs["pool_size"] = 5
    supabase_engine_kwargs["max_overflow"] = 5
    supabase_engine_kwargs["pool_timeout"] = 10

engine_supabase = create_engine(SUPABASE_DATABASE_URL, **supabase_engine_kwargs)

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
# 3. Token-to-Tier Routing
# -----------------------------------------------------------------------------
# New session tokens and API keys carry a tier hint so a request only touches the
# database it needs (community traffic never wakes Neon's compute):
#   sessions: "phc_..." (community) / "php_..." (paid)
#   API keys: "pv_live_c_..." / "pv_live_p_..."
# The hint is only a first guess: after a tier migration the token keeps its
# prefix, so a miss falls back to the other database.


_MAX_TOKEN_CACHE_SIZE = 2048
_NEGATIVE_TTL_SECONDS = 60
_token_plan_cache: dict[str, str] = {}
_negative_cache: dict[str, float] = {}
_user_token_index: dict[str, set[str]] = {}


def tier_hint_for_plan(plan: str | None) -> str:
    return "c" if is_community_plan(plan) else "p"


def token_tier_hint(token: str) -> str | None:
    """Return 'c'/'p' when the token carries a tier prefix, else None (legacy token)."""
    t = (token or "").strip()
    for prefix, hint in (("phc_", "c"), ("php_", "p"), ("pv_live_c_", "c"), ("pv_live_p_", "p")):
        if t.startswith(prefix):
            return hint
    return None


def _hash(token: str) -> str:
    return hashlib.sha256(token.strip().encode("utf-8")).hexdigest()


def _evict_if_full() -> None:
    if len(_token_plan_cache) >= _MAX_TOKEN_CACHE_SIZE:
        for _ in range(min(128, len(_token_plan_cache))):
            _token_plan_cache.pop(next(iter(_token_plan_cache)), None)
    if len(_negative_cache) >= _MAX_TOKEN_CACHE_SIZE:
        now = time.monotonic()
        for k in [k for k, exp in _negative_cache.items() if exp < now] or list(_negative_cache)[:128]:
            _negative_cache.pop(k, None)


def cache_token_plan(token: str, plan: str, user_id: str | None = None) -> None:
    """Associate a session token or API key (raw or hashed) with its database plan."""
    if not token:
        return
    clean_token = token.strip()
    clean_plan = (plan or COMMUNITY_PLAN).strip().lower()
    _evict_if_full()
    token_h = _hash(clean_token)
    _token_plan_cache[clean_token] = clean_plan
    _token_plan_cache[token_h] = clean_plan
    _negative_cache.pop(clean_token, None)
    _negative_cache.pop(token_h, None)
    if user_id:
        _user_token_index.setdefault(user_id, set()).update({clean_token, token_h})


def get_cached_token_plan(token: str) -> str | None:
    """Retrieve the cached plan for a raw or hashed token."""
    if not token:
        return None
    clean_token = token.strip()
    if clean_token in _token_plan_cache:
        return _token_plan_cache[clean_token]
    return _token_plan_cache.get(_hash(clean_token))


def invalidate_token_plan(token: str) -> None:
    """Remove a token from the tier routing cache."""
    if not token:
        return
    clean_token = token.strip()
    for k in (clean_token, _hash(clean_token)):
        _token_plan_cache.pop(k, None)
        _negative_cache.pop(k, None)


def invalidate_user_token_plans(user_id: str) -> None:
    """Drop every cached token of a user (call after a plan / tier change)."""
    for k in _user_token_index.pop(user_id, set()):
        _token_plan_cache.pop(k, None)


def _lookup_plan_in(session_factory: sessionmaker[Session], token: str, default_plan: str) -> tuple[str, str] | None:
    """Return (plan, user_id) if the token is a live session or API key in this database."""
    from models import ApiKey, AuthSession, User

    clean = token.strip()
    token_h = _hash(clean)
    with session_factory() as db:
        user_id = None
        sess = db.query(AuthSession.user_id).filter(AuthSession.token.in_([token_h, clean])).first()
        if sess is not None:
            user_id = sess[0]
        else:
            key = db.query(ApiKey.user_id).filter_by(key_hash=token_h, is_active=True).first()
            if key is not None:
                user_id = key[0]
        if user_id is None:
            return None
        row = db.query(User.plan).filter_by(id=user_id).first()
        plan = (row[0] if row else None) or default_plan
        return plan, user_id


def resolve_token_plan(token: str) -> str:
    """Determine whether a token belongs to Supabase (community) or Neon (paid).

    Tier-prefixed tokens query their own database first; legacy tokens probe
    Supabase first. Unknown tokens are negatively cached for a short time so
    bots and expired sessions do not repeatedly wake Neon. Database errors are
    logged (not swallowed) and the request falls through to the default tier.
    """
    if not token:
        return COMMUNITY_PLAN

    cached = get_cached_token_plan(token)
    if cached is not None:
        return cached

    clean_token = token.strip()
    neg_exp = _negative_cache.get(clean_token)
    if neg_exp is not None:
        if neg_exp > time.monotonic():
            return COMMUNITY_PLAN
        _negative_cache.pop(clean_token, None)

    order = [("community", SessionSupabase, COMMUNITY_PLAN), ("paid", SessionNeon, "team")]
    if token_tier_hint(clean_token) == "p":
        order.reverse()

    for label, factory, default_plan in order:
        try:
            found = _lookup_plan_in(factory, clean_token, default_plan)
        except Exception as exc:
            logger.warning("[PromptHold DB Router] %s database lookup failed: %s", label, exc)
            continue
        if found is not None:
            plan, user_id = found
            cache_token_plan(clean_token, plan, user_id=user_id)
            return plan

    _evict_if_full()
    _negative_cache[clean_token] = time.monotonic() + _NEGATIVE_TTL_SECONDS
    return COMMUNITY_PLAN


# -----------------------------------------------------------------------------
# 4. Seamless Data Migration Across Database Tiers (Plan Upgrade/Downgrade)
# -----------------------------------------------------------------------------

def _copy_rows(dst_db: Session, rows: list[Any]) -> None:
    """Upsert ORM rows into another database by primary key (safe to re-run)."""
    for row in rows:
        mapper = inspect(type(row))
        values = {attr.key: getattr(row, attr.key) for attr in mapper.column_attrs}
        dst_db.merge(type(row)(**values))
    dst_db.flush()


def migrate_user_tier(user_id: str, from_plan: str, to_plan: str) -> None:
    """Move a user and the data they own between Supabase (community) and Neon (paid).

    Idempotent: rows are upserted by primary key, so a retry after a crash
    completes the move instead of failing or duplicating. The source copy is
    only deleted after the destination commit succeeds. What moves: the user,
    their Personal space, team groups where they are the only member, all
    prompts/versions/chunks/diff links/proposals inside those groups, and the
    user's API keys and sessions. Shared team groups stay in the source tier.
    Raises on failure so callers (billing webhooks) can log and retry.
    """
    from_community = is_community_plan(from_plan)
    to_community = is_community_plan(to_plan)
    if from_community == to_community:
        return

    from models import (
        ApiKey,
        AuthSession,
        Group,
        GroupMembership,
        Prompt,
        PromptChunk,
        PromptProposal,
        PromptVersion,
        ProposalApproval,
        ProposalComment,
        SharedDiffLink,
        User,
    )

    src_factory = get_sessionmaker_for_plan(from_plan)
    dst_factory = get_sessionmaker_for_plan(to_plan)

    with src_factory() as src_db, dst_factory() as dst_db:
        src_user = src_db.query(User).filter_by(id=user_id).first()
        if not src_user:
            # Already moved (or never existed): just make sure routing is fresh.
            invalidate_user_token_plans(user_id)
            return

        candidate_groups = src_db.query(Group).filter(
            (Group.personal_owner_id == user_id) | (Group.created_by == user_id)
        ).all()
        groups = []
        for g in candidate_groups:
            if g.personal_owner_id == user_id:
                groups.append(g)
                continue
            others = src_db.query(GroupMembership).filter(
                GroupMembership.group_id == g.id, GroupMembership.user_id != user_id
            ).count()
            if others == 0:
                groups.append(g)
            else:
                logger.info("Tier migration: shared group %s stays in the %s tier", g.id, from_plan)
        group_ids = [g.id for g in groups]

        prompts = src_db.query(Prompt).filter(Prompt.group_id.in_(group_ids)).all() if group_ids else []
        prompt_ids = [p.id for p in prompts]
        versions = src_db.query(PromptVersion).filter(PromptVersion.prompt_id.in_(prompt_ids)).all() if prompt_ids else []
        chunks = src_db.query(PromptChunk).filter(PromptChunk.prompt_id.in_(prompt_ids)).all() if prompt_ids else []
        diffs = src_db.query(SharedDiffLink).filter(SharedDiffLink.prompt_id.in_(prompt_ids)).all() if prompt_ids else []
        proposals = src_db.query(PromptProposal).filter(PromptProposal.prompt_id.in_(prompt_ids)).all() if prompt_ids else []
        proposal_ids = [p.id for p in proposals]
        approvals = src_db.query(ProposalApproval).filter(ProposalApproval.proposal_id.in_(proposal_ids)).all() if proposal_ids else []
        comments = src_db.query(ProposalComment).filter(ProposalComment.proposal_id.in_(proposal_ids)).all() if proposal_ids else []
        memberships = src_db.query(GroupMembership).filter(
            GroupMembership.user_id == user_id, GroupMembership.group_id.in_(group_ids)
        ).all() if group_ids else []
        keys = src_db.query(ApiKey).filter_by(user_id=user_id).all()
        sessions = src_db.query(AuthSession).filter_by(user_id=user_id).all()
        # Group-scoped keys pointing at a group that stays behind cannot move with a valid FK.
        keys = [k for k in keys if not k.group_id or k.group_id in group_ids]

        # 1. Upsert into destination, parents before children.
        try:
            _copy_rows(dst_db, [src_user])
            dst_db.query(User).filter_by(id=user_id).update({"plan": to_plan}, synchronize_session=False)
            for batch in (groups, memberships, prompts, versions, chunks, diffs, proposals, approvals, comments, keys, sessions):
                _copy_rows(dst_db, batch)
            dst_db.commit()
        except Exception:
            dst_db.rollback()
            logger.exception("Tier migration of user %s (%s -> %s) failed while copying", user_id, from_plan, to_plan)
            raise

        # 2. Routing now points at the destination before anything is deleted.
        invalidate_user_token_plans(user_id)
        for k in keys:
            cache_token_plan(k.key_hash, to_plan, user_id=user_id)
        for sess in sessions:
            cache_token_plan(sess.token, to_plan, user_id=user_id)

        # 3. Delete the source copy, children before parents.
        try:
            def _delete(model: Any, ids: list[str], col: str = "id") -> None:
                if ids:
                    src_db.query(model).filter(getattr(model, col).in_(ids)).delete(synchronize_session=False)

            _delete(ProposalComment, [c.id for c in comments])
            _delete(ProposalApproval, [a.id for a in approvals])
            _delete(PromptProposal, proposal_ids)
            _delete(SharedDiffLink, [d.id for d in diffs])
            _delete(PromptChunk, [c.id for c in chunks])
            if prompt_ids:
                src_db.query(Prompt).filter(Prompt.id.in_(prompt_ids)).update({"current_version_id": None}, synchronize_session=False)
            _delete(PromptVersion, [v.id for v in versions])
            _delete(Prompt, prompt_ids)
            _delete(AuthSession, [x.token for x in sessions], col="token")
            _delete(ApiKey, [k.id for k in keys])
            _delete(GroupMembership, [m.id for m in memberships])
            _delete(Group, group_ids)
            remaining = src_db.query(GroupMembership).filter_by(user_id=user_id).count()
            if remaining == 0:
                src_db.query(User).filter_by(id=user_id).delete(synchronize_session=False)
            else:
                # Still a member of shared groups in this tier: keep a stub so FKs stay valid.
                src_db.query(User).filter_by(id=user_id).update({"plan": to_plan}, synchronize_session=False)
            src_db.commit()
        except Exception:
            src_db.rollback()
            logger.exception(
                "Tier migration of user %s copied to %s but source cleanup failed; re-run migrate_user_tier to finish",
                user_id, to_plan,
            )
            raise


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
