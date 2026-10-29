"""Polar.sh Merchant of Record billing integration for PromptHold.

Provides checkout session generation, customer portal links, webhook signature
verification, and automatic plan provisioning/tier migration.
"""

import json
import logging
import os
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from database import (
    PAID_PLANS,
    get_sessionmaker_for_plan,
    is_community_plan,
    is_test_session,
    migrate_user_tier,
)
from models import AuditLog, User

logger = logging.getLogger("uvicorn.error")

# Configuration from environment variables
POLAR_ACCESS_TOKEN = os.getenv("POLAR_ACCESS_TOKEN", "").strip()
POLAR_WEBHOOK_SECRET = os.getenv("POLAR_WEBHOOK_SECRET", "").strip()
POLAR_ENVIRONMENT = os.getenv("POLAR_ENVIRONMENT", "sandbox").strip().lower()
POLAR_PRO_PRODUCT_ID = os.getenv("POLAR_PRO_PRODUCT_ID", "").strip()
POLAR_TEAM_PRODUCT_ID = os.getenv("POLAR_TEAM_PRODUCT_ID", "").strip()
POLAR_CHECKOUT_SUCCESS_URL = os.getenv("POLAR_CHECKOUT_SUCCESS_URL", "").strip()


def is_polar_configured() -> bool:
    """Check if Polar live/sandbox credentials are configured in the environment."""
    return bool(os.getenv("POLAR_ACCESS_TOKEN", "").strip())


def get_product_id_for_plan(plan: str) -> str | None:
    """Retrieve the configured Polar product ID for a given tier."""
    if plan == "pro":
        return os.getenv("POLAR_PRO_PRODUCT_ID", "").strip() or None
    if plan == "team":
        return os.getenv("POLAR_TEAM_PRODUCT_ID", "").strip() or None
    return None


def get_polar_client():
    """Instantiate a Polar SDK client using environment settings."""
    token = os.getenv("POLAR_ACCESS_TOKEN", "").strip()
    if not token:
        return None
    try:
        from polar.v2026_10 import Polar
        env = "sandbox" if os.getenv("POLAR_ENVIRONMENT", "sandbox").strip().lower() == "sandbox" else "production"
        return Polar(access_token=token, environment=env)
    except Exception as exc:
        logger.warning("Failed to initialize Polar SDK client: %s", exc)
        return None


def create_checkout_session(
    user: User,
    plan: str,
    success_url: str | None = None,
) -> dict[str, Any]:
    """Create a Polar checkout session URL for upgrading to a paid tier.

    If Polar credentials are not configured yet, returns a clear mock response
    allowing pre-launch testing and developer workflows.
    """
    if plan not in PAID_PLANS:
        raise HTTPException(status_code=400, detail=f"Invalid paid plan '{plan}'. Must be one of: {', '.join(PAID_PLANS)}")

    client = get_polar_client()
    product_id = get_product_id_for_plan(plan)
    fallback_success = success_url or os.getenv("POLAR_CHECKOUT_SUCCESS_URL", "").strip() or "http://localhost:5173/?billing=success&tier=" + plan

    # 1. Real Polar SDK flow when credentials and product ID exist
    if client and product_id:
        try:
            checkout = client.checkouts.create(
                products=[product_id],
                customer_email=user.email,
                customer_name=user.name,
                success_url=fallback_success,
                allow_discount_codes=True,
                metadata={
                    "user_id": user.id,
                    "plan": plan,
                    "platform": "prompthold",
                },
            )
            return {
                "checkout_url": checkout.url,
                "session_id": checkout.id,
                "mode": "live",
                "plan": plan,
                "configured": True,
            }
        except Exception as exc:
            logger.error("Polar API checkout creation error: %s", exc)
            raise HTTPException(
                status_code=502,
                detail=f"Polar checkout creation failed: {str(exc)}",
            )

    # 2. Informative Mock / Sandbox response if keys are not yet configured
    return {
        "checkout_url": None,
        "session_id": f"dev_mock_checkout_{user.id}_{plan}",
        "mode": "mock",
        "plan": plan,
        "configured": False,
        "message": (
            "Polar credentials are not yet configured in .env. "
            "To enable live card checkout, set POLAR_ACCESS_TOKEN and POLAR_PRO_PRODUCT_ID / POLAR_TEAM_PRODUCT_ID. "
            "In development mode, you can test plan upgrades directly."
        ),
    }


def create_customer_portal_session(user: User) -> dict[str, Any]:
    """Create a customer portal session for the user to manage/cancel subscriptions."""
    client = get_polar_client()
    customer_id = getattr(user, "polar_customer_id", None)
    if client and customer_id:
        try:
            session = client.customer_sessions.create(customer_id=customer_id)
            return {
                "portal_url": session.customer_portal_url,
                "mode": "live",
            }
        except Exception as exc:
            logger.warning("Polar customer portal session error: %s", exc)

    return {
        "portal_url": None,
        "mode": "mock",
        "message": "No active Polar billing subscription found for this account.",
    }


