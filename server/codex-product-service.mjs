import crypto from 'node:crypto';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { enumerateArtifacts, resolveDownload } from './lib/artifacts.mjs';
import { readAudienceResults } from './lib/audience-results.mjs';
import { validateRunRequest } from './lib/contracts.mjs';

const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_LIST_LIMIT = 200;
const JOB_ID = /^[0-9]{14}-[a-f0-9]{8}$/u;
const RESUME_SCOPES = new Set(['full', 'discovery', 'body_completion', 'analysis', 'audience', 'artifacts']);
const TEXT_EXTENSIONS = new Set(['.csv', '.html', '.json', '.jsonl', '.log', '.md', '.text', '.txt']);

export class CodexProductServiceError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'CodexProductServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createCodexProductService(options = {}) {
  return new CodexProductService(options);
}

export class CodexProductService {
  constructor({ manager, xhsContextService, workspaceService, profileStore, token = '', now = () => new Date() } = {}) {
    if (!manager) throw new TypeError('Codex product service requires a job manager.');
    this.manager = manager;
    this.xhsContextService = xhsContextService;
    this.workspaceService = workspaceService;
    this.profileStore = profileStore;
    this.token = String(token || '');
    this.now = now;
  }

  status() {
    const jobs = this.manager.list();
    const active = jobs.filter((job) => ['queued', 'resuming', 'running'].includes(job.status)).length;
    return {
      schemaVersion: 1,
      service: 'codex-product',
      transport: 'loopback-http',
      localOnly: true,
      tools: TOOL_DEFINITIONS.map((tool) => tool.name),
      jobs: jobs.length,
      activeJobs: active,
      activeJobId: this.manager.active?.id || null,
      contextBundles: this.xhsContextService?.listBundles?.().length || 0,
      workspace: this.workspaceService?.status?.() || { available: false },
    };
  }

  authorizeHttp(req, token) {
    if (!isLoopbackAddress(req?.socket?.remoteAddress) || !isLoopbackHost(req?.headers?.host)) {
      throw new CodexProductServiceError('CODEX_PRODUCT_LOOPBACK_ONLY', 'codex-product accepts loopback requests only.', 403);
    }
    if (!safeEqualSecret(this.token, String(token || ''))) {
      throw new CodexProductServiceError('CODEX_PRODUCT_TOKEN_INVALID', 'The codex-product local token is invalid.', 401);
    }
  }

