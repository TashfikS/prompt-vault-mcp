---
title: PromptHold MCP
emoji: 🔐
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# PromptHold

PromptHold is a team prompt workspace and version control system built with FastAPI, SQLAlchemy, React, and FastMCP. It provides Role-Based Access Control (RBAC), immutable sequential prompt versions, drag-and-drop uploads, instant rollback, granular word and sentence comparisons, shareable comparison links, and an in-chat MCP drawer for connected AI assistants and agents.

## Documentation

* **[ARCHITECTURE.md](ARCHITECTURE.md)**: services, request routing across the two databases, backend layering, data model and free-tier operating rules.
* **[AGENTS.md](AGENTS.md)**: authoritative rules for contributors and AI agents (RBAC, contracts, demo accounts, engineering rules).
* **[DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)**: $0/month deployment on Cloudflare, Render, Supabase, Neon, Upstash and Firebase.
* **[MAKING_CHANGES_LIVE.md](MAKING_CHANGES_LIVE.md)**: local testing, CI/CD and release workflow.

## How it fits together

```text
Browser / AI client ─► Cloudflare Pages (SPA) + Worker (proxy) ─► Render: FastAPI + FastMCP
                                                                   ├─ Supabase Postgres  (community users)
                                                                   ├─ Neon Postgres      (paid users)
                                                                   └─ Upstash Redis      (version cache)
```

The backend is one FastAPI app. `main.py` assembles it, REST routes live in `backend/routers/`, MCP tools in `backend/mcp_server.py`, and both call the same business rules in `backend/services/`.

## Start the backend

From the repository root:

```bash
make setup          # .venv, backend requirements, frontend npm ci
make dev-backend    # uvicorn on :8000 (runs from backend/)
```

or manually:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
cd backend && uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

With no database URLs set, the backend uses local SQLite: `prompthold.db` for paid tiers and `prompthold_community.db` for the community tier. On startup it creates tables, applies Alembic migrations and seeds the demo data (when seeding is enabled, see `security.should_seed_demo_data`).

> **Careful with `.env`:** if it contains `DATABASE_URL` / `NEON_DATABASE_URL` / `SUPABASE_DATABASE_URL`, the local backend (and anything that imports `database.py`) talks to those real databases.

## Accounts and sign-in

The web app requires signing in. Anyone can create an account from the sign-up page; new accounts receive an isolated, private Personal space right away, and can create or join team groups. The seeded demo accounts (`alice@example.com`, `bob@example.com`, `charlie@example.com`, `diana@example.com`) use the password `demo1234`.

Passwords are stored as salted PBKDF2-SHA256 hashes. Signing in returns a session token (valid 14 days) that the browser sends as `Authorization: Bearer <token>` or an HttpOnly cookie. MCP clients either sign in through the built-in OAuth 2.1 flow or send a personal API key as the bearer token. Tokens and keys are stored only as SHA-256 hashes. New ones carry a tier prefix (`phc_`/`php_` for sessions, `pv_live_c_`/`pv_live_p_` for keys), so each request queries only the right database.

## Start the frontend

In another terminal, from the repository root:

```bash
cd frontend
npm install
npm run dev -- --host 0.0.0.0 --port 5173
```

The Vite development server proxies `/api` and `/mcp` to `http://127.0.0.1:8000`. For a production build run `npm run build`; FastAPI serves `frontend/dist` from `/` when that directory exists.

## Tests

```bash
make test        # py_compile, pytest, UI guardrails, frontend tests, tsc
make lint        # py_compile + UI guardrails + typecheck
.venv/bin/pytest backend/tests/test_prompt_service.py -v
```

The pgvector search test only runs when `PGVECTOR_TEST_DATABASE_URL` points at a throwaway Postgres (CI sets it). It never uses `DATABASE_URL`.

## Demo API keys

The seeded API keys are `key_admin_alice`, `key_manager_bob`, `key_member_charlie`, and `key_manager_diana`. MCP tools enforce the same group membership boundaries and business rules as the web API. The MCP endpoint is `/mcp` and the UI resource is `ui://prompt-hold/drawer`.

Set `PROMPT_HOLD_APP_URL` to the externally reachable app origin for MCP drawer use outside local development.
