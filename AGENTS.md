# AGENTS.md — PromptHold Architecture & Engineering Guide

This document defines the system architecture, access control model, API contracts, and implementation rules for **PromptHold RBAC & Version Control**. Any AI coding assistant or human engineer working on this codebase should use this document as the authoritative specification.

---

## 1. System Vision & Core Capabilities

**PromptHold** is a full-stack AI prompt management platform combining **granular version control** with **Role-Based Access Control (RBAC)**, designed for non-technical users as well as automated AI agents. It features live **Model Context Protocol (MCP)** server connectivity and interactive in-chat MCP Apps for AI chat clients and autonomous agents.

### Key Capabilities
1. **Dual-Mode Frontend (React):** A single codebase that functions both as a full standalone web workspace and as an embedded in-chat MCP App drawer (`@modelcontextprotocol/ext-apps`).
2. **Role-Based Multi-Group Access Control (RBAC):** Fine-grained workspace and group-level permissions (Workspace Admins, Group Owners, Members, and Guests), plus private Personal spaces.
3. **Frictionless Onboarding:** Every new user can immediately create private prompts in their own Personal space without being assigned to a team group, create new groups, and invite teammates by email.
4. **Intuitive Versioning for Teams:** Immutable sequential versions (`v1`, `v2`, `v3`) with plain-English change notes, author tracking, file upload versioning, and instant active version switching (ranking active version on top without duplicating history).
5. **Word & Sentence Diff Engine:** Toggleable granular diffing (word-by-word or sentence-by-sentence) in side-by-side or combined inline views.
6. **Zero-Config Shareable Comparison Links:** Pre-configured comparison URLs that load the exact base/target versions, layout, and granularity without requiring manual filter setup.
7. **Custom UI System:** Pure Tailwind CSS custom popovers and centered dialog modals, ensuring consistent rendering across all operating systems without native OS widget glitches.

---

## 2. Core Architecture Pillars

### Pillar 1: Dual-Mode Frontend Architecture
Using the `@modelcontextprotocol/ext-apps` SDK (`@modelcontextprotocol/ext-apps/react`):
- **Mode A — Standalone Web Workspace (Full UI):** Default browser interface. Features drag-and-drop file imports (`.txt`, `.md`, `.csv`, `.json`), prompt editing with variable detection (`{{variable}}`), version timeline, visual diff viewer, shared diff links, and access group management.
- **Mode B — Embedded MCP App Drawer (In-Chat UI):** Activated via `?mcp_mode=1` inside AI chat clients or canvas windows. Interacts directly with the MCP host to list accessible prompts, fill variables, and insert compiled prompts or save new versions straight from the AI chat.

### Pillar 2: Role-Based Multi-Group Permissions & Personal Spaces (RBAC)
Permissions operate across two tiers:

#### Tier 1: Workspace Level
- **Workspace Admin (`is_workspace_admin = True`):** Full global visibility. Can create groups, assign Group Owners, manage any group's membership, and view team prompts.
- **Standard User (`is_workspace_admin = False`):** Restricted to groups they belong to and their private personal space.

#### Tier 2: Group Level (Many-to-Many Junction)
Users can belong to multiple groups with distinct roles per group:
- **GROUP_MANAGER (Group Owner):** Full group control. Can add and remove members, assign user roles (`GROUP_MANAGER` [Owner], `MEMBER`, `GUEST`), configure group required approvals (threshold for proposal merging), switch the active version, submit edit proposals, and review/approve proposals.
- **MEMBER:** Can view prompts, test and personalize them, submit edit proposals, and vote to approve proposals submitted by other team members or owners. Proposers cannot vote to approve their own proposals.
- **GUEST:** Read-only prompt access. Can view, test, and copy prompts, but cannot modify, propose edits, upload files, or approve proposals.

