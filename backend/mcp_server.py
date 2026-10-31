"""FastMCP tools exposing only prompts visible to the authenticated API key."""

import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from fastmcp import FastMCP
from fastmcp.server.http import _current_http_request
from sqlalchemy import func

from auth import resolve_api_key
from cache import (
    get_cached_active_version_uuid,
    get_cached_version_by_uuid,
    invalidate_prompt_cache,
    set_cached_active_version_uuid,
    set_cached_version_by_uuid,
)
from contextlib import contextmanager
from sqlalchemy.orm import Session
from database import SessionLocal, SessionNeon, SessionSupabase, get_sessionmaker_for_plan, resolve_token_plan
from permissions import (
    can_access_group_with_key,
    can_user_direct_write_prompt,
    extract_variables,
    get_scoped_group_ids,
    get_user_group_role,
    group_display_name,
)
from models import ApiKey, Group, Prompt, PromptProposal, PromptVersion, ProposalApproval, ProposalComment, User
import services.proposals as proposal_service
from search import hybrid_search_prompts, sync_prompt_embeddings
from security import escape_like, get_client_ip, rate_limiter, record_audit_log

mcp = FastMCP("PromptHold-Server")
BACKEND_DIR = Path(__file__).resolve().parent


def _resolve_drawer_url() -> str:
    app_url = (os.getenv("PROMPT_HOLD_APP_URL") or os.getenv("PROMPT_VAULT_APP_URL", "")).strip()
    if app_url:
        return app_url.rstrip("/") + "/?mcp_mode=1"
    space_host = os.getenv("SPACE_HOST", "").strip()
    if space_host:
        return f"https://{space_host}/?mcp_mode=1"
    render_url = os.getenv("RENDER_EXTERNAL_URL", "").strip()
    if render_url:
        return render_url.rstrip("/") + "/?mcp_mode=1"
    if (BACKEND_DIR.parent / "frontend" / "dist" / "index.html").exists():
        return "/?mcp_mode=1"
    return "http://localhost:5173/?mcp_mode=1"


@mcp.resource("ui://prompt-hold/drawer")
@mcp.resource("ui://prompt-vault/drawer")
def prompt_hold_drawer() -> str:
    """Return an HTML shell that opens the built React app in MCP drawer mode."""
    url = _resolve_drawer_url()
    return ("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            "<title>PromptHold</title></head><body style=\"margin:0\"><iframe title=\"PromptHold\" "
            f"src=\"{url}\" style=\"width:100%;height:100vh;border:0\" allow=\"clipboard-read; clipboard-write\"></iframe>"
            "</body></html>")


@contextmanager
def _get_mcp_session(api_key: str):
    """Context manager yielding a database session routed to the user's tier (Supabase or Neon)."""
    test_session = SessionLocal()
    if not isinstance(test_session, Session):
        try:
            yield test_session
        finally:
            test_session.close()
        return

    plan = resolve_token_plan(api_key)
    target_factory = get_sessionmaker_for_plan(plan)
    db = target_factory()
    try:
        resolved = resolve_api_key(db, api_key)
        if resolved is None:
            alt_factory = SessionNeon if target_factory is SessionSupabase else SessionSupabase
            alt_db = alt_factory()
            alt_resolved = resolve_api_key(alt_db, api_key)
            if alt_resolved is not None:
                db.close()
                db = alt_db
            else:
                alt_db.close()
        yield db
    finally:
        db.close()


_session_api_keys: dict[str, str] = {}


def register_session_key(session_id: str, api_key: str):
    """Associate an MCP session ID with an authenticated PromptHold API key."""
    if session_id and api_key:
        if len(_session_api_keys) >= 10_000:  # bound memory; oldest sessions simply re-send their key
            _session_api_keys.pop(next(iter(_session_api_keys)))
        _session_api_keys[session_id] = api_key.strip()


def has_session_key(session_id: str | None) -> bool:
    return bool(session_id) and session_id in _session_api_keys


