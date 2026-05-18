# @quelvio/mcp-server

Quelvio MCP server — search your company's connected knowledge from any AI tool that speaks the Model Context Protocol.

Endpoint: `https://mcp.quelvio.com/http` (Streamable HTTP, MCP spec 2025-03-26)
Source: [Quelvio/quelvio-mcp-server](https://github.com/Quelvio/quelvio-mcp-server)
License: MIT

## Tools

| Tool | Purpose | Knowledge Tokens |
|---|---|---|
| `query_knowledge` | Primary search across the tenant's connected sources (Drive, SharePoint, Confluence, Slack, Notion). Modes: `fast`, `standard` (default), `deep`. | 1,500 kT (`fast`) / 12,500 kT (`standard`) / 25,000 kT (`deep`) |
| `list_domains` | Discovery — list taxonomy domains with coverage levels. Use to decide whether the brain has relevant knowledge before issuing a billable query. | 0 kT |
| `get_source_detail` | Per-chunk provenance for a previous query: document path, lifecycle state, embedding timestamp, contributor, last-updated. Pass a `query_id` from an earlier `query_knowledge` response. | 0 kT |

## Permission model

Every MCP query is scoped to your **individual employee identity**, not just your tenant. The server applies the same four-layer access model the dashboard uses:

1. **Tenant isolation** — Qdrant collections are per-tenant; cross-tenant content is structurally unreachable.
2. **Role-based feature access** — Owner / Admin / Member determines which tools are callable.
3. **Knowledge Spaces** (v0.9, planned) — content access-control units within a tenant.
4. **Source permission filtering** — `permission_emails` on every chunk, resolved at ingest time from the source system's ACLs (Google Drive shares, SharePoint groups, Confluence space restrictions). MCP queries see only what your individual account would see in those source systems.

The source-permission filter is unconditional — there is no flag, env var, or dashboard toggle that disables it. The MCP server records the per-employee identity on every query so cross-employee provenance inspection via `get_source_detail` is rejected with 404 (only Owner/Admin can view another member's queries).

## Sign in

There is no API key to provision. The first time you use Quelvio MCP from any client, you'll be redirected to your organization's sign-in page (Clerk-hosted, the same one the dashboard uses). After signing in, your client resumes automatically. Subsequent queries reuse the OAuth token until it expires (~30 days) or you revoke it from `enterprise.quelvio.com`.

If your AI assistant prompts you for a "Bearer token" or "API key" header in the JSON config, you have an outdated configuration — delete the `headers` block and let your client manage OAuth. The migration is automatic: the next time you invoke a tool, the client opens a browser tab for sign-in.

## Install

### Claude Desktop (and Claude Web)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "quelvio": {
      "url": "https://mcp.quelvio.com/http"
    }
  }
}
```

Restart Claude Desktop. On first use Claude opens a browser tab pointing at Clerk's hosted sign-in page; complete sign-in and Claude resumes automatically.

### Cursor

Add to `.cursor/mcp.json` in your project root (or globally at `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "quelvio": {
      "url": "https://mcp.quelvio.com/http"
    }
  }
}
```

Cursor handles the OAuth round-trip the same way Claude does.

### Claude Code

```bash
claude mcp add quelvio --transport http https://mcp.quelvio.com/http
```

### VS Code (Copilot)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "quelvio": {
      "type": "http",
      "url": "https://mcp.quelvio.com/http"
    }
  }
}
```

### stdio bridge (older clients)

For MCP clients that don't speak Streamable HTTP yet, install the npm package:

```bash
npm install -g @quelvio/mcp-server
```

Then point your client at the binary:

```json
{
  "mcpServers": {
    "quelvio": {
      "command": "quelvio-mcp"
    }
  }
}
```

The binary opens a local OAuth listener on a random `127.0.0.1` port and proxies all subsequent JSON-RPC to `https://mcp.quelvio.com/http`.

## OAuth flow

The MCP server is an OAuth 2.1 + PKCE (S256) protected resource. Bearer tokens are opaque, KV-backed, and AES-GCM encrypted at rest. RFC 9728 + RFC 8414 discovery is wired:

