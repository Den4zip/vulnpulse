import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'

test('built Electron coordinates feed sync, checkpoints, cancellation, shutdown and a single instance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vulnpulse-scheduler-'))
  const profile = join(directory, 'profile')
  const launcher = join(directory, 'launch.cjs')
  // Only transport and OS result dialogs are substituted. Main, adapters, DB and cron are production code.
  writeFileSync(launcher, `
    const {app,dialog}=require('electron');
    app.setPath('userData',${JSON.stringify(profile)});
    const axios=require(${JSON.stringify(resolve('node_modules/axios/dist/node/axios.cjs'))});
    const state=globalThis.__schedulerTest={requests:[],failNvd:true,holdCisa:false,messages:[],unexpectedNetwork:0};
    for(const protocol of ['http','https']) require(protocol).request=()=>{
      state.unexpectedNetwork++;throw new Error('External network disabled in scheduler E2E');
    };
    dialog.showMessageBox=async options=>{state.messages.push(options);return {response:0,checkboxChecked:false}};
    const testAdapter=async config=>{
      const url=config.url;
      state.requests.push({url,params:config.params,etag:config.headers.get('If-None-Match')});
      let status=200,data,headers={};
      if(url.includes('cisa.gov')){
        if(state.holdCisa) await new Promise((resolve,reject)=>{
          config.signal.addEventListener('abort',()=>reject(new axios.CanceledError()),{once:true});
        });
        headers={etag:'"test-cisa"'};
        if(config.headers.has('If-None-Match')){status=304;data=''}
        else data={catalogVersion:'1',dateReleased:'2026-11-07T00:00:00Z',count:1,vulnerabilities:[{
          cveID:'CVE-2024-0001',vendorProject:'Demo',product:'Demo',vulnerabilityName:'Demo',
          dateAdded:'2024-01-01',shortDescription:'Demo',requiredAction:'Update',dueDate:'2024-02-01'
        }]};
      }else if(url.includes('nvd.nist.gov')){
        const index=config.params.startIndex;
        if(index===1&&state.failNvd){status=400;data='fixture failure'}
        else{
          const incremental=!!config.params.lastModStartDate;
          data={startIndex:index,totalResults:incremental?0:2,resultsPerPage:incremental?0:1,
            vulnerabilities:incremental?[]:[{cve:{id:index===0?'CVE-2024-0001':'CVE-2024-0002',
              published:'2024-01-01T00:00:00.000',lastModified:'2024-01-02T00:00:00.000',
              descriptions:[{lang:'en',value:'Demo technical description'}],references:[]}}]};
        }
      }else throw new Error('Unexpected test network route');
      return {config,status,statusText:'',headers,data};
    };
    const createAxios=axios.create.bind(axios);
    axios.create=options=>createAxios({...options,adapter:testAdapter});
    require(${JSON.stringify(resolve('out/main/index.js'))});
  `)
  let app: ElectronApplication | undefined
  const snapshot = () => {
    const db = new DatabaseSync(join(profile, 'vulnpulse.db'), { readOnly: true })
    try {
      return {
        feeds: db.prepare('SELECT name,etag,sync_state,last_started_at,last_finished_at,last_error FROM feeds ORDER BY name').all(),
        cards: db.prepare('SELECT ext_id,is_known_exploited FROM vulnerabilities ORDER BY ext_id').all(),
        sources: db.prepare('SELECT source_id FROM source_records ORDER BY id').all()
      }
    } finally { db.close() }
  }
  const click = (id: string, checked?: boolean) => app!.evaluate(({ Menu }, input) => {
    const item = Menu.getApplicationMenu()!.getMenuItemById(input.id)!
    if (input.checked !== undefined && item.checked === input.checked) return
    item.click(item, undefined as any, undefined as any)
  }, { id, checked })
  const waitIdle = () => expect.poll(() => app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('osv-file')!.enabled)).toBe(true)
  try {
    app = await electron.launch({ args: [launcher], cwd: resolve('.') })
    await expect((await app.firstWindow()).getByRole('heading', { name: 'VulnPulse Desktop' })).toBeVisible()
    expect(await app.evaluate(({ app }) => app.hasSingleInstanceLock())).toBe(true)
    expect(await app.evaluate(() => (globalThis as any).__schedulerTest.requests)).toEqual([])
    expect(snapshot().feeds).toEqual([])

    // A second process for the same profile exits instead of creating another DB owner.
    const executable = await app.evaluate(() => process.execPath)
    const exit = await new Promise<number | null>((resolveExit, reject) => {
      const child = spawn(executable, [launcher], { windowsHide: true, stdio: 'ignore', timeout: 10000 })
      child.once('error', reject)
      child.once('exit', (code) => resolveExit(code))
    })
    expect(exit).toBe(0)
    expect(snapshot().feeds).toEqual([])

    await click('sync-cisa'); await waitIdle()
    expect(snapshot().cards).toHaveLength(1)
    expect(snapshot().cards).toEqual([{ ext_id: 'CVE-2024-0001', is_known_exploited: 1 }])
    expect(snapshot().feeds[0]).toMatchObject({ name: 'cisa', etag: '"test-cisa"', last_error: null })
    await click('sync-cisa'); await waitIdle()
    const cisaRequests = await app.evaluate(() => (globalThis as any).__schedulerTest.requests.filter((item: any) => item.url.includes('cisa.gov')))
    expect(cisaRequests).toHaveLength(2)
    expect(cisaRequests[1].etag).toBe('"test-cisa"')

    await click('sync-nvd'); await waitIdle()
    const partial = snapshot()
    expect(partial.feeds[1].last_error).toBe('failed')
    expect(JSON.parse(String(partial.feeds[1].sync_state)).pending.startIndex).toBe(1)
    expect(partial.sources).toHaveLength(2)
    await app.evaluate(() => { (globalThis as any).__schedulerTest.failNvd = false })
    await click('sync-nvd'); await waitIdle()
    const completed = snapshot()
    expect(completed.cards).toHaveLength(2)
    expect(completed.sources).toHaveLength(3)
    expect(completed.cards[0].is_known_exploited).toBe(1)
    expect(completed.feeds[1].last_error).toBeNull()
    expect(JSON.parse(String(completed.feeds[1].sync_state)).pending).toBeNull()

    await click('auto-cisa', true)
    await waitIdle()
    await click('sync-status')
    expect(await app.evaluate(() => (globalThis as any).__schedulerTest.messages.at(-1).detail)).toContain('CISA: Завершено; авто: вкл.')
    await app.evaluate(() => { (globalThis as any).__schedulerTest.holdCisa = true })
    await click('sync-cisa')
    await expect.poll(() => app!.evaluate(() => (globalThis as any).__schedulerTest.requests.filter((item: any) => item.url.includes('cisa.gov')).length)).toBe(3)
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('osv-file')!.enabled)).toBe(false)
    await click('fstec-cancel'); await waitIdle()
    expect(snapshot().feeds[0].last_error).toBe('cancelled')

    await click('sync-cisa')
    await expect.poll(() => app!.evaluate(() => (globalThis as any).__schedulerTest.requests.filter((item: any) => item.url.includes('cisa.gov')).length)).toBe(4)
    await app.close(); app = undefined
    const stopped = snapshot()
    expect(stopped.feeds[0]).toMatchObject({ last_error: 'cancelled', etag: '"test-cisa"' })
    expect(stopped.feeds[0].last_finished_at).toBeTruthy()
    app = await electron.launch({ args: [launcher], cwd: resolve('.') })
    await app.firstWindow()
    expect(await app.evaluate(() => (globalThis as any).__schedulerTest.requests)).toEqual([])
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('auto-cisa')!.checked)).toBe(true)
    expect(snapshot()).toEqual(stopped)
    expect(await app.evaluate(() => (globalThis as any).__schedulerTest.unexpectedNetwork)).toBe(0)
  } finally {
    await app?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
