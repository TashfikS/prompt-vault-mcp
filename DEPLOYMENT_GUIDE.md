# PromptHold Full-Stack Cloud Deployment Guide

This guide provides end-to-end instructions for deploying the **PromptHold RBAC & Version Control** platform using a **100% Free / Zero-Dollar Tier ($0/month)** across:

* **Supabase** (PostgreSQL for free/community-plan users)
* **Neon Database** (Serverless PostgreSQL for paid-plan users, scales to zero)
* **Upstash** (Serverless Redis multi-pod cache)
* **Firebase / Google Cloud** (Google OAuth & SSO authentication)
* **Render** (Docker Web Service & FastMCP container)
* **Cloudflare Worker** (thin gateway proxy + 14-minute keep-alive cron)
* **Cloudflare Pages** (Vite React Single Page Application CDN)

---

## Architecture Overview

```
User Browser / AI Chat Client
              │
              ▼
Cloudflare Pages (React SPA: prompthold.pages.dev, dev.prompthold.pages.dev)
              │  /api, /oauth, /mcp, /sse, /.well-known, /share
              ▼
Cloudflare Worker (prompt-vault-gateway.tashfiks.workers.dev)
  • forwards to Render, 90s timeout → 503 "starting up"
  • cron */14 → GET /api/health (keeps Render warm, touches Supabase only)
              │
              ▼
Render Web Service (Docker: FastAPI + FastMCP)
  ├── Supabase Postgres  ← community users
  ├── Neon Postgres      ← pro / team / enterprise users (never touched by health checks)
  └── Upstash Redis      ← prompt version cache

Firebase (Google SSO) · Gemini (embeddings) · Polar (billing webhooks) · GitHub Issues (feedback)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for routing and tier-migration details.

---

## Step 1: Set Up Neon Serverless PostgreSQL

Neon provides a serverless PostgreSQL database with branching and connection pooling.

1. Sign up at [neon.tech](https://neon.tech).
2. Create a new project (e.g. `prompthold`).
3. Under **Dashboard** $\rightarrow$ **Connection Details**, ensure **Pooled connection** is checked.
4. Copy the connection string. It looks like:
   ```text
   postgresql://<username>:<password>@ep-<project-id>-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
5. You don't need to run anything by hand: on startup the backend creates the tables, applies the legacy `upgrade_schema()` baseline, then runs Alembic migrations on **both** databases. To do it ahead of a deploy, run `cd backend && python migrate.py` with `NEON_DATABASE_URL` and `SUPABASE_DATABASE_URL` set.
6. The `pgvector` and `pg_trgm` extensions are enabled automatically when available (both are free on Neon and Supabase). Without them, search falls back to Python scoring.

---

## Step 1b: Set Up Supabase PostgreSQL (community tier)