def resolve_effective_api_key(explicit_key: str = "") -> str:
    """Resolve API key from explicit argument, HTTP Authorization/X-API-Key header, query param, or session map."""
    key = (explicit_key or "").strip()
    if key:
        return key

    req = _current_http_request.get()
    if req is not None:
        auth = req.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        if req.headers.get("X-API-Key"):
            return req.headers.get("X-API-Key").strip()
        if req.query_params.get("api_key"):
            k = req.query_params.get("api_key").strip()
            sess = req.headers.get("mcp-session-id")
            register_session_key(sess, k)
            return k
        if req.query_params.get("token"):
            k = req.query_params.get("token").strip()
            sess = req.headers.get("mcp-session-id")
            register_session_key(sess, k)
            return k
        match = re.search(r"/(?:s|k|key)/([^/?#]+)", req.url.path)
        if match:
            k = match.group(1).strip()
            sess = req.headers.get("mcp-session-id")
            register_session_key(sess, k)
            return k
        sess = req.headers.get("mcp-session-id")
        if sess and sess in _session_api_keys:
            return _session_api_keys[sess]

    raise ValueError(
        "Missing API key. Please configure your personal PromptHold connector URL (with your API key) or pass an Authorization header."
    )


def _auth_key(db, api_key: str) -> tuple[User, ApiKey | None]:
    # Per-client bucket: a global one would let anyone lock every user out with 20 bad keys.
    bucket = f"mcp_invalid_key:{get_client_ip(_current_http_request.get())}"
    if rate_limiter.count_recent(bucket, window_seconds=60) >= 20:
        raise ValueError("Too many invalid API key attempts. Please wait a minute and try again.")
    resolved = resolve_api_key(db, api_key.strip()[:256])
    if resolved is None:
        rate_limiter.record_hit(bucket)
        raise ValueError("The supplied PromptHold API key is invalid or has been revoked.")
    return resolved


@mcp.tool()
def list_my_accessible_prompts(api_key: str = "", search_query: str = "", group_name: str = "") -> dict[str, Any]:
    """List prompts from spaces authorized for your PromptHold API key in a single SQL JOIN query."""
    effective_key = resolve_effective_api_key(api_key)
    with _get_mcp_session(effective_key) as db:
        user, key_record = _auth_key(db, effective_key)
        group_ids = get_scoped_group_ids(db, user, key_record)
        if not group_ids:
            return {"prompts": []}
        query = (
            db.query(Prompt, Group, PromptVersion)
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
            .filter(Prompt.group_id.in_(group_ids), Prompt.is_archived.is_(False))
        )
        if search_query.strip():
            target_group_ids = group_ids
            if group_name.strip().lower() == "personal":
                personal_grp = db.query(Group.id).filter(Group.personal_owner_id == user.id).first()
                target_group_ids = [personal_grp[0]] if personal_grp else []
            elif group_name.strip():
                escaped_group = escape_like(group_name.strip()[:160])
                named_grps = [
                    g.id for g in db.query(Group.id).filter(
                        Group.id.in_(group_ids),
                        Group.name.ilike(escaped_group, escape="\\"),
                        Group.personal_owner_id.is_(None),
                    ).all()
                ]
                target_group_ids = named_grps

            hybrid_results = hybrid_search_prompts(
                db=db,
                query_text=search_query.strip(),
                accessible_group_ids=target_group_ids,
                limit=200,
            )
            return {"prompts": hybrid_results}

        if group_name.strip().lower() == "personal":
            query = query.filter(Group.personal_owner_id == user.id)
        elif group_name.strip():
            escaped_group = escape_like(group_name.strip()[:160])
            query = query.filter(Group.name.ilike(escaped_group, escape="\\"), Group.personal_owner_id.is_(None))
        rows = [
            {
                "id": prompt.id,
                "title": prompt.title,
                "group_name": group_display_name(group),
                "description": prompt.description,
                "content": version.content,
                "variables": json.loads(version.variables_json),
                "current_version_number": prompt.current_version_number,
                "current_version_id": version.id,
            }
            for prompt, group, version in query.order_by(Prompt.title).limit(200).all()
        ]
        return {"prompts": rows}


