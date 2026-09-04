import assert from 'node:assert/strict';
import test from 'node:test';
import { createProxyAwareFetch, resolveProxyForUrl } from './proxy-aware-fetch.mjs';

test('proxy resolution uses the HTTPS proxy for remote secure URLs', () => {
  const proxy = resolveProxyForUrl('https://models.example/v1/models', {
    environment: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
  });
  assert.equal(proxy?.href, 'http://127.0.0.1:7890/');
});

test('proxy resolution respects local and NO_PROXY targets', () => {
  const environment = { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'api.internal.example' };
  assert.equal(resolveProxyForUrl('https://127.0.0.1:4327/api/health', { environment }), null);
  assert.equal(resolveProxyForUrl('https://api.internal.example/v1', { environment }), null);
  assert.equal(resolveProxyForUrl('https://child.api.internal.example/v1', { environment }), null);
});

test('proxy-aware fetch keeps direct requests direct when no proxy applies', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const fetch = createProxyAwareFetch({ fetchImpl, environment: { HTTPS_PROXY: 'http://127.0.0.1:7890' } });
  const response = await fetch('http://127.0.0.1:4327/api/health');
  assert.equal(response.ok, true);
  assert.equal(calls.length, 1);
});
