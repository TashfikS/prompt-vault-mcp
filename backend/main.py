import logging
import os
import re
from contextlib import asynccontextmanager

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from migrations import run_migrations
from database import (
    Base,
    SessionNeon,
    SessionSupabase,
    engine_neon,
    engine_supabase,
    is_supabase_configured,
)
from auth import (ensure_demo_passwords, lock_demo_accounts, upgrade_schema)
from permissions import (ensure_all_personal_groups)
from security import (AUTO_MIGRATE_DB, IS_PRODUCTION, SecurityHeadersMiddleware, get_allowed_origins,
                      should_seed_demo_data)
from fastmcp.server.http import create_sse_app
from seed import seed_initial_data
from mcp_server import has_session_key, mcp, register_session_key

from deps import FRONTEND_DIST, SESSION_COOKIE_NAME, _get_public_base_url  # noqa: F401  (re-exported)
from domain import PLAN_LIMITS_MAP, PLAN_TIERS  # noqa: F401  (re-exported for callers of main)
from routers import account, auth_routes, groups, oauth_routes, prompts, proposals, sharing
# Stateless: each request authenticates on its own, so Render free-tier restarts/sleeps (and multiple pods)
# never strand clients on an in-memory MCP session that no longer exists (404 -> client gives up).
mcp_asgi = mcp.http_app(path="/", stateless_http=True)
mcp_sse_asgi = create_sse_app(server=mcp, message_path="/messages", sse_path="/sse")


@asynccontextmanager
async def lifespan(application: FastAPI):
    if AUTO_MIGRATE_DB:
        # 1. Initialize Neon tables & schema upgrades (Paid Tiers)
        try:
            Base.metadata.create_all(bind=engine_neon)
            upgrade_schema(engine_neon)
            run_migrations(engine_neon)
        except Exception as exc:
            import logging
            logging.getLogger("uvicorn.error").warning("Neon automatic DDL migration skipped: %s", exc)

        # 2. Initialize Supabase tables & schema upgrades (Free/Community Tier)
        try:
            Base.metadata.create_all(bind=engine_supabase)
            upgrade_schema(engine_supabase)
            run_migrations(engine_supabase)
        except Exception as exc:
            import logging
            logging.getLogger("uvicorn.error").warning("Supabase automatic DDL migration skipped: %s", exc)

    # 3. Seed Neon database with demo team accounts if enabled
    try:
        with SessionNeon() as db_neon:
            if should_seed_demo_data():
                seed_initial_data(db_neon)
                ensure_demo_passwords(db_neon)
            else:
                lock_demo_accounts(db_neon)
            ensure_all_personal_groups(db_neon)
    except Exception as exc:
        import logging
        logging.getLogger("uvicorn.error").warning("Neon seed initialization warning: %s", exc)

    # 4. Ensure personal spaces and demo data in Supabase as well
    try:
        with SessionSupabase() as db_supa:
            if should_seed_demo_data():
                seed_initial_data(db_supa)
                ensure_demo_passwords(db_supa)
            else:
                lock_demo_accounts(db_supa)
            ensure_all_personal_groups(db_supa)
    except Exception as exc:
        import logging
        logging.getLogger("uvicorn.error").warning("Supabase seed initialization warning: %s", exc)

    async with mcp_asgi.lifespan(application):
        async with mcp_sse_asgi.lifespan(application):
            yield


app = FastAPI(
    title="PromptHold RBAC & Version Control",
    version="2.0.0",
    lifespan=lifespan,
    docs_url=None if IS_PRODUCTION else "/docs",
    redoc_url=None if IS_PRODUCTION else "/redoc",
    openapi_url="/openapi.json",
)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_allowed_origins(),
    # Exact project hosts only (incl. Pages branch previews like dev.prompthold.pages.dev); never "prompthold-*",
    # since anyone can register such a Pages/Workers project name.
    allow_origin_regex=os.getenv("ALLOWED_ORIGIN_REGEX")
    or r"https://(([a-z0-9-]+\.)?prompthold\.pages\.dev|prompt-vault-gateway\.tashfiks\.workers\.dev)",
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept", "X-Requested-With", "If-None-Match"],
    expose_headers=["ETag", "Mcp-Session-Id"],
)


