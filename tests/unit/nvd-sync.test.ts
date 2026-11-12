import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDb, type Db } from '@main/db'
import { migrations } from '@main/db/migrations'
import { applyMigrations } from '@main/db/migrations/runner'
import { feeds, notes, sourceRecords, vulnerabilities, vulnerabilitySources } from '@main/db/schema'
import { NvdAdapter } from '@main/services/feeds/nvd'
import { CisaAdapter } from '@main/services/feeds/cisa'
import { HttpClient } from '@main/services/httpclient'

const NOW = '2026-11-06T12:00:00.000Z'
const cve = (id = 'CVE-2024-0001', lastModified = '2024-01-02T00:00:00.000', description = 'NVD description') => ({
  id, published: '2024-01-01T00:00:00.000', lastModified,
  descriptions: [{ lang: 'en', value: description }], references: []
})
const page = (index: number, total: number, records: unknown[]) => ({ startIndex: index,
  totalResults: total, resultsPerPage: records.length, vulnerabilities: records.map((cve) => ({ cve })) })
const databases: Db[] = []
const dirs: string[] = []
const database = (path = ':memory:') => { const db = initDb(path); databases.push(db); return db }
const client = (respond: (config: InternalAxiosRequestConfig) => unknown | Promise<unknown>) => {
  const adapter: AxiosAdapter = async (config) => ({ config, status: 200, statusText: '', headers: {}, data: await respond(config) })
  return new HttpClient({ maxRetries: 0, rateLimit: { maxRequests: 100, windowMs: 1 } }, axios.create({ adapter }))
}
const state = (db: Db) => JSON.parse(db.select().from(feeds).where(eq(feeds.name, 'nvd')).get()!.syncState!)
const seed = (db: Db, completedThrough: string) => db.insert(feeds).values({ name: 'nvd', source: 'test',
  syncState: JSON.stringify({ version: 1, completedThrough, pending: null }) }).run()
