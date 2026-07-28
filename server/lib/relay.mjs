import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function probeRelay({ port, openClawConfigPath, timeoutMs = 2500, fetchImpl = fetch }) {
  const checkedAt = new Date().toISOString();
  try {
    const gatewayConfig = JSON.parse(await readFile(openClawConfigPath, 'utf8'));
    const gatewayToken = gatewayConfig?.gateway?.auth?.token;
    if (typeof gatewayToken !== 'string' || !gatewayToken) throw new Error('Gateway token is missing.');
    const relayToken = crypto
      .createHmac('sha256', gatewayToken)
      .update(`openclaw-extension-relay-v1:${port}`)
      .digest('hex');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
        headers: { 'x-openclaw-relay-token': relayToken },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Relay responded with HTTP ${response.status}.`);
      const tabs = await response.json();
      if (!Array.isArray(tabs)) throw new Error('Relay returned an invalid tab list.');
      return {
        ok: true,
        running: true,
        cdpReady: true,
        authenticated: true,
        port,
        tabs: tabs.length,
        tabCount: tabs.length,
        xiaohongshuTabs: tabs.filter((tab) => /xiaohongshu\.com/i.test(String(tab?.url || ''))).length,
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

function publicError(error) {
  if (error?.name === 'AbortError') return 'Relay status check timed out.';
  const message = String(error?.message || error);
  return message.replace(/[A-Fa-f0-9]{32,}/g, '[redacted]');
}