@mcp.tool()
def get_and_fill_prompt(prompt_id: str, api_key: str = "", variables: dict[str, str] | None = None) -> dict[str, str]:
    """Get the latest accessible prompt by UUID and substitute provided variable values."""
    effective_key = resolve_effective_api_key(api_key)
    with _get_mcp_session(effective_key) as db:
        user, key_record = _auth_key(db, effective_key)
        prompt = db.query(Prompt).filter_by(id=prompt_id.strip()[:64]).first()
        if prompt is None or not can_access_group_with_key(db, user, prompt.group_id, key_record):
            raise ValueError("Prompt not found or this API key does not have access to its group.")

        active_uuid = prompt.current_version_id or get_cached_active_version_uuid(prompt.id)
        cached_ver = get_cached_version_by_uuid(active_uuid) if active_uuid else None
        if cached_ver is not None:
            content = str(cached_ver["content"])
            version_id = str(cached_ver["id"])
        else:
            if prompt.current_version_id:
                version = db.query(PromptVersion).filter_by(id=prompt.current_version_id).first()
            else:
                version = db.query(PromptVersion).filter_by(
                    prompt_id=prompt.id, version_number=prompt.current_version_number
                ).first()
            if version is None:
                raise ValueError("The prompt has no saved version.")
            content = version.content
            version_id = version.id
            set_cached_active_version_uuid(prompt.id, version.id)
            set_cached_version_by_uuid(version.id, {"id": version.id, "content": version.content})

        safe_vars = variables or {}
        if len(safe_vars) > 100:
            raise ValueError("Too many variables supplied (maximum 100).")
        for key, value in safe_vars.items():
            safe_val = str(value)[:20_000]
            content = re.sub(r"\{\{\s*" + re.escape(str(key)[:120]) + r"\s*\}\}", lambda _: safe_val, content)
        return {"prompt_id": prompt.id, "version_id": version_id, "title": prompt.title, "content": content}


@mcp.tool()
def save_prompt_version_from_chat(prompt_id: str, new_content: str,
                                  change_note: str = "Updated via AI Chat", api_key: str = "") -> dict[str, Any]:
    """Save a new immutable prompt version (Owner) or submit an edit proposal (Member) after verifying key scope & role."""
    if not new_content or len(new_content) > 100_000:
        raise ValueError("Prompt content must be between 1 and 100,000 characters.")
    safe_note = (change_note or "Updated via AI Chat").strip()[:500]
    effective_key = resolve_effective_api_key(api_key)
    with _get_mcp_session(effective_key) as db:
        user, key_record = _auth_key(db, effective_key)
        if key_record is not None and getattr(key_record, "access_level", "READ_WRITE") == "READ_ONLY":
            raise ValueError("This API key is Read-Only and cannot modify or propose changes to prompts.")
        prompt = db.query(Prompt).filter_by(id=prompt_id.strip()[:64]).first()
        if prompt is None or not can_access_group_with_key(db, user, prompt.group_id, key_record):
            raise ValueError("Prompt not found or this API key does not have access to its group.")
        role = get_user_group_role(db, user, prompt.group_id)
        if role == "GUEST":
            raise ValueError("Guests have view-only access and cannot modify prompts.")
        if not can_user_direct_write_prompt(db, user, prompt.group_id):
            proposal = PromptProposal(
                prompt_id=prompt.id,
                group_id=prompt.group_id,
                proposer_id=user.id,
                title=prompt.title,
                description=prompt.description,
                content=new_content,
                change_note=safe_note,
                status="PENDING",
            )
            db.add(proposal)
            db.commit()
            db.refresh(proposal)
            record_audit_log(db, "MCP_PROPOSAL_CREATED", user_id=user.id, target_type="prompt", target_id=prompt.id, details=safe_note)
            return {
                "prompt_id": prompt.id,
                "proposal_created": True,
                "proposal_id": proposal.id,
                "status": "PENDING",
                "change_note": proposal.change_note,
                "message": "Submitted as a proposal awaiting approval.",
            }
        if not user.is_workspace_admin:
            from main import PLAN_LIMITS_MAP
            user_plan = getattr(user, "plan", "community") or "community"
            plan_info = PLAN_LIMITS_MAP.get(user_plan, PLAN_LIMITS_MAP["community"])
            max_versions = plan_info.get("max_versions_per_prompt", 10)
            max_ver = db.query(func.max(PromptVersion.version_number)).filter_by(prompt_id=prompt.id).scalar() or 0
            if max_ver >= max_versions:
                raise ValueError(f"This prompt has reached the maximum of {max_versions} versions on the {plan_info['name']} plan.")

        max_ver = db.query(func.max(PromptVersion.version_number)).filter_by(prompt_id=prompt.id).scalar() or 0
        prompt.current_version_number = max_ver + 1
        prompt.updated_at = datetime.utcnow()
        version = PromptVersion(prompt_id=prompt.id, version_number=prompt.current_version_number,
                                content=new_content, variables_json=json.dumps(extract_variables(new_content)),
                                change_Note=safe_note, author_id=user.id)
        db.add(version)
        db.flush()
        prompt.current_version_id = version.id
        db.commit()
        invalidate_prompt_cache(prompt.id)
        set_cached_version_by_uuid(version.id, {"id": version.id, "content": version.content})
        set_cached_active_version_uuid(prompt.id, version.id)
        sync_prompt_embeddings(db, prompt, version)
        record_audit_log(db, "MCP_PROMPT_WRITE", user_id=user.id, target_type="prompt", target_id=prompt.id, details=f"v{version.version_number} ({version.id}): {safe_note}")
        return {"prompt_id": prompt.id, "version_id": version.id, "version_number": version.version_number, "change_note": version.change_Note}


