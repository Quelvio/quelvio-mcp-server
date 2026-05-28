/**
 * OAuth 2.1 endpoints for the Quelvio MCP server.
 *
 * Implements the minimum surface required by the MCP spec (2025-03-26):
 *
 *   GET  /.well-known/oauth-protected-resource
 *   GET  /.well-known/oauth-authorization-server
 *   GET  /oauth/authorize       — 302 to Clerk hosted sign-in
 *   GET  /oauth/callback        — Clerk session JWT → ephemeral key + code
 *   POST /oauth/token           — exchange code OR refresh for access token
 *   POST /oauth/revoke          — revoke an access or refresh token
 *
 * The legacy paste-an-API-key flow (POST /oauth/authorize with a
 * CSRF-protected HTML form) and the legacy paste-key direct-accept
 * path were removed. Every MCP user now goes through the Clerk-
 * redirect bridge:
 *
 *   GET /oauth/authorize  →  Clerk hosted sign-in
 *                         →  GET /oauth/callback (with __session JWT)
 *                         →  POST /v1/auth/sso-bridge (mints ephemeral key)
 *                         →  302 back to client redirect_uri with code
 *
 * Storage and PKCE live in storage.ts and pkce.ts; this file is just
 * routing, validation, and HTTP plumbing.
 */

import { type Env, getApiUrl, isRedirectUriAllowed } from "../config.js";
import { verifyPkceChallenge } from "./pkce.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  consumeAuthCode,
  encryptApiKey,
  generateOpaqueId,
  lookupRefreshToken,
  revokeAccessToken,
  revokeRefreshToken,
  storeAccessToken,
  storeAuthCode,
  storeRefreshToken,
} from "./storage.js";

// ── HTTP helpers ──────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function oauthError(
  error: string,
  description: string,
  status = 400,
): Response {
  return jsonResponse({ error, error_description: description }, status);
}

// ── /.well-known/oauth-protected-resource (RFC 9728) ─────────────────────

export function handleProtectedResourceMetadata(env: Env): Response {
  return jsonResponse({
    resource: env.OAUTH_ISSUER,
    authorization_servers: [env.OAUTH_ISSUER],
    bearer_methods_supported: ["header"],
    // v0.8.8 DCR polish — `resource_name` is a non-standard field
    // surfaced by Notion's MCP server and consumed by Anthropic's
    // connector display. Adds operator branding to the consent UI.
    resource_name: "Quelvio MCP",
  });
}

// ── /.well-known/oauth-authorization-server (RFC 8414) ───────────────────

export function handleAuthorizationServerMetadata(env: Env): Response {
  const issuer = env.OAUTH_ISSUER;
  return jsonResponse({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    // Dynamic Client Registration per RFC 7591. Required by Anthropic's
    // custom-connector orchestrator: each Claude Desktop installation
    // registers as a unique OAuth client on first use. Without this
    // endpoint, the orchestrator stalls at "Open Claude" and never
    // reaches /oauth/authorize.
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"], // public clients only
    scopes_supported: ["mcp:read", "mcp:write"],
    // We use DCR, not the OAuth 2.1 + MCP 2025-11-25 CIMD pattern.
    client_id_metadata_document_supported: false,
  });
}

// ── Pending Clerk-redirect state ──────────────────────────────────────────

const PENDING_STATE_TTL_SECONDS = 600; // 10 minutes — same as auth code

/** Pending OAuth-flow state stashed in KV between /oauth/authorize and
 *  /oauth/callback. Carries everything needed to resume the OAuth flow
 *  after the user has authenticated through Clerk.
 */
interface PendingClerkState {
  client_id: string;
  redirect_uri: string;
  state: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: string;
  created_at: number;
}

async function storePendingClerkState(
  env: Env,
  payload: PendingClerkState,
): Promise<string> {
  const id = crypto.randomUUID();
  await env.OAUTH_KV.put(`pending:${id}`, JSON.stringify(payload), {
    expirationTtl: PENDING_STATE_TTL_SECONDS,
  });
  return id;
}

