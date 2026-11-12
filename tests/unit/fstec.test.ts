import axios, { type AxiosAdapter } from 'axios'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import { eq } from 'drizzle-orm'
import { initDb, type Db } from '@main/db'
import { feeds, notes, sourceRecords, vulnerabilities, vulnerabilitySources } from '@main/db/schema'
import { HttpClient } from '@main/services/httpclient'
import { FstecAdapter } from '@main/services/feeds/fstec'
import { FSTEC_MIRROR_URL, FSTEC_MAX_COMPRESSED, type FstecRecord } from '@main/services/feeds/fstec-data'

const directory = mkdtempSync(join(tmpdir(), 'vulnpulse-fstec-test-'))
const databases: Db[] = []
let workerPath: string
let createBuilt: (db: Db, http?: HttpClient) => FstecAdapter
const requireModule = createRequire(import.meta.url)
const database = () => { const db = initDb(':memory:'); databases.push(db); return db }
const record = (id = 'BDU:2026-00001', date = '06.11.2026', cve = 'CVE-2026-0001', extra = '') => `<vul>
  <identifier>${id}</identifier><name>Тестовая уязвимость</name><description>Описание &amp; текст</description>
  <publication_date>01.11.2026</publication_date><last_upd_date>${date}</last_upd_date>
  <vulnerable_software><soft><name>Demo</name><vendor>Vendor</vendor><version>до 2.0 включительно</version></soft></vulnerable_software>
  <cvss3><vector score="9,8">CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H</vector></cvss3>
  ${cve ? `<identifiers><identifier type="CVE" link="https://example.org/?a=1&amp;b=2">${cve}</identifier><identifier type="Other">CVE-2026-9999</identifier></identifiers>` : ''}${extra}</vul>`
const xml = (...entries: string[]) => `<?xml version="1.0" encoding="utf-8"?><vulnerabilities>${entries.join('')}</vulnerabilities>`
let fileNumber = 0
const file = (text: string | Buffer, suffix = '.xml') => {
  const path = join(directory, `input-${++fileNumber}${suffix}`)
  writeFileSync(path, text)
  return path
}
const adapter = (db: Db, http?: HttpClient, timeoutMs?: number, path = workerPath) => new FstecAdapter(db, { workerPath: path, timeoutMs }, http)
const transport = (respond: AxiosAdapter) => new HttpClient({ maxRetries: 0 }, axios.create({ adapter: respond }))

beforeAll(() => {
  // Exercise electron-vite's real ?modulePath output, not a stubbed worker constructor.
  execFileSync(process.execPath, [resolve('node_modules/electron-vite/bin/electron-vite.js'), 'build'], { cwd: resolve('.'), stdio: 'pipe' })
  workerPath = join(resolve('out/main/chunks'), readdirSync('out/main/chunks').find((name) => /^fstec-worker-.*\.js$/.test(name))!)
  createBuilt = requireModule(resolve('out/main/fstec-import.js')).createFstecAdapter
}, 30000)
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.$client.close() })
afterAll(() => {
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected test directory')
  rmSync(directory, { recursive: true, force: true })
})