@mcp.tool()
def duplicate_or_move_prompt(prompt_id: str, target_group_id: str,
                             new_title: str = "", mode: str = "copy", api_key: str = "") -> dict[str, Any]:
    """Duplicate (copy) or move a prompt to another group or Personal space. Requires Member or Owner role in both spaces."""
    clean_mode = "move" if mode.strip().lower() == "move" else "copy"
    effective_key = resolve_effective_api_key(api_key)
    with _get_mcp_session(effective_key) as db:
        user, key_record = _auth_key(db, effective_key)
        if key_record is not None and getattr(key_record, "access_level", "READ_WRITE") == "READ_ONLY":
            raise ValueError("This API key is Read-Only and cannot duplicate or move prompts.")
        prompt = db.query(Prompt).filter_by(id=prompt_id.strip()[:64]).first()
        if prompt is None or not can_access_group_with_key(db, user, prompt.group_id, key_record):
            raise ValueError("Prompt not found or this API key does not have access to its group.")

        source_role = get_user_group_role(db, user, prompt.group_id)
        if source_role == "GUEST" or source_role not in {"GROUP_MANAGER", "MEMBER"}:
            raise ValueError("Guests have view-only access and cannot duplicate or move prompts.")

        target_group = db.query(Group).filter_by(id=target_group_id.strip()[:64]).first()
        if target_group is None or not can_access_group_with_key(db, user, target_group.id, key_record):
            raise ValueError("Target group not found or you do not have access to it.")

        target_role = get_user_group_role(db, user, target_group.id)
        if target_role == "GUEST" or target_role not in {"GROUP_MANAGER", "MEMBER"}:
            raise ValueError("Guests have view-only access and cannot add prompts to the target group.")

        source_group = db.query(Group).filter_by(id=prompt.group_id).first()
        src_name = group_display_name(source_group) if source_group else "Source space"
        tgt_name = group_display_name(target_group)

        if clean_mode == "move":
            if prompt.group_id == target_group.id:
                raise ValueError("The prompt is already in this space.")
            old_group_id = prompt.group_id
            prompt.group_id = target_group.id
            if new_title.strip():
                prompt.title = new_title.strip()[:240]
            prompt.updated_at = datetime.utcnow()
            db.query(PromptProposal).filter_by(prompt_id=prompt.id).update({"group_id": target_group.id})
            db.commit()
            invalidate_prompt_cache(prompt.id)
            record_audit_log(db, "MCP_PROMPT_MOVED", user_id=user.id, target_type="prompt", target_id=prompt.id, details=f"Moved from {old_group_id} to {target_group.id}")
            return {
                "id": prompt.id,
                "title": prompt.title,
                "group_id": prompt.group_id,
                "group_name": tgt_name,
                "mode": "move",
                "message": f"Prompt successfully moved to {tgt_name}."
            }

        # Otherwise copy (Duplicate)
        active_ver = None
        if prompt.current_version_id:
            active_ver = db.query(PromptVersion).filter_by(id=prompt.current_version_id).first()
        if not active_ver:
            active_ver = db.query(PromptVersion).filter_by(prompt_id=prompt.id, version_number=prompt.current_version_number).first()
        if not active_ver:
            raise ValueError("Source prompt has no saved version to duplicate.")

        prompt_title = new_title.strip()[:240] if new_title.strip() else (
            f"{prompt.title} (Copy)"[:240] if prompt.group_id == target_group.id else prompt.title[:240]
        )
        if not user.is_workspace_admin:
            from main import PLAN_LIMITS_MAP
            user_plan = getattr(user, "plan", "community") or "community"
            plan_info = PLAN_LIMITS_MAP.get(user_plan, PLAN_LIMITS_MAP["community"])
            max_prompts = plan_info.get("max_prompts", 20)
            existing_count = db.query(Prompt).filter(Prompt.created_by == user.id, Prompt.is_archived.is_(False)).count()
            if existing_count >= max_prompts:
                raise ValueError(f"Prompt limit reached ({existing_count}/{max_prompts}) for the {plan_info['name']} plan.")

        safe_note = f"Duplicated from {src_name} (v{prompt.current_version_number})"
        new_prompt = Prompt(group_id=target_group.id, title=prompt_title, description=prompt.description,
                            current_version_number=1, created_by=user.id)
        db.add(new_prompt)
        db.flush()
        v1 = PromptVersion(prompt_id=new_prompt.id, version_number=1, content=active_ver.content,
                           variables_json=json.dumps(extract_variables(active_ver.content)),
                           change_Note=safe_note, source_filename=active_ver.source_filename, author_id=user.id)
        db.add(v1)
        db.flush()
        new_prompt.current_version_id = v1.id
        db.commit()
        db.refresh(new_prompt)
        set_cached_version_by_uuid(v1.id, {"id": v1.id, "content": v1.content})
        set_cached_active_version_uuid(new_prompt.id, v1.id)
        sync_prompt_embeddings(db, new_prompt, v1)
        record_audit_log(db, "MCP_PROMPT_DUPLICATED", user_id=user.id, target_type="prompt", target_id=new_prompt.id, details=f"Duplicated from {prompt.id} to {target_group.id}")
        return {
            "id": new_prompt.id,
            "title": new_prompt.title,
            "group_id": new_prompt.group_id,
            "group_name": tgt_name,
            "current_version_number": 1,
            "mode": "copy",
            "message": f"Prompt successfully duplicated to {tgt_name}."
        }


