"""account API routes."""

import os


from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from database import (
    PAID_PLANS,
    get_db,
    get_sessionmaker_for_plan,
    is_community_plan,
    is_test_session,
    migrate_user_tier,
)
from auth import (create_api_key_record, hash_password, verify_password)
from permissions import (can_user_view_group, ensure_personal_group, group_display_name)
from models import (ApiKey, Group, GroupMembership, Prompt, User)
from schemas import (ChangePasswordRequest, CheckoutSessionRequest, CreateApiKeyRequest, MarketingPreferenceRequest,
                     PlanUpdateRequest, UpdateProfileRequest)
from services.limits import PlanLimitError, check_api_key_quota, mcp_usage, team_seat_usage
from services.credential_policy import BREACHED_PASSWORD_MESSAGE, is_password_breached
from polar_billing import (create_checkout_session, create_customer_portal_session, is_polar_configured,
                           process_polar_event, verify_polar_webhook_signature)
from security import (get_client_ip, record_audit_log)

from deps import (current_user, maybe_user, _require_web_session)
from domain import (PLAN_TIERS, PLAN_LIMITS_MAP, _api_key_read)

router = APIRouter()


@router.get("/api/users")
def list_users(db: Session = Depends(get_db), user: User = Depends(current_user)) -> list[dict]:
    """List teammates visible to the caller (all users for Workspace Admins; shared-group teammates for standard users)."""
    _require_web_session(user)
    if user.is_workspace_admin:
        users = db.query(User).order_by(User.name).all()
    else:
        my_group_ids = [
            row[0]
            for row in db.query(GroupMembership.group_id)
            .join(Group, Group.id == GroupMembership.group_id)
            .filter(GroupMembership.user_id == user.id, Group.personal_owner_id.is_(None))
            .all()
        ]
        if my_group_ids:
            teammate_ids = {
                row[0]
                for row in db.query(GroupMembership.user_id)
                .filter(GroupMembership.group_id.in_(my_group_ids))
                .all()
            }
            teammate_ids.add(user.id)
            users = db.query(User).filter(User.id.in_(teammate_ids)).order_by(User.name).all()
        else:
            users = [user]
    return [{"id": u.id, "name": u.name, "email": u.email, "is_workspace_admin": u.is_workspace_admin} for u in users]


@router.get("/api/me")
def get_me(db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    memberships = db.query(GroupMembership, Group).join(Group).filter(GroupMembership.user_id == user.id).all()
    latest_key = db.query(ApiKey).filter_by(user_id=user.id, is_active=True).order_by(ApiKey.created_at.desc()).first()
    plan_name = getattr(user, "plan", "community") or "community"
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "is_workspace_admin": user.is_workspace_admin,
        "plan": plan_name,
        "api_key": latest_key.key_prefix if latest_key else None,
        "onboarding_completed": bool(user.onboarding_completed),
        "email_verified": user.email_verified_at is not None,
        "marketing_opt_in": bool(user.marketing_opt_in),
        "billing_interval": user.billing_interval,
        "billed_seats": user.billed_seats or 1,
        "last_login_at": user.last_login_at.isoformat() if getattr(user, "last_login_at", None) else None,
        "created_at": user.created_at.isoformat() if getattr(user, "created_at", None) else None,
        "groups": [
            {"id": m.group_id, "name": group_display_name(group), "role": m.role,
             "is_personal": group.personal_owner_id is not None}
            for m, group in memberships
        ],
    }


@router.put("/api/me/profile")
@router.put("/api/users/profile")
def update_profile(
    payload: UpdateProfileRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict:
    """Update profile details (e.g. display name) for the authenticated user."""
    _require_web_session(user)
    new_name = payload.name.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Name cannot be blank.")
    user.name = new_name
    db.commit()
    db.refresh(user)
    record_audit_log(
        db,
        "USER_PROFILE_UPDATED",
        user_id=user.id,
        ip_address=get_client_ip(request),
        details=f"Updated display name to '{new_name}'",
    )
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "is_workspace_admin": user.is_workspace_admin,
        "plan": getattr(user, "plan", "community") or "community",
    }


