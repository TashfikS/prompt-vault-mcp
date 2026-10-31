"""prompts API routes."""

import csv
import hashlib
import io
import json
from datetime import datetime
from pathlib import Path


from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import (
    get_db,
)
from cache import (invalidate_prompt_cache, set_cached_active_version_uuid,
                   set_cached_version_by_uuid)
from permissions import (can_access_group_with_key, can_user_direct_write_prompt,
                         extract_variables, get_scoped_group_ids, get_user_group_role, group_display_name)
from models import (Group, Prompt, PromptProposal, PromptVersion, User)
from search import hybrid_search_prompts, sync_prompt_embeddings
from schemas import (PromptCreateRequest, PromptDuplicateRequest, PromptUpdateRequest)
from security import (MAX_BATCH_PROMPTS_PER_FILE, MAX_UPLOAD_FILES,
                      MAX_UPLOAD_FILE_BYTES, get_client_ip, rate_limiter, record_audit_log, sanitize_filename, validate_text_upload_content)

import services.prompts as prompt_service
from deps import (current_user, _active_key, _require_write_permission)
from domain import (_version_read, _check_prompt_quota, _check_version_quota, _create_prompt, _accessible_prompt)

router = APIRouter()


@router.get("/api/prompts")
def list_prompts(
    request: Request,
    response: Response,
    group_id: str | None = None,
    search: str = "",
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    accessible_ids = get_scoped_group_ids(db, user, _active_key(user))
    if not accessible_ids:
        return []

    ver_count_subq = (
        db.query(
            PromptVersion.prompt_id.label("p_id"),
            func.count(PromptVersion.id).label("v_count"),
        )
        .group_by(PromptVersion.prompt_id)
        .subquery()
    )

    query = (
        db.query(Prompt, Group, PromptVersion, func.coalesce(ver_count_subq.c.v_count, 1))
        .join(Group, Prompt.group_id == Group.id)
        .join(
            PromptVersion,
            (PromptVersion.id == Prompt.current_version_id)
            | (
                Prompt.current_version_id.is_(None)
                & (PromptVersion.prompt_id == Prompt.id)
                & (PromptVersion.version_number == Prompt.current_version_number)
            ),
        )
        .outerjoin(ver_count_subq, ver_count_subq.c.p_id == Prompt.id)
        .filter(Prompt.group_id.in_(accessible_ids), Prompt.is_archived.is_(False))
    )
    if group_id:
        query = query.filter(Prompt.group_id == group_id)
    if search.strip():
        return hybrid_search_prompts(
            db=db,
            query_text=search.strip(),
            accessible_group_ids=accessible_ids,
            group_id_filter=group_id,
            limit=500,
        )

    rows = query.order_by(Prompt.updated_at.desc()).limit(500).all()

    # Compute fast ETag from active version UUIDs + updated_at timestamps
    etag_seed = "|".join(f"{p.id}:{v.id}:{int(p.updated_at.timestamp())}:{vc}" for p, _, v, vc in rows)
    etag_value = f'W/"{hashlib.sha256(etag_seed.encode("utf-8")).hexdigest()[:24]}"'
    if request.headers.get("if-none-match") == etag_value:
        return Response(status_code=304, headers={"ETag": etag_value})

    response.headers["ETag"] = etag_value
    response.headers["Cache-Control"] = "private, must-revalidate"

    result = []
    for prompt, group, version, v_count in rows:
        result.append(
            {
                "id": prompt.id,
                "group_id": prompt.group_id,
                "group_name": group_display_name(group),
                "title": prompt.title,
                "description": prompt.description,
                "current_version_number": prompt.current_version_number,
                "current_version_id": version.id,
                "updated_at": prompt.updated_at.isoformat() + "Z",
                "content": version.content,
                "variables": json.loads(version.variables_json),
                "version_count": int(v_count or 1),
            }
        )
    return result


@router.post("/api/prompts", status_code=201)
def create_prompt(payload: PromptCreateRequest, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_write_permission(user)
    if not can_access_group_with_key(db, user, payload.group_id, _active_key(user)):
        raise HTTPException(status_code=403, detail="You (or this scoped API key) cannot create prompts in this group.")
    role = get_user_group_role(db, user, payload.group_id)
    if role == "GUEST":
        raise HTTPException(status_code=403, detail="Guests have view-only access and cannot create prompts.")
    try:
        result = prompt_service.create_or_propose(db, user, payload.group_id, payload.title, payload.content,
                                                  payload.description, payload.change_note, payload.source_filename)
    except prompt_service.PromptError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    prompt = result.prompt
    if result.proposal is not None:
        record_audit_log(db, "PROPOSAL_CREATED", user_id=user.id, target_type="prompt", target_id=prompt.id, details=f"New prompt proposal: {prompt.title}")
        return {
            "id": prompt.id,
            "title": prompt.title,
            "group_id": prompt.group_id,
            "proposal_created": True,
            "proposal_id": result.proposal.id,
            "status": "PENDING",
            "message": "Your new prompt proposal has been submitted for team review before publishing.",
        }
    return {
        "id": prompt.id,
        "title": prompt.title,
        "group_id": prompt.group_id,
        "current_version_number": 1,
        "current_version_id": prompt.current_version_id,
    }


@router.post("/api/prompts/upload-files", status_code=201)
async def upload_files(request: Request, group_id: str = Form(...), prompt_id: str | None = Form(None),
                       change_note: str = Form("Uploaded from file"), files: list[UploadFile] = File(...),
                       db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_write_permission(user)
    rate_limiter.check(f"upload_user:{user.id}", limit=15, window_seconds=60,
                       detail="Too many file upload requests. Please wait a minute and try again.")
    if len(files) > MAX_UPLOAD_FILES:
        raise HTTPException(status_code=400, detail=f"You can upload at most {MAX_UPLOAD_FILES} files at once.")
    safe_change_note = (change_note or "Uploaded from file").strip()[:500]
    if not can_access_group_with_key(db, user, group_id, _active_key(user)):
        raise HTTPException(status_code=403, detail="You (or this scoped API key) cannot upload prompts to this group.")
    role = get_user_group_role(db, user, group_id)
    if role == "GUEST":
        raise HTTPException(status_code=403, detail="Guests have view-only access and cannot upload prompts.")
    if prompt_id:
        target = _accessible_prompt(db, user, prompt_id)
        if target.group_id != group_id:
            raise HTTPException(status_code=400, detail="The selected prompt does not belong to this group.")
    created: list[str] = []
    updated: list[str] = []
    proposed: list[str] = []
    try:
        for upload in files:
            filename = sanitize_filename(upload.filename)
            suffix = Path(filename).suffix.lower()
            raw = await upload.read(MAX_UPLOAD_FILE_BYTES + 1)
            if len(raw) > MAX_UPLOAD_FILE_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"{filename} exceeds the maximum allowed size of {MAX_UPLOAD_FILE_BYTES // (1024 * 1024)} MB.",
                )
            text = validate_text_upload_content(raw, filename)
            if suffix in {".txt", ".md"}:
                if len(text) > 100_000:
                    raise HTTPException(status_code=400, detail=f"{filename} exceeds 100,000 characters.")
                if prompt_id:
                    if not can_user_direct_write_prompt(db, user, target.group_id):
                        proposal = PromptProposal(
                            prompt_id=target.id,
                            group_id=target.group_id,
                            proposer_id=user.id,
                            title=target.title,
                            description=target.description,
                            content=text,
                            change_note=f"{safe_change_note} ({filename})"[:500],
                            status="PENDING",
                        )
                        db.add(proposal)
                        db.flush()
                        proposed.append(proposal.id)
                    else:
                        _check_version_quota(db, user, target)
                        max_ver = db.query(func.max(PromptVersion.version_number)).filter_by(prompt_id=target.id).scalar() or 0
                        target.current_version_number = max_ver + 1
                        variables_list = extract_variables(text)
                        new_ver = PromptVersion(
                            prompt_id=target.id,
                            version_number=target.current_version_number,
                            content=text,
                            variables_json=json.dumps(variables_list),
                            change_Note=safe_change_note,
                            source_filename=filename,
                            author_id=user.id,
                        )
                        db.add(new_ver)
                        db.flush()
                        target.current_version_id = new_ver.id
                        target.updated_at = datetime.utcnow()
                        invalidate_prompt_cache(target.id)
                        set_cached_version_by_uuid(
                            new_ver.id,
                            {
                                "id": new_ver.id,
                                "prompt_id": target.id,
                                "title": target.title,
                                "version_number": new_ver.version_number,
                                "content": new_ver.content,
                                "variables": variables_list,
                            },
                        )
                        set_cached_active_version_uuid(target.id, new_ver.id)
                        sync_prompt_embeddings(db, target, new_ver)
                        updated.append(target.id)
                else:
                    _check_prompt_quota(db, user, group_id, 1)
                    prompt = _create_prompt(db, user, group_id, Path(filename).stem, text,
                                            change_note=safe_change_note, source_filename=filename)
                    created.append(prompt.id)
            elif suffix == ".json":
                try:
                    rows = json.loads(text)
                except json.JSONDecodeError as exc:
                    raise HTTPException(status_code=400, detail=f"{filename} contains invalid JSON.") from exc
                if isinstance(rows, dict):
                    rows = rows.get("prompts", [rows])
                if not isinstance(rows, list):
                    raise HTTPException(status_code=400, detail=f"{filename} must contain a list of prompt objects.")
                if len(rows) > MAX_BATCH_PROMPTS_PER_FILE:
                    raise HTTPException(status_code=400, detail=f"{filename} contains more than {MAX_BATCH_PROMPTS_PER_FILE} prompts.")
                for row in rows:
                    if not isinstance(row, dict) or not row.get("title") or not isinstance(row.get("content"), str):
                        raise HTTPException(status_code=400, detail=f"Every row in {filename} needs title and content fields.")
                    if len(row["content"]) > 100_000:
                        raise HTTPException(status_code=400, detail=f"A prompt in {filename} exceeds 100,000 characters.")
                    _check_prompt_quota(db, user, group_id, 1)
                    prompt = _create_prompt(db, user, group_id, str(row["title"]), row["content"],
                                            str(row.get("description", "")), safe_change_note, filename)
                    created.append(prompt.id)
            elif suffix == ".csv":
                reader = csv.DictReader(io.StringIO(text))
                if not reader.fieldnames or not {"title", "content"}.issubset({field.strip().lower() for field in reader.fieldnames}):
                    raise HTTPException(status_code=400, detail=f"{filename} needs title and content columns.")
                row_count = 0
                for row in reader:
                    row_count += 1
                    if row_count > MAX_BATCH_PROMPTS_PER_FILE:
                        raise HTTPException(status_code=400, detail=f"{filename} contains more than {MAX_BATCH_PROMPTS_PER_FILE} rows.")
                    normalized = {str(key).strip().lower(): value for key, value in row.items() if key}
                    if not normalized.get("title") or normalized.get("content") is None:
                        continue
                    if len(normalized["content"]) > 100_000:
                        raise HTTPException(status_code=400, detail=f"A row in {filename} exceeds 100,000 characters.")
                    _check_prompt_quota(db, user, group_id, 1)
                    prompt = _create_prompt(db, user, group_id, normalized["title"], normalized["content"],
                                            normalized.get("description", ""), safe_change_note, filename)
                    created.append(prompt.id)
            else:
                raise HTTPException(status_code=400, detail=f"Unsupported file type: {filename}")
        db.commit()
    except HTTPException:
        if created or updated or proposed:
            db.rollback()
        raise
    except Exception:
        db.rollback()
        raise
    return {"created_prompt_ids": created, "updated_prompt_ids": updated, "proposal_ids": proposed}


@router.put("/api/prompts/{prompt_id}")
def update_prompt(prompt_id: str, payload: PromptUpdateRequest, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_write_permission(user)
    prompt = _accessible_prompt(db, user, prompt_id)
    role = get_user_group_role(db, user, prompt.group_id)
    if role == "GUEST":
        raise HTTPException(status_code=403, detail="Guests have view-only access and cannot edit prompts.")

    if not can_user_direct_write_prompt(db, user, prompt.group_id):
        proposal = PromptProposal(
            prompt_id=prompt.id,
            group_id=prompt.group_id,
            proposer_id=user.id,
            title=payload.title.strip() if payload.title else prompt.title,
            description=payload.description if payload.description is not None else prompt.description,
            content=payload.content,
            change_note=payload.change_note or "Proposed change",
            status="PENDING",
        )
        db.add(proposal)
        db.commit()
        db.refresh(proposal)
        return {
            "proposal_created": True,
            "proposal_id": proposal.id,
            "message": "Your changes have been submitted as a proposal for review.",
        }

    _check_version_quota(db, user, prompt)

    if payload.title is not None:
        prompt.title = payload.title.strip()
    if payload.description is not None:
        prompt.description = payload.description
    max_ver = db.query(func.max(PromptVersion.version_number)).filter_by(prompt_id=prompt.id).scalar() or 0
    prompt.current_version_number = max_ver + 1
    prompt.updated_at = datetime.utcnow()
    safe_source = sanitize_filename(payload.source_filename) if payload.source_filename else None
    variables_list = extract_variables(payload.content)
    version = PromptVersion(
        prompt_id=prompt.id,
        version_number=prompt.current_version_number,
        content=payload.content,
        variables_json=json.dumps(variables_list),
        change_Note=payload.change_note,
        source_filename=safe_source,
        author_id=user.id,
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
    return _version_read(db, version, author_name=user.name)


@router.post("/api/prompts/{prompt_id}/rollback/{version_number}")
def rollback_prompt(prompt_id: str, version_number: int, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    _require_write_permission(user)
    prompt = _accessible_prompt(db, user, prompt_id)
    role = get_user_group_role(db, user, prompt.group_id)
    if role != "GROUP_MANAGER":
        raise HTTPException(status_code=403, detail="Only the Group Owner can switch the active version.")
    target = db.query(PromptVersion).filter_by(prompt_id=prompt.id, version_number=version_number).first()
    if target is None:
        raise HTTPException(status_code=404, detail="Version not found.")
    prompt.current_version_number = version_number
    prompt.current_version_id = target.id
    prompt.updated_at = datetime.utcnow()
    db.commit()

    invalidate_prompt_cache(prompt.id)
    set_cached_active_version_uuid(prompt.id, target.id)
    sync_prompt_embeddings(db, prompt, target)
    record_audit_log(db, "PROMPT_ROLLBACK", user_id=user.id, ip_address=get_client_ip(request), target_type="prompt", target_id=prompt.id, details=f"Switched active version to v{version_number} ({target.id})")
    return _version_read(db, target)


@router.post("/api/prompts/{prompt_id}/duplicate", status_code=201)
def duplicate_or_move_prompt_route(
    prompt_id: str,
    payload: PromptDuplicateRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict:
    _require_write_permission(user)
    prompt = _accessible_prompt(db, user, prompt_id)

    # Check caller's role in the source group
    source_role = get_user_group_role(db, user, prompt.group_id)
    if source_role == "GUEST" or source_role not in {"GROUP_MANAGER", "MEMBER"}:
        raise HTTPException(
            status_code=403,
            detail="Guests have view-only access and cannot duplicate or move prompts. Only Members and Owners can duplicate or move prompts.",
        )

    # Check caller's role in the target group
    target_group = db.query(Group).filter_by(id=payload.target_group_id).first()
    if target_group is None or not can_access_group_with_key(db, user, payload.target_group_id, _active_key(user)):
        raise HTTPException(status_code=403, detail="You do not have access to the target group.")

    target_role = get_user_group_role(db, user, payload.target_group_id)
    if target_role == "GUEST" or target_role not in {"GROUP_MANAGER", "MEMBER"}:
        raise HTTPException(
            status_code=403,
            detail="Guests have view-only access and cannot add prompts to the target group. You must be a Member or Owner of the target group.",
        )

    tgt_name = group_display_name(target_group)
    try:
        if payload.mode == "move":
            old_group_id = prompt_service.move(db, prompt, target_group, payload.title or "")
        else:
            new_prompt = prompt_service.duplicate(db, user, prompt, target_group, payload.title or "")
    except prompt_service.PromptError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    if payload.mode == "move":
        record_audit_log(db, "PROMPT_MOVED", user_id=user.id, ip_address=get_client_ip(request), target_type="prompt",
                         target_id=prompt.id, details=f"Moved from {old_group_id} to {target_group.id}")
        return {
            "id": prompt.id,
            "title": prompt.title,
            "group_id": prompt.group_id,
            "group_name": tgt_name,
            "current_version_number": prompt.current_version_number,
            "mode": "move",
            "message": f"Prompt successfully moved to {tgt_name}.",
        }

    record_audit_log(db, "PROMPT_DUPLICATED", user_id=user.id, ip_address=get_client_ip(request), target_type="prompt",
                     target_id=new_prompt.id, details=f"Duplicated from {prompt.id} ({prompt.title}) to {target_group.id}")
    return {
        "id": new_prompt.id,
        "title": new_prompt.title,
        "group_id": new_prompt.group_id,
        "group_name": tgt_name,
        "current_version_number": 1,
        "mode": "copy",
        "message": f"Prompt successfully duplicated to {tgt_name}.",
    }


@router.get("/api/prompts/{prompt_id}/versions")
def prompt_versions(
    prompt_id: str,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    prompt = _accessible_prompt(db, user, prompt_id)
    rows = (
        db.query(PromptVersion, User.name)
        .outerjoin(User, PromptVersion.author_id == User.id)
        .filter(PromptVersion.prompt_id == prompt.id)
        .order_by(PromptVersion.version_number.desc())
        .all()
    )

    etag_seed = f"{prompt.id}:{prompt.current_version_id}:{prompt.current_version_number}:{len(rows)}"
    etag_value = f'W/"{hashlib.sha256(etag_seed.encode("utf-8")).hexdigest()[:24]}"'
    if request.headers.get("if-none-match") == etag_value:
        return Response(status_code=304, headers={"ETag": etag_value})

    response.headers["ETag"] = etag_value
    response.headers["Cache-Control"] = "private, must-revalidate"

    active_pair = None
    others = []
    for v, author_name in rows:
        is_active = (v.id == prompt.current_version_id) if prompt.current_version_id else (v.version_number == prompt.current_version_number)
        if is_active and active_pair is None:
            active_pair = (v, author_name)
        else:
            others.append((v, author_name))
    ranked = ([active_pair] if active_pair else []) + others
    return [_version_read(db, version, author_name=author_name or "Unknown") for version, author_name in ranked]