  async handleMcpRequest(body) {
    const request = body && typeof body === 'object' ? body : {};
    const id = request.id ?? null;
    if (request.method === 'initialize') {
      return { jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'codex-product', version: '1.0.0' } } };
    }
    if (request.method === 'notifications/initialized') return null;
    if (request.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (request.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFINITIONS } };
    if (request.method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: PRODUCT_RESOURCES } };
    if (request.method === 'resources/templates/list') return { jsonrpc: '2.0', id, result: { resourceTemplates: PRODUCT_RESOURCE_TEMPLATES } };
    if (request.method === 'resources/read') {
      const uri = String(request.params?.uri || '').trim();
      return { jsonrpc: '2.0', id, result: await this.readResource(uri) };
    }
    if (request.method !== 'tools/call') throw new CodexProductServiceError('CODEX_PRODUCT_MCP_METHOD_NOT_FOUND', 'The codex-product MCP method was not found.', 400);
    const name = String(request.params?.name || '');
    const args = request.params?.arguments && typeof request.params.arguments === 'object' ? request.params.arguments : {};
    const value = await this.callTool(name, args);
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false } };
  }

  async callTool(name, args = {}) {
    switch (String(name || '')) {
      case 'product_status': return this.status();
      case 'list_workspaces': return this.listWorkspaces();
      case 'get_workspace': return this.getWorkspace(args);
      case 'read_source_manifest': return this.readSourceManifest(args);
      case 'list_jobs': return this.listJobs(args);
      case 'search_jobs': return this.searchJobs(args);
      case 'get_job': return this.getJob(args);
      case 'list_job_artifacts': return this.listJobArtifacts(args);
      case 'read_job_artifact': return this.readJobArtifact(args);
      case 'get_audience_results': return this.getAudienceResults(args);
      case 'list_profiles': return this.listProfiles();
      case 'create_context_bundle': return this.createContextBundle(args);
      case 'list_context_bundles': return { bundles: this.xhsContextService?.listBundles?.() || [] };
      case 'search_context': return this.searchContext(args);
      case 'open_context_record': return this.openContextRecord(args);
      case 'start_collection': return this.startCollection(args);
      case 'resume_job': return this.resumeJob(args);
      case 'cancel_job': return this.cancelJob(args);
      default: throw new CodexProductServiceError('CODEX_PRODUCT_TOOL_NOT_FOUND', `Unknown codex-product tool: ${name}`, 404);
    }
  }

  async readResource(uri) {
    const normalized = String(uri || '').trim();
    let parsed;
    try {
      parsed = new URL(normalized);
    } catch {
      throw new CodexProductServiceError('CODEX_PRODUCT_RESOURCE_INVALID', 'The product resource URI is invalid.', 400);
    }
    if (parsed.protocol !== 'codex-product:') {
      throw new CodexProductServiceError('CODEX_PRODUCT_RESOURCE_INVALID', 'The product resource URI scheme is invalid.', 400);
    }
    const segments = [parsed.hostname, ...parsed.pathname.split('/').filter(Boolean)].map(decodeUriSegment);
    if (segments.length === 1 && segments[0] === 'status') return resourceDocument(normalized, this.status());
    if (segments.length === 1 && segments[0] === 'workspace') return resourceDocument(normalized, await this.getWorkspace({}));
    if (segments.length === 2 && segments[0] === 'workspace' && segments[1] === 'source') {
      return resourceDocument(normalized, await this.readSourceManifest({}));
    }
    if (segments.length === 1 && segments[0] === 'jobs') return resourceDocument(normalized, this.listJobs({ limit: MAX_LIST_LIMIT }));
    if (segments[0] !== 'jobs' || !segments[1]) {
      throw new CodexProductServiceError('CODEX_PRODUCT_RESOURCE_NOT_FOUND', 'The product resource was not found.', 404);
    }
    const jobId = segments[1];
    if (segments.length === 2) return resourceDocument(normalized, this.getJob({ jobId }));
    if (segments[2] === 'audience' && segments.length === 3) {
      return resourceDocument(normalized, await this.getAudienceResults({ jobId, limit: 100 }));
    }
    if (segments[2] === 'artifacts' && segments.length >= 4) {
      return resourceDocument(normalized, await this.readJobArtifact({ jobId, artifactId: segments.slice(3).join('/') }));
    }
    throw new CodexProductServiceError('CODEX_PRODUCT_RESOURCE_NOT_FOUND', 'The product resource was not found.', 404);
  }

  listJobs({ status = '', limit = 50 } = {}) {
    const normalizedStatus = String(status || '').trim();
    const matching = this.manager.list()
      .filter((job) => !normalizedStatus || String(job.status) === normalizedStatus);
    const jobs = matching.slice(0, boundedLimit(limit)).map(jobListSummary);
    return { jobs, total: matching.length, status: normalizedStatus || null };
  }

  listWorkspaces() {
    if (!this.workspaceService?.publicSnapshot) return { available: false, workspaces: [] };
    const snapshot = this.workspaceService.publicSnapshot();
    return {
      available: true,
      source: snapshot.source,
      history: snapshot.history,
      activeJobId: snapshot.activeJobId,
      total: 1 + snapshot.history.length,
      generatedAt: snapshot.generatedAt,
    };
  }

  getWorkspace({ projectId = '' } = {}) {
    if (!this.workspaceService?.publicSnapshot) return { available: false, workspace: null };
    const snapshot = this.workspaceService.publicSnapshot();
    if (!projectId) return { available: true, ...snapshot };
    const project = this.workspaceService.project(projectId);
    if (!project) throw new CodexProductServiceError('CODEX_PRODUCT_WORKSPACE_NOT_FOUND', 'The requested product workspace was not found.', 404);
    return { available: true, workspace: publicWorkspaceProject(project), activeJobId: snapshot.activeJobId, generatedAt: snapshot.generatedAt };
  }

  async readSourceManifest(args = {}) {
    if (!this.workspaceService?.sourceManifest) return { available: false, files: [] };
    return { available: true, ...(await this.workspaceService.sourceManifest(args)) };
  }

  searchJobs({ query = '', limit = 50 } = {}) {
    const needle = String(query || '').trim().toLocaleLowerCase('zh-CN');
    if (!needle) return this.listJobs({ limit });
    const jobs = this.manager.list().filter((job) => JSON.stringify(job).toLocaleLowerCase('zh-CN').includes(needle)).slice(0, boundedLimit(limit));
    return { query: String(query || ''), jobs, total: jobs.length };
  }

  getJob({ jobId } = {}) {
    const id = requireJobId(jobId);
    const job = this.manager.get(id);
    if (!job) throw new CodexProductServiceError('CODEX_PRODUCT_JOB_NOT_FOUND', 'The requested job was not found.', 404);
    return { job };
  }

  async listJobArtifacts({ jobId, limit = 200 } = {}) {
    const internal = this.internalJob(jobId);
    const artifacts = await enumerateArtifacts(internal.outputDir);
    return { jobId: internal.id, artifacts: artifacts.slice(0, boundedLimit(limit)), total: artifacts.length };
  }

  async readJobArtifact({ jobId, artifactId = '', path: relativePath = '', maxBytes = MAX_RESULT_BYTES } = {}) {
    const internal = this.internalJob(jobId);
    const artifacts = await enumerateArtifacts(internal.outputDir);
    const requested = String(artifactId || relativePath || '').trim();
    const artifact = artifacts.find((item) => item.id === requested || item.path === requested || item.name === requested);
    if (!artifact) throw new CodexProductServiceError('CODEX_PRODUCT_ARTIFACT_NOT_FOUND', 'The requested job artifact was not found.', 404);
    const resolved = await resolveDownload(internal.outputDir, artifact.id);
    const info = await stat(resolved.absolute);
    const limit = Math.min(MAX_RESULT_BYTES, Math.max(1, Number(maxBytes) || MAX_RESULT_BYTES));
    const ext = path.extname(artifact.path || '').toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) return { jobId: internal.id, artifact, size: info.size, content: null, readable: false };
    if (info.size > limit) throw new CodexProductServiceError('CODEX_PRODUCT_ARTIFACT_TOO_LARGE', 'The requested artifact exceeds the read limit.', 413, { size: info.size, maxBytes: limit });
    const content = await readFile(resolved.absolute, 'utf8');
    return { jobId: internal.id, artifact, size: info.size, readable: true, sha256: sha256(content), content };
  }

  async getAudienceResults({ jobId, kind = 'comments', postId = '', query = '', offset = 0, limit = 100 } = {}) {
    const internal = this.internalJob(jobId);
    const params = new URLSearchParams({ kind: String(kind || 'comments'), offset: String(offset), limit: String(limit), ...(postId ? { postId: String(postId) } : {}), ...(query ? { query: String(query) } : {}) });
    const lineage = audienceJobLineage(this.manager, internal.id);
    const sourceJobId = lineage.at(-1) || internal.id;
    const readableCheckpoints = audienceHistoryJobIds(this.manager, sourceJobId, internal.id)
      .map((id) => ({ id, outputDir: this.manager.getInternal?.(id)?.outputDir }))
      .filter((item) => item.outputDir);
    const primary = readableCheckpoints.at(-1) || { id: internal.id, outputDir: internal.outputDir };
    const fallbackOutputDirs = readableCheckpoints.slice(0, -1).map((item) => item.outputDir);
    const result = await readAudienceResults(primary.outputDir, params, { fallbackOutputDirs });
    return {
      jobId: internal.id,
      sourceJobId,
      checkpointJobId: internal.id,
      readThroughJobIds: lineage,
      mergedCheckpointJobIds: readableCheckpoints.map((item) => item.id),
      ...result,
    };
  }

  async listProfiles() {
    return { profiles: this.profileStore?.list ? await this.profileStore.list() : [] };
  }

  async createContextBundle({ jobId, title = '' } = {}) {
    const internal = this.internalJob(jobId);
    if (!this.xhsContextService?.createBundleFromJob) throw new CodexProductServiceError('CODEX_PRODUCT_CONTEXT_UNAVAILABLE', 'The local context index is unavailable.', 503);
    return this.xhsContextService.createBundleFromJob({ jobId: internal.id, outputDir: internal.outputDir, title });
  }

  searchContext({ bundleId, query, limit = 50 } = {}) {
    if (!this.xhsContextService?.search) throw new CodexProductServiceError('CODEX_PRODUCT_CONTEXT_UNAVAILABLE', 'The local context index is unavailable.', 503);
    return this.xhsContextService.search(String(bundleId || ''), query, { limit });
  }

  openContextRecord({ recordId } = {}) {
    if (!this.xhsContextService?.openRecord) throw new CodexProductServiceError('CODEX_PRODUCT_CONTEXT_UNAVAILABLE', 'The local context index is unavailable.', 503);
    return this.xhsContextService.openRecord(String(recordId || ''));
  }

  async startCollection({ params = {}, queueIfBusy = false, idempotencyKey = '' } = {}) {
    let validated;
    try {
      validated = validateRunRequest(params);
    } catch (error) {
      throw new CodexProductServiceError('CODEX_PRODUCT_REQUEST_INVALID', error.message, 400, error.details);
    }
    return { action: 'started', job: await this.manager.start(validated, { queueIfBusy: Boolean(queueIfBusy), requestedBy: 'codex_product_mcp', idempotencyKey: String(idempotencyKey || '').trim() || undefined }) };
  }

  async resumeJob({ jobId, scope = 'full', aiSessionId, idempotencyKey = '' } = {}) {
    const id = requireJobId(jobId);
    const normalizedScope = String(scope || 'full');
    if (!RESUME_SCOPES.has(normalizedScope)) throw new CodexProductServiceError('CODEX_PRODUCT_RESUME_SCOPE_INVALID', 'The resume scope is invalid.', 400);
    const job = await this.manager.resume(id, {
      scope: normalizedScope,
      ...(aiSessionId == null ? {} : { aiSessionId: String(aiSessionId) }),
      ...(idempotencyKey ? { idempotencyKey: String(idempotencyKey) } : {}),
      requestedBy: 'codex_product_mcp',
    });
    return { action: 'resumed', job };
  }

  async cancelJob({ jobId } = {}) {
    const id = requireJobId(jobId);
    return { action: 'cancelled', ...(await this.manager.cancel(id)) };
  }

  internalJob(jobId) {
    const id = requireJobId(jobId);
    const job = this.manager.getInternal(id);
    if (!job) throw new CodexProductServiceError('CODEX_PRODUCT_JOB_NOT_FOUND', 'The requested job was not found.', 404);
    return job;
  }
}

