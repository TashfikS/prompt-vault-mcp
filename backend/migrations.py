"""Versioned schema migrations (Alembic), applied to every tier database.

New schema changes go in ``alembic/versions/`` — not in ``auth.upgrade_schema()``,
which is frozen as the pre-Alembic baseline. Because there are two databases
(Supabase community, Neon paid), the app runs this for each engine on startup.
"""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy.engine import Engine

_SCRIPT_LOCATION = str(Path(__file__).resolve().parent / "alembic")


def _config() -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", _SCRIPT_LOCATION)
    return cfg


def run_migrations(engine: Engine, revision: str = "head") -> None:
    cfg = _config()
    with engine.begin() as connection:
        cfg.attributes["connection"] = connection
        command.upgrade(cfg, revision)


def current_revision(engine: Engine) -> str | None:
    from alembic.runtime.migration import MigrationContext

    with engine.connect() as connection:
        return MigrationContext.configure(connection).get_current_revision()
