import test from 'node:test';
import assert from 'node:assert/strict';
import { probeNativeBrowser } from './lib/native-browser.mjs';

function response({ ok, status = ok ? 200 : 401, body }) {
  return Object.freeze({
    ok,
    status,
    json: async () => body,
  });
}

test('native browser probe sends the relay token without mutating fetch responses', async () => {
  const requests = [];
  const status = await probeNativeBrowser({
    port: 18800,
    relayToken: 'derived-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, headers: options?.headers || {} });
      if (url.endsWith('/json/version')) {
        return response({ ok: true, body: { Browser: 'Chrome', webSocketDebuggerUrl: 'ws://127.0.0.1/browser' } });
      }
      return response({ ok: true, body: [{ url: 'https://www.xiaohongshu.com/explore' }] });
    },
  });

  assert.equal(status.running, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.xiaohongshuTabs, 1);
  assert.deepEqual(requests.map((entry) => entry.headers['x-openclaw-relay-token']), ['derived-token', 'derived-token']);
});

test('native browser probe falls back to an unauthenticated local CDP endpoint', async () => {
  const requests = [];
  const status = await probeNativeBrowser({
    port: 18800,
    relayToken: 'stale-token',
    fetchImpl: async (url, options) => {
      const hasToken = Boolean(options?.headers?.['x-openclaw-relay-token']);
      requests.push({ url, hasToken });
      if (hasToken) return response({ ok: false, body: {} });
      if (url.endsWith('/json/version')) return response({ ok: true, body: { Browser: 'Chrome' } });
      return response({ ok: true, body: [] });
    },
  });

  assert.equal(status.running, true);
  assert.equal(status.authenticated, false);
  assert.deepEqual(requests.map((entry) => entry.hasToken), [true, false, true, false]);
});
