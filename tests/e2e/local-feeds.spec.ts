import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

test('built Electron imports XML/OSV demos through menus, rejects wrong formats and preserves data', async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'vulnpulse-local-feeds-'))
  const profile = join(directory, 'profile')
  const launcher = join(directory, 'launch.cjs')
  writeFileSync(launcher, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});require(${JSON.stringify(resolve('out/main/index.js'))});`)
  let app: ElectronApplication | undefined
  const snapshot = () => {
    const db = new DatabaseSync(join(profile, 'vulnpulse.db'), { readOnly: true })
    try {
      return {
        sources: db.prepare('SELECT id, source_id, raw_json FROM source_records ORDER BY id').all(),
        cards: db.prepare('SELECT id, ext_id, status FROM vulnerabilities ORDER BY id').all(),
        links: db.prepare('SELECT * FROM vulnerability_sources ORDER BY vulnerability_id, source_record_id').all()
      }
    } finally { db.close() }
  }
  try {
    app = await electron.launch({ args: [launcher], cwd: resolve('.') })
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'VulnPulse Desktop' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Уязвимости', exact: true })).toBeVisible()
    // Stub only OS dialogs: production menu, file readers, XML worker and DB run unchanged.
    await app.evaluate(({ dialog }) => {
      const state = { path: '', canceled: false, messages: [] as Array<{ type?: string; title?: string; message: string }> }
      ;(globalThis as any).__feedsTest = state
      dialog.showOpenDialog = (async () => ({ canceled: state.canceled, filePaths: [state.path] })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async (options: any) => {
        state.messages.push({ type: options.type, title: options.title, message: options.message })
        return { response: 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    })
    const load = async (id: string, path: string, canceled = false) => {
      await app!.evaluate(({ Menu }, input) => {
        const state = (globalThis as any).__feedsTest
        state.path = input.path; state.canceled = input.canceled
        Menu.getApplicationMenu()!.getMenuItemById(input.id)!.click(undefined as any, undefined as any, undefined as any)
      }, { id, path, canceled })
      await expect.poll(() => app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('osv-file')!.enabled)).toBe(true)
    }
    const xml = resolve('examples/fstec-demo.xml')
    const json = resolve('examples/osv-demo.json')
    await load('fstec-file', xml)
    expect(snapshot().sources).toHaveLength(2)
    await load('osv-file', json)
    const imported = snapshot()
    expect(imported.sources).toHaveLength(5)
    expect(imported.links).toHaveLength(5)
    expect(imported.cards.map(row => row.ext_id)).toEqual(['BDU:0000-00001', 'BDU:0000-00002', 'DEMO-LOCAL-0001', 'DEMO-LOCAL-0002', 'DEMO-LOCAL-0003'])
    await load('fstec-file', xml)
    await load('osv-file', json)
    expect(snapshot()).toEqual(imported)
    await load('osv-file', xml)
    await load('fstec-file', json)
    expect(snapshot()).toEqual(imported)
    await load('osv-file', json, true)
    const messages = await app.evaluate(() => (globalThis as any).__feedsTest.messages)
    expect(messages).toHaveLength(6)
    expect(messages.slice(0, 4)).toEqual([
      { type: 'info', title: 'Импорт ФСТЭК', message: 'Обработано записей: 2.' },
      { type: 'info', title: 'Импорт OSV', message: 'Обработано записей: 3.' },
      { type: 'info', title: 'Импорт ФСТЭК', message: 'Обработано записей: 2.' },
      { type: 'info', title: 'Импорт OSV', message: 'Обработано записей: 3.' }
    ])
    expect(messages.slice(4).map((message: { type: string }) => message.type)).toEqual(['error', 'error'])
    await page.screenshot({ path: testInfo.outputPath('local-feeds.png') })
    await app.close(); app = undefined
    app = await electron.launch({ args: [launcher], cwd: resolve('.') })
    await expect((await app.firstWindow()).getByRole('heading', { name: 'VulnPulse Desktop' })).toBeVisible()
    expect(snapshot()).toEqual(imported)
  } finally {
    await app?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