1. Create a free project at [supabase.com](https://supabase.com).
2. Under **Project Settings → Database → Connection string**, copy the **Transaction pooler** URL (host `aws-0-<region>.pooler.supabase.com`, port `6543`).
3. Use it as `SUPABASE_DATABASE_URL` on Render. If it is unset, community users share the Neon database (single-database mode). Locally, they fall back to `prompthold_community.db`.
4. Free Supabase projects pause after about a week without activity. The Worker cron (every 14 min) and `.github/workflows/keep-alive.yml` (every 3 days, override the URL with the `KEEPALIVE_URL` repository variable) both prevent this.

---

## Step 2: Set Up Upstash Serverless Redis

Upstash provides free serverless Redis with both standard TCP and HTTP REST access.

1. Sign up at [upstash.com](https://upstash.com).
2. Click **Create Database**:
   * Name: `prompthold-redis`
   * Region: Choose the region closest to your Neon database (e.g., US-East / Ohio / Virginia).
   * Eviction: Enabled (volatile-lru or allkeys-lru).
3. Under **Connect to your database**, copy the **Redis URL**:
   ```text
   rediss://default:<password>@<endpoint>.upstash.io:6379
   ```
4. Also copy the **REST API credentials** (used for edge caching in Cloudflare Workers):
   * `UPSTASH_REDIS_REST_URL`: `https://<endpoint>.upstash.io`
   * `UPSTASH_REDIS_REST_TOKEN`: `<your-upstash-rest-token>`

---

## Step 3: Set Up Firebase / Google OAuth (SSO)

Firebase Auth provides free user authentication and Google Sign-In.

1. Go to the [Firebase Console](https://console.firebase.google.com) and create a project (e.g. `prompthold-auth`).
2. Navigate to **Build** $\rightarrow$ **Authentication** $\rightarrow$ **Get Started**.
3. Under the **Sign-in method** tab:
   * Enable **Google** provider.
   * Enter your project support email and save.
4. Under **Project Settings** (gear icon) $\rightarrow$ **General**:
   * Scroll down to **Your apps** and click the **Web (`</>`)** icon to register a web app.
   * Copy the **Web API Key** (this is `FIREBASE_WEB_API_KEY`).
5. Under **Authentication** $\rightarrow$ **Settings** $\rightarrow$ **Authorized domains**, add:
   * `localhost`
   * `prompthold.pages.dev`
   * `prompt-vault-gateway.tashfiks.workers.dev`
   * Any custom domains you intend to use.

---

## Step 4: Deploy Backend Container to Render

Render hosts the Docker container running FastAPI, FastMCP server, and background tasks.

1. Sign up at [render.com](https://render.com).
2. Click **New +** $\rightarrow$ **Web Service**.
3. Connect your GitHub repository (`https://github.com/TashfikS/prompt-vault-mcp`).
4. Configure service details:
   * **Name:** `prompthold-backend`
   * **Region:** Ohio (or region matching Neon)
   * **Branch:** `dev`
   * **Runtime:** `Docker`
   * **Instance Type:** `Free`
   * **Health Check Path:** `/api/health` (shallow: pings Supabase only; use `/api/health?deep=1` manually to check Neon too)
5. Under **Environment Variables**, add:
   | Key | Value | Description |
   |---|---|---|
   | `PROMPT_HOLD_ENV` | `production` | Enables production security checks |
   | `SEED_DEMO_DATA` | `true` | Auto-creates demo accounts if DB is empty |
   | `NEON_DATABASE_URL` (or `DATABASE_URL`) | `<neon-pooled-url>` | Paid-tier database (pooled `-pooler` host) |
   | `SUPABASE_DATABASE_URL` | `<supabase-pooler-url>` | Community-tier database (port 6543) |
   | `GATEWAY_SECRET` | `<random string>` | Shared with the Worker so the real client IP is trusted |
   | `TRUST_PROXY_HEADERS` | `true` | Honour `X-Forwarded-*` from the gateway |
   | `GEMINI_API_KEY` | `<key>` | Optional: semantic search embeddings |
   | `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_PRO_PRODUCT_ID`, `POLAR_TEAM_PRODUCT_ID`, `POLAR_ENVIRONMENT` | | Optional: billing |
   | `GITHUB_ISSUE_REPO`, `GITHUB_ISSUE_TOKEN` | | Optional: feedback → GitHub Issues |
   | `REDIS_URL` | `<upstash-redis-url>` | Upstash TCP Redis URL (`rediss://...:6379`) |
   | `FIREBASE_WEB_API_KEY` | `<firebase-api-key>` | Firebase Web API Key for SSO verification |
   | `ALLOWED_ORIGINS` | `https://prompthold.pages.dev,https://prompt-vault-gateway.tashfiks.workers.dev` | Allowed CORS origins |
6. Click **Deploy Web Service**.
7. Once deployed, note your service URL (e.g., `https://prompthold-backend.onrender.com`).
8. Under **Settings**, copy the **Deploy Hook URL** (useful for automated CI/CD redeployments).

---

## Step 5: Deploy Cloudflare Worker (Gateway)

The Worker is a thin proxy. It forwards backend routes to Render with `X-Forwarded-Host`/`-Proto`, passes the client IP behind `GATEWAY_SECRET`, waits up to 90s for a cold start, and runs a cron every 14 minutes that calls `/api/health` to keep Render warm. It holds **no database credentials**. If an older deployment has a `DATABASE_URL` secret, remove it with `npx wrangler secret delete DATABASE_URL`.

1. `cd cloudflare-worker && npx wrangler login`
2. Check `wrangler.toml`: `RENDER_ORIGIN = "https://prompthold-backend.onrender.com"` and `crons = ["*/14 * * * *"]`.
3. Set the shared secret (same value as on Render): `npx wrangler secret put GATEWAY_SECRET`
4. Deploy: `npx wrangler deploy`. CI does this only for `release` and `v*` tags.

---

## Step 6: Deploy Cloudflare Pages (Frontend UI)

Cloudflare Pages delivers the React SPA globally across Cloudflare's CDN.

1. Navigate to `frontend/`:
   ```bash
   cd frontend
   npm install
   ```
2. Build the production bundle:
   ```bash
   npm run build
   ```
3. Deploy to Cloudflare Pages:
   ```bash
   npx wrangler pages deploy dist --project-name prompthold --branch main
   ```
4. Verify the deployment:
   * Open `https://prompthold.pages.dev` in your browser.
   * Sign in using any demo account (e.g., `alice@example.com` / `demo1234`).

---

## Verification & Health Check Checklist

Test each layer from your terminal:

```bash
# 1. Test Cloudflare Worker gateway health (expect tiers.paid.status = "not_checked")
curl -i https://prompt-vault-gateway.tashfiks.workers.dev/api/health

# 2. Test Render Backend Health directly
curl -i https://prompthold-backend.onrender.com/api/health

# 3. Test MCP Server SSE Endpoint
curl -i https://prompt-vault-gateway.tashfiks.workers.dev/mcp/

# 4. Test Demo Account Authentication
curl -i -X POST https://prompt-vault-gateway.tashfiks.workers.dev/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"demo1234"}'

# 5. Test Frontend Asset Delivery
curl -I https://prompthold.pages.dev/
```

All 5 requests should return HTTP 200 OK.
