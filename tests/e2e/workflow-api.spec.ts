import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ApiResult, SlaEntry } from '../../src/shared/api'

const value = <T>(result: ApiResult<T>): T => { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.code); return result.value }
const token = (row: Pick<SlaEntry, 'id' | 'revision'>) => ({ id: row.id, revision: row.revision })

test('workflow IPC migrates legacy notes/SLA, enforces revisions and preserves work across imports/restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vulnpulse-workflow-api-'))
  const profile = join(directory, 'profile')
  mkdirSync(profile)
  const path = join(profile, 'vulnpulse.db')
  const legacy = new DatabaseSync(path)
  try {
    legacy.exec(`PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`)
    for (const [folder, name] of [['20261023190921_init', '001_init'], ['20261105132927_dark_masque', '002_source_records'],
      ['20261106163217_nvd_checkpoint', '003_nvd_checkpoint']]) {
      legacy.exec(readFileSync(resolve('src/main/db/migrations', folder, 'migration.sql'), 'utf8'))
      legacy.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run(name)
    }
    legacy.exec(`INSERT INTO feeds(id,name,source) VALUES(1,'nvd','fixture');
      INSERT INTO vulnerabilities(id,ext_id,feed_id,status) VALUES(1,'DEMO-LOCAL-0001',1,'Affected');
      INSERT INTO notes(id,vulnerability_id,body,created_at) VALUES(20,1,'Legacy note','2026-11-06 12:00:00');
      INSERT INTO sla(id,vulnerability_id,due_at) VALUES(30,1,'2026-12-01');`)
  } finally { legacy.close() }
  const launcher = join(directory, 'launch.cjs')
  writeFileSync(launcher, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});delete process.env.ELECTRON_RENDERER_URL;require(${JSON.stringify(resolve('out/main/index.js'))});`)
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: [launcher], cwd: resolve('.') })
    let page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'VulnPulse Desktop' })).toBeVisible()
    const original = value(await page.evaluate(() => window.electronAPI.notes.get(20)))
    expect(original).toMatchObject({ id: 20, vulnerabilityId: 1, body: 'Legacy note', revision: 1, createdAt: '2026-11-06 12:00:00' })
    const originalSla = value(await page.evaluate(() => window.electronAPI.sla.get(1))).record!
    expect(originalSla).toMatchObject({ id: 30, revision: 1, dueAt: '2026-12-01', state: 'unknown', isOverdue: null })
    const note = value(await page.evaluate(() => window.electronAPI.notes.create({ vulnerabilityId: 1, body: 'Кириллица\n<script>plain text</script>' })))
    const edited = value(await page.evaluate(input => window.electronAPI.notes.update(input), { id: note.id, expectedRevision: 1, body: 'Edited note' }))
    expect(edited).toMatchObject({ id: note.id, revision: 2, body: 'Edited note' })
    expect(value(await page.evaluate(() => window.electronAPI.notes.list({ vulnerabilityId: 1, direction: 'asc', offset: 1, limit: 1 })))).toMatchObject({ total: 2, items: [edited] })
    expect(await page.evaluate(input => window.electronAPI.notes.update(input), { id: note.id, expectedRevision: 1, body: 'Stale' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(await page.evaluate(input => window.electronAPI.notes.remove(input), { id: note.id, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(await page.evaluate(() => window.electronAPI.notes.create({ vulnerabilityId: 1, body: '  ' }))).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(await page.evaluate(() => window.electronAPI.notes.list({ vulnerabilityId: 999 }))).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await page.evaluate(input => window.electronAPI.sla.set(input), { vulnerabilityId: 1, dueAt: '2000-01-01T00:00:00.000Z', patchedAt: null, expected: null })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    const overdue = value(await page.evaluate(input => window.electronAPI.sla.set(input), {
      vulnerabilityId: 1, dueAt: '2000-01-01T00:00:00.000Z', patchedAt: null, expected: token(originalSla)
    })).record!
    expect(overdue).toMatchObject({ id: 30, revision: 2, state: 'overdue', isOverdue: true, missedDeadline: true })
    const completed = value(await page.evaluate(input => window.electronAPI.sla.set(input), {
      vulnerabilityId: 1, dueAt: overdue.dueAt, patchedAt: '2000-01-02T00:00:00.000Z', expected: token(overdue)
    })).record!
    expect(completed).toMatchObject({ id: 30, revision: 3, state: 'completed', isOverdue: false, missedDeadline: true })
    expect(value(await page.evaluate(() => window.electronAPI.vulnerabilities.get(1))).status).toBe('Affected')
    expect(await page.evaluate(input => window.electronAPI.sla.remove(input), { vulnerabilityId: 1, expected: token(overdue) })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(await page.evaluate(input => window.electronAPI.sla.set(input), { vulnerabilityId: 1, dueAt: completed.dueAt, patchedAt: '2099-01-01T00:00:00.000Z', expected: token(completed) })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(await page.evaluate(input => window.electronAPI.sla.set(input), { vulnerabilityId: 1, dueAt: '2026-12-01', patchedAt: null, expected: token(completed) })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })

    await app.evaluate(({ dialog, Menu }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
      Menu.getApplicationMenu()!.getMenuItemById('osv-file')!.click(undefined as any, undefined as any, undefined as any)
    }, resolve('examples/osv-demo.json'))
    await expect.poll(() => app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('osv-file')!.enabled)).toBe(true)
    expect(value(await page.evaluate(id => window.electronAPI.notes.get(id), note.id))).toEqual(edited)
    expect(value(await page.evaluate(() => window.electronAPI.sla.get(1))).record).toEqual(completed)
    expect(value(await page.evaluate(() => window.electronAPI.vulnerabilities.get(1))).status).toBe('Affected')

    const forbidden = await app.evaluate(async ({ BrowserWindow }, paths) => {
      const other = new BrowserWindow({ show: false, webPreferences: { preload: paths.preload, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      try {
        await other.loadFile(paths.renderer)
        return await other.webContents.executeJavaScript(`Promise.all([
          window.electronAPI.notes.list({}),window.electronAPI.notes.get(20),window.electronAPI.notes.create({}),
          window.electronAPI.notes.update({}),window.electronAPI.notes.remove({}),
          window.electronAPI.sla.get(1),window.electronAPI.sla.set({}),window.electronAPI.sla.remove({})])`)
      } finally { other.destroy() }
    }, { preload: resolve('out/preload/index.js'), renderer: resolve('out/renderer/index.html') })
    expect(forbidden).toHaveLength(8)
    expect(forbidden.every((result: ApiResult<unknown>) => !result.ok && result.error.code === 'FORBIDDEN')).toBe(true)
    await app.close(); app = undefined
    app = await electron.launch({ args: [launcher], cwd: resolve('.') })
    page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'VulnPulse Desktop' })).toBeVisible()
    expect(value(await page.evaluate(id => window.electronAPI.notes.get(id), note.id))).toEqual(edited)
    expect(value(await page.evaluate(() => window.electronAPI.sla.get(1))).record).toEqual(completed)
    expect(value(await page.evaluate(input => window.electronAPI.notes.remove(input), { id: note.id, expectedRevision: edited.revision }))).toEqual({ id: note.id })
    expect(value(await page.evaluate(() => window.electronAPI.notes.get(20)))).toEqual(original)
    expect(value(await page.evaluate(input => window.electronAPI.sla.remove(input), { vulnerabilityId: 1, expected: token(completed) })).record).toBeNull()
    const recreated = value(await page.evaluate(() => window.electronAPI.sla.set({ vulnerabilityId: 1, dueAt: '2099-01-01T00:00:00.000Z', patchedAt: null, expected: null }))).record!
    expect(recreated.id).not.toBe(30)
    expect(recreated).toMatchObject({ revision: 1, state: 'open' })
    expect(await page.evaluate(input => window.electronAPI.sla.remove(input), { vulnerabilityId: 1, expected: token(originalSla) })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    const check = new DatabaseSync(path, { readOnly: true })
    try {
      expect(check.prepare('SELECT name FROM schema_migrations').all()).toHaveLength(5)
      expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { check.close() }
  } finally { await app?.close(); rmSync(directory, { recursive: true, force: true }) }
})
