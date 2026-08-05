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
      // Playwright creates and removes this transient directory while tests run.
      // Chokidar must not crash the dev server when that directory disappears.
      ignored: ['**/.playwright-cli/**'],
    },
    proxy: {
      '/api': apiProxy,
    },
  },
})
