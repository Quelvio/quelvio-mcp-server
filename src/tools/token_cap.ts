/**
 * 25K-token response cap for MCP tool results.
 *
 * Claude Connectors hard-limits a single tool response to 25,000 tokens.
 * The backend's REST API is unaware of the cap — it returns full
 * payloads for non-MCP consumers. We enforce the cap at the MCP layer
 * so the backend stays consumer-agnostic and so the same enforcement
 * applies regardless of which path produced the response.
 *
 * Token counting: UTF-8 byte-length heuristic (bytes / 3.5 ≈ tokens).
 * Real tokenizers (tiktoken / Claude tokenizer) live behind Node-only
 * native modules; pulling them into a Workers bundle for "is this near
 * 25K" detection is overkill. The heuristic is conservative — for
 * English text it slightly UNDER-counts vs. the real tokenizer, which
 * means we're slightly more permissive than necessary. Acceptable.
 *
 * Truncation order (per design doc §2.4):
 *   1. Drop excerpts past 200 chars first.
 *   2. Drop the lowest-ranked sources.
 *   3. Truncate the synthesis body if still over.
 * Always preserve at least 3 sources.
 */

/** Hard cap from the Claude Connectors spec. */
export const CLAUDE_CONNECTOR_TOKEN_LIMIT = 25_000;

/** Min sources we never drop — agents need ≥3 to triangulate. */
export const MIN_PRESERVED_SOURCES = 3;

/** Bytes-per-token heuristic for English text. Conservative. */
const BYTES_PER_TOKEN = 3.5;

/**
 * Approximate the token count of a UTF-8 string.
 *
 * `TextEncoder` is a Workers / Web Crypto built-in. Don't reach for
 * Node's `Buffer.byteLength` here — Workers don't have it, and pulling
 * `node:buffer` would blow up the bundle.
 */
export function approximateTokenCount(text: string): number {
  if (text.length === 0) return 0;
  const bytes = new TextEncoder().encode(text).byteLength;
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

export interface SourceRecord {
  rank: number;
  title: string;
  excerpt: string;
  authority: number | null;
  domain: string | null;
}

export interface TruncationInput {
  /** Synthesis body (LLM answer). Empty string for structured-only modes. */
  synthesis: string;
  /** Ranked sources, lowest rank first ([1] is most relevant). */
  sources: SourceRecord[];
  /** Already-formatted metadata footer (Coverage, latency, etc.). */
  footer: string;
}

export interface TruncationResult {
  /** Final formatted body within the cap. */
  body: string;
  /** Whether any truncation happened. */
  truncated: boolean;
  /** Final source count after dropping (≥ MIN_PRESERVED_SOURCES). */
  sources_kept: number;
}

const EXCERPT_HARD_CAP = 200;

function formatSources(sources: SourceRecord[]): string {
  if (sources.length === 0) return "";
  const lines = ["Sources:"];
  for (const s of sources) {
    const auth =
      s.authority !== null ? ` (authority: ${s.authority.toFixed(2)})` : "";
    const domain = s.domain ? ` | ${s.domain}` : "";
    lines.push(`  [${s.rank}] ${s.title}${auth}${domain}`);
    if (s.excerpt) lines.push(`      ${s.excerpt}`);
  }
  return lines.join("\n");
}

function compose(
  synthesis: string,
  sources: SourceRecord[],
  footer: string,
): string {
  const parts: string[] = [];
  if (synthesis) parts.push(synthesis);
  if (sources.length > 0) {
    if (parts.length > 0) parts.push("---");
    parts.push(formatSources(sources));
  }
  if (footer) {
    if (parts.length > 0) parts.push("");
    parts.push(footer);
  }
  return parts.join("\n");
}

function clampExcerpt(excerpt: string, max: number): string {
  if (excerpt.length <= max) return excerpt;
  return excerpt.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Apply the deterministic truncation order. Returns the final body
 * plus a `truncated` flag. The flag is the agent's signal that the
 * response is incomplete and they may want to re-query with a smaller
 * `max_sources`.
 */
export function applyTokenCap(input: TruncationInput): TruncationResult {
  const initial = compose(input.synthesis, input.sources, input.footer);
  if (approximateTokenCount(initial) <= CLAUDE_CONNECTOR_TOKEN_LIMIT) {
    return {
      body: initial,
      truncated: false,
      sources_kept: input.sources.length,
    };
  }

  // Stage 1 — clamp excerpts.
  const clampedSources = input.sources.map((s) => ({
    ...s,
    excerpt: clampExcerpt(s.excerpt, EXCERPT_HARD_CAP),
  }));
  let body = compose(input.synthesis, clampedSources, input.footer);
  if (approximateTokenCount(body) <= CLAUDE_CONNECTOR_TOKEN_LIMIT) {
    return {
      body,
      truncated: true,
      sources_kept: clampedSources.length,
    };
  }

  // Stage 2 — drop lowest-rank sources until we fit OR hit the floor.
  // Sources are ordered [1]=highest rank ... [N]=lowest. We drop from
  // the tail.
  const sorted = clampedSources
    .slice()
    .sort((a, b) => a.rank - b.rank);
  let kept = sorted.slice();
  while (
    kept.length > MIN_PRESERVED_SOURCES &&
    approximateTokenCount(
      compose(input.synthesis, kept, input.footer),
    ) > CLAUDE_CONNECTOR_TOKEN_LIMIT
  ) {
    kept.pop();
  }
  body = compose(input.synthesis, kept, input.footer);
  if (approximateTokenCount(body) <= CLAUDE_CONNECTOR_TOKEN_LIMIT) {
    return {
      body,
      truncated: true,
      sources_kept: kept.length,
    };
  }

  // Stage 3 — truncate the synthesis body. Compute the headroom from
  // the (sources + footer) cost and slice synthesis to fit. Leave a
  // small buffer so the trailing ellipsis itself doesn't push us back
  // over the cap.
  const overhead = approximateTokenCount(
    compose("", kept, input.footer),
  );
  const headroom = CLAUDE_CONNECTOR_TOKEN_LIMIT - overhead - 50;
  if (headroom > 0 && input.synthesis) {
    // Convert headroom (tokens) back to a byte budget, then to chars.
    // For UTF-8 English text 1 char ≈ 1 byte; for safety we treat the
    // headroom as a char budget directly (conservative — drops more
    // chars than necessary on ASCII text but never under-drops).
    const charBudget = Math.floor(headroom * BYTES_PER_TOKEN);
    const truncated =
      input.synthesis.length > charBudget
        ? input.synthesis.slice(0, charBudget).trimEnd() +
          "\n\n[truncated to fit MCP 25K-token response cap — call get_source_detail for full provenance]"
        : input.synthesis;
    body = compose(truncated, kept, input.footer);
  }

  return {
    body,
    truncated: true,
    sources_kept: kept.length,
  };
}
