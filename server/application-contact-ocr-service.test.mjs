import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { ApplicationContactOcrService } from './application-contact-ocr-service.mjs';

test('starts one resumable local OCR process and attaches duplicate requests', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-contact-ocr-service-'));
  const outputDir = path.join(fixture, 'artifacts');
  const scriptPath = path.join(fixture, 'resolve_application_contacts.py');
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(scriptPath, '# fixture\n', 'utf8'),
    writeFile(path.join(outputDir, 'application_intelligence.json'), '{"records":[]}', 'utf8'),
  ]);
  t.after(() => rm(fixture, { recursive: true, force: true }));

  const calls = [];
  const child = new EventEmitter();
  child.pid = 45678;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const service = new ApplicationContactOcrService({
    config: {
      projectRoot: fixture,
      applicationContactOcrPath: scriptPath,
      aiConfigPath: path.join(fixture, 'ai-config.json'),
      applicationContactOcrTimeoutSeconds: 90,
      applicationContactOcrCheckpointEvery: 3,
      applicationContactOcrMaxAttempts: 2,
      applicationContactOcrConcurrency: 3,
      applicationContactOcrPrefetchConcurrency: 14,
      applicationContactOcrBaseUrls: ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11435/v1'],
      applicationContactOcrModel: 'qwen2.5vl:3b',
      applicationContactOcrContextTokens: 4096,
      applicationContactOcrMaxOutputTokens: 512,
      applicationContactOcrKeepAlive: '45m',
    },
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
  });

  const started = await service.start(outputDir, {
    force: true,
    maxRecords: 7,
    noteIds: ['post-1', 'post-1', 'bad id!'],
  });
  const attached = await service.start(outputDir);

  assert.equal(started.action, 'started');
  assert.equal(attached.action, 'attached');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(calls[0].args.slice(-5), ['--max-records', '7', '--force', '--note-id', 'post-1']);
  assert.equal(calls[0].args.includes('--timeout-seconds'), true);
  assert.equal(calls[0].args.includes('--checkpoint-every'), true);
  assert.equal(calls[0].args.includes('--max-attempts'), true);
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf('--concurrency'), calls[0].args.indexOf('--concurrency') + 2), ['--concurrency', '3']);
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf('--prefetch-concurrency'), calls[0].args.indexOf('--prefetch-concurrency') + 2), ['--prefetch-concurrency', '14']);
  assert.equal(calls[0].args.filter((value) => value === '--base-url').length, 2);
  assert.equal(calls[0].args.includes('http://127.0.0.1:11435/v1'), true);
  assert.equal(calls[0].options.env.XHS_APPLICATION_CONTACT_OCR_MODEL, 'qwen2.5vl:3b');
  assert.equal(calls[0].options.env.XHS_APPLICATION_CONTACT_OCR_CONTEXT_TOKENS, '4096');
  assert.equal(calls[0].options.env.XHS_APPLICATION_CONTACT_OCR_MAX_OUTPUT_TOKENS, '512');
  assert.equal(calls[0].options.env.XHS_AI_KEEP_ALIVE, '45m');

  child.emit('close', 0, null);
});

test('watch mode passes incremental collection flags to the worker', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-contact-ocr-watch-'));
  const outputDir = path.join(fixture, 'artifacts');
  const scriptPath = path.join(fixture, 'resolve_application_contacts.py');
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(scriptPath, '# fixture\n', 'utf8'),
    writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), '[]', 'utf8'),
  ]);
  t.after(() => rm(fixture, { recursive: true, force: true }));

  const child = new EventEmitter();
  child.pid = 45679;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const calls = [];
  const service = new ApplicationContactOcrService({
    config: { projectRoot: fixture, applicationContactOcrPath: scriptPath },
    spawnImpl: (command, args) => {
      calls.push({ command, args });
      return child;
    },
  });

  await service.start(outputDir, { watch: true, pollSeconds: 1 });
  const watchIndex = calls[0].args.indexOf('--watch');
  assert.ok(watchIndex >= 0);
  assert.deepEqual(calls[0].args.slice(watchIndex, watchIndex + 6), [
    '--watch', '--poll-seconds', '1', '--watch-idle-exit-seconds', '0',
  ]);
  child.emit('close', 0, null);
});

test('reattaches a persisted live watcher after the API service restarts', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-contact-ocr-reattach-'));
  const outputDir = path.join(fixture, 'artifacts');
  const scriptPath = path.join(fixture, 'resolve_application_contacts.py');
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(scriptPath, '# fixture\n', 'utf8'),
    writeFile(path.join(outputDir, 'application_intelligence.json'), '{"records":[]}', 'utf8'),
    writeFile(path.join(outputDir, 'contact-resolution-job.json'), JSON.stringify({
      schemaVersion: 1,
      jobId: 'persisted-watcher',
      status: 'watching',
      pid: process.pid,
    }), 'utf8'),
  ]);
  t.after(() => rm(fixture, { recursive: true, force: true }));

  let spawnCount = 0;
  const service = new ApplicationContactOcrService({
    config: { projectRoot: fixture, applicationContactOcrPath: scriptPath },
    spawnImpl: () => {
      spawnCount += 1;
      throw new Error('should not spawn');
    },
  });

  const result = await service.start(outputDir, { watch: true });

  assert.equal(result.action, 'attached');
  assert.equal(result.state.active, true);
  assert.equal(result.state.jobId, 'persisted-watcher');
  assert.equal(spawnCount, 0);
});
