"""Stateless multi-pod cache layer (external Redis only — zero in-process prompt caching) and GitHub Issue reporter."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

REDIS_URL = os.getenv("REDIS_URL", "").strip()
_redis_client: Any = None


def _get_redis() -> Any:
    """Lazy-initialize the shared Redis client when REDIS_URL is configured."""
    global _redis_client
    if not REDIS_URL:
        return None
    if _redis_client is not None:
        return _redis_client
    try:
        import redis  # type: ignore[import-untyped]
        _redis_client = redis.from_url(
            REDIS_URL,
            decode_responses=True,
            socket_connect_timeout=1.5,
            socket_timeout=1.5,
        )
        return _redis_client
    except Exception:
        return None


def _reset_redis_client() -> None:
    """Reset the cached Redis client (used when REDIS_URL changes or in tests)."""
    global _redis_client
    _redis_client = None


def get_cached_version_by_uuid(version_uuid: str | None) -> dict[str, Any] | None:
    """Fetch an immutable PromptVersion payload by its globally unique UUID from shared Redis."""
    if not version_uuid:
        return None
    client = _get_redis()
    if client is None:
        return None
    try:
        raw = client.get(f"pv:ver_uuid:{version_uuid}") or client.get(f"pv:ver:{version_uuid}")
        return json.loads(raw) if raw else None
    except Exception:
        return None


def set_cached_version_by_uuid(version_uuid: str, payload: dict[str, Any], ttl_seconds: int = 604800) -> None:
    """Cache an immutable PromptVersion payload by its UUID in shared Redis (default 7 days)."""
    client = _get_redis()
    if client is None or not version_uuid:
        return
    try:
        client.setex(f"pv:ver_uuid:{version_uuid}", ttl_seconds, json.dumps(payload))
    except Exception:
        pass


def get_cached_active_version_uuid(prompt_id: str) -> str | None:
    """Return the active PromptVersion UUID for a prompt from shared Redis."""
    client = _get_redis()
    if client is None:
        return None
    try:
        val = client.get(f"pv:prompt_active:{prompt_id}")
        return str(val) if val else None
    except Exception:
        return None


def set_cached_active_version_uuid(prompt_id: str, version_uuid: str, ttl_seconds: int = 300) -> None:
    """Cache the active PromptVersion UUID pointer for a prompt in shared Redis."""
    client = _get_redis()
    if client is None or not prompt_id or not version_uuid:
        return
    try:
        client.setex(f"pv:prompt_active:{prompt_id}", ttl_seconds, version_uuid)
    except Exception:
        pass


def invalidate_prompt_cache(prompt_id: str) -> None:
    """Invalidate the active version pointer across all pods when a prompt is updated or rolled back."""
    client = _get_redis()
    if client is None or not prompt_id:
        return
    try:
        client.delete(f"pv:prompt_active:{prompt_id}")
    except Exception:
        pass


def create_github_issue_for_feedback(
    category: str,
    subject: str,
    message: str,
    contact_name: str = "",
    contact_email: str = "",
    page_url: str | None = None,
    submission_id: str = "",
) -> dict:
    """Create a GitHub Issue in GITHUB_ISSUE_REPO using GITHUB_ISSUE_TOKEN.
    Returns {"created": bool, "issue_number": int | None, "issue_url": str | None, "error": str | None}.
    """
    repo = os.getenv("GITHUB_ISSUE_REPO", "").strip()  # e.g. "owner/prompt-vault-mcp"
    token = os.getenv("GITHUB_ISSUE_TOKEN", "").strip()
    if not repo or not token:
        return {
            "created": False,
            "issue_number": None,
            "issue_url": None,
            "error": "GITHUB_ISSUE_REPO or GITHUB_ISSUE_TOKEN not configured; saved in database.",
        }

    label_map = {
        "complaint": ["user-feedback", "complaint"],
        "bug": ["user-feedback", "bug"],
        "feature": ["user-feedback", "enhancement"],
        "feature_request": ["user-feedback", "enhancement"],
        "contact": ["user-feedback", "contact"],
    }
    labels = label_map.get(category.lower(), ["user-feedback"])
    prefix = category.upper()
    title = f"[{prefix}] {subject.strip()}"[:240]

    body_lines = [
        f"### User {category.replace('_', ' ').title()} Submission",
        "",
        f"- **Category:** `{category}`",
        f"- **Reporter:** {contact_name or 'Anonymous'} (`{contact_email or 'not provided'}`)",
    ]
    if page_url:
        body_lines.append(f"- **Page / View:** `{page_url}`")
    if submission_id:
        body_lines.append(f"- **Submission ID:** `{submission_id}`")
    body_lines.extend([
        "",
        "---",
        "",
        "### Details",
        "",
        message.strip(),
    ])

    payload = json.dumps({
        "title": title,
        "body": "\n".join(body_lines),
        "labels": labels,
    }).encode("utf-8")

    url = f"https://api.github.com/repos/{repo}/issues"
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "PromptVault-Feedback-Bot/2.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=6.0) as resp:  # nosec B310
            data = json.loads(resp.read().decode("utf-8"))
            return {
                "created": True,
                "issue_number": data.get("number"),
                "issue_url": data.get("html_url"),
                "error": None,
            }
    except urllib.error.HTTPError as exc:
        # Retry without labels in case repository doesn't allow label creation permissions
        if exc.code in {403, 422}:
            try:
                fallback_payload = json.dumps({"title": title, "body": "\n".join(body_lines)}).encode("utf-8")
                fallback_req = urllib.request.Request(url, data=fallback_payload, method="POST", headers=req.headers)
                with urllib.request.urlopen(fallback_req, timeout=6.0) as resp2:  # nosec B310
                    data2 = json.loads(resp2.read().decode("utf-8"))
                    return {
                        "created": True,
                        "issue_number": data2.get("number"),
                        "issue_url": data2.get("html_url"),
                        "error": None,
                    }
            except Exception as inner_exc:
                return {"created": False, "issue_number": None, "issue_url": None, "error": f"GitHub API HTTP {exc.code}: {inner_exc}"}
        return {"created": False, "issue_number": None, "issue_url": None, "error": f"GitHub API HTTP {exc.code}"}
    except Exception as exc:
        return {"created": False, "issue_number": None, "issue_url": None, "error": str(exc)}

