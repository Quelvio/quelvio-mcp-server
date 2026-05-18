# Changelog

All notable changes to the Quelvio MCP server. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.1.0] — 2026-05-18

### Changed (BREAKING — tool surface)

- **`query_knowledge` modes consolidated to v0.9's three tiers:** `fast`,
  `standard`, `deep`. The pre-v0.9 5-value enum (`quick`, `standard`,
  `deep`, `synthesis_lite`, `synthesis_pro`) is retired. `standard` is
  the default. **Synthesis is now built into `standard` and `deep`** —
  there's no separate "synthesis" mode axis. `fast` is the only tier
  that returns chunks without a synthesized answer body.
- **Streaming gate updated:** SSE proxy now engages for `standard` and
  `deep` (previously `synthesis_lite` / `synthesis_pro`). `fast` never
  streams.
- **Default streaming mode in api-client:** changed from `synthesis_lite`
  → `standard` to align with the v0.9 default.

### Fixed

- **Synthesis text was being silently dropped on the default `standard`
  mode.** The old `isSynthesis = mode === "synthesis_lite" || mode === "synthesis_pro"`
  check rejected `standard`, so when v0.9 backends returned an actual
  synthesized answer the MCP discarded it before responding. The new
  logic uses the response payload as source of truth: if the backend
  returned a non-empty `synthesis` string, render it.
- **README pricing was off by orders of magnitude** (1 kT structured /
  2 kT synthesis). Replaced with v0.9 Contract Lock constants:
  1,500 / 12,500 / 25,000 kT for fast / standard / deep.

### Compatibility note

Pre-v0.9 alias values (`quick`, `synthesis_lite`, `synthesis_pro`, `basic`)
are still accepted by the backend's deprecation shim but no longer
exposed via the MCP tool schema. Clients sending an alias get the
mapped v0.9 mode + a per-process deprecation warning in backend logs.

## [1.0.3] — 2026-05-12

### Changed

