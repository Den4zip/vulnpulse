import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { initDb, type Db } from '@main/db'
import { feeds, notes, sourceRecords, vulnerabilities, vulnerabilitySources } from '@main/db/schema'
import { NvdAdapter } from '@main/services/feeds/nvd'
import { loadNvdMatchPage } from '@main/services/feeds/nvd-catalog'
import { matchStack, type StackItemForMatch } from '@main/services/matcher/engine'

const criteria = 'cpe:2.3:a:apache:http_server:*:*:*:*:*:*:*:*'
const record = (id = 'CVE-2024-0001', end = '2.4.58', lastModified = '2024-01-02T00:00:00Z') => ({
  id, published: '2024-01-01T00:00:00Z', lastModified,
  descriptions: [{ lang: 'en', value: 'description' }], references: [],
  configurations: [{ nodes: [{ operator: 'OR', cpeMatch: [{ vulnerable: true, criteria,
    matchCriteriaId: '12345678-1234-1234-1234-123456789abc', versionEndExcluding: end }] }] }]
})
const page = (records: unknown[]) => ({ startIndex: 0, resultsPerPage: records.length,
  totalResults: records.length, vulnerabilities: records.map((cve) => ({ cve })) })
const databases: Db[] = []
const database = () => { const db = initDb(':memory:'); databases.push(db); return db }
const inventory: StackItemForMatch = { id: 7, name: 'HTTPD', product: 'http_server', vendor: 'apache', kind: 'application',
  version: '2.4.57', cpe23: 'cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:*', purl: null }
const importRecords = async (db: Db, records: unknown[]) => {
  const nvd = new NvdAdapter(db)
  await nvd.upsert(await nvd.parse(page(records)))
}
afterEach(() => { for (const db of databases.splice(0)) db.$client.close() })

describe('NVD persisted source to matcher integration', () => {
  it('loads CPE ranges for a CVE first created by CISA without altering workflow', async () => {
    const db = database()
    const cisa = db.insert(feeds).values({ name: 'cisa', source: 'test' }).returning().get()!
    const existing = db.insert(vulnerabilities).values({ feedId: cisa.id, extId: 'CVE-2024-0001', status: 'Patched', isKnownExploited: true }).returning().get()!
    db.insert(notes).values({ vulnerabilityId: existing.id, body: 'keep' }).run()
    db.insert(vulnerabilities).values({ feedId: cisa.id, extId: 'CVE-2024-9999' }).run()
    await importRecords(db, [record()])
    const loaded = loadNvdMatchPage(db)
    expect(loaded.nextAfterId).toBeNull()
    expect(loaded.vulnerabilities).toHaveLength(1)
    expect(loaded.vulnerabilities[0]).not.toHaveProperty('rawJson')
    expect(loaded.vulnerabilities[0].cpes).toEqual([])
    const result = matchStack([inventory], loaded.vulnerabilities)
    expect(result.matches).toHaveLength(1)
    expect(result.assessments[0]).toMatchObject({ status: 'match', vulnerabilityId: existing.id, evaluatedVersion: '2.4.57' })
    expect(db.select().from(vulnerabilities).where(eq(vulnerabilities.id, existing.id)).get()).toMatchObject({
      feedId: cisa.id, status: 'Patched', isKnownExploited: true
    })
    expect(db.select().from(notes).get()?.body).toBe('keep')
  })

  it('re-evaluates the current raw revision without a schema migration or a flat-CPE cache', async () => {
    const db = database()
    await importRecords(db, [record()])
    expect(matchStack([inventory], loadNvdMatchPage(db).vulnerabilities).assessments[0].status).toBe('match')
    await importRecords(db, [record(undefined, '2.4.57', '2024-01-03T00:00:00Z')])
    const result = matchStack([inventory], loadNvdMatchPage(db).vulnerabilities)
    expect(result.matches).toHaveLength(0)
    expect(result.assessments[0].status).toBe('no_match')
  })

  it('pages by internal ID without losing or repeating entries', async () => {
    const db = database()
    await importRecords(db, [record(), record('CVE-2024-0002'), record('CVE-2024-0003')])
    const first = loadNvdMatchPage(db, { limit: 1 })
    const second = loadNvdMatchPage(db, { afterId: first.nextAfterId!, limit: 1 })
    const third = loadNvdMatchPage(db, { afterId: second.nextAfterId!, limit: 1 })
    expect([first, second, third].flatMap((p) => p.vulnerabilities.map((v) => v.extId))).toEqual([
      'CVE-2024-0001', 'CVE-2024-0002', 'CVE-2024-0003'
    ])
    expect(third.nextAfterId).toBeNull()
    expect(loadNvdMatchPage(db, { afterId: 999 }).vulnerabilities).toEqual([])
  })

  it.each(['{broken', 'null', '{"id":"CVE-2024-9999"}', null])('retains invalid legacy raw %j as an unknown assessment', async (rawJson) => {
    const db = database()
    await importRecords(db, [record()])
    db.update(sourceRecords).set({ rawJson }).run()
    const result = matchStack([inventory], loadNvdMatchPage(db).vulnerabilities)
    expect(result.matches).toHaveLength(0)
    expect(result.assessments[0]).toMatchObject({ status: 'unknown', reason: 'invalid_source' })
  })

  it('does not invent applicability for a legacy record without configurations', async () => {
    const db = database()
    const raw = record()
    const { configurations: _configurations, ...without } = raw
    await importRecords(db, [without])
    const result = matchStack([inventory], loadNvdMatchPage(db).vulnerabilities)
    expect(result.assessments[0]).toMatchObject({ status: 'unknown', reason: 'missing_configuration' })
  })

  it('does not reuse an advisory linked to a different CVE as an exact NVD identity', async () => {
    const db = database()
    await importRecords(db, [record()])
    const source = db.select().from(sourceRecords).get()!
    const other = db.insert(vulnerabilities).values({ feedId: source.feedId, extId: 'CVE-2024-9999' }).returning().get()!
    db.insert(vulnerabilitySources).values({ vulnerabilityId: other.id, sourceRecordId: source.id }).run()
    expect(loadNvdMatchPage(db).vulnerabilities.map((v) => v.extId)).toEqual(['CVE-2024-0001'])
  })

  it.each([{ limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { afterId: -1 }, { afterId: Infinity }])(
    'rejects invalid catalog pagination %j', (options) => expect(() => loadNvdMatchPage(database(), options)).toThrow('catalog page')
  )
})
