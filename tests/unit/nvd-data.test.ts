import axios, { type AxiosAdapter } from 'axios'
import { afterEach, describe, expect, it } from 'vitest'
import { initDb, type Db } from '@main/db'
import { feeds, sourceRecords, vulnerabilities } from '@main/db/schema'
import { NvdAdapter } from '@main/services/feeds/nvd'
import { HttpClient } from '@main/services/httpclient'

const cve = () => ({ id: 'CVE-2024-0001', published: '2024-01-01T00:00:00.000',
  lastModified: '2024-01-02T00:00:00.000', descriptions: [{ lang: 'en', value: 'description' }], references: [] })
const page = (records: unknown[]) => ({ startIndex: 0, totalResults: records.length,
  resultsPerPage: records.length, vulnerabilities: records.map((cve) => ({ cve })) })
const metric = (version = '3.1', baseScore = 9.8, source = 'nvd@nist.gov', type = 'Primary') => ({ source, type,
  cvssData: { version, baseScore, vectorString: version === '2.0' ? 'AV:N/AC:L/Au:N/C:P/I:P/A:P'
    : version === '4.0' ? 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'
      : `CVSS:${version}/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H` } })
const databases: Db[] = []
const database = () => { const db = initDb(':memory:'); databases.push(db); return db }
afterEach(() => { for (const db of databases.splice(0)) db.$client.close() })

