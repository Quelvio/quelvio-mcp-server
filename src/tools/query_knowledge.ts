/**
 * query_knowledge — primary search tool.
 *
 * Calls POST /v1/enterprise/query (one-shot) or POST
 * /v1/enterprise/query/stream (SSE) depending on mode + caller preference.
 * Replaces the v0.x-era quelvio_search tool and absorbs quelvio_synthesize
 * via the `mode` parameter.
 *
 * Token consumption (v0.5 rates; v0.8 Phase A migrates to rate-card lookup):
 *   structured modes (quick / standard / deep): 1 kT
 *   synthesis_lite / synthesis_pro            : 2 kT
 */

import type { ChunkResult, QuelvioClient } from "../api-client.js";
import {
  applyTokenCap,
  type SourceRecord,
} from "./token_cap.js";
import type { ToolDefinition, ToolHandler } from "./types.js";

const VALID_MODES = [
  "quick",
  "standard",
  "deep",
  "synthesis_lite",
  "synthesis_pro",
] as const;

export const queryKnowledgeDefinition: ToolDefinition = {
  name: "query_knowledge",
  description:
    "Search the company's connected knowledge across every source — Drive, " +
    "SharePoint, Confluence, Slack, Notion — with cited answers, lifecycle " +
    "awareness, and refusal-on-weak-context. Returns ranked chunks with " +
    "source attribution, authority scores, and coverage level. Use " +
    "`mode=synthesis_lite` (Qwen3.5 Flash) or `mode=synthesis_pro` " +
    "(Qwen3 Max) for a written answer with [n] citations; use the default " +
    "`standard` for a structured chunk list. `quick` is faster + cheaper, " +
    "`deep` is slower + thorough. Synthesis modes consume more Knowledge " +
    "Tokens than structured modes — pick the cheapest mode that answers " +
    "the question. Responses are capped at 25,000 tokens per Claude " +
    "Connectors policy; if the response is truncated, structured metadata " +
    "carries `truncated: true` and `query_id` so the agent can call " +
    "`get_source_detail` for full provenance.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Natural-language query (1–2000 characters). Be specific — " +
          "results are ranked by authority + relevance, not keyword overlap.",
      },
      mode: {
        type: "string",
        description:
          "quick | standard | deep | synthesis_lite | synthesis_pro. " +
          "Defaults to `standard`. Synthesis modes return a written " +
          "answer with citations; structured modes return chunks only.",
        enum: [...VALID_MODES],
      },
      max_sources: {
        type: "number",
        description:
          "Number of source chunks to return (1–20, default 5). The 25K " +
          "token cap may force fewer results regardless of this value.",
        minimum: 1,
        maximum: 20,
      },
      domain: {
        type: "string",
        description:
          "Optional taxonomy domain filter (e.g. 'engineering.platform'). " +
          "Use `list_domains` to discover valid values for the tenant.",
      },
    },
    required: ["query"],
  },
  annotations: {
    title: "Search company knowledge",
    readOnlyHint: true,
    destructiveHint: false,
    // openWorldHint=true because the tool reaches into the tenant's
    // external content sources (Drive, Slack, etc.) — the agent should
    // be aware that the answer depends on whatever those sources
    // currently contain.
    openWorldHint: true,
    // idempotentHint=true: repeated calls with the same args return the
    // same shape of response. Content drift (Drive edits, new chunks)
    // can change which sources surface, but the operation itself has
    // no side effects.
    idempotentHint: true,
  },
};

function normalizeMode(raw: unknown): string {
  if (typeof raw !== "string") return "standard";
  return (VALID_MODES as readonly string[]).includes(raw) ? raw : "standard";
}

function clampMaxSources(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 5;
  return Math.min(Math.max(Math.floor(raw), 1), 20);
}

function chunkToSource(c: ChunkResult): SourceRecord {
  return {
    rank: c.rank,
    title: c.title,
    excerpt: c.excerpt,
    authority: c.authority_score,
    domain: c.taxonomy_domain,
  };
}

/**
 * Build the structured-metadata block emitted at the end of every
 * response. Agents parse this to extract the query_id (needed for
 * get_source_detail), the truncation flag, and the latency / coverage
 * signals. Format: a fenced JSON block so it survives both the LLM-as-
 * passthrough and any human-in-the-loop rendering.
 */
function metadataBlock(payload: Record<string, unknown>): string {
  return [
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
}

export function createQueryKnowledgeHandler(
  client: QuelvioClient,
): ToolHandler {
  return async (args: Record<string, unknown>) => {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return {
        content: [{ type: "text", text: "Error: query is required." }],
        isError: true,
      };
    }

    const mode = normalizeMode(args.mode);
    const maxSources = clampMaxSources(args.max_sources);
    const domain =
      typeof args.domain === "string" && args.domain.trim()
        ? args.domain.trim()
        : undefined;
    const isSynthesis = mode === "synthesis_lite" || mode === "synthesis_pro";

    try {
      const response = await client.query({
        query,
        top_k: maxSources,
        mode,
        domain_filter: domain,
      });

      const sources = response.results.map(chunkToSource);
      const synthesis = response.synthesis ?? "";

      // Footer carries the metadata an agent or human reader needs to
      // understand the response. The structured JSON block at the end
      // is what agents parse programmatically.
      const footerLines = [
        `Coverage: ${response.coverage}`,
        `Mode: ${mode}`,
        `Retrieval: ${response.retrieval_mode}`,
        `Latency: ${response.latency_ms.toFixed(0)}ms`,
      ];
      if (response.tokens_consumed !== undefined) {
        footerLines.push(`Tokens consumed: ${response.tokens_consumed} kT`);
      }
      if (response.risk_flag?.single_expert_dependency) {
        footerLines.push("⚠️  Single expert dependency");
      }
      const footer = footerLines.join(" | ");

      const truncation = applyTokenCap({
        synthesis: isSynthesis ? synthesis : "",
        sources,
        footer,
      });

      const meta = metadataBlock({
        query_id: response.query_id,
        coverage: response.coverage,
        retrieval_mode: response.retrieval_mode,
        synthesis_model: response.synthesis_model,
        result_count: response.result_count,
        sources_kept: truncation.sources_kept,
        truncated: truncation.truncated,
        tokens_consumed: response.tokens_consumed ?? null,
        latency_ms: Math.round(response.latency_ms),
        risk_flags: response.risk_flag ?? {},
      });

      // ── Structured-mode body ────────────────────────────────────
      // For non-synthesis modes there's no LLM body — produce a
      // formatted chunk list manually (the truncation result already
      // includes a "Sources:" block; we'd duplicate by re-formatting,
      // so use the truncation body directly).
      const text = truncation.body
        ? `${truncation.body}\n\n${meta}`
        : meta;

      const noResults = response.results.length === 0;
      if (noResults) {
        return {
          content: [
            {
              type: "text",
              text:
                `No results found for "${query}".\n` +
                `Coverage: ${response.coverage}\n\n${meta}`,
            },
          ],
        };
      }

      return {
        content: [{ type: "text", text }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Search failed: ${message}` }],
        isError: true,
      };
    }
  };
}