const freeze = () => vi.spyOn(Date, 'now').mockReturnValue(Date.parse(NOW))

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.$client.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('NVD durable synchronization', () => {
  it('loads the full initial catalog and commits the baseline only after its final page', async () => {
    freeze()
    const db = database()
    const requests: unknown[] = []
    const http = client((config) => {
      requests.push(config.params)
      expect(db.$client.isTransaction).toBe(false)
      expect(state(db).completedThrough).toBeNull()
      const index = config.params.startIndex
      expect(state(db).pending.startIndex).toBe(index)
      return page(index, 2, [cve(index === 0 ? 'CVE-2024-0001' : 'CVE-2024-0002')])
    })
    const result = await new NvdAdapter(db, 'test-key', http).sync()
    expect(result).toEqual({ processed: 2, pages: 2, completedThrough: NOW })
    expect(requests).toEqual([{ startIndex: 0 }, { startIndex: 1 }])
    expect(state(db)).toEqual({ version: 1, completedThrough: NOW, pending: null })
    expect(db.select().from(sourceRecords).all()).toHaveLength(2)
    expect(db.select().from(vulnerabilitySources).all()).toHaveLength(2)
  })

  it('splits a long offline interval into <=120-day windows with two-minute overlap', async () => {
    freeze()
    const db = database()
    const completed = '2025-11-06T12:00:00.000Z'
    seed(db, completed)
    const intervals: Array<{ start: number; end: number }> = []
    const http = client(({ params }) => {
      intervals.push({ start: Date.parse(params.lastModStartDate), end: Date.parse(params.lastModEndDate) })
      return page(0, 0, [])
    })
    expect(await new NvdAdapter(db, undefined, http).sync()).toEqual({ processed: 0, pages: 4, completedThrough: NOW })
    expect(intervals[0].start).toBe(Date.parse(completed) - 120_000)
    for (let i = 0; i < intervals.length; i++) {
      expect(intervals[i].end - intervals[i].start).toBeLessThanOrEqual(120 * 86_400_000)
      if (i) expect(intervals[i].start).toBe(intervals[i - 1].end - 120_000)
    }
    expect(intervals.at(-1)?.end).toBe(Date.parse(NOW))
    expect(state(db).pending).toBeNull()
  })

  it('retains the last applied page after failure and replays the unfinished window without duplicates', async () => {
    freeze()
    const db = database()
    seed(db, '2026-11-06T10:00:00.000Z')
    const requests: number[] = []
    let fail = true
    const http = client(({ params }) => {
      requests.push(params.startIndex)
      if (params.startIndex === 1 && fail) throw new Error('network failure')
      return page(params.startIndex, 2, [cve(params.startIndex === 0 ? 'CVE-2024-0001' : 'CVE-2024-0002')])
    })
    await expect(new NvdAdapter(db, undefined, http).sync()).rejects.toThrow()
    expect(state(db)).toMatchObject({ completedThrough: '2026-11-06T10:00:00.000Z', pending: { startIndex: 1, lastModEndDate: NOW } })
    expect(db.select().from(vulnerabilities).all()).toHaveLength(1)
    fail = false
    await new NvdAdapter(db, undefined, http).sync()
    expect(requests).toEqual([0, 1, 0, 1])
    expect(db.select().from(vulnerabilities).all()).toHaveLength(2)
    expect(state(db)).toMatchObject({ completedThrough: NOW, pending: null })
  })

  it('restores an interrupted initial population after closing and reopening the database', async () => {
    freeze()
    const dir = mkdtempSync(join(tmpdir(), 'vulnpulse-nvd-'))
    dirs.push(dir)
    const path = join(dir, 'test.db')
    const db = initDb(path)
    try {
      const http = client(({ params }) => {
        if (params.startIndex === 1) throw new Error('offline')
        return page(0, 2, [cve()])
      })
      await expect(new NvdAdapter(db, undefined, http).sync()).rejects.toThrow()
      expect(state(db)).toMatchObject({ completedThrough: null, pending: { baselineAt: NOW, startIndex: 1 } })
    } finally { db.$client.close() }
    const reopened = database(path)
    const offsets: number[] = []
    const http = client(({ params }) => {
      offsets.push(params.startIndex)
      return page(params.startIndex, 2, [cve(params.startIndex ? 'CVE-2024-0002' : 'CVE-2024-0001')])
    })
    await new NvdAdapter(reopened, undefined, http).sync()
    expect(offsets).toEqual([0, 1])
    expect(state(reopened).completedThrough).toBe(NOW)
    expect(reopened.select().from(vulnerabilities).all()).toHaveLength(2)
  })

  it('rolls back page data when checkpoint persistence fails', async () => {
    freeze()
    const db = database()
    db.$client.exec(`CREATE TRIGGER fail_checkpoint BEFORE UPDATE OF sync_state ON feeds
      WHEN json_extract(NEW.sync_state, '$.pending.startIndex') = 1
      BEGIN SELECT RAISE(ABORT, 'checkpoint failure'); END`)
    const http = client(() => page(0, 2, [cve()]))
    await expect(new NvdAdapter(db, undefined, http).sync()).rejects.toThrow()
    expect(state(db).pending.startIndex).toBe(0)
    expect(db.select().from(vulnerabilities).all()).toHaveLength(0)
    expect(db.select().from(sourceRecords).all()).toHaveLength(0)
  })

  it('preserves the cursor and whole page on malformed data or database failure', async () => {
    freeze()
    const db = database()
    const http = client(() => page(0, 2, [cve(), { ...cve('CVE-2024-0002'), descriptions: [null] }]))
    await expect(new NvdAdapter(db, undefined, http).sync()).rejects.toThrow('Invalid NVD CVE')
    expect(state(db).pending.startIndex).toBe(0)
    expect(db.select().from(vulnerabilities).all()).toHaveLength(0)
    db.$client.exec(`CREATE TRIGGER fail_record BEFORE INSERT ON source_records
      WHEN NEW.source_id = 'CVE-2024-0002' BEGIN SELECT RAISE(ABORT, 'write failure'); END`)
    const valid = client(() => page(0, 2, [cve(), cve('CVE-2024-0002')]))
    await expect(new NvdAdapter(db, undefined, valid).sync()).rejects.toThrow()
    expect(state(db).pending.startIndex).toBe(0)
    expect(db.select().from(vulnerabilities).all()).toHaveLength(0)
  })

  it('does not advance a completed window when pagination totals change', async () => {
    freeze()
    const db = database()
    seed(db, '2026-11-06T10:00:00.000Z')
    const http = client(({ params }) => page(params.startIndex, params.startIndex ? 3 : 2,
      [cve(params.startIndex ? 'CVE-2024-0002' : 'CVE-2024-0001')]))
    await expect(new NvdAdapter(db, undefined, http).sync()).rejects.toThrow('result set changed')
    expect(state(db)).toMatchObject({ completedThrough: '2026-11-06T10:00:00.000Z', pending: { startIndex: 1 } })
    expect(db.select().from(vulnerabilities).all()).toHaveLength(1)
  })

  it('continues initial population when new CVEs increase the catalog size', async () => {
    freeze()
    const db = database()
    const offsets: number[] = []
    const http = client(({ params }) => {
      offsets.push(params.startIndex)
      return page(params.startIndex, params.startIndex ? 3 : 2,
        [cve(`CVE-2024-000${params.startIndex + 1}`)])
    })
    expect(await new NvdAdapter(db, undefined, http).sync()).toMatchObject({ processed: 3, pages: 3, completedThrough: NOW })
    expect(offsets).toEqual([0, 1, 2])
    expect(db.select().from(vulnerabilities).all()).toHaveLength(3)
  })

  it('replays a shrinking initial catalog without marking it fully applied', async () => {
    freeze()
    const db = database()
    const http = client(({ params }) => page(params.startIndex, params.startIndex ? 2 : 3,
      [cve(params.startIndex ? 'CVE-2024-0002' : 'CVE-2024-0001')]))
    await expect(new NvdAdapter(db, undefined, http).sync()).rejects.toThrow('result set changed')
    expect(state(db)).toMatchObject({ completedThrough: null, pending: { startIndex: 1 } })
  })

  it('rejects concurrent sync across adapter instances and releases the lock after failure', async () => {
    freeze()
    const db = database()
    let release!: (value: unknown) => void
    const waiting = new Promise((resolve) => { release = resolve })
    const http = client(() => waiting)
    const running = new NvdAdapter(db, undefined, http).sync()
    await expect(new NvdAdapter(db, undefined, http).sync()).rejects.toThrow('already running')
    release({ invalid: true })
    await expect(running).rejects.toThrow()
    await expect(new NvdAdapter(db, undefined, client(() => page(0, 0, []))).sync()).resolves.toMatchObject({ pages: 1 })
  })

  it('handles cancellation before a sync and during a request without advancing progress', async () => {
    freeze()
    const db = database()
    const controller = new AbortController()
    controller.abort()
    const nvd = new NvdAdapter(db, undefined, client(() => page(0, 0, [])))
    await expect(nvd.sync(controller.signal)).rejects.toThrow('cancelled')
    expect(db.select().from(feeds).all()).toHaveLength(0)
    const during = new AbortController()
    const http = client(() => { during.abort(); return page(0, 1, [cve()]) })
    await expect(new NvdAdapter(db, undefined, http).sync(during.signal)).rejects.toThrow()
    expect(state(db)).toMatchObject({ completedThrough: null, pending: { startIndex: 0 } })
    expect(db.select().from(vulnerabilities).all()).toHaveLength(0)
  })

  it('makes no request if the checkpoint is current or the local clock moves backwards', async () => {
    freeze()
    const db = database()
    seed(db, '2026-11-07T00:00:00.000Z')
    const respond = vi.fn(() => page(0, 0, []))
    expect(await new NvdAdapter(db, undefined, client(respond)).sync()).toEqual({
      processed: 0, pages: 0, completedThrough: '2026-11-07T00:00:00.000Z'
    })
    expect(respond).not.toHaveBeenCalled()
  })

  it.each(['{', '{}', '{"version":2,"completedThrough":null,"pending":null}',
    '{"version":1,"completedThrough":"bad","pending":null}',
    '{"version":1,"completedThrough":null,"pending":{"startIndex":0}}'])('rejects an invalid checkpoint: %s', async (syncState) => {
    const db = database()
    db.insert(feeds).values({ name: 'nvd', source: 'test', syncState }).run()
    const respond = vi.fn(() => page(0, 0, []))
    await expect(new NvdAdapter(db, undefined, client(respond)).sync()).rejects.toThrow('checkpoint')
    expect(respond).not.toHaveBeenCalled()
  })

  it('migrates a populated database without changing records, notes, or ETags', () => {
    const raw = new DatabaseSync(':memory:')
    try {
      raw.exec('PRAGMA foreign_keys = ON')
      applyMigrations(raw, migrations.slice(0, 2))
      raw.exec(`INSERT INTO feeds (id, name, source, etag) VALUES (1, 'nvd', 'test', 'keep-etag');
        INSERT INTO vulnerabilities (id, ext_id, feed_id, status) VALUES (1, 'CVE-2024-0001', 1, 'Patched');
        INSERT INTO source_records (id, feed_id, source_id, raw_json) VALUES (1, 1, 'CVE-2024-0001', '{}');
        INSERT INTO vulnerability_sources VALUES (1, 1);
        INSERT INTO notes (vulnerability_id, body) VALUES (1, 'keep');`)
      applyMigrations(raw, migrations)
      applyMigrations(raw, migrations)
      expect(raw.prepare('SELECT etag, sync_state FROM feeds').get()).toMatchObject({ etag: 'keep-etag', sync_state: null })
      expect(raw.prepare('SELECT status FROM vulnerabilities').get()).toMatchObject({ status: 'Patched' })
      expect(raw.prepare('SELECT body FROM notes').get()).toMatchObject({ body: 'keep' })
      expect(raw.prepare('SELECT count(*) AS n FROM vulnerability_sources').get()).toMatchObject({ n: 1 })
    } finally { raw.close() }
  })
})

