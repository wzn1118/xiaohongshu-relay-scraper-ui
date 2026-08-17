import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const PROXY_ENVIRONMENT_NAMES = Object.freeze({
  http: ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'],
  https: ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'],
});

export function resolveProxyForUrl(value, { environment = process.env } = {}) {
  let target;
  try { target = new URL(String(value)); } catch { return null; }
  if (!['http:', 'https:'].includes(target.protocol) || isLocalHost(target.hostname) || bypassesProxy(target, environment)) return null;
  const candidate = proxyEnvironmentValue(target.protocol, environment);
  if (!candidate) return null;
  try {
    const proxy = new URL(candidate.includes('://') ? candidate : `http://${candidate}`);
    return ['http:', 'https:'].includes(proxy.protocol) && proxy.hostname ? proxy : null;
  } catch {
    return null;
  }
}

export function createProxyAwareFetch({ fetchImpl = globalThis.fetch, environment = process.env } = {}) {
  if (typeof fetchImpl !== 'function') return fetchImpl;
  return async function proxyAwareFetch(input, init = {}) {
    const target = requestUrl(input);
    const proxy = resolveProxyForUrl(target, { environment });
    if (!proxy) return fetchImpl(input, init);
    return fetchThroughProxy(new URL(target), proxy, init);
  };
}

function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return String(input);
  if (input && typeof input.url === 'string') return input.url;
  return String(input);
}

function proxyEnvironmentValue(protocol, environment) {
  const names = PROXY_ENVIRONMENT_NAMES[protocol === 'https:' ? 'https' : 'http'];
  for (const name of names) {
    const value = String(environment?.[name] || '').trim();
    if (value) return value;
  }
  return '';
}

function bypassesProxy(target, environment) {
  const entries = String(environment?.NO_PROXY || environment?.no_proxy || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const hostname = target.hostname.toLowerCase();
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  return entries.some((entry) => {
    if (entry === '*') return true;
    const normalized = entry.replace(/^\./u, '');
    const [entryHost, entryPort] = normalized.split(':', 2);
    if (entryPort && entryPort !== port) return false;
    return hostname === entryHost || hostname.endsWith(`.${entryHost}`);
  });
}

function isLocalHost(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === '::1' || value === '127.0.0.1' || value.endsWith('.local');
}

async function fetchThroughProxy(target, proxy, init) {
  if (target.protocol === 'http:') return fetchHttpThroughProxy(target, proxy, init);
  const tunnel = await openTunnel(proxy, target, init.signal);
  return requestViaTunnel(target, proxy, tunnel, init);
}

function fetchHttpThroughProxy(target, proxy, init) {
  const headers = normalizedHeaders(init.headers);
  headers.host ||= target.host;
  applyProxyAuthorization(headers, proxy);
  return requestResponse(proxyTransport(proxy), {
    hostname: proxy.hostname,
    port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)),
    method: String(init.method || 'GET').toUpperCase(),
    path: target.href,
    headers,
  }, init);
}

function openTunnel(proxy, target, signal) {
  return new Promise((resolve, reject) => {
    const headers = { host: `${target.hostname}:${target.port || 443}` };
    applyProxyAuthorization(headers, proxy);
    const request = proxyTransport(proxy).request({
      hostname: proxy.hostname,
      port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)),
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers,
    });
    const abort = () => request.destroy(abortError());
    signal?.addEventListener('abort', abort, { once: true });
    request.once('connect', (response, socket, head) => {
      signal?.removeEventListener('abort', abort);
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT returned HTTP ${response.statusCode || 0}.`));
        return;
      }
      if (head?.length) socket.unshift(head);
      resolve(socket);
    });
    request.once('error', (error) => {
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    request.end();
  });
}

function proxyTransport(proxy) {
  return proxy.protocol === 'https:' ? https : http;
}

function requestViaTunnel(target, _proxy, tunnel, init) {
  const headers = normalizedHeaders(init.headers);
  const agent = new TunnelAgent(tunnel, target.hostname);
  return requestResponse(https, {
    hostname: target.hostname,
    port: Number(target.port || 443),
    method: String(init.method || 'GET').toUpperCase(),
    path: `${target.pathname}${target.search}`,
    headers,
    agent,
  }, init).finally(() => agent.destroy());
}

class TunnelAgent extends https.Agent {
  constructor(tunnel, servername) {
    super({ keepAlive: false });
    this.tunnel = tunnel;
    this.servername = servername;
  }

  createConnection(_options, callback) {
    const socket = tls.connect({ socket: this.tunnel, servername: this.servername });
    if (typeof callback === 'function') {
      socket.once('secureConnect', () => callback(null, socket));
      socket.once('error', callback);
      return undefined;
    }
    return socket;
  }
}

function requestResponse(transport, options, init) {
  return new Promise((resolve, reject) => {
    const request = transport.request(options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('error', reject);
      response.once('end', () => {
        const status = Number(response.statusCode) || 502;
        const body = status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks);
        resolve(new Response(body, { status, statusText: response.statusMessage || '', headers: response.headers }));
      });
    });
    const abort = () => request.destroy(abortError());
    init.signal?.addEventListener('abort', abort, { once: true });
    request.once('error', (error) => {
      init.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    request.once('close', () => init.signal?.removeEventListener('abort', abort));
    const body = requestBody(init.body);
    if (body && !hasHeader(options.headers, 'content-length')) request.setHeader('content-length', String(body.length));
    request.end(body);
  });
}

function normalizedHeaders(value) {
  return Object.fromEntries(new Headers(value || {}).entries());
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function applyProxyAuthorization(headers, proxy) {
  if (!proxy.username && !proxy.password) return;
  const credential = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  headers['proxy-authorization'] = `Basic ${Buffer.from(credential).toString('base64')}`;
}

function requestBody(value) {
  if (value === undefined || value === null) return undefined;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof URLSearchParams) return Buffer.from(value.toString());
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Proxy-aware fetch supports string and binary request bodies only.');
}

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError');
}
