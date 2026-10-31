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
    assert current_revision(engine) == "0001_baseline"
    run_migrations(engine)  # second run is a no-op
    assert current_revision(engine) == "0001_baseline"