#### Proposal & Approval Workflow
- Group Owners configure `required_approvals` (default 1).
- In team groups, Member edits create a `PromptProposal` in `PENDING` status. Group Owners and Workspace Admins save a new version directly (they may still submit a proposal explicitly via `POST /api/prompts/{id}/proposals`).
- Group Owners and other Members cast distinct `ProposalApproval` votes. Self-approval is blocked.
- Once total approvals reach `required_approvals`, the proposal is merged as the next sequential `PromptVersion` (`vN+1`) and automatically becomes the active version.
- Every user has an automatically provisioned `Personal` group (`is_personal = True`, `personal_owner_id = user.id`).
- Prompts saved in a user's Personal space are strictly private to that user and save new versions directly since there are no peer reviewers in private spaces.

### Pillar 3: Immutable Version Snapshots & Git Engine
- **Sequential Versioning:** Every edit or approved proposal generates an incremental version (`v1`, `v2`, `v3...`). Existing versions are never overwritten or mutated.
- **Variable Extraction:** Automatic regex scanning (`\{\{\s*([a-zA-Z0-9_ -]+)\s*\}\}`) stores detected variable names in `variables_json`.
- **Active Version Ranking & Instant Switching:** Rolling back to an older version activates that version directly by updating `current_version_number` (setting it as the Active Version) without creating a redundant version clone or deleting history. In the version timeline, the active version is ranked on top and highlighted with an Active Version badge. Only the Group Owner can switch the active version.

### Pillar 4: Authentication & Session Security
- **Authentication:** Token-based session authentication (`auth_sessions` table) with PBKDF2 password hashing (`hashlib.pbkdf2_hmac` with SHA-256 and salt).
- **Dual Credential Support:**
  - Web UI: Authenticates via `Authorization: Bearer <session_token>` header.
  - MCP Clients: Authenticates via personal `api_key` (`Authorization: Bearer <api_key>` or MCP tool argument).

### Pillar 5: Multi-Tier Database Architecture (Supabase vs Neon)
- **Free / Community Tier (`plan = "community"`):** Stored in **Supabase PostgreSQL** (`SUPABASE_DATABASE_URL`). If Supabase credentials are not yet configured in `.env`, the system safely falls back to local SQLite (`prompthold_community.db`) with clear diagnostics so development and testing continue smoothly.
- **Paid Tiers (`plan in ("pro", "team", "enterprise")`):** Stored in **Neon Serverless PostgreSQL** (`NEON_DATABASE_URL` / `DATABASE_URL`).
- **Dynamic Request Routing:** `database.get_db` (REST) and `_get_mcp_session` (MCP) resolve the bearer token to a plan with `resolve_token_plan` and open a session on that tier's engine. New tokens carry a tier hint (`phc_`/`php_` sessions, `pv_live_c_`/`pv_live_p_` API keys), so only the hinted database is queried. Legacy tokens probe Supabase first, then Neon. Unknown tokens are negatively cached for 60s, and routing DB errors are logged, never swallowed.
- **Neon compute budget:** community traffic must never open a Neon session. `/api/health` pings only Supabase unless called with `?deep=1`. Don't add startup, health or background work that queries Neon.
- **Cross-Tier Data Migration:** `migrate_user_tier` upserts the user, their Personal space and solo team groups, and all dependent rows (prompts, versions, chunks, diff links, proposals, approvals, comments, API keys, sessions) into the destination. It then re-points the routing cache and deletes the source copy. It is safe to re-run and raises on failure so Polar retries the webhook. Shared team groups stay in the source tier. **Any new table holding user data must be added to it.**

---

## 3. Project Directory Structure

