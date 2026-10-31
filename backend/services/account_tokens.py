"""One-time email-verification and password-reset tokens.

Raw tokens go only into the emailed link; the user row stores their SHA-256
hash and expiry, so a database leak cannot be replayed and issuing a new token
invalidates the previous one.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from auth import hash_session_token
from models import User

VERIFY_TTL = timedelta(hours=48)
RESET_TTL = timedelta(hours=1)


def issue_verify_token(user: User) -> str:
    raw = secrets.token_urlsafe(32)
    user.verify_token_hash = hash_session_token(raw)
    user.verify_token_expires_at = datetime.utcnow() + VERIFY_TTL
    return raw


def issue_reset_token(user: User) -> str:
    raw = secrets.token_urlsafe(32)
    user.reset_token_hash = hash_session_token(raw)
    user.reset_token_expires_at = datetime.utcnow() + RESET_TTL
    return raw


def find_user_by_verify_token(db: Session, raw: str) -> User | None:
    user = db.query(User).filter(User.verify_token_hash == hash_session_token(raw)).first()
    if user is None or not user.verify_token_expires_at or user.verify_token_expires_at < datetime.utcnow():
        return None
    return user


def find_user_by_reset_token(db: Session, raw: str) -> User | None:
    user = db.query(User).filter(User.reset_token_hash == hash_session_token(raw)).first()
    if user is None or not user.reset_token_expires_at or user.reset_token_expires_at < datetime.utcnow():
        return None
    return user


def mark_email_verified(user: User) -> None:
    if user.email_verified_at is None:
        user.email_verified_at = datetime.utcnow()
    user.verify_token_hash = None
    user.verify_token_expires_at = None
