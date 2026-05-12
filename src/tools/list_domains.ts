/**
 * list_domains — discovery surface for taxonomy domains.
 *
 * Calls GET /v1/enterprise/domains. Zero-cost (no Knowledge Token
 * consumption) — agents use this to decide whether the brain has
 * relevant knowledge before issuing a billable `query_knowledge` call.
 *
 * Replaces the v0.x quelvio_topics tool, which called a non-existent
 * /v1/topics endpoint. The new endpoint at /v1/enterprise/domains is
 * a thin projection over the existing knowledge-map service so MCP
 * and the dashboard see identical numbers.
 */

import type { DomainCoverage, QuelvioClient } from "../api-client.js";
import type { ToolDefinition, ToolHandler } from "./types.js";

export const listDomainsDefinition: ToolDefinition = {
  name: "list_domains",
  description:
    "List the taxonomy domains the company has indexed — with document " +
    "counts, expert counts, and coverage levels — so an agent can decide " +
    "whether to query before spending a Knowledge Token. Returns one row " +
    "per domain with the canonical `taxonomy_domain` slug, document/chunk " +
    "counts, expert count, coverage level (expert | partial | none), the " +
    "single_expert risk flag, and the top contributor by authority. Use " +
    "the slug as the `domain` filter on a follow-up `query_knowledge` " +
    "call. Zero Knowledge Tokens consumed.",
  inputSchema: {
    type: "object",
    properties: {
      coverage_filter: {
        type: "string",
        description:
          "Optional comma-separated subset of expert,partial,none. " +
          "Default: all three. Unknown tokens 400.",
      },
    },
    required: [],
  },
  annotations: {
    title: "List indexed domains",
    readOnlyHint: true,
    destructiveHint: false,
    // openWorldHint=false: returns metadata about content already
    // resident in the tenant's index, not external content.
    openWorldHint: false,
    idempotentHint: true,
  },
};

function formatDomain(d: DomainCoverage): string {
  const coverage = d.coverage_level.toUpperCase();
  const docs = `${d.document_count} doc${d.document_count === 1 ? "" : "s"}`;
  const chunks = `${d.chunk_count} chunk${d.chunk_count === 1 ? "" : "s"}`;
  const experts = d.expert_count > 0
    ? ` | ${d.expert_count} expert${d.expert_count === 1 ? "" : "s"}`
    : " | 0 experts";
  const top = d.top_expert
    ? ` | top: ${d.top_expert.name} (${d.top_expert.authority_score.toFixed(2)})`
    : "";
  const risk = d.single_expert ? " | ⚠️  single expert" : "";
  return `  [${coverage}] ${d.taxonomy_domain} — ${docs}, ${chunks}${experts}${top}${risk}`;
}

export function createListDomainsHandler(client: QuelvioClient): ToolHandler {
  return async (args: Record<string, unknown>) => {
    const coverage =
      typeof args.coverage_filter === "string" && args.coverage_filter.trim()
        ? args.coverage_filter.trim()
        : undefined;

    try {
      const response = await client.listDomains(coverage);

      if (response.total === 0) {
        const reason = coverage
          ? `No domains match coverage filter "${coverage}".`
          : "No taxonomy domains indexed yet — has the tenant connected any sources?";
        return {
          content: [{ type: "text", text: reason }],
        };
      }

      const header = coverage
        ? `${response.total} domain${response.total === 1 ? "" : "s"} matching "${coverage}":`
        : `${response.total} domain${response.total === 1 ? "" : "s"} indexed:`;
      const body = response.domains.map(formatDomain).join("\n");

      const meta = [
        "```json",
        JSON.stringify(
          {
            total: response.total,
            coverage_filter: coverage ?? null,
            domains: response.domains.map((d) => ({
              taxonomy_domain: d.taxonomy_domain,
              coverage_level: d.coverage_level,
              document_count: d.document_count,
              chunk_count: d.chunk_count,
              expert_count: d.expert_count,
              single_expert: d.single_expert,
              top_expert_email: d.top_expert?.email ?? null,
              last_content_at: d.last_content_at,
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
      return {
        content: [{ type: "text", text: `list_domains failed: ${message}` }],
        isError: true,
      };
    }
  };
}
