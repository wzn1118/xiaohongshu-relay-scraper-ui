import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiProxy = process.env.VITE_API_PROXY
  || `http://127.0.0.1:${process.env.VITE_API_PORT || '4317'}`

export default defineConfig({
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
      '/api': { target: apiProxy, ws: true },
      '/v1/device-tunnel': { target: apiProxy, ws: true },
      // Keep the Codex app route proxied without hijacking the standalone
      // Native Mirror assets (`/codex-native-mirror.*`).
      '^/codex(?:/|$)': apiProxy,
    },
  },
})
