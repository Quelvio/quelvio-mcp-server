/**
 * Quelvio MCP Server — Cloudflare Workers entry point.
 *
 * Implements MCP Streamable HTTP transport (spec 2025-03-26).
 *
 * Three tools (v0.8.8 MCP Phase 1):
 *   query_knowledge   — primary search (absorbs synthesis modes)
 *   list_domains      — taxonomy domain discovery (zero kT)
 *   get_source_detail — chunk-level provenance for a previous query (zero kT)
 *
 * Auth: OAuth 2.1 + PKCE (S256), KV-backed access tokens with AES-GCM
 * encryption of the wrapped enterprise API key. Direct-accept of
 * `Authorization: Bearer qlv_ent_*` for clients without an OAuth round-
 * trip (e.g. Notion MCP). Admin-key fallback gated by env flag.
 *
 * Streaming: when `Accept: text/event-stream` is set on a `tools/call`
 * for `query_knowledge` with synthesis mode, the server proxies the
 * backend's `/v1/enterprise/query/stream` endpoint and re-encodes its
 * event vocabulary into a single MCP tools/call response. (When the
 * MCP spec adds streaming output deltas natively, sse_proxy.ts flips
 * to streaming the response without changing the backend interface.)
 *
 * Deploy: wrangler deploy → https://mcp.quelvio.com/http
 */

import { type Env, PROTOCOL_VERSION, SERVER_INFO, getApiUrl } from "./config.js";
import { QuelvioClient } from "./api-client.js";
import { requireBearerToken } from "./auth/middleware.js";
import {
  handleAuthorizationServerMetadata,
  handleAuthorizeCallback,
  handleAuthorizeGet,
  handleBridgeMeta,
  handleProtectedResourceMetadata,
  handleRegister,
  handleRevoke,
  handleToken,
} from "./auth/oauth.js";
import {
  queryKnowledgeDefinition,
  createQueryKnowledgeHandler,
} from "./tools/query_knowledge.js";
import {
  listDomainsDefinition,
  createListDomainsHandler,
} from "./tools/list_domains.js";
import {
  getSourceDetailDefinition,
  createGetSourceDetailHandler,
} from "./tools/get_source_detail.js";
import { streamSynthesisQuery } from "./tools/sse_proxy.js";
import type { ToolDefinition, ToolHandler } from "./tools/types.js";

