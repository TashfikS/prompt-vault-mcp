"""Prompt create / duplicate / move core shared by REST (routers/prompts.py) and MCP (mcp_server.py).

Adapters keep authentication, group-role checks, audit logging and response
shapes; this module owns plan quotas and the database writes, so a prompt
created or copied from chat follows exactly the same rules as one from the web UI.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session

from cache import invalidate_prompt_cache, set_cached_active_version_uuid, set_cached_version_by_uuid
from plans import plan_info_for
from models import Group, Prompt, PromptProposal, PromptVersion, User
from permissions import can_user_direct_write_prompt, extract_variables, group_display_name
from search import sync_prompt_embeddings
from security import sanitize_filename


class PromptError(Exception):
    """Business-rule violation. ``status_code`` is the HTTP status REST should use."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass
class CreateResult:
    prompt: Prompt
    proposal: PromptProposal | None = None  # set when a Member's new prompt needs team review


def check_prompt_quota(db: Session, user: User, new_prompts_count: int = 1) -> None:
    if user.is_workspace_admin:
        return
    plan_info = plan_info_for(user)
    max_prompts = plan_info.get("max_prompts", 20)
    existing_count = db.query(Prompt).filter(Prompt.created_by == user.id, Prompt.is_archived.is_(False)).count()
    if existing_count + new_prompts_count > max_prompts:
        raise PromptError(
            f"Prompt limit reached ({existing_count}/{max_prompts}) for the {plan_info['name']} plan. "
            "Please upgrade to Pro or Team for more space.",
            status_code=403,
        )


def create_prompt(db: Session, user: User, group_id: str, title: str, content: str,
                  description: str = "", change_note: str = "Initial creation",
                  source_filename: str | None = None) -> Prompt:
    """Create a prompt with an active v1 (no permission or quota checks; callers do those)."""
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


def create_or_propose(db: Session, user: User, group_id: str, title: str, content: str,
                      description: str = "", change_note: str = "Initial creation",
                      source_filename: str | None = None) -> CreateResult:
    """Create directly where the user may write; otherwise open a review proposal (commits)."""
    check_prompt_quota(db, user)
    if can_user_direct_write_prompt(db, user, group_id):
        prompt = create_prompt(db, user, group_id, title, content, description, change_note, source_filename)
        db.commit()
        db.refresh(prompt)
        return CreateResult(prompt=prompt)

    safe_title = (title.strip() or "Untitled prompt")[:240]
    safe_desc = (description or "")[:2000]
    prompt = Prompt(group_id=group_id, title=safe_title, description=safe_desc,
                    current_version_number=1, created_by=user.id, is_archived=True)
    db.add(prompt)
    db.flush()
    proposal = PromptProposal(
        prompt_id=prompt.id,
        group_id=group_id,
        proposer_id=user.id,
        title=safe_title,
        description=safe_desc,
        content=content,
        change_note=(change_note or "Initial creation proposal")[:500],
        status="PENDING",
    )
    db.add(proposal)
    db.commit()
    db.refresh(proposal)
    return CreateResult(prompt=prompt, proposal=proposal)


def move(db: Session, prompt: Prompt, target_group: Group, new_title: str = "") -> str:
    """Move a prompt (and its proposals) to another space. Returns the old group id (commits)."""
    if prompt.group_id == target_group.id:
        raise PromptError("The prompt is already in this space.")
    old_group_id = prompt.group_id
    prompt.group_id = target_group.id
    if new_title.strip():
        prompt.title = new_title.strip()[:240]
    prompt.updated_at = datetime.utcnow()
    db.query(PromptProposal).filter_by(prompt_id=prompt.id).update({"group_id": target_group.id})
    db.commit()
    db.refresh(prompt)
    invalidate_prompt_cache(prompt.id)
    return old_group_id


def active_version(db: Session, prompt: Prompt) -> PromptVersion | None:
    version = None
    if prompt.current_version_id:
        version = db.query(PromptVersion).filter_by(id=prompt.current_version_id).first()
    if not version:
        version = db.query(PromptVersion).filter_by(
            prompt_id=prompt.id, version_number=prompt.current_version_number).first()
    if not version:
        version = (db.query(PromptVersion).filter_by(prompt_id=prompt.id)
                   .order_by(PromptVersion.version_number.desc()).first())
    return version


def duplicate(db: Session, user: User, prompt: Prompt, target_group: Group, new_title: str = "") -> Prompt:
    """Copy the prompt's active version into ``target_group`` as a new prompt (commits)."""
    source = active_version(db, prompt)
    if not source:
        raise PromptError("Source prompt has no content to duplicate.")
    check_prompt_quota(db, user)

    if new_title.strip():
        title = new_title.strip()[:240]
    elif prompt.group_id == target_group.id:
        title = f"{prompt.title} (Copy)"[:240]
    else:
        title = prompt.title[:240]

    source_group = db.query(Group).filter_by(id=prompt.group_id).first()
    src_name = group_display_name(source_group) if source_group else "Source space"
    new_prompt = create_prompt(
        db, user, target_group.id, title, source.content,
        description=prompt.description,
        change_note=f"Duplicated from {src_name} (v{prompt.current_version_number})",
        source_filename=source.source_filename,
    )
    db.commit()
    db.refresh(new_prompt)
    return new_prompt
