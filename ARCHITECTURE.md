# PromptHold: Full System Architecture & Blueprint

This document provides a comprehensive, at-a-glance architectural blueprint of the entire **PromptHold RBAC & Version Control** platform. It details the client interaction models, edge routing, compute containers, distributed caching, database relations, and automated failover mechanics.

---

## 1. High-Level System Architecture Diagram

```mermaid
flowchart TD
    subgraph Clients["1. Clients & Consumers"]
        WebUser["Human Web User<br/>(Desktop / Mobile Browser)"]
        ChatUser["AI Chat User<br/>(In-Chat MCP Drawer: Claude, Cursor, LibreChat)"]
        AiAgent["Autonomous AI Agent<br/>(FastMCP Client / API Key)"]
    end

    subgraph EdgeCDN["2. Cloudflare Global Edge Network"]
        CFPages["Cloudflare Pages CDN<br/>(https://prompthold.pages.dev)<br/>• React 18 SPA (Vite)<br/>• Tailwind CSS Custom UI<br/>• Word & Sentence Diff Engine"]
        
        CFWorker["Cloudflare Worker: Edge Gateway & Load Balancer<br/>(https://prompt-vault-gateway.tashfiks.workers.dev)<br/>• Request router & CORS handler<br/>• 2.8s upstream timeout (AbortSignal)<br/>• Instant edge failover logic<br/>• 14-min keep-alive cron job<br/>• Edge SQL executor (@neondatabase/serverless)"]
    end

    subgraph AuthLayer["3. Identity & Authentication"]
        FirebaseAuth["Firebase / Google Identity Services<br/>• Google OAuth 2.0 / SSO<br/>• JWT ID Token verification"]
        SessionAuth["Session & API Key Engine<br/>• PBKDF2-SHA256 password hashing<br/>• Bearer session tokens (14-day expiry)<br/>• Scoped MCP API Keys (Admin / Group / Personal)"]
    end

    subgraph ComputeLayer["4. Compute & Container Layer (Render)"]
        RenderService["Render Web Service (Docker Container)<br/>(https://prompthold-backend.onrender.com)<br/>• Python 3.12 / FastAPI (REST API)<br/>• FastMCP SSE Server (/mcp)<br/>• Granular RBAC authorization engine<br/>• Variable scanner: {{variable}}<br/>• Sequential versioning engine (v1, v2, v3...)<br/>• GitHub Issues feedback reporter"]
    end

    subgraph CacheLayer["5. Distributed Multi-Pod Cache (Upstash)"]
        UpstashRedis["Upstash Serverless Redis<br/>(adapting-reindeer-239122.upstash.io)<br/>• Prompt version cache (pv:ver_uuid:{uuid})<br/>• Active version pointer (pv:prompt_active:{id})<br/>• Multi-pod invalidation bus<br/>• TCP (Port 6379) + HTTPS REST API"]
    end

    subgraph StorageLayer["6. Relational Persistence (Neon)"]
        NeonDB["Neon Serverless PostgreSQL (AWS US-East-2)<br/>(ep-shy-smoke-pooler.us-east-2.aws.neon.tech)<br/>• PgBouncer pooled connection pool<br/>• Users, Groups & GroupMemberships (RBAC)<br/>• Prompts & Immutable PromptVersions<br/>• PromptProposals & ProposalApprovals<br/>• API Keys, Audit Logs & Feedback"]
    end

    %% Client traffic
    WebUser -->|HTTPS| CFPages
    CFPages -->|API Requests| CFWorker
    ChatUser -->|Loads App Drawer| CFPages
    AiAgent -->|MCP Protocol /api-keys| CFWorker
    
    %% Auth flows
    WebUser -.->|Google SSO ID Token| FirebaseAuth
    FirebaseAuth -.->|Token Verification| CFWorker
    FirebaseAuth -.->|Token Verification| RenderService

    %% Gateway Routing
    CFWorker -->|Route A: Primary Upstream Proxy| RenderService
    CFWorker -->|Route B: Failover Edge Query if Render is asleep| NeonDB

    %% Backend Compute Connections
    RenderService -->|1. Check / Set Version Cache| UpstashRedis
    RenderService -->|2. Relational Read / Write| NeonDB
    RenderService -.->|Cache Invalidation| UpstashRedis
```