- `GET /.well-known/oauth-protected-resource` — resource metadata
- `GET /.well-known/oauth-authorization-server` — authorization server metadata
- `GET /oauth/authorize` — 302 to Clerk hosted sign-in (with PKCE state stashed in KV)
- `GET /oauth/callback` — Clerk session JWT → `POST /v1/auth/sso-bridge` mints a per-employee ephemeral key → 302 back to client `redirect_uri`
- `POST /oauth/token` — auth_code or refresh_token grant
- `POST /oauth/revoke` — invalidate a token

Modern MCP clients auto-bootstrap the flow when they hit a 401 with the `WWW-Authenticate: Bearer ... resource_metadata=...` challenge. Cursor and Claude Desktop do this transparently.

**v0.8.8 foundation deletion:** the legacy paste-an-API-key form path (`POST /oauth/authorize` with a `qlv_ent_*` key in the form body) is gone. Customers using paste-key MCP must complete the OAuth/Clerk round-trip on first use; the migration is automatic — the client just opens a browser tab the next time you invoke a tool.

## Examples

### 1. `query_knowledge` — find an answer with citations

```
ask Claude: "What's our deployment process for the payments service?"

Claude calls: query_knowledge(query="deployment process payments service")

Response: synthesized answer with [n] citations + structured metadata block including
query_id, coverage level, retrieval execution state, latency, and tokens consumed.
(Default mode is `standard` — synthesis is built in. Use `mode="deep"` for complex
analytical questions, `mode="fast"` for keyword-style retrieval with no synthesis.)
```

### 2. `list_domains` — discover what's indexed before querying

```
ask Claude: "What taxonomy domains does our company have indexed?"

Claude calls: list_domains()

Response: list of every domain with document count, expert count, coverage level
(expert | partial | none), top contributor by authority, and the single_expert risk
flag where applicable.
```

### 3. `get_source_detail` — verify a citation

```
After a query_knowledge call returned [3] citations, ask Claude:
"Show me the actual source for citation [3]."

Claude calls: get_source_detail(query_id="<uuid from prior query>")

Response: per-chunk provenance — document path, lifecycle state (live | stale |
superseded | user_deleted), embedding timestamp + model, contributor name + department,
authority score, taxonomy domain.
```

## Pricing

Knowledge Token consumption per tool call (v0.9 frozen constants):

- `query_knowledge` with `mode=fast`     : **1,500 kT**  (retrieval-only, no synthesis)
- `query_knowledge` with `mode=standard` : **12,500 kT** (default; synthesis bundled)
- `query_knowledge` with `mode=deep`     : **25,000 kT** (wider retrieval + premium synthesis)
- `list_domains`                          : 0 kT
- `get_source_detail`                     : 0 kT

These costs are frozen at the v0.9 Contract Lock. The dashboard's billing page (`/billing`) shows the live per-tenant daily Knowledge Token pool and the projected next invoice.

## Self-hosting / development

```bash
cd mcp-server
pnpm install

# Local dev
pnpm dev

# Deploy to Cloudflare Workers
wrangler secret put TOKEN_ENCRYPTION_KEY    # 32 bytes hex (openssl rand -hex 32)
wrangler secret put CLERK_SIGN_IN_URL       # Clerk hosted sign-in URL
pnpm deploy
```

The Worker is stateless — every OAuth artifact (auth codes, access tokens, refresh tokens) lives in the bound KV namespace. No Durable Objects.

## Protocol

- **Transport:** Streamable HTTP (MCP spec 2025-03-26)
- **Endpoint:** `POST /http` with `Content-Type: application/json`
- **Health check:** `GET /` or `GET /http` returns server info
- **Methods:** `initialize`, `tools/list`, `tools/call`, `ping`
- **Streaming:** when `tools/call query_knowledge` carries `Accept: text/event-stream` AND `mode` is `standard|deep` (the two v0.9 tiers that synthesize), the server proxies the backend's SSE pipeline. `fast` never streams (no synthesis body to incrementally produce). The MCP response is still a single JSON body — token-by-token streaming to the MCP client lands when the spec adds native output deltas.
- **Response cap:** Claude Connectors' 25,000-token-per-tool-result limit is enforced server-side. Truncation order: drop excerpts past 200 chars first, then drop lowest-rank sources (preserving ≥3), then truncate the synthesis body. Truncation is signalled via `truncated: true` in the structured metadata block so agents can re-issue with a smaller `max_sources`.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
