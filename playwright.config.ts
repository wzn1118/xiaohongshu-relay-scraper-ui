import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { defineConfig, devices } from '@playwright/test'

const apiPort = process.env.PLAYWRIGHT_API_PORT || '4318'
const webPort = process.env.PLAYWRIGHT_WEB_PORT || '5190'
const apiUrl = `http://127.0.0.1:${apiPort}`
const webUrl = `http://127.0.0.1:${webPort}`
const configuredServerDataRoot = process.env.PLAYWRIGHT_SERVER_DATA_ROOT
const serverDataRoot = configuredServerDataRoot
  ? path.resolve(configuredServerDataRoot)
  : mkdtempSync(path.join(tmpdir(), 'xhs-relay-e2e-'))

if (!configuredServerDataRoot) {
  process.once('exit', () => {
    try {
      rmSync(serverDataRoot, { recursive: true, force: true })
    } catch {
      // A unique temporary root still prevents state reuse if forced shutdown delays cleanup.
    }
  })
}

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results/playwright',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['line']],
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { animations: 'disabled', caret: 'hide' },
  },
  use: {
    baseURL: webUrl,
    navigationTimeout: 45_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'node server/index.mjs',
      url: `${apiUrl}/api/health`,
      env: {
        HOST: '127.0.0.1',
        PORT: apiPort,
        XHS_MCP_ENABLED: 'false',
        XHS_SERVER_DATA_DIR: path.join(serverDataRoot, 'jobs'),
        XHS_PROFILE_DATA_DIR: path.join(serverDataRoot, 'profiles'),
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npm exec vite -- --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: webUrl,
      env: {
        VITE_API_PORT: apiPort,
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
