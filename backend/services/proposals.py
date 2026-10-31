"""Proposal review core shared by the REST API (main.py) and MCP tools (mcp_server.py).

Adapters keep their own authentication / role checks and error types; this module
owns the state rules (pending-only, self-approval, one vote per reviewer) and the
merge that publishes a new prompt version, so both surfaces cannot drift apart.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func
from sqlalchemy.orm import Session

from cache import invalidate_prompt_cache, set_cached_active_version_uuid, set_cached_version_by_uuid
from models import Group, Prompt, PromptProposal, PromptVersion, ProposalApproval, ProposalComment, User
from permissions import extract_variables
from search import sync_prompt_embeddings


class ProposalError(Exception):
    """Business-rule violation. ``status_code`` is the HTTP status REST should use."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass
class ApprovalResult:
    merged: bool
    approvals_count: int
    required_approvals: int
    version: PromptVersion | None = None


def ensure_pending(proposal: PromptProposal) -> None:
    if proposal.status != "PENDING":
        raise ProposalError(f"Proposal is already {proposal.status.lower()}.")


def _add_comment(db: Session, proposal: PromptProposal, user: User, comment: str | None, prefix: str = "") -> None:
    text = (comment or "").strip()[:2000]
    if text:
        db.add(ProposalComment(proposal_id=proposal.id, user_id=user.id, comment=f"{prefix}{text}"))


def reject(db: Session, proposal: PromptProposal, user: User, comment: str | None = None, comment_prefix: str = "") -> None:
    ensure_pending(proposal)
    proposal.status = "REJECTED"
    _add_comment(db, proposal, user, comment, comment_prefix)
    db.commit()


def approve(
    db: Session,
    proposal: PromptProposal,
    prompt: Prompt,
    user: User,
    comment: str | None = None,
    comment_prefix: str = "",
) -> ApprovalResult:
    """Record ``user``'s approval and merge once the group's required count is reached."""
    ensure_pending(proposal)
    group = db.query(Group).filter_by(id=proposal.group_id).first()
    allow_self = bool(getattr(group, "allow_self_approval", False)) if group else False
    if proposal.proposer_id == user.id and not allow_self:
        raise ProposalError("You cannot approve your own proposal because self-approval is disabled for this group.")
    if db.query(ProposalApproval).filter_by(proposal_id=proposal.id, user_id=user.id).first():
        raise ProposalError("You have already approved this proposal.")

    db.add(ProposalApproval(proposal_id=proposal.id, user_id=user.id))
    _add_comment(db, proposal, user, comment, comment_prefix)
    db.flush()

    total = db.query(ProposalApproval).filter_by(proposal_id=proposal.id).count()
    required = getattr(group, "required_approvals", 1) if group else 1
    if total < required:
        db.commit()
        return ApprovalResult(merged=False, approvals_count=total, required_approvals=required)

    version = merge(db, proposal, prompt)
    return ApprovalResult(merged=True, approvals_count=total, required_approvals=required, version=version)


def merge(db: Session, proposal: PromptProposal, prompt: Prompt) -> PromptVersion:
    """Publish the proposal as the prompt's new active version (commits)."""
    proposal.status = "APPROVED"
    is_initial_creation = (prompt.current_version_id is None) or prompt.is_archived
    variables_list = extract_variables(proposal.content)
    prompt.title = proposal.title
    if proposal.description:
        prompt.description = proposal.description
    prompt.updated_at = datetime.utcnow()

    if is_initial_creation:
        prompt.is_archived = False
        prompt.current_version_number = 1
        note = f"[Approved Creation] {proposal.change_note}"
    else:
        max_ver = db.query(func.max(PromptVersion.version_number)).filter_by(prompt_id=prompt.id).scalar() or 0
        prompt.current_version_number = max_ver + 1
        note = f"[Approved] {proposal.change_note}"

    version = PromptVersion(
        prompt_id=prompt.id,
        version_number=prompt.current_version_number,
        content=proposal.content,
        variables_json=json.dumps(variables_list),
        change_Note=note[:500],
        author_id=proposal.proposer_id,
    )
    db.add(version)
    db.flush()
    prompt.current_version_id = version.id
    db.commit()

    invalidate_prompt_cache(prompt.id)
    set_cached_version_by_uuid(
        version.id,
        {
            "id": version.id,
            "prompt_id": prompt.id,
            "title": prompt.title,
            "version_number": version.version_number,
            "content": version.content,
            "variables": variables_list,
        },
    )
    set_cached_active_version_uuid(prompt.id, version.id)
    sync_prompt_embeddings(db, prompt, version)
    return version