describe('NVD source freshness and canonical fields', () => {
  it('ignores older and equal timestamps, but accepts a strictly newer source record', async () => {
    const db = database()
    const nvd = new NvdAdapter(db)
    const newer = cve(undefined, '2024-01-04T00:00:00.000Z', 'fresh')
    await nvd.upsert(await nvd.parse(page(0, 1, [newer])))
    await nvd.upsert(await nvd.parse(page(0, 1, [cve()])))
    await nvd.upsert(await nvd.parse(page(0, 1, [{ ...newer, descriptions: [{ lang: 'en', value: 'stale replica' }] }])))
    expect(db.select().from(vulnerabilities).get()?.description).toBe('fresh')
    expect(db.select().from(sourceRecords).get()?.rawJson).toContain('fresh')
    await nvd.upsert(await nvd.parse(page(0, 1, [cve(undefined, '2024-01-05T00:00:00Z', 'updated')])))
    expect(db.select().from(vulnerabilities).get()?.description).toBe('updated')
  })

  it.each([true, false])('keeps NVD technical data and CISA KEV regardless of import order (CISA first: %s)', async (cisaFirst) => {
    const db = database()
    const kev = { cveID: 'CVE-2024-0001', vulnerabilityName: 'CISA title', shortDescription: 'CISA text',
      vendorProject: 'Vendor', product: 'Product', dateAdded: '2024-01-02', dueDate: '2024-02-02', requiredAction: 'patch' }
    const cisa = new CisaAdapter(db)
    const nvd = new NvdAdapter(db)
    const importCisa = () => cisa.upsert([kev])
    const importNvd = async () => nvd.upsert(await nvd.parse(page(0, 1, [cve()])))
    if (cisaFirst) await importCisa()
    else await importNvd()
    const existing = db.select().from(vulnerabilities).get()!
    db.update(vulnerabilities).set({ status: 'In Progress' }).where(eq(vulnerabilities.id, existing.id)).run()
    db.insert(notes).values({ vulnerabilityId: existing.id, body: 'keep' }).run()
    if (cisaFirst) await importNvd()
    else await importCisa()
    expect(db.select().from(vulnerabilities).get()).toMatchObject({ description: 'NVD description',
      status: 'In Progress', isKnownExploited: true, modifiedAt: '2024-01-02T00:00:00.000' })
    expect(db.select().from(notes).get()?.body).toBe('keep')
    expect(db.select().from(sourceRecords).all()).toHaveLength(2)
  })
})
