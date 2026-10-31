"""Pytest configuration and test fixtures for PromptFolders backend."""

from datetime import datetime

import os
import sys
from pathlib import Path
from typing import AsyncGenerator, Generator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

# Ensure backend directory is in sys.path
backend_dir = Path(__file__).resolve().parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

# Pin the environment before backend modules load .env (load_dotenv does not override existing vars),
# so a local production .env cannot change test behavior.
os.environ["PROMPT_HOLD_ENV"] = "development"
# Tests register @example.com users and must never call the Have I Been Pwned API;
# test_credential_policy.py covers both checks explicitly.
os.environ["ALLOWED_TEST_EMAIL_DOMAINS"] = "example.com"
os.environ["PWNED_PASSWORD_CHECK"] = "0"

from auth import create_session, hash_password, upgrade_schema
from database import Base, get_db
from permissions import ensure_personal_group
from main import app
from models import Group, GroupMembership, Prompt, PromptVersion, User
from security import rate_limiter

# In-memory SQLite engine with StaticPool so all connections share the same memory database
TEST_DATABASE_URL = "sqlite:///:memory:"
test_engine = create_engine(
    TEST_DATABASE_URL,
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=test_engine, autoflush=False, autocommit=False)


@pytest.fixture(scope="session", autouse=True)
def setup_test_db():
    Base.metadata.create_all(bind=test_engine)
    upgrade_schema(test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture(autouse=True)
def clear_rate_limits(monkeypatch):
    """Give every test a fresh, in-memory rate limiter.

    With REDIS_URL set (as in CI), hits would otherwise be stored in Redis and
    carry over between tests, so e.g. the sign-up limit trips after 5 tests.
    """
    monkeypatch.setattr(type(rate_limiter), "_redis", lambda self: None)
    with rate_limiter._lock:
        rate_limiter._hits.clear()
    yield


@pytest.fixture(autouse=True)
def db() -> Generator[Session, None, None]:
    connection = test_engine.connect()
    transaction = connection.begin()
    session = TestingSessionLocal(bind=connection)

    # Dependency override for FastAPI app
    def override_get_db():
        try:
            yield session
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db

    yield session

    session.close()
    transaction.rollback()
    connection.close()
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def test_users_and_groups(db: Session):
    """Create test users and groups for RBAC permissions testing."""
    pw_hash = hash_password("Password1234")

    admin = User(name="Admin User", email="admin@test.com", password_hash=pw_hash, is_workspace_admin=True)
    owner = User(name="Group Owner", email="owner@test.com", password_hash=pw_hash, is_workspace_admin=False)
    member = User(name="Team Member", email="member@test.com", password_hash=pw_hash, is_workspace_admin=False)
    member2 = User(name="Second Member", email="member2@test.com", password_hash=pw_hash, is_workspace_admin=False)
    guest = User(name="Guest User", email="guest@test.com", password_hash=pw_hash, is_workspace_admin=False)
    outsider = User(name="Outsider User", email="outsider@test.com", password_hash=pw_hash, is_workspace_admin=False)

    for u in [admin, owner, member, member2, guest, outsider]:
        u.email_verified_at = datetime.utcnow()  # established accounts
    db.add_all([admin, owner, member, member2, guest, outsider])
    db.flush()

    # Ensure personal spaces
    for u in [admin, owner, member, member2, guest, outsider]:
        ensure_personal_group(db, u)

    # Team Group
    team_group = Group(
        name="Engineering Team",
        description="Engineering prompts repository",
        created_by=owner.id,
        required_approvals=1,
    )
    db.add(team_group)
    db.flush()

    # Memberships
    m_owner = GroupMembership(user_id=owner.id, group_id=team_group.id, role="GROUP_MANAGER")
    m_member = GroupMembership(user_id=member.id, group_id=team_group.id, role="MEMBER")
    m_member2 = GroupMembership(user_id=member2.id, group_id=team_group.id, role="MEMBER")
    m_guest = GroupMembership(user_id=guest.id, group_id=team_group.id, role="GUEST")
    db.add_all([m_owner, m_member, m_member2, m_guest])
    db.flush()

    # Sample prompt in team group created by owner
    team_prompt = Prompt(
        group_id=team_group.id,
        title="Code Reviewer Prompt",
        description="Standard code review guidelines",
        current_version_number=1,
        created_by=owner.id,
    )
    db.add(team_prompt)
    db.flush()

    v1 = PromptVersion(
        prompt_id=team_prompt.id,
        version_number=1,
        content="Review code for {{language}} and check {{style_guide}} rules.",
        variables_json='["language", "style_guide"]',
        change_Note="Initial version",
        author_id=owner.id,
    )
    db.add(v1)
    db.flush()
    team_prompt.current_version_id = v1.id

    # Create session tokens
    tokens = {
        "admin": create_session(db, admin),
        "owner": create_session(db, owner),
        "member": create_session(db, member),
        "member2": create_session(db, member2),
        "guest": create_session(db, guest),
        "outsider": create_session(db, outsider),
    }

    db.commit()

    return {
        "admin": admin,
        "owner": owner,
        "member": member,
        "member2": member2,
        "guest": guest,
        "outsider": outsider,
        "team_group": team_group,
        "team_prompt": team_prompt,
        "tokens": tokens,
    }


@pytest_asyncio.fixture
async def client() -> AsyncGenerator[AsyncClient, None]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac
