# Changelog

All notable changes to GSE Terminal are documented here.

## [Unreleased]

### Added
- The React client in `web/` is now served by the Go binary at `/v2`, embedded via `go:embed` alongside the existing terminal. Client-side routes fall back to the app shell; content-hashed bundles are cached immutably and `index.html` is not cached at all.
- JSON authentication endpoints — `POST /v1/auth/login`, `/v1/auth/signup`, `/v1/auth/logout`, `/v1/auth/refresh` — for clients that cannot follow the HTML form handlers' redirect. They share the credential check, audit entries, rate limit, and session/refresh cookies with `/login` and `/signup`.
- A `.dockerignore`, so the frontend build stages' `npm ci` results are not overwritten by host `node_modules`.
- Opt-in, authenticated Model Context Protocol (MCP) endpoint at `POST /mcp`, enabled with `MCP_ENABLED=true`.
- Read-only MCP tools for latest quotes, bounded price history, market movers, market briefings, and Pro/Admin technical indicators.
- MCP request validation, protocol negotiation, rate limiting, and audit-log entries.
- Tests covering MCP protocol handling, authentication boundaries, tool validation, feature-flag configuration, and regressions.

### Changed
- The legacy service worker no longer intercepts `/v2`, which would have answered the React client's deep links with the old offline shell.
- `go.mod` ignores both `node_modules` trees; adding `web/embed.go` had pulled an npm dependency's vendored Go package into the module.
- Quote calculation is shared between the public API and MCP tools to keep output consistent.
- QuestDB now supports bounded recent OHLC retrieval for MCP history requests.
