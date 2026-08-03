import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobManager } from './job-manager.mjs';
import { validateBodyImportRequest } from './lib/body-import.mjs';

const note = (id, title = '') => ({
  note_id: id,
  note_url: `https://www.xiaohongshu.com/search_result/${id}?xsec_token=token`,
  explore_url: `https://www.xiaohongshu.com/explore/${id}`,
  title,
});

test('body import normalizes records, preserves signed URLs, and deduplicates note ids', () => {
  const firstId = '6a6e1a34000000002402fef4';
  const secondId = '6a6e1a34000000002402fef5';
  const result = validateBodyImportRequest({
    sourceName: 'batch.json',
    analysisMode: 'job',
    records: [note(firstId, 'first'), note(firstId, 'duplicate'), note(secondId, 'second')],
    options: { relayPort: 18800, speedMode: 'random', randomDelayMinSeconds: 1, randomDelayMaxSeconds: 3, maxAgeDays: 14 },
  });

  assert.equal(result.summary.receivedCount, 3);
  assert.equal(result.summary.acceptedCount, 2);
  assert.equal(result.summary.duplicateCount, 1);
  assert.equal(result.summary.rejectedCount, 0);
  assert.equal(result.cards[0].note_url.includes('xsec_token=token'), true);
  assert.equal(result.params.bodyOnly, true);
  assert.equal(result.params.mode, 'resume');
  assert.equal(result.params.analysisMode, 'job');
  assert.equal(result.params.maxAgeDays, 14);
  assert.match(result.params.keyword, /2 条/);
});

test('body import derives ids and reports invalid rows without discarding valid rows', () => {
  const id = '6a6e1a34000000002402fef6';
  const result = validateBodyImportRequest({
    records: [
      { note_url: `https://www.xiaohongshu.com/explore/${id}` },
      { note_id: 'bad', note_url: 'https://example.com/not-a-note' },
    ],
  });

  assert.equal(result.cards[0].note_id, id);
  assert.equal(result.summary.acceptedCount, 1);
  assert.equal(result.summary.rejectedCount, 1);
});

test('body import accepts delimited string fields from front-end card exports', () => {
  const id = '6a6e1a34000000002402fef7';
  const result = validateBodyImportRequest({
    records: [{
      ...note(id),
      card_tags: '',
      card_link_urls: `https://www.xiaohongshu.com/explore/${id} | https://www.xiaohongshu.com/search_result/${id}`,
      card_image_urls: 'https://example.com/image?format=webp|imageMogr2/strip',
      card_text_segments: 'title | author | published',
    }],
  });

  assert.deepEqual(result.cards[0].card_tags, []);
  assert.equal(result.cards[0].card_link_urls.length, 2);
  assert.deepEqual(result.cards[0].card_image_urls, ['https://example.com/image?format=webp|imageMogr2/strip']);
  assert.deepEqual(result.cards[0].card_text_segments, ['title', 'author', 'published']);
});

test('body import rejects empty or oversized requests', () => {
  assert.throws(() => validateBodyImportRequest({ records: [] }), /1-5000/);
  assert.throws(() => validateBodyImportRequest({ records: Array.from({ length: 5001 }, () => ({})) }), /1-5000/);
});

test('JobManager seeds imported cards and starts directly in body completion mode', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'xhs-body-import-'));
  const runnerPath = path.join(dataDir, 'runner.py');
  await writeFile(runnerPath, '', 'utf8');
  const child = new EventEmitter();
  child.pid = 48021;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  let runnerArgs = null;
  const manager = new JobManager({
    dataDir,
    pythonBin: 'python',
    runnerPath,
    spawnImpl: (_command, args) => {
      runnerArgs = args;
      return child;
    },
    terminateImpl: async (target) => target.kill('SIGTERM'),
  });

  try {
    await manager.initialize();
    const input = validateBodyImportRequest({ records: [note('6a6e1a34000000002402fef8'), note('6a6e1a34000000002402fef9')] });
    const job = await manager.startImportedBodies(input.params, input.cards);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(job.config.bodyOnly, true);
    assert.equal(job.progressTotal, 2);
    assert.equal(job.discoveredCount, 2);
    assert.ok(runnerArgs.includes('--body-only'));
    assert.ok(runnerArgs.includes('--resume-scope'));
    assert.equal(runnerArgs[runnerArgs.indexOf('--resume-scope') + 1], 'body_completion');
    const savedCards = JSON.parse(await readFile(path.join(job.outputDir, 'xiaohongshu_cards_latest.json'), 'utf8'));
    assert.deepEqual(savedCards.map((card) => card.note_id), input.cards.map((card) => card.note_id));
    const state = JSON.parse(await readFile(path.join(path.dirname(job.outputDir), 'workflow-state.json'), 'utf8'));
    assert.equal(state.attempts[0].resumeScope, 'body_completion');
    assert.equal(state.stages.discovery.status, 'completed');
    assert.equal(Object.keys(state.stages.bodyCompletion.records).length, 2);
  } finally {
    await manager.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});
