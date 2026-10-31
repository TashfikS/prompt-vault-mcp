"""Cross-tier team membership flags on users.

``is_peer_stub`` marks a name-tag copy of a user whose real account lives in the
other database tier; ``has_peer_memberships`` marks a real account that belongs
to a team group stored in the other tier. Columns are only added when missing,
because the app runs ``create_all()`` before migrations.

Revision ID: 0003_cross_tier_teams
Revises: 0002_signup_billing
Create Date: 2026-11-01
"""

import sqlalchemy as sa
from alembic import op

revision = "0003_cross_tier_teams"
down_revision = "0002_signup_billing"
branch_labels = None
depends_on = None

_COLUMNS = [
    sa.Column("is_peer_stub", sa.Boolean(), nullable=False, server_default=sa.false()),
    sa.Column("has_peer_memberships", sa.Boolean(), nullable=False, server_default=sa.false()),
]


def upgrade() -> None:
    existing = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("users")}
    with op.batch_alter_table("users") as batch:
        for column in _COLUMNS:
            if column.name not in existing:
                batch.add_column(column.copy())
    # No backfill: rows left behind by earlier tier migrations keep working as before (sign-in already
    # prefers the account matching the user's plan); new name tags are always created as stubs.

def downgrade() -> None:
    with op.batch_alter_table("users") as batch:
        for column in _COLUMNS:
            batch.drop_column(column.name)
