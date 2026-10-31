"""Alembic environment.

Programmatic use (app startup, tests): ``migrations.run_migrations(engine)`` passes a
live connection via ``config.attributes["connection"]``.
CLI use (``cd backend && alembic revision --autogenerate -m "..."``) needs an explicit
``ALEMBIC_DATABASE_URL`` so it never silently targets the DATABASE_URL in .env.
"""

import os
import sys
from pathlib import Path

from alembic import context
from sqlalchemy import create_engine

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import models  # noqa: E402,F401  (registers tables on Base.metadata)
from database import Base  # noqa: E402

config = context.config
target_metadata = Base.metadata


def _run(connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=connection.dialect.name == "sqlite",  # SQLite needs batch ALTERs
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


connection = config.attributes.get("connection")
if connection is not None:
    _run(connection)
else:
    url = os.getenv("ALEMBIC_DATABASE_URL")
    if not url:
        raise SystemExit("Set ALEMBIC_DATABASE_URL to the database you intend to migrate.")
    from database import normalize_db_url

    with create_engine(normalize_db_url(url)).connect() as conn:
        _run(conn)
        conn.commit()
