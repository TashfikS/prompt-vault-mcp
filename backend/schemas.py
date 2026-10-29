"""Validated API request and response models."""

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


def validate_password_complexity(v: str) -> str:
    if len(v) < 8:
        raise ValueError("Password must be at least 8 characters long.")
    if not re.search(r"[A-Za-z]", v) or not re.search(r"\d", v):
        raise ValueError("Password must include both letters and numbers.")
    return v


class RegisterRequest(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    email: str = Field(min_length=3, max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    password: str = Field(min_length=8, max_length=200)
    plan: Literal["community", "pro", "team", "enterprise"] = "community"

    @field_validator("password")
    @classmethod
    def validate_password_strength(cls, v: str) -> str:
        return validate_password_complexity(v)


class LoginRequest(BaseModel):
    email: str = Field(min_length=1, max_length=320)
    password: str = Field(min_length=1, max_length=200)


class UpdateProfileRequest(BaseModel):
    name: str = Field(min_length=1, max_length=160)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)

    @field_validator("new_password")
    @classmethod
    def validate_new_password_strength(cls, v: str) -> str:
        return validate_password_complexity(v)


class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    manager_user_id: str | None = Field(default=None, max_length=64)


class AssignMemberRequest(BaseModel):
    user_id: str | None = Field(default=None, max_length=64)
    email: str | None = Field(default=None, max_length=320)
    role: Literal["GROUP_MANAGER", "MEMBER", "GUEST"] = "MEMBER"

    @model_validator(mode="after")
    def require_user_reference(self) -> "AssignMemberRequest":
        if not (self.user_id or (self.email and self.email.strip())):
            raise ValueError("Enter the email address of the person you want to add.")
        return self


class GroupSettingsUpdate(BaseModel):
    required_approvals: int = Field(ge=1, le=10)


class ProposalCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    description: str = Field(default="", max_length=2000)
    content: str = Field(min_length=1, max_length=100_000)
    change_note: str = Field(default="Proposed prompt change", max_length=500)


class PromptCreateRequest(BaseModel):
    group_id: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=240)
    description: str = Field(default="", max_length=2000)
    content: str = Field(min_length=1, max_length=100_000)
    change_note: str = Field(default="Initial creation", max_length=500)
    source_filename: str | None = Field(default=None, max_length=255)


class PromptUpdateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=240)
    description: str | None = Field(default=None, max_length=2000)
    content: str = Field(min_length=1, max_length=100_000)
    change_note: str = Field(default="Updated prompt", max_length=500)
    source_filename: str | None = Field(default=None, max_length=255)


class PromptDuplicateRequest(BaseModel):
    target_group_id: str = Field(min_length=1, max_length=64)
    title: str | None = Field(default=None, max_length=240)
    new_title: str | None = Field(default=None, max_length=240)
    mode: Literal["copy", "move"] = "copy"

    @model_validator(mode="after")
    def sync_title_alias(self) -> "PromptDuplicateRequest":
        if not self.title and self.new_title:
            self.title = self.new_title
        return self



class CreateDiffShareRequest(BaseModel):
    prompt_id: str = Field(min_length=1, max_length=64)
    base_version: int = Field(ge=1)
    target_version: int = Field(ge=1)
    diff_granularity: Literal["word", "sentence"] = "word"
    view_mode: Literal["split", "inline"] = "split"
    expires_in_days: int | None = Field(default=7, ge=1, le=90)


class PromptSaveFromChat(BaseModel):
    new_content: str = Field(min_length=1, max_length=100_000)
    change_note: str = Field(default="Updated via AI Chat", max_length=500)


class PromptFillRequest(BaseModel):
    variables: dict[str, str] = Field(default_factory=dict)

    @field_validator("variables")
    @classmethod
    def validate_variables_bounds(cls, v: dict[str, str]) -> dict[str, str]:
        if len(v) > 100:
            raise ValueError("Too many variables provided (max 100).")
        for k, val in v.items():
            if len(k) > 120 or len(val) > 20_000:
                raise ValueError("Variable name or value exceeds maximum allowed length.")
        return v


class CreateApiKeyRequest(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=500)
    scope_type: Literal["GLOBAL", "GROUP"] = "GLOBAL"
    access_level: Literal["READ_ONLY", "READ_WRITE"] = "READ_WRITE"
    group_id: str | None = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def validate_group_scope(self) -> "CreateApiKeyRequest":
        if self.scope_type == "GROUP" and not (self.group_id and self.group_id.strip()):
            raise ValueError("Please select a group or Personal space for a group-scoped API key.")
        return self


class FirebaseAuthRequest(BaseModel):
    id_token: str = Field(min_length=10, max_length=8000)
    display_name: str | None = Field(default=None, max_length=160)


class FeedbackCreateRequest(BaseModel):
    category: str = Field(default="COMPLAINT", max_length=40)
    subject: str = Field(min_length=2, max_length=240)
    message: str = Field(min_length=5, max_length=10_000)
    contact_name: str | None = Field(default=None, max_length=160)
    contact_email: str | None = Field(default=None, max_length=320)
    page_url: str | None = Field(default=None, max_length=500)

    @field_validator("category")
    @classmethod
    def normalize_category(cls, value: str) -> str:
        cleaned = (value or "COMPLAINT").strip().upper()
        mapping = {
            "COMPLAINT": "COMPLAINT",
            "BUG": "BUG",
            "FEATURE": "FEATURE_REQUEST",
            "FEATURE_REQUEST": "FEATURE_REQUEST",
            "CONTACT": "CONTACT",
        }
        if cleaned not in mapping:
            raise ValueError("Category must be COMPLAINT, BUG, FEATURE_REQUEST, or CONTACT.")
        return mapping[cleaned]


class PlanUpdateRequest(BaseModel):
    plan: Literal["community", "pro", "team", "enterprise"]