async function consumePendingClerkState(
  env: Env,
  id: string,
): Promise<PendingClerkState | null> {
  const key = `pending:${id}`;
  const raw = await env.OAUTH_KV.get(key);
  if (raw === null) return null;
  await env.OAUTH_KV.delete(key);
  try {
    return JSON.parse(raw) as PendingClerkState;
  } catch {
    return null;
  }
}

/**
 * Read pending Clerk state WITHOUT consuming it.
 *
 * v0.8.8 MCP Phase 2: the frontend bridge page calls /oauth/bridge-meta
 * to render the consent UI ("Authorize Claude Desktop?"). The page must
 * NOT consume the pending_id — only the subsequent /oauth/callback that
 * the user is redirected to should consume it. Any read that
 * accidentally consumed would invalidate the flow before the user
 * clicks Authorize.
 */
async function peekPendingClerkState(
  env: Env,
  id: string,
): Promise<PendingClerkState | null> {
  const raw = await env.OAUTH_KV.get(`pending:${id}`);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PendingClerkState;
  } catch {
    return null;
  }
}

/**
 * Read DCR-registered client metadata without consuming the KV entry.
 *
 * v0.8.8 bridge UX polish: handleBridgeMeta uses this to surface the
 * registered ``client_name`` (e.g. "Claude Desktop", "Cursor") to the
 * frontend bridge page, replacing the generic "an MCP client" fallback
 * in the consent UI.
 *
 * Returns ``null`` when the client_id isn't in KV — pending OAuth flows
 * that arrived without prior DCR (e.g. directory-listed connectors that
 * Anthropic pre-registered out-of-band) are valid and don't need a
 * stored entry. The frontend falls back to a static name table +
 * a generic "An application" fallback.
 */
async function lookupRegisteredClient(
  env: Env,
  clientId: string,
): Promise<RegisteredClient | null> {
  if (!clientId) return null;
  const raw = await env.OAUTH_KV.get(`client:${clientId}`);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as RegisteredClient;
  } catch {
    return null;
  }
}

// ── POST /register (RFC 7591 Dynamic Client Registration) ────────────────

/**
 * TTL for registered client metadata. Matches the refresh-token TTL
 * (30 days) — once the user's refresh chain expires they'd re-register
 * a new client anyway. Cloudflare KV's max TTL is 1 year, but 30 days
 * is the right operational horizon: it bounds dormant-client noise
 * while keeping active installations alive across normal usage gaps.
 */
const REGISTERED_CLIENT_TTL_SECONDS = 30 * 86400;

/** Random opaque client_id. 16 bytes hex = 32 chars, matches Notion's shape. */
function generateClientId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Validate a `redirect_uri` per RFC 7591 §2: must be a valid URI, must
 * use https except for localhost (where http is allowed for dev /
 * loopback flows). MCP clients almost always hand us either an
 * ``https://claude.ai/...`` callback or a ``http://localhost:NNNNN/...``
 * loopback; this validator accepts both and rejects everything else.
 */
function isValidRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:") {
    // Loopback exception per OAuth 2.1 §8.4.2 / RFC 7591 §2 allowance:
    // localhost (any port), 127.0.0.1, ::1.
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]" ||
      parsed.hostname === "::1"
    );
  }
  // Custom-scheme callbacks (e.g. claude://) — Anthropic's connector
  // uses these for desktop-app flows. Accept any non-empty scheme other
  // than file: / data: / javascript:.
  const forbidden = ["file:", "data:", "javascript:"];
  return !!parsed.protocol && !forbidden.includes(parsed.protocol);
}

interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope: string | null;
}

async function storeRegisteredClient(
  env: Env,
  client: RegisteredClient,
): Promise<void> {
  await env.OAUTH_KV.put(`client:${client.client_id}`, JSON.stringify(client), {
    expirationTtl: REGISTERED_CLIENT_TTL_SECONDS,
  });
}

