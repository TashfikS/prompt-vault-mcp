# PromptHold Full-Stack Cloud Deployment Guide

This guide provides end-to-end instructions for deploying the **PromptHold RBAC & Version Control** platform using a **100% Free / Zero-Dollar Tier ($0/month)** across:

* **Neon Database** (Serverless PostgreSQL with connection pooling)
* **Upstash** (Serverless Redis multi-pod cache)
* **Firebase / Google Cloud** (Google OAuth & SSO authentication)
* **Render** (Docker Web Service & FastMCP container)
* **Cloudflare Worker** (Edge Gateway, Load Balancer & Instant Failover)
* **Cloudflare Pages** (Vite React Single Page Application CDN)

---

## Architecture Overview

```
User Browser / AI Chat Client
              │
              ▼
    Cloudflare Pages CDN (React Frontend SPA: https://prompthold.pages.dev)
              │
              ▼ API Requests
    Cloudflare Worker (Edge Gateway & Load Balancer: https://prompt-vault-gateway.tashfiks.workers.dev)
              │
      ┌───────┴───────────────────────────────────────────┐
      │ Primary Route (<2.8s)                             │ Instant Failover (>2.8s or asleep)
      ▼                                                   ▼
Render Web Service (Docker Container)           Cloudflare Worker Edge SQL
  ├── Upstash Serverless Redis (Cache)                     │
  └── Neon PostgreSQL (Primary DB)                        ▼
                                                 Neon PostgreSQL (Direct Edge Query)

[Optional User Auth Flow]
  Browser ──► Firebase / Google SSO ──► Cloudflare Worker / Render ──► User Account Provisioned
```

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
5. Run the initial database migration and seed locally against Neon:
   ```bash
   DATABASE_URL="postgresql://<username>:<password>@ep-<project-id>-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require" python3 -m backend.seed
   ```
   *This provisions the `users`, `groups`, `group_memberships`, `prompts`, `prompt_versions`, `prompt_proposals`, `proposal_approvals`, `api_keys`, `feedback_submissions`, and audit tables, plus demo accounts.*

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
   * **Branch:** `main`
   * **Runtime:** `Docker`
   * **Instance Type:** `Free`
   * **Health Check Path:** `/api/health`
5. Under **Environment Variables**, add:
   | Key | Value | Description |
   |---|---|---|
   | `PROMPT_HOLD_ENV` | `production` | Enables production security checks |
   | `SEED_DEMO_DATA` | `true` | Auto-creates demo accounts if DB is empty |
   | `DATABASE_URL` | `<neon-pooled-url>` | Neon PostgreSQL pooled URL |
   | `REDIS_URL` | `<upstash-redis-url>` | Upstash TCP Redis URL (`rediss://...:6379`) |
   | `FIREBASE_WEB_API_KEY` | `<firebase-api-key>` | Firebase Web API Key for SSO verification |
   | `ALLOWED_ORIGINS` | `https://prompthold.pages.dev,https://prompt-vault-gateway.tashfiks.workers.dev` | Allowed CORS origins |
6. Click **Deploy Web Service**.
7. Once deployed, note your service URL (e.g., `https://prompthold-backend.onrender.com`).
8. Under **Settings**, copy the **Deploy Hook URL** (useful for automated CI/CD redeployments).

---

## Step 5: Deploy Cloudflare Worker (Edge Gateway & Load Balancer)

The Cloudflare Worker routes traffic to Render, handles failover to Neon if Render is sleeping, and runs a cron job to keep Render awake.

1. Install Cloudflare Wrangler CLI (if not already installed):
   ```bash
   npm install -g wrangler
   wrangler login
   ```
2. Navigate to `cloudflare-worker/`:
   ```bash
   cd cloudflare-worker
   ```
3. Verify [`wrangler.toml`](file:///media/tinux/Media%20&%20Files/Code/Projects/prompt-vault-mcp/cloudflare-worker/wrangler.toml):
   ```toml
   name = "prompt-vault-gateway"
   main = "worker.js"
   compatibility_date = "2024-11-01"
   compatibility_flags = ["nodejs_compat"]
   workers_dev = true

   [vars]
   RENDER_ORIGIN = "https://prompthold-backend.onrender.com"
   BACKEND_POD_1 = "https://prompthold-backend.onrender.com"

   [triggers]
   crons = ["*/14 * * * *"]
   ```
4. Set the secret `DATABASE_URL` in Cloudflare Worker:
   ```bash
   npx wrangler secret put DATABASE_URL
   # When prompted, paste your Neon pooled connection string:
   # postgresql://<user>:<password>@ep-...neon.tech/neondb?sslmode=require
   ```
5. Deploy the Worker:
   ```bash
   npx wrangler deploy
   ```
6. Your Worker is now live at `https://prompt-vault-gateway.<subdomain>.workers.dev`.

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
# 1. Test Cloudflare Worker Edge Gateway Health
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
