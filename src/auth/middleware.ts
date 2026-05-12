/**
 * Bearer token → API key resolution.
 *
 * Called by index.ts at the top of the tools/call branch. Returns either an
 * ``AuthContext`` (success — caller proceeds with the resolved API key) or
 * a ``Response`` (failure — caller returns it as the HTTP response, with
 * the proper WWW-Authenticate header pointing the MCP client at the
 * discovery doc).
 *
 * Two paths in order of precedence:
 *
 *   1. ``Authorization: Bearer {ADMIN_FALLBACK}`` — only when
 *      ``env.ADMIN_KEY_FALLBACK_ENABLED === "true"`` AND the bearer matches
 *      ``env.QUELVIO_API_KEY`` byte-for-byte. Constant-time compare. Used
 *      for smoke tests against a live Worker without going through OAuth.
 *
 *   2. ``Authorization: Bearer {oauth_token}`` — look up the opaque token
 *      in KV (``token:{uuid}``), decrypt the stored API key, return it.
 *
 * The legacy paste-key direct-accept path (``Authorization: Bearer
 * qlv_ent_*`` posted directly without OAuth) was removed. Customers
 * using the legacy paste-key flow must complete the OAuth/Clerk
 * round-trip on first use.
 *
 * Anything else → 401 with WWW-Authenticate.
 */

import type { Env } from "../config.js";
import { decryptApiKey, lookupAccessToken } from "./storage.js";

export interface AuthContext {
  apiKey: string;
  keyType: "marketplace" | "enterprise";
  /** Tenant ID for enterprise keys, ``null`` for marketplace and admin fallback. */
  tenantId: string | null;
  /**
   * Tenant-member ID when the OAuth flow went through the Clerk-
   * redirect bridge (``/oauth/callback`` → ``POST /v1/auth/sso-bridge``).
   * NULL on admin fallback. When present, the QuelvioClient sends
   * ``X-Employee-Id`` so the backend can resolve the actual member's
   * source-permission scope at retrieval time.
   */
  memberId: string | null;
  /** Email of the resolved member; NULL on admin fallback. Telemetry only. */
  email: string | null;
  /** Authentication path that resolved this context — useful for log telemetry. */
  source: "admin_fallback" | "oauth";
}

/**
 * Return either an AuthContext (success) or a 401 Response (failure).
 *
 * The 401 response sets ``WWW-Authenticate: Bearer ...`` per RFC 6750 §3,
 * and includes the resource_metadata URL so MCP clients (which read RFC 9728)
 * can auto-discover the OAuth flow.
 */
export async function requireBearerToken(
  request: Request,
  env: Env,
): Promise<AuthContext | Response> {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return unauthorized(env, "missing_token", "Authorization header required.");
  }
  const token = header.substring(7).trim();
  if (!token) {
    return unauthorized(env, "invalid_token", "Empty bearer token.");
  }

  // ── Path 1: admin fallback ────────────────────────────────────────
  const adminEnabled = env.ADMIN_KEY_FALLBACK_ENABLED === "true";
  const adminKey = env.QUELVIO_API_KEY ?? "";
  if (adminEnabled && adminKey && constantTimeEqual(token, adminKey)) {
    return {
      apiKey: adminKey,
      keyType: adminKey.startsWith("qlv_ent_") ? "enterprise" : "marketplace",
      tenantId: null,
      memberId: null,
      email: null,
      source: "admin_fallback",
    };
  }

  // ── Path 2: OAuth access token ────────────────────────────────────
  const stored = await lookupAccessToken(env, token);
  if (stored === null) {
    return unauthorized(env, "invalid_token", "Token is invalid or expired.");
  }

  // Belt-and-braces expiry check (KV TTL should already evict expired tokens,
  // but a Worker that read the entry immediately before TTL expiry could see
  // a row whose expires_at is in the past).
  const now = Math.floor(Date.now() / 1000);
  if (stored.expires_at < now) {
    return unauthorized(env, "invalid_token", "Token has expired.");
  }

  let plaintext: string;
  try {
    plaintext = await decryptApiKey(stored.encrypted_api_key, env);
  } catch {
    // AES-GCM auth tag mismatch → tampered or wrong encryption key. Treat
    // as token-invalid; do NOT leak the failure reason.
    return unauthorized(env, "invalid_token", "Token is invalid.");
  }

  return {
    apiKey: plaintext,
    keyType: stored.key_type,
    tenantId: stored.tenant_id,
    memberId: stored.member_id,
    email: stored.email,
    source: "oauth",
  };
}

/** Build a 401 Response with WWW-Authenticate per RFC 6750 + RFC 9728. */
function unauthorized(
  env: Env,
  errorCode: string,
  description: string,
): Response {
  const challenge =
    `Bearer realm="quelvio-mcp", ` +
    `error="${errorCode}", ` +
    `error_description="${description}", ` +
    `resource_metadata="${env.OAUTH_ISSUER}/.well-known/oauth-protected-resource"`;
  return new Response(
    JSON.stringify({
      error: errorCode,
      error_description: description,
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": challenge,
        "Cache-Control": "no-store",
      },
    },
  );
}

/** Constant-time string compare — used for the admin-key fallback check. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