/**
 * RFC 7591 Dynamic Client Registration endpoint.
 *
 * Required by Anthropic's custom-connector orchestrator: each Claude
 * Desktop installation calls this on first use to register itself as
 * a unique OAuth client. Without DCR, the orchestrator can't generate
 * a ``client_id`` and stalls at the "Open Claude" placeholder.
 *
 * Request body (per RFC 7591 §3.1):
 *   {
 *     "redirect_uris": ["https://..."],            // REQUIRED
 *     "client_name": "Claude Desktop",             // optional
 *     "grant_types": ["authorization_code"],       // optional, defaults
 *     "response_types": ["code"],                  // optional, defaults
 *     "token_endpoint_auth_method": "none",        // optional, defaults
 *     "scope": "mcp:read mcp:write"                // optional
 *   }
 *
 * Response (per RFC 7591 §3.2.1) on success, status 201:
 *   {
 *     "client_id": "...",
 *     "client_id_issued_at": <unix>,
 *     "client_name": "...",
 *     "redirect_uris": [...],
 *     "grant_types": [...],
 *     "response_types": [...],
 *     "token_endpoint_auth_method": "...",
 *     "scope": "..."
 *   }
 *
 * Errors (per RFC 7591 §3.2.2):
 *   invalid_redirect_uri   → 400
 *   invalid_client_metadata → 400
 *
 * No authentication required for the registration request itself —
 * registration is open to any caller per OAuth 2.1 + RFC 7591. The
 * registered ``client_id`` is opaque + has no privileges beyond
 * "may invoke /oauth/authorize with this client_id."
 */
export async function handleRegister(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return oauthError(
      "invalid_client_metadata",
      "Request body must be valid JSON.",
      400,
    );
  }

  const redirectUris = body.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    !redirectUris.every((u): u is string => typeof u === "string")
  ) {
    return oauthError(
      "invalid_redirect_uri",
      "redirect_uris MUST be a non-empty array of strings (RFC 7591 §2).",
      400,
    );
  }

  const invalidUri = redirectUris.find((u) => !isValidRedirectUri(u));
  if (invalidUri !== undefined) {
    return oauthError(
      "invalid_redirect_uri",
      `redirect_uri "${invalidUri}" is not a valid URI (must be https, http://localhost*, or a custom-scheme callback).`,
      400,
    );
  }

  const clientName = typeof body.client_name === "string" ? body.client_name : null;
  const grantTypes =
    Array.isArray(body.grant_types) &&
    body.grant_types.every((g): g is string => typeof g === "string")
      ? (body.grant_types as string[])
      : ["authorization_code", "refresh_token"];
  const responseTypes =
    Array.isArray(body.response_types) &&
    body.response_types.every((r): r is string => typeof r === "string")
      ? (body.response_types as string[])
      : ["code"];
  const tokenEndpointAuthMethod =
    typeof body.token_endpoint_auth_method === "string"
      ? body.token_endpoint_auth_method
      : "none";
  const scope = typeof body.scope === "string" ? body.scope : null;

  // We only support public clients ("none") on this server. Reject
  // confidential-client registration requests with the spec error so
  // the caller doesn't proceed thinking they got a working client_secret.
  if (tokenEndpointAuthMethod !== "none") {
    return oauthError(
      "invalid_client_metadata",
      `token_endpoint_auth_method "${tokenEndpointAuthMethod}" is not supported. This server only supports public clients (token_endpoint_auth_method=none).`,
      400,
    );
  }

  const clientId = generateClientId();
  const now = Math.floor(Date.now() / 1000);

  const registered: RegisteredClient = {
    client_id: clientId,
    client_id_issued_at: now,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    scope,
  };

  await storeRegisteredClient(env, registered);

  // RFC 7591 §3.2.1 mandates 201 Created on success with the full
  // registered metadata in the body. Anthropic's orchestrator reads
  // ``client_id`` from this response to construct subsequent
  // /oauth/authorize requests.
  return jsonResponse(registered, 201);
}

// ── GET /oauth/authorize ──────────────────────────────────────────────────

