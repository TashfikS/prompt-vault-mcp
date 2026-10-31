"""Subscription plan catalogue and per-plan limits (no web/framework dependencies)."""

from __future__ import annotations

from typing import Any


PLAN_TIERS = [
    {
        "id": "community",
        "name": "Community",
        "tagline": "Individual developers exploring version-controlled prompts and MCP in-chat access.",
        "price_monthly": 0,
        "price_annual": 0,
        "price_label": "$0",
        "max_prompts": 20,
        "max_versions_per_prompt": 10,
        "max_groups": 1,
        "free_guests_per_editor": 0,
        "mcp_monthly_calls": 1000,
        "storage_type": "Free Cloud Database (Supabase / SQLite)",
        "features": [
            "1 User · Personal space + 1 team group",
            "Up to 20 active prompts",
            "Last 10 versions per prompt",
            "Direct Save (instant versioning)",
            "FastMCP In-Chat Drawer & Personal API Key",
            "Word & sentence basic diff viewer",
        ],
    },
    {
        "id": "pro",
        "name": "Pro",
        "tagline": "Power prompt crafters and freelancers managing extensive prompt libraries.",
        "price_monthly": 5,
        "price_annual": 4,  # $48/year
        "price_label": "$5/mo",
        "max_prompts": 100,
        "max_versions_per_prompt": 50,
        "max_groups": 1,
        "free_guests_per_editor": 0,
        "mcp_monthly_calls": 10000,
        "storage_type": "Cloud DB + Bring Your Own Storage (Google Drive / Local)",
        "features": [
            "Everything in Community",
            "Up to 100 active prompts",
            "Up to 50 versions per prompt",
            "Word & Sentence Diff Viewer (Split & Inline)",
            "Shareable Zero-Config Diff Links",
            "Batch File Upload (.txt, .md, .csv, .json)",
            "Bring Your Own Storage (Google Drive & local sync)",
        ],
    },
    {
        "id": "team",
        "name": "Team",
        "badge": "Most Popular",
        "tagline": "Startups and product teams collaborating with approval workflows and RBAC.",
        "price_monthly": 12,
        "price_annual": 10,  # $120/year
        "price_label": "$10/editor/mo",
        "max_prompts": 500,
        "max_versions_per_prompt": 100,
        "max_groups": 5,
        "free_guests_per_editor": 2,
        "mcp_monthly_calls": 50000,
        "storage_type": "Team Cloud DB + Google Drive Team Sync",
        "features": [
            "Everything in Pro",
            "No seat minimums (starts at 1 editor)",
            "2 Free Read-Only Guests per paid editor",
            "Up to 500 prompts across 5 Team Groups",
            "Proposal & Approval Workflow (required_approvals)",
            "Central Review Requests Inbox & auto-merge",
            "3 Team MCP API Keys for automated agents",
            "Team Cloud & Google Drive Sync",
        ],
    },
    {
        "id": "enterprise",
        "name": "Enterprise",
        "tagline": "Organizations requiring self-hosting, strict compliance, and custom infrastructure.",
        "price_monthly": None,
        "price_annual": None,
        "price_label": "Contact Us",
        "max_prompts": 10000,
        "max_versions_per_prompt": 1000,
        "max_groups": 100,
        "free_guests_per_editor": 10,
        "mcp_monthly_calls": 1000000,
        "storage_type": "Self-Hosted Docker / VPC / Private PostgreSQL",
        "features": [
            "Everything in Team",
            "Self-Hosted Deployment (Docker / VPC / On-Prem)",
            "Dedicated PostgreSQL or custom DB cluster",
            "SSO / SAML 2.0 (Okta, Google Workspace, Azure AD)",
            "Custom prompt & version quotas",
            "Full Compliance & Audit Logs Export",
            "Dedicated SLA & onboarding support",
        ],
    },
]

PLAN_LIMITS_MAP = {tier["id"]: tier for tier in PLAN_TIERS}


def plan_info_for(user: Any) -> dict:
    plan = getattr(user, "plan", "community") or "community"
    return PLAN_LIMITS_MAP.get(plan, PLAN_LIMITS_MAP["community"])
