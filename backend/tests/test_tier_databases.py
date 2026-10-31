"""Unit and integration tests for PromptFolders multi-tier database routing (Supabase for Free tier, Neon for Paid tiers)."""

import os
from unittest.mock import patch
import pytest
from httpx import AsyncClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import database
from database import (
    Base,
    COMMUNITY_PLAN,
    PAID_PLANS,
    cache_token_plan,
    get_cached_token_plan,
    get_engine_for_plan,
    get_sessionmaker_for_plan,
    invalidate_token_plan,
    is_community_plan,
    is_supabase_configured,
    is_test_session,
    migrate_user_tier,
    normalize_db_url,
    resolve_token_plan,
)
from models import ApiKey, AuthSession, Group, GroupMembership, Prompt, PromptVersion, User
from auth import hash_password, upgrade_schema


def test_normalize_db_url():
    """Verify postgres URL conversion for psycopg3 driver."""
    assert normalize_db_url("postgres://user:pass@host:5432/db") == "postgresql+psycopg://user:pass@host:5432/db"
    assert normalize_db_url("postgresql://user:pass@host:5432/db") == "postgresql+psycopg://user:pass@host:5432/db"
    assert normalize_db_url("sqlite:///./local.db") == "sqlite:///./local.db"
    assert normalize_db_url('"postgresql://user:pass@host/db"') == "postgresql+psycopg://user:pass@host/db"
    assert normalize_db_url("") == ""


def test_is_supabase_configured_detection():
    """Verify detection of live vs empty/placeholder Supabase database credentials."""
    with patch.dict(os.environ, {"SUPABASE_DATABASE_URL": ""}):
        assert is_supabase_configured() is False

    with patch.dict(os.environ, {"SUPABASE_DATABASE_URL": "postgresql://postgres:[YOUR-PASSWORD]@db.example.com:5432/postgres"}):
        assert is_supabase_configured() is False

    with patch.dict(os.environ, {"SUPABASE_DATABASE_URL": "postgresql://postgres:realsecret123@db.abcdefgh.supabase.co:5432/postgres?sslmode=require"}):
        assert is_supabase_configured() is True


def test_plan_tier_helpers():
    """Verify tier mapping: community is free tier, others are paid."""
    assert is_community_plan("community") is True
    assert is_community_plan(None) is True
    assert is_community_plan("") is True
    assert is_community_plan("pro") is False
    assert is_community_plan("team") is False
    assert is_community_plan("enterprise") is False

    assert get_sessionmaker_for_plan("community") is database.SessionSupabase
    assert get_sessionmaker_for_plan("pro") is database.SessionNeon
    assert get_sessionmaker_for_plan("team") is database.SessionNeon
    assert get_sessionmaker_for_plan("enterprise") is database.SessionNeon


def test_token_plan_cache():
    """Verify in-memory token plan cache routing."""
    token = "test_bearer_token_xyz123"
    cache_token_plan(token, "community")
    assert get_cached_token_plan(token) == "community"

    # Also works with updated plan
    cache_token_plan(token, "pro")
    assert get_cached_token_plan(token) == "pro"

    invalidate_token_plan(token)
    assert get_cached_token_plan(token) is None


def test_migrate_user_tier_between_engines():
    """Verify seamless relational data migration between free tier (Supabase) and paid tier (Neon)."""
    # Create two isolated in-memory SQLite engines to represent Supabase and Neon
    engine_supa = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    engine_neon = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)

    Base.metadata.create_all(bind=engine_supa)
    upgrade_schema(engine_supa)
    Base.metadata.create_all(bind=engine_neon)
    upgrade_schema(engine_neon)

    SessionMockSupa = sessionmaker(bind=engine_supa, autoflush=False, autocommit=False)
    SessionMockNeon = sessionmaker(bind=engine_neon, autoflush=False, autocommit=False)

    # Patch sessionmakers for plan
    with patch("database.get_sessionmaker_for_plan", side_effect=lambda plan: SessionMockSupa if is_community_plan(plan) else SessionMockNeon):
        # 1. Create a user on Community tier with prompts and versions in Supabase
        with SessionMockSupa() as db_supa:
            user = User(name="Charlie Free", email="charlie@free.com", plan="community", password_hash=hash_password("test1234"))
            db_supa.add(user)
            db_supa.flush()

            personal_group = Group(name=f"personal:{user.id}", personal_owner_id=user.id, created_by=user.id)
            db_supa.add(personal_group)
            db_supa.flush()

            membership = GroupMembership(user_id=user.id, group_id=personal_group.id, role="GROUP_MANAGER")
            db_supa.add(membership)

            prompt = Prompt(title="Free Tier Prompt", group_id=personal_group.id, created_by=user.id)
            db_supa.add(prompt)
            db_supa.flush()

            v1 = PromptVersion(prompt_id=prompt.id, version_number=1, content="Hello {{name}}", variables_json='["name"]', author_id=user.id)
            db_supa.add(v1)
            prompt.current_version_id = v1.id

            api_key = ApiKey(user_id=user.id, name="Test Key", key_prefix="pv_test...", key_hash="fakehash123")
            db_supa.add(api_key)

            from datetime import datetime, timedelta
            session = AuthSession(token="fakesessiontoken", user_id=user.id, expires_at=datetime.utcnow() + timedelta(days=1))
            db_supa.add(session)

            db_supa.commit()
            user_id = user.id

        # 2. Upgrade user from Community to Team (Paid tier)
        migrate_user_tier(user_id, from_plan="community", to_plan="team")

        # 3. Verify user and their data are now present in Neon engine
        with SessionMockNeon() as db_neon:
            neon_user = db_neon.query(User).filter_by(id=user_id).first()
            assert neon_user is not None
            assert neon_user.email == "charlie@free.com"
            assert neon_user.plan == "team"

            neon_group = db_neon.query(Group).filter_by(personal_owner_id=user_id).first()
            assert neon_group is not None

            neon_prompt = db_neon.query(Prompt).filter_by(created_by=user_id).first()
            assert neon_prompt is not None
            assert neon_prompt.title == "Free Tier Prompt"

            neon_version = db_neon.query(PromptVersion).filter_by(prompt_id=neon_prompt.id).first()
            assert neon_version is not None
            assert neon_version.content == "Hello {{name}}"

            neon_key = db_neon.query(ApiKey).filter_by(user_id=user_id).first()
            assert neon_key is not None

            neon_session = db_neon.query(AuthSession).filter_by(user_id=user_id).first()
            assert neon_session is not None

        # 4. Verify user was purged from Supabase source
        with SessionMockSupa() as db_supa:
            assert db_supa.query(User).filter_by(id=user_id).first() is None
            assert db_supa.query(Prompt).filter_by(created_by=user_id).first() is None


@pytest.mark.asyncio
async def test_health_check_reports_both_database_tiers(client: AsyncClient):
    """Verify /api/health returns database connectivity diagnostics for both Neon and Supabase tiers."""
    res = await client.get("/api/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert "tiers" in data
    assert "paid" in data["tiers"]
    assert "community" in data["tiers"]
    assert data["tiers"]["paid"]["provider"] == "Neon PostgreSQL"
    assert "community" in data["tiers"]["community"]["plans"]
