import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { initDb, type Db } from '@main/db'
import { feeds, notes, sourceRecords, vulnerabilities, vulnerabilitySources } from '@main/db/schema'
import { OsvAdapter } from '@main/services/feeds/osv'
import { loadOsvMatchPage } from '@main/services/feeds/osv-catalog'
import { OSV_MAX_BYTES, osvTime } from '@main/services/feeds/osv-data'
import { HttpClient } from '@main/services/httpclient'
import { matchStack, type StackItemForMatch } from '@main/services/matcher/engine'

const record = (changes: Record<string, unknown> = {}) => ({ id: 'GHSA-test-unit-0001', modified: '2026-11-06T00:00:00.123456789Z',
  published: '2026-01-01T00:00:00Z', summary: 'OSV summary', details: 'OSV details', aliases: ['CVE-2026-0001'],
  affected: [{ package: { ecosystem: 'npm', name: 'demo' },
    ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.0.0' }] }] }], ...changes })
const inventory: StackItemForMatch = { id: 3, kind: 'package', name: 'demo', product: 'demo', vendor: null,
  version: '1.0.0', purl: 'pkg:npm/demo@1.0.0', cpe23: null }
const databases: Db[] = []
const dirs: string[] = []
const database = () => { const db = initDb(':memory:'); databases.push(db); return db }
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'vulnpulse-osv-')); dirs.push(dir); return dir }
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.$client.close()
  for (const dir of dirs.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected test directory')
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('OSV explicit local JSON import', () => {
  it('imports the distributed demo without network, repeats safely and evaluates its package rules', async () => {
    const network = vi.spyOn(HttpClient.prototype, 'request').mockRejectedValue(new Error('must not use network'))
    const db = database()
    const osv = new OsvAdapter(db)
    const path = resolve('examples/osv-demo.json')
    expect(await osv.importFile(path)).toEqual({ processed: 3 })
    const sources = db.select().from(sourceRecords).all()
    expect(sources).toHaveLength(3)
    expect(db.select().from(vulnerabilities).all().map(v => v.extId)).toEqual(['DEMO-LOCAL-0001', 'DEMO-LOCAL-0002', 'DEMO-LOCAL-0003'])
    const entries = JSON.parse(readFileSync(path, 'utf8'))
    const versions = ['1.1.0', '2.0.0', '3.0.0']
    const loaded = loadOsvMatchPage(db)
    for (const [index, entry] of entries.entries()) {
      const item = { ...inventory, version: versions[index], purl: `${entry.affected[0].package.purl}@${versions[index]}` }
      const vulnerability = loaded.vulnerabilities.find(v => v.extId === entry.id)!
      expect(matchStack([item], loaded.vulnerabilities).assessments.find(a => a.vulnerabilityId === vulnerability.id)).toMatchObject({ status: 'match', source: 'osv' })
    }
    const fixed = { ...inventory, version: '1.2.0', purl: 'pkg:npm/vulnpulse-demo-npm@1.2.0' }
    const npm = loaded.vulnerabilities.find(v => v.extId === 'DEMO-LOCAL-0001')!
    expect(matchStack([fixed], loaded.vulnerabilities).assessments.find(a => a.vulnerabilityId === npm.id)).toMatchObject({ status: 'no_match' })
    await osv.importFile(path)
    expect(db.select().from(sourceRecords).all()).toEqual(sources)
    expect(db.select().from(vulnerabilitySources).all()).toHaveLength(3)
    expect(network).not.toHaveBeenCalled()
  })

  it('imports a UTF-8 file without network and produces a local package match', async () => {
    const network = vi.spyOn(HttpClient.prototype, 'request').mockRejectedValue(new Error('must not use network'))
    const db = database()
    const path = join(directory(), 'osv.json')
    writeFileSync(path, '\uFEFF' + JSON.stringify(record()))
    const osv = new OsvAdapter(db)
    expect(await osv.importFile(path)).toEqual({ processed: 1 })
    expect(db.select().from(feeds).get()).toMatchObject({ name: 'osv', source: 'local:osv-json', syncState: null })
    const loaded = loadOsvMatchPage(db)
    expect(loaded.vulnerabilities[0]).not.toHaveProperty('rawJson')
    expect(loaded.vulnerabilities[0].extId).toBe('CVE-2026-0001')
    expect(matchStack([inventory], loaded.vulnerabilities).assessments[0]).toMatchObject({ status: 'match', source: 'osv' })
    await expect(osv.fetchIncremental({ cursor: null })).rejects.toThrow('network fetch is disabled')
    expect(network).not.toHaveBeenCalled()
  })

  it('is idempotent and preserves NVD/CISA technical data, KEV, statuses and notes', async () => {
    const db = database()
    const feed = db.insert(feeds).values({ name: 'nvd', source: 'test' }).returning().get()!
    const existing = db.insert(vulnerabilities).values({ extId: 'CVE-2026-0001', feedId: feed.id,
      description: 'NVD text', title: 'CISA title', status: 'Patched', cvssScore: 9.8, isKnownExploited: true }).returning().get()!
    db.insert(notes).values({ vulnerabilityId: existing.id, body: 'keep' }).run()
    const osv = new OsvAdapter(db)
    await osv.importJson(JSON.stringify(record()))
    await osv.importJson(JSON.stringify([record()]))
    expect(db.select().from(vulnerabilities).all()).toHaveLength(1)
    expect(db.select().from(vulnerabilities).get()).toMatchObject({ feedId: feed.id, description: 'NVD text', title: 'CISA title',
      status: 'Patched', cvssScore: 9.8, isKnownExploited: true })
    expect(db.select().from(notes).get()?.body).toBe('keep')
    expect(db.select().from(sourceRecords).all()).toHaveLength(1)
    expect(db.select().from(vulnerabilitySources).all()).toHaveLength(1)
  })

  it('links only explicit CVE aliases, keeping non-CVE advisories and related IDs separate', async () => {
    const db = database()
    const osv = new OsvAdapter(db)
    await osv.importJson(JSON.stringify([
      record({ aliases: ['CVE-2026-0001', 'CVE-2026-0001', 'CVE-2026-0002', 'GHSA-other-alias'] }),
      record({ id: 'OSV-TEST-2', aliases: [], related: ['CVE-2026-9999'], upstream: ['CVE-2026-8888'] })
    ]))
    expect(db.select().from(vulnerabilities).all().map((v) => v.extId)).toEqual(['CVE-2026-0001', 'CVE-2026-0002', 'OSV-TEST-2'])
    expect(db.select().from(vulnerabilitySources).all()).toHaveLength(3)
    expect(loadOsvMatchPage(db).vulnerabilities).toHaveLength(3)
  })

  it('replaces only the current source links when aliases change, preserving old workflow', async () => {
    const db = database()
    const osv = new OsvAdapter(db)
    await osv.importJson(JSON.stringify(record()))
    const first = db.select().from(vulnerabilities).get()!
    db.update(vulnerabilities).set({ status: 'In Progress' }).where(eq(vulnerabilities.id, first.id)).run()
    db.insert(notes).values({ vulnerabilityId: first.id, body: 'keep' }).run()
    await osv.importJson(JSON.stringify(record({ aliases: ['CVE-2026-0002'], modified: '2026-11-06T00:00:01Z' })))
    expect(loadOsvMatchPage(db).vulnerabilities.map((v) => v.extId)).toEqual(['CVE-2026-0002'])
    expect(db.select().from(vulnerabilities).where(eq(vulnerabilities.id, first.id)).get()?.status).toBe('In Progress')
    expect(db.select().from(notes).get()?.body).toBe('keep')
  })

  it('rejects stale and equal revisions without losing nanosecond precision, then reads newer conditions', async () => {
    const db = database()
    const osv = new OsvAdapter(db)
    await osv.importJson(JSON.stringify(record()))
    await osv.importJson(JSON.stringify(record({ summary: 'older', modified: '2026-11-06T00:00:00.123456788Z' })))
    await osv.importJson(JSON.stringify(record({ summary: 'equal' })))
    expect(JSON.parse(db.select().from(sourceRecords).get()!.rawJson!).summary).toBe('OSV summary')
    await osv.importJson(JSON.stringify(record({ modified: '2026-11-06T00:00:00.123456790Z', affected: [] })))
    expect(matchStack([inventory], loadOsvMatchPage(db).vulnerabilities).assessments[0].status).toBe('unknown')
  })

  it('retains withdrawn source history without automatically changing workflow to Patched', async () => {
    const db = database()
    const osv = new OsvAdapter(db)
    await osv.importJson(JSON.stringify(record()))
    await osv.importJson(JSON.stringify(record({ modified: '2026-11-06T01:00:00Z', withdrawn: '2026-11-06T00:30:00Z' })))
    expect(matchStack([inventory], loadOsvMatchPage(db).vulnerabilities).assessments[0]).toMatchObject({ status: 'unknown', reason: 'withdrawn' })
    expect(db.select().from(vulnerabilities).get()?.status).toBe('New')
  })

  it('rolls back the entire file, including source links, on a database failure', async () => {
    const db = database()
    db.$client.exec(`CREATE TRIGGER fail_osv BEFORE INSERT ON vulnerability_sources
      WHEN NEW.source_record_id = 2 BEGIN SELECT RAISE(ABORT, 'write failure'); END`)
    await expect(new OsvAdapter(db).importJson(JSON.stringify([record(), record({ id: 'OSV-TEST-2', aliases: ['CVE-2026-0002'] })]))).rejects.toThrow()
    for (const table of [feeds, sourceRecords, vulnerabilities, vulnerabilitySources]) expect(db.select().from(table).all()).toHaveLength(0)
  })

  it.each([
    null, {}, { id: '../bad' }, { modified: '2026-02-30T00:00:00Z' }, { modified: '2026-11-06T00:00:00' },
    { schema_version: '2.0.0' }, { published: 'bad' }, { withdrawn: 'bad' }, { aliases: [1] },
    { related: 'CVE-2026-0001' }, { details: null }, { affected: 'bad' }
  ])('rejects invalid record metadata before any writes: %j', async (changes) => {
    const db = database()
    const candidate = changes === null ? null : Object.keys(changes).length ? record(changes) : changes
    await expect(new OsvAdapter(db).importJson(JSON.stringify([record(), candidate]))).rejects.toThrow('OSV')
    expect(db.select().from(feeds).all()).toHaveLength(0)
  })

  it('rejects invalid JSON, duplicate IDs, empty batches and oversized input', async () => {
    const db = database()
    const osv = new OsvAdapter(db)
    await expect(osv.importJson('{')).rejects.toThrow('JSON')
    await expect(osv.importJson('[]')).rejects.toThrow('count')
    await expect(osv.importJson(JSON.stringify([record(), record()]))).rejects.toThrow('Duplicate')
    await expect(osv.importJson(' '.repeat(OSV_MAX_BYTES + 1))).rejects.toThrow('32 MiB')
    await expect(osv.parse(Array(1001).fill(record()))).rejects.toThrow('count')
    expect(db.select().from(feeds).all()).toHaveLength(0)
  })

  it('rejects oversized or invalid UTF-8 files and missing files without writes', async () => {
    const db = database()
    const osv = new OsvAdapter(db)
    const dir = directory()
    const oversized = join(dir, 'large.json')
    writeFileSync(oversized, Buffer.alloc(OSV_MAX_BYTES + 1, 32))
    await expect(osv.importFile(oversized)).rejects.toThrow('32 MiB')
    const invalid = join(dir, 'invalid.json')
    writeFileSync(invalid, Buffer.from([0xc3, 0x28]))
    await expect(osv.importFile(invalid)).rejects.toThrow()
    await expect(osv.importFile(join(dir, 'missing.json'))).rejects.toThrow()
    expect(db.select().from(feeds).all()).toHaveLength(0)
  })

  it('cancels before import and while reading without partial persistence', async () => {
    const db = database()
    const osv = new OsvAdapter(db)
    const controller = new AbortController()
    controller.abort()
    await expect(osv.importJson(JSON.stringify(record()), controller.signal)).rejects.toThrow('cancelled')
    await expect(osv.fetchIncremental({ cursor: null, signal: controller.signal })).rejects.toThrow('cancelled')
    await expect(osv.importFile('unused', controller.signal)).rejects.toThrow('cancelled')
    const path = join(directory(), 'osv.json')
    writeFileSync(path, JSON.stringify(record()))
    const during = new AbortController()
    const pending = osv.importFile(path, during.signal)
    during.abort()
    await expect(pending).rejects.toThrow()
    expect(db.select().from(feeds).all()).toHaveLength(0)
  })

  it('refuses to overwrite corrupt stored OSV data', async () => {
    const db = database()
    const osv = new OsvAdapter(db)
    await osv.importJson(JSON.stringify(record()))
    db.update(sourceRecords).set({ rawJson: '{broken' }).run()
    await expect(osv.importJson(JSON.stringify(record({ modified: '2026-11-06T01:00:00Z' })))).rejects.toThrow('stored OSV')
    expect(db.select().from(sourceRecords).get()?.rawJson).toBe('{broken')
  })

  it('rejects an inconsistent stored source identity and an excessive alias fan-out', async () => {
    const db = database()
    const osv = new OsvAdapter(db)
    const aliases = Array.from({ length: 1000 }, (_, i) => `CVE-2026-${String(i + 1000)}`)
    await expect(osv.upsert(await osv.parse(Array.from({ length: 11 }, (_, i) => record({ id: `OSV-TEST-${i}`, aliases }))))).rejects.toThrow('alias link budget')
    expect(db.select().from(feeds).all()).toHaveLength(0)
    await osv.importJson(JSON.stringify(record()))
    db.update(sourceRecords).set({ rawJson: JSON.stringify(record({ id: 'OSV-WRONG' })) }).run()
    await expect(osv.importJson(JSON.stringify(record()))).rejects.toThrow('stored OSV')
  })
})

describe('OSV source-key catalog pagination', () => {
  it('keeps several advisories for the same CVE across pages without losing evidence', async () => {
    const db = database()
    const osv = new OsvAdapter(db)
    await osv.importJson(JSON.stringify([record(), record({ id: 'OSV-TEST-2' }), record({ id: 'OSV-TEST-3', aliases: [] })]))
    const first = loadOsvMatchPage(db, { limit: 1 })
    const second = loadOsvMatchPage(db, { afterSourceId: first.nextAfterSourceId!, limit: 1 })
    const third = loadOsvMatchPage(db, { afterSourceId: second.nextAfterSourceId!, limit: 1 })
    expect(first.vulnerabilities[0].id).toBe(second.vulnerabilities[0].id)
    const combined = matchStack([inventory], [...first.vulnerabilities, ...second.vulnerabilities])
    expect(combined.matches).toHaveLength(1)
    expect(combined.assessments).toHaveLength(2)
    expect(third.nextAfterSourceId).toBeNull()
    expect(loadOsvMatchPage(db, { afterSourceId: 999 }).vulnerabilities).toEqual([])
  })
  it.each(['{', null, '{"id":"WRONG"}'])('retains damaged raw %j as unknown', async (rawJson) => {
    const db = database()
    await new OsvAdapter(db).importJson(JSON.stringify(record()))
    db.update(sourceRecords).set({ rawJson }).run()
    expect(matchStack([inventory], loadOsvMatchPage(db).vulnerabilities).assessments[0]).toMatchObject({ status: 'unknown', reason: 'invalid_source' })
  })
  it.each([{ limit: 0 }, { limit: 1001 }, { afterSourceId: -1 }, { afterSourceId: 1.5 }])('validates cursor %j', (options) => {
    expect(() => loadOsvMatchPage(database(), options)).toThrow('catalog page')
  })
})

describe('OSV date normalization', () => {
  it.each([null, '', '2026-02-30T00:00:00Z', '2026-11-06', '2026-11-06T24:00:00Z', '2026-11-06T00:00:00.1234567890Z'])('rejects %j', (value) => expect(osvTime(value)).toBeNull())
  it('normalizes equivalent timestamp representations', () => expect(osvTime('2026-11-06T00:00:00Z')).toBe(osvTime('2026-11-06T00:00:00.000000Z')))
})
