import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";

let activeRequest = null;

function getCorsHeaders(req = null) {
  const r = req || activeRequest;
  const origin = (r && r.headers.get("Origin")) || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, If-None-Match, Mcp-Session-Id, X-Requested-With",
    "Access-Control-Expose-Headers": "ETag, X-Cache, X-Upstream-Pod, Mcp-Session-Id",
  };
}

const PBKDF2_ITERATIONS = 100000;

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...getCorsHeaders(),
      ...extraHeaders,
    },
  });
}

function errorResponse(detail, status = 400) {
  return jsonResponse({ detail }, status);
}

function uuid4() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(raw) {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const dk = crypto.pbkdf2Sync(
    Buffer.from(password, "utf8"),
    Buffer.from(salt, "utf8"),
    PBKDF2_ITERATIONS,
    32,
    "sha256"
  );
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${salt}$${dk.toString("hex")}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  const parts = storedHash.split("$");
  if (parts.length === 4 && parts[0] === "pbkdf2_sha256") {
    const iterations = Math.min(100000, parseInt(parts[1], 10) || PBKDF2_ITERATIONS);
    const salt = parts[2];
    const expected = parts[3];
    const dk = crypto.pbkdf2Sync(
      Buffer.from(password, "utf8"),
      Buffer.from(salt, "utf8"),
      iterations,
      32,
      "sha256"
    ).toString("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(dk), Buffer.from(expected));
    } catch {
      return false;
    }
  }
  return false;
}

function maskApiKey(rawKey) {
  if (rawKey.length <= 14) return `${rawKey.slice(0, 4)}••••••••`;
  return `${rawKey.slice(0, 11)}••••••••${rawKey.slice(-4)}`;
}

function extractVariables(text) {
  const regex = /\{\{\s*([a-zA-Z0-9_ -]+)\s*\}\}/g;
  const seen = new Set();
  const result = [];
  let match;
  while ((match = regex.exec(text || "")) !== null) {
    const clean = match[1].trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      result.push(clean);
    }
  }
  return result;
}

function serializeUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    is_workspace_admin: Boolean(u.is_workspace_admin),
    api_key: u.api_key || null,
    onboarding_completed: Boolean(u.onboarding_completed),
  };
}

async function authenticateRequest(request, sql) {
  const authHeader = request.headers.get("Authorization") || "";
  const xApiKey = request.headers.get("X-API-Key") || "";
  let token = "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    token = authHeader.slice(7).trim();
  } else if (xApiKey.trim()) {
    token = xApiKey.trim();
  }
  if (!token) return null;

  const tokenHash = sha256Hex(token);

  // 1. Check active session token (hashed or raw)
  const sessions = await sql`
    SELECT u.*
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE (s.token = ${tokenHash} OR s.token = ${token}) AND s.expires_at > NOW()
    LIMIT 1
  `;
  if (sessions.length > 0) return sessions[0];

  // 2. Check scoped api_keys by sha256 hash
  const scopedUsers = await sql`
    SELECT u.*, k.id AS key_id
    FROM api_keys k
    JOIN users u ON u.id = k.user_id
    WHERE k.key_hash = ${tokenHash} AND k.is_active = TRUE
    LIMIT 1
  `;
  if (scopedUsers.length > 0) {
    await sql`UPDATE api_keys SET last_used_at = NOW() WHERE id = ${scopedUsers[0].key_id}`;
    return scopedUsers[0];
  }

  // 3. Check legacy user api_key
  const legacyUsers = await sql`
    SELECT * FROM users WHERE api_key = ${token} LIMIT 1
  `;
  if (legacyUsers.length > 0) return legacyUsers[0];

  return null;
}

async function ensurePersonalGroup(sql, user) {
  const existing = await sql`
    SELECT * FROM groups
    WHERE personal_owner_id = ${user.id}
    LIMIT 1
  `;
  if (existing.length > 0) {
    const grp = existing[0];
    await sql`
      INSERT INTO group_memberships (id, user_id, group_id, role, added_at)
      VALUES (${uuid4()}, ${user.id}, ${grp.id}, 'GROUP_MANAGER', NOW())
      ON CONFLICT (user_id, group_id) DO NOTHING
    `;
    return grp;
  }
  const grpId = uuid4();
  const baseName = `Personal — ${user.name}`;
  const created = await sql`
    INSERT INTO groups (id, name, description, created_by, personal_owner_id, required_approvals, created_at)
    VALUES (${grpId}, ${baseName}, ${`Private personal prompt space for ${user.name}`}, ${user.id}, ${user.id}, 1, NOW())
    ON CONFLICT (name) DO UPDATE SET personal_owner_id = EXCLUDED.personal_owner_id
    RETURNING *
  `;
  await sql`
    INSERT INTO group_memberships (id, user_id, group_id, role, added_at)
    VALUES (${uuid4()}, ${user.id}, ${created[0].id}, 'GROUP_MANAGER', NOW())
    ON CONFLICT (user_id, group_id) DO NOTHING
  `;
  return created[0];
}

async function getUserGroupIds(sql, user) {
  const personal = await ensurePersonalGroup(sql, user);
  if (user.is_workspace_admin) {
    const rows = await sql`
      SELECT id FROM groups WHERE personal_owner_id IS NULL OR id = ${personal.id}
    `;
    return rows.map((r) => r.id);
  }
  const rows = await sql`
    SELECT group_id FROM group_memberships WHERE user_id = ${user.id}
  `;
  const ids = new Set(rows.map((r) => r.group_id));
  ids.add(personal.id);
  return Array.from(ids);
}

async function buildGroupResponses(sql, groupIds) {
  if (!groupIds || groupIds.length === 0) return [];
  const groups = await sql`
    SELECT * FROM groups WHERE id = ANY(${groupIds})
    ORDER BY (personal_owner_id IS NOT NULL) DESC, name ASC
  `;
  const memberships = await sql`
    SELECT m.id, m.user_id, m.group_id, m.role, u.name AS user_name, u.email AS user_email
    FROM group_memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.group_id = ANY(${groupIds})
  `;
  const promptCounts = await sql`
    SELECT group_id, COUNT(*)::int AS cnt
    FROM prompts
    WHERE group_id = ANY(${groupIds}) AND is_archived = FALSE
    GROUP BY group_id
  `;
  const countMap = new Map(promptCounts.map((r) => [r.group_id, r.cnt]));
  const memberMap = new Map();
  for (const m of memberships) {
    if (!memberMap.has(m.group_id)) memberMap.set(m.group_id, []);
    memberMap.get(m.group_id).push({
      id: m.id,
      user_id: m.user_id,
      user_name: m.user_name,
      user_email: m.user_email,
      group_id: m.group_id,
      role: m.role,
    });
  }
  return groups.map((g) => {
    const isPersonal = Boolean(g.personal_owner_id);
    return {
      id: g.id,
      name: isPersonal ? "Personal" : g.name,
      description: g.description || "",
      created_by: g.created_by,
      is_personal: isPersonal,
      personal_owner_id: g.personal_owner_id || null,
      required_approvals: Number(g.required_approvals ?? 1),
      created_at: g.created_at,
      members: memberMap.get(g.id) || [],
      prompt_count: countMap.get(g.id) || 0,
    };
  });
}

