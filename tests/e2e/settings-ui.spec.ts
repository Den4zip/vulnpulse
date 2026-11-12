import { test, expect } from '@playwright/test'
import { launchCatalog } from './catalog-helpers'

test('settings UI saves schedules, handles stale revisions, and clears the NVD key field', async () => {
  const context = await launchCatalog()
  const { page, app } = context
  try {
    await page.getByRole('link', { name: 'Настройки' }).click()
    await expect(page.getByRole('heading', { name: 'Настройки' })).toBeFocused()
    const cisa = page.locator('.settings-feed').filter({ hasText: 'CISA KEV' })
    await cisa.getByRole('spinbutton').fill('180')
    await page.getByRole('button', { name: 'Сохранить расписание' }).click()
    await expect(page.getByRole('status')).toContainText('Расписание сохранено')
    const current = await page.evaluate(() => window.electronAPI.settings.get())
    expect(current.ok && current.value.feeds.cisa.intervalMinutes).toBe(180)
    if (!current.ok) throw new Error('settings unavailable')
    await page.evaluate(command => window.electronAPI.settings.update(command), { expectedRevision: current.value.revision, feeds: current.value.feeds })
    await cisa.getByRole('spinbutton').fill('240')
    await page.getByRole('button', { name: 'Сохранить расписание' }).click()
    await expect(page.getByRole('alert')).toContainText('Данные изменились')
    await expect(cisa.getByRole('spinbutton')).toHaveValue('240')
    await page.getByRole('button', { name: 'Обновить', exact: true }).click()
    await expect(cisa.getByRole('spinbutton')).toHaveValue('180')
    if (current.value.nvdKey.storageAvailable) {
      await page.getByLabel('Новый ключ').fill('test-key')
      await page.getByRole('button', { name: 'Сохранить ключ' }).click()
      await expect(page.getByRole('status')).toContainText('Ключ сохранён')
      await expect(page.getByLabel('Новый ключ')).toHaveValue('')
      await page.getByRole('button', { name: 'Удалить ключ' }).click()
      await expect(page.getByRole('status')).toContainText('Ключ удалён')
    }
    await expect(page.getByText('Локальный импорт JSON. Данные стека не отправляются в OSV.')).toBeVisible()
  } finally { await app.close(); context.cleanup() }
})