```text
prompt-vault-mcp/
├── AGENTS.md                   # This architecture & engineering guide
├── backend/
│   ├── requirements.txt        # Backend Python dependencies
│   ├── main.py                 # App assembly: lifespan, middleware, /api/health, MCP + SPA mounts
│   ├── routers/                # REST routes by domain: auth_routes, oauth_routes, account,
│   │                           #   groups, prompts, proposals, sharing
│   ├── services/               # Business rules shared by REST and MCP
│   │   ├── prompts.py          #   quota, create-or-propose, duplicate, move
│   │   └── proposals.py        #   approve / reject / merge
│   ├── deps.py                 # current_user, maybe_user, session cookies, permission guards
│   ├── domain.py               # Read-model helpers + HTTP wrappers around service quotas
│   ├── plans.py                # PLAN_TIERS / PLAN_LIMITS_MAP (no web imports)
│   ├── database.py             # Engines, tier routing, migrate_user_tier
│   ├── migrations.py           # Alembic runner (revisions in alembic/versions/)
│   ├── models.py               # ORM database models (SQLite/PostgreSQL)
│   ├── schemas.py              # Pydantic v2 validation models
│   ├── auth.py                 # Password hashing, sessions, API keys, legacy upgrade_schema()
│   ├── permissions.py          # RBAC authorization helpers & variable parser
│   ├── search.py               # Hybrid search (fuzzy + Gemini embeddings, pgvector in SQL)
│   ├── oauth.py                # OAuth 2.1 authorization server for MCP clients
│   ├── polar_billing.py        # Polar checkout/portal/webhooks → tier migration
│   ├── security.py             # Headers/CSP, rate limiting, uploads, audit log
│   ├── cache.py                # Redis cache, GitHub feedback issues
│   ├── seed.py / migrate.py    # Demo data / standalone migration runner
│   └── mcp_server.py           # FastMCP tools (thin adapters over services/)
└── frontend/
    ├── package.json            # Node dependencies
    ├── vite.config.ts          # Vite configuration
    ├── tailwind.config.js      # Tailwind CSS configuration
    ├── postcss.config.js       # PostCSS configuration
    ├── index.html              # HTML shell
    └── src/
        ├── main.tsx            # React application root
        ├── index.css           # Global Tailwind stylesheet
        ├── types.ts            # TypeScript interfaces matching backend models
        ├── api.ts              # API client & auth token storage
        ├── App.tsx             # Main view router & modal manager
        └── components/
            ├── Navbar.tsx                   # Top navigation & user profile
            ├── LoginPage.tsx                # Sign In & Registration form
            ├── PromptDashboard.tsx          # Prompt list, search & space filters
            ├── PromptEditorAndHistory.tsx   # Editor, live tester, timeline & restore modal
            ├── VisualDiffViewer.tsx         # Granular diff viewer (word/sentence)
            ├── SharedDiffPage.tsx           # Standalone read-only comparison view
            ├── AccessGroupManager.tsx       # Groups, member invites & leader assignments
            ├── ReviewRequestsDashboard.tsx  # Central review inbox & approval dashboard
            ├── GroupSelectDropdown.tsx      # Custom popover for group/personal space
            ├── VersionSelectDropdown.tsx    # Custom popover for diff version picker
            ├── PromptSelectDropdown.tsx     # Custom popover for target prompt selection
            ├── LeaderSelectDropdown.tsx     # Custom popover for group owner assignment
            ├── FileUploadModal.tsx          # Drag-and-drop batch file uploader
            ├── DuplicatePromptModal.tsx     # Custom modal to duplicate or move prompt across spaces
            └── McpInChatDrawer.tsx          # In-chat MCP App drawer component
```

---

## 4. Backend Specifications

### 4.1 Database Models (`backend/models.py`)

- **`User` (`users`):**
  - `id` (UUID4 string, PK)
  - `name` (String)
  - `email` (String, unique, indexed)
  - `password_hash` (String, nullable for legacy seeded users)
  - `is_workspace_admin` (Boolean, default False)
  - `api_key` (String, unique, indexed, for MCP access)
  - `created_at` (DateTime, UTC)

- **`AuthSession` (`auth_sessions`):**
  - `id` (UUID4 string, PK)
  - `token` (String, unique, indexed)
  - `user_id` (String, FK `users.id`)
  - `created_at` (DateTime, UTC)
  - `expires_at` (DateTime, UTC)

- **`Group` (`groups`):**
  - `id` (UUID4 string, PK)
  - `name` (String, non-nullable)
  - `description` (String, default `""`)
  - `created_by` (String, FK `users.id`)
  - `is_personal` (Boolean, default False)
  - `personal_owner_id` (String, FK `users.id`, nullable)
  - `required_approvals` (Integer, default 1)
  - `created_at` (DateTime, UTC)

