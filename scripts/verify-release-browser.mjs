#!/usr/bin/env node

import path from 'node:path';
import { chromium } from '@playwright/test';

const options = parseArgs(process.argv.slice(2));
if (!options.url || !options.screenshotPath) {
  throw new Error('Usage: verify-release-browser.mjs --url URL --screenshot-path PATH [--require-codex-built-in]');
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error?.message || error)));

try {
  const response = await page.goto(options.url, { waitUntil: 'networkidle', timeout: 60_000 });
  if (!response?.ok()) throw new Error(`Page returned HTTP ${response?.status() || 'unknown'}.`);
  if (options.requireCodexBuiltIn) {
    await page.locator('html[data-codex-ready="true"]').waitFor({ state: 'attached', timeout: 30_000 });
    const controls = await page.locator('button, textarea').count();
    if (controls < 3) throw new Error(`Codex page has too few interactive controls: ${controls}.`);
  } else {
    await page.locator('#root').waitFor({ state: 'visible', timeout: 30_000 });
  }
  if (pageErrors.length) throw new Error(`Page raised errors: ${pageErrors.join(' | ')}`);
  const screenshotPath = path.resolve(options.screenshotPath);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  process.stdout.write(`${JSON.stringify({ ok: true, url: options.url, title: await page.title(), screenshot: path.basename(screenshotPath) })}\n`);
} finally {
  await browser.close();
}

function parseArgs(args) {
  const parsed = { url: '', screenshotPath: '', requireCodexBuiltIn: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--url') parsed.url = String(args[++index] || '');
    else if (argument === '--screenshot-path') parsed.screenshotPath = String(args[++index] || '');
    else if (argument === '--require-codex-built-in') parsed.requireCodexBuiltIn = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return parsed;
}