@mcp.tool()
def create_prompt_from_chat(title: str, content: str, group_id: str = "", group_name: str = "",
                            description: str = "", change_note: str = "Created via AI Chat", api_key: str = "") -> dict[str, Any]:
    """Create a new prompt from AI chat. In team spaces, Member submissions create a proposal for review/approval; in Personal space, prompts save directly."""
    if not title or len(title.strip()) > 240:
        raise ValueError("Prompt title must be between 1 and 240 characters.")
    if not content or len(content) > 100_000:
        raise ValueError("Prompt content must be between 1 and 100,000 characters.")
    safe_title = title.strip()[:240]
    safe_desc = (description or "").strip()[:2000]
    safe_note = (change_note or "Created via AI Chat").strip()[:500]

    effective_key = resolve_effective_api_key(api_key)
    with _get_mcp_session(effective_key) as db:
        user, key_record = _auth_key(db, effective_key)
        if key_record is not None and getattr(key_record, "access_level", "READ_WRITE") == "READ_ONLY":
            raise ValueError("This API key is Read-Only and cannot create prompts or proposals.")

        target_group = None
        if group_id.strip():
            target_group = db.query(Group).filter_by(id=group_id.strip()[:64]).first()
        elif group_name.strip():
            if group_name.strip().lower() == "personal":
                target_group = db.query(Group).filter_by(personal_owner_id=user.id).first()
            else:
                target_group = db.query(Group).filter(Group.name.ilike(escape_like(group_name.strip()[:160]), escape="\\")).first()
        else:
            target_group = db.query(Group).filter_by(personal_owner_id=user.id).first()

        if not target_group or not can_access_group_with_key(db, user, target_group.id, key_record):
            raise ValueError("Target group not found or you do not have permission to access it.")

        role = get_user_group_role(db, user, target_group.id)
        if role == "GUEST":
            raise ValueError("Guests have view-only access and cannot create prompts or proposals.")

        if not user.is_workspace_admin:
            from main import PLAN_LIMITS_MAP
            user_plan = getattr(user, "plan", "community") or "community"
            plan_info = PLAN_LIMITS_MAP.get(user_plan, PLAN_LIMITS_MAP["community"])
            max_prompts = plan_info.get("max_prompts", 20)
            existing_count = db.query(Prompt).filter(Prompt.created_by == user.id, Prompt.is_archived.is_(False)).count()
            if existing_count >= max_prompts:
                raise ValueError(f"Prompt limit reached ({existing_count}/{max_prompts}) for the {plan_info['name']} plan.")

        tgt_name = group_display_name(target_group)
        if not can_user_direct_write_prompt(db, user, target_group.id):
            # Member proposing a new prompt in a team space!
            prompt = Prompt(
                group_id=target_group.id,
                title=safe_title,
                description=safe_desc,
                current_version_number=1,
                created_by=user.id,
                is_archived=True,
            )
            db.add(prompt)
            db.flush()
            proposal = PromptProposal(
                prompt_id=prompt.id,
                group_id=target_group.id,
                proposer_id=user.id,
                title=safe_title,
                description=safe_desc,
                content=content,
                change_note=safe_note,
                status="PENDING",
            )
            db.add(proposal)
            db.commit()
            record_audit_log(db, "MCP_PROMPT_PROPOSAL_CREATED", user_id=user.id, target_type="prompt", target_id=prompt.id, details=f"New prompt proposal: {safe_title}")
            return {
                "id": prompt.id,
                "title": prompt.title,
                "group_id": prompt.group_id,
                "group_name": tgt_name,
                "proposal_created": True,
                "proposal_id": proposal.id,
                "status": "PENDING",
                "message": f"Prompt submitted for team review in '{tgt_name}' before going live.",
            }

        prompt = Prompt(
            group_id=target_group.id,
            title=safe_title,
            description=safe_desc,
            current_version_number=1,
            created_by=user.id,
        )
        db.add(prompt)
        db.flush()
        v1 = PromptVersion(
            prompt_id=prompt.id,
            version_number=1,
            content=content,
            variables_json=json.dumps(extract_variables(content)),
            change_Note=safe_note,
            author_id=user.id,
        )
        db.add(v1)
        db.flush()
        prompt.current_version_id = v1.id
        db.commit()
        db.refresh(prompt)
        set_cached_version_by_uuid(v1.id, {"id": v1.id, "content": v1.content})
        set_cached_active_version_uuid(prompt.id, v1.id)
        sync_prompt_embeddings(db, prompt, v1)
        record_audit_log(db, "MCP_PROMPT_CREATED", user_id=user.id, target_type="prompt", target_id=prompt.id, details=f"Created {prompt.title}")
        return {
            "id": prompt.id,
            "title": prompt.title,
            "group_id": prompt.group_id,
            "group_name": tgt_name,
            "current_version_number": 1,
            "current_version_id": v1.id,
            "message": f"Prompt successfully created in '{tgt_name}'.",
        }


