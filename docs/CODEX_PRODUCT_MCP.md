# Embedded Codex Product Integration

The embedded Codex browser runtime now receives two local HTTP MCP servers:

- `xhs-context`: immutable indexed records and citations built from job artifacts.
- `codex-product`: the product control and analysis surface described below.

Both endpoints are loopback-only and use the local xhs-context token. The token is injected into the Codex app-server environment and is never returned by status endpoints or tool results.

The product integration now also publishes a workspace map consumed by the
Codex Host bridge:

- the writable source project is the repository configured as `workspaceRoot`;
- every persisted collection/analysis job is exposed as a historical artifact
  workspace, with its own project id and result resource;
- Codex starts in the source project by default and can switch to a historical
  task workspace without losing the source project;
- `developer-instructions` and the product MCP resources describe the same
  workspace contract, so the embedded renderer, local Codex CLI, and future
  remote connector use the same project labels.

## Product Tools

Read and analysis tools:

- `product_status`: product runtime, active jobs, and context index counts.
- `list_workspaces`: writable source workspace plus all historical task workspaces.
- `get_workspace`: read the complete workspace map or one workspace.
- `read_source_manifest`: bounded source-file manifest for the product workspace.
- `list_jobs`, `search_jobs`, `get_job`: persisted task state and workflow summaries.
- `list_job_artifacts`, `read_job_artifact`: bounded inspection of task outputs.
- `get_audience_results`: normalized audience comments or users with filters and pagination.
- `list_profiles`: configured collection profiles without credentials.
- `create_context_bundle`, `list_context_bundles`, `search_context`, `open_context_record`: immutable searchable context and citations.

Control tools:

- `start_collection`: starts a new validated collection/analysis task.
- `resume_job`: resumes a task at `full`, `discovery`, `body_completion`, `analysis`, `audience`, or `artifacts` scope.
- `cancel_job`: requests cancellation of a queued or running task.

Control calls run through the existing `JobManager` and contract validation. They retain the product's queue, recovery, idempotency, and state persistence behavior.

## Resources

The same server exposes standard MCP resources so Codex can attach product state as native context:

- `codex-product://status`: current workload and context-index status.
- `codex-product://workspace`: source and historical task workspace map.
- `codex-product://workspace/source`: bounded source-file manifest.
- `codex-product://jobs`: bounded list of persisted product jobs.
- `codex-product://jobs/{jobId}`: one job's workflow and resumability metadata.
- `codex-product://jobs/{jobId}/audience`: merged audience results, including checkpoint lineage.
- `codex-product://jobs/{jobId}/artifacts/{artifactId}`: bounded text artifact content or binary metadata.

## Endpoints

- `GET /api/codex-product/status`
- `GET /api/codex-product/workspaces`
- `GET /api/codex-product/integration`
- `POST /api/codex-product/mcp`
- `GET /api/xhs-context/status`
- `POST /api/xhs-context/mcp`

The browser status response includes a `product` section so the UI can distinguish a healthy browser shell from a healthy product tool surface.

## Verification

The service tests cover artifact reads, audience normalization, context bundle creation/search, invalid request rejection, workflow controls, token checks, and dual MCP process injection. The app-server transport remains backwards compatible with the original single `contextMcp` option.

## Local Codex installation

The repository ships `scripts/install-codex-product-mcp.ps1` and the npm
alias `npm run install:codex-product`. It registers two stdio MCP servers with
the user's Codex CLI by using the supported `codex mcp add` command:

```powershell
npm run install:codex-product
```

The bridge reads the product token from `data/xhs-context/local-token`; the
token is not embedded in `config.toml`, a URL, or the browser UI. An optional
`-McpGatewayTokenFile` registers the existing full-scope product MCP gateway as
`xhs-workbench` when the user already has a valid MCP grant token. Codex must
be restarted after installation so the source workspace instructions and MCP
servers are loaded.
