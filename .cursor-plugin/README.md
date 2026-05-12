# Quelvio — Cursor plugin

Search your company's connected knowledge from inside Cursor.

## Install

The plugin auto-discovers the Quelvio MCP endpoint at `https://mcp.quelvio.com/http`. On first use, Cursor opens a browser tab for sign-in. Complete sign-in and Cursor resumes automatically.

## Tools

- `query_knowledge` — search across all connected sources (Drive, SharePoint, Confluence, Slack, Notion). Returns cited answers grounded in your authoritative documents.
- `list_domains` — discover what knowledge domains exist in your tenant.
- `get_source_detail` — chunk-level provenance for a previous query.

## Permission model

Every query is scoped to your individual identity. You see only what you can access in the underlying source systems.

## Links

- Website: https://quelvio.com
- Privacy: https://quelvio.com/privacy
- Source: https://github.com/Quelvio/quelvio-mcp-server