@mcp.tool()
def list_pending_proposals(api_key: str = "", group_name: str = "") -> dict[str, Any]:
    """List pending prompt proposals awaiting review across your authorized spaces, including diffs, comments, and approval status."""
    effective_key = resolve_effective_api_key(api_key)
    with _get_mcp_session(effective_key) as db:
        user, key_record = _auth_key(db, effective_key)
        group_ids = get_scoped_group_ids(db, user, key_record)
        if not group_ids:
            return {"proposals": []}

        if group_name.strip().lower() == "personal":
            personal_grp = db.query(Group.id).filter(Group.personal_owner_id == user.id).first()
            group_ids = [personal_grp[0]] if personal_grp else []
        elif group_name.strip():
            escaped_group = escape_like(group_name.strip()[:160])
            named_grps = [
                g.id for g in db.query(Group.id).filter(
                    Group.id.in_(group_ids),
                    Group.name.ilike(escaped_group, escape="\\"),
                    Group.personal_owner_id.is_(None),
                ).all()
            ]
            group_ids = named_grps

        if not group_ids:
            return {"proposals": []}

        proposals = (
            db.query(PromptProposal)
            .filter(PromptProposal.group_id.in_(group_ids), PromptProposal.status == "PENDING")
            .order_by(PromptProposal.created_at.desc())
            .limit(50)
            .all()
        )

        results = []
        for p in proposals:
            group = db.query(Group).filter_by(id=p.group_id).first()
            prompt = db.query(Prompt).filter_by(id=p.prompt_id).first()
            proposer = db.query(User).filter_by(id=p.proposer_id).first()
            role = get_user_group_role(db, user, p.group_id)

            approvals = db.query(ProposalApproval).filter_by(proposal_id=p.id).all()
            has_approved = any(a.user_id == user.id for a in approvals)
            required = getattr(group, "required_approvals", 1) if group else 1
            allow_self = bool(getattr(group, "allow_self_approval", False)) if group else False
            is_proposer = (p.proposer_id == user.id)
            self_approve_allowed = (not is_proposer) or allow_self
            can_approve = (role in {"GROUP_MANAGER", "MEMBER"}) and (not has_approved) and self_approve_allowed

            comments = db.query(ProposalComment).filter_by(proposal_id=p.id).order_by(ProposalComment.created_at.asc()).all()
            comments_data = []
            for c in comments:
                cu = db.query(User).filter_by(id=c.user_id).first()
                comments_data.append({
                    "id": c.id,
                    "author": cu.name if cu else "Unknown",
                    "comment": c.comment,
                    "created_at": c.created_at.isoformat() + "Z",
                })

            active_ver = None
            if prompt and prompt.current_version_id:
                active_ver = db.query(PromptVersion).filter_by(id=prompt.current_version_id).first()

            results.append({
                "proposal_id": p.id,
                "prompt_id": p.prompt_id,
                "prompt_title": prompt.title if prompt else p.title,
                "proposed_title": p.title,
                "group_id": p.group_id,
                "group_name": group_display_name(group) if group else "Unknown",
                "proposer_name": proposer.name if proposer else "Unknown",
                "change_note": p.change_note,
                "proposed_content": p.content,
                "current_content": active_ver.content if active_ver else None,
                "is_new_prompt": (prompt.current_version_id is None) if prompt else True,
                "approvals_count": len(approvals),
                "required_approvals": required,
                "allow_self_approval": allow_self,
                "can_approve": can_approve,
                "has_approved": has_approved,
                "comments": comments_data,
                "created_at": p.created_at.isoformat() + "Z",
            })

        return {"proposals": results}


