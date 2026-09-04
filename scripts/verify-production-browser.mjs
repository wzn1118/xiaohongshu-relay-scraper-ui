import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const baseUrl = String(process.env.HEGELSALON_VERIFY_URL || 'https://relay.hegelsalon.com').replace(/\/$/u, '');
const email = String(process.env.HEGELSALON_VERIFY_EMAIL || '').trim();
const password = String(process.env.HEGELSALON_VERIFY_PASSWORD || '');
const screenshotPath = path.resolve(process.env.HEGELSALON_VERIFY_SCREENSHOT || 'output/playwright/hegelsalon-production-current.png');
const expectedJobIds = String(process.env.HEGELSALON_VERIFY_JOB_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .sort();
const expectedArtifactJobId = String(process.env.HEGELSALON_VERIFY_ARTIFACT_JOB_ID || '20260731093808-50dd4507').trim();
const expectedHistoryJobId = String(process.env.HEGELSALON_VERIFY_HISTORY_JOB_ID || '20260731005634-5c619106').trim();
const expectedArtifactCountText = String(process.env.HEGELSALON_VERIFY_ARTIFACT_COUNT || '').trim();
const expectedArtifactCount = expectedArtifactCountText ? Number(expectedArtifactCountText) : null;
if (expectedArtifactCountText) assert.ok(Number.isInteger(expectedArtifactCount) && expectedArtifactCount >= 0, 'HEGELSALON_VERIFY_ARTIFACT_COUNT must be a non-negative integer.');

assert.ok(email, 'HEGELSALON_VERIFY_EMAIL is required.');
assert.ok(password, 'HEGELSALON_VERIFY_PASSWORD is required.');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const initialApiRequests = [];
  const pageErrors = [];
  const consoleErrors = [];
  const failedApiResponses = [];
  let captureInitialRequests = true;
  page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/') && response.status() >= 400) {
      failedApiResponses.push({ method: response.request().method(), path: url.pathname, status: response.status() });
    }
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (captureInitialRequests && url.pathname.startsWith('/api/')) initialApiRequests.push(url.pathname);
  });

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('.auth-form').waitFor({ state: 'visible' });
  captureInitialRequests = false;
  assert.deepEqual([...new Set(initialApiRequests)], ['/api/auth/me']);

  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  const jobsResponsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/jobs' && response.status() === 200);
  await page.locator('.auth-submit').click();
  const jobsResponse = await jobsResponsePromise;
  const jobs = await jobsResponse.json();
  assert.ok(Array.isArray(jobs));
  const jobIds = jobs.map((job) => String(job.id)).sort();
  if (expectedJobIds.length) assert.deepEqual(jobIds, expectedJobIds);
  if (expectedHistoryJobId) assert.ok(jobIds.includes(expectedHistoryJobId), `Historical task ${expectedHistoryJobId} is missing.`);

  const apiChecks = await page.evaluate(async ({ historyJobId }) => {
    const endpoints = {
      health: '/api/health',
      relayConfig: '/api/relay/config',
      relayStatus: '/api/relay/status',
      emailConfig: '/api/email/config',
      aiProviders: '/api/ai/providers',
      localModels: '/api/ai/local-models',
      profiles: '/api/profiles',
      dataOwnership: '/api/data/ownership',
      dataRetention: '/api/data/retention',
      copilotCapabilities: '/api/copilot/capabilities',
      copilotContextJobs: '/api/copilot/context/jobs?limit=1',
      historicalTask: `/api/jobs/${encodeURIComponent(historyJobId)}`,
    };
    return Object.fromEntries(await Promise.all(Object.entries(endpoints).map(async ([name, url]) => {
      const response = await fetch(url);
      const payload = await response.json().catch(() => null);
      return [name, { status: response.status, payload }];
    })));
  }, { historyJobId: expectedHistoryJobId });
  for (const [name, result] of Object.entries(apiChecks)) {
    assert.equal(result.status, 200, `${name} returned HTTP ${result.status}.`);
  }
  assert.equal(apiChecks.health.payload?.ok, true);
  assert.equal(apiChecks.health.payload?.runnerAvailable, true);
  assert.equal(apiChecks.health.payload?.audienceAi?.enabled, true);
  assert.equal(apiChecks.health.payload?.audienceAi?.runnerAvailable, true);
  assert.equal(apiChecks.relayStatus.payload?.ready, true);
  assert.equal(apiChecks.relayStatus.payload?.running, true);
  assert.equal(apiChecks.relayStatus.payload?.cdpReady, true);
  assert.ok(Array.isArray(apiChecks.aiProviders.payload));
  assert.ok(Array.isArray(apiChecks.profiles.payload));
  assert.equal(String(apiChecks.historicalTask.payload?.id || ''), expectedHistoryJobId);

  await page.waitForFunction(() => !document.querySelector('.auth-form'));
  const workflowNav = page.getByRole('navigation', { name: '任务流程' });
  const workflowOrder = await workflowNav.locator('.nav-button-label').allTextContents();
  assert.deepEqual(workflowOrder.map((value) => value.trim()), ['总览', '环境', '新建', '结果', '投递', '历史', '文件']);
  const workflowScreens = [
    ['总览', 'start', '工作总览'],
    ['环境', 'setup', '运行环境'],
    ['新建', 'task', '创建采集任务'],
    ['结果', 'workspace', '运行与结果'],
    ['历史', 'history', '任务历史'],
    ['文件', 'artifacts', '文件交付'],
  ];
  for (const [label, screen, moduleTitle] of workflowScreens) {
    await workflowNav.getByRole('button', { name: label, exact: true }).click();
    await page.locator(`.workflow-main.screen-${screen}`).waitFor({ state: 'visible' });
    assert.equal((await page.locator('.workflow-module-bar h2').textContent())?.trim(), moduleTitle);
    const visibleSurfaces = await page.locator('.workflow-main > .workflow-screen, .workflow-main > .workflow-secondary-grid').evaluateAll((elements) => (
      elements
        .filter((element) => getComputedStyle(element).display !== 'none')
        .map((element) => element.className)
    ));
    assert.ok(visibleSurfaces.length > 0, `${label} should display its workflow surface.`);
    const expectedClass = screen === 'history' || screen === 'artifacts' ? 'workflow-secondary-grid' : `workflow-screen-${screen}`;
    assert.ok(visibleSurfaces.every((className) => String(className).split(/\s+/u).includes(expectedClass)), `${label} displayed another module: ${visibleSurfaces.join(', ')}`);
  }
  await workflowNav.getByRole('button', { name: '投递', exact: true }).click();
  await page.locator('.app-shell.batch-surface-active .workflow-main.screen-workspace').waitFor({ state: 'visible' });
  assert.equal(new URL(page.url()).pathname, '/batch');
  const visibleBatchSurfaces = await page.locator('.workflow-main > .workflow-screen, .workflow-main > .workflow-secondary-grid').evaluateAll((elements) => (
    elements
      .filter((element) => getComputedStyle(element).display !== 'none')
      .map((element) => element.className)
  ));
  assert.ok(visibleBatchSurfaces.length > 0, '批量 should display its workflow surface.');
  assert.ok(visibleBatchSurfaces.every((className) => String(className).split(/\s+/u).includes('workflow-screen-workspace')), `批量 displayed another module: ${visibleBatchSurfaces.join(', ')}`);
  assert.equal((await page.locator('.workflow-module-bar h2').textContent())?.trim(), '批量投递');
  assert.equal(await page.locator('.coverage-panel:visible').count(), 0, '批量界面不应重复显示结果覆盖面板。');
  assert.equal(await page.locator('.batch-application-heading:visible').count(), 0, '批量界面不应重复显示工作台标题。');
  assert.deepEqual((await workflowNav.locator('.nav-button-label').allTextContents()).map((value) => value.trim()), ['总览', '环境', '新建', '结果', '投递', '历史', '文件']);
  await workflowNav.getByRole('button', { name: '历史', exact: true }).click();
  await page.locator('.workflow-main.screen-history .history-panel').waitFor({ state: 'visible' });
  assert.equal(new URL(page.url()).pathname, '/');
  await workflowNav.getByRole('button', { name: '投递', exact: true }).click();
  await page.locator('.app-shell.batch-surface-active .workflow-main.screen-workspace').waitFor({ state: 'visible' });

  const artifactJob = jobs.find((job) => String(job.id) === expectedArtifactJobId) || jobs[0];
  if (expectedArtifactJobId) assert.equal(String(artifactJob?.id || ''), expectedArtifactJobId);
  const artifacts = artifactJob?.id
    ? await page.evaluate(async (jobId) => {
        const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/artifacts`);
        if (!response.ok) throw new Error(`Artifacts request failed with ${response.status}.`);
        return response.json();
      }, String(artifactJob.id))
    : [];
  assert.ok(Array.isArray(artifacts));
  if (expectedArtifactCount !== null) assert.equal(artifacts.length, expectedArtifactCount);

  await mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const logoutStatus = await page.evaluate(async () => (await fetch('/api/auth/logout', { method: 'POST' })).status);
  assert.equal(logoutStatus, 200);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(failedApiResponses, []);

  console.log(JSON.stringify({
    url: page.url(),
    loginGateRequests: [...new Set(initialApiRequests)],
    jobs: jobIds,
    artifactJob: artifactJob?.id ? String(artifactJob.id) : null,
    artifacts: artifacts.length,
    apiChecks: {
      health: {
        status: apiChecks.health.status,
        runnerAvailable: apiChecks.health.payload.runnerAvailable,
        audienceAiEnabled: apiChecks.health.payload.audienceAi?.enabled === true,
        audienceAiRunnerAvailable: apiChecks.health.payload.audienceAi?.runnerAvailable === true,
        relaySupervisorPhase: apiChecks.health.payload.relaySupervisor?.phase || null,
        relayAutomaticEnabled: apiChecks.health.payload.relaySupervisor?.automaticEnabled === true,
        emailConfigured: apiChecks.health.payload.emailDelivery?.configured === true,
      },
      relayConfig: { status: apiChecks.relayConfig.status },
      relayStatus: {
        status: apiChecks.relayStatus.status,
        ready: apiChecks.relayStatus.payload?.ready === true,
        running: apiChecks.relayStatus.payload?.running === true,
        cdpReady: apiChecks.relayStatus.payload?.cdpReady === true,
      },
      emailConfig: {
        status: apiChecks.emailConfig.status,
        configured: apiChecks.emailConfig.payload?.configured === true,
        verified: apiChecks.emailConfig.payload?.verified === true,
      },
      aiProviders: { status: apiChecks.aiProviders.status, count: apiChecks.aiProviders.payload.length },
      localModels: { status: apiChecks.localModels.status },
      profiles: { status: apiChecks.profiles.status, count: apiChecks.profiles.payload.length },
      dataOwnership: { status: apiChecks.dataOwnership.status },
      dataRetention: { status: apiChecks.dataRetention.status },
      copilotCapabilities: { status: apiChecks.copilotCapabilities.status },
      copilotContextJobs: { status: apiChecks.copilotContextJobs.status },
      historicalTask: { status: apiChecks.historicalTask.status, id: expectedHistoryJobId },
    },
    workflowOrder,
    workflowScreens: [...workflowScreens.map(([label, screen, moduleTitle]) => ({ label, screen, moduleTitle })), { label: '批量', screen: 'workspace', moduleTitle: '批量投递', persistentNavigation: true, historyExitVerified: true }],
    browserErrors: { page: pageErrors, console: consoleErrors, apiResponses: failedApiResponses },
    screenshot: screenshotPath,
  }));
} finally {
  await browser.close();
}
