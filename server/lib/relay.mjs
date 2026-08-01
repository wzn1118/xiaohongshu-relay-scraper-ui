import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relayTargetSummary } from './relay-targets.mjs';

export async function probeRelay({ port, openClawConfigPath, timeoutMs = 2500, fetchImpl = fetch }) {
  const checkedAt = new Date().toISOString();
  try {
    const relayToken = await resolveRelayToken({ port, openClawConfigPath });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const request = (headers) => fetchImpl(`http://127.0.0.1:${port}/json/list`, {
        ...(Object.keys(headers).length ? { headers } : {}),
        signal: controller.signal,
      });
      let response = await request(relayToken ? { 'x-openclaw-relay-token': relayToken } : {});
      const authenticated = Boolean(relayToken && response.ok);
      if (!response.ok && relayToken) response = await request({});
      if (!response.ok) throw new Error(`Relay responded with HTTP ${response.status}.`);
      const tabs = await response.json();
      if (!Array.isArray(tabs)) throw new Error('Relay returned an invalid tab list.');
      const targetSummary = relayTargetSummary(tabs);
      return {
        ok: true,
        running: true,
        cdpReady: true,
        authenticated,
        port,
        tabs: tabs.length,
        tabCount: tabs.length,
        xiaohongshuTabs: targetSummary.xiaohongshuPages,
        pageCount: targetSummary.pageCount,
        iframeCount: targetSummary.iframeCount,
        workerCount: targetSummary.workerCount,
        targetPressure: targetSummary.pressure,
        pressureReasons: targetSummary.pressureReasons,
        recoveryRecommended: targetSummary.recoveryRecommended,
        checkedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const message = publicError(error);
    return {
      ok: false,
      running: false,
      cdpReady: false,
      authenticated: false,
      port,
      tabs: 0,
      tabCount: 0,
      xiaohongshuTabs: 0,
      checkedAt,
      message,
      error: message,
    };
  }
}

export async function resolveRelayToken({ port, openClawConfigPath }) {
  if (!openClawConfigPath) return '';
  try {
    const gatewayConfig = JSON.parse(await readFile(openClawConfigPath, 'utf8'));
    const gatewayToken = gatewayConfig?.gateway?.auth?.token;
    if (typeof gatewayToken !== 'string' || !gatewayToken) return '';
    return crypto
      .createHmac('sha256', gatewayToken)
      .update(`openclaw-extension-relay-v1:${port}`)
      .digest('hex');
  } catch {
    return '';
  }
}

function publicError(error) {
  if (error?.name === 'AbortError') return 'Relay status check timed out.';
  const message = String(error?.message || error);
  return message.replace(/[A-Fa-f0-9]{32,}/g, '[redacted]');
}
