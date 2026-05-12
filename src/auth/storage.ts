/**
 * KV-backed storage for OAuth artifacts.
 *
 * Single namespace, prefixed keys:
 *   code:{uuid}     — pending authorization codes (10-minute TTL, single-use)
 *   token:{uuid}    — issued access tokens (24-hour TTL)
 *   refresh:{uuid}  — issued refresh tokens (30-day TTL)
 *
 * The developer's API key is encrypted with AES-GCM (key from
 * env.TOKEN_ENCRYPTION_KEY) before being written to KV. We never store
 * plaintext API keys at rest. Cloudflare KV is encrypted at rest by AWS,
 * but the AES-GCM layer is defense-in-depth: even if a Worker accidentally
 * dumps a KV value, the leaked bytes are useless without the
 * TOKEN_ENCRYPTION_KEY secret.
 *
 * IV (12 bytes) is randomly generated per write and prepended to the
 * ciphertext, then base64-encoded for KV storage. Decrypt reads it back.
 */

import type { Env } from "../config.js";

// ── TTLs (seconds) ────────────────────────────────────────────────────────

export const CODE_TTL_SECONDS = 600; // 10 minutes
export const ACCESS_TOKEN_TTL_SECONDS = 86400; // 24 hours
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 86400; // 30 days

// ── Stored payload shapes ─────────────────────────────────────────────────

/** Payload stored under code:{uuid} during /oauth/authorize → /oauth/token.
 *
 * ``member_id`` and ``email`` are populated for every normal auth
 * (Clerk-redirect flow at ``/oauth/callback``). The pre-foundation
 * paste-an-API-key flow that wrote NULLs has been removed alongside
 * the legacy paste-key direct-accept code path. The fields are still
 * nullable on the type so the admin-fallback smoke path can mint
 * codes without an employee binding (admin smoke is operator-only,
 * never customer).
 */
export interface StoredAuthCode {
  encrypted_api_key: string;
  key_type: "marketplace" | "enterprise";
  key_id: string;
  tenant_id: string | null;
  member_id: string | null;
  email: string | null;
  code_challenge: string;
  code_challenge_method: string;
  redirect_uri: string;
  client_id: string;
  scope: string;
  created_at: number; // unix seconds
}

/** Payload stored under token:{uuid} after a successful exchange. */
export interface StoredAccessToken {
  encrypted_api_key: string;
  key_type: "marketplace" | "enterprise";
  key_id: string;
  tenant_id: string | null;
  member_id: string | null;
  email: string | null;
  client_id: string;
  scope: string;
  created_at: number;
  expires_at: number;
  refresh_token_id: string | null;
}

/** Payload stored under refresh:{uuid}. */
export interface StoredRefreshToken {
  encrypted_api_key: string;
  key_type: "marketplace" | "enterprise";
  key_id: string;
  tenant_id: string | null;
  member_id: string | null;
  email: string | null;
  client_id: string;
  scope: string;
  created_at: number;
  expires_at: number;
}

// ── Crypto helpers ────────────────────────────────────────────────────────

/** Decode a hex string into bytes. Throws on invalid hex. */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex: odd length");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error("Invalid hex character");
    out[i] = b;
  }
  return out;
}

/** Base64-encode raw bytes. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
}

/** Base64-decode to raw bytes. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/** Import the TOKEN_ENCRYPTION_KEY hex string as a CryptoKey for AES-GCM. */
async function importEncryptionKey(env: Env): Promise<CryptoKey> {
  const rawKey = hexToBytes(env.TOKEN_ENCRYPTION_KEY);
  if (rawKey.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars); got ${rawKey.length}`,
    );
  }
  return crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a plaintext API key for KV storage.
 * Output format: base64( iv (12 bytes) || ciphertext )
 */
export async function encryptApiKey(
  plaintext: string,
  env: Env,
): Promise<string> {
  const key = await importEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    data,
  );
  const out = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), iv.byteLength);
  return bytesToBase64(out);
}

/**
 * Decrypt a stored API key. Throws on tampered ciphertext (AES-GCM auth tag
 * mismatch) — callers should treat any throw as "token invalid, return 401".
 */
export async function decryptApiKey(
  encoded: string,
  env: Env,
): Promise<string> {
  const buf = base64ToBytes(encoded);
  if (buf.byteLength < 13) {
    throw new Error("Encrypted payload too short");
  }
  const iv = buf.slice(0, 12);
  const ciphertext = buf.slice(12);
  const key = await importEncryptionKey(env);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

// ── Random ID generation ──────────────────────────────────────────────────

/** Generate a URL-safe random ID (used for codes / tokens / refresh tokens). */
export function generateOpaqueId(): string {
  return crypto.randomUUID();
}

// ── Authorization codes ───────────────────────────────────────────────────

/** Persist an authorization code in KV. Returns the code string. */
export async function storeAuthCode(
  env: Env,
  payload: StoredAuthCode,
): Promise<string> {
  const code = generateOpaqueId();
  await env.OAUTH_KV.put(`code:${code}`, JSON.stringify(payload), {
    expirationTtl: CODE_TTL_SECONDS,
  });
  return code;
}

/**
 * Atomically read and delete an auth code (single-use enforcement).
 * Returns the payload on success, or null if the code is missing/expired.
 */
export async function consumeAuthCode(
  env: Env,
  code: string,
): Promise<StoredAuthCode | null> {
  const key = `code:${code}`;
  const raw = await env.OAUTH_KV.get(key);
  if (raw === null) return null;
  // KV doesn't expose true atomic read+delete, but at OAuth-flow scale
  // (one auth per developer per day) the race window is microseconds.
  // We delete immediately so a leaked code can't be replayed.
  await env.OAUTH_KV.delete(key);
  try {
    return JSON.parse(raw) as StoredAuthCode;
  } catch {
    return null;
  }
}

// ── Access tokens ─────────────────────────────────────────────────────────

export async function storeAccessToken(
  env: Env,
  payload: StoredAccessToken,
): Promise<string> {
  const token = generateOpaqueId();
  await env.OAUTH_KV.put(`token:${token}`, JSON.stringify(payload), {
    expirationTtl: ACCESS_TOKEN_TTL_SECONDS,
  });
  return token;
}

/** Look up an access token. Returns null if missing or expired. */
export async function lookupAccessToken(
  env: Env,
  token: string,
): Promise<StoredAccessToken | null> {
  const raw = await env.OAUTH_KV.get(`token:${token}`);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as StoredAccessToken;
  } catch {
    return null;
  }
}

/** Delete an access token (logout / revoke). Idempotent. */
export async function revokeAccessToken(
  env: Env,
  token: string,
): Promise<void> {
  await env.OAUTH_KV.delete(`token:${token}`);
}

// ── Refresh tokens ────────────────────────────────────────────────────────

export async function storeRefreshToken(
  env: Env,
  payload: StoredRefreshToken,
): Promise<string> {
  const token = generateOpaqueId();
  await env.OAUTH_KV.put(`refresh:${token}`, JSON.stringify(payload), {
    expirationTtl: REFRESH_TOKEN_TTL_SECONDS,
  });
  return token;
}

/** Look up a refresh token. Returns null if missing or expired. */
export async function lookupRefreshToken(
  env: Env,
  token: string,
): Promise<StoredRefreshToken | null> {
  const raw = await env.OAUTH_KV.get(`refresh:${token}`);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as StoredRefreshToken;
  } catch {
    return null;
  }
}

/** Delete a refresh token. */
export async function revokeRefreshToken(
  env: Env,
  token: string,
): Promise<void> {
  await env.OAUTH_KV.delete(`refresh:${token}`);
}
