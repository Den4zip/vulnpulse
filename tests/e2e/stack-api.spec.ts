import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ApiResult, StackComponentInput } from '../../src/shared/api'

const component = (version = '1.0.0', name = 'CRUD demo'): StackComponentInput => ({ kind: 'package', name, product: 'crud-demo',
  version, purl: `pkg:npm/crud-demo@${version}` })
const value = <T>(result: ApiResult<T>): T => { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.code); return result.value }

test('stack IPC preserves revisions, import compatibility, match consistency and data across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vulnpulse-stack-api-'))
  const profile = join(directory, 'profile')
  const launcher = join(directory, 'launch.cjs')
  const databasePath = join(profile, 'vulnpulse.db')
  writeFileSync(launcher, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});delete process.env.ELECTRON_RENDERER_URL;require(${JSON.stringify(resolve('out/main/index.js'))});`)
  let app: ElectronApplication | undefined
  const counts = () => {
    const db = new DatabaseSync(databasePath, { readOnly: true })
    try { return db.prepare(`SELECT (SELECT count(*) FROM stack) AS components, (SELECT count(*) FROM matches) AS matches,
      (SELECT count(*) FROM vulnerabilities) AS cards, (SELECT count(*) FROM notes) AS notes, (SELECT count(*) FROM sla) AS sla`).get() }
    finally { db.close() }
  }
  try {
    app = await electron.launch({ args: [launcher], cwd: resolve('.') })
    let page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'VulnPulse Desktop' })).toBeVisible()
    expect(await page.evaluate(() => Object.keys(window.electronAPI.stack))).toEqual(['list', 'get', 'create', 'update', 'remove'])
    expect(value(await page.evaluate(() => window.electronAPI.stack.list())).total).toBe(0)
    const created = value(await page.evaluate(input => window.electronAPI.stack.create(input), component())).item
    expect(created).toMatchObject({ vendor: null, version: '1.0.0' })
    expect(await page.evaluate(input => window.electronAPI.stack.create(input), component())).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(await page.evaluate(input => window.electronAPI.stack.create(input as any), { ...component(), version: '2.0.0' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(await page.evaluate(() => window.electronAPI.stack.list({ limit: 101 }))).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })

    // Keep native dialogs mocked, exercising the production inventory menu/parser/transaction.
    await app.evaluate(({ dialog, Menu }, path) => {
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
      Menu.getApplicationMenu()!.getMenuItemById('stack-config')!.click(undefined as any, undefined as any, undefined as any)
    }, resolve('examples/local-stack.example.json'))
    await expect.poll(() => app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('stack-config')!.enabled)).toBe(true)
    const imported = value(await page.evaluate(() => window.electronAPI.stack.list({ sort: 'id', direction: 'asc' })))
    expect(imported.total).toBe(5)
    const legacy = imported.items[1]
    const legacyComponent: StackComponentInput = { kind: legacy.kind, name: 'Renamed imported component', vendor: legacy.vendor,
      product: legacy.product, version: legacy.version!, purl: legacy.purl, cpe23: legacy.cpe23 }
    const editedLegacy = value(await page.evaluate(input => window.electronAPI.stack.update(input), {
      id: legacy.id, expectedUpdatedAt: legacy.updatedAt, component: legacyComponent
    })).item
    expect(editedLegacy.createdAt).toBe(legacy.createdAt)
    expect(editedLegacy.updatedAt).not.toBe(legacy.updatedAt)

    // Fixture-only match rows stand in for the not-yet-connected matcher persistence.
    const fixture = new DatabaseSync(databasePath)
    try {
      fixture.exec('PRAGMA foreign_keys=ON')
      const feed = fixture.prepare("INSERT INTO feeds(name,source) VALUES('osv','local:osv-json') RETURNING id").get()!
      const vuln = fixture.prepare("INSERT INTO vulnerabilities(ext_id,feed_id,status) VALUES('CRUD-DEMO',?,'Affected') RETURNING id").get(feed.id)!
      fixture.prepare("INSERT INTO notes(vulnerability_id,body) VALUES(?,'keep note')").run(vuln.id)
      fixture.prepare("INSERT INTO sla(vulnerability_id,due_at) VALUES(?,'2026-12-01')").run(vuln.id)
      fixture.prepare('INSERT INTO matches(vulnerability_id,stack_id) VALUES(?,?)').run(vuln.id, created.id)
      fixture.prepare('INSERT INTO matches(vulnerability_id,stack_id) VALUES(?,?)').run(vuln.id, legacy.id)
    } finally { fixture.close() }
    const renamed = value(await page.evaluate(input => window.electronAPI.stack.update(input), {
      id: created.id, expectedUpdatedAt: created.updatedAt, component: component('1.0.0', 'Renamed')
    }))
    expect(renamed.invalidatedMatches).toBe(0)
    expect(counts()).toMatchObject({ components: 5, matches: 2, cards: 1, notes: 1, sla: 1 })
    const stale = { id: created.id, expectedUpdatedAt: created.updatedAt }
    expect(await page.evaluate(input => window.electronAPI.stack.remove(input), stale)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(await page.evaluate(input => window.electronAPI.stack.update(input), { ...stale, component: component('1.1.0') })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    const changed = value(await page.evaluate(input => window.electronAPI.stack.update(input), {
      id: created.id, expectedUpdatedAt: renamed.item.updatedAt, component: component('1.1.0')
    }))
    expect(changed).toMatchObject({ invalidatedMatches: 1, matchingRecomputed: false, item: { id: created.id, version: '1.1.0' } })
    expect(counts()).toMatchObject({ components: 5, matches: 1, cards: 1, notes: 1, sla: 1 })
    expect(value(await page.evaluate(() => window.electronAPI.stack.list({ search: 'crud-demo', kind: 'package', offset: 0, limit: 1 }))).items).toEqual([changed.item])
    expect(value(await page.evaluate(() => window.electronAPI.stack.list({ offset: 99 }))).total).toBe(5)

    // The same local file/preload in another window has no read or write authority.
    const forbidden = await app.evaluate(async ({ BrowserWindow }, paths) => {
      const other = new BrowserWindow({ show: false, webPreferences: { preload: paths.preload, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      try {
        await other.loadFile(paths.renderer)
        return await other.webContents.executeJavaScript(`Promise.all([
          window.electronAPI.stack.list(), window.electronAPI.stack.get(1), window.electronAPI.stack.create({}),
          window.electronAPI.stack.update({}), window.electronAPI.stack.remove({})])`)
      } finally { other.destroy() }
    }, { preload: resolve('out/preload/index.js'), renderer: resolve('out/renderer/index.html') })
    expect(forbidden).toHaveLength(5)
    expect(forbidden.every((result: ApiResult<unknown>) => !result.ok && result.error.code === 'FORBIDDEN')).toBe(true)

    await app.evaluate(({ dialog, Menu }) => {
      dialog.showOpenDialog = (() => new Promise(resolveDialog => {
        ;(globalThis as any).__releaseStackDialog = () => resolveDialog({ canceled: true, filePaths: [] })
      })) as typeof dialog.showOpenDialog
      Menu.getApplicationMenu()!.getMenuItemById('stack-config')!.click(undefined as any, undefined as any, undefined as any)
    })
    expect(value(await page.evaluate(() => window.electronAPI.stack.list())).total).toBe(5)
    expect(await page.evaluate(input => window.electronAPI.stack.create(input), component('3.0.0'))).toMatchObject({ ok: false, error: { code: 'BUSY' } })
    expect(await page.evaluate(input => window.electronAPI.stack.update(input), { id: created.id, expectedUpdatedAt: changed.item.updatedAt, component: component('1.2.0') })).toMatchObject({ ok: false, error: { code: 'BUSY' } })
    expect(await page.evaluate(input => window.electronAPI.stack.remove(input), { id: created.id, expectedUpdatedAt: changed.item.updatedAt })).toMatchObject({ ok: false, error: { code: 'BUSY' } })
    await app.evaluate(() => (globalThis as any).__releaseStackDialog())
    await expect.poll(() => app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('stack-config')!.enabled)).toBe(true)
    await app.close(); app = undefined
    app = await electron.launch({ args: [launcher], cwd: resolve('.') })
    page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'VulnPulse Desktop' })).toBeVisible()
    expect(value(await page.evaluate(id => window.electronAPI.stack.get(id), created.id))).toEqual(changed.item)
    expect(value(await page.evaluate(input => window.electronAPI.stack.remove(input), {
      id: created.id, expectedUpdatedAt: changed.item.updatedAt
    }))).toEqual({ id: created.id, removedMatches: 0 })
    expect(await page.evaluate(id => window.electronAPI.stack.get(id), created.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(counts()).toMatchObject({ components: 4, matches: 1, cards: 1, notes: 1, sla: 1 })
    expect(value(await page.evaluate(() => window.electronAPI.vulnerabilities.list())).items[0].status).toBe('Affected')
  } finally {
    await app?.evaluate(() => (globalThis as any).__releaseStackDialog?.()).catch(() => {})
    await app?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
