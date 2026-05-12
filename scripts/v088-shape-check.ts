/**
 * v0.8.8 SSO foundation — type-shape regression guard.
 *
 * The MCP server has no runtime test framework today (all current
 * coverage is via the wrangler-dev oauth-smoke-test.ts and backend
 * integration tests). This file exists as a `tsc --noEmit` smoke
 * check: it constructs every new type introduced by v0.8.8 and
 * exercises the new constructor signatures so any future change that
 * breaks the contract surfaces as a typecheck failure rather than a
 * runtime 500.
 *
 * Run via:
 *   ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
 *
 * Coverage:
 *   - AuthContext now carries memberId + email
 *   - StoredAuthCode / StoredAccessToken / StoredRefreshToken carry
 *     member_id + email
 *   - QuelvioClient accepts an optional memberId third argument
 *
 * Runtime tests (KV round-trip, /oauth/callback flow, header
 * propagation against a live backend) are tracked as a follow-up
 * item.
 */

import type { AuthContext } from "../src/auth/middleware.js";
import type {
  StoredAccessToken,
  StoredAuthCode,
  StoredRefreshToken,
} from "../src/auth/storage.js";
import { QuelvioClient } from "../src/api-client.js";

// ── AuthContext shape — Clerk-redirect path ──────────────────────────────
const _ctxOauthClerk: AuthContext = {
  apiKey: "qlv_ent_eph_AAA",
  keyType: "enterprise",
  tenantId: "11111111-1111-1111-1111-111111111111",
  memberId: "22222222-2222-2222-2222-222222222222",
  email: "alice@acme.com",
  source: "oauth",
};

// ── AuthContext shape — admin-fallback smoke path (memberId null) ───
// The legacy ``direct_enterprise`` paste-key path was removed along
// with the legacy paste-key direct-accept code path. Admin fallback
// is the only remaining branch where ``memberId`` is null.
const _ctxAdminFallback: AuthContext = {
  apiKey: "qlv_ent_ADMIN_SMOKE",
  keyType: "enterprise",
  tenantId: null,
  memberId: null,
  email: null,
  source: "admin_fallback",
};

// ── KV payload shapes ───────────────────────────────────────────────────
const _code: StoredAuthCode = {
  encrypted_api_key: "...",
  key_type: "enterprise",
  key_id: "kid",
  tenant_id: "tid",
  member_id: "mid",
  email: "alice@acme.com",
  code_challenge: "challenge",
  code_challenge_method: "S256",
  redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  client_id: "client",
  scope: "mcp:read",
  created_at: 1,
};

const _token: StoredAccessToken = {
  encrypted_api_key: "...",
  key_type: "enterprise",
  key_id: "kid",
  tenant_id: "tid",
  member_id: null, // legacy direct-key path
  email: null,
  client_id: "client",
  scope: "mcp:read",
  created_at: 1,
  expires_at: 2,
  refresh_token_id: null,
};

const _refresh: StoredRefreshToken = {
  encrypted_api_key: "...",
  key_type: "enterprise",
  key_id: "kid",
  tenant_id: "tid",
  member_id: "mid",
  email: "alice@acme.com",
  client_id: "client",
  scope: "mcp:read",
  created_at: 1,
  expires_at: 2,
};

// ── QuelvioClient constructor — three-arg form with memberId ────────────
const _withMember = new QuelvioClient(
  "qlv_ent_eph_AAA",
  "https://api.quelvio.com",
  "22222222-2222-2222-2222-222222222222",
);
const _legacy = new QuelvioClient(
  "qlv_ent_PASTED",
  "https://api.quelvio.com",
);

// Suppress unused-warning noise — these exist to assert shape only.
void _ctxOauthClerk;
void _ctxAdminFallback;
void _code;
void _token;
void _refresh;
void _withMember;
void _legacy;
