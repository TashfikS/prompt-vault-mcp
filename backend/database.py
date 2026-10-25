"""SQLAlchemy database setup for PromptHold."""

import os
from collections.abc import Generator
from dotenv import find_dotenv, load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

load_dotenv(find_dotenv(usecwd=True))

_default_sqlite = "sqlite:///./prompt_vault.db" if os.path.exists("./prompt_vault.db") else "sqlite:///./prompthold.db"
_raw_db_url = os.getenv("DATABASE_URL", _default_sqlite)
if _raw_db_url.startswith("postgres://"):
    DATABASE_URL = _raw_db_url.replace("postgres://", "postgresql+psycopg://", 1)
elif _raw_db_url.startswith("postgresql://") and "+psycopg" not in _raw_db_url and "+psycopg2" not in _raw_db_url:
    try:
        import psycopg  # noqa: F401
        DATABASE_URL = _raw_db_url.replace("postgresql://", "postgresql+psycopg://", 1)
    except ImportError:
        DATABASE_URL = _raw_db_url
else:
    DATABASE_URL = _raw_db_url

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {},
    pool_pre_ping=True,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    """Base class for mapped models."""


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

