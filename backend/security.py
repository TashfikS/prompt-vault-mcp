"""Production security utilities: rate limiting, security headers, audit logging, and input sanitization."""

from __future__ import annotations

import os
import re
import threading
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Callable

from fastapi import HTTPException, Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from sqlalchemy.orm import Session

from models import AuditLog

ENV = (os.getenv("PROMPT_HOLD_ENV") or os.getenv("PROMPT_VAULT_ENV", "development")).strip().lower()
IS_PRODUCTION = ENV == "production"
TRUST_PROXY_HEADERS = os.getenv("TRUST_PROXY_HEADERS", "false").strip().lower() in {"1", "true", "yes"}

MAX_UPLOAD_FILES = int(os.getenv("MAX_UPLOAD_FILES", "10"))
MAX_UPLOAD_FILE_BYTES = int(os.getenv("MAX_UPLOAD_FILE_BYTES", str(1 * 1024 * 1024)))  # 1 MB per file
MAX_BATCH_PROMPTS_PER_FILE = int(os.getenv("MAX_BATCH_PROMPTS_PER_FILE", "200"))


def should_seed_demo_data() -> bool:
    """Seed demo accounts by default in development, and never in production unless explicitly forced."""
    raw = os.getenv("SEED_DEMO_DATA")
    if raw is not None:
        return raw.strip().lower() in {"1", "true", "yes"}
    return not IS_PRODUCTION


def get_allowed_origins() -> list[str]:
    """Return explicit CORS allowed origins instead of wildcard '*'."""
    raw = os.getenv("ALLOWED_ORIGINS", "").strip()
    if raw:
        return [origin.strip() for origin in raw.split(",") if origin.strip()]
    app_url = os.getenv("PROMPT_VAULT_APP_URL", "http://localhost:5173").rstrip("/")
    defaults = {
        app_url,
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:8002",
        "http://127.0.0.1:8002",
    }
    return sorted(defaults)


def get_client_ip(request: Request | None) -> str:
    """Extract client IP safely, only trusting forwarding headers when TRUST_PROXY_HEADERS=true."""
    if request is None:
        return "unknown"
    if TRUST_PROXY_HEADERS:
        cf_ip = request.headers.get("cf-connecting-ip")
        if cf_ip:
            return cf_ip.strip()[:64]
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()[:64]
    if request.client and request.client.host:
        return request.client.host[:64]
    return "unknown"


class SlidingWindowRateLimiter:
    """Thread-safe in-memory sliding-window rate limiter with automatic cleanup."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._last_cleanup = time.monotonic()

    def _cleanup(self, now: float, max_window: float = 900.0) -> None:
        if now - self._last_cleanup < 120.0:
            return
        self._last_cleanup = now
        stale_keys = [
            key for key, timestamps in self._hits.items()
            if not timestamps or (now - timestamps[-1]) > max_window
        ]
        for key in stale_keys:
            self._hits.pop(key, None)

    def check(self, bucket_key: str, limit: int, window_seconds: int, detail: str = "Too many requests. Please wait and try again.") -> None:
        now = time.monotonic()
        cutoff = now - window_seconds
        with self._lock:
            self._cleanup(now)
            q = self._hits[bucket_key]
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= limit:
                retry_after = max(1, int(window_seconds - (now - q[0])))
                raise HTTPException(
                    status_code=429,
                    detail=detail,
                    headers={"Retry-After": str(retry_after)},
                )
            q.append(now)

    def record_hit(self, bucket_key: str) -> None:
        now = time.monotonic()
        with self._lock:
            self._hits[bucket_key].append(now)

    def count_recent(self, bucket_key: str, window_seconds: int) -> int:
        now = time.monotonic()
        cutoff = now - window_seconds
        with self._lock:
            q = self._hits.get(bucket_key)
            if not q:
                return 0
            while q and q[0] <= cutoff:
                q.popleft()
            return len(q)

    def clear_bucket(self, bucket_key: str) -> None:
        with self._lock:
            self._hits.pop(bucket_key, None)


rate_limiter = SlidingWindowRateLimiter()


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Attach hardened HTTP security headers and baseline per-IP rate limiting to all responses."""

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        client_ip = get_client_ip(request)
        if (request.url.path.startswith("/api/") or request.url.path.startswith("/mcp")) and request.url.path != "/api/health":
            try:
                rate_limiter.check(
                    f"global_api:{client_ip}",
                    limit=240,
                    window_seconds=60,
                    detail="Rate limit exceeded. Please slow down your requests.",
                )
            except HTTPException as exc:
                from fastapi.responses import JSONResponse
                return JSONResponse(
                    status_code=exc.status_code,
                    content={"detail": exc.detail},
                    headers=exc.headers or {},
                )

        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=()"
        response.headers["X-Permitted-Cross-Domain-Policies"] = "none"

        # Allow embedding in MCP hosts when in MCP mode, otherwise restrict framing to same-origin
        mcp_mode = request.query_params.get("mcp_mode") == "1" or request.url.path.startswith("/mcp")
        frame_ancestors = (
            "'self' https://claude.ai https://*.claude.ai https://chatgpt.com https://*.openai.com https://huggingface.co https://*.hf.space"
            if mcp_mode
            else "'self' https://huggingface.co https://*.hf.space"
        )

        csp = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com data:; "
            "img-src 'self' data: blob:; "
            "connect-src 'self' http://localhost:* http://127.0.0.1:* https://*; "
            f"frame-ancestors {frame_ancestors}; "
            "base-uri 'self'; "
            "form-action 'self'"
        )
        response.headers["Content-Security-Policy"] = csp

        if IS_PRODUCTION or request.url.scheme == "https":
            response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload"

        return response


def escape_like(raw: str) -> str:
    """Escape SQL LIKE/ILIKE wildcard characters (%, _, \\) to prevent wildcard DoS injection."""
    return raw.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")


def sanitize_filename(raw_filename: str | None) -> str:
    """Strip directory traversal components and control characters from uploaded filenames."""
    if not raw_filename:
        return "upload.txt"
    cleaned = _CONTROL_CHARS_RE.sub("", raw_filename).replace("\\", "/")
    name = Path(cleaned).name.strip()
    if not name or name in {".", ".."}:
        return "upload.txt"
    return name[:255]


def record_audit_log(
    db: Session,
    action: str,
    user_id: str | None = None,
    ip_address: str = "unknown",
    target_type: str | None = None,
    target_id: str | None = None,
    details: str = "",
) -> None:
    """Persist an immutable security audit event without interrupting the caller transaction on error."""
    try:
        entry = AuditLog(
            user_id=user_id,
            action=action[:64],
            ip_address=ip_address[:64],
            target_type=target_type[:64] if target_type else None,
            target_id=target_id[:64] if target_id else None,
            details=details[:1000],
        )
        db.add(entry)
        db.commit()
    except Exception:
        db.rollback()
