"""Baseline: schema as built by create_all() + the legacy upgrade_schema().

Every existing Supabase/Neon/SQLite database already matches this, so the
revision is empty; it only marks where versioned migrations start.

Revision ID: 0001_baseline
Revises:
Create Date: 2026-10-31
"""

revision = "0001_baseline"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
