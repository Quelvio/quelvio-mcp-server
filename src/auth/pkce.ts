/**
 * PKCE (Proof Key for Code Exchange, RFC 7636) verification.
 *
 * The MCP client generates:
 *   code_verifier  = random URL-safe string (43–128 chars)
 *   code_challenge = base64url(sha256(code_verifier))
 *
 * On /oauth/authorize the client sends ``code_challenge`` (we store it).
 * On /oauth/token the client sends ``code_verifier`` (we verify it produces
 * the stored challenge). This proves the same client that started the
 * authorization is the one redeeming the code, even if the auth code itself
 * leaks via the redirect URL or browser history.
 *
 * We only support ``S256`` — ``plain`` is forbidden by OAuth 2.1.
 */

/** Base64url-encode bytes (no padding, URL-safe alphabet). */
function base64UrlEncode(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < u8.byteLength; i++) {
    bin += String.fromCharCode(u8[i]!);
  }
  // btoa is available in Workers globally.
  return btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Compute the S256 code_challenge for a verifier.
 * Returns base64url(sha256(verifier)).
 */
export async function computeS256Challenge(
  verifier: string,
): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(digest);
}

/**
 * Verify a PKCE code_verifier against a stored challenge.
 *
 * - Returns ``true`` if the verifier produces the challenge under S256.
 * - Returns ``false`` for any mismatch, unsupported method, or invalid input.
 *
 * Comparison is constant-time to prevent timing side channels.
 */
export async function verifyPkceChallenge(
  verifier: string,
  challenge: string,
  method: string | undefined,
): Promise<boolean> {
  // OAuth 2.1: only S256 is permitted. Reject "plain" and unknown methods.
  if (method !== "S256") return false;

  // RFC 7636 §4.1: verifier MUST be 43–128 chars from the unreserved set.
  if (verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;

  const computed = await computeS256Challenge(verifier);
  return constantTimeEqual(computed, challenge);
}

/** Constant-time string comparison — prevents timing attacks on the challenge. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
