"""Subscription plan catalogue and per-plan limits (no web/framework dependencies).

This is the single source of truth for plans: the frontend reads it from
``GET /api/pricing``. Every limit listed here is enforced server-side; features
that are not built yet go in ``coming_soon`` instead of ``features``.
"""

from __future__ import annotations

from typing import Any

# Bump when the Terms of Service or Privacy Policy text changes materially.
TERMS_VERSION = "2026-10-31"

PLAN_TIERS = [
    {
        "id": "community",
        "name": "Community",
        "tagline": "Individual developers exploring version-controlled prompts and MCP in-chat access.",
        "price_monthly": 0,
        "price_annual": 0,
        "per_seat": False,
        "price_label": "$0",
        "max_prompts": 20,
        "max_versions_per_prompt": 10,
        "max_groups": 1,
        "max_api_keys": 2,
        "free_guests_per_editor": 0,
        "mcp_monthly_calls": 1000,
        "share_links": False,
        "batch_upload": False,
        "storage_type": "Free Cloud Database",
        "features": [
            "1 user · Personal space + 1 team group",
            "Up to 20 active prompts",
            "Last 10 versions per prompt",
            "Direct Save (instant versioning)",
            "MCP in-chat drawer · 1,000 MCP calls/month",
            "Up to 2 API keys",
            "Word & sentence diff viewer",
        ],
        "coming_soon": [],
    },
    {
        "id": "pro",
        "name": "Pro",
        "tagline": "Power prompt crafters and freelancers managing extensive prompt libraries.",
        "price_monthly": 7,
        "price_annual": 5,  # $60/year
        "per_seat": False,
        "price_label": "$7/mo",
        "max_prompts": 100,
        "max_versions_per_prompt": 50,
        "max_groups": 1,
        "max_api_keys": 5,
        "free_guests_per_editor": 0,
        "mcp_monthly_calls": 10000,
        "share_links": True,
        "batch_upload": True,
        "storage_type": "Cloud Database",
        "features": [
            "Everything in Community",
            "Up to 100 active prompts",
            "Up to 50 versions per prompt",
            "10,000 MCP calls/month · up to 5 API keys",
            "Shareable diff links",
            "Batch file upload (.txt, .md, .csv, .json)",
        ],
        "coming_soon": [],
    },
    {
        "id": "team",
        "name": "Team",
        "badge": "Most Popular",
        "tagline": "Startups and product teams collaborating with approval workflows and RBAC.",
        "price_monthly": 12,
        "price_annual": 10,  # $120/editor/year
        "per_seat": True,
        "price_label": "$12/editor/mo",
        "max_prompts": 500,
        "max_versions_per_prompt": 100,
        "max_groups": 5,
        "max_api_keys": 10,
        "free_guests_per_editor": 2,
        "mcp_monthly_calls": 50000,
        "share_links": True,
        "batch_upload": True,
        "storage_type": "Team Cloud Database",
        "features": [
            "Everything in Pro",
            "Billed per editor, no seat minimum",
            "2 free read-only guests per paid editor",
            "Up to 500 prompts across 5 team groups",
            "Proposal & approval workflow",
            "Review requests inbox & auto-merge",
            "50,000 MCP calls/month · up to 10 API keys for agents",
        ],
        "coming_soon": [],
    },
    {
        "id": "enterprise",
        "name": "Enterprise",
        "tagline": "Organizations needing custom quotas, compliance exports and dedicated support.",
        "price_monthly": None,
        "price_annual": None,
        "per_seat": True,
        "price_label": "Contact Us",
        "max_prompts": 10000,
        "max_versions_per_prompt": 1000,
        "max_groups": 100,
        "max_api_keys": 100,
        "free_guests_per_editor": 10,
        "mcp_monthly_calls": 1000000,
        "share_links": True,
        "batch_upload": True,
        "storage_type": "Dedicated Cloud Database",
        "features": [
            "Everything in Team",
            "Custom prompt, version & MCP quotas",
            "Audit log export (CSV)",
            "Dedicated SLA & onboarding support",
        ],
        "coming_soon": [],
    },
]

PLAN_LIMITS_MAP = {tier["id"]: tier for tier in PLAN_TIERS}


def plan_info_for(user: Any) -> dict:
    plan = getattr(user, "plan", "community") or "community"
    return PLAN_LIMITS_MAP.get(plan, PLAN_LIMITS_MAP["community"])
