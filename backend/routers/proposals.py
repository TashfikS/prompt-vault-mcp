"""proposals API routes."""



from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import (
    get_db,
)
from permissions import (can_access_group_with_key, can_user_approve_proposals, get_scoped_group_ids, get_user_group_role)
from models import (Group, Prompt, PromptProposal, PromptVersion, ProposalComment, User)
import services.proposals as proposal_service
from schemas import (ProposalCommentCreate, ProposalCreateRequest, ProposalReviewAction)

from deps import (current_user, _active_key, _require_write_permission)
from domain import (_accessible_prompt, _proposal_read)

router = APIRouter()


@router.get("/api/proposals")
def list_all_proposals(
    group_id: str | None = None,
    status: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> list[dict]:
    group_ids = get_scoped_group_ids(db, user, _active_key(user))
    if group_id:
        if group_id not in group_ids:
            raise HTTPException(status_code=403, detail="You do not have access to this group.")
        target_group_ids = [group_id]
    else:
        target_group_ids = group_ids

    query = db.query(PromptProposal).filter(PromptProposal.group_id.in_(target_group_ids))
    if status:
        query = query.filter(PromptProposal.status == status.upper())

    proposals = query.order_by(PromptProposal.created_at.desc()).all()
    results = []
    for p in proposals:
        role = get_user_group_role(db, user, p.group_id)
        read_data = _proposal_read(db, p, user.id, role)
        prompt = db.query(Prompt).filter_by(id=p.prompt_id).first()
        group = db.query(Group).filter_by(id=p.group_id).first()
        read_data["prompt_title"] = prompt.title if prompt else p.title
        read_data["group_name"] = group.name if group else "Unknown"
        read_data["current_version_number"] = prompt.current_version_number if prompt else 1
        active_ver = None
        if prompt and prompt.current_version_id:
            active_ver = db.query(PromptVersion).filter_by(id=prompt.current_version_id).first()
        if not active_ver and prompt:
            active_ver = (
                db.query(PromptVersion)
                .filter_by(prompt_id=p.prompt_id, version_number=prompt.current_version_number)
                .first()
            )
        read_data["current_content"] = active_ver.content if active_ver else ""
        results.append(read_data)
    return results


@router.get("/api/prompts/{prompt_id}/proposals")
def list_proposals(prompt_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)) -> list[dict]:
    prompt = _accessible_prompt(db, user, prompt_id)
    role = get_user_group_role(db, user, prompt.group_id)
    proposals = db.query(PromptProposal).filter_by(prompt_id=prompt.id).order_by(PromptProposal.created_at.desc()).all()
    return [_proposal_read(db, p, user.id, role) for p in proposals]


