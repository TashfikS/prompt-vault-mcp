"""Cross-tier teams: a Community user (Supabase) joins a paid team (Neon) and works in it.

Two separate in-memory databases stand in for the tiers. The real ``get_db`` routes each
request by its session token, and ``tiers.peer_sessionmaker_for`` maps one tier to the other.
"""

from collections.abc import Iterator
from datetime import datetime
from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

import database
import deps
import mcp_server
import routers.auth_routes as auth_routes
import tiers
from auth import create_api_key_record, create_session, hash_password, upgrade_schema
from database import Base, get_db, migrate_user_tier
from main import app
from models import Group, GroupMembership, Prompt, PromptProposal, PromptVersion, User
from permissions import ensure_personal_group

PASSWORD = "Password1234"


def _tier() -> sessionmaker[Session]:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    upgrade_schema(engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


class Tiers:
    def __init__(self) -> None:
        self.community = _tier()
        self.paid = _tier()
        self.peer_opens = 0

    def peer_for(self, db: Session):
        self.peer_opens += 1
        bind = db.get_bind()
        return self.paid if bind is self.community.kw["bind"] else self.community


@pytest.fixture
def two_tiers() -> Iterator[Tiers]:
    t = Tiers()

    def real_get_db(request=None):
        yield from database.get_db(request)

    with patch.object(database, "SessionSupabase", t.community), patch.object(database, "SessionNeon", t.paid), \
            patch.object(deps, "SessionSupabase", t.community), patch.object(deps, "SessionNeon", t.paid), \
            patch.object(auth_routes, "SessionSupabase", t.community), patch.object(auth_routes, "SessionNeon", t.paid), \
            patch.object(mcp_server, "SessionSupabase", t.community), patch.object(mcp_server, "SessionNeon", t.paid), \
            patch.object(mcp_server, "SessionLocal", t.paid), \
            patch.object(tiers, "peer_sessionmaker_for", t.peer_for):
        saved = app.dependency_overrides.pop(get_db, None)
        database._token_plan_cache.clear()
        database._negative_cache.clear()
        try:
            yield t
        finally:
            if saved is not None:
                app.dependency_overrides[get_db] = saved
            database._token_plan_cache.clear()
            database._negative_cache.clear()


@pytest_asyncio.fixture
async def http(two_tiers) -> AsyncClient:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        yield client


def _user(factory, name: str, email: str, plan: str) -> tuple[str, str]:
    with factory() as db:
        user = User(name=name, email=email, plan=plan, password_hash=hash_password(PASSWORD),
                    email_verified_at=datetime.utcnow())
        db.add(user)
        db.flush()
        ensure_personal_group(db, user)
        db.commit()
        return user.id, create_session(db, user)


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def world(two_tiers):
    """Bob owns a paid team "Marketing" (Neon) with one prompt; Dana is a Community user (Supabase)."""
    bob_id, bob = _user(two_tiers.paid, "Bob Owner", "bob@corp.com", "team")
    dana_id, dana = _user(two_tiers.community, "Dana Free", "dana@corp.com", "community")
    with two_tiers.paid() as db:
        db.query(User).filter_by(id=bob_id).update({"billed_seats": 3})
        group = Group(name="Marketing", description="", created_by=bob_id, required_approvals=1)
        db.add(group)
        db.flush()
        db.add(GroupMembership(user_id=bob_id, group_id=group.id, role="GROUP_MANAGER"))
        prompt = Prompt(group_id=group.id, title="Campaign writer", description="", current_version_number=1, created_by=bob_id)
        db.add(prompt)
        db.flush()
        v1 = PromptVersion(prompt_id=prompt.id, version_number=1, content="Write about {{product}}.", variables_json='["product"]', author_id=bob_id)
        db.add(v1)
        db.flush()
        prompt.current_version_id = v1.id
        db.commit()
        ids = {"group": group.id, "prompt": prompt.id}
    with two_tiers.community() as db:
        personal = db.query(Group).filter_by(personal_owner_id=dana_id).one()
        p = Prompt(group_id=personal.id, title="Dana private", description="", current_version_number=1, created_by=dana_id)
        db.add(p)
        db.flush()
        v = PromptVersion(prompt_id=p.id, version_number=1, content="Mine.", variables_json="[]", author_id=dana_id)
        db.add(v)
        db.flush()
        p.current_version_id = v.id
        db.commit()
        ids["dana_prompt"] = p.id
    return {"bob": bob, "bob_id": bob_id, "dana": dana, "dana_id": dana_id, **ids}


async def _add_dana(http: AsyncClient, w: dict, role: str = "MEMBER"):
    return await http.post(f"/api/groups/{w['group']}/members", headers=_h(w["bob"]), json={"email": "dana@corp.com", "role": role})


@pytest.mark.asyncio
async def test_paid_owner_adds_community_user_by_email(http, two_tiers, world):
    res = await _add_dana(http, world)
    assert res.status_code == 201, res.text
    with two_tiers.paid() as db:
        stub = db.query(User).filter_by(id=world["dana_id"]).one()
        assert stub.is_peer_stub and stub.password_hash is None and not stub.is_workspace_admin
        assert db.query(GroupMembership).filter_by(user_id=world["dana_id"], group_id=world["group"]).one().role == "MEMBER"
    with two_tiers.community() as db:
        real = db.query(User).filter_by(id=world["dana_id"]).one()
        assert real.has_peer_memberships and not real.is_peer_stub
        # Her own data never moved.
        assert db.query(Prompt).filter_by(id=world["dana_prompt"]).one()


@pytest.mark.asyncio
async def test_member_sees_both_tiers_in_lists(http, world):
    await _add_dana(http, world)
    groups = (await http.get("/api/groups", headers=_h(world["dana"]))).json()
    assert {g["name"] for g in groups} == {"Personal", "Marketing"}
    assert groups[0]["is_personal"]
    prompts = (await http.get("/api/prompts", headers=_h(world["dana"]))).json()
    assert {p["title"] for p in prompts} == {"Campaign writer", "Dana private"}
    versions = await http.get(f"/api/prompts/{world['prompt']}/versions", headers=_h(world["dana"]))
    assert versions.status_code == 200 and versions.json()[0]["content"] == "Write about {{product}}."


@pytest.mark.asyncio
async def test_member_proposes_and_owner_merges(http, world):
    await _add_dana(http, world)
    edit = await http.put(f"/api/prompts/{world['prompt']}", headers=_h(world["dana"]),
                          json={"title": "Campaign writer", "content": "Write about {{product}}. Be brief.", "change_note": "Shorter"})
    assert edit.status_code == 200 and edit.json()["proposal_created"], edit.text
    proposal_id = edit.json()["proposal_id"]

    mine = (await http.get("/api/proposals", headers=_h(world["dana"]))).json()
    assert [p["id"] for p in mine] == [proposal_id]
    # Self-approval stays blocked across tiers.
    assert (await http.post(f"/api/proposals/{proposal_id}/approve", headers=_h(world["dana"]))).status_code in {400, 403}
    comment = await http.post(f"/api/proposals/{proposal_id}/comments", headers=_h(world["dana"]), json={"comment": "Ready"})
    assert comment.status_code == 201 and comment.json()["user_name"] == "Dana Free"

    approve = await http.post(f"/api/proposals/{proposal_id}/approve", headers=_h(world["bob"]))
    assert approve.status_code == 200 and approve.json()["merged"], approve.text
    versions = (await http.get(f"/api/prompts/{world['prompt']}/versions", headers=_h(world["dana"]))).json()
    assert versions[0]["content"].endswith("Be brief.")


@pytest.mark.asyncio
async def test_member_creates_team_prompt_and_guest_cannot(http, two_tiers, world):
    await _add_dana(http, world)
    res = await http.post("/api/prompts", headers=_h(world["dana"]),
                          json={"group_id": world["group"], "title": "Dana idea", "content": "Hi {{name}}"})
    assert res.status_code == 201 and res.json().get("proposal_created"), res.text  # Members propose new prompts
    with two_tiers.paid() as db:
        assert db.query(PromptProposal).filter_by(proposer_id=world["dana_id"]).count() == 1
    with two_tiers.community() as db:
        assert db.query(PromptProposal).count() == 0

    await _add_dana(http, world, role="GUEST")
    denied = await http.put(f"/api/prompts/{world['prompt']}", headers=_h(world["dana"]),
                            json={"title": "x", "content": "y", "change_note": "z"})
    assert denied.status_code == 403


@pytest.mark.asyncio
async def test_duplicate_across_tiers_copies_and_move_is_refused(http, two_tiers, world):
    await _add_dana(http, world)
    with two_tiers.community() as db:
        personal_id = db.query(Group.id).filter_by(personal_owner_id=world["dana_id"]).scalar()
    copy = await http.post(f"/api/prompts/{world['prompt']}/duplicate", headers=_h(world["dana"]),
                           json={"target_group_id": personal_id, "mode": "copy"})
    assert copy.status_code == 201, copy.text
    with two_tiers.community() as db:
        assert db.query(Prompt).filter_by(group_id=personal_id, title="Campaign writer").one()
    move = await http.post(f"/api/prompts/{world['dana_prompt']}/duplicate", headers=_h(world["dana"]),
                           json={"target_group_id": world["group"], "mode": "move"})
    assert move.status_code == 400 and "Duplicate it instead" in move.json()["detail"]


@pytest.mark.asyncio
async def test_removal_clears_flag_and_hides_team(http, two_tiers, world):
    await _add_dana(http, world)
    res = await http.delete(f"/api/groups/{world['group']}/members/{world['dana_id']}", headers=_h(world["bob"]))
    assert res.status_code == 200
    with two_tiers.community() as db:
        assert db.query(User).filter_by(id=world["dana_id"]).one().has_peer_memberships is False
    names = {g["name"] for g in (await http.get("/api/groups", headers=_h(world["dana"]))).json()}
    assert names == {"Personal"}
    assert (await http.get(f"/api/prompts/{world['prompt']}/versions", headers=_h(world["dana"]))).status_code in {403, 404}


@pytest.mark.asyncio
async def test_users_without_peer_teams_never_open_the_other_tier(http, two_tiers, world):
    two_tiers.peer_opens = 0
    for path in ("/api/groups", "/api/prompts", "/api/proposals", "/api/prompts?search=writer"):
        assert (await http.get(path, headers=_h(world["dana"]))).status_code == 200
    assert two_tiers.peer_opens == 0


@pytest.mark.asyncio
async def test_outsider_cannot_reach_peer_team_by_id(http, two_tiers, world):
    """A user flagged for some peer team still can't open a different team's prompt there."""
    await _add_dana(http, world)
    with two_tiers.paid() as db:
        other = Group(name="Secret", description="", created_by=world["bob_id"])
        db.add(other)
        db.flush()
        p = Prompt(group_id=other.id, title="Secret", description="", current_version_number=1, created_by=world["bob_id"])
        db.add(p)
        db.flush()
        db.add(PromptVersion(prompt_id=p.id, version_number=1, content="s", variables_json="[]", author_id=world["bob_id"]))
        db.commit()
        secret_id = p.id
    assert (await http.get(f"/api/prompts/{secret_id}/versions", headers=_h(world["dana"]))).status_code in {403, 404}


@pytest.mark.asyncio
async def test_sign_in_ignores_name_tags(http, two_tiers, world):
    await _add_dana(http, world)
    res = await http.post("/api/auth/login", json={"email": "dana@corp.com", "password": PASSWORD})
    assert res.status_code == 200 and res.json()["token"].startswith("phc_")
    # A stub has no password, so it can never be signed in to even if it were picked.
    with two_tiers.paid() as db:
        assert db.query(User).filter_by(email="dana@corp.com").one().password_hash is None


def test_upgrade_turns_stub_into_real_account(two_tiers, world):
    """Dana upgrades to Pro: her account moves to Neon over her stub; nothing is left in the other tier."""
    with two_tiers.community() as db:
        real = db.query(User).filter_by(id=world["dana_id"]).one()
    with two_tiers.paid() as db:
        tiers.ensure_stub(db, real)
        db.add(GroupMembership(user_id=world["dana_id"], group_id=world["group"], role="MEMBER"))
        db.commit()
    with two_tiers.community() as db:
        db.query(User).filter_by(id=world["dana_id"]).update({"has_peer_memberships": True})
        db.commit()

    migrate_user_tier(world["dana_id"], "community", "pro")

    with two_tiers.paid() as db:
        moved = db.query(User).filter_by(id=world["dana_id"]).one()
        assert not moved.is_peer_stub and moved.password_hash and moved.plan == "pro"
        assert moved.has_peer_memberships is False
        assert db.query(GroupMembership).filter_by(user_id=world["dana_id"], group_id=world["group"]).one()
    with two_tiers.community() as db:
        assert db.query(User).filter_by(id=world["dana_id"]).first() is None


@pytest.mark.asyncio
async def test_mcp_tools_work_across_tiers(http, two_tiers, world):
    """Dana's AI-chat key (stored in Supabase) lists, fills, proposes and comments on the Neon team prompt."""
    await _add_dana(http, world)
    with two_tiers.community() as db:
        dana = db.query(User).filter_by(id=world["dana_id"]).one()
        _, key = create_api_key_record(db, user=dana, name="chat", scope_type="GLOBAL", access_level="READ_WRITE")
        db.commit()

    titles = {p["title"] for p in mcp_server.list_my_accessible_prompts(api_key=key)["prompts"]}
    assert titles == {"Campaign writer", "Dana private"}
    filled = mcp_server.get_and_fill_prompt(world["prompt"], api_key=key, variables={"product": "Tea"})
    assert filled["content"] == "Write about Tea."

    saved = mcp_server.save_prompt_version_from_chat(world["prompt"], "Write about {{product}} warmly.", api_key=key)
    assert saved["proposal_created"]
    pending = mcp_server.list_pending_proposals(api_key=key)["proposals"]
    assert [p["proposal_id"] for p in pending] == [saved["proposal_id"]]
    assert mcp_server.comment_on_proposal(saved["proposal_id"], "Looks good", api_key=key)["author"] == "Dana Free"

    created = mcp_server.create_prompt_from_chat("From chat", "Hello {{x}}", group_name="Marketing", api_key=key)
    assert created["proposal_created"] and created["group_name"] == "Marketing"

    with two_tiers.community() as db:
        personal_id = db.query(Group.id).filter_by(personal_owner_id=world["dana_id"]).scalar()
    copied = mcp_server.duplicate_or_move_prompt(world["prompt"], personal_id, api_key=key)
    assert copied["mode"] == "copy" and copied["group_id"] == personal_id
    with pytest.raises(ValueError, match="Duplicate it instead"):
        mcp_server.duplicate_or_move_prompt(world["dana_prompt"], world["group"], mode="move", api_key=key)
