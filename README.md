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

## Start the backend

From the repository root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
cd backend
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

On first startup, the backend creates `backend/prompthold.db` and seeds Alice, Bob, Charlie, Diana, team groups, and versioned sample prompts.

## Accounts and sign-in

The web app requires signing in. Anyone can create an account from the sign-up page; new accounts receive an isolated, private Personal space right away, and can create or join team groups. The seeded demo accounts (`alice@example.com`, `bob@example.com`, `charlie@example.com`, `diana@example.com`) use the password `demo1234`.

Passwords are stored as salted PBKDF2-SHA256 hashes. Signing in returns a session token (valid 14 days) that the browser sends as `Authorization: Bearer <token>` or HttpOnly cookie. MCP clients can instead send their personal API key as the bearer token.

## Start the frontend

In another terminal, from the repository root:

```bash
cd frontend
npm install
npm run dev -- --host 0.0.0.0 --port 5173
```

The Vite development server proxies `/api` and `/mcp` to `http://127.0.0.1:8000`. For a production build run `npm run build`; FastAPI serves `frontend/dist` from `/` when that directory exists.

## Demo API keys

The seeded API keys are `key_admin_alice`, `key_manager_bob`, `key_member_charlie`, and `key_manager_diana`. MCP tools accept the API key as an argument and enforce the same group membership boundaries as the web API. The MCP endpoint is `/mcp` and the UI resource is `ui://prompt-hold/drawer`.

Set `DATABASE_URL` to use a database other than the default SQLite database. Set `PROMPT_HOLD_APP_URL` to the externally reachable app origin for MCP drawer use outside local development.
