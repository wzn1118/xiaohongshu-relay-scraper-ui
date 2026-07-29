import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createApp } from './app.mjs';

test('application results hydrate images and filter the full result set by publish time', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-results-'));
  const outputDir = path.join(fixture, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
  const base = {
    note_url: 'https://www.xiaohongshu.com/explore/test',
    access_status: 'success',
    collected_at: new Date().toISOString(),
    application_info: { contacts: [], application_routes: [], responsibilities: [], requirements: [] },
    outreach: { greeting: 'g', email_subject: 's', email_body: 'b', cover_letter: 'c', generation_mode: 'test', runtime_status: 'completed', status: 'ready' },
    quality: { job_card_generated: true },
  };
  await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
    records: [
      { ...base, note_id: 'recent', title: '最新岗位', body: '', publish_time: { raw: recent, value: recent, precision: 'minute', is_estimated: false }, job_card: { parse_basis: 'search_card' }, outreach: { ...base.outreach, runtime_status: 'fallback_missing_job_body' } },
      { ...base, note_id: 'old', title: '较早岗位', body: '完整正文', publish_time: { raw: old, value: old, precision: 'minute', is_estimated: false }, job_card: { parse_basis: 'full_body' } },
      { ...base, note_id: 'unknown', title: '日期待确认', body: '完整正文', publish_time: { raw: '', value: '', precision: 'unknown', is_estimated: false }, job_card: { parse_basis: 'full_body' } },
    ],
  }), 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify([{
    note_id: 'recent',
    card_cover_url: 'https://img.example/cover.jpg',
    card_image_urls: 'https://img.example/cover.jpg | https://img.example/second.jpg | https://sns-avatar.example/avatar/user.jpg',
  }]), 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), '[]', 'utf8');

  const id = '20260729080000-abcdef12';
  const internal = { id, outputDir, config: {} };
  const manager = {
    active: null,
    list: () => [],
    get: (jobId) => jobId === id ? internal : null,
    getInternal: (jobId) => jobId === id ? internal : null,
  };
  const server = http.createServer(createApp({
    manager,
    config: { host: '127.0.0.1', port: 0, maxBodyBytes: 4096, runnerAvailable: true },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const all = await fetch(`${origin}/api/jobs/${id}/results?sort=newest`).then((response) => response.json());
    assert.deepEqual(all.items.map((item) => item.note_id), ['recent', 'old', 'unknown']);
    assert.equal(all.filters.stats.incomplete, 1);
    assert.equal(all.filters.stats.withImages, 1);
    assert.equal(all.items[0].media.images.length, 2);

    const oldest = await fetch(`${origin}/api/jobs/${id}/results?sort=oldest`).then((response) => response.json());
    assert.deepEqual(oldest.items.map((item) => item.note_id), ['old', 'recent', 'unknown']);

    const recentOnly = await fetch(`${origin}/api/jobs/${id}/results?timeRange=7`).then((response) => response.json());
    assert.deepEqual(recentOnly.items.map((item) => item.note_id), ['recent']);

    const unknownOnly = await fetch(`${origin}/api/jobs/${id}/results?timeRange=unknown`).then((response) => response.json());
    assert.deepEqual(unknownOnly.items.map((item) => item.note_id), ['unknown']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  }
});
