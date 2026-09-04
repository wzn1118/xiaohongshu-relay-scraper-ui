import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const defaultApiProxy = `http://127.0.0.1:${process.env.VITE_API_PORT || '4317'}`
const configuredApiProxy = process.env.VITE_API_PROXY || ''
const explicitCodexApiProxy = process.env.VITE_CODEX_API_PROXY || ''

const codexProxy = (target: string) => ({
  target,
  ws: true,
  // The signed connector launch URL must use the actual upstream origin,
  // rather than the Vite browser origin (5173).
  changeOrigin: true,
})

async function probeApiProxy(origin: string) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 900)
  try {
    const response = await fetch(`${origin}/api/health`, {
      headers: { 'cache-control': 'no-cache' },
      signal: controller.signal,
    })
    if (!response.ok) return { origin, score: 0 }
    const health = await response.json().catch(() => ({})) as { port?: number }
    let relayScore = 0
    try {
      const relayResponse = await fetch(`${origin}/api/codex-relay/status`, {
        headers: { 'cache-control': 'no-cache' },
        signal: controller.signal,
      })
      const relay = await relayResponse.json().catch(() => ({})) as {
        adapter?: { state?: string }
        gateway?: { onlineDevices?: number }
      }
      relayScore = (Number(relay?.gateway?.onlineDevices) > 0 ? 4 : 0)
        + (relay?.adapter?.state === 'compatible' ? 2 : 0)
    } catch {
      // A healthy API is still a valid fallback when Codex is starting.
    }
    return { origin, score: relayScore + (Number(health?.port) > 0 ? 1 : 0) }
  } catch {
    return { origin, score: -1 }
  } finally {
    clearTimeout(timer)
  }
}

async function resolveApiProxy() {
  if (configuredApiProxy) return configuredApiProxy
  const candidates = [...new Set([
    process.env.VITE_CODEX_API_PORT ? `http://127.0.0.1:${process.env.VITE_CODEX_API_PORT}` : '',
    'http://127.0.0.1:4327',
    defaultApiProxy,
  ].filter(Boolean))]
  const results = await Promise.all(candidates.map((candidate) => probeApiProxy(candidate)))
  return results
    .sort((left, right) => right.score - left.score)
    .find((result) => result.score >= 0)?.origin || defaultApiProxy
}

export default defineConfig(async ({ command }) => {
  const runtimeApiProxy = command === 'serve' ? await resolveApiProxy() : configuredApiProxy || defaultApiProxy
  const codexApiProxy = explicitCodexApiProxy || runtimeApiProxy
  const codexProxyOptions = codexProxy(codexApiProxy)
  return {
    plugins: [react()],
    server: {
      host: '::',
      port: 5173,
      watch: {
        // Generated artifacts include the complete Codex desktop runtime and must
        // stay outside the frontend hot-reload graph.
        ignored: ['**/.playwright-cli/**', '**/output/**'],
      },
      proxy: {
        // Keep every Codex/browser-host request on the same backend as the
        // selected local device. Put these before the generic API fallback.
        '^/api/(?:codex(?:-|/|$)|xhs-context(?:/|$))': codexProxyOptions,
        '^/codex(?:/|$)': codexProxyOptions,
        '/api': { target: runtimeApiProxy, ws: true },
        '/v1/device-tunnel': codexProxyOptions,
      },
    },
  }
})
