# ADR: Anonymous MCP Showcase on the Public Endpoint

- Status: Accepted
- Date: 2026-08-10

## Context

The public MCP URL was healthy but returned HTTP 401 when opened without a Grant.
That protected private data, but it also made the competition and integration URL
look unavailable to reviewers and MCP clients that had not received a Grant.

## Decision

Keep one Streamable HTTP endpoint with two explicit paths:

1. A request with no `Authorization` header uses a stateless, read-only showcase.
   It exposes only embedded synthetic records, `showcase://` resources, and
   deterministic `showcase.*` tools.
2. A request with any `Authorization` header uses the existing Grant
   authentication and stateful session path. Invalid, malformed, expired, or
   revoked credentials return HTTP 401 and never fall back to the showcase.

The showcase provider has no dependency on the production store, job manager,
data adapter, tool registry, file system, environment, or network. Each MCP POST
creates and closes its own stateless SDK server and transport. Browser GET returns
endpoint metadata; MCP-style SSE GET and DELETE return 405.

The application enforces a separate anonymous body limit, per-source request
limit, per-source concurrency limit, bounded limiter state, and a production kill
switch. Existing Host, Origin, HTTPS-forwarding, and Cloudflare checks execute
before both paths.

## Consequences

- Reviewers can open the endpoint and use it immediately with an official MCP
  client without receiving credentials.
- Anonymous clients cannot discover private resources or write-capable tools.
- Grant clients retain the existing snapshot, scope, audit, revocation, and
  session behavior.
- Operations must verify both `npm run verify:mcp:showcase` and the authenticated
  `npm run verify:mcp` path before release.
