"""Alembic runner applies cleanly on a database built by create_all + upgrade_schema."""

from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from auth import upgrade_schema
from database import Base
from migrations import current_revision, run_migrations


def test_run_migrations_reaches_head_and_is_idempotent():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    upgrade_schema(engine)
    run_migrations(engine)
    assert current_revision(engine) == "0002_signup_billing"
    run_migrations(engine)  # second run is a no-op
    assert current_revision(engine) == "0002_signup_billing"


def test_signup_columns_added_to_pre_existing_users_table():
    """A database from before 0002 gains the new columns, and its existing users count as verified."""
    from sqlalchemy import inspect, text

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    upgrade_schema(engine)
    run_migrations(engine, "0001_baseline")
    new_cols = ["email_verified_at", "verify_token_hash", "verify_token_expires_at", "reset_token_hash",
                "reset_token_expires_at", "terms_accepted_at", "terms_version", "marketing_opt_in",
                "marketing_opt_in_at", "billing_interval", "billed_seats", "mcp_usage_month", "mcp_usage_count"]
    with engine.begin() as conn:
        for idx in ("ix_users_verify_token_hash", "ix_users_reset_token_hash"):
            conn.execute(text(f"DROP INDEX IF EXISTS {idx}"))
        for col in new_cols:
            conn.execute(text(f"ALTER TABLE users DROP COLUMN {col}"))
        conn.execute(text("INSERT INTO users (id, name, email, is_workspace_admin, onboarding_completed, plan, "
                          "failed_login_attempts, created_at) VALUES ('u1', 'Old', 'old@test.com', 0, 0, 'community', 0, "
                          "'2025-01-01 00:00:00')"))
    run_migrations(engine)
    assert set(new_cols) <= {c["name"] for c in inspect(engine).get_columns("users")}
    with engine.connect() as conn:
        row = conn.execute(text("SELECT email_verified_at, billed_seats, marketing_opt_in FROM users WHERE id='u1'")).one()
    assert row[0] is not None and row[1] == 1 and not row[2]
