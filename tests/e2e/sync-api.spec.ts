import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ApiResult, ImportKind, OperationInfo, SyncView } from '../../src/shared/api'

const value = <T>(result: ApiResult<T>): T => { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.code); return result.value }

test('sync IPC shares menu/cron locks, selects local files in Main, cancels by operation ID and exposes safe status', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vulnpulse-sync-api-'))
  const profile = join(directory, 'profile')
  const launcher = join(directory, 'launch.cjs')
  writeFileSync(launcher, `
    const {app,dialog,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(profile)});delete process.env.ELECTRON_RENDERER_URL;
    const state=globalThis.__syncTest={path:'',holdSelection:false,release:null,holdNvd:false,failNvd:false,requests:[],dialogs:[],messages:[],unexpectedNetwork:0};
    for(const protocol of ['http','https']) require(protocol).request=()=>{state.unexpectedNetwork++;throw new Error('External network disabled')};
    dialog.showOpenDialog=async(window,options)=>{
      state.dialogs.push({parent:window===BrowserWindow.getAllWindows()[0],title:options.title});
      if(state.holdSelection) await new Promise(resolve=>{state.release=resolve});
      return {canceled:false,filePaths:[state.path]};
    };
    dialog.showMessageBox=async options=>{state.messages.push(options);return {response:0,checkboxChecked:false}};
    const axios=require(${JSON.stringify(resolve('node_modules/axios/dist/node/axios.cjs'))});const create=axios.create.bind(axios);
    axios.create=options=>create({...options,adapter:async config=>{
      state.requests.push(config.url);
      let data,headers={},status=200;
      if(config.url.includes('nvd.nist.gov')){
        if(state.holdNvd) await new Promise((resolve,reject)=>config.signal.addEventListener('abort',()=>reject(new axios.CanceledError()),{once:true}));
        if(state.failNvd) throw new Error('apiKey=private-path-secret');
        data={startIndex:config.params.startIndex,totalResults:0,resultsPerPage:0,vulnerabilities:[]};
      }else if(config.url.includes('cisa.gov')){
        headers={etag:'"fixture"'};
        if(config.headers.has('If-None-Match')){status=304;data=''}
        else data={catalogVersion:'1',dateReleased:'2026-11-07T00:00:00Z',count:0,vulnerabilities:[]};
      }else if(config.url.includes('github')){
        data=require('node:zlib').gzipSync(require('node:fs').readFileSync(${JSON.stringify(resolve('examples/fstec-demo.xml'))}));
      }else throw new Error('Unexpected route');
      return {config,status,statusText:'',headers,data};
    }});
    require(${JSON.stringify(resolve('out/main/index.js'))});
  `)
  let app: ElectronApplication | undefined
  const snapshot = () => {
    const db = new DatabaseSync(join(profile, 'vulnpulse.db'), { readOnly: true })
    try { return { cards: db.prepare('SELECT id,ext_id,status FROM vulnerabilities ORDER BY id').all(),
      stack: db.prepare('SELECT id,name,version FROM stack ORDER BY id').all(),
      sources: db.prepare('SELECT id,source_id,raw_json FROM source_records ORDER BY id').all() } }
    finally { db.close() }
  }
  try {
    app = await electron.launch({ args: [launcher], cwd: resolve('.') })
    let page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'VulnPulse Desktop' })).toBeVisible()
    const status = async (): Promise<SyncView> => value(await page.evaluate(() => window.electronAPI.sync.status()))
    const idle = () => expect.poll(async () => (await status()).active).toBeNull()
    const select = (path: string, holdSelection = false) => app!.evaluate((_electron, input) => {
      Object.assign((globalThis as any).__syncTest, input)
    }, { path, holdSelection })
    const startImport = async (kind: ImportKind, path: string): Promise<OperationInfo> => {
      await select(path)
      const operation = value(await page.evaluate(kind => window.electronAPI.sync.importFile({ kind }), kind))
      await idle()
      expect((await status()).lastImport).toMatchObject({ id: operation.id, phase: 'completed' })
      return operation
    }
    const click = (id: string) => app!.evaluate(({ Menu }, id) => {
      const item = Menu.getApplicationMenu()!.getMenuItemById(id)!
      item.click(item, undefined as any, undefined as any)
    }, id)

    expect(await status()).toMatchObject({ active: null, lastImport: null, lastSync: null, osvMode: 'local-json' })
    expect(await page.evaluate(() => (window.electronAPI.sync.importFile as any)({ kind: 'osv', path: 'file-from-renderer' }))).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    await startImport('stack', resolve('examples/local-stack.example.json'))
    await startImport('osv', resolve('examples/osv-demo.json'))
    await startImport('fstec', resolve('examples/fstec-demo.xml'))
    expect(snapshot().stack).toHaveLength(4)
    expect(snapshot().cards).toHaveLength(5)
    expect(snapshot().sources).toHaveLength(5)
    const imported = snapshot()
    await startImport('osv', resolve('examples/osv-demo.json'))
    expect(snapshot()).toEqual(imported)
    expect(await app.evaluate(() => (globalThis as any).__syncTest.requests)).toEqual([])
    expect(await app.evaluate(() => (globalThis as any).__syncTest.messages)).toEqual([])
    expect(await app.evaluate(() => (globalThis as any).__syncTest.dialogs.every((item: any) => item.parent))).toBe(true)

    // The selector itself is locked, and cancellation prevents subsequent file access.
    await select(resolve('examples/osv-demo.json'), true)
    const held = value(await page.evaluate(() => window.electronAPI.sync.importFile({ kind: 'osv' })))
    await expect.poll(() => app!.evaluate(() => !!(globalThis as any).__syncTest.release)).toBe(true)
    expect((await status()).active).toMatchObject({ id: held.id, phase: 'selecting' })
    expect(await page.evaluate(() => window.electronAPI.sync.start({ feed: 'nvd' }))).toMatchObject({ ok: false, error: { code: 'BUSY' } })
    expect(await page.evaluate(() => window.electronAPI.sync.importFile({ kind: 'stack' }))).toMatchObject({ ok: false, error: { code: 'BUSY' } })
    const settings = value(await page.evaluate(() => window.electronAPI.settings.get()))
    expect(await page.evaluate(command => window.electronAPI.settings.update(command), { expectedRevision: settings.revision, feeds: settings.feeds })).toMatchObject({ ok: false, error: { code: 'BUSY' } })
    await click('fstec-file')
    value(await page.evaluate(operationId => window.electronAPI.sync.cancel({ operationId }), held.id))
    expect((await status()).active?.cancelRequested).toBe(true)
    await app.evaluate(() => { const state = (globalThis as any).__syncTest; state.holdSelection = false; state.release(); state.release = null })
    await idle()
    expect((await status()).lastImport?.phase).toBe('cancelled')
    expect(snapshot()).toEqual(imported)

    // Menu imports and API imports use the same operation state.
    await select(resolve('examples/osv-demo.json'))
    await click('osv-file'); await idle()
    expect((await status()).lastImport).toMatchObject({ phase: 'completed', target: 'osv' })
    expect(snapshot()).toEqual(imported)
    await select(resolve('examples/fstec-demo.xml'))
    value(await page.evaluate(() => window.electronAPI.sync.importFile({ kind: 'osv' })))
    await idle()
    expect((await status()).lastImport?.phase).toBe('failed')
    expect(snapshot()).toEqual(imported)

    for (const [index, feed] of (['cisa', 'cisa', 'fstec'] as const).entries()) {
      value(await page.evaluate(feed => window.electronAPI.sync.start({ feed }), feed))
      await idle()
      expect((await status()).lastSync).toMatchObject({ phase: 'completed', target: feed,
        result: { processed: feed === 'fstec' ? 2 : 0, unchanged: index === 1 } })
    }
    await app.evaluate(() => { (globalThis as any).__syncTest.holdNvd = true })
    const nvd = value(await page.evaluate(() => window.electronAPI.sync.start({ feed: 'nvd' })))
    await expect.poll(() => app!.evaluate(() => (globalThis as any).__syncTest.requests.some((url: string) => url.includes('nvd.nist.gov')))).toBe(true)
    expect(await page.evaluate(operationId => window.electronAPI.sync.cancel({ operationId }), held.id)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect((await status()).active?.id).toBe(nvd.id)
    value(await page.evaluate(operationId => window.electronAPI.sync.cancel({ operationId }), nvd.id))
    await idle()
    expect((await status()).lastSync?.phase).toBe('cancelled')

    const denied = await app.evaluate(async ({ BrowserWindow }, paths) => {
      const other = new BrowserWindow({ show: false, webPreferences: { preload: paths.preload, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      try {
        await other.loadFile(paths.renderer)
        return await other.webContents.executeJavaScript(`Promise.all([window.electronAPI.sync.status(),window.electronAPI.sync.start({feed:'cisa'}),window.electronAPI.sync.importFile({kind:'osv'}),window.electronAPI.sync.cancel({operationId:'bad'})])`)
      } finally { other.destroy() }
    }, { preload: resolve('out/preload/index.js'), renderer: resolve('out/renderer/index.html') })
    expect(denied).toHaveLength(4)
    expect(denied.every((result: ApiResult<unknown>) => !result.ok && result.error.code === 'FORBIDDEN')).toBe(true)
    const safe = JSON.stringify(await status())
    expect(safe).not.toContain(directory)
    expect(safe).not.toMatch(/rawJson|raw_json|private-path-secret|ciphertext/)
    expect(await app.evaluate(() => (globalThis as any).__syncTest.unexpectedNetwork)).toBe(0)
    const beforeRestart = snapshot()
    await app.close(); app = undefined
    app = await electron.launch({ args: [launcher], cwd: resolve('.') })
    page = await app.firstWindow()
    expect(await status()).toMatchObject({ active: null, lastSync: null, lastImport: null })
    expect((await status()).feeds.find(feed => feed.name === 'nvd')).toMatchObject({ lastError: 'cancelled' })
    expect(snapshot()).toEqual(beforeRestart)
    expect(await app.evaluate(() => (globalThis as any).__syncTest.requests)).toEqual([])
  } finally {
    await app?.close()
    // The directory is the explicit mkdtemp workspace of this test only.
    rmSync(directory, { recursive: true, force: true })
  }
})
