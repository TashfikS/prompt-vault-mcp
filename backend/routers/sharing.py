"""sharing API routes."""

from datetime import datetime, timedelta


from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from sqlalchemy.orm import Session

from database import (
    SessionNeon,
    SessionSupabase,
    engine_neon,
    get_db,
    get_db_bind_url,
    is_test_session,
)
from cache import (create_github_issue_for_feedback)
from permissions import (get_user_group_role, group_display_name, require_workspace_admin)
from models import (AuditLog, FeedbackSubmission, Group, Prompt, PromptVersion, SharedDiffLink, User)
from schemas import (CreateDiffShareRequest,
                     FeedbackCreateRequest)
from security import (get_client_ip, rate_limiter, record_audit_log)

from deps import (SESSION_COOKIE_NAME, current_user, _require_web_session, _require_write_permission)
from domain import (_version_read, _accessible_prompt)

from services.limits import PlanLimitError, require_feature

router = APIRouter()


@router.post("/api/diff-shares", status_code=201)
def create_diff_share(payload: CreateDiffShareRequest, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_write_permission(user)
    try:
        require_feature(user, "share_links", "Shareable diff links")
    except PlanLimitError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    prompt = _accessible_prompt(db, user, payload.prompt_id)
    role = get_user_group_role(db, user, prompt.group_id)
    if role == "GUEST":
        raise HTTPException(status_code=403, detail="Guests cannot create external share links.")
    for number in (payload.base_version, payload.target_version):
        if not db.query(PromptVersion.id).filter_by(prompt_id=prompt.id, version_number=number).first():
            raise HTTPException(status_code=404, detail=f"Version {number} not found.")
    days = payload.expires_in_days or 7
    expires_at = datetime.utcnow() + timedelta(days=days)
    record = SharedDiffLink(
        prompt_id=prompt.id,
        base_version=payload.base_version,
        target_version=payload.target_version,
        diff_granularity=payload.diff_granularity,
        view_mode=payload.view_mode,
        created_by=user.id,
        expires_at=expires_at,
        is_revoked=False,
    )
    db.add(record)
    db.commit()
    record_audit_log(db, "DIFF_SHARE_CREATED", user_id=user.id, ip_address=get_client_ip(request), target_type="diff_share", target_id=record.id, details=f"Prompt {prompt.id} v{record.base_version}..v{record.target_version} (expires {days}d)")
    return {
        "share_id": record.id,
        "expires_at": expires_at.isoformat() + "Z",
        "share_url": f"/share/diff/{record.id}?base={record.base_version}&target={record.target_version}&granularity={record.diff_granularity}&mode={record.view_mode}",
    }


@router.delete("/api/diff-shares/{share_id}")
def revoke_diff_share(share_id: str, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_web_session(user)
    record = db.query(SharedDiffLink).filter_by(id=share_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="Shared comparison not found.")
    prompt = _accessible_prompt(db, user, record.prompt_id)
    role = get_user_group_role(db, user, prompt.group_id)
    if record.created_by != user.id and role != "GROUP_MANAGER" and not user.is_workspace_admin:
        raise HTTPException(status_code=403, detail="Only the creator or Group Owner can revoke this shared link.")
    record.is_revoked = True
    db.commit()
    record_audit_log(db, "DIFF_SHARE_REVOKED", user_id=user.id, ip_address=get_client_ip(request), target_type="diff_share", target_id=record.id)
    return {"revoked": True, "share_id": share_id}


@router.get("/api/diff-shares/{share_id}")
def get_diff_share(share_id: str, request: Request, db: Session = Depends(get_db)) -> dict:
    rate_limiter.check(f"diff_share_ip:{get_client_ip(request)}", limit=30, window_seconds=60,
                       detail="Too many shared comparison requests. Please wait a minute.")
    record = db.query(SharedDiffLink).filter_by(id=share_id[:64]).first()
    active_db = db
    alt_db_to_close = None
    if record is None and not is_test_session(db):
        bind_url = get_db_bind_url(db)
        alt_factory = SessionNeon if bind_url != str(engine_neon.url) else SessionSupabase
        try:
            alt_db = alt_factory()
            alt_record = alt_db.query(SharedDiffLink).filter_by(id=share_id[:64]).first()
            if alt_record is not None:
                record = alt_record
                active_db = alt_db
                alt_db_to_close = alt_db
        except Exception:
            pass
    try:
        if record is None or getattr(record, "is_revoked", False):
            raise HTTPException(status_code=404, detail="Shared comparison not found or has been revoked.")
        if record.expires_at and record.expires_at < datetime.utcnow():
            raise HTTPException(status_code=410, detail="This shared comparison link has expired.")
        prompt = active_db.query(Prompt).filter_by(id=record.prompt_id).first()
        base = active_db.query(PromptVersion).filter_by(prompt_id=record.prompt_id, version_number=record.base_version).first()
        target = active_db.query(PromptVersion).filter_by(prompt_id=record.prompt_id, version_number=record.target_version).first()
        group = active_db.query(Group).filter_by(id=prompt.group_id).first() if prompt else None
        if not prompt or not base or not target:
            raise HTTPException(status_code=404, detail="The comparison versions are unavailable.")
        return {"share_id": record.id, "prompt": {"id": prompt.id, "title": prompt.title, "group_id": prompt.group_id,
                 "group_name": group_display_name(group) if group else ""}, "base_version": _version_read(active_db, base),
                "target_version": _version_read(active_db, target), "diff_granularity": record.diff_granularity,
                "view_mode": record.view_mode,
                "expires_at": (record.expires_at.isoformat() + "Z") if record.expires_at else None}
    finally:
        if alt_db_to_close is not None:
            alt_db_to_close.close()


@router.post("/api/feedback", status_code=201)
def submit_feedback(
    payload: FeedbackCreateRequest,
    request: Request,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    """Submit user feedback, a complaint, a bug report, or a contact message and automatically create a GitHub Issue."""
    client_ip = get_client_ip(request)
    rate_limiter.check(
        f"feedback_ip:{client_ip}",
        limit=10,
        window_seconds=300,
        detail="Too many feedback submissions from this IP. Please wait a few minutes.",
    )

    # Resolve optional authenticated user without failing if submitted from login page
    auth_user: User | None = None
    try:
        auth_user = current_user(
            request=request,
            authorization=authorization,
            session_cookie=request.cookies.get(SESSION_COOKIE_NAME),
            db=db,
        )
    except HTTPException:
        auth_user = None

    contact_name = (payload.contact_name or (auth_user.name if auth_user else "Anonymous User")).strip()[:120]
    contact_email = (payload.contact_email or (auth_user.email if auth_user else "")).strip()[:254]

    submission = FeedbackSubmission(
        user_id=auth_user.id if auth_user else None,
        category=payload.category,
        subject=payload.subject,
        message=payload.message,
        reporter_name=contact_name,
        reporter_email=contact_email,
        page_url=(payload.page_url or "")[:500],
        status="OPEN",
    )
    db.add(submission)
    db.flush()

    gh_issue = create_github_issue_for_feedback(
        category=payload.category,
        subject=payload.subject,
        message=payload.message,
        contact_name=contact_name,
        contact_email=contact_email,
        page_url=payload.page_url,
        submission_id=submission.id,
    )
    if gh_issue.get("created"):
        submission.github_issue_number = gh_issue.get("issue_number")
        submission.github_issue_url = gh_issue.get("issue_url")
        submission.status = "GITHUB_SYNCED"

    db.commit()
    db.refresh(submission)
    record_audit_log(
        db,
        "FEEDBACK_SUBMITTED",
        user_id=auth_user.id if auth_user else None,
        ip_address=client_ip,
        target_type="feedback",
        target_id=submission.id,
        details=f"[{payload.category}] {payload.subject[:80]} (gh_issue={submission.github_issue_number})",
    )
    return {
        "id": submission.id,
        "category": submission.category,
        "subject": submission.subject,
        "status": submission.status,
        "github_issue_created": bool(gh_issue.get("created")),
        "github_issue_number": submission.github_issue_number,
        "github_issue_url": submission.github_issue_url,
        "created_at": submission.created_at.isoformat() + "Z",
        "message": (
            f"Thank you! Your {payload.category.lower().replace('_', ' ')} has been logged as Issue #{submission.github_issue_number}."
            if submission.github_issue_number
            else "Thank you! Your feedback has been saved and queued for our team."
        ),
    }


@router.get("/api/feedback")
def list_feedback_submissions(
    limit: int = 100,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> list[dict]:
    """List user complaints, bug reports, and contact submissions (Workspace Admins only)."""
    _require_web_session(user)
    require_workspace_admin(user)
    safe_limit = max(1, min(limit, 500))
    items = db.query(FeedbackSubmission).order_by(FeedbackSubmission.created_at.desc()).limit(safe_limit).all()
    return [
        {
            "id": item.id,
            "user_id": item.user_id,
            "category": item.category,
            "subject": item.subject,
            "message": item.message,
            "contact_name": item.reporter_name,
            "contact_email": item.reporter_email,
            "page_url": item.page_url,
            "github_issue_number": item.github_issue_number,
            "github_issue_url": item.github_issue_url,
            "status": item.status,
            "created_at": item.created_at.isoformat() + "Z",
        }
        for item in items
    ]


@router.get("/api/audit-logs")
def list_audit_logs(limit: int = 100, db: Session = Depends(get_db), user: User = Depends(current_user)) -> list[dict]:
    """Return recent security audit log entries (Workspace Admins only)."""
    _require_web_session(user)
    require_workspace_admin(user)
    safe_limit = max(1, min(limit, 500))
    logs = db.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(safe_limit).all()
    return [
        {
            "id": entry.id,
            "user_id": entry.user_id,
            "action": entry.action,
            "ip_address": entry.ip_address,
            "target_type": entry.target_type,
            "target_id": entry.target_id,
            "details": entry.details,
            "created_at": entry.created_at.isoformat() + "Z",
        }
        for entry in logs
    ]




@router.get("/api/audit-logs/export")
def export_audit_logs(days: int = 90, db: Session = Depends(get_db), user: User = Depends(current_user)) -> Response:
    """Download the audit trail as CSV for compliance reviews (Workspace Admins only)."""
    import csv
    import io

    _require_web_session(user)
    require_workspace_admin(user)
    since = datetime.utcnow() - timedelta(days=max(1, min(days, 3650)))
    logs = db.query(AuditLog).filter(AuditLog.created_at >= since).order_by(AuditLog.created_at.desc()).limit(50000).all()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["created_at", "action", "user_id", "ip_address", "target_type", "target_id", "details"])
    for e in logs:
        # Prefix cells that a spreadsheet would treat as formulas.
        row = [e.created_at.isoformat() + "Z", e.action, e.user_id or "", e.ip_address, e.target_type or "", e.target_id or "", e.details]
        writer.writerow(["'" + c if isinstance(c, str) and c[:1] in ("=", "+", "-", "@") else c for c in row])
    record_audit_log(db, "AUDIT_LOG_EXPORTED", user_id=user.id, details=f"Exported {len(logs)} entries ({days} days)")
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="prompthold-audit-{datetime.utcnow():%Y%m%d}.csv"'},
    )
