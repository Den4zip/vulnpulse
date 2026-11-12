import axios, { type AxiosAdapter } from 'axios'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { initDb } from '@main/db'
import { feeds, notes, sourceRecords, vulnerabilities, vulnerabilitySources } from '@main/db/schema'
import { HttpClient } from '@main/services/httpclient'
import { CisaAdapter } from '@main/services/feeds/cisa'

const entry = (id: string) => ({ cveID: id, vendorProject: 'Example', product: 'Test',
  vulnerabilityName: 'Example vulnerability', dateAdded: '2024-01-01', shortDescription: 'Description',
  requiredAction: 'Update', dueDate: '2024-02-01' })
const catalog = (records: unknown[]) => ({ catalogVersion: '1', dateReleased: '2024-01-01T00:00:00Z',
  count: records.length, vulnerabilities: records })

describe('CISA adapter', () => {
  it('imports, preserves existing NVD data, and conditionally reuses ETag', async () => {
    const db = initDb(':memory:')
    const [nvd] = db.insert(feeds).values({ name: 'nvd', source: 'https://example.org' }).returning().all()
    const [vuln] = db.insert(vulnerabilities).values({ extId: 'CVE-2024-0001', feedId: nvd.id,
      title: 'NVD title', severity: 'High', status: 'Affected' }).returning().all()
    db.insert(notes).values({ vulnerabilityId: vuln.id, body: 'keep' }).run()
    const seen: unknown[] = []
    const adapter: AxiosAdapter = async (config) => {
      seen.push(config.headers.get('If-None-Match'))
      return { config, status: seen.length === 1 ? 200 : 304, statusText: '',
        headers: { etag: '"v1"' }, data: seen.length === 1 ? catalog([entry('CVE-2024-0001')]) : '' }
    }
    const cisa = new CisaAdapter(db, new HttpClient({}, axios.create({ adapter })))
    expect(await cisa.sync()).toEqual({ kind: 'updated', processed: 1 })
    expect(await cisa.sync()).toEqual({ kind: 'not-modified', processed: 0 })
    expect(seen).toEqual([undefined, '"v1"'])
    expect(db.select().from(vulnerabilities).where(eq(vulnerabilities.id, vuln.id)).get())
      .toMatchObject({ title: 'NVD title', severity: 'High', status: 'Affected', isKnownExploited: true })
    expect(db.select().from(notes).all()).toHaveLength(1)
    expect(db.select().from(sourceRecords).all()).toHaveLength(1)
    expect(db.select().from(vulnerabilitySources).all()).toHaveLength(1)
    db.$client.close()
  })

  it('rejects malformed catalogs without advancing ETag', async () => {
    const db = initDb(':memory:')
    const adapter: AxiosAdapter = async (config) => ({ config, status: 200, statusText: '',
      headers: { etag: '"bad"' }, data: { ...catalog([entry('CVE-2024-0001')]), count: 2 } })
    const cisa = new CisaAdapter(db, new HttpClient({}, axios.create({ adapter })))
    await expect(cisa.sync()).rejects.toThrow('Invalid CISA catalog')
    expect(db.select().from(feeds).all()).toHaveLength(0)
    expect(db.select().from(vulnerabilities).all()).toHaveLength(0)
    db.$client.close()
  })

  it('rolls back all records and the ETag on a database error', async () => {
    const db = initDb(':memory:')
    db.$client.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON source_records
      WHEN NEW.source_id = 'CVE-2024-0002' BEGIN SELECT RAISE(ABORT, 'test failure'); END`)
    const adapter: AxiosAdapter = async (config) => ({ config, status: 200, statusText: '',
      headers: { etag: '"v2"' }, data: catalog([entry('CVE-2024-0001'), entry('CVE-2024-0002')]) })
    await expect(new CisaAdapter(db, new HttpClient({}, axios.create({ adapter }))).sync()).rejects.toThrow()
    expect(db.select().from(vulnerabilities).all()).toHaveLength(0)
    expect(db.select().from(feeds).all()).toHaveLength(0)
    expect(db.select().from(sourceRecords).all()).toHaveLength(0)
    db.$client.close()
  })

  it('rejects duplicates and cancellation', async () => {
    const db = initDb(':memory:')
    const cisa = new CisaAdapter(db)
    await expect(cisa.parse(catalog([entry('CVE-2024-0001'), entry('CVE-2024-0001')]))).rejects.toThrow()
    await expect(cisa.parse(catalog([{ ...entry('CVE-2024-0001'), dueDate: '2024-02-30' }]))).rejects.toThrow()
    const controller = new AbortController()
    controller.abort()
    await expect(cisa.sync(controller.signal)).rejects.toThrow('cancelled')
    db.$client.close()
  })

  it('reimports a changed snapshot without duplicating records', async () => {
    const db = initDb(':memory:')
    let count = 0
    const adapter: AxiosAdapter = async (config) => ({ config, status: 200, statusText: '',
      headers: { etag: `v${++count}` }, data: catalog([{ ...entry('CVE-2024-0001'), notes: `run ${count}` }]) })
    const cisa = new CisaAdapter(db, new HttpClient({}, axios.create({ adapter })))
    await cisa.sync()
    await cisa.sync()
    expect(db.select().from(vulnerabilities).all()).toHaveLength(1)
    expect(db.select().from(vulnerabilitySources).all()).toHaveLength(1)
    expect(db.select().from(sourceRecords).get()?.rawJson).toContain('run 2')
    expect(db.select().from(feeds).where(eq(feeds.name, 'cisa')).get()?.etag).toBe('v2')
    db.$client.close()
  })
})