// ── JSON-RPC types ────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function jsonResponse(
  id: string | number | null | undefined,
  result: unknown,
): Response {
  const body: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: id ?? null,
    result,
  };
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(
  id: string | number | null | undefined,
  code: number,
  message: string,
): Response {
  const body: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
  return new Response(JSON.stringify(body), {
    status: code === -32600 ? 400 : 200,
    headers: { "Content-Type": "application/json" },
  });
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Mcp-Session-Id, Accept",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

// ── Tool registry ─────────────────────────────────────────────────────────

interface ToolEntry {
  definition: ToolDefinition;
  createHandler: (client: QuelvioClient) => ToolHandler;
}

const TOOL_REGISTRY: ToolEntry[] = [
  {
    definition: queryKnowledgeDefinition,
    createHandler: createQueryKnowledgeHandler,
  },
  {
    definition: listDomainsDefinition,
    createHandler: createListDomainsHandler,
  },
  {
    definition: getSourceDetailDefinition,
    createHandler: createGetSourceDetailHandler,
  },
];

// ── Synthesis mode detection ──────────────────────────────────────────────
//
// v0.9: synthesis is bundled into ``standard`` and ``deep``. ``fast`` is
// the only tier that returns chunks without an LLM-synthesized body. The
// streaming SSE proxy is therefore engaged for ``standard`` and ``deep``
// (when the caller requests text/event-stream), never for ``fast``.

const SYNTHESIZING_MODES = new Set(["standard", "deep"]);

function isStreamingSynthesisCall(
  request: Request,
  toolName: string | undefined,
  toolArgs: Record<string, unknown>,
): boolean {
  if (toolName !== "query_knowledge") return false;
  // Default mode is ``standard`` (which synthesizes); only the
  // explicit ``fast`` opt-out falls outside the streaming-eligible set.
  const rawMode = toolArgs.mode;
  const mode = typeof rawMode === "string" ? rawMode : "standard";
  if (!SYNTHESIZING_MODES.has(mode)) return false;
  const accept = request.headers.get("Accept") ?? "";
  return accept.includes("text/event-stream");
}

// ── Request handler ───────────────────────────────────────────────────────

async function handleMcpRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  // Parse JSON-RPC request body.
  let rpc: JsonRpcRequest;
  try {
    rpc = (await request.json()) as JsonRpcRequest;
  } catch {
    return jsonError(null, -32700, "Parse error: invalid JSON");
  }

  if (rpc.jsonrpc !== "2.0") {
    return jsonError(rpc.id, -32600, "Invalid Request: jsonrpc must be '2.0'");
  }

  // ── Route by method ─────────────────────────────────────────────────

  switch (rpc.method) {
    // ── Handshake ───────────────────────────────────────────────────
    case "initialize":
      return jsonResponse(rpc.id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: {
          tools: { listChanged: false },
        },
      });

    // ── Client acknowledgement (notification, no id) ────────────────
    case "notifications/initialized":
      return new Response(null, { status: 202 });

    // ── List tools ──────────────────────────────────────────────────
    case "tools/list":
      return jsonResponse(rpc.id, {
        tools: TOOL_REGISTRY.map((t) => t.definition),
      });

    // ── Call a tool ─────────────────────────────────────────────────
    case "tools/call": {
      const params = rpc.params ?? {};
      const toolName = params.name as string | undefined;
      const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

      if (!toolName) {
        return jsonError(rpc.id, -32602, "Invalid params: tool name required");
      }

      // ── Auth: resolve the bearer token to an API key ──────────────
      // initialize / tools/list / ping are unauthenticated (MCP spec).
      // Only tools/call requires a valid OAuth access token (or the
      // admin fallback when ADMIN_KEY_FALLBACK_ENABLED === "true").
      // On failure we return the 401 Response directly — NOT wrapped
      // in a JSON-RPC envelope — so the MCP client picks up the
      // WWW-Authenticate header and triggers its OAuth flow.
      const authResult = await requireBearerToken(request, env);
      if (authResult instanceof Response) {
        return authResult;
      }

      const entry = TOOL_REGISTRY.find((t) => t.definition.name === toolName);
      if (!entry) {
        return jsonError(
          rpc.id,
          -32602,
          `Unknown tool: ${toolName}. Available: ${TOOL_REGISTRY.map(
            (t) => t.definition.name,
          ).join(", ")}`,
        );
      }

      // Construct a per-request client with the resolved API key.
      // No more singleton from env.QUELVIO_API_KEY — each developer's
      // requests use the API key bound to their OAuth token.
      // v0.8.8 SSO foundation: thread memberId so the client sends
      // ``X-Employee-Id`` when the OAuth flow captured a member identity
      // (Clerk-redirect path). Legacy paste-key paths leave it null.
      const client = new QuelvioClient(
        authResult.apiKey,
        getApiUrl(env),
        authResult.memberId,
      );

      // SSE branch: `query_knowledge` + synthesis mode + Accept header.
      // Bypasses the standard one-shot handler and runs the SSE proxy
      // which re-encodes the backend's event stream into the MCP
      // response shape. The MCP-spec response is still a single JSON
      // body — we don't yet fan out per-token deltas to the MCP client.
      if (isStreamingSynthesisCall(request, toolName, toolArgs)) {
        const query = typeof toolArgs.query === "string"
          ? toolArgs.query.trim()
          : "";
        if (!query) {
          return jsonResponse(rpc.id, {
            content: [{ type: "text", text: "Error: query is required." }],
            isError: true,
          });
        }
        const mode = toolArgs.mode as "standard" | "deep";
        const maxSources =
          typeof toolArgs.max_sources === "number"
            ? Math.min(Math.max(Math.floor(toolArgs.max_sources), 1), 20)
            : 5;
        const domain =
          typeof toolArgs.domain === "string" && toolArgs.domain.trim()
            ? toolArgs.domain.trim()
            : undefined;
        const result = await streamSynthesisQuery(client, {
          query,
          mode,
          max_sources: maxSources,
          domain,
        });
        return jsonResponse(rpc.id, result);
      }

      const handler = entry.createHandler(client);
      const result = await handler(toolArgs);
      return jsonResponse(rpc.id, result);
    }

    // ── Ping ────────────────────────────────────────────────────────
    case "ping":
      return jsonResponse(rpc.id, {});

    // ── Unknown method ──────────────────────────────────────────────
    default:
      return jsonError(rpc.id, -32601, `Method not found: ${rpc.method}`);
  }
}

