/**
 * Sentinel-header detection for the Quelvio v2 strict permission model.
 *
 * Backend PR #643 began emitting `X-Quelvio-Sentinel-Set: closed-v1` on
 * search/retrieval endpoints whenever the requesting tenant is operating
 * under the closed (strict) permission model. SDK consumers need a
 * one-time warning so they understand that results may be filtered.
 *
 * Design notes:
 *   - Idempotent per Worker isolate. We track a module-scoped Set of
 *     observed sentinel values; the first observation logs, subsequent
 *     observations are silent. Cloudflare Workers reuse isolates across
 *     requests on the same instance, so this is effectively "once per
 *     instance" — matching the spec's "once per process" intent while
 *     remaining safe in a multi-tenant Worker (no cross-tenant state).
 *   - No telemetry pipeline exists in this SDK; we emit a structured
 *     console.warn line that `wrangler tail` / CF Logs pick up. When a
 *     telemetry sink is later added, the `quelvio_sentinel_set_detected`
 *     event hook below is where to dispatch.
 *   - We never throw. A header-parse failure must not break the API
 *     call — the warning is a UX nice-to-have, not a correctness gate.
 */

const SENTINEL_HEADER = "X-Quelvio-Sentinel-Set";
const DOCS_URL = "https://docs.quelvio.com/permission-model";

const observed = new Set<string>();

export function resetSentinelStateForTest(): void {
  observed.clear();
}

/**
 * Inspect a fetch `Response` for the strict-mode sentinel header. Logs
 * a warning once per (sentinel value) per process. Safe to call on every
 * response — the dedupe set guarantees a single emission.
 */
export function noteSentinelHeader(res: Response): void {
  try {
    const value = res.headers.get(SENTINEL_HEADER);
    if (!value) return;
    if (observed.has(value)) return;
    observed.add(value);

    // Structured single-line emission so log aggregators can pattern-
    // match on `quelvio_sentinel_set_detected`. Two lines of human-
    // readable copy follow so an operator tailing the log understands
    // what changed.
    console.warn(
      `quelvio_sentinel_set_detected sentinel=${value} docs=${DOCS_URL}`,
    );
    console.warn(
      "Quelvio v2 strict permission mode is active for your tenant.",
    );
    console.warn(
      "Some search results may be filtered to enforce explicit permissions.",
    );
    console.warn(`Learn more: ${DOCS_URL}`);
  } catch {
    // Never let warning-side-effects propagate. The header check is a
    // UX nicety; the API call result is authoritative.
  }
}