/** Validate OAuth params and 302 the browser to Clerk hosted sign-in.
 *
 * This handler is unconditional. The pre-foundation paste-an-API-key
 * form path (previously gated on ENABLE_CLERK_REDIRECT) is gone along
 * with the legacy paste-key direct-accept path. Customers that
 * previously pasted ``qlv_ent_*`` keys directly into Claude Desktop /
 * Cursor / Notion's MCP UI must complete the OAuth/Clerk round-trip
 * on first use.
 */
export async function handleAuthorizeGet(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const params = url.searchParams;

  const responseType = params.get("response_type") ?? "";
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state") ?? "";
  const scope = params.get("scope") ?? "mcp:read mcp:write";
  const codeChallenge = params.get("code_challenge") ?? "";
  const codeChallengeMethod = params.get("code_challenge_method") ?? "";

  // OAuth 2.1: response_type must be "code".
  if (responseType !== "code") {
    return oauthError(
      "unsupported_response_type",
      "Only response_type=code is supported.",
    );
  }
  if (!clientId) {
    return oauthError("invalid_request", "Missing client_id.");
  }
  if (!redirectUri) {
    return oauthError(
      "invalid_request",
      "Missing redirect_uri.",
    );
  }

  const registeredClient = await lookupRegisteredClient(env, clientId);
  const isRegisteredRedirect =
    registeredClient?.redirect_uris.includes(redirectUri) ?? false;
  if (!isRegisteredRedirect && !isRedirectUriAllowed(redirectUri, env)) {
    return oauthError(
      "invalid_request",
      "redirect_uri is not in the allowlist.",
    );
  }
  // PKCE is mandatory in OAuth 2.1.
  if (!codeChallenge) {
    return oauthError("invalid_request", "Missing code_challenge.");
  }
  if (codeChallengeMethod !== "S256") {
    return oauthError(
      "invalid_request",
      "code_challenge_method must be S256.",
    );
  }

  if (!env.CLERK_SIGN_IN_URL) {
    return oauthError(
      "server_error",
      "CLERK_SIGN_IN_URL is unset on this Worker.",
      500,
    );
  }
  const pendingId = await storePendingClerkState(env, {
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    created_at: Math.floor(Date.now() / 1000),
  });
  // v0.8.8 MCP Phase 2: `CLERK_SIGN_IN_URL` is the bridge page at
  // enterprise.quelvio.com/oauth/bridge — NOT Clerk's hosted sign-in
  // page directly. The bridge page reads ``pending_id`` from its own
  // query params, runs the consent UI ("Authorize Claude Desktop?"),
  // and 302s to /oauth/callback itself with both ``pending_id`` and
  // ``__session`` (the Clerk JWT). So the worker only needs to thread
  // ``pending_id`` through to the bridge — no nested ``redirect_url``.
  // The pre-Phase-2 design assumed CLERK_SIGN_IN_URL pointed at Clerk's
  // own hosted-sign-in URL which bounces back to ``redirect_url`` after
  // auth; that pattern is no longer in use.
  const bridgeUrl = new URL(env.CLERK_SIGN_IN_URL);
  bridgeUrl.searchParams.set("pending_id", pendingId);
  return new Response(null, {
    status: 302,
    headers: {
      Location: bridgeUrl.toString(),
      "Cache-Control": "no-store",
    },
  });
}

// ── GET /oauth/callback (Clerk-redirect bridge) ───────────────────────────

/** Backend response shape for ``POST /v1/auth/sso-bridge``. */
interface SsoBridgeResponse {
  tenant_id: string;
  member_id: string;
  email: string;
  name: string;
  role: string;
  scope: "read" | "write";
  ephemeral_api_key: string;
  ephemeral_api_key_id: string;
  expires_at: string;
}

/**
 * Forward a Clerk session JWT to the backend's SSO-bridge endpoint.
 * On 200 returns the bridge payload; on any error returns ``null``
 * (the caller redirects the user to an error page).
 */
