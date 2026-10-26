"""FastMCP tools exposing only prompts visible to the authenticated API key."""

import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from fastmcp import FastMCP
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
from models import ApiKey, Group, Prompt, PromptProposal, PromptVersion, User
from security import escape_like, rate_limiter, record_audit_log

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


def _auth_key(db, api_key: str) -> tuple[User, ApiKey | None]:
    if rate_limiter.count_recent("mcp_invalid_key", window_seconds=60) >= 20:
        raise ValueError("Too many invalid API key attempts. Please wait a minute and try again.")
    resolved = resolve_api_key(db, api_key.strip()[:256])
    if resolved is None:
        rate_limiter.record_hit("mcp_invalid_key")
        raise ValueError("The supplied PromptHold API key is invalid or has been revoked.")
    return resolved


@mcp.tool()
def list_my_accessible_prompts(api_key: str, search_query: str = "", group_name: str = "") -> dict[str, Any]:
    """List prompts from spaces authorized for the supplied API key in a single SQL JOIN query."""
    with _get_mcp_session(api_key) as db:
        user, key_record = _auth_key(db, api_key)
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
            needle = f"%{escape_like(search_query.strip()[:200])}%"
            query = query.filter(Prompt.title.ilike(needle, escape="\\") | Prompt.description.ilike(needle, escape="\\"))
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
def get_and_fill_prompt(api_key: str, prompt_id: str, variables: dict[str, str] | None = None) -> dict[str, str]:
    """Get the latest accessible prompt by UUID and substitute provided variable values."""
    with _get_mcp_session(api_key) as db:
        user, key_record = _auth_key(db, api_key)
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
def save_prompt_version_from_chat(api_key: str, prompt_id: str, new_content: str,
                                  change_note: str = "Updated via AI Chat") -> dict[str, Any]:
    """Save a new immutable prompt version (Owner) or submit an edit proposal (Member) after verifying key scope & role."""
    if not new_content or len(new_content) > 100_000:
        raise ValueError("Prompt content must be between 1 and 100,000 characters.")
    safe_note = (change_note or "Updated via AI Chat").strip()[:500]
    with _get_mcp_session(api_key) as db:
        user, key_record = _auth_key(db, api_key)
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
        record_audit_log(db, "MCP_PROMPT_WRITE", user_id=user.id, target_type="prompt", target_id=prompt.id, details=f"v{version.version_number} ({version.id}): {safe_note}")
        return {"prompt_id": prompt.id, "version_id": version.id, "version_number": version.version_number, "change_note": version.change_Note}


@mcp.tool()
def duplicate_or_move_prompt(api_key: str, prompt_id: str, target_group_id: str,
                             new_title: str = "", mode: str = "copy") -> dict[str, Any]:
    """Duplicate (copy) or move a prompt to another group or Personal space. Requires Member or Owner role in both spaces."""
    clean_mode = "move" if mode.strip().lower() == "move" else "copy"
    with _get_mcp_session(api_key) as db:
        user, key_record = _auth_key(db, api_key)
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