async function buildPromptSummaries(sql, groupIds, filterGroupId = null, search = null) {
  if (!groupIds || groupIds.length === 0) return [];
  const targetGroups = filterGroupId ? groupIds.filter((id) => id === filterGroupId) : groupIds;
  if (targetGroups.length === 0) return [];

  const rows = await sql`
    SELECT
      p.*,
      g.name AS group_name,
      g.personal_owner_id AS g_personal_owner_id,
      u.name AS creator_name,
      v.id AS v_id,
      v.prompt_id AS v_prompt_id,
      v.version_number AS v_version_number,
      v.content AS v_content,
      v.variables_json AS v_variables_json,
      v."change_Note" AS v_change_note,
      v.source_filename AS v_source_filename,
      v.author_id AS v_author_id,
      v.created_at AS v_created_at,
      au.name AS v_author_name,
      (SELECT COUNT(*)::int FROM prompt_versions pv WHERE pv.prompt_id = p.id) AS version_count
    FROM prompts p
    JOIN groups g ON g.id = p.group_id
    LEFT JOIN users u ON u.id = p.created_by
    LEFT JOIN prompt_versions v ON v.prompt_id = p.id AND v.version_number = p.current_version_number
    LEFT JOIN users au ON au.id = v.author_id
    WHERE p.is_archived = FALSE AND p.group_id = ANY(${targetGroups})
    ORDER BY p.updated_at DESC
  `;

  const q = search ? search.trim().toLowerCase() : "";
  const results = [];
  for (const r of rows) {
    if (q) {
      const hay = `${r.title} ${r.description || ""} ${r.v_content || ""}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    let vars = [];
    try {
      vars = JSON.parse(r.v_variables_json || "[]");
    } catch {
      vars = [];
    }
    results.push({
      id: r.id,
      group_id: r.group_id,
      group_name: r.g_personal_owner_id ? "Personal" : r.group_name || "Unknown",
      title: r.title,
      description: r.description || "",
      current_version_number: Number(r.current_version_number),
      current_version_id: r.current_version_id || r.v_id || null,
      created_by: r.created_by,
      creator_name: r.creator_name || "Unknown",
      updated_at: r.updated_at,
      content: r.v_content || "",
      variables: vars,
      version_count: Number(r.version_count || 1),
      latest_version: r.v_id
        ? {
            id: r.v_id,
            prompt_id: r.id,
            version_number: Number(r.v_version_number),
            content: r.v_content,
            variables: vars,
            change_note: r.v_change_note || "",
            source_filename: r.v_source_filename || null,
            author_id: r.v_author_id,
            author_name: r.v_author_name || "Unknown",
            created_at: r.v_created_at,
          }
        : null,
    });
  }
  return results;
}

async function buildProposalResponses(sql, proposals) {
  if (!proposals || proposals.length === 0) return [];
  const proposalIds = proposals.map((p) => p.id);
  const approvals = await sql`
    SELECT a.id, a.proposal_id, a.user_id, a.created_at, u.name AS user_name
    FROM proposal_approvals a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.proposal_id = ANY(${proposalIds})
    ORDER BY a.created_at ASC
  `;
  const appMap = new Map();
  for (const a of approvals) {
    if (!appMap.has(a.proposal_id)) appMap.set(a.proposal_id, []);
    appMap.get(a.proposal_id).push({
      id: a.id,
      user_id: a.user_id,
      user_name: a.user_name || "Unknown",
      created_at: a.created_at,
    });
  }
  return proposals.map((p) => ({
    id: p.id,
    prompt_id: p.prompt_id,
    prompt_title: p.prompt_title || "Unknown",
    group_id: p.group_id,
    group_name: p.group_name || "Unknown",
    proposer_id: p.proposer_id,
    proposer_name: p.proposer_name || "Unknown",
    title: p.title,
    description: p.description || "",
    content: p.content,
    change_note: p.change_note || "",
    status: p.status,
    required_approvals: Number(p.required_approvals ?? 1),
    approvals: appMap.get(p.id) || [],
    created_at: p.created_at,
    updated_at: p.updated_at,
  }));
}

async function resolveMcpUser(sql, rawApiKey) {
  if (!rawApiKey) return null;
  const keyHash = sha256Hex(rawApiKey.trim());
  const scoped = await sql`
    SELECT u.* FROM api_keys k JOIN users u ON u.id = k.user_id
    WHERE k.key_hash = ${keyHash} AND k.is_active = TRUE LIMIT 1
  `;
  if (scoped.length > 0) return scoped[0];
  const legacy = await sql`SELECT * FROM users WHERE api_key = ${rawApiKey.trim()} LIMIT 1`;
  if (legacy.length > 0) return legacy[0];
  const sess = await sql`
    SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id
    WHERE (s.token = ${keyHash} OR s.token = ${rawApiKey.trim()}) AND s.expires_at > NOW() LIMIT 1
  `;
  return sess[0] || null;
}

async function handleMcpRequest(request, env, sql) {
  if (request.method === "GET") {
    return jsonResponse({
      name: "PromptHold MCP Server",
      status: "ok",
      protocol: "mcp-streamable-http",
      tools: [
        "list_my_accessible_prompts",
        "get_and_fill_prompt",
        "save_prompt_version_from_chat",
        "duplicate_or_move_prompt",
      ],
    });
  }
  const body = await request.json().catch(() => ({}));
  const { id, method, params } = body;

  if (method === "initialize") {
    return jsonResponse({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "PromptHold RBAC & Version Control", version: "2.0.0" },
      },
    });
  }

  if (method === "tools/list") {
    return jsonResponse({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "list_my_accessible_prompts",
            description: "List prompts accessible to the caller's personal API key.",
            inputSchema: {
              type: "object",
              properties: {
                api_key: { type: "string" },
                search_query: { type: "string" },
                group_name: { type: "string" },
              },
              required: ["api_key"],
            },
          },
          {
            name: "get_and_fill_prompt",
            description: "Compile the active version of a prompt by filling {{variables}}.",
            inputSchema: {
              type: "object",
              properties: {
                api_key: { type: "string" },
                prompt_id: { type: "string" },
                variables: { type: "object" },
              },
              required: ["api_key", "prompt_id"],
            },
          },
          {
            name: "save_prompt_version_from_chat",
            description: "Save a new version or proposal directly from an AI chat client.",
            inputSchema: {
              type: "object",
              properties: {
                api_key: { type: "string" },
                prompt_id: { type: "string" },
                new_content: { type: "string" },
                change_note: { type: "string" },
              },
              required: ["api_key", "prompt_id", "new_content"],
            },
          },
        ],
      },
    });
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};
    const apiKey = args.api_key || (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");

    const user = await resolveMcpUser(sql, apiKey);
    if (!user) {
      return jsonResponse({
        jsonrpc: "2.0",
        id,
        result: { isError: true, content: [{ type: "text", text: "Invalid API key." }] },
      });
    }
    const groupIds = await getUserGroupIds(sql, user);

    if (toolName === "list_my_accessible_prompts") {
      const summaries = await buildPromptSummaries(sql, groupIds, null, args.search_query || null);
      const filtered = args.group_name
        ? summaries.filter((s) => s.group_name.toLowerCase() === String(args.group_name).toLowerCase())
        : summaries;
      return jsonResponse({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify({ user: user.name, count: filtered.length, prompts: filtered }, null, 2) }] },
      });
    }

    if (toolName === "get_and_fill_prompt") {
      const summaries = await buildPromptSummaries(sql, groupIds, null, null);
      const target = summaries.find((s) => s.id === args.prompt_id);
      if (!target || !target.latest_version) {
        return jsonResponse({
          jsonrpc: "2.0",
          id,
          result: { isError: true, content: [{ type: "text", text: "Prompt not found or access denied." }] },
        });
      }
      let compiled = target.latest_version.content;
      const vars = args.variables || {};
      for (const [k, v] of Object.entries(vars)) {
        const pattern = new RegExp(`\\{\\{\\s*${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`, "g");
        compiled = compiled.replace(pattern, String(v));
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                prompt_id: target.id,
                title: target.title,
                version: target.current_version_number,
                compiled_prompt: compiled,
              }, null, 2),
            },
          ],
        },
      });
    }
  }

  return jsonResponse({ jsonrpc: "2.0", id, result: {} });
}

export default {
  async fetch(request, env, ctx) {
    activeRequest = request;
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: getCorsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Optional multi-pod upstream forwarding (Render + Edge Failover)
    const pods = [env.RENDER_ORIGIN, env.BACKEND_POD_1, env.BACKEND_POD_2].filter(Boolean);
    if (pods.length > 0 && (path.startsWith("/api/") || path.startsWith("/mcp"))) {
      for (const pod of pods) {
        try {
          const targetUrl = new URL(path + url.search, pod);
          const reqBody = ["GET", "HEAD"].includes(request.method) ? undefined : request.body;
          const upstreamReq = new Request(targetUrl.toString(), {
            method: request.method,
            headers: request.headers,
            body: reqBody,
            redirect: "follow",
            signal: AbortSignal.timeout(2800),
          });
          const resp = await fetch(upstreamReq);
          if (resp.status < 502) {
            const headers = new Headers(resp.headers);
            headers.set("X-Upstream-Pod", pod);
            headers.set("X-Served-By", "render-upstream");
            for (const [k, v] of Object.entries(getCorsHeaders(request))) headers.set(k, v);
            return new Response(resp.body, { status: resp.status, headers });
          }
        } catch {
          // Failover to next pod or built-in Edge Neon execution
        }
      }
    }

    // 2. Direct Edge execution against Neon Lakebase Postgres
    if (path.startsWith("/api/") || path.startsWith("/mcp")) {
      if (!env.DATABASE_URL) {
        return errorResponse("DATABASE_URL secret is not configured on Worker.", 500);
      }
      const sql = neon(env.DATABASE_URL);

      try {
        if (path.startsWith("/mcp")) {
          return await handleMcpRequest(request, env, sql);
        }

        // Health check
        if (path === "/api/health" && request.method === "GET") {
          const ping = await sql`SELECT 1 AS ok`;
          return jsonResponse({
            status: "ok",
            service: "PromptHold RBAC & Version Control",
            runtime: "cloudflare-worker-edge",
            database: ping.length > 0 ? "neon-postgres-connected" : "degraded",
          });
        }

        // Auth: Login
        if (path === "/api/auth/login" && request.method === "POST") {
          const body = await request.json();
          const email = (body.email || "").trim().toLowerCase();
          const users = await sql`SELECT * FROM users WHERE LOWER(email) = ${email} LIMIT 1`;
          const user = users[0];
          if (!user) {
            return errorResponse("Invalid email or password.", 401);
          }
          if (user.password_hash && user.password_hash.startsWith("$argon2")) {
            // Argon2id hashes require primary backend verification.
            // When edge failover is active, proxy upstream with extended timeout to avoid false 401.
            const origin = env.RENDER_ORIGIN || env.BACKEND_POD_1;
            if (origin) {
              try {
                const upstreamResp = await fetch(new URL(path, origin).toString(), {
                  method: "POST",
                  headers: request.headers,
                  body: JSON.stringify(body),
                  signal: AbortSignal.timeout(6000),
                });
                return new Response(upstreamResp.body, {
                  status: upstreamResp.status,
                  headers: { ...getCorsHeaders(request), "Content-Type": "application/json" },
                });
              } catch {}
            }
            return errorResponse("Backend authentication service is spinning up. Please retry in a few moments.", 503);
          }
          if (!verifyPassword(body.password || "", user.password_hash)) {
            return errorResponse("Invalid email or password.", 401);
          }
          await ensurePersonalGroup(sql, user);
          const rawToken = crypto.randomBytes(32).toString("base64url");
          const tokenHash = sha256Hex(rawToken);
          await sql`
            INSERT INTO auth_sessions (token, user_id, created_at, expires_at)
            VALUES (${tokenHash}, ${user.id}, NOW(), NOW() + INTERVAL '14 days')
          `;
          return jsonResponse({
            token: rawToken,
            user: serializeUser(user),
          });
        }

        // Auth: Register
        if (path === "/api/auth/register" && request.method === "POST") {
          const body = await request.json();
          const name = (body.name || "").trim();
          const email = (body.email || "").trim().toLowerCase();
          const password = body.password || "";
          if (!name || !email || password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
            return errorResponse("Name, valid email, and password (min 8 chars with letters & numbers) are required.", 400);
          }
          const existing = await sql`SELECT id FROM users WHERE LOWER(email) = ${email} LIMIT 1`;
          if (existing.length > 0) {
            return errorResponse("An account with this email already exists.", 400);
          }
          const userId = uuid4();
          const pwHash = hashPassword(password);
          const inserted = await sql`
            INSERT INTO users (id, name, email, password_hash, is_workspace_admin, onboarding_completed, created_at)
            VALUES (${userId}, ${name}, ${email}, ${pwHash}, FALSE, FALSE, NOW())
            RETURNING *
          `;
          const user = inserted[0];
          await ensurePersonalGroup(sql, user);
          const rawToken = crypto.randomBytes(32).toString("base64url");
          const tokenHash = sha256Hex(rawToken);
          await sql`
            INSERT INTO auth_sessions (token, user_id, created_at, expires_at)
            VALUES (${tokenHash}, ${user.id}, NOW(), NOW() + INTERVAL '14 days')
          `;
          return jsonResponse({
            token: rawToken,
            user: serializeUser(user),
          });
        }

        // Auth: Firebase / Google SSO
        if (path === "/api/auth/firebase" && request.method === "POST") {
          const body = await request.json();
          const idToken = (body.id_token || "").trim();
          if (!idToken) return errorResponse("id_token is required.", 400);

          let verifiedUser = null;

          // 1. Verify via Firebase Web API key if configured
          if (env.FIREBASE_WEB_API_KEY) {
            try {
              const resp = await fetch(
                `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_WEB_API_KEY}`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ idToken }),
                }
              );
              if (resp.ok) {
                const data = await resp.json();
                const acc = data.users?.[0];
                if (acc && acc.email) {
                  verifiedUser = {
                    email: acc.email.toLowerCase(),
                    name: acc.displayName || body.display_name || acc.email.split("@")[0],
                  };
                }
              }
            } catch {}
          }

          // 2. Verify via Google oauth2 tokeninfo
          if (!verifiedUser) {
            try {
              const resp = await fetch(
                `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
              );
              if (resp.ok) {
                const data = await resp.json();
                if (data.email && (data.email_verified === "true" || data.email_verified === true)) {
                  verifiedUser = {
                    email: data.email.toLowerCase(),
                    name: data.name || body.display_name || data.email.split("@")[0],
                  };
                }
              }
            } catch {}
          }

          if (!verifiedUser) {
            return errorResponse("Invalid or unverified Firebase / Google token.", 401);
          }

          let users = await sql`SELECT * FROM users WHERE LOWER(email) = ${verifiedUser.email} LIMIT 1`;
          let user = users[0];
          if (!user) {
            const userId = uuid4();
            const inserted = await sql`
              INSERT INTO users (id, name, email, password_hash, is_workspace_admin, onboarding_completed, created_at)
              VALUES (${userId}, ${verifiedUser.name}, ${verifiedUser.email}, NULL, FALSE, FALSE, NOW())
              RETURNING *
            `;
            user = inserted[0];
          }

          await ensurePersonalGroup(sql, user);
          const rawToken = crypto.randomBytes(32).toString("base64url");
          const tokenHash = sha256Hex(rawToken);
          await sql`
            INSERT INTO auth_sessions (token, user_id, created_at, expires_at)
            VALUES (${tokenHash}, ${user.id}, NOW(), NOW() + INTERVAL '14 days')
          `;
          return jsonResponse({
            token: rawToken,
            user: serializeUser(user),
          });
        }

        // Auth: Logout
        if (path === "/api/auth/logout" && request.method === "POST") {
          const authHeader = request.headers.get("Authorization") || "";
          if (authHeader.toLowerCase().startsWith("bearer ")) {
            const rawToken = authHeader.slice(7).trim();
            const tokenHash = sha256Hex(rawToken);
            await sql`DELETE FROM auth_sessions WHERE token = ${tokenHash} OR token = ${rawToken}`;
          }
          return jsonResponse({ status: "logged_out" });
        }

        // Public shared diff view
        const diffShareMatch = path.match(/^\/api\/diff-shares\/([^/]+)$/);
        if (diffShareMatch && request.method === "GET") {
          const shareId = diffShareMatch[1];
          const shares = await sql`SELECT * FROM shared_diff_links WHERE id = ${shareId} AND is_revoked = FALSE LIMIT 1`;
          if (shares.length === 0) return errorResponse("Shared diff link not found.", 404);
          const share = shares[0];
          const prompts = await sql`
            SELECT p.*, g.name AS group_name
            FROM prompts p JOIN groups g ON g.id = p.group_id
            WHERE p.id = ${share.prompt_id} LIMIT 1
          `;
          if (prompts.length === 0) return errorResponse("Prompt not found.", 404);
          const prompt = prompts[0];
          const versions = await sql`
            SELECT v.*, v."change_Note" AS c_note, u.name AS author_name
            FROM prompt_versions v LEFT JOIN users u ON u.id = v.author_id
            WHERE v.prompt_id = ${prompt.id}
              AND v.version_number IN (${share.base_version}, ${share.target_version})
          `;
          const vMap = new Map(
            versions.map((v) => [
              Number(v.version_number),
              {
                id: v.id,
                prompt_id: v.prompt_id,
                version_number: Number(v.version_number),
                content: v.content,
                variables: JSON.parse(v.variables_json || "[]"),
                change_note: v.c_note || "",
                source_filename: v.source_filename || null,
                author_id: v.author_id,
                author_name: v.author_name || "Unknown",
                created_at: v.created_at,
              },
            ])
          );
          return jsonResponse({
            id: share.id,
            prompt_id: prompt.id,
            prompt_title: prompt.title,
            group_name: prompt.group_name,
            base_version: Number(share.base_version),
            target_version: Number(share.target_version),
            diff_granularity: share.diff_granularity,
            view_mode: share.view_mode,
            base_version_data: vMap.get(Number(share.base_version)),
            target_version_data: vMap.get(Number(share.target_version)),
            created_at: share.created_at,
          });
        }

        // All remaining routes require authentication
        const user = await authenticateRequest(request, sql);
        if (!user) {
          return errorResponse("Authentication required. Please sign in.", 401);
        }

        // GET /api/me
        if (path === "/api/me" && request.method === "GET") {
          const memberships = await sql`
            SELECT m.id, m.user_id, m.group_id, m.role, g.name AS group_name, g.personal_owner_id
            FROM group_memberships m
            JOIN groups g ON g.id = m.group_id
            WHERE m.user_id = ${user.id}
          `;
          const latestKey = await sql`
            SELECT key_prefix FROM api_keys WHERE user_id = ${user.id} AND is_active = TRUE
            ORDER BY created_at DESC LIMIT 1
          `;
          return jsonResponse({
            id: user.id,
            name: user.name,
            email: user.email,
            is_workspace_admin: Boolean(user.is_workspace_admin),
            api_key: latestKey[0]?.key_prefix || user.api_key || null,
            onboarding_completed: Boolean(user.onboarding_completed),
            groups: memberships.map((m) => ({
              id: m.group_id,
              name: m.personal_owner_id ? "Personal" : m.group_name,
              role: m.role,
              is_personal: Boolean(m.personal_owner_id),
            })),
          });
        }

        // POST /api/me/onboarding-complete & PATCH /api/me/onboarding
        if ((path === "/api/me/onboarding-complete" || path === "/api/me/onboarding") && (request.method === "POST" || request.method === "PATCH")) {
          await sql`UPDATE users SET onboarding_completed = TRUE WHERE id = ${user.id}`;
          return jsonResponse({ status: "completed", onboarding_completed: true });
        }

        // GET /api/users
        if (path === "/api/users" && request.method === "GET") {
          const users = await sql`SELECT * FROM users ORDER BY name ASC`;
          return jsonResponse(users.map(serializeUser));
        }

        // GET & POST /api/groups
        if (path === "/api/groups" && request.method === "GET") {
          const groupIds = await getUserGroupIds(sql, user);
          return jsonResponse(await buildGroupResponses(sql, groupIds));
        }

        if (path === "/api/groups" && request.method === "POST") {
          const body = await request.json();
          const grpId = uuid4();
          await sql`
            INSERT INTO groups (id, name, description, created_by, required_approvals, created_at)
            VALUES (${grpId}, ${body.name.trim()}, ${(body.description || "").trim()}, ${user.id}, 1, NOW())
          `;
          const managerId = body.initial_manager_id || user.id;
          await sql`
            INSERT INTO group_memberships (id, user_id, group_id, role, added_at)
            VALUES (${uuid4()}, ${managerId}, ${grpId}, 'GROUP_MANAGER', NOW())
            ON CONFLICT (user_id, group_id) DO NOTHING
          `;
          const built = await buildGroupResponses(sql, [grpId]);
          return jsonResponse(built[0], 200);
        }

        // PATCH /api/groups/:id/settings
        const groupSettingsMatch = path.match(/^\/api\/groups\/([^/]+)\/settings$/);
        if (groupSettingsMatch && request.method === "PATCH") {
          const groupId = groupSettingsMatch[1];
          const body = await request.json();
          const reqApp = Math.max(1, Number(body.required_approvals || 1));
          await sql`UPDATE groups SET required_approvals = ${reqApp} WHERE id = ${groupId}`;
          const built = await buildGroupResponses(sql, [groupId]);
          return jsonResponse(built[0]);
        }

        // POST /api/groups/:id/members
        const groupMembersMatch = path.match(/^\/api\/groups\/([^/]+)\/members$/);
        if (groupMembersMatch && request.method === "POST") {
          const groupId = groupMembersMatch[1];
          const body = await request.json();
          let targetUser = null;
          if (body.user_id) {
            const r = await sql`SELECT * FROM users WHERE id = ${body.user_id} LIMIT 1`;
            targetUser = r[0];
          } else if (body.email) {
            const r = await sql`SELECT * FROM users WHERE LOWER(email) = ${body.email.trim().toLowerCase()} LIMIT 1`;
            targetUser = r[0];
          }
          if (!targetUser) return errorResponse("No registered user found with that email.", 404);
          const role = ["GROUP_MANAGER", "MEMBER", "GUEST"].includes(body.role) ? body.role : "MEMBER";
          await sql`
            INSERT INTO group_memberships (id, user_id, group_id, role, added_at)
            VALUES (${uuid4()}, ${targetUser.id}, ${groupId}, ${role}, NOW())
            ON CONFLICT (user_id, group_id) DO UPDATE SET role = EXCLUDED.role
          `;
          const built = await buildGroupResponses(sql, [groupId]);
          return jsonResponse(built[0]);
        }

        // DELETE /api/groups/:id/members/:userId
        const groupMemberDelMatch = path.match(/^\/api\/groups\/([^/]+)\/members\/([^/]+)$/);
        if (groupMemberDelMatch && request.method === "DELETE") {
          const [, groupId, targetUserId] = groupMemberDelMatch;
          await sql`DELETE FROM group_memberships WHERE group_id = ${groupId} AND user_id = ${targetUserId}`;
          return jsonResponse({ status: "removed" });
        }

        // GET & POST /api/prompts
        if (path === "/api/prompts" && request.method === "GET") {
          const groupIds = await getUserGroupIds(sql, user);
          const filterGroupId = url.searchParams.get("group_id");
          const search = url.searchParams.get("search");
          const summaries = await buildPromptSummaries(sql, groupIds, filterGroupId, search);
          return jsonResponse(summaries);
        }

        if (path === "/api/prompts" && request.method === "POST") {
          const body = await request.json();
          const promptId = uuid4();
          const versionId = uuid4();
          const vars = JSON.stringify(extractVariables(body.content || ""));
          await sql`
            INSERT INTO prompts (id, group_id, title, description, current_version_number, current_version_id, created_by, updated_at, is_archived)
            VALUES (${promptId}, ${body.group_id}, ${body.title.trim()}, ${(body.description || "").trim()}, 1, ${versionId}, ${user.id}, NOW(), FALSE)
          `;
          await sql`
            INSERT INTO prompt_versions (id, prompt_id, version_number, content, variables_json, "change_Note", source_filename, author_id, created_at)
            VALUES (${versionId}, ${promptId}, 1, ${body.content}, ${vars}, ${body.change_note || "Initial version"}, ${body.source_filename || null}, ${user.id}, NOW())
          `;
          const summaries = await buildPromptSummaries(sql, [body.group_id]);
          const created = summaries.find((s) => s.id === promptId);
          return jsonResponse(created || summaries[0]);
        }

        // PUT /api/prompts/:id
        const promptIdMatch = path.match(/^\/api\/prompts\/([^/]+)$/);
        if (promptIdMatch && request.method === "PUT") {
          const promptId = promptIdMatch[1];
          const body = await request.json();
          const prompts = await sql`SELECT * FROM prompts WHERE id = ${promptId} LIMIT 1`;
          if (prompts.length === 0) return errorResponse("Prompt not found.", 404);
          const prompt = prompts[0];
          const groups = await sql`SELECT * FROM groups WHERE id = ${prompt.group_id} LIMIT 1`;
          const group = groups[0];

          if (group && group.personal_owner_id === user.id) {
            const maxRows = await sql`SELECT COALESCE(MAX(version_number), 0)::int AS max_v FROM prompt_versions WHERE prompt_id = ${promptId}`;
            const nextVer = Number(maxRows[0].max_v) + 1;
            const versionId = uuid4();
            const newTitle = body.title !== undefined && body.title !== null ? body.title.trim() : prompt.title;
            const newDesc = body.description !== undefined && body.description !== null ? body.description.trim() : prompt.description;
            const vars = JSON.stringify(extractVariables(body.content || ""));
            await sql`
              INSERT INTO prompt_versions (id, prompt_id, version_number, content, variables_json, "change_Note", source_filename, author_id, created_at)
              VALUES (${versionId}, ${promptId}, ${nextVer}, ${body.content}, ${vars}, ${body.change_note || `Updated to v${nextVer}`}, ${body.source_filename || null}, ${user.id}, NOW())
            `;
            await sql`
              UPDATE prompts
              SET title = ${newTitle}, description = ${newDesc}, current_version_number = ${nextVer}, current_version_id = ${versionId}, updated_at = NOW()
              WHERE id = ${promptId}
            `;
            const summaries = await buildPromptSummaries(sql, [prompt.group_id]);
            return jsonResponse(summaries.find((s) => s.id === promptId));
          } else {
            const propId = uuid4();
            const propTitle = body.title !== undefined && body.title !== null ? body.title.trim() : prompt.title;
            const propDesc = body.description !== undefined && body.description !== null ? body.description.trim() : prompt.description;
            await sql`
              INSERT INTO prompt_proposals (id, prompt_id, group_id, proposer_id, title, description, content, change_note, status, created_at, updated_at)
              VALUES (${propId}, ${promptId}, ${prompt.group_id}, ${user.id}, ${propTitle}, ${propDesc}, ${body.content}, ${body.change_note || "Proposed edit"}, 'PENDING', NOW(), NOW())
            `;
            const summaries = await buildPromptSummaries(sql, [prompt.group_id]);
            return jsonResponse(summaries.find((s) => s.id === promptId));
          }
        }

        // GET /api/prompts/:id/versions
        const versionsMatch = path.match(/^\/api\/prompts\/([^/]+)\/versions$/);
        if (versionsMatch && request.method === "GET") {
          const promptId = versionsMatch[1];
          const versions = await sql`
            SELECT v.*, v."change_Note" AS c_note, u.name AS author_name
            FROM prompt_versions v
            LEFT JOIN users u ON u.id = v.author_id
            WHERE v.prompt_id = ${promptId}
            ORDER BY v.version_number DESC
          `;
          return jsonResponse(
            versions.map((v) => ({
              id: v.id,
              prompt_id: v.prompt_id,
              version_number: Number(v.version_number),
              content: v.content,
              variables: JSON.parse(v.variables_json || "[]"),
              change_note: v.c_note || "",
              source_filename: v.source_filename || null,
              author_id: v.author_id,
              author_name: v.author_name || "Unknown",
              created_at: v.created_at,
            }))
          );
        }

        // POST /api/prompts/:id/rollback/:version
        const rollbackMatch = path.match(/^\/api\/prompts\/([^/]+)\/rollback\/(\d+)$/);
        if (rollbackMatch && request.method === "POST") {
          const [, promptId, targetVerStr] = rollbackMatch;
          const targetVer = Number(targetVerStr);
          const vRows = await sql`
            SELECT * FROM prompt_versions WHERE prompt_id = ${promptId} AND version_number = ${targetVer} LIMIT 1
          `;
          if (vRows.length === 0) return errorResponse("Target version not found.", 404);
          await sql`
            UPDATE prompts SET current_version_number = ${targetVer}, current_version_id = ${vRows[0].id}, updated_at = NOW()
            WHERE id = ${promptId}
          `;
          const pRows = await sql`SELECT group_id FROM prompts WHERE id = ${promptId}`;
          const summaries = await buildPromptSummaries(sql, [pRows[0].group_id]);
          return jsonResponse(summaries.find((s) => s.id === promptId));
        }

        // POST /api/prompts/:id/duplicate
        const dupMatch = path.match(/^\/api\/prompts\/([^/]+)\/duplicate$/);
        if (dupMatch && request.method === "POST") {
          const promptId = dupMatch[1];
          const body = await request.json();
          const pRows = await sql`SELECT * FROM prompts WHERE id = ${promptId} LIMIT 1`;
          if (pRows.length === 0) return errorResponse("Prompt not found.", 404);
          const prompt = pRows[0];
          if (body.mode === "move") {
            await sql`
              UPDATE prompts SET group_id = ${body.target_group_id}, title = ${(body.new_title || prompt.title).trim()}, updated_at = NOW()
              WHERE id = ${promptId}
            `;
            const summaries = await buildPromptSummaries(sql, [body.target_group_id]);
            return jsonResponse(summaries.find((s) => s.id === promptId));
          } else {
            const vRows = await sql`
              SELECT * FROM prompt_versions WHERE prompt_id = ${promptId} AND version_number = ${prompt.current_version_number} LIMIT 1
            `;
            const activeV = vRows[0];
            const newPromptId = uuid4();
            const newVerId = uuid4();
            const newTitle = (body.new_title || `${prompt.title} (Copy)`).trim();
            await sql`
              INSERT INTO prompts (id, group_id, title, description, current_version_number, current_version_id, created_by, updated_at, is_archived)
              VALUES (${newPromptId}, ${body.target_group_id}, ${newTitle}, ${prompt.description || ""}, 1, ${newVerId}, ${user.id}, NOW(), FALSE)
            `;
            await sql`
              INSERT INTO prompt_versions (id, prompt_id, version_number, content, variables_json, "change_Note", source_filename, author_id, created_at)
              VALUES (${newVerId}, ${newPromptId}, 1, ${activeV.content}, ${activeV.variables_json}, ${`Duplicated from '${prompt.title}'`}, ${activeV.source_filename}, ${user.id}, NOW())
            `;
            const summaries = await buildPromptSummaries(sql, [body.target_group_id]);
            return jsonResponse(summaries.find((s) => s.id === newPromptId));
          }
        }

        // GET /api/proposals
        if (path === "/api/proposals" && request.method === "GET") {
          const groupIds = await getUserGroupIds(sql, user);
          if (groupIds.length === 0) return jsonResponse([]);
          const rows = await sql`
            SELECT pr.*, p.title AS prompt_title, g.name AS group_name, g.required_approvals, u.name AS proposer_name
            FROM prompt_proposals pr
            JOIN prompts p ON p.id = pr.prompt_id
            JOIN groups g ON g.id = pr.group_id
            LEFT JOIN users u ON u.id = pr.proposer_id
            WHERE pr.group_id = ANY(${groupIds})
            ORDER BY pr.created_at DESC
          `;
          return jsonResponse(await buildProposalResponses(sql, rows));
        }

        // GET & POST /api/prompts/:id/proposals
        const promptPropsMatch = path.match(/^\/api\/prompts\/([^/]+)\/proposals$/);
        if (promptPropsMatch && request.method === "GET") {
          const promptId = promptPropsMatch[1];
          const rows = await sql`
            SELECT pr.*, p.title AS prompt_title, g.name AS group_name, g.required_approvals, u.name AS proposer_name
            FROM prompt_proposals pr
            JOIN prompts p ON p.id = pr.prompt_id
            JOIN groups g ON g.id = pr.group_id
            LEFT JOIN users u ON u.id = pr.proposer_id
            WHERE pr.prompt_id = ${promptId}
            ORDER BY pr.created_at DESC
          `;
          return jsonResponse(await buildProposalResponses(sql, rows));
        }

        if (promptPropsMatch && request.method === "POST") {
          const promptId = promptPropsMatch[1];
          const body = await request.json();
          const pRows = await sql`SELECT * FROM prompts WHERE id = ${promptId} LIMIT 1`;
          if (pRows.length === 0) return errorResponse("Prompt not found.", 404);
          const prompt = pRows[0];
          const propId = uuid4();
          await sql`
            INSERT INTO prompt_proposals (id, prompt_id, group_id, proposer_id, title, description, content, change_note, status, created_at, updated_at)
            VALUES (${propId}, ${promptId}, ${prompt.group_id}, ${user.id}, ${(body.title || prompt.title).trim()}, ${(body.description ?? prompt.description) || ""}, ${body.content}, ${body.change_note || "Proposed edit"}, 'PENDING', NOW(), NOW())
          `;
          const rows = await sql`
            SELECT pr.*, p.title AS prompt_title, g.name AS group_name, g.required_approvals, u.name AS proposer_name
            FROM prompt_proposals pr
            JOIN prompts p ON p.id = pr.prompt_id
            JOIN groups g ON g.id = pr.group_id
            LEFT JOIN users u ON u.id = pr.proposer_id
            WHERE pr.id = ${propId}
          `;
          const built = await buildProposalResponses(sql, rows);
          return jsonResponse(built[0]);
        }

        // POST /api/proposals/:id/approve
        const approveMatch = path.match(/^\/api\/proposals\/([^/]+)\/approve$/);
        if (approveMatch && request.method === "POST") {
          const propId = approveMatch[1];
          const rows = await sql`
            SELECT pr.*, g.required_approvals
            FROM prompt_proposals pr JOIN groups g ON g.id = pr.group_id
            WHERE pr.id = ${propId} LIMIT 1
          `;
          if (rows.length === 0) return errorResponse("Proposal not found.", 404);
          const prop = rows[0];
          if (prop.proposer_id === user.id) {
            return errorResponse("You cannot approve your own review request.", 403);
          }
          await sql`
            INSERT INTO proposal_approvals (id, proposal_id, user_id, created_at)
            VALUES (${uuid4()}, ${propId}, ${user.id}, NOW())
            ON CONFLICT (proposal_id, user_id) DO NOTHING
          `;
          const countRows = await sql`SELECT COUNT(*)::int AS cnt FROM proposal_approvals WHERE proposal_id = ${propId}`;
          const totalApprovals = Number(countRows[0].cnt);
          if (totalApprovals >= Number(prop.required_approvals || 1)) {
            const maxRows = await sql`SELECT COALESCE(MAX(version_number), 0)::int AS max_v FROM prompt_versions WHERE prompt_id = ${prop.prompt_id}`;
            const nextVer = Number(maxRows[0].max_v) + 1;
            const versionId = uuid4();
            const vars = JSON.stringify(extractVariables(prop.content || ""));
            await sql`
              INSERT INTO prompt_versions (id, prompt_id, version_number, content, variables_json, "change_Note", author_id, created_at)
              VALUES (${versionId}, ${prop.prompt_id}, ${nextVer}, ${prop.content}, ${vars}, ${prop.change_note}, ${prop.proposer_id}, NOW())
            `;
            await sql`
              UPDATE prompts
              SET title = ${prop.title}, description = ${prop.description}, current_version_number = ${nextVer}, current_version_id = ${versionId}, updated_at = NOW()
              WHERE id = ${prop.prompt_id}
            `;
            await sql`UPDATE prompt_proposals SET status = 'APPROVED', updated_at = NOW() WHERE id = ${propId}`;
          }
          const updated = await sql`
            SELECT pr.*, p.title AS prompt_title, g.name AS group_name, g.required_approvals, u.name AS proposer_name
            FROM prompt_proposals pr
            JOIN prompts p ON p.id = pr.prompt_id
            JOIN groups g ON g.id = pr.group_id
            LEFT JOIN users u ON u.id = pr.proposer_id
            WHERE pr.id = ${propId}
          `;
          const built = await buildProposalResponses(sql, updated);
          return jsonResponse(built[0]);
        }

        // POST /api/proposals/:id/reject
        const rejectMatch = path.match(/^\/api\/proposals\/([^/]+)\/reject$/);
        if (rejectMatch && request.method === "POST") {
          const propId = rejectMatch[1];
          await sql`UPDATE prompt_proposals SET status = 'REJECTED', updated_at = NOW() WHERE id = ${propId}`;
          const updated = await sql`
            SELECT pr.*, p.title AS prompt_title, g.name AS group_name, g.required_approvals, u.name AS proposer_name
            FROM prompt_proposals pr
            JOIN prompts p ON p.id = pr.prompt_id
            JOIN groups g ON g.id = pr.group_id
            LEFT JOIN users u ON u.id = pr.proposer_id
            WHERE pr.id = ${propId}
          `;
          const built = await buildProposalResponses(sql, updated);
          return jsonResponse(built[0]);
        }

        // GET & POST /api/api-keys
        if (path === "/api/api-keys" && request.method === "GET") {
          const keys = await sql`
            SELECT k.*, g.name AS group_name
            FROM api_keys k LEFT JOIN groups g ON g.id = k.group_id
            WHERE k.user_id = ${user.id} AND k.is_active = TRUE
            ORDER BY k.created_at DESC
          `;
          return jsonResponse(
            keys.map((k) => ({
              id: k.id,
              user_id: k.user_id,
              name: k.name,
              description: k.description || "",
              key_prefix: k.key_prefix,
              scope_type: k.scope_type,
              access_level: k.access_level,
              group_id: k.group_id || null,
              group_name: k.group_name || null,
              is_active: Boolean(k.is_active),
              last_used_at: k.last_used_at,
              created_at: k.created_at,
            }))
          );
        }

        if (path === "/api/api-keys" && request.method === "POST") {
          const body = await request.json();
          const rawKey = `pv_live_${crypto.randomBytes(24).toString("base64url")}`;
          const keyId = uuid4();
          const prefix = maskApiKey(rawKey);
          const keyHash = sha256Hex(rawKey);
          const scopeType = body.scope_type === "GROUP" ? "GROUP" : "GLOBAL";
          const accessLevel = body.access_level === "READ_ONLY" ? "READ_ONLY" : "READ_WRITE";
          const groupId = scopeType === "GROUP" ? body.group_id || null : null;
          const inserted = await sql`
            INSERT INTO api_keys (id, user_id, name, description, key_prefix, key_hash, scope_type, access_level, group_id, is_active, created_at)
            VALUES (${keyId}, ${user.id}, ${(body.name || "Personal API Key").trim()}, ${(body.description || "").trim()}, ${prefix}, ${keyHash}, ${scopeType}, ${accessLevel}, ${groupId}, TRUE, NOW())
            RETURNING *
          `;
          const k = inserted[0];
          return jsonResponse({
            id: k.id,
            user_id: k.user_id,
            name: k.name,
            description: k.description || "",
            key_prefix: k.key_prefix,
            scope_type: k.scope_type,
            access_level: k.access_level,
            group_id: k.group_id || null,
            group_name: null,
            is_active: true,
            last_used_at: null,
            created_at: k.created_at,
            raw_key: rawKey,
          });
        }

        const revokeKeyMatch = path.match(/^\/api\/api-keys\/([^/]+)$/);
        if (revokeKeyMatch && request.method === "DELETE") {
          await sql`DELETE FROM api_keys WHERE id = ${revokeKeyMatch[1]} AND user_id = ${user.id}`;
          return jsonResponse({ status: "revoked" });
        }

        // POST /api/diff-shares
        if (path === "/api/diff-shares" && request.method === "POST") {
          const body = await request.json();
          const shareId = uuid4();
          await sql`
            INSERT INTO shared_diff_links (id, prompt_id, base_version, target_version, diff_granularity, view_mode, created_by, is_revoked, created_at)
            VALUES (${shareId}, ${body.prompt_id}, ${body.base_version}, ${body.target_version}, ${body.diff_granularity || "word"}, ${body.view_mode || "split"}, ${user.id}, FALSE, NOW())
          `;
          const pRows = await sql`
            SELECT p.title, g.name AS group_name FROM prompts p JOIN groups g ON g.id = p.group_id WHERE p.id = ${body.prompt_id}
          `;
          const vRows = await sql`
            SELECT v.*, v."change_Note" AS c_note, u.name AS author_name FROM prompt_versions v LEFT JOIN users u ON u.id = v.author_id
            WHERE v.prompt_id = ${body.prompt_id} AND v.version_number IN (${body.base_version}, ${body.target_version})
          `;
          const vMap = new Map(
            vRows.map((v) => [
              Number(v.version_number),
              {
                id: v.id,
                prompt_id: v.prompt_id,
                version_number: Number(v.version_number),
                content: v.content,
                variables: JSON.parse(v.variables_json || "[]"),
                change_note: v.c_note || "",
                source_filename: v.source_filename || null,
                author_id: v.author_id,
                author_name: v.author_name || "Unknown",
                created_at: v.created_at,
              },
            ])
          );
          return jsonResponse({
            id: shareId,
            prompt_id: body.prompt_id,
            prompt_title: pRows[0]?.title || "Prompt",
            group_name: pRows[0]?.group_name || "Group",
            base_version: Number(body.base_version),
            target_version: Number(body.target_version),
            diff_granularity: body.diff_granularity || "word",
            view_mode: body.view_mode || "split",
            base_version_data: vMap.get(Number(body.base_version)),
            target_version_data: vMap.get(Number(body.target_version)),
            created_at: nowIso(),
          });
        }

        // POST & GET /api/feedback
        if (path === "/api/feedback" && request.method === "POST") {
          const body = await request.json();
          const fbId = uuid4();
          const subject = (body.subject || body.title || "User Feedback").trim();
          const message = (body.message || "").trim();
          const category = (body.category || "complaint").trim().toLowerCase();
          const pageUrl = (body.page_url || body.page_context || "").trim();
          const inserted = await sql`
            INSERT INTO feedback_submissions (id, user_id, reporter_name, reporter_email, category, subject, message, page_url, status, created_at)
            VALUES (${fbId}, ${user.id}, ${user.name}, ${user.email}, ${category}, ${subject}, ${message}, ${pageUrl}, 'OPEN', NOW())
            RETURNING *
          `;
          return jsonResponse(inserted[0], 201);
        }

        if (path === "/api/feedback" && request.method === "GET") {
          const rows = user.is_workspace_admin
            ? await sql`SELECT * FROM feedback_submissions ORDER BY created_at DESC LIMIT 100`
            : await sql`SELECT * FROM feedback_submissions WHERE user_id = ${user.id} ORDER BY created_at DESC LIMIT 50`;
          return jsonResponse(rows);
        }

        return errorResponse(`Route not found: ${request.method} ${path}`, 404);
      } catch (err) {
        return errorResponse(`Edge runtime error: ${err.message || String(err)}`, 500);
      }
    }

    // 3. Static SPA assets (React frontend)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("PromptHold Gateway Active", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    const origin = env.RENDER_ORIGIN || env.BACKEND_POD_1;
    if (origin) {
      try {
        console.log(`[CRON] Keep-alive ping sent to ${origin}/api/health`);
        const resp = await fetch(`${origin}/api/health`, {
          method: "GET",
          headers: { "User-Agent": "PromptHold-KeepAlive-Cron/1.0" },
          signal: AbortSignal.timeout(10000),
        });
        console.log(`[CRON] Keep-alive response status: ${resp.status}`);
      } catch (err) {
        console.warn(`[CRON] Keep-alive error: ${err.message || err}`);
      }
    }
  },
};
