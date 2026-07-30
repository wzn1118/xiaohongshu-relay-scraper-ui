import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createApp, isIncompleteApplicationRecord, isIncompleteGeneralRecord } from './app.mjs';

test('cached verified poster text remains incomplete until merged into official job fields', () => {
  const cached = {
    body: '标题式正文',
    job_card: { parse_basis: 'full_body', enrichment_status: 'ai_enriched' },
    application_info: { responsibilities: [], requirements: [], application_routes: [] },
    media: { analysis: { status: 'analyzed', source: 'vision_model', visible_text: 'HC要求\n香港院校在读' } },
    outreach: { runtime_status: 'completed' },
  };
  assert.equal(isIncompleteApplicationRecord(cached), true);
  assert.equal(isIncompleteApplicationRecord({
    ...cached,
    job_card: { ...cached.job_card, enrichment_status: 'image_enriched' },
    application_info: { ...cached.application_info, requirements: [{ text: '香港院校在读' }] },
  }), false);
});

test('general content completeness depends on AI modules and vision rather than job fields', () => {
  const record = {
    body: '一篇关于城市展览的完整正文',
    application_info: { responsibilities: [], requirements: [], application_routes: [] },
    outreach: { runtime_status: 'fallback_missing_job_body' },
    media: {
      images: [{ url: 'https://img.example/poster.jpg' }],
      analysis: { status: 'analyzed', source: 'vision_model', visible_text: '展览时间：8月1日' },
    },
    content_analysis: {
      status: 'completed',
      overview: '该内容介绍一场城市摄影展。',
      modules: [{ id: 'schedule', title: '时间与地点', summary: '8月1日举办。', items: [], evidence: [] }],
    },
  };
  assert.equal(isIncompleteGeneralRecord(record), false);
  assert.equal(isIncompleteApplicationRecord(record), true);
  assert.equal(isIncompleteGeneralRecord({
    ...record,
    media: { ...record.media, analysis: { ...record.media.analysis, source: 'image_alt_text' } },
  }), true);
});

test('application results expose general presentation and use general completeness rules', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-general-results-'));
  const outputDir = path.join(fixture, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  const id = '20260730140000-abcdef12';
  const record = {
    note_id: 'content-1',
    title: '城市摄影展',
    note_url: 'https://www.xiaohongshu.com/explore/content-1',
    body: '一篇关于城市展览的完整正文',
    access_status: 'success',
    collected_at: new Date().toISOString(),
    publish_time: { raw: '刚刚', value: new Date().toISOString(), precision: 'minute', is_estimated: false },
    application_info: { contacts: [], application_routes: [], responsibilities: [], requirements: [] },
    outreach: { greeting: '', email_subject: '', email_body: '', cover_letter: '', generation_mode: '', runtime_status: 'fallback_missing_job_body', status: 'not_applicable' },
    media: { images: [], analysis: { status: 'no_images', source: 'none', visible_text: '' } },
    content_analysis: {
      status: 'completed',
      overview: '该内容介绍一场城市摄影展。',
      content_type: '展览推荐',
      relevance_score: 95,
      relevance_reason: '直接相关',
      topics: ['摄影展'],
      entities: ['城市美术馆'],
      image_insights: [],
      modules: [{ id: 'highlights', title: '展览亮点', summary: '聚焦城市摄影。', items: [], evidence: ['城市摄影展'] }],
    },
    quality: {},
  };
  await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
    analysis_mode: 'general',
    keyword: '城市展览',
    content_research: {
      preset: 'place',
      label: '地点清单',
      goal: '整理适合周末到访的展览、时间与地点。',
    },
    content_presentation: {
      eyebrow: 'CITY EXHIBITION INTELLIGENCE',
      title: '城市展览内容观察',
      description: '整理正文与图片中的展览信息。',
      modules: [{ id: 'highlights', title: '展览亮点', question: '有哪些亮点？' }],
    },
    records: [record],
  }), 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), '[]', 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), '[]', 'utf8');
  const internal = { id, outputDir, config: { analysisMode: 'general' } };
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

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${origin}/api/jobs/${id}/results`).then((item) => item.json());
    assert.equal(response.analysisMode, 'general');
    assert.equal(response.keyword, '城市展览');
    assert.deepEqual(response.research, {
      preset: 'place',
      label: '地点清单',
      goal: '整理适合周末到访的展览、时间与地点。',
    });
    assert.equal(response.presentation.title, '城市展览内容观察');
    assert.equal(response.filters.stats.incomplete, 0);
    assert.equal(response.items[0].content_analysis.modules[0].title, '展览亮点');

    const completionResponse = await fetch(`${origin}/api/jobs/${id}/complete-missing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(completionResponse.status, 200);
    const completion = await completionResponse.json();
    assert.equal(completion.action, 'already_complete');
    assert.equal(completion.incompleteBefore, 0);
    assert.equal(completion.job.id, id);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  }
});

