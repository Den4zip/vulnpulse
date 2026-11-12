import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

test('built Electron: preload isolation, local config import, repeat, rollback and persistence', async ({}, testInfo) => {
  const dir = mkdtempSync(join(tmpdir(), 'vulnpulse-e2e-'))
  const profile = join(dir, 'profile')
  const launcher = join(dir, 'launch.cjs')
  writeFileSync(launcher, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});require(${JSON.stringify(resolve('out/main/index.js'))});`)
  const sample = resolve('examples/local-stack.example.json')
  const invalid = join(dir, 'invalid.json')
  const parsed = JSON.parse(readFileSync(sample, 'utf8'))
  writeFileSync(invalid, JSON.stringify({ schemaVersion: 1, components: [
    { kind: 'package', name: 'New component', product: 'new-package', version: '1.0.0', purl: 'pkg:npm/new-package@1.0.0' },
    { ...parsed.components[0], name: 'Conflicting metadata' }
  ] }))
  let app: ElectronApplication | undefined
  const rows = () => {
    const db = new DatabaseSync(join(profile, 'vulnpulse.db'), { readOnly: true })
    try { return db.prepare('SELECT id, name, product, version FROM stack ORDER BY id').all() }
    finally { db.close() }
  }
  try {
    app = await electron.launch({ args: [launcher], cwd: resolve('.') })
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await expect(page.getByRole('heading', { name: 'VulnPulse Desktop' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Уязвимости', exact: true })).toBeVisible()
    expect(await page.evaluate(() => ({ require: typeof (window as any).require, process: typeof (window as any).process,
      ping: (window as any).electronAPI.ping() }))).toEqual({ require: 'undefined', process: 'undefined', ping: 'VulnPulse preload ready' })
    expect(await app.evaluate(({ BrowserWindow }) => {
      const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
      return { contextIsolation: prefs?.contextIsolation, nodeIntegration: prefs?.nodeIntegration }
    })).toEqual({ contextIsolation: true, nodeIntegration: false })

    // Native OS dialogs are replaced only in the test process. The real menu handler,
    // file reader, validator, SQLite transaction and built preload/renderer run unchanged.
    await app.evaluate(({ dialog }) => {
      const state = { path: '', canceled: false, messages: [] as Array<{ type?: string; message: string }> }
      ;(globalThis as any).__configTest = state
      dialog.showOpenDialog = (async () => ({ canceled: state.canceled, filePaths: [state.path] })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async (options: any) => {
        state.messages.push({ type: options.type, message: options.message })
        return { response: 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    })
    const load = async (path: string, canceled = false) => {
      await app!.evaluate(({ Menu }, input) => {
        const state = (globalThis as any).__configTest
        state.path = input.path; state.canceled = input.canceled
        const item = Menu.getApplicationMenu()!.getMenuItemById('stack-config')!
        item.click(undefined as any, undefined as any, undefined as any)
      }, { path, canceled })
      await expect.poll(() => app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('stack-config')!.enabled)).toBe(true)
    }
    await load(sample)
    expect(rows()).toHaveLength(4)
    const imported = rows()
    await load(sample)
    expect(rows()).toEqual(imported)
    await load(invalid)
    expect(rows()).toEqual(imported)
    await load(sample, true)
    const messages = await app.evaluate(() => (globalThis as any).__configTest.messages)
    expect(messages).toEqual([
      { type: 'info', message: 'Добавлено: 4. Уже загружено: 0. Всего компонентов: 4.' },
      { type: 'info', message: 'Добавлено: 0. Уже загружено: 4. Всего компонентов: 4.' },
      { type: 'error', message: 'Конфигурация не загружена.' }
    ])
    expect(errors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('startup.png') })
    await app.close(); app = undefined
    app = await electron.launch({ args: [launcher], cwd: resolve('.') })
    await expect((await app.firstWindow()).getByRole('heading', { name: 'VulnPulse Desktop' })).toBeVisible()
    expect(rows()).toEqual(imported)
  } finally {
    await app?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
