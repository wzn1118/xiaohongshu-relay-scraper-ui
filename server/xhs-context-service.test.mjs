import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { XhsContextService } from './xhs-context-service.mjs';

test('XhsContextService creates a content-addressed bundle and searches records', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xhs-context-service-'));
  const outputDir = path.join(root, 'artifacts');
  const contextDir = path.join(root, 'context');
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'notes.json'), JSON.stringify([
    { note_id: 'n-1', title: 'Codex relay', body: 'Local semantic session context.' },
    { note_id: 'n-2', title: 'Other note', body: 'A separate source.' },
  ]));
  await writeFile(path.join(outputDir, 'photo.png'), Buffer.from('not-a-real-image'));
  const service = new XhsContextService({ rootDir: contextDir });
  t.after(async () => {
    service.close();
    await rm(root, { recursive: true, force: true });
  });

  const bundle = await service.createBundleFromJob({ jobId: 'job-1', outputDir, title: 'Test bundle' });
  assert.equal(bundle.title, 'Test bundle');
  assert.equal(bundle.fileCount, 2);
  assert.equal(bundle.recordCount, 2);
  assert.equal(bundle.indexMode, 'token-index');
  assert.equal(bundle.files.find((file) => file.path === 'photo.png').mode, 'lazy');
  assert.equal(service.listBundles().length, 1);

  const reused = await service.createBundleFromJob({ jobId: 'job-1', outputDir, title: 'Test bundle' });
  assert.equal(reused.bundleId, bundle.bundleId);
  const results = service.search(bundle.bundleId, 'semantic session');
  assert.equal(results.results.length, 1);
  const record = service.openRecord(results.results[0].recordId);
  assert.match(record.body, /semantic session/);
  const artifact = await service.readArtifact(bundle.bundleId, 'notes.json');
  assert.match(artifact.content, /Codex relay/);
  assert.equal(service.verify(bundle.bundleId).verified, true);
  const tools = await service.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(tools.result.tools.length, 8);
  const resources = await service.handleMcpRequest({ jsonrpc: '2.0', id: 'resources', method: 'resources/list' });
  assert.deepEqual(resources.result.resources, []);
  const resourceTemplates = await service.handleMcpRequest({ jsonrpc: '2.0', id: 'resource-templates', method: 'resources/templates/list' });
  assert.deepEqual(resourceTemplates.result.resourceTemplates, []);
  const rpcSearch = await service.handleMcpRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'search', arguments: { bundleId: bundle.bundleId, query: 'semantic' } },
  });
  assert.equal(rpcSearch.result.structuredContent.results.length, 1);
  const localRequest = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { host: '127.0.0.1:4317' } };
  assert.doesNotThrow(() => service.authorizeHttp(localRequest, service.localToken));
  assert.throws(() => service.authorizeHttp(localRequest, 'wrong-token'), { code: 'XHS_CONTEXT_TOKEN_INVALID' });
  assert.equal((await service.readArtifact(bundle.bundleId, 'photo.png')).mode, 'lazy');
  assert.equal(JSON.parse(await readFile(path.join(contextDir, 'bundles', bundle.bundleId, 'manifest.json'), 'utf8')).manifestHash, bundle.manifestHash);
});

test('XhsContextService detects a modified cached chunk', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xhs-context-integrity-'));
  const outputDir = path.join(root, 'artifacts');
  const contextDir = path.join(root, 'context');
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'note.txt'), 'immutable context');
  const service = new XhsContextService({ rootDir: contextDir });
  t.after(async () => {
    service.close();
    await rm(root, { recursive: true, force: true });
  });
  const bundle = await service.createBundleFromJob({ jobId: 'job-2', outputDir });
  const chunkHash = bundle.files.find((file) => file.path === 'note.txt').chunkHash;
  await writeFile(path.join(contextDir, 'chunks', chunkHash), 'changed');
  const verified = service.verify(bundle.bundleId);
  assert.equal(verified.verified, false);
  assert.equal(verified.errors[0].code, 'CHUNK_HASH_MISMATCH');
});