---

## 2. Request Routing & Failover Sequence

The Cloudflare Worker implements intelligent load-balancing and instant edge failover to prevent users from experiencing cold-start stalls.

```mermaid
sequenceDiagram
    autonumber
    actor Client as User / MCP Client
    participant GW as Cloudflare Worker (Edge Gateway)
    participant Render as Render Backend (Docker Container)
    participant Redis as Upstash Redis Cache
    participant DB as Neon PostgreSQL (Pooled)

    %% Scenario A: Healthy Primary
    Note over Client,DB: Scenario A: Normal Fast-Path Request
    Client->>GW: GET /api/prompts (Bearer Token)
    GW->>Render: Forward request (with 2.8s AbortSignal timeout)
    Render->>Redis: Check active version cache (pv:prompt_active:{id})
    alt Cache Hit
        Redis-->>Render: Return cached prompt version JSON
    else Cache Miss
        Render->>DB: Query SQL: Prompts & Active Versions
        DB-->>Render: Return prompt rows
        Render->>Redis: Store snapshot in Redis (TTL: 7 days)
    end
    Render-->>GW: HTTP 200 OK (x-served-by: render-upstream)
    GW-->>Client: HTTP 200 OK + Prompt Data

    %% Scenario B: Cold Start / Failover
    Note over Client,DB: Scenario B: Render is Sleeping or Times Out (>2.8s)
    Client->>GW: GET /api/prompts (Bearer Token)
    GW->>Render: Forward request (Waiting up to 2.8s...)
    Note over Render: Render container spinning up from zero...
    GW->>GW: 2.8s timeout reached! Abort upstream request.
    GW->>DB: Direct Edge SQL via @neondatabase/serverless (<40ms)
    DB-->>GW: Return prompt records
    GW-->>Client: HTTP 200 OK (x-served-by: edge-failover-db)

    %% Scenario C: 14-min Keep-Alive
    Note over GW,Render: Scenario C: 14-Minute Keep-Alive Cron
    loop Every 14 Minutes
        GW->>Render: GET /api/health
        Render-->>GW: HTTP 200 {"status":"ok"} (Container Stays Awake)
    end
```

---

## 3. Relational Data Model (Entity-Relationship)

Every database table is strictly isolated by group boundaries and personal ownership.

