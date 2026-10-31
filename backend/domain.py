"""Plan limits, quota checks and shared read-model helpers."""

import json


from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from cache import (set_cached_active_version_uuid,
                   set_cached_version_by_uuid)
from permissions import (can_access_group_with_key, extract_variables)
from models import (ApiKey, Group, Prompt, PromptProposal, PromptVersion, User)
from search import sync_prompt_embeddings
from security import (sanitize_filename)

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


PLAN_TIERS = [
    {
        "id": "community",
        "name": "Community",
        "tagline": "Individual developers exploring version-controlled prompts and MCP in-chat access.",
        "price_monthly": 0,
        "price_annual": 0,
        "price_label": "$0",
        "max_prompts": 20,
        "max_versions_per_prompt": 10,
        "max_groups": 1,
        "free_guests_per_editor": 0,
        "mcp_monthly_calls": 1000,
        "storage_type": "Free Cloud Database (Supabase / SQLite)",
        "features": [
            "1 User · Personal space + 1 team group",
            "Up to 20 active prompts",
            "Last 10 versions per prompt",
            "Direct Save (instant versioning)",
            "FastMCP In-Chat Drawer & Personal API Key",
            "Word & sentence basic diff viewer",
        ],
    },
    {
        "id": "pro",
        "name": "Pro",
        "tagline": "Power prompt crafters and freelancers managing extensive prompt libraries.",
        "price_monthly": 5,
        "price_annual": 4,  # $48/year
        "price_label": "$5/mo",
        "max_prompts": 100,
        "max_versions_per_prompt": 50,
        "max_groups": 1,
        "free_guests_per_editor": 0,
        "mcp_monthly_calls": 10000,
        "storage_type": "Cloud DB + Bring Your Own Storage (Google Drive / Local)",
        "features": [
            "Everything in Community",
            "Up to 100 active prompts",
            "Up to 50 versions per prompt",
            "Word & Sentence Diff Viewer (Split & Inline)",
            "Shareable Zero-Config Diff Links",
            "Batch File Upload (.txt, .md, .csv, .json)",
            "Bring Your Own Storage (Google Drive & local sync)",
        ],
    },
    {
        "id": "team",
        "name": "Team",
        "badge": "Most Popular",
        "tagline": "Startups and product teams collaborating with approval workflows and RBAC.",
        "price_monthly": 12,
        "price_annual": 10,  # $120/year
        "price_label": "$10/editor/mo",
        "max_prompts": 500,
        "max_versions_per_prompt": 100,
        "max_groups": 5,
        "free_guests_per_editor": 2,
        "mcp_monthly_calls": 50000,
        "storage_type": "Team Cloud DB + Google Drive Team Sync",
        "features": [
            "Everything in Pro",
            "No seat minimums (starts at 1 editor)",
            "2 Free Read-Only Guests per paid editor",
            "Up to 500 prompts across 5 Team Groups",
            "Proposal & Approval Workflow (required_approvals)",
            "Central Review Requests Inbox & auto-merge",
            "3 Team MCP API Keys for automated agents",
            "Team Cloud & Google Drive Sync",
        ],
    },
    {
        "id": "enterprise",
        "name": "Enterprise",
        "tagline": "Organizations requiring self-hosting, strict compliance, and custom infrastructure.",
        "price_monthly": None,
        "price_annual": None,
        "price_label": "Contact Us",
        "max_prompts": 10000,
        "max_versions_per_prompt": 1000,
        "max_groups": 100,
        "free_guests_per_editor": 10,
        "mcp_monthly_calls": 1000000,
        "storage_type": "Self-Hosted Docker / VPC / Private PostgreSQL",
        "features": [
            "Everything in Team",
            "Self-Hosted Deployment (Docker / VPC / On-Prem)",
            "Dedicated PostgreSQL or custom DB cluster",
            "SSO / SAML 2.0 (Okta, Google Workspace, Azure AD)",
            "Custom prompt & version quotas",
            "Full Compliance & Audit Logs Export",
            "Dedicated SLA & onboarding support",
        ],
    },
]

PLAN_LIMITS_MAP = {tier["id"]: tier for tier in PLAN_TIERS}


def _check_prompt_quota(db: Session, user: User, group_id: str, new_prompts_count: int = 1) -> None:
    if user.is_workspace_admin:
        return
    user_plan = getattr(user, "plan", "community") or "community"
    plan_info = PLAN_LIMITS_MAP.get(user_plan, PLAN_LIMITS_MAP["community"])
    max_prompts = plan_info.get("max_prompts", 20)
    existing_count = db.query(Prompt).filter(Prompt.created_by == user.id, Prompt.is_archived.is_(False)).count()
    if existing_count + new_prompts_count > max_prompts:
        raise HTTPException(
            status_code=403,
            detail=f"Prompt limit reached ({existing_count}/{max_prompts}) for the {plan_info['name']} plan. Please upgrade to Pro or Team for more space.",
        )


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


def _create_prompt(db: Session, user: User, group_id: str, title: str, content: str,
                   description: str = "", change_note: str = "Initial creation", source_filename: str | None = None) -> Prompt:
    safe_title = (title.strip() or "Untitled prompt")[:240]
    safe_desc = (description or "")[:2000]
    safe_note = (change_note or "Initial creation")[:500]
    safe_source = sanitize_filename(source_filename) if source_filename else None
    prompt = Prompt(group_id=group_id, title=safe_title, description=safe_desc,
                    current_version_number=1, created_by=user.id)
    db.add(prompt)
    db.flush()
    v1 = PromptVersion(prompt_id=prompt.id, version_number=1, content=content,
                       variables_json=json.dumps(extract_variables(content)), change_Note=safe_note,
                       source_filename=safe_source, author_id=user.id)
    db.add(v1)
    db.flush()
    prompt.current_version_id = v1.id
    set_cached_version_by_uuid(v1.id, {"id": v1.id, "content": v1.content})
    set_cached_active_version_uuid(prompt.id, v1.id)
    sync_prompt_embeddings(db, prompt, v1)
    return prompt



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


