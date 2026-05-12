/**
 * Quelvio MCP server configuration.
 *
 * Reads API URL and key from Cloudflare Workers environment bindings.
 * Detects enterprise vs marketplace mode from the API key prefix.
 */

/** Cloudflare Workers environment bindings. */
export interface Env {
  // ── Backend ─────────────────────────────────────────────────────────
  QUELVIO_API_URL: string;

  // ── Admin fallback (legacy single-key mode, gated by ADMIN_KEY_FALLBACK_ENABLED) ──
  // When ADMIN_KEY_FALLBACK_ENABLED === "true", the auth middleware accepts
  // ``Bearer {QUELVIO_API_KEY}`` as a valid token and routes the request as
  // if the developer had completed an OAuth flow with that key. Off in prod,
  // on for smoke tests. The literal value of QUELVIO_API_KEY must match the
  // bearer token byte-for-byte.
  QUELVIO_API_KEY?: string;
  ADMIN_KEY_FALLBACK_ENABLED?: string;

  // ── OAuth ───────────────────────────────────────────────────────────
  // The canonical issuer URL — used in /.well-known discovery docs and as
  // the ``iss`` claim if we ever switch to JWT-format access tokens. Must
  // match the public URL the MCP client uses (e.g. https://mcp.quelvio.com).
  OAUTH_ISSUER: string;

  // Workers Secret — 32 bytes hex-encoded, used as the AES-GCM key to
  // encrypt API keys at rest in KV. Generated once via:
  //   openssl rand -hex 32
  //   wrangler secret put TOKEN_ENCRYPTION_KEY
  TOKEN_ENCRYPTION_KEY: string;

  // Comma-separated list of additional redirect_uri values to allow beyond
  // the two hardcoded Claude callbacks. Each entry is exact-match (per
  // OAuth 2.1) except localhost which matches any port. Example value:
  //   "https://cursor.sh/api/mcp/auth_callback,http://localhost:*"
  OAUTH_EXTRA_REDIRECT_URIS?: string;

  // ── Clerk-redirect SSO bridge ───────────────────────────────────────
  // /oauth/authorize unconditionally 302s the browser to
  // CLERK_SIGN_IN_URL. After sign-in /oauth/callback exchanges the
  // Clerk session JWT for a per-employee ephemeral API key via
  // /v1/auth/sso-bridge. The ENABLE_CLERK_REDIRECT flag and the
  // legacy paste-an-API-key form have been removed; Clerk redirect
  // is unconditional.
  CLERK_SIGN_IN_URL: string;

  // ── Storage ─────────────────────────────────────────────────────────
  // Cloudflare KV namespace bound in wrangler.toml. Single namespace,
  // prefixed keys: code:{uuid}, token:{uuid}, refresh:{uuid}.
  OAUTH_KV: KVNamespace;
}

/** Whether the API key belongs to an enterprise tenant. */
export function isEnterpriseKey(apiKey: string): boolean {
  return apiKey.startsWith("qlv_ent_");
}

/** Hardcoded MCP-client redirect URIs (always allowed). Exact match. */
export const HARDCODED_REDIRECT_URIS: readonly string[] = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

/** Resolve the full redirect-URI allowlist (hardcoded + env-var extras). */
export function getRedirectUriAllowlist(env: Env): string[] {
  const extras = (env.OAUTH_EXTRA_REDIRECT_URIS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...HARDCODED_REDIRECT_URIS, ...extras];
}

/** Whether a redirect_uri is allowed. Localhost wildcards match any port. */
export function isRedirectUriAllowed(uri: string, env: Env): boolean {
  const allowlist = getRedirectUriAllowlist(env);
  for (const allowed of allowlist) {
    if (allowed === uri) return true;
    // localhost wildcard: "http://localhost:*" matches any port path.
    if (allowed.endsWith(":*")) {
      const prefix = allowed.slice(0, -1); // strip the *
      if (uri.startsWith(prefix)) return true;
    }
  }
  return false;
}

/** Base URL for Quelvio API calls (no trailing slash). */
export function getApiUrl(env: Env): string {
  return (env.QUELVIO_API_URL ?? "https://api.quelvio.com").replace(
    /\/$/,
    "",
  );
}

/** MCP server metadata returned during initialize handshake. */
export const SERVER_INFO = {
  name: "quelvio-mcp",
  version: "1.0.3",
} as const;

/** MCP protocol version (streamable HTTP, spec 2025-03-26). */
export const PROTOCOL_VERSION = "2025-03-26";
