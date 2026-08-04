import { expect, test } from '@playwright/test'

const initialApiPaths = [
  '/api/health',
  '/api/jobs',
  '/api/relay/config',
  '/api/email/config',
  '/api/relay/status',
]

test('loads the workbench against the live API without runtime failures', async ({ page }) => {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const failedApiRequests: string[] = []
  const nonOkApiResponses: string[] = []

  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('requestfailed', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.startsWith('/api/')) {
      failedApiRequests.push(`${request.method()} ${pathname}: ${request.failure()?.errorText || 'failed'}`)
    }
  })
  page.on('response', (response) => {
    const pathname = new URL(response.url()).pathname
    if (pathname.startsWith('/api/') && !response.ok()) {
      nonOkApiResponses.push(`${response.request().method()} ${pathname}: ${response.status()}`)
    }
  })

  const initialResponses = initialApiPaths.map((pathname) =>
    page.waitForResponse((response) => new URL(response.url()).pathname === pathname),
  )

  await page.goto('/')
  const responses = await Promise.all(initialResponses)

  for (const response of responses) {
    expect(response.ok(), `${response.request().method()} ${response.url()}`).toBeTruthy()
    await response.json()
  }
  await expect(page.locator('.app-shell')).toBeVisible()
  await expect(page.locator('#product-hero-title')).toBeVisible()
  await expect(page.getByText('本地服务正常', { exact: true })).toBeVisible()

  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(horizontalOverflow).toBeLessThanOrEqual(1)
  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
  expect(failedApiRequests).toEqual([])
  expect(nonOkApiResponses).toEqual([])
})
