"""Cross-tier team membership.

Every user has one *home* database (Supabase for Community, Neon for paid plans), which holds
their account, sessions, API keys and Personal space. A team group lives in its owner's home
database. When someone joins a team stored in the other (*peer*) database, the peer gets a
*stub* user row with the same id: a name tag with no password or sessions, so the team's rows
(memberships, versions, proposals, approvals) keep valid foreign keys. The real account is
flagged ``has_peer_memberships`` so only those users ever open the peer database; everyone
else stays on their home tier (Community traffic never wakes Neon).

Requests about one group, prompt or proposal run against whichever database holds it, as the
stub (never a workspace admin there). Lists merge both databases for flagged users.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime

from sqlalchemy.orm import Session, sessionmaker

import database
from models import Group, GroupMembership, Prompt, PromptProposal, SharedDiffLink, User

ROUTED_RESOURCES = (("prompt_id", Prompt), ("proposal_id", PromptProposal), ("share_id", SharedDiffLink), ("group_id", Group))


def peer_sessionmaker_for(db: Session) -> sessionmaker[Session] | None:
    """Sessionmaker for the database tier that ``db`` is not on (None in single-database deployments)."""
    if database.SUPABASE_DATABASE_URL == database.NEON_DATABASE_URL:
        return None
    url = database.get_db_bind_url(db)
    if url == str(database.engine_neon.url):
        return database.SessionSupabase
    if url == str(database.engine_supabase.url):
        return database.SessionNeon
    return None


def peer_view(peer_db: Session, user: User) -> User | None:
    """The user's stub in ``peer_db``, carrying the request's API key; None if they have none there."""
    stub = peer_db.query(User).filter_by(id=user.id).first()
    if stub is not None:
        stub._active_api_key = getattr(user, "_active_api_key", None)  # type: ignore[attr-defined]
    return stub


@contextmanager
def open_peer(db: Session, user: User) -> Iterator[tuple[Session, User] | None]:
    """Yield ``(peer_db, stub)`` for a user with teams in the other tier, otherwise None (no connection opened)."""
    if not getattr(user, "has_peer_memberships", False):
        yield None
        return
    factory = peer_sessionmaker_for(db)
    if factory is None:
        yield None
        return
    peer_db = factory()
    try:
        stub = peer_view(peer_db, user)
        yield (peer_db, stub) if stub is not None else None
    finally:
        peer_db.close()


def _holds(db: Session, model, row_id: str) -> bool:
    return db.query(model.id).filter_by(id=row_id).first() is not None


@contextmanager
def db_for(db: Session, user: User, model, row_id: str | None) -> Iterator[tuple[Session, User]]:
    """Yield the ``(session, user)`` pair for the database holding ``model`` row ``row_id``."""
    if row_id and not _holds(db, model, row_id):
        with open_peer(db, user) as peer:
            if peer is not None and _holds(peer[0], model, row_id):
                yield peer
                return
    yield db, user


def db_for_group(db: Session, user: User, group_id: str | None):
    return db_for(db, user, Group, group_id)


def merged(db: Session, user: User, fn) -> list:
    """``fn(db, user)`` on the home database, plus on the peer database when the user has teams there."""
    rows = list(fn(db, user))
    with open_peer(db, user) as peer:
        if peer is not None:
            rows.extend(fn(*peer))
    return rows


def find_real_user_in_peer(db: Session, *, user_id: str | None = None, email: str | None = None) -> tuple[Session, User] | None:
    """Look up a real (non-stub) account in the other tier. Caller must close the returned session."""
    factory = peer_sessionmaker_for(db)
    if factory is None:
        return None
    peer_db = factory()
    query = peer_db.query(User).filter(User.is_peer_stub.is_(False))
    found = query.filter_by(id=user_id).first() if user_id else query.filter(User.email == (email or "")).first()
    if found is None:
        peer_db.close()
        return None
    return peer_db, found


def ensure_stub(db: Session, real: User) -> User:
    """Create (or refresh) the name-tag row for ``real`` in ``db``."""
    stub = db.query(User).filter_by(id=real.id).first()
    if stub is None:
        stub = User(id=real.id, email=real.email, name=real.name, is_peer_stub=True)
        db.add(stub)
    stub.name = real.name
    stub.email = real.email
    stub.plan = real.plan or "community"
    stub.is_workspace_admin = False
    stub.password_hash = None
    stub.email_verified_at = real.email_verified_at or datetime.utcnow()
    db.flush()
    return stub


def sync_stub(home_db: Session, real: User) -> None:
    """Copy name/email/plan changes of a real account to its stub in the other tier, if any."""
    if not getattr(real, "has_peer_memberships", False):
        return
    factory = peer_sessionmaker_for(home_db)
    if factory is None:
        return
    with factory() as peer_db:
        if peer_db.query(User.id).filter_by(id=real.id, is_peer_stub=True).first():
            ensure_stub(peer_db, real)
            peer_db.commit()


def refresh_peer_flag(group_db: Session, user_id: str) -> None:
    """After a membership change in ``group_db``, set the real account's flag from whether any remain."""
    stub = group_db.query(User).filter_by(id=user_id, is_peer_stub=True).first()
    if stub is None:
        return
    still_member = group_db.query(GroupMembership.id).filter_by(user_id=user_id).first() is not None
    found = find_real_user_in_peer(group_db, user_id=user_id)
    if found is None:
        return
    home_db, real = found
    try:
        if real.has_peer_memberships != still_member:
            real.has_peer_memberships = still_member
            home_db.commit()
    finally:
        home_db.close()