- **`GroupMembership` (`group_memberships`):**
  - `id` (UUID4 string, PK)
  - `user_id` (String, FK `users.id`, indexed)
  - `group_id` (String, FK `groups.id`, indexed)
  - `role` (String: `"GROUP_MANAGER"` [Owner], `"MEMBER"`, or `"GUEST"`)
  - `added_at` (DateTime, UTC)
  - Unique constraint on `(user_id, group_id)`

- **`Prompt` (`prompts`):**
  - `id` (UUID4 string, PK)
  - `group_id` (String, FK `groups.id`, indexed)
  - `title` (String, non-nullable)
  - `description` (String, default `""`)
  - `current_version_number` (Integer, default 1)
  - `created_by` (String, FK `users.id`)
  - `updated_at` (DateTime, UTC)
  - `is_archived` (Boolean, default False)

- **`PromptVersion` (`prompt_versions`):**
  - `id` (UUID4 string, PK)
  - `prompt_id` (String, FK `prompts.id`, indexed)
  - `version_number` (Integer, non-nullable)
  - `content` (Text, non-nullable)
  - `variables_json` (Text, non-nullable JSON string)
  - `change_note` (String, default `"Initial version"`)
  - `source_filename` (String, nullable)
  - `author_id` (String, FK `users.id`)
  - `created_at` (DateTime, UTC)

- **`PromptProposal` (`prompt_proposals`):**
  - `id` (UUID4 string, PK)
  - `prompt_id` (String, FK `prompts.id`, indexed)
  - `group_id` (String, FK `groups.id`, indexed)
  - `proposer_id` (String, FK `users.id`, indexed)
  - `title` (String, non-nullable)
  - `description` (Text, default `""`)
  - `content` (Text, non-nullable)
  - `change_note` (String, default `"Proposed edit"`)
  - `status` (String: `"PENDING"`, `"APPROVED"`, or `"REJECTED"`)
  - `created_at` (DateTime, UTC)
  - `updated_at` (DateTime, UTC)

- **`ProposalApproval` (`proposal_approvals`):**
  - `id` (UUID4 string, PK)
  - `proposal_id` (String, FK `prompt_proposals.id`, indexed)
  - `user_id` (String, FK `users.id`, indexed)
  - `created_at` (DateTime, UTC)
  - Unique constraint on `(proposal_id, user_id)`

- **`SharedDiffLink` (`shared_diff_links`):**
  - `id` (UUID4 string, PK)
  - `prompt_id` (String, FK `prompts.id`)
  - `base_version` (Integer)
  - `target_version` (Integer)
  - `diff_granularity` (String: `"word"` or `"sentence"`)
  - `view_mode` (String: `"split"` or `"inline"`)
  - `created_by` (String, FK `users.id`)
  - `created_at` (DateTime, UTC)

- **`PromptChunk` (`prompt_chunks`):**
  - `id` (UUID4 string, PK)
  - `prompt_id` (String, FK `prompts.id`, cascade delete, indexed)
  - `version_id` (String, FK `prompt_versions.id`, cascade delete, indexed)
  - `chunk_index` (Integer, default 0)
  - `chunk_text` (Text, non-nullable chunk slice)
  - `embedding_json` (Text, non-nullable JSON string of float vector)
  - `created_at` (DateTime, UTC)
  - Enforces the Active-Version-Only indexing rule (historical vectors pruned upon publishing new active versions)

---

### 4.2 RBAC Permission Helpers (`backend/permissions.py`)

- `extract_variables(text: str) -> list[str]`: Extracts unique `{{variable_name}}` tokens preserving document order.
- `get_user_group_ids(db: Session, user: User) -> list[str]`:
  - If `user.is_workspace_admin`: returns all non-personal group IDs plus the admin's personal space ID.
  - Otherwise: returns all group IDs where the user has a membership, plus their personal space ID.