describe('FSTEC manual XML import with the real production worker', () => {
  it('imports the distributed synthetic example locally with no CVE links or duplicates', async () => {
    const network = vi.spyOn(HttpClient.prototype, 'request').mockRejectedValue(new Error('must not use network'))
    const db = database()
    const feed = createBuilt(db)
    expect(await feed.importFile(resolve('examples/fstec-demo.xml'))).toEqual({ processed: 2 })
    const saved = db.select().from(sourceRecords).all()
    expect(saved.map(row => row.sourceId)).toEqual(['BDU:0000-00001', 'BDU:0000-00002'])
    expect(JSON.parse(saved[1].rawJson!).fields.description).toContain('< > &')
    expect(db.select().from(vulnerabilities).all().map(row => row.extId)).toEqual(['BDU:0000-00001', 'BDU:0000-00002'])
    await feed.importFile(resolve('examples/fstec-demo.xml'))
    expect(db.select().from(sourceRecords).all()).toEqual(saved)
    expect(db.select().from(vulnerabilitySources).all()).toHaveLength(2)
    expect(network).not.toHaveBeenCalled()
  })

  it('imports UTF-8 XML locally, preserving raw fields, CVE links, and Cyrillic', async () => {
    const db = database()
    const network = vi.spyOn(HttpClient.prototype, 'request').mockRejectedValue(new Error('no network expected'))
    const result = await createBuilt(db).importFile(file('\uFEFF' + xml(record())))
    expect(result).toEqual({ processed: 1 })
    expect(network).not.toHaveBeenCalled()
    const saved = db.select().from(sourceRecords).get()!
    const payload = JSON.parse(saved.rawJson!)
    expect(payload).toMatchObject({ format: 'fstec-xml-v1', origin: 'manual', modifiedAt: '2026-11-06' })
    expect(payload.fields.name).toBe('Тестовая уязвимость')
    expect(payload.fields.description).toBe('Описание & текст')
    expect(payload.xml).toContain('vulnerable_software')
    expect(payload.fields.cvss3.vector['@_score']).toBe('9,8')
    expect(db.select().from(vulnerabilities).get()?.extId).toBe('CVE-2026-0001')
    expect(db.select().from(vulnerabilitySources).all()).toHaveLength(1)
    expect(db.select().from(feeds).get()).toMatchObject({ name: 'fstec', source: 'local:fstec-xml', etag: null })
  })

  it('accepts local XML.GZ and bounded parse/upsert, without inventing CVE aliases from text', async () => {
    const db = database()
    await adapter(db).importFile(file(gzipSync(xml(record(undefined, undefined, ''))), '.xml.gz'))
    expect(db.select().from(vulnerabilities).get()?.extId).toBe('BDU:2026-00001')
    const records = await adapter(db).parse({ kind: 'bytes', data: Buffer.from(xml(record('BDU:2026-00002', '06.11.2026', 'CVE-2026-0002'))) })
    expect(records).toHaveLength(1)
    await adapter(db).upsert(records)
    expect(db.select().from(sourceRecords).all()).toHaveLength(2)
  })

  it('handles CDATA closing-tag text, comments, quotes in attributes and split input tokens', async () => {
    const db = database()
    const description = '<description><![CDATA[<script>literal</script> </vul> &content;]]></description>'
    const largeComment = '<!--' + 'x'.repeat(65535) + '-->'
    const entry = record().replace('<description>Описание &amp; текст</description>', description)
      .replace('<name>Demo</name>', '<name note=">">Demo</name>')
    await adapter(db).importFile(file(xml(largeComment + entry)))
    const saved = JSON.parse(db.select().from(sourceRecords).get()!.rawJson!)
    expect(saved.fields.description).toContain('</vul> &content;')
    expect(saved.fields.vulnerable_software.soft.name['@_note']).toBe('>')
  })

  it('preserves workflow and other providers, ignores stale/equal dates and applies a newer source', async () => {
    const db = database()
    const nvd = db.insert(feeds).values({ name: 'nvd', source: 'test' }).returning().get()!
    const existing = db.insert(vulnerabilities).values({ extId: 'CVE-2026-0001', feedId: nvd.id, title: 'Keep',
      status: 'Patched', cvssScore: 9.8, isKnownExploited: true }).returning().get()!
    db.insert(notes).values({ vulnerabilityId: existing.id, body: 'keep' }).run()
    const fstec = adapter(db)
    await fstec.importFile(file(xml(record())))
    await fstec.importFile(file(xml(record(undefined, '05.11.2026').replace('Тестовая', 'Старая'))))
    await fstec.importFile(file(xml(record().replace('Тестовая', 'Иная'))))
    expect(JSON.parse(db.select().from(sourceRecords).get()!.rawJson!).fields.name).toBe('Тестовая уязвимость')
    await fstec.importFile(file(xml(record(undefined, '07.11.2026'))))
    expect(JSON.parse(db.select().from(sourceRecords).get()!.rawJson!).modifiedAt).toBe('2026-11-07')
    expect(db.select().from(vulnerabilities).where(eq(vulnerabilities.id, existing.id)).get()).toMatchObject({
      title: 'Keep', status: 'Patched', cvssScore: 9.8, isKnownExploited: true
    })
    expect(db.select().from(notes).get()?.body).toBe('keep')
  })

  it('updates only current FSTEC links on a revised CVE mapping and preserves the old card', async () => {
    const db = database()
    const fstec = adapter(db)
    await fstec.importFile(file(xml(record())))
    const first = db.select().from(vulnerabilities).get()!
    db.insert(notes).values({ vulnerabilityId: first.id, body: 'keep' }).run()
    await fstec.importFile(file(xml(record(undefined, '07.11.2026', 'CVE-2026-0002'))))
    expect(db.select().from(vulnerabilities).all()).toHaveLength(2)
    expect(db.select().from(vulnerabilitySources).get()?.vulnerabilityId).not.toBe(first.id)
    expect(db.select().from(notes).get()?.body).toBe('keep')
  })

  it('rolls back the entire file when persistence fails', async () => {
    const db = database()
    db.$client.exec(`CREATE TRIGGER fail_fstec BEFORE INSERT ON source_records
      WHEN NEW.source_id = 'BDU:2026-00002' BEGIN SELECT RAISE(ABORT, 'failure'); END`)
    await expect(adapter(db).importFile(file(xml(record(), record('BDU:2026-00002', undefined, 'CVE-2026-0002'))))).rejects.toThrow()
    for (const table of [feeds, sourceRecords, vulnerabilities, vulnerabilitySources]) expect(db.select().from(table).all()).toHaveLength(0)
  })

  it.each([
    '<vulnerabilities/>', '<root></root>', '<vulnerabilities><vul></vulnerabilities>',
    xml(record()) + '<extra/>', xml(record(), record()),
    xml(record().replace('<name>Тестовая уязвимость</name>', '<name>A</name><name>B</name>')),
    '<!DOCTYPE vulnerabilities [<!ENTITY x SYSTEM "file:///not-read">]>' + xml(record()),
    xml(record().replace('<description>Описание &amp; текст</description>', '<description>' + '<a>'.repeat(33) + 'x' + '</a>'.repeat(33) + '</description>')),
    xml(record().replace('Описание &amp; текст', 'x'.repeat(2 * 1024 * 1024 + 1))),
    '<?xml version="1.0" encoding="windows-1251"?><vulnerabilities>' + record() + '</vulnerabilities>'
  ])('rejects malformed/unsupported XML without any database writes (%#)', async (input) => {
    const db = database()
    await expect(adapter(db).importFile(file(input))).rejects.toThrow()
    expect(db.select().from(feeds).all()).toHaveLength(0)
  })

  it('rejects invalid UTF-8, corrupt gzip, and missing files', async () => {
    const db = database()
    const fstec = adapter(db)
    await expect(fstec.importFile(file(Buffer.from([0xc3, 0x28])))).rejects.toThrow()
    await expect(fstec.importFile(file('not gzip', '.xml.gz'))).rejects.toThrow()
    await expect(fstec.importFile(join(directory, 'missing.xml'))).rejects.toThrow()
    expect(db.select().from(feeds).all()).toHaveLength(0)
  })

  it('retains malformed CVE references as warnings without inventing a CVE link', async () => {
    const db = database()
    const input = xml(record().replace('CVE-2026-0001</identifier>', 'bad</identifier>'))
    expect(await adapter(db).importFile(file(input))).toEqual({ processed: 1, warnings: 1 })
    expect(db.select().from(vulnerabilities).get()?.extId).toBe('BDU:2026-00001')
    expect(JSON.parse(db.select().from(sourceRecords).get()!.rawJson!).warnings).toEqual(['invalid_cve_reference'])
  })

  it('retains invalid provider dates in raw payload with a warning and a safe date fallback', async () => {
    const db = database()
    expect(await adapter(db).importFile(file(xml(record(undefined, '30.02.2026'))))).toEqual({ processed: 1, warnings: 1 })
    const raw = JSON.parse(db.select().from(sourceRecords).get()!.rawJson!)
    expect(raw.fields.last_upd_date).toBe('30.02.2026')
    expect(raw.modifiedAt).toBe('2026-11-01')
    expect(raw.warnings).toContain('invalid_last_upd_date')
  })

  it('cancels a real worker, rejects overlapping imports, and releases the lock', async () => {
    const db = database()
    const path = file(xml(record()))
    const controller = new AbortController()
    const fstec = adapter(db)
    const pending = fstec.importFile(path, controller.signal)
    await expect(adapter(db).importFile(path)).rejects.toThrow('already running')
    controller.abort()
    await expect(pending).rejects.toThrow('cancelled')
    expect(db.select().from(feeds).all()).toHaveLength(0)
    await expect(fstec.importFile(path)).resolves.toEqual({ processed: 1 })
  })

  it('terminates a timed-out worker and handles premature exit/invalid metadata', async () => {
    const db = database()
    const path = file(xml(record()))
    const stall = file('setInterval(() => {}, 1000)', '.cjs')
    await expect(adapter(db, undefined, 50, stall).importFile(path)).rejects.toThrow('timed out')
    const exit = file('process.exit(0)', '.cjs')
    await expect(adapter(db, undefined, 1000, exit).importFile(path)).rejects.toThrow('exited')
    const invalid = file('require("node:worker_threads").parentPort.postMessage({ok:true,stage:{count:-1}})', '.cjs')
    await expect(adapter(db, undefined, 1000, invalid).importFile(path)).rejects.toThrow('stage metadata')
    expect(db.select().from(feeds).all()).toHaveLength(0)
  })
})

