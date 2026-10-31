# PromptFolders: How to Make Changes Live (Release & Update Guide)

This guide explains how to make code changes, test them, and deploy them live to production across the **Frontend**, **Cloudflare Worker**, **Render Backend**, and **Neon Database**.

---

## 1. Quick Reference: Where Changes Live

| Component | Code Directory | Hosted On | Deployment Trigger | Live In |
|---|---|---|---|---|
| **Frontend UI** | `frontend/src/` | **Cloudflare Pages** (`prompthold.pages.dev`) | `wrangler pages deploy` or CI | ~15 sec |
| **Edge Gateway & Failover** | `cloudflare-worker/` | **Cloudflare Worker** (`prompt-vault-gateway...`) | `wrangler deploy` or CI | ~5 sec |
| **Backend & MCP Server** | `backend/`, `Dockerfile` | **Render Web Service** (`prompthold-backend...`) | `git push origin main` | 2–3 min |
| **Database Models** | `backend/models.py` | **Neon PostgreSQL** | Migration script / `seed.py` | Immediate |

---

## 2. Local Testing Before Making Changes Live

Always run the pre-flight verification script before deploying:

```bash
# 1. Run the full automated verification suite (Linter, Unit Tests, Type Check, Frontend Build)
./run_tests.sh

# 2. Specifically verify TypeScript types if you touched the frontend:
cd frontend
npx tsc -b --noEmit
cd ..

# 3. Check git status to ensure clean working tree:
git status
```

---

## 3. Automated Push-to-Deploy (Push Once, Deploy All)

Whenever you push to the `main` branch on GitHub:

```bash
git add .
git commit -m "feat: description of your changes"
git push origin main
```

### What Happens Automatically (Strict Test-Gated Pipeline):
The unified GitHub Actions pipeline (`.github/workflows/pipeline.yml`) executes in two strict stages:

#### **Stage 1: Comprehensive Verification (Test Gate)**
1. **Backend Lint & Static Security Audit:** Lints Python syntax, compiles bytecode, runs `ruff` and `bandit` security scans.
2. **Backend Multi-Database Tests:** Spins up clean containerized **PostgreSQL 16** and **Redis 7** service containers, runs all 29 pytest unit & integration tests across both SQLite and PostgreSQL, and verifies database migration & demo account seed idempotency.
3. **Frontend Guardrails & Build:** Enforces AGENTS.md UI standards (0 native OS widgets or dialogs), runs TypeScript type check (`tsc -b --noEmit`), runs diff engine unit tests, and builds the production bundle with Vite.
4. **Full-Stack Docker Smoke Test:** Performs a multi-stage Docker build, launches the live container, and tests the `/api/health` probe and single-page-application serving.

#### **Stage 2: Automatic Deployment (Only Executes if 100% of Stage 1 Passes)**
* **GitHub Container Registry (GHCR):** Automatically builds and pushes production multi-platform images (`ghcr.io/tashfiks/prompt-vault-mcp:latest` and tagged with the commit SHA).
* **Render Web Service:** Automatically triggers the Render deploy hook to redeploy the live backend container.
* **Cloudflare Pages & Worker:** Automatically deploys the production frontend bundle to **Cloudflare Pages** (`prompthold.pages.dev`) and the edge gateway to **Cloudflare Worker**.
* **Hugging Face Spaces:** Pushes repository updates to Hugging Face Spaces (if configured).

> [!IMPORTANT]
> If **any test fails** in Stage 1, the pipeline halts immediately and **no deployment takes place**, ensuring broken code can never reach production.

---

## 4. Instant Manual Deployments (Zero-Wait CLI)

If you need your changes live immediately without waiting for GitHub Actions queues, use these direct CLI commands:

### A. Updating the Frontend (Cloudflare Pages)
Use this whenever you edit files in `frontend/src/` (UI components, styling, buttons, pages):

```bash
cd frontend

# 1. Build the production bundle
npm run build

# 2. Deploy directly to Cloudflare Pages CDN
npx wrangler pages deploy dist --project-name promptfolders --branch main
```
*Your changes will be live worldwide across Cloudflare's edge in approximately **15 seconds**.*

---

### B. Updating the Edge Gateway (Cloudflare Worker)
Use this whenever you edit `cloudflare-worker/worker.js` or `cloudflare-worker/wrangler.toml` (proxied path prefixes, timeout, keep-alive cron):

```bash
cd cloudflare-worker

# Deploy directly to Cloudflare Worker edge
npx wrangler deploy
```
*Your changes will be live across 300+ global data centers in **under 5 seconds**.*

---

### C. Updating the Backend Container (Render)
Use this whenever you edit anything in `backend/` (routers, services, models, migrations, `mcp_server.py`…) or the `Dockerfile`.

> **Note:** the CI pipeline redeploys the single Render backend on pushes to `dev` **as well as** `release` and tags. `dev.prompthold.pages.dev` and production share that backend and its databases, so a `dev` push is a production backend deploy.

> **Schema changes:** add an Alembic revision (`backend/alembic/versions/`). It is applied automatically to both the Supabase and Neon databases when the new container starts.

**Option 1: Git Push (Automatic Webhook)**
```bash
git add backend/ Dockerfile
git commit -m "feat: backend update"
git push origin main
```
*Render automatically detects the commit on branch `main` and begins rebuilding the Docker image.*

**Option 2: Trigger Deploy via Render CLI**
```bash
render deploys create srv-dbeqls7avr4c73bq6c0g
```

**Option 3: Trigger Deploy via HTTP Webhook**
```bash
curl -fsSL -X POST "https://api.render.com/deploy/srv-dbeqls7avr4c73bq6c0g?key=<your-render-deploy-key>"
```

---

### D. Updating Database Schema (Neon PostgreSQL)
Use this whenever you add new columns or tables in `backend/models.py`:

```bash
# Set your Neon connection string and run the migration/upgrade script
DATABASE_URL="postgresql://<user>:<password>@ep-...neon.tech/neondb?sslmode=require" \
  python3 -m backend.seed
```
*Tables and columns will be created/upgraded instantly on Neon.*

---

## 5. Live Monitoring & Debugging

Use these commands to monitor your live applications in real time:

### 1. Stream Live Cloudflare Worker Logs
```bash
cd cloudflare-worker
npx wrangler tail
```
*Shows live request headers, upstream routing, 503 cold-start responses, and execution times.*

### 2. Stream Live Render Backend Logs
```bash
# Using Render CLI:
render logs -s srv-dbeqls7avr4c73bq6c0g --follow
```

### 3. Check Live Health Endpoints
```bash
# Gateway Health
curl -s https://prompt-vault-gateway.tashfiks.workers.dev/api/health | jq .

# Render Health
curl -s https://prompthold-backend.onrender.com/api/health | jq .
```

---

## 6. Instant Rollback Procedures

If a bad change reaches production:

* **Cloudflare Pages:** Go to Cloudflare Dashboard $\rightarrow$ **Workers & Pages** $\rightarrow$ **promptfolders** $\rightarrow$ **Deployments**. Click the three dots next to any previous deployment and select **Rollback to this deployment** (instant, 0 downtime).
* **Cloudflare Worker:** Run `cd cloudflare-worker && npx wrangler rollback` to revert to the previous version instantly.
* **Render:** Go to Render Dashboard $\rightarrow$ **prompthold-backend** $\rightarrow$ **Events** $\rightarrow$ Click **Rollback** on the last known good deploy.
* **Neon Database:** Go to Neon Console $\rightarrow$ **Branches** $\rightarrow$ Create a branch from a point-in-time timestamp before the error occurred.