- Repository URL refs now point at the public mirror
  ([Quelvio/quelvio-mcp-server](https://github.com/Quelvio/quelvio-mcp-server))
  across `package.json`, `server.json`, and `.cursor-plugin/plugin.json`
  for Cursor Marketplace + Claude Connectors directory submissions.
- `SERVER_INFO.version` synced to 1.0.3 (was lagging at 1.0.0 in the
  MCP `initialize` handshake response).

### Polish

- Scrubbed internal-only references from comments (private design-doc
  links, Python module paths, internal codenames).
- Regenerated `package-lock.json` without monorepo workspace paths so
  fresh clones can `npm install` cleanly.
- Dockerfile labels corrected: `image.licenses="MIT"` (was
  `"Proprietary"`), `image.source` / `image.documentation` point at the
  public mirror.

## [1.0.2] — 2026-05-12

### Added

- **Dynamic Client Registration (RFC 7591)** — `POST /register`
  endpoint required by Anthropic's custom-connector orchestrator. Each
  Claude Desktop installation now registers as a unique OAuth client
  on first use, unblocking the previously-stalled "Open Claude" step.
- **`title` + `idempotentHint` tool annotations** on all three tools
  (`query_knowledge`, `list_domains`, `get_source_detail`) per the
  Claude Connectors directory submission criteria.
- **`/oauth/bridge-meta` `client_name` surface** — DCR-registered
  client names propagate to the frontend bridge consent page (Claude
  Desktop / Cursor / etc.).

### Fixed

- `server.json` schema alignment with the Official MCP Registry
  (repository as object, plural `remotes[]` array, removed deprecated
  fields).
- OAuth bridge UX polish: Quelvio logo on the consent page, dynamic
  client name in copy, branded loading state.

## [1.0.1] — 2026-05-12

### Added

- `.cursor-plugin/` directory for Cursor Marketplace listing
  (plugin manifest + README).
- MIT `LICENSE` file (the source was already MIT-licensed in
  `package.json`).

## [1.0.0] — 2026-05-09 (v0.8.8)

The MCP Phase 1 release — the server is now usable end-to-end at tenant-scope auth. Three tools live, OAuth 2.1 + PKCE shipped, distribution scaffolding in place. Per-employee permission filtering remains a v0.9.x deliverable (SSO + Identity workstream).

### Added

- **`query_knowledge` tool** — primary search tool with structured + synthesis modes (`quick | standard | deep | synthesis_lite | synthesis_pro`). Replaces `quelvio_search` and absorbs `quelvio_synthesize`. First-sentence-uniqueness description targets progressive-discovery clients (Claude Code Tool Search).
- **`list_domains` tool** — zero-cost discovery of taxonomy domains with coverage levels, document/expert counts, and the top contributor per domain. Replaces the broken `quelvio_topics` tool which called a non-existent backend endpoint.
- **`get_source_detail` tool** — chunk-level provenance for a previous query (`query_id` from a prior `query_knowledge` response). Returns lifecycle state, embedding timestamp, contributor metadata. Zero kT consumption.
- **Safety annotations on every tool** — `readOnlyHint=true`, `destructiveHint=false`, `openWorldHint` per tool. Required by the Claude Connectors directory.
- **25K-token response cap** — server-side enforcement with deterministic truncation: clamp excerpts to 200 chars first, then drop lowest-rank sources (preserving ≥3), then truncate the synthesis body. Surfaced via `truncated: true` in the structured metadata block.
- **SSE proxy for synthesis modes** — when `tools/call query_knowledge` carries `Accept: text/event-stream` and a synthesis mode, the server proxies the backend's `/v1/enterprise/query/stream` endpoint and re-encodes its event vocabulary into the MCP response.
- **`X-Quelvio-Source: mcp` header** — tagged on every backend call so audit logs distinguish MCP-originating queries from dashboard / Slack / etc.
- **Distribution scaffolding** — `server.json` (MCP Registry manifest, schema 2025-12-11, namespace `com.quelvio/knowledge-api`, DNS TXT verification at `quelvio.com`), `.cursor-plugin/` (Cursor Marketplace), `Dockerfile` (Docker MCP Registry stdio-bridge target).
- **Structured metadata block** — every tool response now ends with a fenced JSON block carrying `query_id`, `truncated`, `coverage`, `retrieval_mode`, `tokens_consumed`, etc. Agents parse this programmatically; humans read the prose above it.

### Removed

- **Marketplace key path** — `qlv_*` (non-`qlv_ent_`) keys are gone. The marketplace product was deprecated in v0.7. The OAuth flow + paste-key direct-accept path remain; only the marketplace branch in the API client is removed. `POST /v1/query` was never live post-v0.7.
- **`quelvio_search`, `quelvio_synthesize`, `quelvio_topics` tools** — replaced as part of the v0.8.8 tool rename. The smoke test invocations (`scripts/oauth-smoke-test.ts`) were updated to call `list_domains`.
- **Unused `@modelcontextprotocol/sdk` dependency** — closed the hono CVE chain (3 medium-severity CVEs) and removed 20+ unused transitive dependencies after deciding to keep the hand-rolled MCP implementation.

### Changed

- **`api-client.ts`** — single enterprise endpoint shape (no more marketplace branch), added `listDomains()` + `getSourceDetail()` + `queryStream()` methods, threaded the `X-Quelvio-Source` header on every call.
- **`tools/types.ts`** — `ToolDefinition` gained a required `annotations` field (Claude Connectors compliance).

### Permission model — explicit limitation

All MCP queries in v0.8.8 run at **tenant scope**. The OAuth flow resolves a bearer token to a tenant API key + tenant ID; the backend enforces tenant isolation but does not yet filter `permission_emails` per individual employee. Tenants relying on connector-level ACLs see content scoped tenant-wide.

Per-employee permission filtering ships in v0.9 alongside the SSO + Identity workstream. Until then, treat MCP results as a tenant-wide read.

### Compatibility notes

- **Modern Claude Desktop, Cursor, Claude Web, Claude Code** — connect directly to `https://mcp.quelvio.com/http` over Streamable HTTP. No client-side install needed.
- **Older Claude Desktop / stdio-only clients** — `npm install -g @quelvio/mcp-server` ships a stdio bridge that proxies stdin/stdout JSON-RPC to the remote endpoint.
- **Claude Connectors directory submission** — pending Anthropic review. Privacy policy (https://quelvio.com/privacy) and three working examples in this README satisfy the directory's submission requirements.

### Known follow-ups for v0.8.x

- Wire a TypeScript test framework (vitest) and add unit tests for `tools/token_cap.ts` (truncation order at the cap boundary) and `tools/sse_proxy.applyEvent` (event vocabulary + error frame handling). Helpers are exposed via `__testing` exports for this. Currently exercised only by the end-to-end smoke test (`scripts/oauth-smoke-test.ts`) and tsc / wrangler bundle sanity.
- Vendor a types-only file from the SDK (`ToolAnnotations`, `CallToolResult`, etc.) so future spec drift is caught at compile time.

---

## [0.3.0] — 2026-Q1

Initial MCP server release — basic OAuth 2.1, two working tools (`quelvio_search`, `quelvio_synthesize`), one broken tool (`quelvio_topics` — backend endpoint never existed). Live at `https://mcp.quelvio.com`. Documented gaps captured in `docs/v07x-mcp-end-to-end-audit.md`; closed in 1.0.0.
