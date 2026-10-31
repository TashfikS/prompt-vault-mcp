"""Polar.sh Merchant of Record billing integration for PromptFolders.

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
from security import IS_PRODUCTION

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


# Env vars holding the Polar product for each (plan, interval). Team products must use
# seat-based pricing in Polar so the checkout charges per editor.
_PRODUCT_ENV = {
    ("pro", "month"): "POLAR_PRO_PRODUCT_ID",
    ("pro", "year"): "POLAR_PRO_ANNUAL_PRODUCT_ID",
    ("team", "month"): "POLAR_TEAM_PRODUCT_ID",
    ("team", "year"): "POLAR_TEAM_ANNUAL_PRODUCT_ID",
}


def get_product_id_for_plan(plan: str, interval: str = "month") -> str | None:
    """Retrieve the configured Polar product ID for a tier and billing interval."""
    env = _PRODUCT_ENV.get((plan, interval))
    return (os.getenv(env, "").strip() or None) if env else None


def plan_for_product_id(product_id: str | None) -> tuple[str, str] | None:
    """Map a Polar product ID back to (plan, interval)."""
    if not product_id:
        return None
    for (plan, interval), env in _PRODUCT_ENV.items():
        configured = os.getenv(env, "").strip()
        if configured and configured == product_id:
            return plan, interval
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
    interval: str = "month",
    seats: int = 1,
) -> dict[str, Any]:
    """Create a Polar checkout session URL for upgrading to a paid tier.

    If Polar credentials are not configured yet, returns a clear mock response
    allowing pre-launch testing and developer workflows.
    """
    if plan not in PAID_PLANS:
        raise HTTPException(status_code=400, detail=f"Invalid paid plan '{plan}'. Must be one of: {', '.join(PAID_PLANS)}")

    client = get_polar_client()
    product_id = get_product_id_for_plan(plan, interval)
    if client and not product_id:
        raise HTTPException(status_code=503, detail=f"{'Annual' if interval == 'year' else 'Monthly'} billing for {plan.title()} is not available yet.")
    fallback_success = success_url or os.getenv("POLAR_CHECKOUT_SUCCESS_URL", "").strip() or "http://localhost:5173/?billing=success&tier=" + plan

    # 1. Real Polar SDK flow when credentials and product ID exist
    if client and product_id:
        try:
            extra: dict[str, Any] = {"seats": max(1, seats)} if plan == "team" else {}
            checkout = client.checkouts.create(
                **extra,
                products=[product_id],
                customer_email=user.email,
                customer_name=user.name,
                success_url=fallback_success,
                allow_discount_codes=True,
                metadata={
                    "user_id": user.id,
                    "plan": plan,
                    "interval": interval,
                    "platform": "promptfolders",
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
            "To enable live card checkout, set POLAR_ACCESS_TOKEN and the POLAR_{PRO,TEAM}_PRODUCT_ID / "
            "POLAR_{PRO,TEAM}_ANNUAL_PRODUCT_ID product IDs. "
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
    # Webhooks grant paid plans and move user data between tiers, so production must never accept unsigned events.
    if not secret and IS_PRODUCTION:
        raise HTTPException(status_code=503, detail="Billing webhooks are not configured.")

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
    # The product actually paid for wins over checkout metadata.
    mapped = plan_for_product_id(data.get("product_id"))
    desired_plan = mapped[0] if mapped else metadata.get("plan")
    if desired_plan not in PAID_PLANS:
        desired_plan = "pro"  # Default paid tier
    interval = data.get("recurring_interval") or (mapped[1] if mapped else None) or metadata.get("interval")
    seats_raw = data.get("seats")

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
        if interval in ("month", "year"):
            user.billing_interval = interval
        if isinstance(seats_raw, int) and seats_raw >= 1:
            user.billed_seats = seats_raw

        is_test_env = is_test_session(db)

        if user.plan != desired_plan:
            # Handle cross-database tier migration (Supabase <-> Neon)
            audit_db = db
            if not is_test_env and is_community_plan(old_plan) != is_community_plan(desired_plan):
                # Persist the Polar ids before the move so they travel with the user row.
                db.commit()
                migrate_user_tier(user.id, old_plan, desired_plan)
                db.expunge(user)  # the source row may now be gone; never flush it again
                audit_db = get_sessionmaker_for_plan(desired_plan)()
                migrated_user = audit_db.query(User).filter_by(id=user.id).first()
                if migrated_user:
                    migrated_user.plan = desired_plan
                    audit_db.commit()
                user.plan = desired_plan
            else:
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
                audit_db.add(audit)
                audit_db.commit()
            except Exception:
                logger.exception("Failed to record upgrade audit log for user %s", user.id)
            finally:
                if audit_db is not db:
                    audit_db.close()

            logger.info("Successfully upgraded user %s (%s) to %s via Polar event %s", user.id, user.email, desired_plan, event_type)
            return {"status": "upgraded", "user_id": user.id, "plan": desired_plan}

        db.commit()  # seat count / interval changes on an existing plan
        return {"status": "already_active", "user_id": user.id, "plan": user.plan, "seats": user.billed_seats}

    # 2. DOWNGRADE / CANCELLATION / REVOCATION
    elif event_type in ("subscription.revoked", "subscription.canceled"):
        is_test_env = is_test_session(db)
        if user.plan != "community":
            # Migrate back to community tier
            audit_db = db
            if not is_test_env and is_community_plan(old_plan) != is_community_plan("community"):
                migrate_user_tier(user.id, old_plan, "community")
                db.expunge(user)
                audit_db = get_sessionmaker_for_plan("community")()
                audit_db.query(User).filter_by(id=user.id).update(
                    {"billed_seats": 1, "billing_interval": None}, synchronize_session=False)
                audit_db.commit()
                user.plan = "community"
            else:
                user.plan = "community"
                user.billed_seats = 1
                user.billing_interval = None
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
                audit_db.add(audit)
                audit_db.commit()
            except Exception:
                logger.exception("Failed to record downgrade audit log for user %s", user.id)
            finally:
                if audit_db is not db:
                    audit_db.close()

            logger.info("Downgraded user %s (%s) to community via Polar event %s", user.id, user.email, event_type)
            return {"status": "downgraded", "user_id": user.id, "plan": "community"}

    return {"status": "unhandled_event", "type": event_type}
