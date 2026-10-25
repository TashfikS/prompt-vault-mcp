"""Unit tests for RBAC permission helpers and authentication logic."""

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from auth import hash_password, verify_password
from permissions import (
    can_user_approve_proposals,
    can_user_direct_write_prompt,
    can_user_manage_group_members,
    can_user_view_group,
    ensure_personal_group,
    extract_variables,
    get_user_group_ids,
    get_user_group_role,
)
from models import Group, GroupMembership, PromptVersion, User


def test_extract_variables():
    # Normal variables
    text = "Hello {{name}}, your balance is {{ amount }}."
    assert extract_variables(text) == ["name", "amount"]

    # Variable with hyphens and underscores
    text = "Deploy {{service-name}} in {{env_region-01}}"
    assert extract_variables(text) == ["service-name", "env_region-01"]

    # Deduplication and preservation of order
    text = "Hi {{user}}, please confirm {{user}}'s email {{ email }}."
    assert extract_variables(text) == ["user", "email"]

    # No variables
    assert extract_variables("Plain text without curly braces") == []
    assert extract_variables("") == []

    # Malformed / incomplete braces
    assert extract_variables("Single brace {not_var} and broken {{unclosed") == []


def test_password_hashing():
    password = "CorrectHorseBattery99!"
    hashed = hash_password(password)

    # Valid format: pbkdf2_sha256$iterations$salt$hash
    parts = hashed.split("$")
    assert len(parts) == 4
    assert parts[0] == "pbkdf2_sha256"

    # Verifications
    assert verify_password(password, hashed) is True
    assert verify_password("WrongPassword123", hashed) is False
    assert verify_password("", hashed) is False
    assert verify_password(password, None) is False
    assert verify_password(password, "invalid_hash_string") is False


def test_ensure_personal_group(db: Session):
    user = User(name="Test User", email="personal_test@test.com", password_hash="dummy")
    db.add(user)
    db.flush()

    group1 = ensure_personal_group(db, user)
    assert group1.personal_owner_id == user.id
    assert group1.name == f"personal:{user.id}"

    # Verify user is assigned GROUP_MANAGER
    membership = db.query(GroupMembership).filter_by(user_id=user.id, group_id=group1.id).first()
    assert membership is not None
    assert membership.role == "GROUP_MANAGER"

    # Idempotence: calling again returns the exact same group
    group2 = ensure_personal_group(db, user)
    assert group2.id == group1.id


def test_rbac_group_visibility(db: Session, test_users_and_groups):
    fixtures = test_users_and_groups
    admin = fixtures["admin"]
    owner = fixtures["owner"]
    guest = fixtures["guest"]
    outsider = fixtures["outsider"]
    team_group = fixtures["team_group"]

    owner_personal = ensure_personal_group(db, owner)

    # Team group visibility
    assert can_user_view_group(db, admin, team_group.id) is True
    assert can_user_view_group(db, owner, team_group.id) is True
    assert can_user_view_group(db, guest, team_group.id) is True
    assert can_user_view_group(db, outsider, team_group.id) is False

    # Personal space isolation: Admin CANNOT view another user's personal group
    assert can_user_view_group(db, admin, owner_personal.id) is False
    assert can_user_view_group(db, owner, owner_personal.id) is True
    assert can_user_view_group(db, outsider, owner_personal.id) is False


def test_rbac_group_ids_scoping(db: Session, test_users_and_groups):
    fixtures = test_users_and_groups
    admin = fixtures["admin"]
    owner = fixtures["owner"]
    outsider = fixtures["outsider"]
    team_group = fixtures["team_group"]

    admin_personal = ensure_personal_group(db, admin)
    owner_personal = ensure_personal_group(db, owner)

    admin_groups = get_user_group_ids(db, admin)
    assert team_group.id in admin_groups
    assert admin_personal.id in admin_groups
    assert owner_personal.id not in admin_groups  # Strictly isolated

    owner_groups = get_user_group_ids(db, owner)
    assert team_group.id in owner_groups
    assert owner_personal.id in owner_groups
    assert admin_personal.id not in owner_groups

    outsider_groups = get_user_group_ids(db, outsider)
    assert team_group.id not in outsider_groups


def test_rbac_manage_group_members(db: Session, test_users_and_groups):
    fixtures = test_users_and_groups
    admin = fixtures["admin"]
    owner = fixtures["owner"]
    member = fixtures["member"]
    guest = fixtures["guest"]
    team_group = fixtures["team_group"]

    # Admin and Group Owner can manage
    assert can_user_manage_group_members(db, admin, team_group.id) is True
    assert can_user_manage_group_members(db, owner, team_group.id) is True

    # Members and Guests are denied with 403
    with pytest.raises(HTTPException) as exc_info:
        can_user_manage_group_members(db, member, team_group.id)
    assert exc_info.value.status_code == 403

    with pytest.raises(HTTPException) as exc_info:
        can_user_manage_group_members(db, guest, team_group.id)
    assert exc_info.value.status_code == 403


def test_rbac_approve_proposals(db: Session, test_users_and_groups):
    fixtures = test_users_and_groups
    owner = fixtures["owner"]
    member = fixtures["member"]
    guest = fixtures["guest"]
    outsider = fixtures["outsider"]
    team_group = fixtures["team_group"]

    # Owners and Members can vote
    assert can_user_approve_proposals(db, owner, team_group.id) is True
    assert can_user_approve_proposals(db, member, team_group.id) is True

    # Guests and Outsiders cannot vote
    assert can_user_approve_proposals(db, guest, team_group.id) is False
    assert can_user_approve_proposals(db, outsider, team_group.id) is False


def test_rbac_direct_write_prompt(db: Session, test_users_and_groups):
    """Verify Workspace Admins, Group Owners, and Personal Space Owners write directly; Members and Guests do not."""
    fixtures = test_users_and_groups
    admin = fixtures["admin"]
    owner = fixtures["owner"]
    member = fixtures["member"]
    guest = fixtures["guest"]
    outsider = fixtures["outsider"]
    team_group = fixtures["team_group"]

    owner_personal = ensure_personal_group(db, owner)

    assert can_user_direct_write_prompt(db, admin, team_group.id) is True
    assert can_user_direct_write_prompt(db, owner, team_group.id) is True
    assert can_user_direct_write_prompt(db, member, team_group.id) is False
    assert can_user_direct_write_prompt(db, guest, team_group.id) is False
    assert can_user_direct_write_prompt(db, outsider, team_group.id) is False

    # Personal space: only owner can direct write (even Admin cannot write to another user's personal space)
    assert can_user_direct_write_prompt(db, owner, owner_personal.id) is True
    assert can_user_direct_write_prompt(db, admin, owner_personal.id) is False


def test_prompt_version_change_note_property_alias():
    """Verify PromptVersion supports both change_note and change_Note seamlessly."""
    v = PromptVersion(prompt_id="p1", version_number=1, content="Hello", variables_json="[]", change_Note="Initial")
    assert v.change_note == "Initial"
    assert v.change_Note == "Initial"
    v.change_note = "Updated via snake_case property"
    assert v.change_Note == "Updated via snake_case property"
    assert v.change_note == "Updated via snake_case property"

