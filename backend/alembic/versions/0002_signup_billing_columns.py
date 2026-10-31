"""Sign-up and billing columns on users.

Adds email verification, password-reset tokens, Terms/marketing consent,
Polar seat/interval mirrors and monthly MCP call metering.

The app runs ``create_all()`` before migrations, so a brand-new database may
already have these columns; each one is only added when missing. Accounts that
existed before this revision are treated as already verified.

Revision ID: 0002_signup_billing
Revises: 0001_baseline
Create Date: 2026-10-31
"""

import sqlalchemy as sa
from alembic import op

revision = "0002_signup_billing"
down_revision = "0001_baseline"
branch_labels = None
depends_on = None

_COLUMNS = [
    sa.Column("email_verified_at", sa.DateTime(), nullable=True),
    sa.Column("verify_token_hash", sa.String(128), nullable=True),
    sa.Column("verify_token_expires_at", sa.DateTime(), nullable=True),
    sa.Column("reset_token_hash", sa.String(128), nullable=True),
    sa.Column("reset_token_expires_at", sa.DateTime(), nullable=True),
    sa.Column("terms_accepted_at", sa.DateTime(), nullable=True),
    sa.Column("terms_version", sa.String(32), nullable=True),
    sa.Column("marketing_opt_in", sa.Boolean(), nullable=False, server_default=sa.false()),
    sa.Column("marketing_opt_in_at", sa.DateTime(), nullable=True),
    sa.Column("billing_interval", sa.String(16), nullable=True),
    sa.Column("billed_seats", sa.Integer(), nullable=False, server_default="1"),
    sa.Column("mcp_usage_month", sa.String(7), nullable=True),
    sa.Column("mcp_usage_count", sa.Integer(), nullable=False, server_default="0"),
]
_INDEXES = {"ix_users_verify_token_hash": "verify_token_hash", "ix_users_reset_token_hash": "reset_token_hash"}


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    existing = {c["name"] for c in inspector.get_columns("users")}
    added_verified = "email_verified_at" not in existing
    with op.batch_alter_table("users") as batch:
        for column in _COLUMNS:
            if column.name not in existing:
                batch.add_column(column.copy())
    existing_indexes = {i["name"] for i in sa.inspect(op.get_bind()).get_indexes("users")}
    for name, col in _INDEXES.items():
        if name not in existing_indexes:
            op.create_index(name, "users", [col])
    if added_verified:
        # Grandfather accounts created before verification existed.
        op.execute("UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL")


def downgrade() -> None:
    for name in _INDEXES:
        op.drop_index(name, table_name="users")
    with op.batch_alter_table("users") as batch:
        for column in reversed(_COLUMNS):
            batch.drop_column(column.name)
