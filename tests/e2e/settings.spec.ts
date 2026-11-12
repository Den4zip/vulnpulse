import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ApiResult, FeedSettingsMap } from '../../src/shared/api'

const KEY = 'fixture-only-nvd-key-do-not-use'
const value = <T>(result: ApiResult<T>): T => { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.code); return result.value }

test('settings persist, Windows safeStorage protects the NVD key, and only Main attaches it to NVD', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vulnpulse-settings-'))
  const profile = join(directory, 'profile')
  const launcher = join(directory, 'launch.cjs')
  const dbPath = join(profile, 'vulnpulse.db')
  writeFileSync(launcher, `
    const {app,dialog}=require('electron');app.setPath('userData',${JSON.stringify(profile)});delete process.env.ELECTRON_RENDERER_URL;
    const state=globalThis.__settingsTest={requests:[],holdNvd:false,unexpectedNetwork:0};
    for(const protocol of ['http','https']) require(protocol).request=()=>{state.unexpectedNetwork++;throw new Error('External network disabled in settings E2E')};
    const axios=require(${JSON.stringify(resolve('node_modules/axios/dist/node/axios.cjs'))});
    const create=axios.create.bind(axios);
    axios.create=options=>create({...options,adapter:async config=>{
      const nvd=config.url.includes('nvd.nist.gov');
      if(!nvd&&!config.url.includes('cisa.gov')) throw new Error('Unexpected route');
      state.requests.push({nvd,authenticated:config.headers.get('apiKey')===${JSON.stringify(KEY)}});
      if(nvd&&state.holdNvd) await new Promise((resolve,reject)=>config.signal.addEventListener('abort',()=>reject(new axios.CanceledError()),{once:true}));
      return {config,status:200,statusText:'',headers:{},data:nvd
        ?{startIndex:config.params.startIndex,totalResults:0,resultsPerPage:0,vulnerabilities:[]}
        :{catalogVersion:'1',dateReleased:'2026-11-07T00:00:00Z',count:0,vulnerabilities:[]}};
    }});
    dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});
    require(${JSON.stringify(resolve('out/main/index.js'))});
  `)
  let app: ElectronApplication | undefined
  const click = (id: string) => app!.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()!.getMenuItemById(id)!
    item.click(item, undefined as any, undefined as any)
  }, id)
  const idle = () => expect.poll(() => app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('osv-file')!.enabled)).toBe(true)
  const requests = () => app!.evaluate(() => (globalThis as any).__settingsTest.requests as Array<{ nvd: boolean; authenticated: boolean }>)
  try {
    app = await electron.launch({ args: [launcher], cwd: resolve('.') })
    let page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'VulnPulse Desktop' })).toBeVisible()
    const initial = value(await page.evaluate(() => window.electronAPI.settings.get()))
    expect(initial.feeds).toEqual({ cisa: { enabled: false, intervalMinutes: 60 }, nvd: { enabled: false, intervalMinutes: 120 }, fstec: { enabled: false, intervalMinutes: 1440 } })
    expect(initial.nvdKey).toMatchObject({ configured: false, storageAvailable: true, status: 'missing', revision: 1 })
    expect(await requests()).toEqual([])
    const feeds: FeedSettingsMap = { cisa: { enabled: false, intervalMinutes: 180 }, nvd: { enabled: false, intervalMinutes: 240 }, fstec: { enabled: false, intervalMinutes: 2880 } }
    const saved = value(await page.evaluate(command => window.electronAPI.settings.update(command), { expectedRevision: initial.revision, feeds }))
    expect(saved).toMatchObject({ revision: 2, feeds, osvMode: 'local-json' })
    expect(await page.evaluate(command => window.electronAPI.settings.update(command), { expectedRevision: initial.revision, feeds })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(await page.evaluate(command => window.electronAPI.settings.update(command), { expectedRevision: 2, feeds: { ...feeds, nvd: { enabled: true, intervalMinutes: 119 } } })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    const keyed = value(await page.evaluate(command => window.electronAPI.settings.setNvdApiKey(command), { expectedRevision: initial.nvdKey.revision, apiKey: KEY }))
    expect(keyed.nvdKey).toMatchObject({ revision: 2, configured: true, status: 'available' })
    expect(JSON.stringify(keyed)).not.toContain(KEY)
    const check = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = check.prepare('SELECT ciphertext FROM app_secrets').get()!
      expect(row.ciphertext).toBeInstanceOf(Uint8Array)
      expect(Buffer.from(row.ciphertext as Uint8Array).includes(Buffer.from(KEY))).toBe(false)
      expect(check.prepare('SELECT value_json FROM settings').get()!.value_json).not.toContain(KEY)
    } finally { check.close() }
    await click('sync-nvd'); await idle()
    expect(await requests()).toEqual([{ nvd: true, authenticated: true }])

    await app.evaluate(() => { (globalThis as any).__settingsTest.holdNvd = true })
    await click('sync-nvd')
    await expect.poll(async () => (await requests()).length).toBe(2)
    expect(await page.evaluate(command => window.electronAPI.settings.removeNvdApiKey(command), { expectedRevision: 2 })).toMatchObject({ ok: false, error: { code: 'BUSY' } })
    expect(await page.evaluate(command => window.electronAPI.settings.update(command), { expectedRevision: 2, feeds })).toMatchObject({ ok: false, error: { code: 'BUSY' } })
    await click('fstec-cancel'); await idle()
    await app.evaluate(() => { (globalThis as any).__settingsTest.holdNvd = false })

    await click('auto-cisa'); await idle()
    const automatic = value(await page.evaluate(() => window.electronAPI.settings.get()))
    expect(automatic.feeds.cisa).toEqual({ enabled: true, intervalMinutes: 180 })
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('auto-cisa')!.label)).toContain('180 мин.')
    expect((await requests()).filter(row => !row.nvd)).toHaveLength(1)

    const denied = await app.evaluate(async ({ BrowserWindow }, paths) => {
      const other = new BrowserWindow({ show: false, webPreferences: { preload: paths.preload, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      try {
        await other.loadFile(paths.renderer)
        return await other.webContents.executeJavaScript(`Promise.all([
          window.electronAPI.settings.get(),window.electronAPI.settings.update({}),
          window.electronAPI.settings.setNvdApiKey({}),window.electronAPI.settings.removeNvdApiKey({})])`)
      } finally { other.destroy() }
    }, { preload: resolve('out/preload/index.js'), renderer: resolve('out/renderer/index.html') })
    expect(denied).toHaveLength(4)
    expect(denied.every((result: ApiResult<unknown>) => !result.ok && result.error.code === 'FORBIDDEN')).toBe(true)

    await app.close(); app = undefined
    app = await electron.launch({ args: [launcher], cwd: resolve('.') })
    page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'VulnPulse Desktop' })).toBeVisible()
    const restored = value(await page.evaluate(() => window.electronAPI.settings.get()))
    expect(restored).toEqual(automatic)
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('auto-cisa')!.checked)).toBe(true)
    expect(await requests()).toEqual([])
    await click('sync-nvd'); await idle()
    const replayed = await requests()
    expect(replayed.length).toBeGreaterThanOrEqual(1)
    expect(replayed.every(row => row.nvd && row.authenticated)).toBe(true)

    // Damaged/foreign ciphertext must fail before HTTP, not downgrade to anonymous.
    const damaged = new DatabaseSync(dbPath)
    try { damaged.prepare('UPDATE app_secrets SET ciphertext=?').run(Buffer.from('damaged fixture')) } finally { damaged.close() }
    expect(value(await page.evaluate(() => window.electronAPI.settings.get())).nvdKey).toMatchObject({ configured: true, status: 'unavailable' })
    await click('sync-nvd'); await idle()
    expect(await requests()).toHaveLength(replayed.length)
    const removed = value(await page.evaluate(() => window.electronAPI.settings.removeNvdApiKey({ expectedRevision: 2 })))
    expect(removed.nvdKey).toMatchObject({ configured: false, status: 'missing', revision: 3 })
    await click('sync-nvd'); await idle()
    expect((await requests()).at(-1)).toEqual({ nvd: true, authenticated: false })
    expect(await app.evaluate(() => (globalThis as any).__settingsTest.unexpectedNetwork)).toBe(0)
  } finally { await app?.close(); rmSync(directory, { recursive: true, force: true }) }
})
