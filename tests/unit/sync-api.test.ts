import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb } from '@main/db'
import { feeds } from '@main/db/schema'
import { ImportService } from '@main/services/imports'
import { SyncService } from '@main/services/sync'
import { FeedScheduler } from '@main/services/scheduler'
import { ServiceError } from '@main/services/errors'

const abortable = (_path: string, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
  signal.throwIfAborted()
  signal.addEventListener('abort', () => reject(new Error('private path and payload')), { once: true })
})

let db: ReturnType<typeof initDb>
let imports: ImportService
let scheduler: FeedScheduler
let service: SyncService
let settingsBusy = false
const picker = vi.fn<() => Promise<string | null>>()
const importer = vi.fn()
const sync = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  settingsBusy = false
  picker.mockResolvedValue('private-file.json')
  importer.mockResolvedValue({ processed: 3, warnings: 2 })
  sync.mockResolvedValue({ processed: 4, kind: 'updated' })
  db = initDb(':memory:')
  scheduler = new FeedScheduler(db, (['cisa', 'nvd', 'fstec'] as const).map(name => ({ name, source: `https://${name}.example`, intervalMs: 3600000, sync })),
    () => imports.isBusy || settingsBusy)
  imports = new ImportService(picker, { osv: importer, fstec: importer, stack: importer }, () => scheduler.isRunning || settingsBusy)
  service = new SyncService(scheduler, imports, () => settingsBusy)
})
afterEach(async () => { service.dispose(); await Promise.all([scheduler.dispose(), imports.dispose()]); db.$client.close() })
const code = (action: () => unknown, expected: string) => {
  try { action(); throw new Error('expected failure') } catch (error) { expect(error).toBeInstanceOf(ServiceError); expect((error as ServiceError).code).toBe(expected) }
}
const idle = () => vi.waitFor(() => expect(service.status().active).toBeNull())

