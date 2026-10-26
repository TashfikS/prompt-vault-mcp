"""Production security utilities: rate limiting, security headers, audit logging, and input sanitization."""

from __future__ import annotations

import os
import re
import secrets
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
AUTO_MIGRATE_DB = os.getenv("AUTO_MIGRATE_DB", "true").strip().lower() in {"1", "true", "yes"}


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
    """Thread-safe rate limiter with Redis sliding-window support and automatic in-memory fallback."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._last_cleanup = time.monotonic()

    def _cleanup_memory(self, now: float, max_window: float = 900.0) -> None:
        if now - self._last_cleanup < 120.0:
            return
        self._last_cleanup = now
        stale_keys = [
            key for key, timestamps in self._hits.items()
            if not timestamps or (now - timestamps[-1]) > max_window
        ]
        for key in stale_keys:
            self._hits.pop(key, None)

    def _check_redis(self, bucket_key: str, limit: int, window_seconds: int, detail: str) -> bool:
        """Attempt to check and record a rate limit hit in shared Redis.

        Returns True if Redis evaluated the rate limit. Returns False if Redis is unconfigured or unavailable.
        """
        try:
            from cache import _get_redis
            client = _get_redis()
            if client is None:
                return False

            now = time.time()
            cutoff = now - window_seconds
            redis_key = f"pv:rl:{bucket_key}"
            member_id = f"{now:.6f}:{secrets.token_hex(4)}"

            pipe = client.pipeline()
            pipe.zremrangebyscore(redis_key, 0, cutoff)
            pipe.zcard(redis_key)
            pipe.zadd(redis_key, {member_id: now})
            pipe.expire(redis_key, window_seconds + 5)
            results = pipe.execute()

            current_count = results[1]
            if current_count >= limit:
                raise HTTPException(
                    status_code=429,
                    detail=detail,
                    headers={"Retry-After": str(max(1, window_seconds))},
                )
            return True
        except HTTPException:
            raise
        except Exception:
            # Fall back cleanly to in-memory limiter on Redis connection issues
            return False

    def check(self, bucket_key: str, limit: int, window_seconds: int, detail: str = "Too many requests. Please wait and try again.") -> None:
        if self._check_redis(bucket_key, limit, window_seconds, detail):
            return

        now = time.monotonic()
        cutoff = now - window_seconds
        with self._lock:
            self._cleanup_memory(now)
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
        try:
            from cache import _get_redis
            client = _get_redis()
            if client is not None:
                now = time.time()
                redis_key = f"pv:rl:{bucket_key}"
                pipe = client.pipeline()
                pipe.zadd(redis_key, {f"{now:.6f}:{secrets.token_hex(4)}": now})
                pipe.expire(redis_key, 3600)
                pipe.execute()
        except Exception:
            pass

        now = time.monotonic()
        with self._lock:
            self._hits[bucket_key].append(now)

    def count_recent(self, bucket_key: str, window_seconds: int) -> int:
        try:
            from cache import _get_redis
            client = _get_redis()
            if client is not None:
                now = time.time()
                cutoff = now - window_seconds
                redis_key = f"pv:rl:{bucket_key}"
                pipe = client.pipeline()
                pipe.zremrangebyscore(redis_key, 0, cutoff)
                pipe.zcard(redis_key)
                results = pipe.execute()
                return int(results[1])
        except Exception:
            pass

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
        try:
            from cache import _get_redis
            client = _get_redis()
            if client is not None:
                client.delete(f"pv:rl:{bucket_key}")
        except Exception:
            pass

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


DISALLOWED_BINARY_PREFIXES: tuple[bytes, ...] = (
    b"\x7fELF",              # Linux ELF executables
    b"MZ",                   # Windows DOS / PE / EXE / DLL
    b"\xca\xfe\xba\xbe",      # Java class / Mach-O Fat Binary
    b"\xfe\xed\xfa\xce",      # Mach-O 32-bit binary
    b"\xfe\xed\xfa\xcf",      # Mach-O 64-bit binary
    b"\xce\xfa\xed\xfe",      # Mach-O reverse byte order
    b"\xcf\xfa\xed\xfe",      # Mach-O reverse byte order
    b"\x1f\x8b",              # GZIP compressed archive
    b"PK\x03\x04",            # ZIP / JAR archive
    b"\xd0\xcf\x11\xe0",      # OLE Compound Document (legacy MS Office binary)
    b"\x25\x50\x44\x46",      # %PDF document
)

ALLOWED_TEXT_EXTENSIONS: set[str] = {".txt", ".md", ".json", ".csv"}


def validate_text_upload_content(raw: bytes, filename: str) -> str:
    """Validate that uploaded file is authentic text (not a disguised executable or binary).

    Returns decoded UTF-8 text if valid, raises HTTPException(400) otherwise.
    """
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_TEXT_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"{filename} has an unsupported file extension '{suffix}'. Only .txt, .md, .csv, and .json files are supported.",
        )

    for prefix in DISALLOWED_BINARY_PREFIXES:
        if raw.startswith(prefix):
            raise HTTPException(
                status_code=400,
                detail=f"{filename} appears to be a binary, executable, or compressed archive file, which is not permitted.",
            )

    # Null bytes are never valid in plain text, markdown, json, or csv prompt files
    if b"\x00" in raw:
        raise HTTPException(
            status_code=400,
            detail=f"{filename} contains binary null bytes and cannot be parsed as text.",
        )

    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"{filename} must be valid UTF-8 encoded text.",
        ) from exc


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