@router.post("/api/me/change-password")
@router.post("/api/users/change-password")
def change_password(
    payload: ChangePasswordRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict:
    """Safely rotate password after verifying current credentials and complexity requirements."""
    _require_web_session(user)
    client_ip = get_client_ip(request)

    # 1. Verify current password
    if not verify_password(payload.current_password, user.password_hash):
        record_audit_log(
            db,
            "AUTH_PASSWORD_CHANGE_FAILED",
            user_id=user.id,
            ip_address=client_ip,
            details="Incorrect current password submitted",
        )
        raise HTTPException(status_code=400, detail="Current password is incorrect.")

    # 2. Check that new password is not identical to current
    if payload.current_password == payload.new_password:
        raise HTTPException(status_code=400, detail="New password must be different from your current password.")
    if is_password_breached(payload.new_password):
        raise HTTPException(status_code=400, detail=BREACHED_PASSWORD_MESSAGE)

    # 3. Update password hash (using Argon2id) and reset any lockout state
    user.password_hash = hash_password(payload.new_password)
    user.failed_login_attempts = 0
    user.locked_until = None
    db.commit()

    record_audit_log(
        db,
        "AUTH_PASSWORD_CHANGED",
        user_id=user.id,
        ip_address=client_ip,
        details="Password rotated successfully",
    )
    return {"message": "Password changed successfully."}


@router.get("/api/pricing")
def get_pricing_plans(db: Session = Depends(get_db), user: User | None = Depends(maybe_user)) -> dict:
    """Return all available plans, limits, and current user's usage if authenticated."""
    current_plan = getattr(user, "plan", "community") if user else "community"
    plan_info = PLAN_LIMITS_MAP.get(current_plan, PLAN_LIMITS_MAP["community"])
    usage = None
    if user is not None:
        prompts_count = db.query(Prompt).filter(Prompt.created_by == user.id, Prompt.is_archived.is_(False)).count()
        usage = {
            "prompts_count": prompts_count,
            "max_prompts": plan_info["max_prompts"],
            "mcp_calls": mcp_usage(user),
            "mcp_monthly_calls": plan_info["mcp_monthly_calls"],
            "api_keys": db.query(ApiKey).filter_by(user_id=user.id, is_active=True).count(),
            "max_api_keys": plan_info["max_api_keys"],
        }
        if plan_info.get("per_seat") and current_plan != "enterprise":
            seats = team_seat_usage(db, user)
            usage.update({
                "seats": user.billed_seats or 1,
                "editors": seats["editors"],
                "guests": seats["guests"],
                "max_guests": (user.billed_seats or 1) * plan_info["free_guests_per_editor"],
            })
    return {
        "tiers": PLAN_TIERS,
        "current_plan": current_plan,
        "usage": usage,
    }


@router.patch("/api/me/plan")
@router.post("/api/me/plan")
def update_my_plan(payload: PlanUpdateRequest, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    """Update subscription plan for the current user."""
    _require_web_session(user)
    if payload.plan not in PLAN_LIMITS_MAP:
        raise HTTPException(status_code=400, detail="Invalid plan selected.")
    old_plan = getattr(user, "plan", "community") or "community"
    is_test_env = is_test_session(db)
    if not is_test_env and not user.is_workspace_admin and payload.plan in PAID_PLANS and user.plan != payload.plan:
        raise HTTPException(
            status_code=403,
            detail="Upgrading to a paid subscription requires payment verification or workspace administrator authorization."
        )

    # If transitioning across database tiers (Community <-> Paid), migrate the user's data!
    if not is_test_env and is_community_plan(old_plan) != is_community_plan(payload.plan):
        db.commit()
        migrate_user_tier(user.id, old_plan, payload.plan)
        db.expunge(user)  # source row may be deleted now; never flush it from this session
        new_factory = get_sessionmaker_for_plan(payload.plan)
        with new_factory() as new_db:
            migrated_user = new_db.query(User).filter_by(id=user.id).first()
            if migrated_user:
                migrated_user.plan = payload.plan
                new_db.commit()
                record_audit_log(
                    new_db,
                    "PLAN_CHANGED",
                    user_id=user.id,
                    ip_address=get_client_ip(request),
                    target_type="user",
                    target_id=user.id,
                    details=f"Migrated tier database and updated plan from {old_plan} to {payload.plan}",
                )
        user.plan = payload.plan
    else:
        user.plan = payload.plan
        db.commit()
        db.refresh(user)
        record_audit_log(
            db,
            "PLAN_CHANGED",
            user_id=user.id,
            ip_address=get_client_ip(request),
            target_type="user",
            target_id=user.id,
            details=f"Changed subscription plan from {old_plan} to {payload.plan}",
        )
    return {
        "message": f"Successfully updated your plan to {payload.plan.title()}.",
        "plan": user.plan,
        "user": {
            "id": user.id,
            "name": user.name,
            "email": user.email,
            "plan": user.plan,
            "is_workspace_admin": user.is_workspace_admin,
        },
    }


@router.get("/api/billing/config")
def get_billing_configuration() -> dict:
    """Return public Polar billing configuration status."""
    return {
        "provider": "polar",
        "configured": is_polar_configured(),
        "environment": os.getenv("POLAR_ENVIRONMENT", "sandbox").strip().lower(),
    }


@router.post("/api/billing/checkout")
def create_billing_checkout(
    payload: CheckoutSessionRequest,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict:
    """Generate a Polar checkout session URL to upgrade to a paid subscription."""
    _require_web_session(user)
    if user.email_verified_at is None:
        raise HTTPException(status_code=403, detail="Confirm your email address before upgrading. Check your inbox or resend the confirmation email from your profile.")
    seats = payload.seats if payload.plan == "team" else 1
    return create_checkout_session(user=user, plan=payload.plan, success_url=payload.success_url,
                                   interval=payload.billing_interval, seats=seats)


@router.put("/api/me/marketing")
def update_marketing_preference(payload: MarketingPreferenceRequest, request: Request, db: Session = Depends(get_db),
                                user: User = Depends(current_user)) -> dict:
    """Opt in or out of product and marketing emails (consent timestamp kept for GDPR records)."""
    _require_web_session(user)
    from datetime import datetime

    if bool(user.marketing_opt_in) != payload.marketing_opt_in:
        user.marketing_opt_in = payload.marketing_opt_in
        user.marketing_opt_in_at = datetime.utcnow() if payload.marketing_opt_in else None
        db.commit()
        record_audit_log(db, "MARKETING_CONSENT_CHANGED", user_id=user.id, ip_address=get_client_ip(request),
                         target_type="user", target_id=user.id, details=f"marketing_opt_in={payload.marketing_opt_in}")
    return {"marketing_opt_in": bool(user.marketing_opt_in)}


@router.post("/api/billing/portal")
def create_billing_portal(
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict:
    """Generate a Polar customer portal session URL to self-manage or cancel subscriptions."""
    _require_web_session(user)
    return create_customer_portal_session(user=user)


@router.post("/api/webhooks/polar")
async def handle_polar_webhook(
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """Receive and process incoming verified webhooks from Polar.sh."""
    raw_body = await request.body()
    headers_dict = dict(request.headers)
    event_dict = verify_polar_webhook_signature(raw_body, headers_dict)
    return process_polar_event(event_dict, db)


@router.get("/api/api-keys")
def list_api_keys(db: Session = Depends(get_db), user: User = Depends(current_user)) -> list[dict]:
    """List all active API keys for the signed-in user. Raw secrets are never returned here."""
    _require_web_session(user)
    records = (
        db.query(ApiKey)
        .filter_by(user_id=user.id, is_active=True)
        .order_by(ApiKey.created_at.desc())
        .all()
    )
    return [_api_key_read(db, record) for record in records]


@router.post("/api/api-keys", status_code=201)
def create_api_key(payload: CreateApiKeyRequest, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    """Generate a new API key (Global or Group-scoped). Returns the full raw secret ONLY once."""
    _require_web_session(user)
    ensure_personal_group(db, user)
    try:
        check_api_key_quota(db, user)
    except PlanLimitError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    group_id: str | None = None
    if payload.scope_type == "GROUP":
        group_id = (payload.group_id or "").strip()
        if not can_user_view_group(db, user, group_id):
            raise HTTPException(status_code=403, detail="You do not have access to the selected group.")
    record, raw_key = create_api_key_record(
        db=db,
        user=user,
        name=payload.name,
        description=payload.description,
        scope_type=payload.scope_type,
        group_id=group_id,
        access_level=payload.access_level,
    )
    record_audit_log(
        db,
        "API_KEY_CREATED",
        user_id=user.id,
        ip_address=get_client_ip(request),
        target_type="api_key",
        target_id=record.id,
        details=f"Created {record.scope_type} ({record.access_level}) key '{record.name}'",
    )
    data = _api_key_read(db, record)
    data["raw_key"] = raw_key
    return data


@router.post("/api/api-keys/{key_id}/revoke")
def revoke_api_key(key_id: str, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    """Revoke an active API key by deleting it permanently (no revoked history is kept)."""
    _require_web_session(user)
    record = db.query(ApiKey).filter_by(id=key_id, user_id=user.id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="API key not found.")
    name = record.name
    db.delete(record)
    db.commit()
    record_audit_log(db, "API_KEY_REVOKED", user_id=user.id, ip_address=get_client_ip(request), target_type="api_key", target_id=key_id, details=f"Revoked key '{name}'")
    return {"revoked": True, "id": key_id, "name": name}


@router.delete("/api/api-keys/{key_id}")
def delete_api_key(key_id: str, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    """Delete an API key record from history."""
    _require_web_session(user)
    record = db.query(ApiKey).filter_by(id=key_id, user_id=user.id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="API key not found.")
    name = record.name
    db.delete(record)
    db.commit()
    record_audit_log(db, "API_KEY_DELETED", user_id=user.id, ip_address=get_client_ip(request), target_type="api_key", target_id=key_id, details=f"Deleted key '{name}'")
    return {"deleted": True, "id": key_id}


@router.post("/api/me/onboarding")
def complete_onboarding(db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    """Mark the first-login product tour as finished (or skipped) for the current user."""
    _require_web_session(user)
    user.onboarding_completed = True
    db.commit()
    return {"onboarding_completed": True}


