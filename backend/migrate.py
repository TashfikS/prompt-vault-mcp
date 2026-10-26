"""PromptHold Standalone Database Migration & Schema Runner.

Executes schema creation, table upgrades, and initial space provisioning
under admin database credentials (DDL privileges).

Usage:
    python migrate.py
"""

from __future__ import annotations

import sys
from auth import ensure_demo_passwords, upgrade_schema
from database import Base, SessionNeon, SessionSupabase, engine_neon, engine_supabase
from permissions import ensure_all_personal_groups
from security import should_seed_demo_data
from seed import seed_initial_data


def run_migrations() -> None:
    print("=" * 60)
    print("PromptHold: Running standalone database migrations")
    print("=" * 60)

    # 1. Neon Database (Paid Tiers)
    print("\n[1/2] Migrating Neon PostgreSQL Database (Paid Tiers)...")
    try:
        Base.metadata.create_all(bind=engine_neon)
        upgrade_schema(engine_neon)
        print("      ✓ Schema and tables initialized on Neon.")

        with SessionNeon() as db_neon:
            if should_seed_demo_data():
                print("      ✓ Seeding demo accounts on Neon...")
                seed_initial_data(db_neon)
                ensure_demo_passwords(db_neon)
            ensure_all_personal_groups(db_neon)
            print("      ✓ Personal groups verified on Neon.")
    except Exception as exc:
        print(f"      ✗ Error migrating Neon database: {exc}", file=sys.stderr)
        raise

    # 2. Supabase Database (Free / Community Tier)
    print("\n[2/2] Migrating Supabase Database (Community Tier)...")
    try:
        Base.metadata.create_all(bind=engine_supabase)
        upgrade_schema(engine_supabase)
        print("      ✓ Schema and tables initialized on Supabase.")

        with SessionSupabase() as db_supa:
            ensure_all_personal_groups(db_supa)
            print("      ✓ Personal groups verified on Supabase.")
    except Exception as exc:
        print(f"      ✗ Error migrating Supabase database: {exc}", file=sys.stderr)
        raise

    print("\n" + "=" * 60)
    print("✓ All PromptHold database migrations completed successfully.")
    print("=" * 60)


if __name__ == "__main__":
    run_migrations()
