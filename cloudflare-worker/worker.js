// PromptFolders edge gateway: a thin proxy in front of the Render backend.
//
// All auth, RBAC, rate limiting and CORS decisions live in the FastAPI backend. The gateway only forwards
// backend routes (passing the public host so OAuth metadata advertises this origin), serves the SPA assets,
// and pings the backend every 14 minutes so the Render free instance stays warm.

const BACKEND_PREFIXES = ["/api/", "/mcp", "/sse", "/oauth/", "/.well-known/", "/share/"];
// Long enough to ride out a Render free-tier cold start (~30-60s); waiting on fetch does not use Worker CPU time.
const UPSTREAM_TIMEOUT_MS = 90_000;

function isBackendRoute(path) {
  return BACKEND_PREFIXES.some((prefix) => path.startsWith(prefix));
}

async function proxyToBackend(request, env, url) {
  const upstreamUrl = new URL(url.pathname + url.search, env.RENDER_ORIGIN);
  const headers = new Headers(request.headers);
  headers.set("X-Forwarded-Host", url.host);
  headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
  // Render sees the Worker's egress IP, so pass the real client IP, authenticated by a shared secret.
  headers.delete("X-Gateway-Secret");
  headers.delete("X-Client-IP");
  if (env.GATEWAY_SECRET) {
    headers.set("X-Gateway-Secret", env.GATEWAY_SECRET);
    headers.set("X-Client-IP", request.headers.get("CF-Connecting-IP") || "");
  }
  try {
    return await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return new Response(JSON.stringify({ detail: "PromptFolders is starting up. Please retry in a few seconds." }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": "10" },
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (isBackendRoute(url.pathname)) {
      return proxyToBackend(request, env, url);
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("PromptFolders Gateway Active", { status: 200 });
  },

  async scheduled(event, env) {
    try {
      await fetch(`${env.RENDER_ORIGIN}/api/health`, {
        headers: { "User-Agent": "PromptFolders-KeepAlive-Cron/1.0" },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      console.warn(`[CRON] Keep-alive error: ${err.message || err}`);
    }
  },
};
