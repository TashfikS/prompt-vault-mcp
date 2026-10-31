"""groups API routes."""

from datetime import datetime


from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from database import (
    get_db,
)
from permissions import (can_user_manage_group_members, ensure_personal_group, get_scoped_group_ids, group_display_name, require_workspace_admin)
from models import (Group, GroupMembership, User)
from schemas import (AssignMemberRequest, GroupCreate, GroupSettingsUpdate)
from security import (get_client_ip, record_audit_log)

from deps import (current_user, _active_key, _require_web_session)
from domain import (_check_group_quota)
from services.limits import PlanLimitError, check_member_seat

router = APIRouter()


@router.get("/api/groups")
def list_groups(db: Session = Depends(get_db), user: User = Depends(current_user)) -> list[dict]:
    ensure_personal_group(db, user)
    ids = get_scoped_group_ids(db, user, _active_key(user))
    groups = db.query(Group).filter(Group.id.in_(ids)).order_by(Group.name).all() if ids else []
    groups.sort(key=lambda group: group.personal_owner_id is None)
    result = []
    for group in groups:
        members = db.query(GroupMembership, User).join(User).filter(GroupMembership.group_id == group.id).order_by(User.name).all()
        result.append({"id": group.id, "name": group_display_name(group), "description": group.description,
                       "is_personal": group.personal_owner_id is not None,
                       "required_approvals": getattr(group, "required_approvals", 1),
                       "allow_self_approval": bool(getattr(group, "allow_self_approval", False)),
                       "members": [{"user_id": membership.user_id, "name": member.name, "email": member.email,
                                    "role": membership.role, "added_at": (membership.added_at.isoformat() if getattr(membership, "added_at", None) else datetime.utcnow().isoformat()) + "Z"}
                                   for membership, member in members]})
    return result


@router.put("/api/groups/{group_id}/settings")
@router.patch("/api/groups/{group_id}/settings")
def update_group_settings(group_id: str, payload: GroupSettingsUpdate, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_web_session(user)
    can_user_manage_group_members(db, user, group_id)
    group = db.query(Group).filter_by(id=group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found.")
    if group.personal_owner_id:
        raise HTTPException(status_code=400, detail="Personal space does not require approval settings.")
    if payload.required_approvals is not None:
        group.required_approvals = payload.required_approvals
    if payload.allow_self_approval is not None:
        group.allow_self_approval = payload.allow_self_approval
    db.commit()
    record_audit_log(db, "GROUP_SETTINGS_UPDATED", user_id=user.id, ip_address=get_client_ip(request), target_type="group", target_id=group.id, details=f"required_approvals={group.required_approvals}, allow_self_approval={group.allow_self_approval}")
    return {"group_id": group.id, "required_approvals": group.required_approvals, "allow_self_approval": bool(getattr(group, "allow_self_approval", False))}


@router.post("/api/groups", status_code=201)
def create_group(payload: GroupCreate, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    """Any signed-in user may create a group. The creator leads it, unless a Workspace Admin picks another leader."""
    _require_web_session(user)
    _check_group_quota(db, user)
    name = payload.name.strip()
    if not name or name.lower().startswith("personal"):
        raise HTTPException(status_code=400, detail="Please choose a different group name.")
    if db.query(Group).filter_by(name=name).first():
        raise HTTPException(status_code=409, detail="A group with this name already exists.")
    leader = user
    if payload.manager_user_id and payload.manager_user_id != user.id:
        require_workspace_admin(user)
        leader = db.query(User).filter_by(id=payload.manager_user_id).first()
        if not leader:
            raise HTTPException(status_code=404, detail="Selected user not found.")
    group = Group(name=name, description=payload.description.strip(), created_by=user.id)
    db.add(group)
    db.flush()
    db.add(GroupMembership(user_id=leader.id, group_id=group.id, role="GROUP_MANAGER"))
    db.commit()
    record_audit_log(db, "GROUP_CREATED", user_id=user.id, ip_address=get_client_ip(request), target_type="group", target_id=group.id, details=f"Created group '{group.name}'")
    return {"id": group.id, "name": group.name, "description": group.description}


@router.post("/api/groups/{group_id}/members", status_code=201)
def add_member(group_id: str, payload: AssignMemberRequest, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_web_session(user)
    can_user_manage_group_members(db, user, group_id)
    group = db.query(Group).filter_by(id=group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found.")
    if group.personal_owner_id:
        raise HTTPException(status_code=400, detail="Your Personal space is private. Create a group to share prompts with others.")
    if payload.role == "GROUP_MANAGER" and not user.is_workspace_admin:
        raise HTTPException(status_code=403, detail="Only a Workspace Admin can assign Group Managers.")
    if payload.user_id:
        target = db.query(User).filter_by(id=payload.user_id).first()
    else:
        target = db.query(User).filter(User.email == (payload.email or "").strip().lower()).first()
    if not target:
        raise HTTPException(status_code=404, detail="No PromptHold account uses that email yet. Ask them to sign up first, then add them.")
    try:
        check_member_seat(db, user, group, target, payload.role)
    except PlanLimitError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    membership = db.query(GroupMembership).filter_by(user_id=target.id, group_id=group_id).first()
    if membership:
        if membership.role == "GROUP_MANAGER" and not user.is_workspace_admin:
            raise HTTPException(status_code=403, detail="Only a Workspace Admin can change a Group Manager's membership.")
        if payload.role == "GROUP_MANAGER" and not user.is_workspace_admin:
            raise HTTPException(status_code=403, detail="Only a Workspace Admin can assign Group Managers.")
        membership.role = payload.role
    else:
        membership = GroupMembership(user_id=target.id, group_id=group_id, role=payload.role)
        db.add(membership)
    db.commit()
    record_audit_log(db, "GROUP_MEMBER_ASSIGNED", user_id=user.id, ip_address=get_client_ip(request), target_type="group", target_id=group_id, details=f"Assigned {target.email} as {membership.role}")
    return {"user_id": target.id, "name": target.name, "role": membership.role}


@router.delete("/api/groups/{group_id}/members/{target_user_id}")
def remove_member(group_id: str, target_user_id: str, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_web_session(user)
    can_user_manage_group_members(db, user, group_id)
    group = db.query(Group).filter_by(id=group_id).first()
    if group and group.personal_owner_id:
        raise HTTPException(status_code=400, detail="You cannot leave your own Personal space.")
    membership = db.query(GroupMembership).filter_by(group_id=group_id, user_id=target_user_id).first()
    if not membership:
        raise HTTPException(status_code=404, detail="Group membership not found.")
    if membership.role == "GROUP_MANAGER" and not user.is_workspace_admin:
        raise HTTPException(status_code=403, detail="Only a Workspace Admin can remove a Group Manager.")
    db.delete(membership)
    db.commit()
    record_audit_log(db, "GROUP_MEMBER_REMOVED", user_id=user.id, ip_address=get_client_ip(request), target_type="group", target_id=group_id, details=f"Removed user {target_user_id}")
    return {"removed": True}