def verify_polar_webhook_signature(raw_body: bytes, headers: dict[str, str]) -> dict[str, Any]:
    """Verify standard Polar webhook signatures (svix format).

    Raises HTTPException(403) on signature mismatch.
    """
    secret = os.getenv("POLAR_WEBHOOK_SECRET", "").strip()

    # If secret is configured, strictly enforce signature verification
    if secret:
        try:
            from polar.webhooks import _verify_signature
            body_text = raw_body.decode("utf-8")
            _verify_signature(body_text, headers, secret)
        except Exception as exc:
            logger.warning("Polar webhook signature verification failed: %s", exc)
            raise HTTPException(status_code=403, detail="Invalid Polar webhook signature")

    # Parse JSON payload
    try:
        return json.loads(raw_body.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON webhook payload") from exc


def process_polar_event(event_dict: dict[str, Any], db: Session) -> dict[str, Any]:
    """Process an incoming verified Polar webhook event.

    Handles:
    - order.paid / order.created: Upgrades user to paid tier and migrates database.
    - subscription.created / subscription.active: Upgrades or activates user tier.
    - subscription.canceled / subscription.revoked: Downgrades user back to community tier.
    """
    event_type = event_dict.get("type", "")
    data = event_dict.get("data", {})
    if not isinstance(data, dict):
        # Could be an object if passed directly from an SDK typed payload
        data = getattr(data, "__dict__", {})

    metadata = data.get("metadata", {}) or {}
    customer = data.get("customer", {}) or {}
    customer_email = customer.get("email") if isinstance(customer, dict) else getattr(customer, "email", None)
    customer_id = data.get("customer_id") or (customer.get("id") if isinstance(customer, dict) else None)
    subscription_id = data.get("subscription_id") or data.get("id") if "subscription" in event_type else None

    # Identify user by metadata.user_id or customer_email
    target_user_id = metadata.get("user_id")
    user: User | None = None

    if target_user_id:
        user = db.query(User).filter_by(id=target_user_id).first()
    if not user and customer_email:
        user = db.query(User).filter_by(email=customer_email).first()

    if not user:
        logger.info("Polar webhook event '%s' ignored: user not found (id=%s, email=%s)", event_type, target_user_id, customer_email)
        return {"status": "ignored", "reason": "user_not_found", "event": event_type}

    # Determine desired plan
    desired_plan = metadata.get("plan")
    if not desired_plan:
        product_id = data.get("product_id")
        pro_id = os.getenv("POLAR_PRO_PRODUCT_ID", "").strip()
        team_id = os.getenv("POLAR_TEAM_PRODUCT_ID", "").strip()
        if pro_id and product_id == pro_id:
            desired_plan = "pro"
        elif team_id and product_id == team_id:
            desired_plan = "team"
        else:
            desired_plan = "pro"  # Default paid tier

    old_plan = getattr(user, "plan", "community") or "community"

    # 1. UPGRADE / PAYMENT SUCCESS
    if event_type in ("order.paid", "order.created", "subscription.created", "subscription.active", "subscription.updated", "checkout.updated"):
        status = data.get("status", "")
        # If checkout.updated, only process if confirmed or succeeded
        if event_type == "checkout.updated" and status not in ("confirmed", "succeeded"):
            return {"status": "skipped", "reason": f"checkout status '{status}'"}

        if customer_id and hasattr(user, "polar_customer_id"):
            user.polar_customer_id = str(customer_id)
        if subscription_id and hasattr(user, "polar_subscription_id"):
            user.polar_subscription_id = str(subscription_id)

        is_test_env = is_test_session(db)

        if user.plan != desired_plan:
            # Handle cross-database tier migration (Supabase <-> Neon)
            if not is_test_env and is_community_plan(old_plan) != is_community_plan(desired_plan):
                migrate_user_tier(user.id, old_plan, desired_plan)
                new_factory = get_sessionmaker_for_plan(desired_plan)
                with new_factory() as new_db:
                    migrated_user = new_db.query(User).filter_by(id=user.id).first()
                    if migrated_user:
                        migrated_user.plan = desired_plan
                        if customer_id and hasattr(migrated_user, "polar_customer_id"):
                            migrated_user.polar_customer_id = str(customer_id)
                        if subscription_id and hasattr(migrated_user, "polar_subscription_id"):
                            migrated_user.polar_subscription_id = str(subscription_id)
                        new_db.commit()

            user.plan = desired_plan
            db.commit()
            db.refresh(user)

            # Record audit log
            try:
                audit = AuditLog(
                    action="SUBSCRIPTION_UPGRADED_POLAR",
                    user_id=user.id,
                    target_type="user",
                    target_id=user.id,
                    details=f"Upgraded plan from {old_plan} to {desired_plan} via Polar event '{event_type}'",
                )
                db.add(audit)
                db.commit()
            except Exception:
                pass

            logger.info("Successfully upgraded user %s (%s) to %s via Polar event %s", user.id, user.email, desired_plan, event_type)
            return {"status": "upgraded", "user_id": user.id, "plan": desired_plan}

        return {"status": "already_active", "user_id": user.id, "plan": user.plan}

    # 2. DOWNGRADE / CANCELLATION / REVOCATION
    elif event_type in ("subscription.revoked", "subscription.canceled"):
        is_test_env = is_test_session(db)
        if user.plan != "community":
            # Migrate back to community tier
            if not is_test_env and is_community_plan(old_plan) != is_community_plan("community"):
                migrate_user_tier(user.id, old_plan, "community")
            user.plan = "community"
            db.commit()
            db.refresh(user)

            try:
                audit = AuditLog(
                    action="SUBSCRIPTION_CANCELED_POLAR",
                    user_id=user.id,
                    target_type="user",
                    target_id=user.id,
                    details=f"Subscription canceled on Polar event '{event_type}'. Reverted to community plan.",
                )
                db.add(audit)
                db.commit()
            except Exception:
                pass

            logger.info("Downgraded user %s (%s) to community via Polar event %s", user.id, user.email, event_type)
            return {"status": "downgraded", "user_id": user.id, "plan": "community"}

    return {"status": "unhandled_event", "type": event_type}