describe('NVD consumed field validation and CVSS projection', () => {
  it.each([
    ['cvssMetricV40', '4.0', 9.3, 'Critical'], ['cvssMetricV31', '3.1', 9.8, 'Critical'],
    ['cvssMetricV30', '3.0', 7, 'High'], ['cvssMetricV2', '2.0', 10, 'High'],
    ['cvssMetricV31', '3.1', 6.9, 'Medium'], ['cvssMetricV31', '3.1', 3.9, 'Low'],
    ['cvssMetricV31', '3.1', 0, 'None']
  ])('projects %s score %s/%s as %s without dropping the source', async (key, version, score, severity) => {
    const db = database()
    const nvd = new NvdAdapter(db)
    const record = { ...cve(), metrics: { [key]: [metric(version as string, score as number)] } }
    await nvd.upsert(await nvd.parse(page([record])))
    expect(db.select().from(vulnerabilities).get()).toMatchObject({ cvssScore: score,
      severity, cvssVector: metric(version as string).cvssData.vectorString })
    expect(JSON.parse(db.select().from(sourceRecords).get()!.rawJson!)).toEqual(record)
  })

  it('chooses newest CVSS then Primary deterministically regardless of array order', async () => {
    const primary = metric('3.1', 9.8, 'z@example.org')
    const secondary = metric('3.1', 4.2, 'a@example.org', 'Secondary')
    for (const candidates of [[primary, secondary], [secondary, primary]]) {
      const db = database()
      const nvd = new NvdAdapter(db)
      await nvd.upsert(await nvd.parse(page([{ ...cve(), metrics: {
        cvssMetricV31: candidates, cvssMetricV30: [metric('3.0', 1)]
      } }])))
      expect(db.select().from(vulnerabilities).get()?.cvssScore).toBe(9.8)
    }
  })

  it('clears a removed NVD metric on a newer revision and preserves unknown as null', async () => {
    const db = database()
    const nvd = new NvdAdapter(db)
    await nvd.upsert(await nvd.parse(page([{ ...cve(), metrics: { cvssMetricV31: [metric()] } }])))
    await nvd.upsert(await nvd.parse(page([{ ...cve(), lastModified: '2024-01-03T00:00:00.000' }])))
    expect(db.select().from(vulnerabilities).get()).toMatchObject({ cvssScore: null, cvssVector: null, severity: null })
  })

  it.each([
    { published: '2024-02-30T00:00:00Z' }, { lastModified: 'invalid' },
    { lastModified: '2023-01-01T00:00:00Z' }, { published: '2024-01-01' },
    { descriptions: [null] }, { descriptions: [{ lang: 'en' }] }, { references: [null] },
    { metrics: [] }, { metrics: { cvssMetricV31: {} } }, { metrics: { cvssMetricV31: [null] } },
    { metrics: { cvssMetricV31: [{ ...metric(), source: '' }] } },
    { metrics: { cvssMetricV31: [{ ...metric(), type: 'unknown' }] } },
    { metrics: { cvssMetricV31: [{ ...metric(), cvssData: { version: '3.1', baseScore: 11, vectorString: 'CVSS:3.1/AV:N' } }] } },
    { metrics: { cvssMetricV31: [{ ...metric(), cvssData: { version: '3.0', baseScore: 5, vectorString: 'CVSS:3.1/AV:N' } }] } },
    { metrics: { cvssMetricV31: [{ ...metric(), cvssData: { version: '3.1', baseScore: 5, vectorString: 'not-a-vector' } }] } }
  ])('rejects malformed consumed fields: %j', async (changes) => {
    const db = database()
    await expect(new NvdAdapter(db).parse(page([{ ...cve(), ...changes }]))).rejects.toThrow('Invalid NVD')
  })

  it('rejects invalid stored source data without replacing it or canonical data', async () => {
    const db = database()
    const nvd = new NvdAdapter(db)
    await nvd.upsert(await nvd.parse(page([cve()])))
    db.update(sourceRecords).set({ rawJson: '{broken' }).run()
    await expect(nvd.upsert(await nvd.parse(page([{ ...cve(), lastModified: '2024-01-03T00:00:00Z' }])))).rejects.toThrow('stored NVD')
    expect(db.select().from(sourceRecords).get()?.rawJson).toBe('{broken')
    expect(db.select().from(vulnerabilities).get()?.modifiedAt).toBe('2024-01-02T00:00:00.000')
  })

  it.each([
    { startIndex: -1 }, { startIndex: 1.5 }, { startIndex: 0, lastModStartDate: '2024-01-01T00:00:00Z' },
    { startIndex: 0, lastModStartDate: '', lastModEndDate: '' },
    { startIndex: 0, lastModStartDate: '2024-02-01T00:00:00Z', lastModEndDate: '2024-01-01T00:00:00Z' },
    { startIndex: 0, lastModStartDate: '2024-01-01T00:00:00Z', lastModEndDate: '2024-06-01T00:00:00Z' }
  ])('rejects invalid request cursor before network: %j', async (cursor) => {
    const db = database()
    await expect(new NvdAdapter(db).fetchIncremental({ cursor })).rejects.toThrow('cursor')
    expect(db.select().from(feeds).all()).toHaveLength(0)
  })

  it.each([
    null, [], {}, { ...page([]), totalResults: -1 },
    { ...page([cve()]), resultsPerPage: 2 }, { ...page([cve()]), totalResults: 0 },
    { ...page([]), resultsPerPage: 2001 }, { ...page([]), totalResults: 1 }
  ])('rejects malformed pages: %j', async (raw) => {
    await expect(new NvdAdapter(database()).parse(raw)).rejects.toThrow('Invalid NVD page')
  })

  it('passes API keys in headers and rejects unexpected offsets and 304 responses', async () => {
    const db = database()
    let status = 200
    const adapter: AxiosAdapter = async (config) => {
      expect(config.headers.get('apiKey')).toBe('test-secret')
      expect(config.params).toEqual({ startIndex: 0 })
      return { config, status, statusText: '', headers: {}, data: { ...page([]), startIndex: 1 } }
    }
    const nvd = new NvdAdapter(db, 'test-secret', new HttpClient({}, axios.create({ adapter })))
    await expect(nvd.fetchIncremental({ cursor: null })).rejects.toThrow('offset')
    status = 304
    await expect(nvd.fetchIncremental({ cursor: null })).rejects.toThrow('304')
  })
})
