import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCodexProductService, PRODUCT_RESOURCES, PRODUCT_RESOURCE_TEMPLATES, TOOL_DEFINITIONS } from './codex-product-service.mjs';
import { XhsContextService } from './xhs-context-service.mjs';

const JOB_ID = '20260818123456-abcdef12';

test('codex-product exposes internal product data and validated workflow actions through MCP', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-product-'));
  const outputDir = path.join(root, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, 'notes.json'), JSON.stringify([{ note_id: 'n-1', title: 'Codex product integration', body: 'Internal product context.' }])),
    writeFile(path.join(outputDir, 'audience-posts.json'), JSON.stringify([{ post_id: 'n-1', title: 'Codex product integration', note_url: 'https://example.test/n-1' }])),
    writeFile(path.join(outputDir, 'audience-comments.json'), JSON.stringify([{ comment_id: 'c-1', post_id: 'n-1', text: 'The internal tool is useful.', user: { user_id: 'u-1', display_name: 'User One' } }])),
    writeFile(path.join(outputDir, 'audience-users.json'), JSON.stringify([{ user_id: 'u-1', display_name: 'User One', post_ids: ['n-1'] }])),
    writeFile(path.join(outputDir, 'preview.png'), Buffer.from('binary')),
  ]);
  const job = { id: JOB_ID, status: 'succeeded', progress: 100, keyword: 'Codex', outputDir, workflowSummary: { discovered: 1 } };
  const calls = [];
  const manager = {
    active: null,
    list: () => [{ id: job.id, status: job.status, progress: job.progress, keyword: job.keyword, workflowSummary: job.workflowSummary }],
    get: (id) => id === job.id ? { id: job.id, status: job.status, progress: job.progress, keyword: job.keyword, workflowSummary: job.workflowSummary } : null,
    getInternal: (id) => id === job.id ? job : null,
    start: async (params, options) => { calls.push(['start', params, options]); return { id: '20260818130000-1234abcd', status: 'queued', params }; },
    resume: async (id, options) => { calls.push(['resume', id, options]); return { id, status: 'resuming', attemptId: 'attempt-2' }; },
    cancel: async (id) => { calls.push(['cancel', id]); return { found: true, changed: true, job: { id, status: 'cancelling' } }; },
  };
  const context = new XhsContextService({ rootDir: path.join(root, 'context') });
  const workspace = {
    status: () => ({ schemaVersion: 1, sourceProjectId: 'source-1', sourceProjectName: 'Product source', historyProjects: 1, activeJobId: JOB_ID, generatedAt: '2026-08-18T00:00:00.000Z' }),
    publicSnapshot: () => ({ schemaVersion: 1, source: { id: 'source-1', name: 'Product source', kind: 'source', metadata: { writable: true } }, history: [], activeJobId: JOB_ID, generatedAt: '2026-08-18T00:00:00.000Z' }),
    project: (id) => id === 'source-1' ? { id: 'source-1', name: 'Product source', kind: 'source', rootPaths: [root], metadata: { writable: true } } : null,
    sourceManifest: async () => ({ schemaVersion: 1, project: { id: 'source-1', name: 'Product source' }, files: [{ path: 'server/index.mjs', size: 10 }], fileCount: 1, totalBytes: 10, truncated: false }),
  };
  const service = createCodexProductService({
    manager,
    xhsContextService: context,
    workspaceService: workspace,
    profileStore: { list: async () => [{ id: 'profile-1', name: 'Default' }] },
    token: 'product-token',
  });
  t.after(async () => {
    context.close();
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(service.status().jobs, 1);
  assert.equal(service.status().workspace.sourceProjectId, 'source-1');
  assert.equal((await service.callTool('list_workspaces')).source.id, 'source-1');
  const selectedWorkspace = await service.callTool('get_workspace', { projectId: 'source-1' });
  assert.equal(selectedWorkspace.workspace.id, 'source-1');
  assert.equal('rootPaths' in selectedWorkspace.workspace, false);
  assert.equal((await service.callTool('read_source_manifest')).files[0].path, 'server/index.mjs');
  assert.equal(service.listJobs().jobs[0].id, JOB_ID);
  assert.equal(service.searchJobs({ query: 'codex' }).jobs.length, 1);
  assert.equal(service.getJob({ jobId: JOB_ID }).job.progress, 100);
  const artifacts = await service.listJobArtifacts({ jobId: JOB_ID });
  assert.ok(artifacts.artifacts.some((artifact) => artifact.path === 'notes.json'));
  const text = await service.readJobArtifact({ jobId: JOB_ID, path: 'notes.json' });
  assert.equal(text.readable, true);
  assert.match(text.content, /Internal product context/);
  const binary = await service.readJobArtifact({ jobId: JOB_ID, path: 'preview.png' });
  assert.equal(binary.readable, false);
  assert.equal(binary.content, null);

  const audience = await service.getAudienceResults({ jobId: JOB_ID, kind: 'comments', query: 'useful' });
  assert.equal(audience.total, 1);
  assert.equal(audience.items[0].user.display_name, 'User One');
  assert.equal((await service.listProfiles()).profiles[0].id, 'profile-1');

  const bundle = await service.createContextBundle({ jobId: JOB_ID, title: 'Product data' });
  assert.equal(bundle.sourceJobId, JOB_ID);
  assert.equal((await service.callTool('list_context_bundles')).bundles.length, 1);
  const found = service.searchContext({ bundleId: bundle.bundleId, query: 'Internal product' });
  assert.ok(found.results.length >= 1);
  const contextRecord = found.results
    .map((result) => service.openContextRecord({ recordId: result.recordId }))
    .find((record) => record.body.includes('Internal product context'));
  assert.ok(contextRecord);

  const started = await service.startCollection({ params: { keyword: 'AI product manager' }, queueIfBusy: true, idempotencyKey: 'codex-start-1' });
  assert.equal(started.job.status, 'queued');
  assert.equal(calls[0][1].searchSort, 'latest');
  assert.equal(calls[0][2].requestedBy, 'codex_product_mcp');
  assert.equal(calls[0][2].pauseActive, false);
  await service.startCollection({ params: { keyword: 'New task' }, idempotencyKey: 'codex-start-2' });
  assert.equal(calls[1][2].pauseActive, true);
  const resumed = await service.resumeJob({ jobId: JOB_ID, scope: 'analysis', idempotencyKey: 'codex-resume-1' });
  assert.equal(resumed.job.status, 'resuming');
  assert.equal(calls[2][2].scope, 'analysis');
  const cancelled = await service.cancelJob({ jobId: JOB_ID });
  assert.equal(cancelled.changed, true);

  const tools = await service.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(tools.result.tools.length, TOOL_DEFINITIONS.length);
  const rpc = await service.handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'product_status', arguments: {} } });
  assert.equal(rpc.result.structuredContent.service, 'codex-product');
  const listedResources = await service.handleMcpRequest({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
  assert.equal(listedResources.result.resources.length, PRODUCT_RESOURCES.length);
  const listedTemplates = await service.handleMcpRequest({ jsonrpc: '2.0', id: 4, method: 'resources/templates/list' });
  assert.equal(listedTemplates.result.resourceTemplates.length, PRODUCT_RESOURCE_TEMPLATES.length);
  const jobResource = await service.handleMcpRequest({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: `codex-product://jobs/${JOB_ID}` } });
  assert.equal(JSON.parse(jobResource.result.contents[0].text).job.id, JOB_ID);
  const audienceResource = await service.handleMcpRequest({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: `codex-product://jobs/${JOB_ID}/audience` } });
  assert.equal(JSON.parse(audienceResource.result.contents[0].text).total, 1);
  const workspaceResource = await service.handleMcpRequest({ jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'codex-product://workspace' } });
  assert.equal(JSON.parse(workspaceResource.result.contents[0].text).source.id, 'source-1');
  const sourceResource = await service.handleMcpRequest({ jsonrpc: '2.0', id: 8, method: 'resources/read', params: { uri: 'codex-product://workspace/source' } });
  assert.equal(JSON.parse(sourceResource.result.contents[0].text).files[0].path, 'server/index.mjs');
  const localRequest = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { host: '127.0.0.1:46291' } };
  assert.doesNotThrow(() => service.authorizeHttp(localRequest, 'product-token'));
  assert.throws(() => service.authorizeHttp(localRequest, 'wrong'), { code: 'CODEX_PRODUCT_TOKEN_INVALID' });
});

