"""Plan limits, quota checks and shared read-model helpers."""

import json


from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from permissions import (can_access_group_with_key)
from models import (ApiKey, Group, Prompt, PromptProposal, PromptVersion, User)

import services.prompts as prompt_service
from deps import (_active_key)


def _version_read(db: Session, version: PromptVersion, author_name: str | None = None) -> dict:
    if author_name is None:
        author = db.query(User).filter_by(id=version.author_id).first() if version.author_id else None
        resolved_author = author.name if author else "Unknown"
    else:
        resolved_author = author_name or "Unknown"
    return {"id": version.id, "prompt_id": version.prompt_id, "version_number": version.version_number,
            "content": version.content, "variables": json.loads(version.variables_json),
            "change_note": version.change_Note, "source_filename": version.source_filename,
            "author_id": version.author_id, "author_name": resolved_author,
            "created_at": version.created_at.isoformat() + "Z"}


from plans import PLAN_LIMITS_MAP, PLAN_TIERS  # noqa: F401  (re-exported)


def _check_prompt_quota(db: Session, user: User, group_id: str, new_prompts_count: int = 1) -> None:
    try:
        prompt_service.check_prompt_quota(db, user, new_prompts_count)
    except prompt_service.PromptError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


def _check_version_quota(db: Session, user: User, prompt: Prompt) -> None:
    if user.is_workspace_admin:
        return
    user_plan = getattr(user, "plan", "community") or "community"
    plan_info = PLAN_LIMITS_MAP.get(user_plan, PLAN_LIMITS_MAP["community"])
    max_versions = plan_info.get("max_versions_per_prompt", 10)
    max_ver = db.query(func.max(PromptVersion.version_number)).filter_by(prompt_id=prompt.id).scalar() or 0
    if max_ver >= max_versions:
        raise HTTPException(
            status_code=403,
            detail=f"This prompt has reached the maximum of {max_versions} versions on the {plan_info['name']} plan. Please upgrade to preserve more versions.",
        )


def _check_group_quota(db: Session, user: User) -> None:
    if user.is_workspace_admin:
        return
    user_plan = getattr(user, "plan", "community") or "community"
    plan_info = PLAN_LIMITS_MAP.get(user_plan, PLAN_LIMITS_MAP["community"])
    max_groups = plan_info.get("max_groups", 1)
    created_team_groups = db.query(Group).filter(Group.created_by == user.id, Group.personal_owner_id.is_(None)).count()
    if created_team_groups >= max_groups:
        raise HTTPException(
            status_code=403,
            detail=f"You have reached your limit of {max_groups} team group(s) on the {plan_info['name']} plan. Please upgrade to Team for more spaces.",
        )


_create_prompt = prompt_service.create_prompt


def _accessible_prompt(db: Session, user: User, prompt_id: str) -> Prompt:
    prompt = db.query(Prompt).filter_by(id=prompt_id).first()
    if prompt is None or not can_access_group_with_key(db, user, prompt.group_id, _active_key(user)):
        raise HTTPException(status_code=404, detail="Prompt not found")
    return prompt


def _api_key_read(db: Session, record: ApiKey) -> dict:
    group = db.query(Group).filter_by(id=record.group_id).first() if record.group_id else None
    is_personal = bool(group and group.personal_owner_id is not None)
    if record.scope_type == "GLOBAL":
        scope_label = "All Spaces + Personal"
    elif group:
        scope_label = "Personal" if is_personal else group.name
    else:
        scope_label = "Removed Group"
    return {
        "id": record.id,
        "name": record.name,
        "description": record.description,
        "key_prefix": record.key_prefix,
        "scope_type": record.scope_type,
        "access_level": getattr(record, "access_level", "READ_WRITE"),
        "group_id": record.group_id,
        "group_name": scope_label,
        "is_personal_group": is_personal,
        "is_active": record.is_active,
        "created_at": record.created_at.isoformat() + "Z",
        "last_used_at": (record.last_used_at.isoformat() + "Z") if record.last_used_at else None,
        "revoked_at": (record.revoked_at.isoformat() + "Z") if record.revoked_at else None,
    }



def _proposal_read(db: Session, proposal: PromptProposal, current_user_id: str, user_role: str | None) -> dict:
    proposer = db.query(User).filter_by(id=proposal.proposer_id).first()
    approvals_list = []
    has_approved = False
    for a in proposal.approvals:
        u = db.query(User).filter_by(id=a.user_id).first()
        if a.user_id == current_user_id:
            has_approved = True
        approvals_list.append({
            "id": a.id,
            "user_id": a.user_id,
            "user_name": u.name if u else "Unknown",
            "created_at": a.created_at.isoformat() + "Z",
        })
    group = db.query(Group).filter_by(id=proposal.group_id).first()
    required = getattr(group, "required_approvals", 1) if group else 1
    allow_self = bool(getattr(group, "allow_self_approval", False)) if group else False
    is_proposer = (proposal.proposer_id == current_user_id)
    self_approve_allowed = (not is_proposer) or allow_self
    can_approve = (user_role in {"GROUP_MANAGER", "MEMBER"}) and (not has_approved) and (proposal.status == "PENDING") and self_approve_allowed

    comments_list = []
    for c in (proposal.comments or []):
        cu = db.query(User).filter_by(id=c.user_id).first()
        comments_list.append({
            "id": c.id,
            "proposal_id": c.proposal_id,
            "user_id": c.user_id,
            "user_name": cu.name if cu else "Unknown",
            "comment": c.comment,
            "created_at": c.created_at.isoformat() + "Z",
        })

    return {
        "id": proposal.id,
        "prompt_id": proposal.prompt_id,
        "group_id": proposal.group_id,
        "proposer_id": proposal.proposer_id,
        "proposer_name": proposer.name if proposer else "Unknown",
        "proposer_email": proposer.email if proposer else "",
        "title": proposal.title,
        "description": proposal.description,
        "content": proposal.content,
        "change_note": proposal.change_note,
        "status": proposal.status,
        "created_at": proposal.created_at.isoformat() + "Z",
        "approvals": approvals_list,
        "approvals_count": len(approvals_list),
        "required_approvals": required,
        "allow_self_approval": allow_self,
        "can_approve": can_approve,
        "has_approved": has_approved,
        "comments": comments_list,
    }


