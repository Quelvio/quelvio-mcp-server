# Quelvio MCP server — Docker MCP Registry submission target.
#
# This image runs the stdio bridge for clients that don't speak
# Streamable HTTP directly (older Claude Desktop builds, custom agents
# that prefer stdio). The bridge proxies stdin/stdout JSON-RPC to
# https://mcp.quelvio.com/http and handles the OAuth round-trip via a
# local HTTP listener.
#
# Most users do NOT need this image — Cursor, modern Claude Desktop,
# Claude Web, and Claude Code all speak Streamable HTTP and connect to
# https://mcp.quelvio.com/http directly. The image exists for the
# Docker MCP Registry listing and for stdio-only environments.

FROM node:22-alpine

LABEL org.opencontainers.image.title="Quelvio MCP Server"
LABEL org.opencontainers.image.description="MCP server for Quelvio enterprise knowledge — stdio bridge"
LABEL org.opencontainers.image.url="https://mcp.quelvio.com"
LABEL org.opencontainers.image.documentation="https://github.com/Quelvio/quelvio-platform/tree/main/mcp-server"
LABEL org.opencontainers.image.source="https://github.com/Quelvio/quelvio-platform"
LABEL org.opencontainers.image.licenses="Proprietary"

WORKDIR /app

# The stdio bridge ships in the npm package alongside the Workers
# source. When `npm install -g @quelvio/mcp-server` runs in the next
# stage, it places the `quelvio-mcp` binary on PATH.
RUN npm install -g @quelvio/mcp-server@latest

# stdio mode: the MCP client (e.g. Claude Desktop) will spawn this
# binary and exchange JSON-RPC over stdin/stdout. The binary opens a
# local OAuth listener on a random 127.0.0.1 port for the auth round-
# trip and proxies all subsequent calls to mcp.quelvio.com.
ENTRYPOINT ["quelvio-mcp"]
