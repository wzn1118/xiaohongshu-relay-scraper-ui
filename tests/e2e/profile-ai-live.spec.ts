import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { expect, test } from '@playwright/test'

const liveBaseUrl = process.env.PROFILE_AI_E2E_BASE_URL

test.describe('background profile AI live integration', () => {
  test.skip(!liveBaseUrl, 'Set PROFILE_AI_E2E_BASE_URL to run against a real API instance.')

  test('restores the selected model output into first-person memory and signature fields', async ({ page }) => {
    await page.goto(liveBaseUrl!, { waitUntil: 'domcontentloaded' })

    await expect(page.getByText('求职信署名信息', { exact: true })).toBeVisible()
    await expect(page.getByLabel('姓名')).toHaveValue('林知远')
    await expect(page.getByLabel('学校')).toHaveValue('海川大学')
    await expect(page.getByLabel('专业')).toHaveValue('数据科学')
    await expect(page.getByLabel('年级/学历')).toHaveValue('研二')
    await expect(page.getByLabel('电话/微信')).toHaveValue('')
    await expect(page.getByLabel('邮箱', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('每周可实习天数')).toHaveValue('5')
    await expect(page.getByLabel('预计实习时长')).toHaveValue('6个月')

    await expect(page.getByText('local_qwen / qwen3.5:4b', { exact: true })).toBeVisible()
    await expect(page.getByText('2 条可核验证据', { exact: true })).toBeVisible()
    await expect(page.getByText(/我是海川大学数据科学专业研二学生/)).toBeVisible()
    await expect(page.getByText('SQL · Power BI', { exact: true })).toBeVisible()
    await expect(page.getByText(/待补充：电话或微信、邮箱/)).toBeVisible()

    const screenshotPath = path.resolve(
      process.env.PROFILE_AI_E2E_SCREENSHOT || 'test-results/profile-ai-live.png',
    )
    await mkdir(path.dirname(screenshotPath), { recursive: true })
    await page.locator('#ai-memory').screenshot({ path: screenshotPath })
  })
})
