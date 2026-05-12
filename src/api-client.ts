/**
 * HTTP client for the Quelvio enterprise REST API.
 *
 * Constructor takes an explicit apiKey + baseUrl + optional memberId so
 * each MCP request can use the API key resolved from its OAuth bearer
 * token, plus the employee binding captured during the OAuth flow.
 *
 * Header convention:
 *   X-API-Key          — matches the backend's auth dependency.
 *   X-Quelvio-Source   — origin label "mcp" — flows into the audit log so
 *                        MCP-originating queries are distinguishable from
 *                        dashboard / Slack / etc.
 *   X-Employee-Id      — per-employee scoping when the OAuth flow captured
 *                        a member binding. The backend uses this to scope
 *                        permission filtering to the actual querying
 *                        employee instead of falling through to tenant-
 *                        level access. Omitted when memberId is null
 *                        (admin fallback path only).
 *
 * Endpoints called:
 *   POST /v1/enterprise/query         — one-shot search
 *   POST /v1/enterprise/query/stream  — SSE synthesis stream
 *   GET  /v1/enterprise/domains       — taxonomy discovery
 *   GET  /v1/enterprise/sources/:id   — per-chunk provenance
 */

const SOURCE_HEADER_VALUE = "mcp";

// ── Request / Response types ──────────────────────────────────────────────

export interface QueryParams {
  query: string;
  top_k?: number;
  mode?: string;
  domain_filter?: string;
}

export interface ChunkResult {
  chunk_id: string;
  content_piece_id: string;
  creator_id?: string;
  title: string;
  excerpt: string;
  score: number;
  authority_score: number | null;
  taxonomy_domain: string | null;
  rank: number;
  author_name?: string | null;
  author_email?: string | null;
  department?: string | null;
  source_url?: string | null;
}

export interface QueryResponse {
  query: string;
  query_id: string;
  results: ChunkResult[];
  result_count: number;
  coverage: string;
  risk_flag: Record<string, boolean>;
  retrieval_mode: string;
  synthesis: string | null;
  synthesis_model: string | null;
  latency_ms: number;
  tokens_consumed?: number;
}

export interface DomainCoverage {
  taxonomy_domain: string;
  document_count: number;
  chunk_count: number;
  expert_count: number;
  coverage_level: string;
  single_expert: boolean;
  top_expert: {
    email: string;
    name: string;
    department: string | null;
    document_count: number;
    authority_score: number;
  } | null;
  consistency_score: number | null;
  unanswered_query_count: number;
  last_content_at: string | null;
}

export interface DomainsListResponse {
  domains: DomainCoverage[];
  total: number;
}

export interface SourceChunk {
  chunk_id: string;
  content_piece_id: string;
  title: string;
  excerpt: string;
  source_url: string | null;
  source_type: string | null;
  lifecycle_state: string;
  embedded_at: string | null;
  embedding_model: string | null;
  last_source_updated_at: string | null;
  authority_score: number | null;
  taxonomy_domain: string | null;
  author_name: string | null;
  author_email: string | null;
  department: string | null;
}

export interface SourceDetailResponse {
  query_id: string;
  tenant_id: string;
  chunks: SourceChunk[];
  chunk_count: number;
}

// ── API client ────────────────────────────────────────────────────────────

export class QuelvioClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly memberId: string | null;

  constructor(
    apiKey: string,
    baseUrl: string,
    memberId: string | null = null,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.memberId = memberId;
  }

  /**
   * Build request headers. Always includes Content-Type, X-API-Key, and
   * X-Quelvio-Source. Conditionally adds X-Employee-Id when the OAuth
   * flow captured a member binding (memberId set on the constructor).
   */
  private headers(extra?: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {
      "Content-Type": "application/json",
      "X-API-Key": this.apiKey,
      "X-Quelvio-Source": SOURCE_HEADER_VALUE,
      ...(extra ?? {}),
    };
    if (this.memberId) {
      out["X-Employee-Id"] = this.memberId;
    }
    return out;
  }

  /** Send a one-shot query (structured or synthesis) to the Quelvio API. */
  async query(params: QueryParams): Promise<QueryResponse> {
    const body: Record<string, unknown> = {
      query: params.query,
      limit: params.top_k ?? 5,
      mode: params.mode ?? "standard",
    };
    if (params.domain_filter) {
      body.domain_filter = params.domain_filter;
    }

    const res = await fetch(`${this.baseUrl}/v1/enterprise/query`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Quelvio API ${res.status}: ${text.slice(0, 500)}`);
    }

    return (await res.json()) as QueryResponse;
  }

  /**
   * Open a streaming query — proxy the backend's SSE pipeline. Returns
   * the raw `Response` so the MCP layer can pipe the body through to
   * the MCP client. Caller is responsible for translating backend SSE
   * frames into MCP-shaped output.
   *
   * Throws on non-2xx (token cap exhausted, rate limited, etc.) so the
   * caller can fall back to one-shot mode rather than streaming an
   * error response.
   */
  async queryStream(params: QueryParams): Promise<Response> {
    const body: Record<string, unknown> = {
      query: params.query,
      limit: params.top_k ?? 5,
      mode: params.mode ?? "synthesis_lite",
    };
    if (params.domain_filter) {
      body.domain_filter = params.domain_filter;
    }

    const res = await fetch(`${this.baseUrl}/v1/enterprise/query/stream`, {
      method: "POST",
      headers: this.headers({ Accept: "text/event-stream" }),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Quelvio API ${res.status}: ${text.slice(0, 500)}`);
    }
    return res;
  }

  /** List taxonomy domains with coverage levels (zero-cost discovery). */
  async listDomains(coverage?: string): Promise<DomainsListResponse> {
    const url = new URL(`${this.baseUrl}/v1/enterprise/domains`);
    if (coverage) {
      url.searchParams.set("coverage", coverage);
    }
    const res = await fetch(url.toString(), {
      headers: this.headers(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Quelvio API ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as DomainsListResponse;
  }

  /** Per-chunk provenance for a previous query (zero-cost). */
  async getSourceDetail(queryId: string): Promise<SourceDetailResponse> {
    const res = await fetch(
      `${this.baseUrl}/v1/enterprise/sources/${encodeURIComponent(queryId)}`,
      {
        headers: this.headers(),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Quelvio API ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as SourceDetailResponse;
  }
}