- `can_user_view_group(db: Session, user: User, group_id: str) -> bool`:
  - If personal group: strictly `group.personal_owner_id == user.id`.
  - If admin: `True` for non-personal groups.
  - Otherwise: checks if a `GroupMembership` record exists.
- `can_user_manage_group_members(db: Session, user: User, group_id: str) -> bool`:
  - Returns `True` if user is workspace admin (for team groups) or if user's role in that group is `GROUP_MANAGER`.
- `can_user_direct_write_prompt(db: Session, user: User, group_id: str) -> bool`:
  - Returns `True` if user is workspace admin, personal space owner, or group `GROUP_MANAGER`.
- `can_user_approve_proposals(db: Session, user: User, group_id: str) -> bool`:
  - Returns `True` for `GROUP_MANAGER` and `MEMBER` (Guests cannot approve).
- `ensure_personal_group(db: Session, user: User) -> Group`:
  - Auto-provisions a `"Personal"` group for the user if one does not already exist.

---

### 4.3 REST API Endpoints (`backend/routers/`)

Routes are grouped by file: `auth_routes.py` (register/login/logout/SSO), `oauth_routes.py` (OAuth 2.1 + discovery), `account.py` (me, users, plans, billing, webhooks, API keys), `groups.py`, `prompts.py` (prompts, uploads, versions, duplicate/move), `proposals.py`, `sharing.py` (diff shares, feedback, audit logs). `/api/health` stays in `main.py`.


| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `POST` | `/api/auth/register` | Register a new user and create their personal space | No |
| `POST` | `/api/auth/login` | Authenticate with email/password and obtain session token | No |
| `POST` | `/api/auth/logout` | Invalidate the current session token | Yes |
| `GET` | `/api/me` | Current user profile, groups, and membership roles | Yes |
| `GET` | `/api/users` | List registered teammates for member invitations | Yes |
| `GET` | `/api/groups` | List groups visible to the current user | Yes |
| `POST` | `/api/groups` | Create a new team group (creator becomes Owner) | Yes |
| `PATCH` | `/api/groups/{id}/settings` | Update group required approvals threshold | Yes (Owner) |
| `POST` | `/api/groups/{id}/members` | Invite or add a member/guest/owner to a group by email | Yes (Owner/Admin) |
| `DELETE` | `/api/groups/{id}/members/{user_id}` | Remove a member from a group | Yes (Owner/Admin) |
| `GET` | `/api/prompts` | List accessible prompts (supports `group_id` & search) | Yes |
| `POST` | `/api/prompts` | Create a new prompt in an authorized space | Yes |
| `PUT` | `/api/prompts/{id}` | Save version (Owner) or submit proposal (Member) | Yes |
| `POST` | `/api/prompts/upload-files` | Batch file upload (`.txt`, `.md`, `.csv`, `.json`) | Yes |
| `POST` | `/api/prompts/{id}/rollback/{version}` | Switch prompt active version pointer without duplication | Yes (Owner) |
| `POST` | `/api/prompts/{id}/duplicate` | Duplicate (copy) or move prompt to any group / Personal space | Yes (Owner/Member) |
| `GET` | `/api/prompts/{id}/versions` | List all historical versions for a prompt | Yes |
| `GET` | `/api/proposals` | List all prompt review requests across accessible groups | Yes |
| `GET` | `/api/prompts/{id}/proposals` | List review requests for a specific prompt | Yes |
| `POST` | `/api/prompts/{id}/proposals` | Submit a new edit review request | Yes (Member/Owner) |
| `POST` | `/api/proposals/{id}/approve` | Vote to approve a review request (auto-merges at threshold) | Yes (Owner/Member) |
| `POST` | `/api/proposals/{id}/reject` | Reject a review request | Yes (Owner/Member) |
| `POST` | `/api/diff-shares` | Create a shareable diff comparison link | Yes |
| `GET` | `/api/diff-shares/{share_id}` | Retrieve pre-configured diff data for zero-config view | Open |
| `GET` | `/api/billing/config` | Inspect Polar billing configuration status | Open |
| `POST` | `/api/billing/checkout` | Create Polar checkout session URL for paid plan upgrade | Yes |
| `POST` | `/api/billing/portal` | Create Polar customer portal session URL | Yes |
| `POST` | `/api/webhooks/polar` | Receive verified Polar webhooks & auto-migrate tiers | Open (HMAC) |