describe('sync/import orchestration', () => {
  it('returns bounded defaults without starting HTTP or a dialog', () => {
    expect(service.status()).toEqual({ feeds: ['cisa', 'nvd', 'fstec'].map(name => ({ name, enabled: false, running: false,
      lastStartedAt: null, lastFinishedAt: null, lastError: null })), active: null, lastSync: null, lastImport: null,
      settingsBusy: false, osvMode: 'local-json', matchingRecomputed: false })
    expect(sync).not.toHaveBeenCalled()
    expect(picker).not.toHaveBeenCalled()
  })

  it.each([null, {}, [], 'cisa', { feed: 'osv' }, { feed: 'cisa', url: 'https://evil.example' }, { feed: 'CISA' }])('rejects invalid start %j', input => {
    code(() => service.start(input), 'INVALID_ARGUMENT')
    expect(sync).not.toHaveBeenCalled()
  })
  it.each([null, {}, [], { kind: 'nvd' }, { kind: 'osv', path: 'private-file.json' }, { kind: 'stack', raw: '{}' }])('rejects import payload %j before selection', input => {
    code(() => service.importFile(input), 'INVALID_ARGUMENT')
    expect(picker).not.toHaveBeenCalled()
  })
  it.each([null, {}, [], { operationId: '' }, { operationId: 3 }, { operationId: 'x'.repeat(10000) }, { operationId: 'a', force: true }])('rejects cancellation %j', input => {
    code(() => service.cancel(input), 'INVALID_ARGUMENT')
  })
  it.each([null, {}, 1])('rejects status payload %j', input => { code(() => service.status(input), 'INVALID_ARGUMENT') })

  it('takes the network lock before returning and exposes completed counts', async () => {
    const started = service.start({ feed: 'cisa' })
    expect(started).toMatchObject({ kind: 'sync', target: 'cisa', phase: 'running', finishedAt: null })
    expect(service.status().active).toEqual(started)
    code(() => service.start({ feed: 'nvd' }), 'BUSY')
    code(() => service.importFile({ kind: 'osv' }), 'BUSY')
    await idle()
    expect(service.status().lastSync).toMatchObject({ id: started.id, phase: 'completed', result: { processed: 4, warnings: 0, unchanged: false } })
    expect(service.status().feeds[0]).toMatchObject({ lastError: null, running: false })
    expect(picker).not.toHaveBeenCalled()
  })

  it('identifies unchanged snapshots and observes native-menu/direct scheduler runs', async () => {
    sync.mockResolvedValueOnce({ processed: 0, kind: 'not-modified', warnings: 1 })
    await scheduler.run('fstec')
    expect(service.status().lastSync).toMatchObject({ target: 'fstec', phase: 'completed', result: { processed: 0, warnings: 1, unchanged: true } })
  })

  it('sanitizes network failures and prevents stale cancellation from cancelling another run', async () => {
    sync.mockRejectedValueOnce(new Error('apiKey=secret SQL private'))
    const first = service.start({ feed: 'nvd' })
    await idle()
    expect(service.status().lastSync).toMatchObject({ id: first.id, phase: 'failed', result: null })
    expect(service.status().feeds[1].lastError).toBe('failed')
    sync.mockImplementationOnce((signal: AbortSignal) => abortable('', signal))
    const second = service.start({ feed: 'nvd' })
    code(() => service.cancel({ operationId: first.id }), 'CONFLICT')
    expect(service.cancel({ operationId: second.id })).toMatchObject({ id: second.id, cancelRequested: true })
    await idle()
    expect(service.status().lastSync?.phase).toBe('cancelled')
    code(() => service.cancel({ operationId: second.id }), 'CONFLICT')
    expect(JSON.stringify(service.status())).not.toMatch(/secret|SQL|private/)
  })

  it('locks while the file picker is open, cancels without importing and waits for selection to close', async () => {
    let choose!: (value: string | null) => void
    picker.mockReturnValueOnce(new Promise(resolve => { choose = resolve }))
    const started = service.importFile({ kind: 'osv' })
    expect(started.phase).toBe('selecting')
    await vi.waitFor(() => expect(picker).toHaveBeenCalledOnce())
    code(() => service.start({ feed: 'cisa' }), 'BUSY')
    code(() => service.importFile({ kind: 'fstec' }), 'BUSY')
    expect(await scheduler.run('cisa')).toEqual({ kind: 'busy' })
    expect(service.cancel({ operationId: started.id })).toMatchObject({ phase: 'selecting', cancelRequested: true })
    expect(service.status().active?.id).toBe(started.id)
    choose('private-file.json')
    await idle()
    expect(service.status().lastImport).toMatchObject({ id: started.id, phase: 'cancelled' })
    expect(importer).not.toHaveBeenCalled()
  })

  it.each(['osv', 'fstec', 'stack'] as const)('imports %s via a Main-only selected path', async kind => {
    if (kind === 'stack') importer.mockResolvedValueOnce({ added: 2, skipped: 1, total: 3 })
    const started = service.importFile({ kind })
    const completed = await imports.wait()
    expect(completed).toMatchObject({ id: started.id, kind: 'import', target: kind, phase: 'completed' })
    expect(importer).toHaveBeenCalledWith('private-file.json', expect.any(AbortSignal))
    expect(completed.result).toEqual(kind === 'stack' ? { added: 2, skipped: 1, total: 3 } : { processed: 3, warnings: 2, unchanged: false })
    expect(completed.finishedAt).not.toBeNull()
    expect(JSON.stringify(service.status())).not.toContain('private-file.json')
    expect(sync).not.toHaveBeenCalled()
  })

  it('treats user selection cancellation separately from import failure, without leaking either error', async () => {
    picker.mockResolvedValueOnce(null)
    service.importFile({ kind: 'osv' })
    expect(await imports.wait()).toMatchObject({ phase: 'cancelled', cancelRequested: false, result: null })
    picker.mockRejectedValueOnce(new Error('OS private path'))
    service.importFile({ kind: 'osv' })
    expect(await imports.wait()).toMatchObject({ phase: 'failed', result: null })
    importer.mockRejectedValueOnce(new Error('payload secrets'))
    service.importFile({ kind: 'osv' })
    expect(await imports.wait()).toMatchObject({ phase: 'failed', result: null })
    expect(JSON.stringify(service.status())).not.toMatch(/private|secrets|payload/)
  })

  it('supports cancellation during the importer and preserves completed commits', async () => {
    importer.mockImplementationOnce(abortable)
    const operation = service.importFile({ kind: 'fstec' })
    await vi.waitFor(() => expect(importer).toHaveBeenCalledOnce())
    expect(service.status().active?.phase).toBe('running')
    service.cancel({ operationId: operation.id })
    await idle()
    expect(service.status().lastImport?.phase).toBe('cancelled')
    importer.mockImplementationOnce(() => { imports.cancel(); return Promise.resolve({ processed: 1 }) })
    service.importFile({ kind: 'osv' })
    expect(await imports.wait()).toMatchObject({ phase: 'completed', cancelRequested: true, result: { processed: 1 } })
  })

  it('blocks import and network commands while encrypted settings are being written', () => {
    settingsBusy = true
    expect(service.status().settingsBusy).toBe(true)
    code(() => service.start({ feed: 'cisa' }), 'BUSY')
    code(() => service.importFile({ kind: 'osv' }), 'BUSY')
    code(() => imports.start('osv'), 'BUSY')
  })

  it('returns detached snapshots and handles observers safely', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unsubscribe = imports.subscribe(() => { throw new Error('private observer') })
    try {
      const operation = imports.start('osv')
      operation.phase = 'failed'
      expect(imports.lastOperation?.phase).toBe('selecting')
      await imports.wait()
      const read = imports.lastOperation!
      read.result = null
      expect(imports.lastOperation?.result).not.toBeNull()
      expect(error).toHaveBeenCalledWith('Import observer failed')
    } finally { unsubscribe(); error.mockRestore() }
    code(() => imports.wait(), 'CONFLICT')
  })

  it('bounds persisted legacy timestamps/errors and reports interrupted runs', () => {
    db.insert(feeds).values([{ name: 'cisa', source: 'local', lastStartedAt: '2026-11-07T00:00:00.000Z', lastFinishedAt: null },
      { name: 'nvd', source: 'local', lastFinishedAt: 'x'.repeat(10000), lastError: 'private SQL error' },
      { name: 'fstec', source: 'local', lastFinishedAt: 'invalid' }]).run()
    expect(service.status().feeds).toMatchObject([{ lastError: 'interrupted' }, { lastError: 'failed', lastFinishedAt: null }, { lastFinishedAt: null }])
    expect(JSON.stringify(service.status()).length).toBeLessThan(1200)
  })

  it('shuts down, aborts active work and refuses subsequent commands', async () => {
    importer.mockImplementationOnce(abortable)
    service.importFile({ kind: 'fstec' })
    await vi.waitFor(() => expect(importer).toHaveBeenCalledOnce())
    await imports.dispose()
    expect(imports.isBusy).toBe(false)
    expect(imports.lastOperation?.phase).toBe('cancelled')
    code(() => imports.start('osv'), 'UNAVAILABLE')
    service.dispose()
    code(() => service.status(), 'UNAVAILABLE')
    code(() => service.start({ feed: 'cisa' }), 'UNAVAILABLE')
    code(() => service.importFile({ kind: 'osv' }), 'UNAVAILABLE')
    code(() => service.cancel({ operationId: '00000000-0000-0000-0000-000000000000' }), 'UNAVAILABLE')
  })
})
