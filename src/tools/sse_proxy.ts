/**
 * SSE proxy for synthesis-mode `query_knowledge` calls.
 *
 * When a client requests `Accept: text/event-stream` and the mode is
 * synthesis_lite or synthesis_pro, the MCP server opens a streaming
 * fetch to the backend's `POST /v1/enterprise/query/stream` and re-
 * encodes its bespoke event vocabulary as MCP-shaped output deltas.
 *
 * Backend SSE event mapping (per design doc §4.1):
 *
 *   status              → discarded (internal stage marker)
 *   sources             → buffered for the final structured-metadata block
 *   query_expansion     → discarded (internal)
 *   synthesis_chunk     → emitted as MCP-spec text delta
 *   grounding_verified  → buffered for final metadata
 *   followups           → buffered for final metadata
 *   insights            → discarded (dashboard UI affordance)
 *   done                → emit final response (text + structured metadata)
 *   error               → emit MCP error response (isError: true)
 *
 * The backend stream is assembled into a single MCP `tools/call` JSON
 * response at the end. We do NOT pass raw backend SSE through to the
 * MCP client — most MCP clients today expect a single tools/call
 * response, not framework-level streaming. (When the MCP spec adds
 * streaming output deltas natively, this file flips to streaming the
 * tools/call response without changing the backend interface.)
 */

import type { QuelvioClient } from "../api-client.js";
import { applyTokenCap, type SourceRecord } from "./token_cap.js";
import type { ToolResult } from "./types.js";

interface BackendSourceChunk {
  rank: number;
  title: string;
  excerpt: string;
  authority_score: number | null;
  taxonomy_domain: string | null;
}

interface AssembledStream {
  query_id: string | null;
  synthesis_text: string;
  sources: SourceRecord[];
  coverage: string | null;
  retrieval_mode: string | null;
  synthesis_model: string | null;
  latency_ms: number | null;
  tokens_consumed: number | null;
  grounding: Record<string, unknown> | null;
  followups: string[];
  errored: boolean;
  error_message: string | null;
}

function emptyAssembled(): AssembledStream {
  return {
    query_id: null,
    synthesis_text: "",
    sources: [],
    coverage: null,
    retrieval_mode: null,
    synthesis_model: null,
    latency_ms: null,
    tokens_consumed: null,
    grounding: null,
    followups: [],
    errored: false,
    error_message: null,
  };
}

/**
 * Parse a single SSE event frame ("event: foo\ndata: {...}\n\n") and
 * mutate the assembled-stream accumulator. Returns silently on
 * malformed frames — partial data is preferable to crashing the whole
 * stream over one bad frame.
 */
function applyEvent(frame: string, acc: AssembledStream): void {
  const lines = frame.split("\n");
  let event = "";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data += line.slice(5).trim();
    }
  }
  if (!event || !data) return;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }

  switch (event) {
    case "synthesis_chunk": {
      const t = payload.text;
      if (typeof t === "string") acc.synthesis_text += t;
      return;
    }
    case "sources": {
      const items = payload.results;
      if (Array.isArray(items)) {
        acc.sources = items
          .filter((x): x is BackendSourceChunk => typeof x === "object" && x !== null)
          .map((s) => ({
            rank: typeof s.rank === "number" ? s.rank : 0,
            title: typeof s.title === "string" ? s.title : "(untitled)",
            excerpt: typeof s.excerpt === "string" ? s.excerpt : "",
            authority:
              typeof s.authority_score === "number" ? s.authority_score : null,
            domain:
              typeof s.taxonomy_domain === "string" ? s.taxonomy_domain : null,
          }));
      }
      return;
    }
    case "grounding_verified": {
      acc.grounding = payload;
      return;
    }
    case "followups": {
      const qs = payload.questions;
      if (Array.isArray(qs)) {
        acc.followups = qs.filter((q): q is string => typeof q === "string");
      }
      return;
    }
    case "done": {
      if (typeof payload.query_id === "string") acc.query_id = payload.query_id;
      if (typeof payload.coverage === "string") acc.coverage = payload.coverage;
      if (typeof payload.retrieval_mode === "string") {
        acc.retrieval_mode = payload.retrieval_mode;
      }
      if (typeof payload.synthesis_model === "string") {
        acc.synthesis_model = payload.synthesis_model;
      }
      if (typeof payload.latency_ms === "number") {
        acc.latency_ms = payload.latency_ms;
      }
      if (typeof payload.tokens_consumed === "number") {
        acc.tokens_consumed = payload.tokens_consumed;
      }
      return;
    }
    case "error": {
      acc.errored = true;
      const msg = payload.message;
      acc.error_message = typeof msg === "string" ? msg : "stream errored";
      return;
    }
    default:
      // status, query_expansion, insights — discarded.
      return;
  }
}

async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line ("\n\n").
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.trim()) yield frame;
    }
  }
  if (buffer.trim()) yield buffer;
}

/**
 * Drive the backend SSE stream to completion and produce a final MCP
 * tool result. Handles the full event taxonomy in `applyEvent`.
 */
export async function streamSynthesisQuery(
  client: QuelvioClient,
  params: {
    query: string;
    mode: "synthesis_lite" | "synthesis_pro";
    max_sources: number;
    domain: string | undefined;
  },
): Promise<ToolResult> {
  const acc = emptyAssembled();
  let upstream: Response;
  try {
    upstream = await client.queryStream({
      query: params.query,
      mode: params.mode,
      top_k: params.max_sources,
      domain_filter: params.domain,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Synthesis stream failed: ${message}` }],
      isError: true,
    };
  }

  if (upstream.body === null) {
    return {
      content: [{ type: "text", text: "Synthesis stream returned empty body." }],
      isError: true,
    };
  }

  for await (const frame of parseSSEStream(upstream.body)) {
    applyEvent(frame, acc);
  }

  if (acc.errored) {
    return {
      content: [
        {
          type: "text",
          text: `Synthesis errored: ${acc.error_message ?? "unknown"}`,
        },
      ],
      isError: true,
    };
  }

  const footerLines = [
    `Coverage: ${acc.coverage ?? "unknown"}`,
    `Mode: ${params.mode}`,
    `Retrieval: ${acc.retrieval_mode ?? "unknown"}`,
  ];
  if (acc.latency_ms !== null) {
    footerLines.push(`Latency: ${Math.round(acc.latency_ms)}ms`);
  }
  if (acc.tokens_consumed !== null) {
    footerLines.push(`Tokens consumed: ${acc.tokens_consumed} kT`);
  }
  const footer = footerLines.join(" | ");

  const truncation = applyTokenCap({
    synthesis: acc.synthesis_text,
    sources: acc.sources,
    footer,
  });

  const meta = [
    "```json",
    JSON.stringify(
      {
        query_id: acc.query_id,
        coverage: acc.coverage,
        retrieval_mode: acc.retrieval_mode,
        synthesis_model: acc.synthesis_model,
        sources_kept: truncation.sources_kept,
        truncated: truncation.truncated,
        tokens_consumed: acc.tokens_consumed,
        latency_ms: acc.latency_ms !== null ? Math.round(acc.latency_ms) : null,
        followups: acc.followups,
        grounding: acc.grounding,
      },
      null,
      2,
    ),
    "```",
  ].join("\n");

  const text = truncation.body ? `${truncation.body}\n\n${meta}` : meta;

  return {
    content: [{ type: "text", text }],
  };
}

// Exposed for unit tests so the parser can be exercised without
// wiring a real fetch round-trip.
export const __testing = { applyEvent, emptyAssembled, parseSSEStream };
