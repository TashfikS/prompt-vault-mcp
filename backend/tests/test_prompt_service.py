"""services.prompts: the rules REST and MCP now share."""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import services.prompts as prompt_service
from auth import upgrade_schema
from database import Base
from models import Group, GroupMembership, Prompt, PromptProposal, User


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    upgrade_schema(engine)
    with sessionmaker(bind=engine)() as session:
        yield session


def _user_with_space(db, email="u@x.io", role="GROUP_MANAGER"):
    user = User(name="U", email=email, plan="community")
    db.add(user)
    db.flush()
    personal = Group(name=f"personal:{user.id}", personal_owner_id=user.id, created_by=user.id)
    team = Group(name=f"team-{user.id}", created_by=user.id)
    db.add_all([personal, team])
    db.flush()
    db.add_all([
        GroupMembership(user_id=user.id, group_id=personal.id, role="GROUP_MANAGER"),
        GroupMembership(user_id=user.id, group_id=team.id, role=role),
    ])
    db.commit()
    return user, personal, team


def test_create_direct_then_duplicate_and_move(db):
    user, personal, team = _user_with_space(db)
    created = prompt_service.create_or_propose(db, user, personal.id, "Hello", "Hi {{name}}")
    assert created.proposal is None and created.prompt.current_version_id

    copy = prompt_service.duplicate(db, user, created.prompt, personal)
    assert copy.title == "Hello (Copy)" and copy.group_id == personal.id

    prompt_service.move(db, copy, team)
    assert copy.group_id == team.id
    with pytest.raises(prompt_service.PromptError, match="already in this space"):
        prompt_service.move(db, copy, team)


def test_member_in_team_space_gets_a_proposal(db):
    user, _, team = _user_with_space(db, role="MEMBER")
    result = prompt_service.create_or_propose(db, user, team.id, "Team prompt", "body")
    assert result.proposal is not None
    assert result.prompt.is_archived
    assert db.query(PromptProposal).filter_by(prompt_id=result.prompt.id, status="PENDING").count() == 1


def test_quota_applies_to_create_and_duplicate(db, monkeypatch):
    user, personal, _ = _user_with_space(db)
    monkeypatch.setattr(prompt_service, "plan_info_for", lambda u: {"name": "Community", "max_prompts": 1})
    first = prompt_service.create_or_propose(db, user, personal.id, "One", "x").prompt
    with pytest.raises(prompt_service.PromptError) as err:
        prompt_service.create_or_propose(db, user, personal.id, "Two", "y")
    assert err.value.status_code == 403
    with pytest.raises(prompt_service.PromptError, match="Prompt limit reached"):
        prompt_service.duplicate(db, user, first, personal)
    assert db.query(Prompt).count() == 1
