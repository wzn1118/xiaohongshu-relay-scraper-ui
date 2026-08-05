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
  assert.equal(isIncompleteApplicationRecord({
    ...cached,
    body: '',
    job_card: { ...cached.job_card, enrichment_status: 'image_enriched' },
    application_info: { ...cached.application_info, requirements: [{ text: '香港院校在读' }] },
    outreach: { runtime_status: 'image_enriched_missing_job_body' },
  }), true);
  assert.equal(isIncompleteApplicationRecord({
    ...cached,
    outreach: { runtime_status: 'quality_threshold_not_met' },
  }), true);
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
      grounded_evidence_count: 2,
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
      grounded_evidence_count: 1,
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
    content_insights: {
      sampleSize: 1,
      sourceReady: 1,
      groundedRecords: 1,
      coverageRate: 100,
      methodNote: '只统计可回溯证据。',
      topTopics: [],
      modules: [],
    },
    records: [record],
  }), 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), '[]', 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), '[]', 'utf8');
  const internal = { id, outputDir, config: { analysisMode: 'general' } };
  const manager = {
    active: internal,
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
    assert.equal(response.insights.groundedRecords, 1);
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
    active: internal,
    // active collection fixture
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

test('one-click completion resumes the original task in place and repeated clicks attach to it', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-managed-completion-'));
  const outputDir = path.join(fixture, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  const sourceId = '20260730140200-abcdef12';
  const sourceParams = {
    analysisMode: 'job',
    keyword: '数据分析实习',
    aiSessionId: '22222222-2222-4222-8222-222222222222',
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
  const resumes = [];
  const manager = {
    active: null,
    list: () => [...jobs],
    get: (jobId) => jobs.find((job) => job.id === jobId) || null,
    getInternal: (jobId) => jobId === sourceId ? internal : null,
    resume: async (jobId, options) => {
      resumes.push([jobId, options]);
      sourceJob.status = 'resuming';
      sourceJob.resumeCount = 1;
      sourceJob.attempts = [{ attemptId: 'attempt-2', resumeScope: options.scope }];
      internal.status = 'resuming';
      return { ...sourceJob, attemptId: 'attempt-2' };
    },
  };
  await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
    analysis_mode: 'job',
    keyword: sourceParams.keyword,
    source_coverage: {
      status: 'partial',
      reason: 'missing_bodies',
      targetCount: 3,
      readyCount: 0,
      pendingCount: 3,
      totalRecordCount: 1,
      fullBodyCount: 0,
      statisticsSource: 'bodyCompletionLedger',
    },
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
    const payload = JSON.stringify({});
    const firstResponse = await fetch(`${origin}/api/jobs/${sourceId}/complete-missing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(firstResponse.status, 202);
    const first = await firstResponse.json();
    assert.equal(first.action, 'started');
    assert.equal(first.incompleteBefore, 3);
    assert.equal(first.job.id, sourceId);
    assert.equal(first.job.createdAt, sourceJob.createdAt);
    assert.equal(jobs.length, 1);
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0][0], sourceId);
    assert.equal(resumes[0][1].scope, 'body_completion');
    assert.equal(resumes[0][1].params.mode, 'resume');
    assert.equal(resumes[0][1].params.resumeFromJobId, sourceId);
    assert.equal(resumes[0][1].params.completeMissingOnly, true);
    assert.equal(resumes[0][1].params.searchSort, 'latest');
    assert.equal(resumes[0][1].params.aiSessionId, null);
    assert.equal(resumes[0][1].aiSessionId, null);

    const secondResponse = await fetch(`${origin}/api/jobs/${sourceId}/complete-missing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();
    assert.equal(second.action, 'attached');
    assert.equal(second.job.id, sourceId);
    assert.equal(jobs.length, 1);
    assert.equal(resumes.length, 1);
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
        application_info: {
          ...base.application_info,
          contacts: [{ type: 'email', value: 'structured.jobs@example.test', evidence: '结构化应聘邮箱' }],
          responsibilities: [{ text: '图片识别职责' }],
        },
        job_card: { role_name: '结构化增长产品经理', parse_basis: 'search_card', enrichment_status: 'image_enriched' },
        media: { analysis: { status: 'analyzed', source: 'vision_model' } },
        outreach: { ...base.outreach, runtime_status: 'image_enriched_missing_job_body' },
      },
      { ...base, note_id: 'old', title: '较早岗位', body: '完整正文。简历标题备注上：岗位-姓名-最早到岗时间-可实习时长；邮件标题要求：姓名-学校-应聘岗位。帖子不删就是还在招', publish_time: { raw: old, value: old, precision: 'minute', is_estimated: false }, job_card: { parse_basis: 'full_body' } },
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
    active: internal,
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
    assert.equal(all.filters.stats.incomplete, 2);
    assert.deepEqual(
      all.items.filter(isIncompleteApplicationRecord).map((item) => item.note_id),
      ['recent', 'unknown'],
    );
    assert.equal(all.filters.stats.withImages, 1);
    assert.equal(all.items[0].media.images.length, 2);
    assert.deepEqual(all.items.find((item) => item.note_id === 'old').attachmentRequirement, {
      detected: true,
      template: '岗位-姓名-最早到岗时间-可实习时长',
      evidence: '简历标题备注上:岗位-姓名-最早到岗时间-可实习时长',
      fields: ['jobTitle', 'candidateName', 'arrivalDate', 'internshipDuration'],
    });
    assert.deepEqual(all.items.find((item) => item.note_id === 'old').emailSubjectRequirement, {
      detected: true,
      template: '姓名-学校-应聘岗位',
      evidence: '邮件标题要求：姓名-学校-应聘岗位',
      fields: ['candidateName', 'school', 'jobTitle'],
    });

    const roleMatch = await fetch(`${origin}/api/jobs/${id}/results?query=${encodeURIComponent('结构化增长产品经理')}`).then((response) => response.json());
    assert.deepEqual(roleMatch.items.map((item) => item.note_id), ['recent']);

    const structuredEmailMatch = await fetch(`${origin}/api/jobs/${id}/results?query=structured.jobs%40example.test`).then((response) => response.json());
    assert.deepEqual(structuredEmailMatch.items.map((item) => item.note_id), ['recent']);

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

test('application results expose normalized legacy body emails to search and detail views', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-normalized-contact-results-'));
  const outputDir = path.join(fixture, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  const id = '20260804120000-abcdef12';
  await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
    records: [{
      note_id: 'emoji-contact',
      title: '内容运营实习',
      body: '简历fa：📮1️⃣3️⃣9️⃣6️⃣334506️⃣@扣扣点com',
      application_info: { contacts: [], application_routes: [], responsibilities: [], requirements: [] },
      outreach: { email_subject: '内容运营实习申请', email_body: '正文', cover_letter: '求职信' },
    }],
  }), 'utf8');
  const internal = { id, outputDir, config: {}, params: { analysisMode: 'job' } };
  const manager = {
    active: internal,
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
    const response = await fetch(`${origin}/api/jobs/${id}/results?query=1396334506%40qq.com`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.total, 1);
    const contact = payload.items[0].application_info.contacts[0];
    assert.equal(contact.value, '1396334506@qq.com');
    assert.equal(contact.verification_status, 'body_format_normalized');
    assert.equal(contact.normalization_applied, true);
    assert.match(contact.evidence, /1️⃣3️⃣9️⃣6️⃣334506️⃣@扣扣点com/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  }
});

test('application results proxy Xiaohongshu images through a persistent per-task cache', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-media-cache-'));
  const outputDir = path.join(fixture, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  const id = '20260731180000-abcdef12';
  const sourceUrl = 'https://sns-webpic-qc.xhscdn.com/202607311800/test.webp';
  await writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
    records: [{
      note_id: 'cached-image',
      title: 'cached image',
      note_url: 'https://www.xiaohongshu.com/explore/cached-image',
      body: 'complete body',
      publish_time: { value: new Date().toISOString() },
      media: {
        cover_url: sourceUrl,
        images: [{ url: sourceUrl, alt: 'poster', source: 'detail' }],
        analysis: { status: 'analyzed', source: 'vision_model' },
      },
      application_info: { contacts: [], application_routes: [], responsibilities: [], requirements: [] },
      outreach: { runtime_status: 'completed' },
    }],
  }), 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), '[]', 'utf8');
  await writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), '[]', 'utf8');
  const internal = { id, outputDir, config: {}, params: { analysisMode: 'job' } };
  const manager = {
    active: internal,
    list: () => [],
    get: (jobId) => jobId === id ? internal : null,
    getInternal: (jobId) => jobId === id ? internal : null,
  };
  let fetchCount = 0;
  const server = http.createServer(createApp({
    manager,
    config: { host: '127.0.0.1', port: 0, maxBodyBytes: 4096, runnerAvailable: true },
    mediaFetcher: async () => {
      fetchCount += 1;
      return new Response(Buffer.from('cached-image-body'), {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      });
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const results = await fetch(`${origin}/api/jobs/${id}/results`).then((response) => response.json());
    const image = results.items[0].media.images[0];
    assert.equal(image.original_url, sourceUrl);
    assert.match(image.url, new RegExp(`^/api/jobs/${id}/media\\?url=`));
    assert.equal(results.items[0].media.cover_original_url, sourceUrl);

    const first = await fetch(`${origin}${image.url}`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'image/webp');
    assert.equal(await first.text(), 'cached-image-body');
    const second = await fetch(`${origin}${image.url}`);
    assert.equal(second.status, 200);
    assert.equal(await second.text(), 'cached-image-body');
    assert.equal(fetchCount, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  }
});

test('audience results cache commenter and author avatars through the task media route', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-audience-avatar-cache-'));
  const outputDir = path.join(fixture, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  const id = '20260801103000-abcdef12';
  const commenterAvatar = 'https://sns-avatar-qc.xhscdn.com/avatar/commenter.jpg';
  const authorAvatar = 'https://sns-avatar-qc.xhscdn.com/avatar/author.jpg';
  await Promise.all([
    writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), JSON.stringify([{
      note_id: 'post-1',
      title: 'Avatar source post',
      note_url: 'https://www.xiaohongshu.com/explore/post-1',
      author: 'Author',
      author_profile: 'https://www.xiaohongshu.com/user/profile/author-1',
      card_image_urls: `https://sns-webpic-qc.xhscdn.com/post.webp | ${authorAvatar}`,
    }]), 'utf8'),
    writeFile(path.join(outputDir, 'audience-comments.json'), JSON.stringify([{
      comment_id: 'comment-1',
      post_id: 'post-1',
      text: 'Comment',
      user: { user_id: 'commenter-1', display_name: 'Commenter', avatar_url: commenterAvatar },
    }]), 'utf8'),
    writeFile(path.join(outputDir, 'audience-users.json'), JSON.stringify([
      { user_id: 'commenter-1', display_name: 'Commenter', avatar_url: commenterAvatar, post_ids: ['post-1'] },
      { user_id: 'author-1', display_name: 'Author', avatar_url: '', post_ids: ['post-1'], roles: ['author'] },
    ]), 'utf8'),
  ]);
  const internal = { id, outputDir, config: {}, params: {} };
  const manager = {
    active: null,
    list: () => [],
    get: (jobId) => jobId === id ? internal : null,
    getInternal: (jobId) => jobId === id ? internal : null,
  };
  let fetchCount = 0;
  const server = http.createServer(createApp({
    manager,
    config: { host: '127.0.0.1', port: 0, maxBodyBytes: 4096, runnerAvailable: true },
    mediaFetcher: async () => {
      fetchCount += 1;
      return new Response(Buffer.from('avatar-image-body'), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const users = await fetch(`${origin}/api/jobs/${id}/audience?kind=users&limit=10`).then((response) => response.json());
    const commenter = users.items.find((user) => user.user_id === 'commenter-1');
    const author = users.items.find((user) => user.user_id === 'author-1');
    assert.equal(commenter.avatar_original_url, commenterAvatar);
    assert.match(commenter.avatar_url, new RegExp(`^/api/jobs/${id}/media\\?url=`));
    assert.equal(author.avatar_original_url, authorAvatar);
    assert.match(author.avatar_url, new RegExp(`^/api/jobs/${id}/media\\?url=`));

    const comments = await fetch(`${origin}/api/jobs/${id}/audience?kind=comments&limit=10`).then((response) => response.json());
    assert.equal(comments.items[0].user.avatar_original_url, commenterAvatar);
    assert.match(comments.items[0].user.avatar_url, new RegExp(`^/api/jobs/${id}/media\\?url=`));

    const first = await fetch(`${origin}${commenter.avatar_url}`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'image/jpeg');
    assert.equal(await first.text(), 'avatar-image-body');
    const second = await fetch(`${origin}${commenter.avatar_url}`);
    assert.equal(second.status, 200);
    assert.equal(await second.text(), 'avatar-image-body');
    assert.equal(fetchCount, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  }
});

test('media proxy returns 502 without crashing when the source image rejects access', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-media-source-error-'));
  const outputDir = path.join(fixture, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  const id = '20260801090000-abcdef12';
  const internal = { id, outputDir, config: {}, params: { analysisMode: 'job' } };
  const manager = {
    active: internal,
    list: () => [],
    get: (jobId) => jobId === id ? internal : null,
    getInternal: (jobId) => jobId === id ? internal : null,
  };
  const server = http.createServer(createApp({
    manager,
    config: { host: '127.0.0.1', port: 0, maxBodyBytes: 4096, runnerAvailable: true },
    mediaFetcher: async () => new Response('', { status: 403 }),
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const sourceUrl = encodeURIComponent('https://sns-webpic-qc.xhscdn.com/expired.webp');
    const response = await fetch(`${origin}/api/jobs/${id}/media?url=${sourceUrl}`);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'MEDIA_SOURCE_UNAVAILABLE');

    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  }
});

test('application results start contact OCR through the shared service instance', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'xhs-contact-ocr-results-'));
  const outputDir = path.join(fixture, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  const id = '20260805010000-abcdef12';
  await Promise.all([
    writeFile(path.join(outputDir, 'application_intelligence.json'), JSON.stringify({
      records: [{
        note_id: 'image-contact-1',
        title: 'Image contact role',
        note_url: 'https://www.xiaohongshu.com/explore/image-contact-1',
        body: 'Role description without an email address.',
        publish_time: { value: new Date().toISOString() },
        media: {
          images: [{ url: 'https://img.example/contact.webp' }],
          analysis: { status: 'pending_ai', source: 'image_urls' },
        },
        application_info: { contacts: [], application_routes: [], responsibilities: [], requirements: [] },
        outreach: { runtime_status: 'completed' },
      }, {
        note_id: 'body-contact-1',
        title: 'Body contact role',
        note_url: 'https://www.xiaohongshu.com/explore/body-contact-1',
        body: 'Please send your resume to body@example.com',
        publish_time: { value: new Date().toISOString() },
        media: {
          images: [{ url: 'https://img.example/body-contact.webp' }],
          analysis: { status: 'pending_ai', source: 'image_urls' },
        },
        application_info: { contacts: [], application_routes: [], responsibilities: [], requirements: [] },
        outreach: { runtime_status: 'completed' },
      }],
    }), 'utf8'),
    writeFile(path.join(outputDir, 'xiaohongshu_cards_latest.json'), '[]', 'utf8'),
    writeFile(path.join(outputDir, 'xiaohongshu_notes_latest.json'), '[]', 'utf8'),
    writeFile(path.join(outputDir, 'application-contact-ocr.json'), JSON.stringify({
      schemaVersion: 1,
      records: {
        'image-contact-1': {
          status: 'complete',
          visibleText: 'Apply at image@example.com',
          routes: [{
            type: 'email',
            channel: 'email',
            value: 'image@example.com',
            source: 'image',
            source_field: 'image',
            confidence: 100,
            actionable: true,
          }],
          contactOcr: { status: 'complete', attempts: 1, emailsFound: 1 },
        },
      },
    }), 'utf8'),
  ]);
  const internal = { id, outputDir, config: {}, params: { analysisMode: 'job' } };
  const manager = {
    active: null,
    list: () => [],
    get: (jobId) => jobId === id ? internal : null,
    getInternal: (jobId) => jobId === id ? internal : null,
  };
  let starts = 0;
  const applicationContactOcrService = {
    ensureStarted: async (requestedOutputDir) => {
      starts += 1;
      assert.equal(requestedOutputDir, outputDir);
      return {
        action: 'started',
        state: { status: 'running', active: true, totalQueued: 1, processed: 0 },
      };
    },
    getState: async () => ({ status: 'running', active: true, totalQueued: 1, processed: 0 }),
  };
  const server = http.createServer(createApp({
    manager,
    config: {
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 4096,
      runnerAvailable: true,
      applicationContactOcrEnabled: true,
      applicationContactOcrAutoEnabled: true,
    },
    applicationContactOcrService,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const resultsResponse = await fetch(`${origin}/api/jobs/${id}/results`);
    assert.equal(resultsResponse.status, 200);
    const results = await resultsResponse.json();
    assert.equal(starts, 1);
    assert.equal(results.contactResolution.action, 'started');
    assert.equal(results.contactResolution.status, 'running');
    assert.equal(results.items[0].application_info.application_routes[0].value, 'image@example.com');
    assert.equal(results.items[0].media.analysis.contact_ocr.status, 'complete');
    assert.equal(results.items[0].contactDiscovery.status, 'ready');
    assert.equal(results.items[0].contactDiscovery.candidates[0].address, 'image@example.com');
    assert.equal(results.items[0].contactDiscovery.candidates[0].noteId, 'image-contact-1');
    assert.equal(results.contactDiscovery.summary.imageEmailRecords, 1);

    const resolutionResponse = await fetch(`${origin}/api/jobs/${id}/contact-resolution?limit=5`);
    assert.equal(resolutionResponse.status, 200);
    const resolution = await resolutionResponse.json();
    assert.equal(resolution.summary.imageOcrComplete, 1);
    assert.equal(resolution.summary.imageOcrSkippedBodyEmail, 1);
    assert.equal(resolution.summary.imageOcrPending, 0);
    assert.equal(resolution.items.find((item) => item.noteId === 'body-contact-1').imageOcrStatus, 'skipped_body_email');
    assert.equal(resolution.summary.commentsPending, 0);
    assert.equal(resolution.summary.noEmailConfirmed, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture, { recursive: true, force: true });
  }
});