---

### 4.4 FastMCP Server (`backend/mcp_server.py`)

Tools authenticate and check roles, then call the same `services/` functions as the REST routes. Errors surface as `ValueError` with the same messages as REST.


Mounted at `/mcp` using SSE/Streamable HTTP:
- **UI Resource `ui://prompt-hold/drawer` (and `ui://prompt-vault/drawer` alias):** HTML shell embedding the React frontend with `?mcp_mode=1`.
- **Tool `list_my_accessible_prompts(api_key, search_query, group_name)`:** Strictly filters prompts by the caller's RBAC memberships.
- **Tool `get_and_fill_prompt(api_key, prompt_id, variables)`:** Compiles the latest prompt version by interpolating `{{variables}}`.
- **Tool `save_prompt_version_from_chat(api_key, prompt_id, new_content, change_note)`:** Saves an updated prompt version directly from AI chat clients.
- **Tool `duplicate_or_move_prompt(api_key, prompt_id, target_group_id, new_title, mode)`:** Duplicates or moves a prompt to another authorized group or Personal space.

---

## 5. Frontend Architecture & UI Standards

### 5.1 Routing & Operating Modes
`App.tsx` inspects query parameters on startup:
1. `?share_diff=<id>`: Mounts `<SharedDiffPage />` to display a pre-configured diff comparison with locked parameters.
2. `?mcp_mode=1`: Mounts `<McpInChatDrawer />` for embedded rendering within AI chat client panels.
3. Default: Renders the full standalone application with authentication check (`<LoginPage />` if unauthenticated, otherwise `<Navbar />`, `<PromptDashboard />`, `<AccessGroupManager />`).

### 5.2 Custom UI Components (No Native OS Elements)
To avoid OS-level GTK/browser widget styling conflicts (such as black `<select>` and `<datalist>` popups in Chromium on Linux):
- **Popovers:** All dropdowns are built as custom React components with absolute positioning, click-outside dismissal, smooth transitions, and Tailwind styling (`GroupSelectDropdown`, `VersionSelectDropdown`, `PromptSelectDropdown`, `LeaderSelectDropdown`).
- **Confirmation Modals:** Destructive or consequential actions (e.g., version rollbacks) render centered custom Tailwind modals with `backdrop-blur-sm`, action summaries, and preview cards instead of native `window.confirm()`.
- **Segmented Controls:** Binary or small-set choices (e.g., upload mode, diff view mode, diff granularity) use styled inline pill buttons instead of select dropdowns.

---

## 6. Engineering & Contribution Rules

When modifying or extending this repository, AI agents and engineers must adhere to the following rules:

1. **Zero Placeholders:** Never submit `// TODO`, `# implement later`, or stubbed empty methods. All code must be complete, testable, and functional.
2. **Schema & Migration Safety:** Add schema changes as Alembic revisions in `backend/alembic/versions/` (they run for both tier engines on startup). Do not extend `auth.upgrade_schema()`, which is the frozen pre-Alembic baseline. Keep changes backward compatible, and add new user-data tables to `migrate_user_tier`. Run the `alembic` CLI only with an explicit `ALEMBIC_DATABASE_URL`.
3. **RBAC Boundary Enforcement:** Every prompt and group query must be guarded by `can_user_view_group` or `get_user_group_ids`. Never expose prompts across group boundaries or leak Personal space contents.
4. **Preserve Demo Accounts:** Keep the standard demo accounts seeded on startup (all passwords: `demo1234`):

