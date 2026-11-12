import axios, { type AxiosAdapter } from 'axios'
import { describe, expect, it } from 'vitest'
import { initDb } from '@main/db'
import { feeds, notes, vulnerabilities, sourceRecords, vulnerabilitySources } from '@main/db/schema'
import { NvdAdapter } from '@main/services/feeds/nvd'
import { HttpClient } from '@main/services/httpclient'

const cve = (id: string) => ({ id, published: '2024-01-01T00:00:00Z', lastModified: '2024-01-02T00:00:00Z',
  descriptions: [{ lang: 'en', value: 'NVD description' }], references: [],
  configurations: [{ nodes: [{ operator: 'AND', cpeMatch: [{ vulnerable: true, criteria: 'cpe:2.3:a:vendor:product:*:*:*:*:*:*:*:*', versionEndExcluding: '2.0' }] }] }] })
const response = (index: number, total: number, records: unknown[]) => ({ startIndex: index, totalResults: total,
  resultsPerPage: records.length, vulnerabilities: records.map((value) => ({ cve: value })) })

describe('NVD adapter', () => {
  it('fetches pages and imports independent NVD records without overwriting CISA workflow', async () => {
    const db = initDb(':memory:')
    const [feed] = db.insert(feeds).values({ name: 'cisa', source: 'test' }).returning().all()
    const [existing] = db.insert(vulnerabilities).values({ extId: 'CVE-2024-0001', feedId: feed.id,
      title: 'CISA title', status: 'Affected', isKnownExploited: true }).returning().all()
    db.insert(notes).values({ vulnerabilityId: existing.id, body: 'keep' }).run()
    const requests: Array<number> = []
    const adapter: AxiosAdapter = async (config) => {
      const offset = config.params.startIndex as number
      requests.push(offset)
      return { config, status: 200, statusText: '', headers: {}, data: response(offset, 2,
        [cve(offset === 0 ? 'CVE-2024-0001' : 'CVE-2024-0002')]) }
    }
    const nvd = new NvdAdapter(db, undefined, new HttpClient({}, axios.create({ adapter })))
    const first = await nvd.fetchIncremental({ cursor: null })
    if (first.kind !== 'data') throw new Error('expected data')
    await nvd.upsert(await nvd.parse(first.raw))
    const second = await nvd.fetchIncremental({ cursor: first.nextCursor })
    if (second.kind !== 'data') throw new Error('expected data')
    await nvd.upsert(await nvd.parse(second.raw))
    await nvd.upsert(await nvd.parse(second.raw))
    expect(second.nextCursor).toBeNull()
    expect(requests).toEqual([0, 1])
    expect(db.select().from(vulnerabilities).all()).toHaveLength(2)
    expect(db.select().from(vulnerabilities).all()[0]).toMatchObject({ title: 'CISA title', status: 'Affected', isKnownExploited: true })
    expect(db.select().from(notes).all()).toHaveLength(1)
    expect(db.select().from(sourceRecords).all()).toHaveLength(2)
    expect(db.select().from(sourceRecords).all()[0].rawJson).toContain('versionEndExcluding')
    expect(db.select().from(vulnerabilitySources).all()).toHaveLength(2)
    db.$client.close()
  })

  it('rejects bad pagination and malformed or duplicate CVEs', async () => {
    const db = initDb(':memory:')
    const nvd = new NvdAdapter(db)
    await expect(nvd.parse(response(0, 2, []))).rejects.toThrow('metadata')
    await expect(nvd.parse(response(0, 2, [cve('CVE-2024-0001'), cve('CVE-2024-0001')]))).rejects.toThrow('Invalid NVD CVE')
    db.$client.close()
  })

  it('rolls back the entire page when a record fails', async () => {
    const db = initDb(':memory:')
    db.$client.exec(`CREATE TRIGGER fail_nvd BEFORE INSERT ON source_records
      WHEN NEW.source_id = 'CVE-2024-0002' BEGIN SELECT RAISE(ABORT, 'test failure'); END`)
    const nvd = new NvdAdapter(db)
    const records = await nvd.parse(response(0, 2, [cve('CVE-2024-0001'), cve('CVE-2024-0002')]))
    await expect(nvd.upsert(records)).rejects.toThrow()
    expect(db.select().from(vulnerabilities).all()).toHaveLength(0)
    expect(db.select().from(sourceRecords).all()).toHaveLength(0)
    db.$client.close()
  })
})