@router.post("/api/prompts/{prompt_id}/proposals", status_code=201)
def create_proposal(prompt_id: str, payload: ProposalCreateRequest, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_write_permission(user)
    prompt = _accessible_prompt(db, user, prompt_id)
    role = get_user_group_role(db, user, prompt.group_id)
    if role == "GUEST":
        raise HTTPException(status_code=403, detail="Guests have view-only access and cannot propose changes.")
    proposal = PromptProposal(
        prompt_id=prompt.id,
        group_id=prompt.group_id,
        proposer_id=user.id,
        title=payload.title.strip(),
        description=payload.description.strip(),
        content=payload.content,
        change_note=payload.change_note.strip() or "Proposed change",
        status="PENDING",
    )
    db.add(proposal)
    db.commit()
    db.refresh(proposal)
    return {"id": proposal.id, "status": proposal.status, "message": "Proposal submitted for review."}


@router.post("/api/proposals/{proposal_id}/approve")
def approve_proposal(proposal_id: str, payload: ProposalReviewAction | None = None, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_write_permission(user)
    proposal = db.query(PromptProposal).filter_by(id=proposal_id).first()
    if not proposal:
        raise HTTPException(status_code=404, detail="Proposal not found.")
    prompt = _accessible_prompt(db, user, proposal.prompt_id)
    if not can_user_approve_proposals(db, user, prompt.group_id):
        raise HTTPException(status_code=403, detail="Guests cannot approve proposals.")
    try:
        result = proposal_service.approve(db, proposal, prompt, user, payload.comment if payload else None)
    except proposal_service.ProposalError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    if result.merged and result.version is not None:
        return {
            "status": "APPROVED",
            "merged": True,
            "approvals_count": result.approvals_count,
            "required_approvals": result.required_approvals,
            "version_number": result.version.version_number,
            "version_id": result.version.id,
        }
    return {
        "status": "PENDING",
        "merged": False,
        "approvals_count": result.approvals_count,
        "required_approvals": result.required_approvals,
    }


@router.post("/api/proposals/{proposal_id}/reject")
def reject_proposal(proposal_id: str, payload: ProposalReviewAction | None = None, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_write_permission(user)
    proposal = db.query(PromptProposal).filter_by(id=proposal_id).first()
    if not proposal:
        raise HTTPException(status_code=404, detail="Proposal not found.")
    prompt = _accessible_prompt(db, user, proposal.prompt_id)
    if not can_user_approve_proposals(db, user, prompt.group_id):
        raise HTTPException(status_code=403, detail="Guests cannot reject proposals.")
    try:
        proposal_service.reject(db, proposal, user, payload.comment if payload else None)
    except proposal_service.ProposalError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    return {"status": "REJECTED"}


@router.post("/api/proposals/{proposal_id}/comments", status_code=201)
def add_proposal_comment(proposal_id: str, payload: ProposalCommentCreate, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_write_permission(user)
    proposal = db.query(PromptProposal).filter_by(id=proposal_id).first()
    if not proposal:
        raise HTTPException(status_code=404, detail="Proposal not found.")
    prompt = _accessible_prompt(db, user, proposal.prompt_id)
    if not can_access_group_with_key(db, user, prompt.group_id, _active_key(user)):
        raise HTTPException(status_code=403, detail="You do not have access to this proposal.")
    role = get_user_group_role(db, user, prompt.group_id)
    if role == "GUEST":
        raise HTTPException(status_code=403, detail="Guests have view-only access and cannot comment.")
    comment_text = payload.comment.strip()
    if not comment_text:
        raise HTTPException(status_code=400, detail="Comment cannot be empty.")
    comment = ProposalComment(proposal_id=proposal.id, user_id=user.id, comment=comment_text[:2000])
    db.add(comment)
    db.commit()
    db.refresh(comment)
    return {
        "id": comment.id,
        "proposal_id": comment.proposal_id,
        "user_id": comment.user_id,
        "user_name": user.name,
        "comment": comment.comment,
        "created_at": comment.created_at.isoformat() + "Z",
    }


@router.get("/api/proposals/{proposal_id}/comments")
def get_proposal_comments(proposal_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)) -> list[dict]:
    proposal = db.query(PromptProposal).filter_by(id=proposal_id).first()
    if not proposal:
        raise HTTPException(status_code=404, detail="Proposal not found.")
    prompt = _accessible_prompt(db, user, proposal.prompt_id)
    if not can_access_group_with_key(db, user, prompt.group_id, _active_key(user)):
        raise HTTPException(status_code=403, detail="You do not have access to this proposal.")
    comments = db.query(ProposalComment).filter_by(proposal_id=proposal.id).order_by(ProposalComment.created_at.asc()).all()
    results = []
    for c in comments:
        u = db.query(User).filter_by(id=c.user_id).first()
        results.append({
            "id": c.id,
            "proposal_id": c.proposal_id,
            "user_id": c.user_id,
            "user_name": u.name if u else "Unknown",
            "comment": c.comment,
            "created_at": c.created_at.isoformat() + "Z",
        })
    return results