test('codex-product rejects invalid job ids and unvalidated collection parameters', async () => {
  const service = createCodexProductService({
    manager: { list: () => [], get: () => null, getInternal: () => null },
    token: 'product-token',
  });
  assert.throws(() => service.getJob({ jobId: '../job' }), { code: 'CODEX_PRODUCT_JOB_ID_INVALID' });
  await assert.rejects(
    service.startCollection({ params: { keyword: 'test', unexpected: true } }),
    { code: 'CODEX_PRODUCT_REQUEST_INVALID' },
  );
});

test('codex-product merges audience checkpoint lineage like the product audience view', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-product-lineage-'));
  const sourceDir = path.join(root, 'source');
  const checkpointDir = path.join(root, 'checkpoint');
  await Promise.all([
    mkdir(sourceDir, { recursive: true }),
    mkdir(checkpointDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(sourceDir, 'audience-posts.json'), JSON.stringify([{ post_id: 'n-1', title: 'Source post', note_url: 'https://example.test/n-1' }])),
    writeFile(path.join(sourceDir, 'audience-comments.json'), JSON.stringify([{ comment_id: 'c-source', post_id: 'n-1', text: 'source comment', user_id: 'u-1' }])),
    writeFile(path.join(checkpointDir, 'audience-comments.json'), JSON.stringify([{ comment_id: 'c-checkpoint', post_id: 'n-1', text: 'checkpoint comment', user_id: 'u-2' }])),
  ]);
  const sourceId = '20260818140000-abcdef12';
  const checkpointId = '20260818140100-abcdef13';
  const source = { id: sourceId, status: 'succeeded', outputDir: sourceDir, params: { keyword: 'lineage' }, config: {} };
  const checkpoint = {
    id: checkpointId,
    status: 'succeeded',
    outputDir: checkpointDir,
    params: { audienceOnly: true, resumeFromJobId: sourceId },
    config: { audienceOnly: true },
  };
  const jobs = [source, checkpoint];
  const manager = {
    list: () => jobs.map(({ id, status, config }) => ({ id, status, config })),
    get: (id) => jobs.find((job) => job.id === id) || null,
    getInternal: (id) => jobs.find((job) => job.id === id) || null,
  };
  const service = createCodexProductService({ manager });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await service.getAudienceResults({ jobId: checkpointId, kind: 'comments', limit: 20 });
  assert.deepEqual(result.readThroughJobIds, [checkpointId, sourceId]);
  assert.deepEqual(result.mergedCheckpointJobIds, [sourceId, checkpointId]);
  assert.equal(result.sourceJobId, sourceId);
  assert.equal(result.total, 2);
  assert.deepEqual(result.items.map((item) => item.comment_id), ['c-source', 'c-checkpoint']);
});