async function callSsoBridge(
  clerkJwt: string,
  env: Env,
): Promise<SsoBridgeResponse | null> {
  const url = `${getApiUrl(env)}/v1/auth/sso-bridge`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clerkJwt}`,
        "Content-Type": "application/json",
      },
    });
  } catch {
    return null;
  }
  if (!res.ok) {
    return null;
  }
  try {
    return (await res.json()) as SsoBridgeResponse;
  } catch {
    return null;
  }
}

/**
 * Resume an OAuth flow after the user has authenticated through Clerk.
 *
 * Expects two query parameters on the redirect:
 *   - ``pending_id``: opaque ID issued by /oauth/authorize (KV lookup)
 *   - ``__session``:  Clerk session JWT (Clerk's hosted-redirect format)
 *
 * On success: mints an OAuth auth code in KV (with member_id + email
 * captured from the SSO bridge) and 302s the browser to the original
 * client redirect_uri with ``code`` + ``state``.
 *
 * On failure: 4xx with a plain-text error. Production deployments
 * should layer a friendly error-page renderer over this — kept terse
 * here to keep the auth-critical path focused.
 */
export async function handleAuthorizeCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const pendingId = url.searchParams.get("pending_id") ?? "";
  // Clerk passes the session JWT as ``__session`` on hosted-sign-in
  // redirects. Some Clerk configurations use a different name; allow
  // a fallback for forward-compatibility.
  const clerkJwt =
    url.searchParams.get("__session") ??
    url.searchParams.get("session_token") ??
    "";

  if (!pendingId || !clerkJwt) {
    return oauthError(
      "invalid_request",
      "Missing pending_id or session token from Clerk redirect.",
    );
  }

  const pending = await consumePendingClerkState(env, pendingId);
  if (pending === null) {
    return oauthError(
      "invalid_grant",
      "Pending auth state is missing or expired. Restart the OAuth flow.",
    );
  }

  const bridge = await callSsoBridge(clerkJwt, env);
  if (bridge === null) {
    return oauthError(
      "access_denied",
      "Quelvio could not bridge this Clerk session to a tenant member.",
      401,
    );
  }

  // Mint the auth code with full per-employee identity baked in.
  const encryptedApiKey = await encryptApiKey(bridge.ephemeral_api_key, env);
  const code = await storeAuthCode(env, {
    encrypted_api_key: encryptedApiKey,
    key_type: "enterprise",
    key_id: bridge.ephemeral_api_key_id,
    tenant_id: bridge.tenant_id,
    member_id: bridge.member_id,
    email: bridge.email,
    code_challenge: pending.code_challenge,
    code_challenge_method: pending.code_challenge_method,
    redirect_uri: pending.redirect_uri,
    client_id: pending.client_id,
    scope: pending.scope,
    created_at: Math.floor(Date.now() / 1000),
  });

  const redirectUrl = new URL(pending.redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (pending.state) redirectUrl.searchParams.set("state", pending.state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectUrl.toString(),
      "Cache-Control": "no-store",
    },
  });
}

// ── GET /oauth/bridge-meta (v0.8.8 MCP Phase 2) ───────────────────────────

/**
 * Read pending OAuth-flow metadata for the frontend bridge page.
 *
 * The frontend bridge page at enterprise.quelvio.com/oauth/bridge calls
 * this endpoint to render the consent UI:
 *
 *   "Authorize Claude Desktop to access Quelvio?"
 *
 * Returns ``client_id``, ``redirect_uri``, and ``expires_at`` derived
 * from the pending KV entry. Does NOT consume the pending_id — that
 * happens only at /oauth/callback after the user clicks Authorize.
 *
 * Public CORS — same shape as ``/.well-known/oauth-protected-resource``.
 * Authentication is the pending_id itself, which is opaque + short-lived
 * (10min TTL). An attacker who guesses or intercepts a pending_id can
 * read these three metadata fields but cannot mint a code or token —
 * the /oauth/callback handler still requires a valid Clerk JWT.
 */
export async function handleBridgeMeta(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const pendingId = url.searchParams.get("pending_id") ?? "";
  if (!pendingId) {
    return new Response(
      JSON.stringify({
        error: "missing_pending_id",
        error_description: "pending_id query parameter is required.",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      },
    );
  }
  const pending = await peekPendingClerkState(env, pendingId);
  if (pending === null) {
    return new Response(
      JSON.stringify({
        error: "not_found",
        error_description:
          "Pending authorization is missing or expired. Restart from your MCP client.",
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      },
    );
  }
  // v0.8.8 bridge UX polish: surface the DCR-registered ``client_name``
  // when the pending flow's ``client_id`` matches a previously-registered
  // client. The frontend bridge page renders this in the consent UI
  // copy ("Claude Desktop is asking to access ..."). Falls back to
  // ``null`` for OAuth flows that arrived without prior DCR — the
  // frontend then resolves a static name from a known-IDs table OR
  // displays the generic "An application" fallback.
  const registered = await lookupRegisteredClient(env, pending.client_id);
  return new Response(
    JSON.stringify({
      client_id: pending.client_id,
      client_name: registered?.client_name ?? null,
      redirect_uri: pending.redirect_uri,
      expires_at: pending.created_at + PENDING_STATE_TTL_SECONDS,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    },
  );
}

// ── POST /oauth/token ─────────────────────────────────────────────────────

/** Exchange an authorization code OR a refresh token for an access token. */
export async function handleToken(
  request: Request,
  env: Env,
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError(
      "invalid_request",
      "Body must be application/x-www-form-urlencoded.",
    );
  }

  const grantType = (form.get("grant_type") ?? "").toString();

  if (grantType === "authorization_code") {
    return handleAuthCodeGrant(form, env);
  }
  if (grantType === "refresh_token") {
    return handleRefreshGrant(form, env);
  }
  return oauthError(
    "unsupported_grant_type",
    "Supported grant_type values: authorization_code, refresh_token.",
  );
}

async function handleAuthCodeGrant(
  form: FormData,
  env: Env,
): Promise<Response> {
  const code = (form.get("code") ?? "").toString();
  const redirectUri = (form.get("redirect_uri") ?? "").toString();
  const clientId = (form.get("client_id") ?? "").toString();
  const codeVerifier = (form.get("code_verifier") ?? "").toString();

  if (!code || !codeVerifier || !redirectUri || !clientId) {
    return oauthError(
      "invalid_request",
      "Missing one of: code, code_verifier, redirect_uri, client_id.",
    );
  }

  const stored = await consumeAuthCode(env, code);
  if (stored === null) {
    return oauthError(
      "invalid_grant",
      "Authorization code is invalid, expired, or already used.",
    );
  }

  // Bind the code to the client + redirect_uri it was issued for.
  if (stored.client_id !== clientId) {
    return oauthError(
      "invalid_grant",
      "client_id does not match the one used in /oauth/authorize.",
    );
  }
  if (stored.redirect_uri !== redirectUri) {
    return oauthError(
      "invalid_grant",
      "redirect_uri does not match the one used in /oauth/authorize.",
    );
  }

  // Verify PKCE.
  const ok = await verifyPkceChallenge(
    codeVerifier,
    stored.code_challenge,
    stored.code_challenge_method,
  );
  if (!ok) {
    return oauthError("invalid_grant", "PKCE verification failed.");
  }

  // Mint access + refresh tokens. Both store the same encrypted API key.
  const now = Math.floor(Date.now() / 1000);
  const refreshTokenId = generateOpaqueId();

  const refreshToken = await storeRefreshToken(env, {
    encrypted_api_key: stored.encrypted_api_key,
    key_type: stored.key_type,
    key_id: stored.key_id,
    tenant_id: stored.tenant_id,
    member_id: stored.member_id,
    email: stored.email,
    client_id: stored.client_id,
    scope: stored.scope,
    created_at: now,
    expires_at: now + REFRESH_TOKEN_TTL_SECONDS,
  });

  const accessToken = await storeAccessToken(env, {
    encrypted_api_key: stored.encrypted_api_key,
    key_type: stored.key_type,
    key_id: stored.key_id,
    tenant_id: stored.tenant_id,
    member_id: stored.member_id,
    email: stored.email,
    client_id: stored.client_id,
    scope: stored.scope,
    created_at: now,
    expires_at: now + ACCESS_TOKEN_TTL_SECONDS,
    refresh_token_id: refreshTokenId,
  });

  return jsonResponse({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: stored.scope,
  });
}

async function handleRefreshGrant(
  form: FormData,
  env: Env,
): Promise<Response> {
  const refreshToken = (form.get("refresh_token") ?? "").toString();
  const clientId = (form.get("client_id") ?? "").toString();

  if (!refreshToken || !clientId) {
    return oauthError(
      "invalid_request",
      "Missing one of: refresh_token, client_id.",
    );
  }

  const stored = await lookupRefreshToken(env, refreshToken);
  if (stored === null) {
    return oauthError(
      "invalid_grant",
      "Refresh token is invalid or expired.",
    );
  }

  // Bind the refresh token to the client_id it was issued for.
  if (stored.client_id !== clientId) {
    return oauthError(
      "invalid_grant",
      "client_id does not match the refresh token's owner.",
    );
  }

  // Belt-and-braces expiry check.
  const now = Math.floor(Date.now() / 1000);
  if (stored.expires_at < now) {
    return oauthError("invalid_grant", "Refresh token has expired.");
  }

  // Refresh-token rotation: invalidate the old refresh token, mint a new
  // pair. Mirrors the auth_code-grant logic in handleAuthCodeGrant.
  await revokeRefreshToken(env, refreshToken);
  const newRefreshTokenId = generateOpaqueId();

  const newRefreshToken = await storeRefreshToken(env, {
    encrypted_api_key: stored.encrypted_api_key,
    key_type: stored.key_type,
    key_id: stored.key_id,
    tenant_id: stored.tenant_id,
    member_id: stored.member_id,
    email: stored.email,
    client_id: stored.client_id,
    scope: stored.scope,
    created_at: now,
    expires_at: now + REFRESH_TOKEN_TTL_SECONDS,
  });

  const newAccessToken = await storeAccessToken(env, {
    encrypted_api_key: stored.encrypted_api_key,
    key_type: stored.key_type,
    key_id: stored.key_id,
    tenant_id: stored.tenant_id,
    member_id: stored.member_id,
    email: stored.email,
    client_id: stored.client_id,
    scope: stored.scope,
    created_at: now,
    expires_at: now + ACCESS_TOKEN_TTL_SECONDS,
    refresh_token_id: newRefreshTokenId,
  });

  return jsonResponse({
    access_token: newAccessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: newRefreshToken,
    scope: stored.scope,
  });
}

// ── POST /oauth/revoke ────────────────────────────────────────────────────

/** Revoke an access or refresh token. Returns 200 even if the token was unknown
 *  (RFC 7009 §2.2: revocation must not leak token validity). */
export async function handleRevoke(
  request: Request,
  env: Env,
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError(
      "invalid_request",
      "Body must be application/x-www-form-urlencoded.",
    );
  }

  const token = (form.get("token") ?? "").toString();
  const tokenTypeHint = (form.get("token_type_hint") ?? "").toString();

  if (!token) {
    return oauthError("invalid_request", "Missing token.");
  }

  // We don't trust the hint — try both. KV deletes are idempotent, so
  // calling delete on a missing key is a no-op. The hint just dictates
  // which lookup we attempt first to avoid one extra round-trip.
  if (tokenTypeHint === "refresh_token") {
    await revokeRefreshToken(env, token);
    await revokeAccessToken(env, token);
  } else {
    await revokeAccessToken(env, token);
    await revokeRefreshToken(env, token);
  }

  // RFC 7009: 200 OK with empty body, regardless of whether the token existed.
  return new Response(null, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
