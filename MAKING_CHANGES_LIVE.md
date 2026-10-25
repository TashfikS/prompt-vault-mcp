# PromptHold: How to Make Changes Live (Release & Update Guide)

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

## 3. Automated Push-to-Deploy (Recommended)

Whenever you push to the `main` branch on GitHub:

```bash
git add .
git commit -m "feat: description of your changes"
git push origin main
```

### What Happens Automatically:
1. **GitHub Actions CI (`.github/workflows/ci.yml`):**
   * Lints backend code with `ruff` and audits security with `bandit`.
   * Spins up containerized **PostgreSQL 16** and **Redis 7** service containers.
   * Runs all backend unit and integration tests with `pytest`.
   * Verifies database migration and seed idempotency.
   * Compiles the React frontend with Vite and runs frontend test suites.
2. **GitHub Actions CD (`.github/workflows/cd.yml`):**
   * Builds the multi-platform Docker container and pushes to **GitHub Container Registry (GHCR)**.
   * Triggers the **Render Deploy Hook** to redeploy the live container.
   * If `CLOUDFLARE_API_TOKEN` is configured in GitHub Secrets, automatically deploys the latest frontend build to **Cloudflare Pages** and the gateway to **Cloudflare Worker**.

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
npx wrangler pages deploy dist --project-name prompthold --branch main
```
*Your changes will be live worldwide across Cloudflare's edge in approximately **15 seconds**.*

---

### B. Updating the Edge Gateway (Cloudflare Worker)
Use this whenever you edit `cloudflare-worker/worker.js` or `cloudflare-worker/wrangler.toml` (routing, auth endpoints, failover logic):

```bash
cd cloudflare-worker

# Deploy directly to Cloudflare Worker edge
npx wrangler deploy
```
*Your changes will be live across 300+ global data centers in **under 5 seconds**.*

---

### C. Updating the Backend Container (Render)
Use this whenever you edit files in `backend/` (`models.py`, `main.py`, `auth.py`, `cache.py`, `mcp_server.py`) or `Dockerfile`:

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
*Shows live request headers, upstream routing, failover events, and execution times.*

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

* **Cloudflare Pages:** Go to Cloudflare Dashboard $\rightarrow$ **Workers & Pages** $\rightarrow$ **prompthold** $\rightarrow$ **Deployments**. Click the three dots next to any previous deployment and select **Rollback to this deployment** (instant, 0 downtime).
* **Cloudflare Worker:** Run `cd cloudflare-worker && npx wrangler rollback` to revert to the previous version instantly.
* **Render:** Go to Render Dashboard $\rightarrow$ **prompthold-backend** $\rightarrow$ **Events** $\rightarrow$ Click **Rollback** on the last known good deploy.
* **Neon Database:** Go to Neon Console $\rightarrow$ **Branches** $\rightarrow$ Create a branch from a point-in-time timestamp before the error occurred.
