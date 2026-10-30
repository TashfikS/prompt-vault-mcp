"""Workspace, group membership, prompt and immutable version models."""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


def new_id() -> str:
    return str(uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
    is_workspace_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    api_key: Mapped[str | None] = mapped_column(String(200), unique=True, index=True)
    password_hash: Mapped[str | None] = mapped_column(String(255))
    onboarding_completed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    plan: Mapped[str] = mapped_column(String(32), default="community", nullable=False)
    polar_customer_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    polar_subscription_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    failed_login_attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    memberships: Mapped[list["GroupMembership"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class AuthSession(Base):
    """Opaque login token issued to the web UI after a successful sign-in."""
    __tablename__ = "auth_sessions"

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class ApiKey(Base):
    """Scoped API key with hashed secret (raw key shown only once on creation) and persistent metadata."""
    __tablename__ = "api_keys"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    key_prefix: Mapped[str] = mapped_column(String(40), nullable=False)
    key_hash: Mapped[str] = mapped_column(String(128), unique=True, index=True, nullable=False)
    scope_type: Mapped[str] = mapped_column(String(32), default="GLOBAL", nullable=False)  # GLOBAL or GROUP
    access_level: Mapped[str] = mapped_column(String(32), default="READ_WRITE", nullable=False)  # READ_ONLY or READ_WRITE
    group_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("groups.id"), index=True, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)



class Group(Base):
    __tablename__ = "groups"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(160), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    # Set only for a user's private "Personal" space; such groups are never shared.
    personal_owner_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"), index=True)
    required_approvals: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    allow_self_approval: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    memberships: Mapped[list["GroupMembership"]] = relationship(back_populates="group", cascade="all, delete-orphan")


class GroupMembership(Base):
    __tablename__ = "group_memberships"
    __table_args__ = (UniqueConstraint("user_id", "group_id", name="uq_user_group"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), index=True, nullable=False)
    group_id: Mapped[str] = mapped_column(String(36), ForeignKey("groups.id"), index=True, nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    added_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    user: Mapped[User] = relationship(back_populates="memberships")
    group: Mapped[Group] = relationship(back_populates="memberships")


class Prompt(Base):
    __tablename__ = "prompts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    group_id: Mapped[str] = mapped_column(String(36), ForeignKey("groups.id"), index=True, nullable=False)
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    current_version_number: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    current_version_id: Mapped[str | None] = mapped_column(String(36), index=True, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    versions: Mapped[list["PromptVersion"]] = relationship(back_populates="prompt", cascade="all, delete-orphan")
    chunks: Mapped[list["PromptChunk"]] = relationship(back_populates="prompt", cascade="all, delete-orphan")


class PromptChunk(Base):
    """Search chunk and vector embedding for a prompt's active version."""
    __tablename__ = "prompt_chunks"
    __table_args__ = (
        Index("ix_prompt_chunks_prompt_id", "prompt_id"),
        Index("ix_prompt_chunks_version_id", "version_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    prompt_id: Mapped[str] = mapped_column(String(36), ForeignKey("prompts.id", ondelete="CASCADE"), nullable=False)
    version_id: Mapped[str] = mapped_column(String(36), ForeignKey("prompt_versions.id", ondelete="CASCADE"), nullable=False)
    chunk_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    chunk_text: Mapped[str] = mapped_column(Text, nullable=False)
    embedding_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    prompt: Mapped[Prompt] = relationship(back_populates="chunks")


class PromptVersion(Base):
    __tablename__ = "prompt_versions"
    __table_args__ = (
        Index("ix_prompt_version_lookup", "prompt_id", "version_number"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    prompt_id: Mapped[str] = mapped_column(String(36), ForeignKey("prompts.id"), index=True, nullable=False)
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    variables_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    change_Note: Mapped[str] = mapped_column(String(500), default="Initial version", nullable=False)
    source_filename: Mapped[str | None] = mapped_column(String(255))
    author_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    prompt: Mapped[Prompt] = relationship(back_populates="versions")

    @property
    def change_note(self) -> str:
        return self.change_Note

    @change_note.setter
    def change_note(self, value: str) -> None:
        self.change_Note = value


class SharedDiffLink(Base):
    __tablename__ = "shared_diff_links"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    prompt_id: Mapped[str] = mapped_column(String(36), ForeignKey("prompts.id"), nullable=False)
    base_version: Mapped[int] = mapped_column(Integer, nullable=False)
    target_version: Mapped[int] = mapped_column(Integer, nullable=False)
    diff_granularity: Mapped[str] = mapped_column(String(16), default="word", nullable=False)
    view_mode: Mapped[str] = mapped_column(String(16), default="split", nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    is_revoked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class PromptProposal(Base):
    """Proposal submitted by a member awaiting review/approval before becoming a prompt version."""
    __tablename__ = "prompt_proposals"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    prompt_id: Mapped[str] = mapped_column(String(36), ForeignKey("prompts.id"), index=True, nullable=False)
    group_id: Mapped[str] = mapped_column(String(36), ForeignKey("groups.id"), index=True, nullable=False)
    proposer_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), index=True, nullable=False)
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    change_note: Mapped[str] = mapped_column(String(500), default="Proposed edit", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="PENDING", nullable=False)  # PENDING, APPROVED, REJECTED
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    approvals: Mapped[list["ProposalApproval"]] = relationship(back_populates="proposal", cascade="all, delete-orphan")
    comments: Mapped[list["ProposalComment"]] = relationship(back_populates="proposal", cascade="all, delete-orphan", order_by="ProposalComment.created_at.asc()")


class ProposalApproval(Base):
    """Approval cast by a group leader or moderator for a prompt proposal."""
    __tablename__ = "proposal_approvals"
    __table_args__ = (UniqueConstraint("proposal_id", "user_id", name="uq_proposal_user"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    proposal_id: Mapped[str] = mapped_column(String(36), ForeignKey("prompt_proposals.id"), index=True, nullable=False)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    proposal: Mapped[PromptProposal] = relationship(back_populates="approvals")


class ProposalComment(Base):
    """Review comment, feedback, or discussion message on a prompt proposal."""
    __tablename__ = "proposal_comments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    proposal_id: Mapped[str] = mapped_column(String(36), ForeignKey("prompt_proposals.id", ondelete="CASCADE"), index=True, nullable=False)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), index=True, nullable=False)
    comment: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    proposal: Mapped[PromptProposal] = relationship(back_populates="comments")
    user: Mapped[User] = relationship()


class AuditLog(Base):
    """Immutable security audit trail for authentication, RBAC permission changes, API keys, and prompt mutations."""
    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"), index=True, nullable=True)
    action: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    ip_address: Mapped[str] = mapped_column(String(64), default="unknown", nullable=False)
    target_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    target_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    details: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True, nullable=False)


class FeedbackSubmission(Base):
    """User complaint, bug report, feature request, or contact message synced to GitHub Issues."""
    __tablename__ = "feedback_submissions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"), index=True, nullable=True)
    reporter_name: Mapped[str] = mapped_column(String(160), default="Anonymous", nullable=False)
    reporter_email: Mapped[str] = mapped_column(String(320), default="", nullable=False)
    category: Mapped[str] = mapped_column(String(32), default="complaint", index=True, nullable=False)  # complaint, bug, feature, contact
    subject: Mapped[str] = mapped_column(String(240), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    page_url: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    github_issue_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    github_issue_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="OPEN", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True, nullable=False)


class OAuthClient(Base):
    """Registered OAuth 2.0 / 2.1 client (e.g. Claude.ai, ChatGPT, or custom integrations)."""
    __tablename__ = "oauth_clients"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # client_id
    client_secret: Mapped[str | None] = mapped_column(String(128), nullable=True)
    client_name: Mapped[str] = mapped_column(String(160), default="AI Assistant", nullable=False)
    redirect_uris_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    grant_types_json: Mapped[str] = mapped_column(Text, default='["authorization_code", "refresh_token"]', nullable=False)
    response_types_json: Mapped[str] = mapped_column(Text, default='["code"]', nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class OAuthAuthorizationCode(Base):
    """Temporary one-time authorization code issued during OAuth 2.0 PKCE flow."""
    __tablename__ = "oauth_authorization_codes"

    code: Mapped[str] = mapped_column(String(128), primary_key=True)
    client_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), index=True, nullable=False)
    redirect_uri: Mapped[str] = mapped_column(String(500), nullable=False)
    code_challenge: Mapped[str | None] = mapped_column(String(256), nullable=True)
    code_challenge_method: Mapped[str | None] = mapped_column(String(32), default="S256", nullable=True)
    scope: Mapped[str] = mapped_column(String(160), default="prompts", nullable=False)
    is_used: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

