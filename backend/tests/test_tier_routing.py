"""Tier-hinted token routing, negative caching and retry-safe tier migration."""

from datetime import datetime, timedelta
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import database
from auth import create_session, generate_api_key, hash_password, hash_session_token, upgrade_schema
from database import (
    Base,
    cache_token_plan,
    get_cached_token_plan,
    invalidate_user_token_plans,
    is_community_plan,
    migrate_user_tier,
    resolve_token_plan,
    token_tier_hint,
)
from models import (
    AuthSession,
    Group,
    GroupMembership,
    Prompt,
    PromptChunk,
    PromptProposal,
    PromptVersion,
    ProposalComment,
    User,
)


def _two_tiers():
    engines = []
    for _ in range(2):
        eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(bind=eng)
        upgrade_schema(eng)
        engines.append(sessionmaker(bind=eng, autoflush=False, autocommit=False))
    return engines  # (community, paid)


def test_generated_tokens_carry_tier_hint():
    assert token_tier_hint(generate_api_key("community")) == "c"
    assert token_tier_hint(generate_api_key("team")) == "p"
    assert token_tier_hint("legacy-random-token") is None

    supa, _ = _two_tiers()
    with supa() as db:
        user = User(name="A", email="a@x.io", plan="pro")
        db.add(user)
        db.commit()
        assert create_session(db, user).startswith("php_")


def test_paid_hint_queries_neon_first_and_community_never_touches_neon():
    supa, neon = _two_tiers()
    with neon() as db:
        u = User(name="P", email="p@x.io", plan="pro")
        db.add(u)
        db.flush()
        db.add(AuthSession(token=hash_session_token("php_abc"), user_id=u.id, expires_at=datetime.utcnow() + timedelta(days=1)))
        db.commit()
    with supa() as db:
        u = User(name="C", email="c@x.io", plan="community")
        db.add(u)
        db.flush()
        db.add(AuthSession(token=hash_session_token("phc_abc"), user_id=u.id, expires_at=datetime.utcnow() + timedelta(days=1)))
        db.commit()

    calls: list[str] = []
    real = database._lookup_plan_in

    def spy(factory, token, default):
        calls.append("neon" if factory is neon else "supa")
        return real(factory, token, default)

    with patch.object(database, "SessionSupabase", supa), patch.object(database, "SessionNeon", neon), \
            patch.object(database, "_lookup_plan_in", side_effect=spy):
        assert resolve_token_plan("php_abc") == "pro"
        assert calls == ["neon"]
        calls.clear()
        assert resolve_token_plan("phc_abc") == "community"
        assert calls == ["supa"]


def test_unknown_token_is_negatively_cached():
    supa, neon = _two_tiers()
    calls = []
    real = database._lookup_plan_in
    with patch.object(database, "SessionSupabase", supa), patch.object(database, "SessionNeon", neon), \
            patch.object(database, "_lookup_plan_in", side_effect=lambda *a: calls.append(1) or real(*a)):
        assert resolve_token_plan("phc_does_not_exist") == "community"
        assert len(calls) == 2
        assert resolve_token_plan("phc_does_not_exist") == "community"
        assert len(calls) == 2  # second call served from the negative cache


def test_db_error_is_logged_and_falls_through(caplog):
    supa, neon = _two_tiers()

    def boom():
        raise RuntimeError("supabase down")

    with patch.object(database, "SessionSupabase", boom), patch.object(database, "SessionNeon", neon):
        assert resolve_token_plan("phc_whatever_err") == "community"
    assert "supabase down" in caplog.text


def test_invalidate_user_token_plans():
    cache_token_plan("phc_tok_inv", "community", user_id="user-inv")
    assert get_cached_token_plan("phc_tok_inv") == "community"
    invalidate_user_token_plans("user-inv")
    assert get_cached_token_plan("phc_tok_inv") is None


def test_migration_moves_proposals_and_chunks_and_is_rerunnable():
    supa, neon = _two_tiers()
    with patch("database.get_sessionmaker_for_plan", side_effect=lambda plan: supa if is_community_plan(plan) else neon):
        with supa() as db:
            u = User(name="M", email="m@x.io", plan="community", password_hash=hash_password("pw123456"))
            db.add(u)
            db.flush()
            g = Group(name=f"personal:{u.id}", personal_owner_id=u.id, created_by=u.id)
            db.add(g)
            db.flush()
            db.add(GroupMembership(user_id=u.id, group_id=g.id, role="GROUP_MANAGER"))
            p = Prompt(title="T", group_id=g.id, created_by=u.id)
            db.add(p)
            db.flush()
            v = PromptVersion(prompt_id=p.id, version_number=1, content="x", variables_json="[]", author_id=u.id)
            db.add(v)
            db.flush()
            p.current_version_id = v.id
            db.add(PromptChunk(prompt_id=p.id, version_id=v.id, chunk_text="x", embedding_json="[]"))
            prop = PromptProposal(prompt_id=p.id, group_id=g.id, proposer_id=u.id, title="T", content="y")
            db.add(prop)
            db.flush()
            db.add(ProposalComment(proposal_id=prop.id, user_id=u.id, comment="hi"))
            db.add(AuthSession(token="sess-mig", user_id=u.id, expires_at=datetime.utcnow() + timedelta(days=1)))
            db.commit()
            uid = u.id
        cache_token_plan("sess-mig", "community", user_id=uid)

        migrate_user_tier(uid, "community", "team")
        assert get_cached_token_plan("sess-mig") == "team"
        migrate_user_tier(uid, "community", "team")  # re-run is a no-op, not an error

        with neon() as db:
            assert db.query(User).filter_by(id=uid).one().plan == "team"
            assert db.query(PromptChunk).count() == 1
            assert db.query(PromptProposal).count() == 1
            assert db.query(ProposalComment).count() == 1
        with supa() as db:
            assert db.query(User).filter_by(id=uid).first() is None
            assert db.query(PromptProposal).count() == 0


def test_shared_team_group_stays_in_source_tier():
    supa, neon = _two_tiers()
    with patch("database.get_sessionmaker_for_plan", side_effect=lambda plan: supa if is_community_plan(plan) else neon):
        with supa() as db:
            owner = User(name="O", email="o@x.io", plan="community")
            mate = User(name="T", email="t@x.io", plan="community")
            db.add_all([owner, mate])
            db.flush()
            team = Group(name="Team", created_by=owner.id)
            db.add(team)
            db.flush()
            db.add_all([
                GroupMembership(user_id=owner.id, group_id=team.id, role="GROUP_MANAGER"),
                GroupMembership(user_id=mate.id, group_id=team.id, role="MEMBER"),
            ])
            db.add(Prompt(title="Shared", group_id=team.id, created_by=owner.id))
            db.commit()
            oid = owner.id

        migrate_user_tier(oid, "community", "pro")

        with supa() as db:
            assert db.query(Prompt).filter_by(title="Shared").first() is not None
            assert db.query(User).filter_by(id=oid).one().plan == "pro"  # stub keeps FKs valid
        with neon() as db:
            assert db.query(User).filter_by(id=oid).one().plan == "pro"
            assert db.query(Prompt).count() == 0


def test_shallow_health_check_never_touches_neon():
    import main

    def neon_forbidden():
        raise AssertionError("health check must not open a Neon session")

    supa, _ = _two_tiers()
    with patch.object(main, "SessionNeon", neon_forbidden), patch.object(main, "SessionSupabase", supa):
        data = main.health_check(deep=False)
    assert data["tiers"]["paid"]["status"] == "not_checked"
    assert data["status"] == "ok"
