"""Explicit helpers for PromptFolders's Role-Based Access Control (RBAC) and group permissions."""

import re

from fastapi import HTTPException
from sqlalchemy.orm import Session

from models import ApiKey, Group, GroupMembership, User

VARIABLE_PATTERN = re.compile(r"\{\{\s*([a-zA-Z0-9_ -]+)\s*\}\}")


def extract_variables(text: str) -> list[str]:
    return list(dict.fromkeys(match.strip() for match in VARIABLE_PATTERN.findall(text)))


def group_display_name(group: Group) -> str:
    return "Personal" if group.personal_owner_id else group.name


def ensure_personal_group(db: Session, user: User) -> Group:
    """Return the user's private Personal space, creating it (with the user as its only manager) if needed."""
    group = db.query(Group).filter_by(personal_owner_id=user.id).first()
    if group is None:
        db_user = db.query(User).filter_by(id=user.id).first()
        if db_user is None:
            db_user = User(
                id=user.id,
                name=user.name,
                email=user.email,
                is_workspace_admin=user.is_workspace_admin,
                plan=getattr(user, "plan", "community") or "community",
                password_hash=getattr(user, "password_hash", None),
            )
            db.add(db_user)
            db.flush()
        group = Group(name=f"personal:{user.id}", description="Private prompts only you can see.",
                      created_by=user.id, personal_owner_id=user.id)
        db.add(group)
        db.flush()
        db.add(GroupMembership(user_id=user.id, group_id=group.id, role="GROUP_MANAGER"))
        db.commit()
    return group


def ensure_all_personal_groups(db: Session) -> None:
    """Create missing Personal spaces with one query instead of one per user (cheap on every boot)."""
    has_personal = db.query(Group.personal_owner_id).filter(Group.personal_owner_id.isnot(None))
    for user in db.query(User).filter(User.id.notin_(has_personal)).all():
        ensure_personal_group(db, user)


def get_user_group_ids(db: Session, user: User) -> list[str]:
    if user.is_workspace_admin:
        rows = db.query(Group.id).filter((Group.personal_owner_id.is_(None)) | (Group.personal_owner_id == user.id)).order_by(Group.name).all()
        return [row[0] for row in rows]
    return [row[0] for row in db.query(GroupMembership.group_id).filter(GroupMembership.user_id == user.id).all()]


def get_scoped_group_ids(db: Session, user: User, api_key: ApiKey | None = None) -> list[str]:
    """Return accessible group IDs filtered by the API key's scope (GLOBAL vs GROUP)."""
    base_ids = get_user_group_ids(db, user)
    if api_key is not None and api_key.scope_type == "GROUP":
        if api_key.group_id and api_key.group_id in base_ids:
            return [api_key.group_id]
        return []
    return base_ids


def _is_someone_elses_personal_group(db: Session, user: User, group_id: str) -> bool:
    owner = db.query(Group.personal_owner_id).filter_by(id=group_id).scalar()
    return owner is not None and owner != user.id


def can_user_view_group(db: Session, user: User, group_id: str) -> bool:
    if user.is_workspace_admin and not _is_someone_elses_personal_group(db, user, group_id):
        return True
    return db.query(GroupMembership.id).filter_by(user_id=user.id, group_id=group_id).first() is not None


def can_access_group_with_key(db: Session, user: User, group_id: str, api_key: ApiKey | None = None) -> bool:
    """Verify both user membership/admin access and optional single-group API key scope."""
    if not can_user_view_group(db, user, group_id):
        return False
    if api_key is not None and api_key.scope_type == "GROUP":
        return api_key.group_id == group_id
    return True


def can_user_manage_group_members(db: Session, user: User, group_id: str) -> bool:
    if user.is_workspace_admin and not _is_someone_elses_personal_group(db, user, group_id):
        return True
    membership = db.query(GroupMembership).filter_by(user_id=user.id, group_id=group_id).first()
    if membership and membership.role == "GROUP_MANAGER":
        return True
    raise HTTPException(status_code=403, detail="Only Workspace Admins or the Group Leader/Manager of this group can perform this action.")


def get_user_group_role(db: Session, user: User, group_id: str) -> str | None:
    group = db.query(Group).filter_by(id=group_id).first()
    if not group:
        return None
    if group.personal_owner_id == user.id:
        return "GROUP_MANAGER"
    if user.is_workspace_admin and not group.personal_owner_id:
        return "GROUP_MANAGER"
    membership = db.query(GroupMembership).filter_by(user_id=user.id, group_id=group_id).first()
    return membership.role if membership else None


def can_user_direct_write_prompt(db: Session, user: User, group_id: str) -> bool:
    return get_user_group_role(db, user, group_id) == "GROUP_MANAGER"


def can_user_approve_proposals(db: Session, user: User, group_id: str) -> bool:
    role = get_user_group_role(db, user, group_id)
    return role in {"GROUP_MANAGER", "MEMBER"}


def require_workspace_admin(user: User) -> None:
    if not user.is_workspace_admin:
        raise HTTPException(status_code=403, detail="Only a Workspace Admin can perform this action.")