| Name | Email | Password | Workspace Role | Group Memberships & Roles | Category |
|---|---|---|---|---|---|
| Alice Morgan | `alice@example.com` | `demo1234` | **Workspace Admin** | Full workspace visibility & management | **Admin** (1/2) |
| Evan Wright | `evan@example.com` | `demo1234` | **Workspace Admin** | Full workspace visibility & management | **Admin** (2/2) |
| Bob Chen | `bob@example.com` | `demo1234` | Standard User | **Marketing**: Owner (`GROUP_MANAGER`), **Sales**: Member | **Owner** (1/2) |
| Diana Okafor | `diana@example.com` | `demo1234` | Standard User | **Sales**: Owner (`GROUP_MANAGER`) | **Owner** (2/2) |
| Charlie Rivera | `charlie@example.com` | `demo1234` | Standard User | **Marketing**: Member (`MEMBER`) | **Member** (1/4) |
| Fiona Gallagher | `fiona@example.com` | `demo1234` | Standard User | **Marketing**: Member (`MEMBER`), **Sales**: Member (`MEMBER`) | **Member** (2/4) |
| George Clark | `george@example.com` | `demo1234` | Standard User | **Marketing**: Member (`MEMBER`) | **Member** (3/4) |
| Hannah Abbott | `hannah@example.com` | `demo1234` | Standard User | **Sales**: Member (`MEMBER`) | **Member** (4/4) |
| Ian Malcolm | `ian@example.com` | `demo1234` | Standard User | **Marketing**: Guest (`GUEST`) | **Guest** (1/5) |
| Julia Roberts | `julia@example.com` | `demo1234` | Standard User | **Sales**: Guest (`GUEST`) | **Guest** (2/5) |
| Kevin Bacon | `kevin@example.com` | `demo1234` | Standard User | **Marketing**: Guest (`GUEST`) | **Guest** (3/5) |
| Laura Croft | `laura@example.com` | `demo1234` | Standard User | **Sales**: Guest (`GUEST`) | **Guest** (4/5) |
| Mike Ross | `mike@example.com` | `demo1234` | Standard User | **Executive Legal**: Guest (`GUEST`) | **Guest** (5/5) |

**Total:** 13 configured users (2 Admins, 2 Owners, 4 Members, 5 Guests). Every user also possesses an isolated, auto-provisioned private `Personal` space.
5. **No Native Browser Dialogs:** Never use `alert()`, `confirm()`, `prompt()`, `<select>`, or `<datalist>` in the frontend. Use custom Tailwind modals and popovers.
6. **Type Safety:** Maintain strict TypeScript interfaces in `frontend/src/types.ts` mirroring backend Pydantic schemas. Verify changes with `npx tsc -b --noEmit`.
7. **One Source of Business Rules:** Prompt create/duplicate/move and proposal approve/reject/merge live in `backend/services/`. REST routes and MCP tools only authenticate, check roles, log audits and shape responses. Never copy rules into an adapter.
8. **Free-Tier Budget:** Never query Neon from health checks, startup or background jobs, and keep `/api/health` shallow by default. Tests must never touch the databases in `.env`: use in-memory SQLite, or an explicit throwaway URL such as `PGVECTOR_TEST_DATABASE_URL`.

---

## 7. Development & Verification Guide

### Backend Setup
```bash
cd backend
python -m venv ../.venv
source ../.venv/bin/activate
pip install -r requirements.txt
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend Setup
```bash
cd frontend
npm install
npm run dev -- --host 0.0.0.0 --port 5173
```

### Verification Checklist
- [ ] Backend starts cleanly on port 8000, creates tables, applies Alembic migrations and seeds the SQLite database.
- [ ] `GET /api/health` reports `paid.status: "not_checked"` (Neon untouched) and the community tier connected.
- [ ] User registration creates a new user and an isolated `Personal` space.
- [ ] Existing demo accounts can log in with password `demo1234`.
- [ ] Group Owner can invite a new member or guest by email address.
- [ ] Owner edits create an incremented version directly; Member edits submit a review proposal.
- [ ] Owner or other Members can approve proposals to auto-merge when threshold is met.
- [ ] Rollback allows Group Owner to activate an older version without creating duplicate history.
- [ ] Diff viewer toggles word-by-word and sentence-by-sentence changes cleanly with aligned toolbar boxes.
- [ ] `npx tsc -b --noEmit` completes with 0 errors.