```mermaid
erDiagram
    User ||--o{ GroupMembership : "belongs to"
    User ||--o{ Group : "creates / owns"
    User ||--o{ Prompt : "creates"
    User ||--o{ PromptVersion : "authors"
    User ||--o{ PromptProposal : "submits"
    User ||--o{ ProposalApproval : "votes to approve"
    User ||--o{ ApiKey : "owns"
    User ||--o{ AuthSession : "holds"
    User ||--o{ FeedbackSubmission : "reports"
    User ||--o{ AuditLog : "triggers"

    Group ||--o{ GroupMembership : "contains"
    Group ||--o{ Prompt : "contains"
    Group ||--o{ PromptProposal : "contains review requests"

    Prompt ||--o{ PromptVersion : "has immutable history"
    Prompt ||--o{ PromptProposal : "has pending edits"
    Prompt ||--o{ SharedDiffLink : "generates shareable diffs"

    PromptProposal ||--o{ ProposalApproval : "receives votes"

    User {
        string id PK "UUID"
        string name "User full name"
        string email UK "Indexed unique email"
        string password_hash "PBKDF2-SHA256 salted hash"
        boolean is_workspace_admin "Global admin privilege"
        boolean onboarding_completed "First-run tour status"
        datetime created_at "UTC timestamp"
    }

    Group {
        string id PK "UUID"
        string name "Group name (e.g. Marketing, Sales)"
        string description "Team purpose"
        string created_by FK "User reference"
        boolean is_personal "True for private personal space"
        string personal_owner_id FK "User reference for personal space"
        int required_approvals "Proposal threshold (default 1)"
        datetime created_at "UTC timestamp"
    }

    GroupMembership {
        string id PK "UUID"
        string user_id FK "User reference"
        string group_id FK "Group reference"
        string role "GROUP_MANAGER, MEMBER, or GUEST"
        datetime added_at "UTC timestamp"
    }

    Prompt {
        string id PK "UUID"
        string group_id FK "Group reference"
        string title "Prompt title"
        string description "Usage context"
        int current_version_number "Pointer to active version"
        string created_by FK "User reference"
        boolean is_archived "Soft delete state"
        datetime updated_at "UTC timestamp"
    }

    PromptVersion {
        string id PK "UUID"
        string prompt_id FK "Prompt reference"
        int version_number "Sequential incremental (1, 2, 3...)"
        string content "Raw prompt text with {{variables}}"
        string variables_json "JSON array of detected tokens"
        string change_note "Plain-English explanation"
        string source_filename "Uploaded file name if imported"
        string author_id FK "User reference"
        datetime created_at "UTC timestamp"
    }

    PromptProposal {
        string id PK "UUID"
        string prompt_id FK "Prompt reference"
        string group_id FK "Group reference"
        string proposer_id FK "User reference"
        string title "Proposal title"
        string content "Proposed updated prompt text"
        string change_note "Rationale for changes"
        string status "PENDING, APPROVED, or REJECTED"
        datetime created_at "UTC timestamp"
    }

    ProposalApproval {
        string id PK "UUID"
        string proposal_id FK "PromptProposal reference"
        string user_id FK "User reference"
        datetime created_at "UTC timestamp"
    }

    ApiKey {
        string id PK "UUID"
        string user_id FK "User reference"
        string key_hash UK "SHA-256 hash of API key"
        string name "Key label (e.g. Claude Desktop)"
        string scope_type "ALL_ACCESSIBLE, GROUP, or PERSONAL_ONLY"
        string access_level "READ_ONLY or READ_WRITE"
        string group_id FK "Specific group if scoped"
        datetime created_at "UTC timestamp"
    }

    AuthSession {
        string id PK "UUID"
        string token UK "SHA-256 session token hash"
        string user_id FK "User reference"
        datetime created_at "UTC timestamp"
        datetime expires_at "14-day expiry timestamp"
    }
```

---

## 4. Role-Based Access Control (RBAC) Permission Matrix

PromptHold enforces a two-tier permission system: Global Workspace tier and Group-Level Membership tier.

| Action / Capability | Workspace Admin | Group Owner (`GROUP_MANAGER`) | Team Member (`MEMBER`) | Guest (`GUEST`) | Personal Space Owner |
|---|:---:|:---:|:---:|:---:|:---:|
| **View Group Prompts & Diffs** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes (Own only) |
| **Test & Interpolate Variables** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| **Direct Edit & Publish Version** | ✅ Yes | ✅ Yes | ❌ (Creates Proposal) | ❌ No | ✅ Yes (Instant) |
| **Submit Edit Proposal** | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No | N/A (Direct save) |
| **Vote to Approve Proposals** | ✅ Yes | ✅ Yes | ✅ Yes (Not own) | ❌ No | N/A |
| **Switch Active Version (Rollback)** | ✅ Yes | ✅ Yes | ❌ No | ❌ No | ✅ Yes |
| **Batch Upload Files (.txt, .md, .csv)** | ✅ Yes | ✅ Yes | ❌ No | ❌ No | ✅ Yes |
| **Add / Remove Members & Guests** | ✅ Yes | ✅ Yes | ❌ No | ❌ No | N/A |
| **Configure Required Approvals** | ✅ Yes | ✅ Yes | ❌ No | ❌ No | N/A |
| **Create Scoped MCP API Keys** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes (Read-only) | ✅ Yes |
| **Access Other Users' Personal Space** | ❌ Strictly Isolated | ❌ Strictly Isolated | ❌ Strictly Isolated | ❌ Strictly Isolated | ✅ Full Ownership |

---

## 5. Dual-Mode Frontend Operating Architecture

