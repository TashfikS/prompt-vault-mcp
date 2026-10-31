# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is the authoritative spec (data models, RBAC rules, REST/MCP contracts, demo accounts, engineering rules) — read it before changing behavior. `ARCHITECTURE.md`, `DEPLOYMENT_GUIDE.md`, and `MAKING_CHANGES_LIVE.md` cover infra and deploys. This file only adds what those don't make obvious.

## Commands

All run from the repo root (Makefile prefers `.venv/bin/python` / `.venv/bin/pytest` when present):

```bash
make setup          # .venv + backend/requirements.txt, frontend npm ci
make dev-backend    # uvicorn main:app --reload on :8000 (run from backend/)
make dev-frontend   # Vite on :5173, proxies /api and /mcp to :8000
make test           # ./run_tests.sh: py_compile, pytest, UI guardrails, frontend tests, tsc
make lint           # py_compile + ui-guardrails + typecheck
make typecheck      # cd frontend && npx tsc -b --noEmit (must be 0 errors)
make ci             # lint + test + build
```

Single tests:

```bash
.venv/bin/pytest backend/tests/test_api_permissions.py -v
.venv/bin/pytest backend/tests/test_api_permissions.py::test_name -v
cd frontend && node --test tests/<file>.test.js
cd frontend && npm run test:e2e        # browser e2e (tests/browser-e2e.mjs)
```

- The `.githooks/pre-commit` hook runs the full `./run_tests.sh`; enable with `git config core.hooksPath .githooks`.
- `make ui-guardrails` greps `frontend/src` for `<select`, `<datalist`, `window.alert/confirm/prompt(` and fails the build — use the custom Tailwind popovers/modals instead.
- pytest uses `asyncio_mode = strict` (`backend/pytest.ini`): async tests need `@pytest.mark.asyncio` and async fixtures need `@pytest_asyncio.fixture`.
- Backend modules import each other as top-level modules (`from models import ...`), so code must run with `backend/` on `sys.path` (uvicorn from `backend/`; `tests/conftest.py` inserts it).

## Architecture notes

- **Single deployable:** FastAPI (`backend/main.py` only assembles the app; routes are in `backend/routers/`, shared business rules in `backend/services/`, which both REST and `mcp_server.py` must use) serves REST under `/api`, mounts the FastMCP server (`backend/mcp_server.py`) at `/mcp`, and serves `frontend/dist` at `/` when built. The same React bundle runs as the full web app or, with `?mcp_mode=1`, as the in-chat MCP App drawer (`ui://prompt-hold/drawer`).
- **Multi-database routing (`backend/database.py`):** users on the `community` plan live in Supabase Postgres (falls back to local SQLite `prompthold_community.db` if unconfigured); paid plans live in Neon. `get_db` resolves the bearer token → plan (`resolve_token_plan`, cached in-process, tier hinted by `phc_`/`php_`/`pv_live_c_`/`pv_live_p_` prefixes) → engine. Never query Neon from health/startup/background paths (free-tier compute budget); `/api/health` is Supabase-only unless `?deep=1`. `.env` points at the live Neon/Supabase DBs, so tests must use in-memory SQLite or an explicit throwaway URL. `dev` pushes redeploy the single shared production backend. Cross-tier moves go through `migrate_user_tier`, triggered by Polar webhooks (`polar_billing.py`). Any new table holding user data must be included in that migration.
- **Schema changes:** add a revision in `backend/alembic/versions/` (CLI: `cd backend && ALEMBIC_DATABASE_URL=sqlite:///./scratch.db alembic revision --autogenerate -m ...`; env.py refuses to run without that var so it never hits `.env`'s DATABASE_URL). `migrations.run_migrations()` runs on startup for both tier engines and in `migrate.py`. `upgrade_schema()` in `auth.py` is the frozen pre-Alembic baseline — don't extend it.
- **Auth:** session tokens and API keys are stored hashed (`hash_session_token`, `hash_api_key` in `auth.py`); `resolve_api_key` / `user_for_session_token` are the entry points. `oauth.py` implements an OAuth 2.1 authorization server (PKCE, dynamic client registration, RFC discovery metadata) for MCP clients; `main.py` (`_get_public_base_url`) derives the public base URL from `X-Forwarded-Host` because production sits behind a Cloudflare Worker proxy (`cloudflare-worker/`).
- **RBAC:** every prompt/group query must go through `permissions.py` (`get_user_group_ids`, `can_user_view_group`, etc.). Team-group edits create `PromptProposal`s that merge at `required_approvals`; Personal-space edits write versions directly. Both the REST routes and MCP tools must enforce the same checks.
- **Caching (`cache.py`):** Redis only (no in-process prompt cache, for multi-pod safety). Call `invalidate_prompt_cache(prompt_id)` whenever the active version changes.
- **Search (`search.py`):** hybrid fuzzy + Gemini embeddings over `PromptChunk`s; only the active version is indexed, so re-chunk on version publish/rollback.
- **Security (`security.py`):** rate limiter, security headers/CSP middleware (OAuth redirect origins must be allowed in `form-action`), upload sanitization, audit logging. Demo seeding is gated by `should_seed_demo_data()`.
- **Frontend:** `frontend/src/types.ts` must mirror the Pydantic schemas in `backend/schemas.py`; `api.ts` holds the client and token storage.