@mcp.tool()
def review_proposal(proposal_id: str, action: str = "APPROVE", comment: str = "", api_key: str = "") -> dict[str, Any]:
    """Vote to APPROVE or REJECT a prompt proposal from AI chat, with an optional review comment. Merges when required approvals are reached."""
    clean_action = (action or "APPROVE").strip().upper()
    if clean_action not in {"APPROVE", "REJECT"}:
        raise ValueError("Action must be either 'APPROVE' or 'REJECT'.")

    effective_key = resolve_effective_api_key(api_key)
    with _get_mcp_session(effective_key) as db:
        user, key_record = _auth_key(db, effective_key)
        if key_record is not None and getattr(key_record, "access_level", "READ_WRITE") == "READ_ONLY":
            raise ValueError("This API key is Read-Only and cannot approve or reject proposals.")

        proposal = db.query(PromptProposal).filter_by(id=proposal_id.strip()[:64]).first()
        if not proposal:
            raise ValueError("Proposal not found.")

        prompt = db.query(Prompt).filter_by(id=proposal.prompt_id).first()
        if not prompt or not can_access_group_with_key(db, user, prompt.group_id, key_record):
            raise ValueError("You do not have access to this prompt proposal.")

        role = get_user_group_role(db, user, prompt.group_id)
        if role == "GUEST" or role not in {"GROUP_MANAGER", "MEMBER"}:
            raise ValueError("Guests have view-only access and cannot approve or reject proposals.")

        safe_comment = (comment or "").strip()[:2000]
        try:
            if clean_action == "REJECT":
                proposal_service.reject(db, proposal, user, safe_comment, comment_prefix="[Rejected via AI] ")
                record_audit_log(db, "MCP_PROPOSAL_REJECTED", user_id=user.id, target_type="proposal", target_id=proposal.id, details=safe_comment)
                return {
                    "proposal_id": proposal.id,
                    "status": "REJECTED",
                    "message": f"Proposal for '{proposal.title}' has been rejected.",
                }
            result = proposal_service.approve(db, proposal, prompt, user, safe_comment, comment_prefix="[Approved via AI] ")
        except proposal_service.ProposalError as exc:
            raise ValueError(str(exc)) from exc

        total_approvals, required = result.approvals_count, result.required_approvals
        if result.merged and result.version is not None:
            record_audit_log(db, "MCP_PROPOSAL_MERGED", user_id=user.id, target_type="proposal", target_id=proposal.id, details=f"Merged v{result.version.version_number}")
            return {
                "proposal_id": proposal.id,
                "prompt_id": prompt.id,
                "status": "APPROVED",
                "merged": True,
                "version_number": result.version.version_number,
                "approvals_count": total_approvals,
                "required_approvals": required,
                "message": f"Proposal approved and merged! Version {result.version.version_number} is now active.",
            }

        record_audit_log(db, "MCP_PROPOSAL_APPROVED", user_id=user.id, target_type="proposal", target_id=proposal.id, details=f"Voted {total_approvals}/{required}")
        return {
            "proposal_id": proposal.id,
            "status": "PENDING",
            "merged": False,
            "approvals_count": total_approvals,
            "required_approvals": required,
            "message": f"Approval vote recorded ({total_approvals} / {required} required). Waiting for additional reviewer votes.",
        }


