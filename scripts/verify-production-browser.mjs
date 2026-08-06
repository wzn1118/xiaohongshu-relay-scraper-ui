import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const baseUrl = String(process.env.HEGELSALON_VERIFY_URL || 'https://relay.hegelsalon.com').replace(/\/$/u, '');
const email = String(process.env.HEGELSALON_VERIFY_EMAIL || '').trim();
const password = String(process.env.HEGELSALON_VERIFY_PASSWORD || '');
const screenshotPath = path.resolve(process.env.HEGELSALON_VERIFY_SCREENSHOT || 'output/playwright/hegelsalon-production-current.png');

assert.ok(email, 'HEGELSALON_VERIFY_EMAIL is required.');
assert.ok(password, 'HEGELSALON_VERIFY_PASSWORD is required.');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const initialApiRequests = [];
  let captureInitialRequests = true;
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
  assert.deepEqual(jobs.map((job) => job.id).sort(), ['20260731005634-5c619106', '20260804081657-caf8f451']);

  await page.waitForFunction(() => !document.querySelector('.auth-form'));
  const artifacts = await page.evaluate(async () => {
    const response = await fetch('/api/jobs/20260804081657-caf8f451/artifacts');
    if (!response.ok) throw new Error(`Artifacts request failed with ${response.status}.`);
    return response.json();
  });
  assert.ok(Array.isArray(artifacts));
  assert.equal(artifacts.length, 321);

  await mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const logoutStatus = await page.evaluate(async () => (await fetch('/api/auth/logout', { method: 'POST' })).status);
  assert.equal(logoutStatus, 200);

  console.log(JSON.stringify({
    url: page.url(),
    loginGateRequests: [...new Set(initialApiRequests)],
    jobs: jobs.map((job) => job.id),
    artifacts: artifacts.length,
    screenshot: screenshotPath,
  }));
} finally {
  await browser.close();
}