describe('FSTEC mirror through the shared HTTP layer', () => {
  it('downloads gzip, commits data and ETag together, then uses If-None-Match and 304', async () => {
    const db = database()
    const http = transport(async (config) => {
      expect(config.url).toBe(FSTEC_MIRROR_URL)
      expect(config.params).toBeUndefined()
      const cached = config.headers.get('If-None-Match')
      return { config, status: cached ? 304 : 200, statusText: '', headers: { etag: '"snapshot-1"' }, data: cached ? '' : gzipSync(xml(record())) }
    })
    const fstec = createBuilt(db, http)
    expect(await fstec.syncMirror()).toEqual({ kind: 'updated', processed: 1 })
    expect(db.select().from(feeds).get()).toMatchObject({ etag: '"snapshot-1"', source: FSTEC_MIRROR_URL })
    expect(JSON.parse(db.select().from(sourceRecords).get()!.rawJson!).origin).toBe('mirror')
    expect(await fstec.syncMirror()).toEqual({ kind: 'not-modified', processed: 0 })
    // A successful manual import invalidates the mirror ETag.
    await fstec.importFile(file(xml(record(undefined, '07.11.2026'))))
    expect(db.select().from(feeds).get()?.etag).toBeNull()
  })

  it('does not advance ETag on bad gzip/XML or a failed transaction', async () => {
    const db = database()
    db.insert(feeds).values({ name: 'fstec', source: FSTEC_MIRROR_URL, etag: '"old"' }).run()
    let bytes = Buffer.from('invalid gzip')
    const http = transport(async (config) => ({ config, status: 200, statusText: '', headers: { etag: '"new"' }, data: bytes }))
    await expect(adapter(db, http).syncMirror()).rejects.toThrow()
    expect(db.select().from(feeds).get()?.etag).toBe('"old"')
    bytes = gzipSync(xml(record()))
    db.$client.exec(`CREATE TRIGGER fail_write BEFORE INSERT ON source_records BEGIN SELECT RAISE(ABORT, 'failure'); END`)
    await expect(adapter(db, http).syncMirror()).rejects.toThrow()
    expect(db.select().from(feeds).get()?.etag).toBe('"old"')
    expect(db.select().from(vulnerabilities).all()).toHaveLength(0)
  })

  it('rejects unsolicited 304 and oversized responses', async () => {
    const db = database()
    const notModified = transport(async (config) => ({ config, status: 304, statusText: '', headers: {}, data: '' }))
    await expect(adapter(db, notModified).syncMirror()).rejects.toThrow('304')
    const large = transport(async (config) => ({ config, status: 200, statusText: '', headers: {}, data: Buffer.alloc(FSTEC_MAX_COMPRESSED + 1) }))
    await expect(adapter(db, large).syncMirror()).rejects.toThrow()
    expect(db.select().from(feeds).all()).toHaveLength(0)
  })

  it('accepts abort before network without creating a feed', async () => {
    const db = database()
    const controller = new AbortController()
    controller.abort()
    await expect(adapter(db).syncMirror(controller.signal)).rejects.toThrow('cancelled')
    expect(db.select().from(feeds).all()).toHaveLength(0)
  })
})