@mcp.tool()
def comment_on_proposal(proposal_id: str, comment: str, api_key: str = "") -> dict[str, Any]:
    """Post feedback, questions, or review comments on a prompt proposal from AI chat."""
    if not comment or not comment.strip():
        raise ValueError("Comment text cannot be empty.")
    safe_comment = comment.strip()[:2000]

    effective_key = resolve_effective_api_key(api_key)
    with _get_mcp_session(effective_key) as db:
        user, key_record = _auth_key(db, effective_key)
        if key_record is not None and getattr(key_record, "access_level", "READ_WRITE") == "READ_ONLY":
            raise ValueError("This API key is Read-Only and cannot comment on proposals.")

        proposal = db.query(PromptProposal).filter_by(id=proposal_id.strip()[:64]).first()
        if not proposal:
            raise ValueError("Proposal not found.")

        prompt = db.query(Prompt).filter_by(id=proposal.prompt_id).first()
        if not prompt or not can_access_group_with_key(db, user, prompt.group_id, key_record):
            raise ValueError("You do not have access to this prompt proposal.")

        role = get_user_group_role(db, user, prompt.group_id)
        if role == "GUEST":
            raise ValueError("Guests have view-only access and cannot comment.")

        comment_record = ProposalComment(proposal_id=proposal.id, user_id=user.id, comment=safe_comment)
        db.add(comment_record)
        db.commit()
        db.refresh(comment_record)
        record_audit_log(db, "MCP_PROPOSAL_COMMENTED", user_id=user.id, target_type="proposal", target_id=proposal.id, details=safe_comment[:100])
        return {
            "id": comment_record.id,
            "proposal_id": proposal.id,
            "author": user.name,
            "comment": comment_record.comment,
            "created_at": comment_record.created_at.isoformat() + "Z",
            "message": "Comment posted successfully.",
        }