The React application ([`frontend/src/App.tsx`](file:///media/tinux/Media%20&%20Files/Code/Projects/prompt-vault-mcp/frontend/src/App.tsx)) automatically detects its environment and renders in one of three modes:

```mermaid
flowchart TD
    Start["User visits application URL"] --> CheckParam{"Inspect URL Query Parameters"}

    CheckParam -->|"?share_diff=<share_id>"| SharedMode["Mode 1: Shared Diff View<br/>• Zero-config side-by-side or inline view<br/>• Pre-locked base & target versions<br/>• Read-only visual comparison for team members"]

    CheckParam -->|"?mcp_mode=1"| McpDrawer["Mode 2: Embedded MCP App Drawer<br/>• Rendered inside Claude Desktop / Cursor / LibreChat<br/>• Compact drawer layout (@modelcontextprotocol/ext-apps)<br/>• Select prompt, fill {{variables}}, and insert directly into AI chat"]

    CheckParam -->|"Standard Web Access"| AuthCheck{"Check Session Token in localStorage"}

    AuthCheck -->|"Unauthenticated"| LoginPage["Sign In & Registration<br/>• Email/Password auth<br/>• Firebase / Google SSO<br/>• 1-Click Interactive Demo Accounts"]
    
    AuthCheck -->|"Authenticated"| FullWorkspace["Mode 3: Standalone Web Workspace<br/>• Group & Personal space switcher<br/>• Prompt Editor with live variable tester<br/>• Sequential version timeline with rollback<br/>• Granular Word & Sentence visual diff viewer<br/>• Team Review Requests & proposal voting inbox<br/>• Scoped MCP API Key management dashboard<br/>• Drag-and-drop batch file uploader"]
```

---

## 6. Project Directory Map

```text
prompt-vault-mcp/
├── ARCHITECTURE.md                  # This complete architecture blueprint
├── DEPLOYMENT_GUIDE.md              # Zero-cost cloud deployment guide
├── MAKING_CHANGES_LIVE.md           # Operational release & update guide
├── AGENTS.md                        # Authoritative system rules for AI agents
├── README.md                        # Project summary & getting started
├── Dockerfile                       # Multi-platform production container definition
├── render.yaml                      # Infrastructure-as-code blueprint for Render
├── Makefile                         # Local and container automation targets
├── run_tests.sh                     # 5-stage automated pre-flight test runner
│
├── backend/                         # Compute & Backend Service (Python/FastAPI)
│   ├── main.py                      # REST API endpoints, routing & CORS
│   ├── models.py                    # SQLAlchemy database ORM models
│   ├── schemas.py                   # Pydantic v2 input/output data schemas
│   ├── permissions.py               # RBAC rules, variable parser & scoping
│   ├── auth.py                      # PBKDF2 password hashing & token verification
│   ├── cache.py                     # Upstash Redis caching & GitHub feedback integration
│   ├── mcp_server.py                # FastMCP server & MCP tools definition
│   ├── seed.py                      # Database schema initial migration & demo data
│   └── tests/                       # Automated backend pytest test suites
│
├── cloudflare-worker/               # Global Edge Gateway & Load Balancer
│   ├── worker.js                    # Reverse proxy, 2.8s timeout, failover SQL & 14m cron
│   ├── wrangler.toml                # Cloudflare Worker configuration & variables
│   └── package.json                 # Worker runtime dependencies (@neondatabase/serverless)
│
└── frontend/                        # Frontend User Interface (React 18 + Vite + Tailwind)
    ├── index.html                   # HTML entry point shell
    ├── vite.config.ts               # Vite bundler configuration & proxies
    └── src/
        ├── App.tsx                  # Main application router & mode selector
        ├── api.ts                   # Type-safe API client & session manager
        ├── types.ts                 # TypeScript interfaces matching backend models
        └── components/              # Modular UI components
            ├── PromptDashboard.tsx          # Main prompt library & space filters
            ├── PromptEditorAndHistory.tsx   # Prompt editor, variable tester & timeline
            ├── VisualDiffViewer.tsx         # Granular word/sentence diff viewer
            ├── ReviewRequestsDashboard.tsx  # Proposal review & approval voting inbox
            ├── AccessGroupManager.tsx       # Team groups & member management
            ├── McpInChatDrawer.tsx          # In-chat MCP App drawer
            ├── SharedDiffPage.tsx           # Standalone shareable diff view
            ├── LoginPage.tsx                # Sign In & Demo accounts
            └── ui/                          # Custom Tailwind modals & popovers
                ├── ErrorBoundary.tsx        # React component crash protection
                ├── RoleBadge.tsx            # Interactive RBAC role pill
                ├── Brand.tsx                # Logos & highlighted prompt tokens
                └── ...                      # Custom dropdowns & confirmation modals
```
