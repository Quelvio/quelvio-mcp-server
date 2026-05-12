/**
 * get_source_detail — chunk-level provenance for a previous query.
 *
 * Calls GET /v1/enterprise/sources/:query_id. The query_id comes from
 * a prior `query_knowledge` response's structured-metadata block.
 *
 * Use cases:
 *   - Verify a citation: "what document did chunk [3] come from?"
 *   - Surface lifecycle state to a downstream system (live | stale |
 *     superseded | user_deleted).
 *   - Check the embedding timestamp + model — useful when reconciling
 *     cosine-similarity numbers across migrations.
 *
 * Cross-tenant access returns 404 (not 403) by design — no info leak.
 * Zero Knowledge Tokens consumed.
 */

import type { QuelvioClient, SourceChunk } from "../api-client.js";
import type { ToolDefinition, ToolHandler } from "./types.js";

export const getSourceDetailDefinition: ToolDefinition = {
  name: "get_source_detail",
  description:
    "Return per-chunk source provenance for a previous query — document " +
    "path, lifecycle state, embedding timestamp, contributor, last-updated " +
    "— useful for verifying a citation or surfacing trust signals to a " +
    "downstream system. Pass a `query_id` returned by an earlier " +
    "`query_knowledge` call. Returns 404 if the query_id is unknown OR " +
    "belongs to a different tenant (indistinguishable to prevent info-" +
    "leak). Zero Knowledge Tokens consumed.",
  inputSchema: {
    type: "object",
    properties: {
      query_id: {
        type: "string",
        description:
          "UUID returned in the structured-metadata block of a prior " +
          "`query_knowledge` response. Tenant-scoped — cross-tenant 404.",
      },
    },
    required: ["query_id"],
  },
  annotations: {
    title: "Get source detail",
    readOnlyHint: true,
    destructiveHint: false,
    // openWorldHint=false: provenance lookup against indexed metadata
    // only; doesn't reach into the live external sources.
    openWorldHint: false,
    idempotentHint: true,
  },
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatChunk(c: SourceChunk): string {
  const parts = [
    `  [${c.title}]`,
    `    chunk_id: ${c.chunk_id}`,
    `    lifecycle: ${c.lifecycle_state}`,
  ];
  if (c.source_url) parts.push(`    source: ${c.source_url}`);
  if (c.author_name) {
    const dept = c.department ? ` (${c.department})` : "";
    parts.push(`    author: ${c.author_name}${dept}`);
  }
  if (c.last_source_updated_at) {
    parts.push(`    last_updated: ${c.last_source_updated_at}`);
  }
  if (c.embedded_at) {
    const model = c.embedding_model ? ` via ${c.embedding_model}` : "";
    parts.push(`    embedded: ${c.embedded_at}${model}`);
  }
  if (c.taxonomy_domain) parts.push(`    domain: ${c.taxonomy_domain}`);
  if (c.authority_score !== null) {
    parts.push(`    authority: ${c.authority_score.toFixed(2)}`);
  }
  if (c.excerpt) parts.push(`    excerpt: ${c.excerpt}`);
  return parts.join("\n");
}

export function createGetSourceDetailHandler(
  client: QuelvioClient,
): ToolHandler {
  return async (args: Record<string, unknown>) => {
    const queryId =
      typeof args.query_id === "string" ? args.query_id.trim() : "";
    if (!queryId) {
      return {
        content: [{ type: "text", text: "Error: query_id is required." }],
        isError: true,
      };
    }
    if (!UUID_RE.test(queryId)) {
      return {
        content: [
          {
            type: "text",
            text: "Error: query_id must be a UUID returned by a prior query_knowledge call.",
          },
        ],
        isError: true,
      };
    }

    try {
      const response = await client.getSourceDetail(queryId);

      if (response.chunk_count === 0) {
        return {
          content: [
            {
              type: "text",
              text: `query_id ${queryId} returned no chunks (query may have predated the v0.7 provenance invariant).`,
            },
          ],
        };
      }

      const header = `${response.chunk_count} chunk${
        response.chunk_count === 1 ? "" : "s"
      } for query_id ${queryId}:`;
      const body = response.chunks.map(formatChunk).join("\n\n");

      const meta = [
        "```json",
        JSON.stringify(
          {
            query_id: response.query_id,
            chunk_count: response.chunk_count,
            chunks: response.chunks.map((c) => ({
              chunk_id: c.chunk_id,
              content_piece_id: c.content_piece_id,
              source_url: c.source_url,
              source_type: c.source_type,
              lifecycle_state: c.lifecycle_state,
              embedded_at: c.embedded_at,
              embedding_model: c.embedding_model,
              last_source_updated_at: c.last_source_updated_at,
              authority_score: c.authority_score,
              taxonomy_domain: c.taxonomy_domain,
              author_email: c.author_email,
              department: c.department,
            })),
          },
          null,
          2,
        ),
        "```",
      ].join("\n");

      return {
        content: [{ type: "text", text: `${header}\n\n${body}\n\n${meta}` }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Backend 404s for cross-tenant + missing + pre-v0.7-provenance —
      // surface a single message that doesn't disambiguate the cases.
      if (message.includes("404")) {
        return {
          content: [
            {
              type: "text",
              text: `query_id ${queryId} not found.`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: `get_source_detail failed: ${message}` }],
        isError: true,
      };
    }
  };
}
