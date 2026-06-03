# Strict-Mode Sentinel Handoff (FE-13)

This SDK is the **reference implementation** for the v2 strict-mode
sentinel warning. The other seven Quelvio SDKs (`quelvio-cli`,
`quelvio-vercel-ai-sdk`, `quelvio-langchain-js`,
`quelvio-langchain-python`, `quelvio-llama-index`, `quelvio-crewai`,
`quelvio-agent-skills`) carry a small docs PR that points back to this
file. Mirror the pattern below in each SDK using its native HTTP client.

## What backend PR #643 ships

Backend PR #643 begins emitting two response headers globally on the
search/retrieval endpoints:

| Header | Value | Meaning |
| --- | --- | --- |
| `X-Quelvio-API-Version` | `2.0` | API contract version. Informational. |
| `X-Quelvio-Sentinel-Set` | `closed-v1` | Tenant is on the strict (closed) permission model. Some results may be filtered. |

The sentinel header is the load-bearing one for SDK UX. When present,
SDK consumers may see fewer search results than they expect — the
strict model only returns chunks for which the calling employee has
explicit access. Without a warning, this looks like "search regressed".

## Implementation contract

Each SDK MUST, when it observes `X-Quelvio-Sentinel-Set` on any response
from the Quelvio API:

1. Log a warning **once per process** (idempotent — repeated observations
   stay silent). The warning text:
   ```
   Quelvio v2 strict permission mode is active for your tenant.
   Some search results may be filtered to enforce explicit permissions.
   Learn more: https://docs.quelvio.com/permission-model
   ```
2. Surface the warning via the SDK's existing logger or `stderr` /
   `console.warn`. Never raise / throw / break the API call.
3. Prepend an event line `quelvio_sentinel_set_detected sentinel=<value>`
   so log aggregators can grep on a stable token. This is also where a
   telemetry sink (when the SDK gains one) should fire a
   `quelvio_sentinel_set_detected` event.

## Reference implementation (TypeScript / Cloudflare Workers)

This SDK uses native `fetch` against the Quelvio REST API. The pattern:

- `src/sentinel.ts` — module-scoped `Set<string>` of observed sentinel
  values + `noteSentinelHeader(res: Response)` helper. The Set is the
  idempotency gate.
- `src/api-client.ts` — calls `noteSentinelHeader(res)` immediately
  after every `await fetch(...)` (4 call sites: `query`, `queryStream`,
  `listDomains`, `getSourceDetail`).
- `src/sentinel.test.ts` — `node:test` cases covering the three states
  (header absent, present once, repeated same value, different values).
- `.github/workflows/ci.yml` — runs `npm run typecheck && npm test` on
  PRs so the test gate is enforced.

The dedupe set lives in the module's closure — fine for a Cloudflare
Worker isolate (one tenant per isolate effectively, since the API key
is per-request) and for any Node / browser SDK where one process serves
one user. In Python SDKs use a module-level `set` plus a `threading.Lock`
if the client may be called from multiple threads.

## Adapting to each SDK

| Repo | HTTP client | Place to wire it |
| --- | --- | --- |
| `quelvio-cli` | `fetch` (Node) | The shared API client wrapper. |
| `quelvio-vercel-ai-sdk` | `fetch` | The provider's `fetchImpl`. |
| `quelvio-langchain-js` | `fetch` / `axios` | The `QuelvioRetriever._getRelevantDocuments` call site. |
| `quelvio-langchain-python` | `httpx` / `requests` | A `httpx.Client` event hook (`event_hooks={"response": [...]}`). |
| `quelvio-llama-index` | `requests` / `httpx` | The retriever's `_retrieve` method. |
| `quelvio-crewai` | `requests` | The tool's HTTP wrapper. |
| `quelvio-agent-skills` | inert (skills are markdown bundles) | No runtime code path; this repo's PR is docs-only — add a note in the relevant skill describing the strict-mode UX. |

## Telemetry stub

When an SDK has a telemetry pipeline, dispatch a single
`quelvio_sentinel_set_detected` event with payload `{sentinel: <value>}`
**from inside the same dedupe gate** so telemetry inherits the
once-per-process semantics.

## Owner

FE-13 / antonis@rolle.io. Backend counterpart: PR #643 on
`Quelvio/quelvio-platform`.
