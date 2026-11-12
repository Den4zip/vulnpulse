import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { initDb, type Db } from '@main/db'
import { feeds } from '@main/db/schema'
import { FeedScheduler, type FeedJob, type SyncResult } from '@main/services/scheduler'
import { getTasks } from 'node-cron'
import axios, { type AxiosAdapter } from 'axios'
import { HttpClient } from '@main/services/httpclient'
import { CisaAdapter, CISA_KEV_URL } from '@main/services/feeds/cisa'

let db: Db
let schedulers: FeedScheduler[]
const hour = 3_600_000
const makeJob = (overrides: Partial<FeedJob> = {}): FeedJob => ({ name: 'cisa', source: CISA_KEV_URL,
  intervalMs: hour, sync: vi.fn().mockResolvedValue({ processed: 1 }), ...overrides })
const create = (jobs: FeedJob[] = [makeJob()], busy?: () => boolean) => {
  const scheduler = new FeedScheduler(db, jobs, busy)
  schedulers.push(scheduler)
  return scheduler
}
const row = () => db.select().from(feeds).where(eq(feeds.name, 'cisa')).get()!

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-07T10:00:00Z'))
  db = initDb(':memory:')
  schedulers = []
})
afterEach(async () => {
  await Promise.all(schedulers.map((scheduler) => scheduler.dispose()))
  db.$client.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Main feed scheduling', () => {
  it('applies saved intervals and enabled flags atomically and validates configuration before changing it', async () => {
    const job = makeJob()
    const scheduler = create([job])
    scheduler.configure([{ name: 'cisa', enabled: true, intervalMs: 2 * hour }])
    await scheduler.tick()
    vi.setSystemTime(Date.now() + hour)
    await scheduler.tick()
    expect(job.sync).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + hour)
    await scheduler.tick()
    expect(job.sync).toHaveBeenCalledTimes(2)
    expect(() => scheduler.configure([])).toThrow('Incomplete')
    expect(() => scheduler.configure([{ name: 'cisa', enabled: false, intervalMs: 0 }])).toThrow('Invalid')
    expect(() => scheduler.configure([{ name: 'cisa', enabled: true, intervalMs: hour }, { name: 'cisa', enabled: false, intervalMs: hour }])).toThrow('Invalid')
    expect(scheduler.isEnabled('cisa')).toBe(true)
    scheduler.start()
    scheduler.configure([{ name: 'cisa', enabled: false, intervalMs: hour }])
    await vi.advanceTimersByTimeAsync(2 * hour)
    expect(job.sync).toHaveBeenCalledTimes(2)
    await scheduler.dispose()
    scheduler.configure([{ name: 'cisa', enabled: true, intervalMs: hour }])
    expect(scheduler.isEnabled('cisa')).toBe(false)
  })
  it('starts with all sources disabled, without touching storage or network', async () => {
    const job = makeJob()
    const scheduler = create([job])
    scheduler.start(); scheduler.start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(job.sync).not.toHaveBeenCalled()
    expect(db.select().from(feeds).all()).toEqual([])
    expect(scheduler.status()).toEqual([{ name: 'cisa', enabled: false, running: false,
      lastStartedAt: null, lastFinishedAt: null, lastError: null }])
  })

  it('records a manual success and preserves the adapter ETag/checkpoint/source', async () => {
    db.insert(feeds).values({ name: 'cisa', source: 'previous', etag: 'keep', syncState: 'keep-state', lastError: 'failed' }).run()
    const job = makeJob({ sync: vi.fn(async () => {
      expect(row()).toMatchObject({ lastStartedAt: '2026-11-07T10:00:00.000Z', lastFinishedAt: null, lastError: null })
      return { processed: 0, kind: 'not-modified' as const }
    }) })
    const scheduler = create([job])
    expect(await scheduler.run('cisa')).toEqual({ kind: 'completed', result: { processed: 0, kind: 'not-modified' } })
    expect(row()).toMatchObject({ source: 'previous', etag: 'keep', syncState: 'keep-state', lastError: null,
      lastStartedAt: '2026-11-07T10:00:00.000Z', lastFinishedAt: '2026-11-07T10:00:00.000Z' })
  })

  it('catches up once on enabling and runs again only after the interval via real node-cron', async () => {
    const job = makeJob()
    const scheduler = create([job])
    scheduler.start()
    scheduler.setEnabled('cisa', true)
    await vi.advanceTimersByTimeAsync(0)
    expect(job.sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(hour - 1)
    expect(job.sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(job.sync).toHaveBeenCalledTimes(2)
    scheduler.setEnabled('cisa', false)
    await vi.advanceTimersByTimeAsync(2 * hour)
    expect(job.sync).toHaveBeenCalledTimes(2)
  })

  it('waits for a recent persisted completion and collapses missed intervals to one', async () => {
    db.insert(feeds).values({ name: 'cisa', source: 'keep', lastStartedAt: '2026-11-07T09:29:00.000Z',
      lastFinishedAt: '2026-11-07T09:30:00.000Z' }).run()
    const job = makeJob()
    const scheduler = create([job])
    scheduler.setEnabled('cisa', true)
    await scheduler.tick()
    expect(job.sync).not.toHaveBeenCalled()
    vi.setSystemTime(new Date('2026-11-10T10:00:00Z'))
    await scheduler.tick(); await scheduler.tick()
    expect(job.sync).toHaveBeenCalledTimes(1)
  })

  it('serializes manual/cron and all sources without queuing duplicates', async () => {
    let release!: (value: SyncResult) => void
    const first = makeJob({ sync: vi.fn(() => new Promise<SyncResult>((resolve) => { release = resolve })) })
    const second = makeJob({ name: 'nvd' })
    const scheduler = create([first, second])
    scheduler.setEnabled('cisa', true); scheduler.setEnabled('nvd', true)
    const running = scheduler.run('cisa')
    expect(scheduler.activeFeed).toBe('cisa')
    expect(await scheduler.run('cisa')).toEqual({ kind: 'busy' })
    expect(await scheduler.run('nvd')).toEqual({ kind: 'busy' })
    await scheduler.tick()
    expect(second.sync).not.toHaveBeenCalled()
    release({ processed: 5 })
    await running
    await scheduler.tick()
    expect(first.sync).toHaveBeenCalledTimes(1)
    expect(second.sync).toHaveBeenCalledTimes(1)
  })

  it('defers enabled jobs while an import/file selector is busy', async () => {
    let busy = true
    const job = makeJob()
    const scheduler = create([job], () => busy)
    scheduler.setEnabled('cisa', true)
    expect(await scheduler.run('cisa')).toEqual({ kind: 'busy' })
    await scheduler.tick()
    expect(job.sync).not.toHaveBeenCalled()
    busy = false
    await scheduler.tick()
    expect(job.sync).toHaveBeenCalledOnce()
  })

  it('records failure without leaking error data and continues to the next source', async () => {
    const first = makeJob({ sync: vi.fn().mockRejectedValue(new Error('apiKey=secret payload')) })
    const second = makeJob({ name: 'nvd', intervalMs: 2 * hour })
    const scheduler = create([first, second])
    scheduler.setEnabled('cisa', true); scheduler.setEnabled('nvd', true)
    await scheduler.tick()
    expect(row()).toMatchObject({ lastError: 'failed', lastFinishedAt: '2026-11-07T10:00:00.000Z' })
    expect(second.sync).toHaveBeenCalledOnce()
    await scheduler.tick()
    expect(first.sync).toHaveBeenCalledOnce()
    vi.setSystemTime(Date.now() + hour)
    await scheduler.tick()
    expect(first.sync).toHaveBeenCalledTimes(2)
  })

  it('enforces at least five minutes between automatic retries of short jobs', async () => {
    const job = makeJob({ intervalMs: 60_000, sync: vi.fn().mockRejectedValue(null) })
    const scheduler = create([job])
    scheduler.setEnabled('cisa', true)
    await scheduler.tick()
    vi.setSystemTime(Date.now() + 60_000)
    await scheduler.tick()
    expect(job.sync).toHaveBeenCalledOnce()
    vi.setSystemTime(Date.now() + 4 * 60_000)
    await scheduler.tick()
    expect(job.sync).toHaveBeenCalledTimes(2)
  })

  it.each([null, '2026-11-07T08:00:00.000Z'])('detects and retries an interrupted run with old finish %s', async (finished) => {
    db.insert(feeds).values({ name: 'cisa', source: 'keep', lastStartedAt: '2026-11-07T09:59:00.000Z', lastFinishedAt: finished }).run()
    const scheduler = create()
    expect(scheduler.status()[0].lastError).toBe('interrupted')
    scheduler.setEnabled('cisa', true)
    await scheduler.tick()
    expect(scheduler.status()[0]).toMatchObject({ lastError: null, lastFinishedAt: '2026-11-07T10:00:00.000Z' })
  })

  it('retries invalid stored completion time conservatively', async () => {
    db.insert(feeds).values({ name: 'cisa', source: 'keep', lastFinishedAt: 'invalid' }).run()
    const job = makeJob()
    const scheduler = create([job])
    scheduler.setEnabled('cisa', true)
    await scheduler.tick()
    expect(job.sync).toHaveBeenCalledOnce()
  })

  it('cancels on disabling and waits for adapter cleanup before disposing', async () => {
    let cleanup!: () => void
    const job = makeJob({ sync: vi.fn((signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { cleanup = () => reject(new Error('aborted')) }, { once: true })
    })) })
    const scheduler = create([job])
    scheduler.setEnabled('cisa', true)
    const task = scheduler.run('cisa')
    await Promise.resolve()
    scheduler.setEnabled('cisa', false)
    let closed = false
    const closing = scheduler.dispose().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(scheduler.isRunning).toBe(true)
    cleanup()
    expect(await task).toEqual({ kind: 'cancelled' })
    await closing
    expect(row().lastError).toBe('cancelled')
    expect(await scheduler.run('cisa')).toEqual({ kind: 'disposed' })
    scheduler.start(); scheduler.setEnabled('cisa', true)
    expect(scheduler.isEnabled('cisa')).toBe(false)
  })

  it('aborts even a not-yet-started run without invoking the adapter', async () => {
    const job = makeJob()
    const scheduler = create([job])
    const task = scheduler.run('cisa')
    scheduler.cancel()
    expect(await task).toEqual({ kind: 'cancelled' })
    expect(job.sync).not.toHaveBeenCalled()
  })

  it('keeps a completed commit successful when cancellation arrives after it', async () => {
    let scheduler: FeedScheduler
    scheduler = create([makeJob({ sync: vi.fn(async () => { scheduler.cancel(); return { processed: 1 } }) })])
    expect((await scheduler.run('cisa')).kind).toBe('completed')
    expect(row().lastError).toBeNull()
  })

  it('releases locks after storage failure and catches automatic failures without leaking exceptions', async () => {
    const scheduler = create()
    db.$client.exec("CREATE TRIGGER fail_run BEFORE UPDATE ON feeds BEGIN SELECT RAISE(ABORT, 'fail'); END")
    await expect(scheduler.run('cisa')).rejects.toThrow()
    expect(scheduler.isRunning).toBe(false)
    expect(scheduler.lastOperation).toMatchObject({ phase: 'failed', result: null, finishedAt: expect.any(String) })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    scheduler.start(); scheduler.setEnabled('cisa', true)
    await vi.advanceTimersByTimeAsync(0)
    expect(log).toHaveBeenCalledWith('Feed scheduler could not update run state')
    db.$client.exec('DROP TRIGGER fail_run')
    expect((await scheduler.run('cisa')).kind).toBe('completed')
  })

  it('isolates observer failures and allows unsubscribing', async () => {
    const scheduler = create()
    const listener = vi.fn(() => { throw new Error('private') })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unsubscribe = scheduler.subscribe(listener)
    await scheduler.run('cisa')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith('Feed scheduler observer failed')
    unsubscribe()
    await scheduler.run('cisa')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('validates jobs and prevents two schedulers sharing a DB connection', async () => {
    expect(() => create([makeJob(), makeJob()])).toThrow('Invalid')
    expect(() => create([makeJob({ intervalMs: 0 })])).toThrow('Invalid')
    expect(() => create([makeJob({ name: 'osv' as any })])).toThrow('Invalid')
    const scheduler = create()
    expect(() => create()).toThrow('already owns')
    expect(() => scheduler.run('osv' as any)).toThrow('Unknown')
    await scheduler.dispose()
    const next = create()
    expect(next.isEnabled('cisa')).toBe(false)
  })

  it('destroys the actual cron task and leaves persisted completions across scheduler recreation', async () => {
    const before = getTasks().size
    const job = makeJob()
    const scheduler = create([job])
    scheduler.start()
    scheduler.setEnabled('cisa', true)
    await vi.advanceTimersByTimeAsync(0)
    expect(getTasks().size).toBe(before + 1)
    await scheduler.dispose()
    expect(getTasks().size).toBe(before)
    const next = create([job])
    next.setEnabled('cisa', true)
    await next.tick()
    expect(job.sync).toHaveBeenCalledOnce()
  })

  it('uses the real CISA adapter for a successful catalog then a conditional 304', async () => {
    const transport: AxiosAdapter = vi.fn(async (config) => ({ config,
      status: config.headers.has('If-None-Match') ? 304 : 200, statusText: '', headers: { etag: '"v1"' },
      data: { catalogVersion: '1', dateReleased: '2026-11-07T00:00:00Z', count: 0, vulnerabilities: [] } }))
    const cisa = new CisaAdapter(db, new HttpClient({}, axios.create({ adapter: transport })))
    const scheduler = create([makeJob({ sync: (signal) => cisa.sync(signal) })])
    await scheduler.run('cisa')
    expect(row().etag).toBe('"v1"')
    expect(await scheduler.run('cisa')).toEqual({ kind: 'completed', result: { kind: 'not-modified', processed: 0 } })
    expect(row().lastError).toBeNull()
    expect(transport).toHaveBeenCalledTimes(2)
  })
})
