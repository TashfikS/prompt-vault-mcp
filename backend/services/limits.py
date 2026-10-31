"""Plan limits shared by REST routes and MCP tools.

Raises ``PlanLimitError`` (an HTTP-agnostic error); adapters translate it into
an HTTP 403 or an MCP tool error. Workspace admins are exempt everywhere.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import update
from sqlalchemy.orm import Session

from models import ApiKey, Group, GroupMembership, User
from plans import PLAN_LIMITS_MAP, plan_info_for

EDITOR_ROLES = ("GROUP_MANAGER", "MEMBER")
SEAT_PLANS = ("team",)


class PlanLimitError(Exception):
    status_code = 403


def require_feature(user: User, feature: str, label: str) -> None:
    """Block a paid-only feature (e.g. ``share_links``, ``batch_upload``) on plans without it."""
    if user.is_workspace_admin:
        return
    info = plan_info_for(user)
    if not info.get(feature):
        raise PlanLimitError(f"{label} is available on the Pro plan and above. Upgrade to use it.")


def check_api_key_quota(db: Session, user: User) -> None:
    if user.is_workspace_admin:
        return
    info = plan_info_for(user)
    limit = info.get("max_api_keys", 2)
    active = db.query(ApiKey).filter_by(user_id=user.id, is_active=True).count()
    if active >= limit:
        raise PlanLimitError(
            f"You have {active} of {limit} API keys allowed on the {info['name']} plan. "
            "Revoke an unused key or upgrade for more."
        )


def _current_month() -> str:
    return datetime.utcnow().strftime("%Y-%m")


def mcp_usage(user: User) -> int:
    return (user.mcp_usage_count or 0) if user.mcp_usage_month == _current_month() else 0


def record_mcp_call(db: Session, user: User) -> None:
    """Count one MCP tool call against the user's monthly quota, refusing once it is used up."""
    if user.is_workspace_admin:
        return
    info = plan_info_for(user)
    limit = info.get("mcp_monthly_calls", 1000)
    month = _current_month()
    if mcp_usage(user) >= limit:
        raise PlanLimitError(
            f"You've used all {limit:,} MCP calls included in the {info['name']} plan this month. "
            "The quota resets on the 1st (UTC), or upgrade for more."
        )
    if user.mcp_usage_month != month:
        # New month: reset only if no concurrent call already did.
        db.execute(
            update(User).where(User.id == user.id, (User.mcp_usage_month != month) | User.mcp_usage_month.is_(None))
            .values(mcp_usage_month=month, mcp_usage_count=0)
        )
    # Increment in SQL so concurrent calls don't lose counts.
    db.execute(update(User).where(User.id == user.id).values(mcp_usage_count=User.mcp_usage_count + 1))
    db.commit()
    db.refresh(user)


def team_seat_usage(db: Session, owner: User) -> dict:
    """Distinct editors and guests across the team groups ``owner`` created."""
    group_ids = [g.id for g in db.query(Group.id).filter(Group.created_by == owner.id, Group.personal_owner_id.is_(None))]
    if not group_ids:
        return {"editors": 1, "guests": 0}
    rows = db.query(GroupMembership.user_id, GroupMembership.role).filter(GroupMembership.group_id.in_(group_ids)).all()
    editors = {uid for uid, role in rows if role in EDITOR_ROLES}
    editors.add(owner.id)  # the subscriber always occupies one seat
    guests = {uid for uid, role in rows if role not in EDITOR_ROLES} - editors
    return {"editors": len(editors), "guests": len(guests)}


def check_member_seat(db: Session, actor: User, group: Group, target: User, new_role: str) -> None:
    """On per-editor plans, keep editors within paid seats and guests within the free allowance."""
    if actor.is_workspace_admin or not group.created_by:
        return
    owner = db.query(User).filter_by(id=group.created_by).first()
    if owner is None or (owner.plan or "community") not in SEAT_PLANS:
        return
    info = PLAN_LIMITS_MAP[owner.plan]
    seats = max(1, owner.billed_seats or 1)
    usage = team_seat_usage(db, owner)

    group_ids = [g.id for g in db.query(Group.id).filter(Group.created_by == owner.id, Group.personal_owner_id.is_(None))]
    roles = {role for (role,) in db.query(GroupMembership.role).filter(
        GroupMembership.user_id == target.id, GroupMembership.group_id.in_(group_ids)
    )} if group_ids else set()
    already_editor = target.id == owner.id or bool(roles & set(EDITOR_ROLES))
    already_guest = bool(roles) and not already_editor

    if new_role in EDITOR_ROLES:
        if not already_editor and usage["editors"] >= seats:
            raise PlanLimitError(
                f"All {seats} paid editor seat(s) on this team are in use. "
                "Add a seat in billing, or add this person as a read-only guest."
            )
    else:
        guest_limit = seats * info.get("free_guests_per_editor", 0)
        if not already_editor and not already_guest and usage["guests"] >= guest_limit:
            raise PlanLimitError(
                f"This team has used all {guest_limit} free guest seat(s) ({info.get('free_guests_per_editor', 0)} per paid editor). "
                "Add an editor seat to get more guests."
            )