@app.middleware("http")
async def mcp_session_key_capture_middleware(request: Request, call_next):
    session_id = request.headers.get("mcp-session-id")
    api_key = (
        (request.headers.get("Authorization") or "").replace("Bearer ", "").replace("bearer ", "").strip()
        or request.headers.get("X-API-Key", "").strip()
        or request.query_params.get("api_key", "").strip()
        or request.query_params.get("token", "").strip()
    )
    if not api_key:
        match = re.search(r"/(?:s|k|key)/([^/?#]+)", request.url.path)
        if match:
            api_key = match.group(1).strip()

    # RFC 9728 challenge: anonymous MCP POSTs (initialize / tool calls) get 401 + resource metadata so clients
    # (Claude, ChatGPT) discover the OAuth sign-in. Only POST is challenged: Gemini health-probes with an
    # anonymous HEAD and stops calling the server if that probe returns 401.
    is_mcp_path = request.url.path.startswith(("/mcp", "/sse"))
    if is_mcp_path and request.method == "POST" and not api_key and not has_session_key(session_id):
        metadata_url = f"{_get_public_base_url(request)}/.well-known/oauth-protected-resource"
        return JSONResponse(
            {"error": "invalid_token", "error_description": "Sign in to PromptHold to use this connector."},
            status_code=401,
            headers={"WWW-Authenticate": f'Bearer resource_metadata="{metadata_url}"'},
        )

    response = await call_next(request)

    resp_sess = response.headers.get("mcp-session-id") or session_id
    if resp_sess and api_key:
        register_session_key(resp_sess, api_key)
    return response


@app.get("/api/openapi.json", include_in_schema=False)
def get_api_openapi_json() -> dict:
    """Provide /api/openapi.json as an alias for Custom GPT and tool-calling agents."""
    return app.openapi()



@app.get("/api/health")
def health_check(deep: bool = False) -> dict:
    """Health check.

    By default only the community (Supabase) database is pinged. Render's health
    checker and the keep-alive workflow hit this endpoint often; pinging Neon
    here would stop it from ever scaling to zero and burn free compute hours
    (it would also keep Supabase from pausing, which is what we want).
    Pass ``?deep=1`` to also check the paid (Neon) tier.
    """
    from sqlalchemy import text

    def _ping(factory) -> str:
        try:
            with factory() as s:
                s.execute(text("SELECT 1"))
            return "connected"
        except Exception as exc:
            logging.getLogger("prompthold.health").warning("Health ping failed: %s", exc)
            return "unreachable"

    supa_status = _ping(SessionSupabase)
    if supa_status == "connected" and not is_supabase_configured():
        supa_status = "local_fallback (prompthold_community.db)"
    neon_status = _ping(SessionNeon) if deep else "not_checked"
    db_ok = supa_status != "unreachable" and neon_status != "unreachable"

    return {
        "status": "ok" if db_ok else "degraded",
        "service": "prompt-vault-mcp",
        "version": "2.0.0",
        "database": "connected" if db_ok else "unreachable",
        "tiers": {
            "paid": {
                "provider": "Neon PostgreSQL",
                "plans": ["pro", "team", "enterprise"],
                "status": neon_status,
            },
            "community": {
                "provider": "Supabase PostgreSQL" if is_supabase_configured() else "SQLite Fallback",
                "configured": is_supabase_configured(),
                "plans": ["community"],
                "status": supa_status,
            },
        },
    }



@app.get("/share/diff/{share_id}")
def share_fallback(share_id: str):
    """Help direct API-server share links open the SPA when a dist build exists."""
    if not (FRONTEND_DIST / "index.html").exists():
        raise HTTPException(status_code=404, detail="Build the frontend to open shared links directly.")
    from fastapi.responses import FileResponse
    return FileResponse(FRONTEND_DIST / "index.html")


@app.get("/terms")
@app.get("/privacy")
def legal_fallback():
    """Serve the SPA for the Terms of Service and Privacy Policy pages linked from sign-up."""
    if not (FRONTEND_DIST / "index.html").exists():
        raise HTTPException(status_code=404, detail="Build the frontend to view this page.")
    from fastapi.responses import FileResponse
    return FileResponse(FRONTEND_DIST / "index.html")


app.include_router(auth_routes.router)
app.include_router(oauth_routes.router)
app.include_router(account.router)
app.include_router(groups.router)
app.include_router(prompts.router)
app.include_router(proposals.router)
app.include_router(sharing.router)

app.mount("/sse", mcp_sse_asgi, name="sse")
app.mount("/mcp", mcp_asgi, name="mcp")
if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