// ── Cloudflare Workers entry point ────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Health check (GET /).
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/http")) {
      return new Response(
        JSON.stringify({
          name: SERVER_INFO.name,
          version: SERVER_INFO.version,
          protocol: "mcp",
          transport: "streamable-http",
          status: "ok",
        }),
        {
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        },
      );
    }

    // ── OAuth discovery (RFC 9728 + RFC 8414) ───────────────────────
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-protected-resource"
    ) {
      const res = handleProtectedResourceMetadata(env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-authorization-server"
    ) {
      const res = handleAuthorizationServerMetadata(env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // ── OAuth authorize: GET 302s to Clerk hosted sign-in ───────────
    // POST /oauth/authorize (the paste-key form submission) and the
    // legacy paste-key direct-accept code path have been removed.
    if (request.method === "GET" && url.pathname === "/oauth/authorize") {
      return await handleAuthorizeGet(request, env);
    }

    // ── Clerk-redirect callback ─────────────────────────────────────
    // GET /oauth/callback resumes the OAuth flow after the user has
    // authenticated through Clerk. The handler exchanges the Clerk
    // session JWT for an ephemeral per-employee API key via
    // POST /v1/auth/sso-bridge.
    if (request.method === "GET" && url.pathname === "/oauth/callback") {
      return await handleAuthorizeCallback(request, env);
    }

    // ── Bridge consent UI metadata (v0.8.8 MCP Phase 2) ─────────────
    // The frontend bridge page calls this to render the consent UI
    // ("Authorize Claude Desktop?"). Reads pending state without
    // consuming the pending_id. Public — pending_id is the auth signal.
    if (request.method === "GET" && url.pathname === "/oauth/bridge-meta") {
      const res = await handleBridgeMeta(request, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // ── Dynamic Client Registration (RFC 7591) ──────────────────────
    // Anthropic's custom-connector orchestrator requires DCR to
    // register each Claude Desktop installation as a unique OAuth
    // client on first use. Without this endpoint the orchestrator
    // stalls at "Open Claude" before invoking /oauth/authorize.
    if (request.method === "POST" && url.pathname === "/register") {
      const res = await handleRegister(request, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // ── OAuth token + revoke ────────────────────────────────────────
    if (request.method === "POST" && url.pathname === "/oauth/token") {
      const res = await handleToken(request, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }
    if (request.method === "POST" && url.pathname === "/oauth/revoke") {
      const res = await handleRevoke(request, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // MCP endpoint: POST /http (or POST /).
    if (
      request.method === "POST" &&
      (url.pathname === "/http" || url.pathname === "/")
    ) {
      const response = await handleMcpRequest(request, env);

      // Merge CORS headers into the response.
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders())) {
        headers.set(key, value);
      }

      return new Response(response.body, {
        status: response.status,
        headers,
      });
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  },
};