test('legacy results can be viewed as content and remain pending until AI structures them', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-legacy-content-results-'));
  const outputDir = path.join(fixture, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  const id = '20260730140100-abcdef12';
  await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
    analysis_mode: 'job',
    records: [{
      note_id: 'legacy-content-1',
      title: '短发造型经验',
      note_url: 'https://www.xiaohongshu.com/explore/legacy-content-1',
      body: '分享短发打理和日常造型经验。',
      collected_at: new Date().toISOString(),
      publish_time: { raw: '刚刚', value: new Date().toISOString(), precision: 'minute', is_estimated: false },
      application_info: { contacts: [], application_routes: [], responsibilities: [], requirements: [] },
      outreach: { runtime_status: 'completed' },
      media: { images: [], analysis: { status: 'no_images', source: 'none', visible_text: '' } },
    }],
  }), 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), '[]', 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), '[]', 'utf8');
  const internal = {
    id,
    outputDir,
    params: {
      keyword: '短发女',
      contentPreset: 'people',
      contentGoal: '整理发型特征、打理方式和风格表达。',
    },
    config: {},
  };
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

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${origin}/api/jobs/${id}/results?analysisMode=general`).then((item) => item.json());
    assert.equal(response.analysisMode, 'general');
    assert.equal(response.keyword, '短发女');
    assert.deepEqual(response.research, {
      preset: 'people',
      label: '人群与风格',
      goal: '整理发型特征、打理方式和风格表达。',
    });
    assert.equal(response.filters.stats.all, 1);
    assert.equal(response.filters.stats.incomplete, 1);
    assert.equal(response.items[0].title, '短发造型经验');
    assert.equal(response.items[0].content_analysis, undefined);
    assert.equal(response.items[0].outreach, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  }
});

test('one-click completion starts one managed task and repeated clicks attach to it', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-managed-completion-'));
  const outputDir = path.join(fixture, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  const sourceId = '20260730140200-abcdef12';
  const childId = '20260730140300-bcdef123';
  const sourceParams = {
    analysisMode: 'job',
    keyword: '数据分析实习',
    candidateProfile: {
      name: '候选人',
      school: '示例大学',
      major: '数据分析',
      email: 'candidate@example.com',
    },
  };
  const sourceJob = {
    id: sourceId,
    keyword: sourceParams.keyword,
    status: 'completed',
    createdAt: new Date().toISOString(),
    config: sourceParams,
  };
  const internal = {
    ...sourceJob,
    params: sourceParams,
    outputDir,
  };
  const jobs = [sourceJob];
  const starts = [];
  const manager = {
    active: null,
    list: () => [...jobs],
    get: (jobId) => jobs.find((job) => job.id === jobId) || null,
    getInternal: (jobId) => jobId === sourceId ? internal : null,
    start: async (params) => {
      starts.push(params);
      const child = {
        id: childId,
        keyword: params.keyword,
        status: 'queued',
        createdAt: new Date().toISOString(),
        config: params,
      };
      jobs.unshift(child);
      return child;
    },
  };
  await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
    analysis_mode: 'job',
    keyword: sourceParams.keyword,
    records: [{
      note_id: 'missing-1',
      title: '数据分析实习生',
      note_url: 'https://www.xiaohongshu.com/explore/missing-1',
      body: '',
      collected_at: new Date().toISOString(),
      publish_time: { raw: '刚刚', value: new Date().toISOString(), precision: 'minute', is_estimated: false },
      application_info: { contacts: [], application_routes: [], responsibilities: [], requirements: [] },
      outreach: { runtime_status: 'fallback_missing_job_body' },
      job_card: { parse_basis: 'search_card' },
      media: { images: [], analysis: { status: 'no_images', source: 'none', visible_text: '' } },
    }],
  }), 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), '[]', 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), '[]', 'utf8');

  const server = http.createServer(createApp({
    manager,
    config: { host: '127.0.0.1', port: 0, maxBodyBytes: 4096, runnerAvailable: true },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const payload = JSON.stringify({ aiSessionId: '11111111-1111-4111-8111-111111111111' });
    const firstResponse = await fetch(`${origin}/api/jobs/${sourceId}/complete-missing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(firstResponse.status, 202);
    const first = await firstResponse.json();
    assert.equal(first.action, 'started');
    assert.equal(first.incompleteBefore, 1);
    assert.equal(first.job.id, childId);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].mode, 'resume');
    assert.equal(starts[0].resumeFromJobId, sourceId);
    assert.equal(starts[0].completeMissingOnly, true);
    assert.equal(starts[0].searchSort, 'latest');
    assert.equal(starts[0].aiSessionId, '11111111-1111-4111-8111-111111111111');

    const secondResponse = await fetch(`${origin}/api/jobs/${sourceId}/complete-missing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();
    assert.equal(second.action, 'attached');
    assert.equal(second.job.id, childId);
    assert.equal(starts.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  }
});

test('application results hydrate images and filter the full result set by publish time', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-results-'));
  const outputDir = path.join(fixture, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  const recent = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
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
      {
        ...base,
        note_id: 'recent',
        title: '最新岗位',
        body: '',
        publish_time: { raw: recent, value: recent, precision: 'minute', is_estimated: false },
        application_info: { ...base.application_info, responsibilities: [{ text: '图片识别职责' }] },
        job_card: { parse_basis: 'search_card', enrichment_status: 'image_enriched' },
        media: { analysis: { status: 'analyzed', source: 'vision_model' } },
        outreach: { ...base.outreach, runtime_status: 'image_enriched_missing_job_body' },
      },
      { ...base, note_id: 'old', title: '较早岗位', body: '完整正文', publish_time: { raw: old, value: old, precision: 'minute', is_estimated: false }, job_card: { parse_basis: 'full_body' } },
      { ...base, note_id: 'unknown', title: '日期待确认', body: '', publish_time: { raw: '', value: '', precision: 'unknown', is_estimated: false }, job_card: { parse_basis: 'search_card' }, outreach: { ...base.outreach, runtime_status: 'fallback_missing_job_body' } },
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

    const last24Hours = await fetch(`${origin}/api/jobs/${id}/results?timeRange=1`).then((response) => response.json());
    assert.deepEqual(last24Hours.items.map((item) => item.note_id), ['recent']);

    const last3Days = await fetch(`${origin}/api/jobs/${id}/results?timeRange=3`).then((response) => response.json());
    assert.deepEqual(last3Days.items.map((item) => item.note_id), ['recent']);

    const unknownOnly = await fetch(`${origin}/api/jobs/${id}/results?timeRange=unknown`).then((response) => response.json());
    assert.deepEqual(unknownOnly.items.map((item) => item.note_id), ['unknown']);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(path.join(outputDir, 'application_intelligence.checkpoint.json'), JSON.stringify({
      records: [{
        ...base,
        note_id: 'live-checkpoint',
        title: '实时补全检查点',
        body: '检查点正文',
        publish_time: { raw: recent, value: recent, precision: 'minute', is_estimated: false },
        job_card: { parse_basis: 'full_body' },
      }],
    }), 'utf8');
    const live = await fetch(`${origin}/api/jobs/${id}/results`).then((response) => response.json());
    assert.deepEqual(live.items.map((item) => item.note_id), ['live-checkpoint']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  }
});