function jobListSummary(job) {
  return {
    id: job.id,
    keyword: job.keyword,
    status: job.status,
    progress: job.progress,
    progressPhase: job.progressPhase,
    progressLabel: job.progressLabel,
    message: job.message,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    activeAttemptId: job.activeAttemptId,
    currentAttemptId: job.currentAttemptId,
    resumeCount: job.resumeCount,
    resumeAvailable: job.resumeAvailable,
    artifactCount: job.artifactCount,
    applicationCount: job.applicationCount,
    discoveredCount: job.discoveredCount,
    scrapedCount: job.scrapedCount,
    incompleteCount: job.incompleteCount,
  };
}

export const TOOL_DEFINITIONS = Object.freeze([
  { name: 'product_status', description: 'Read the health and current workload of this product, including active jobs and context indexes.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_workspaces', description: 'List the writable product source workspace and every historical task workspace.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_workspace', description: 'Read one product workspace or the complete workspace map.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' } } } },
  { name: 'read_source_manifest', description: 'Read a bounded manifest of source files available in the product workspace.', inputSchema: { type: 'object', properties: { maxFiles: { type: 'integer' }, maxBytes: { type: 'integer' } } } },
  { name: 'list_jobs', description: 'List persisted Xiaohongshu collection and analysis jobs with their current status and progress.', inputSchema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'search_jobs', description: 'Search persisted product jobs by keyword across their public metadata and workflow summaries.', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'get_job', description: 'Read one product job, including workflow stages, attempts, progress, and resumability metadata.', inputSchema: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' } } } },
  { name: 'list_job_artifacts', description: 'List files produced by a product job.', inputSchema: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'read_job_artifact', description: 'Read a bounded text artifact from a product job; binary artifacts return metadata only.', inputSchema: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' }, artifactId: { type: 'string' }, path: { type: 'string' }, maxBytes: { type: 'integer' } } } },
  { name: 'get_audience_results', description: 'Read normalized audience comments or users for a product job with filters and pagination.', inputSchema: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' }, kind: { type: 'string', enum: ['comments', 'users'] }, postId: { type: 'string' }, query: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } } } },
  { name: 'list_profiles', description: 'List configured local collection profiles without exposing credentials.', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_context_bundle', description: 'Build or reuse an immutable searchable context bundle from a product job.', inputSchema: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' }, title: { type: 'string' } } } },
  { name: 'list_context_bundles', description: 'List searchable immutable context bundles built from product jobs.', inputSchema: { type: 'object', properties: {} } },
  { name: 'search_context', description: 'Search indexed product records by tokenized query.', inputSchema: { type: 'object', required: ['bundleId', 'query'], properties: { bundleId: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'open_context_record', description: 'Open one indexed product record with its source path and content.', inputSchema: { type: 'object', required: ['recordId'], properties: { recordId: { type: 'string' } } } },
  { name: 'start_collection', description: 'Start a validated new product collection or analysis job using the product runtime.', inputSchema: { type: 'object', required: ['params'], properties: { params: { type: 'object' }, queueIfBusy: { type: 'boolean' }, idempotencyKey: { type: 'string' } } } },
  { name: 'resume_job', description: 'Resume a persisted product job at a bounded workflow scope.', inputSchema: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' }, scope: { type: 'string', enum: [...RESUME_SCOPES] }, aiSessionId: { type: 'string' }, idempotencyKey: { type: 'string' } } } },
  { name: 'cancel_job', description: 'Request cancellation of a running or queued product job.', inputSchema: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' } } } },
]);

export const PRODUCT_RESOURCES = Object.freeze([
  { uri: 'codex-product://status', name: 'product-status', title: 'Current product status', description: 'Current product workload, active tasks, and context index counts.', mimeType: 'application/json' },
  { uri: 'codex-product://workspace', name: 'product-workspace', title: 'Product workspace map', description: 'Writable source workspace and all historical task workspaces.', mimeType: 'application/json' },
  { uri: 'codex-product://workspace/source', name: 'product-source-manifest', title: 'Product source manifest', description: 'Bounded source-file manifest for the writable product workspace.', mimeType: 'application/json' },
  { uri: 'codex-product://jobs', name: 'product-jobs', title: 'Product jobs', description: 'Persisted collection and analysis jobs available to the product Codex.', mimeType: 'application/json' },
]);

export const PRODUCT_RESOURCE_TEMPLATES = Object.freeze([
  { uriTemplate: 'codex-product://jobs/{jobId}', name: 'product-job', title: 'Product job', description: 'One product job with workflow, progress, and resumability metadata.', mimeType: 'application/json' },
  { uriTemplate: 'codex-product://jobs/{jobId}/audience', name: 'product-job-audience', title: 'Job audience results', description: 'Merged audience summary and normalized comments/users for a product job.', mimeType: 'application/json' },
  { uriTemplate: 'codex-product://jobs/{jobId}/artifacts/{artifactId}', name: 'product-job-artifact', title: 'Job artifact', description: 'A bounded text artifact or binary artifact metadata from a product job.', mimeType: 'application/json' },
]);

function requireJobId(value) {
  const id = String(value || '').trim();
  if (!JOB_ID.test(id)) throw new CodexProductServiceError('CODEX_PRODUCT_JOB_ID_INVALID', 'The job id is invalid.', 400);
  return id;
}

function boundedLimit(value) {
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Number(value) || 50));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function safeEqualSecret(expected, actual) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(actual || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isLoopbackAddress(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '::1' || normalized.startsWith('127.') || normalized.startsWith('::ffff:127.');
}

function isLoopbackHost(value) {
  try {
    const host = new URL(`http://${String(value || '').trim()}`).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  } catch {
    return false;
  }
}

function decodeUriSegment(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

function resourceDocument(uri, value) {
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value) }] };
}

function publicWorkspaceProject(project) {
  if (!project || typeof project !== 'object') return null;
  const { rootPaths: _rootPaths, ...safeProject } = project;
  return safeProject;
}

function audienceHistoryJobIds(manager, sourceJobId, requestedJobId = sourceJobId) {
  const ordered = [sourceJobId];
  const seen = new Set(ordered);
  const oldestFirst = [...manager.list()].reverse();
  for (const job of oldestFirst) {
    if (!job.config?.audienceOnly) continue;
    if (audienceContentSourceJobId(manager, job.id) !== sourceJobId) continue;
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    ordered.push(job.id);
  }
  for (const id of audienceJobLineage(manager, requestedJobId).reverse()) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  return ordered;
}

function audienceContentSourceJobId(manager, jobId) {
  return audienceJobLineage(manager, jobId).at(-1) || jobId;
}

function audienceJobLineage(manager, jobId) {
  const lineage = [];
  const visited = new Set();
  let currentId = jobId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    lineage.push(currentId);
    const current = manager.getInternal?.(currentId);
    if (!current?.params?.audienceOnly || !current.params.resumeFromJobId) break;
    currentId = current.params.resumeFromJobId;
  }
  return lineage;
}
