import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { initDb, type Db } from '@main/db'
import { feeds, matches, notes, sla, sourceRecords, stack, vulnerabilities, vulnerabilitySources } from '@main/db/schema'
import type { ApiErrorCode, StackComponentInput } from '@shared/api'
import { StackService } from '@main/services/stack'
import { ServiceError } from '@main/services/errors'
import { importStackConfig, parseStackConfig } from '@main/services/stack/config'

let db: Db
let service: StackService
const npm = (version = '1.0.0', name = 'Demo'): StackComponentInput => ({ kind: 'package', name, product: 'demo', version, purl: `pkg:npm/demo@${version}` })
const cpe: StackComponentInput = { kind: 'application', name: 'Apache', vendor: 'apache', product: 'http_server', version: '2.4.57', cpe23: 'cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:*' }
const config = (component: unknown) => JSON.stringify({ schemaVersion: 1, components: [component] })
const error = (action: () => unknown, code: ApiErrorCode) => {
  try { action(); throw new Error('Expected rejection') } catch (caught) {
    expect(caught).toBeInstanceOf(ServiceError)
    expect((caught as ServiceError).code).toBe(code)
  }
}
beforeEach(() => { db = initDb(':memory:'); service = new StackService(db) })
afterEach(() => { db.$client.close(); vi.useRealTimers(); vi.restoreAllMocks() })

function seedMatches(id: number) {
  const other = service.create(npm('2.0.0')).item
  const feed = db.insert(feeds).values({ name: 'osv', source: 'local:osv-json' }).returning().get()!
  const vuln = db.insert(vulnerabilities).values({ extId: 'DEMO', feedId: feed.id, status: 'Affected', isKnownExploited: true }).returning().get()!
  const source = db.insert(sourceRecords).values({ feedId: feed.id, sourceId: 'DEMO', rawJson: 'keep' }).returning().get()!
  db.insert(vulnerabilitySources).values({ vulnerabilityId: vuln.id, sourceRecordId: source.id }).run()
  db.insert(notes).values({ vulnerabilityId: vuln.id, body: 'keep' }).run()
  db.insert(sla).values({ vulnerabilityId: vuln.id, dueAt: '2026-12-01' }).run()
  db.insert(matches).values([{ vulnerabilityId: vuln.id, stackId: id }, { vulnerabilityId: vuln.id, stackId: other.id }]).run()
  return { other, vuln }
}
const preserveCatalog = () => {
  expect(db.select().from(vulnerabilities).get()).toMatchObject({ status: 'Affected', isKnownExploited: true })
  expect(db.select().from(notes).get()!.body).toBe('keep')
  expect(db.select().from(sla).get()!.dueAt).toBe('2026-12-01')
  expect(db.select().from(sourceRecords).get()!.rawJson).toBe('keep')
  expect(db.select().from(vulnerabilitySources).all()).toHaveLength(1)
}

describe('Inventory CRUD on real SQLite', () => {
  it('creates explicit read DTOs, reads an individual row and lists defaults', () => {
    expect(service.list()).toEqual({ items: [], total: 0, offset: 0, limit: 50 })
    const result = service.create(npm())
    expect(result).toMatchObject({ invalidatedMatches: 0, matchingRecomputed: false, item: {
      id: expect.any(Number), ...npm(), vendor: null, cpe23: null, createdAt: expect.any(String), updatedAt: expect.any(String)
    } })
    expect(result.item.createdAt).toBe(result.item.updatedAt)
    expect(service.get({ id: result.item.id })).toEqual(result.item)
    expect(service.list().items).toEqual([result.item])
  })

  it.each([cpe,
    { kind: 'package', name: 'Python', product: 'demo-lib', version: '1.2.0', purl: 'pkg:pypi/Demo_Lib@1.2.0' },
    { kind: 'package', name: 'Maven', product: 'org.demo:core', version: '1.0', purl: 'pkg:maven/org.demo/core@1.0' },
    { kind: 'system', name: 'Both', vendor: 'demo', product: 'demo', version: '1.0.0', purl: 'pkg:npm/demo@1.0.0', cpe23: 'cpe:2.3:a:demo:demo:1.0.0:*:*:*:*:*:*:*' }
  ])('shares the exact component policy with JSON import %#', (input) => {
    const expected = parseStackConfig(config(input))[0]
    expect(service.create(input).item).toMatchObject(expected)
    expect(importStackConfig(db, config(input))).toMatchObject({ added: 0, skipped: 1, total: 1 })
  })

  it('rejects duplicate identities with NULL and non-NULL vendors, allows different versions', () => {
    service.create(npm())
    error(() => service.create(npm('1.0.0', 'Different metadata')), 'CONFLICT')
    service.create(npm('1.1.0'))
    service.create(cpe)
    error(() => service.create(cpe), 'CONFLICT')
    expect(service.list().total).toBe(3)
  })

  it('does not accept legacy NULL-vendor duplicates silently', () => {
    const value = parseStackConfig(config(npm()))[0]
    const rows = db.insert(stack).values([value, value]).returning().all()
    error(() => service.create(npm()), 'CONFLICT')
    error(() => service.update({ id: rows[0].id, expectedUpdatedAt: rows[0].updatedAt, component: npm() }), 'CONFLICT')
    expect(service.remove({ id: rows[0].id, expectedUpdatedAt: rows[0].updatedAt })).toEqual({ id: rows[0].id, removedMatches: 0 })
    expect(service.list().total).toBe(1)
  })

  it('updates a full component atomically, preserves its ID/creation and invalidates only its own matches', () => {
    const previous = service.create(npm()).item
    const { other } = seedMatches(previous.id)
    const result = service.update({ id: previous.id, expectedUpdatedAt: previous.updatedAt, component: npm('1.1.0') })
    expect(result).toMatchObject({ invalidatedMatches: 1, matchingRecomputed: false, item: {
      id: previous.id, createdAt: previous.createdAt, version: '1.1.0', purl: 'pkg:npm/demo@1.1.0'
    } })
    expect(result.item.updatedAt > previous.updatedAt).toBe(true)
    expect(db.select().from(matches).all()).toMatchObject([{ stackId: other.id }])
    preserveCatalog()
  })

  it('preserves matches on rename and leaves an identical update idempotent', () => {
    const previous = service.create(npm()).item
    seedMatches(previous.id)
    expect(service.update({ id: previous.id, expectedUpdatedAt: previous.updatedAt, component: npm() })).toEqual({ item: previous, invalidatedMatches: 0, matchingRecomputed: false })
    const renamed = service.update({ id: previous.id, expectedUpdatedAt: previous.updatedAt, component: npm('1.0.0', 'Renamed') })
    expect(renamed.invalidatedMatches).toBe(0)
    expect(renamed.item.name).toBe('Renamed')
    expect(db.select().from(matches).all()).toHaveLength(2)
  })

  it('rejects identity collisions on update without altering matches or fields', () => {
    const previous = service.create(npm()).item
    seedMatches(previous.id)
    error(() => service.update({ id: previous.id, expectedUpdatedAt: previous.updatedAt, component: npm('2.0.0') }), 'CONFLICT')
    expect(service.get({ id: previous.id })).toEqual(previous)
    expect(db.select().from(matches).all()).toHaveLength(2)
  })

  it('uses strictly increasing revisions even with same-millisecond edits and a backward clock', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-07T12:00:00.000Z'))
    const previous = service.create(npm()).item
    const first = service.update({ id: previous.id, expectedUpdatedAt: previous.updatedAt, component: npm('1.0.0', 'First') }).item
    expect(first.updatedAt).toBe('2026-11-07T12:00:00.001Z')
    vi.setSystemTime(new Date('2026-11-06T12:00:00Z'))
    const second = service.update({ id: first.id, expectedUpdatedAt: first.updatedAt, component: npm('1.0.0', 'Second') }).item
    expect(second.updatedAt).toBe('2026-11-07T12:00:00.002Z')
    for (const expectedUpdatedAt of [previous.updatedAt, first.updatedAt]) {
      error(() => service.update({ id: previous.id, expectedUpdatedAt, component: npm('1.0.0', 'Stale') }), 'CONFLICT')
      error(() => service.remove({ id: previous.id, expectedUpdatedAt }), 'CONFLICT')
    }
    expect(service.get({ id: previous.id })).toEqual(second)
  })

  it('edits legacy SQLite UTC timestamps without changing timezone or ID', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-07T12:00:00Z'))
    const legacy = db.insert(stack).values({ ...parseStackConfig(config(npm()))[0], updatedAt: '2026-11-07 12:00:00' }).returning().get()!
    expect(service.update({ id: legacy.id, expectedUpdatedAt: legacy.updatedAt, component: npm('1.1.0') }).item.updatedAt).toBe('2026-11-07T12:00:00.001Z')
  })

  it('fails atomically on an invalid stored revision instead of guessing a timestamp', () => {
    const item = service.create(npm()).item
    seedMatches(item.id)
    db.update(stack).set({ updatedAt: 'invalid' }).where(eq(stack.id, item.id)).run()
    error(() => service.update({ id: item.id, expectedUpdatedAt: 'invalid', component: npm('1.1.0') }), 'INTERNAL_ERROR')
    expect(db.select().from(matches).all()).toHaveLength(2)
    expect(service.get({ id: item.id }).version).toBe('1.0.0')
  })

  it('deletes the chosen component and its matches while preserving canonical workflow and other components', () => {
    const item = service.create(npm()).item
    const { other } = seedMatches(item.id)
    expect(service.remove({ id: item.id, expectedUpdatedAt: item.updatedAt })).toEqual({ id: item.id, removedMatches: 1 })
    expect(service.list().items).toEqual([other])
    expect(db.select().from(matches).all()).toMatchObject([{ stackId: other.id }])
    error(() => service.get({ id: item.id }), 'NOT_FOUND')
    preserveCatalog()
  })

  it.each(['UPDATE', 'DELETE'])('rolls back %s failures together with match changes', operation => {
    const item = service.create(npm()).item
    seedMatches(item.id)
    const before = db.select().from(matches).all()
    db.$client.exec(`CREATE TRIGGER fail_write BEFORE ${operation} ON stack BEGIN SELECT RAISE(ABORT, 'test failure'); END`)
    expect(() => operation === 'UPDATE'
      ? service.update({ id: item.id, expectedUpdatedAt: item.updatedAt, component: npm('1.1.0') })
      : service.remove({ id: item.id, expectedUpdatedAt: item.updatedAt })).toThrow()
    expect(service.get({ id: item.id })).toEqual(item)
    expect(db.select().from(matches).all()).toEqual(before)
    preserveCatalog()
  })

  it('allows reads and rejects every write while a local import/selector is active', () => {
    const item = service.create(npm()).item
    const busy = new StackService(db, () => true)
    expect(busy.list().total).toBe(1)
    expect(busy.get({ id: item.id })).toEqual(item)
    error(() => busy.create(npm('3.0.0')), 'BUSY')
    error(() => busy.update({ id: item.id, expectedUpdatedAt: item.updatedAt, component: npm('1.1.0') }), 'BUSY')
    error(() => busy.remove({ id: item.id, expectedUpdatedAt: item.updatedAt }), 'BUSY')
    expect(service.get({ id: item.id })).toEqual(item)
  })

  it('returns NOT_FOUND for missing read/update/delete targets', () => {
    error(() => service.get({ id: 999 }), 'NOT_FOUND')
    error(() => service.update({ id: 999, expectedUpdatedAt: 'unknown', component: npm() }), 'NOT_FOUND')
    error(() => service.remove({ id: 999, expectedUpdatedAt: 'unknown' }), 'NOT_FOUND')
  })

  it('searches literal text with combined kind filters and stable pagination', () => {
    const first = service.create(npm('1.0.0', 'Same')).item
    const second = service.create(npm('1.1.0', 'Same')).item
    const third = service.create(npm('1.2.0', "100%_!\\' OR 1=1 --")).item
    service.create(cpe)
    expect(service.list({ kind: 'package', sort: 'id', limit: 1, offset: 1 })).toMatchObject({ total: 3, items: [{ id: second.id }] })
    expect(service.list({ search: "%_!\\' OR 1=1 --" }).items.map(row => row.id)).toEqual([third.id])
    expect(service.list({ kind: 'application', search: 'APACHE' }).total).toBe(1)
    expect(service.list({ search: '  same  ', sort: 'name' }).items.map(row => row.id)).toEqual([first.id, second.id])
    expect(service.list({ search: '1.1.0' }).total).toBe(1)
    expect(service.list({ search: '   ' }).total).toBe(4)
    expect(service.list({ offset: 50, limit: 100 })).toMatchObject({ total: 4, items: [] })
  })

  it.each(['id', 'name', 'updatedAt'] as const)('supports both %s sort directions with ID ties', sort => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-07T12:00:00Z'))
    const first = service.create(npm('1.0.0', 'Same')).item
    const second = service.create(npm('1.1.0', 'Same')).item
    expect(service.list({ sort, direction: 'asc' }).items.map(row => row.id)).toEqual([first.id, second.id])
    expect(service.list({ sort, direction: 'desc' }).items.map(row => row.id)).toEqual([second.id, first.id])
  })

  it('sorts mixed legacy/ISO UTC revisions chronologically, with malformed legacy dates last', () => {
    const first = service.create(npm('1.0.0')).item
    const second = service.create(npm('1.1.0')).item
    const third = service.create(npm('1.2.0')).item
    const invalid = service.create(npm('1.3.0')).item
    for (const [id, updatedAt] of [[first.id, '2026-11-07T08:00:00.000Z'], [second.id, '2026-11-07 12:00:00'],
      [third.id, '2026-11-07T13:00:00.000Z'], [invalid.id, 'invalid']] as const) {
      db.update(stack).set({ updatedAt }).where(eq(stack.id, id)).run()
    }
    expect(service.list({ sort: 'updatedAt', direction: 'asc' }).items.map(row => row.id)).toEqual([first.id, second.id, third.id, invalid.id])
    expect(service.list({ sort: 'updatedAt', direction: 'desc' }).items.map(row => row.id)).toEqual([third.id, second.id, first.id, invalid.id])
  })

  it.each([null, [], 1, 'q', { other: true }, { limit: 0 }, { limit: 101 }, { limit: '1' },
    { offset: -1 }, { offset: 1_000_001 }, { offset: 0.5 }, { sort: 'version' }, { direction: 'up' },
    { kind: 'unknown' }, { search: false }, { search: 'x'.repeat(201) }, { search: '\u0000' }, { [Symbol('hidden')]: 1 }
  ])('validates list input %#', input => error(() => service.list(input), 'INVALID_ARGUMENT'))

  it.each([null, [], { ...npm(), id: 1 }, { ...npm(), kind: 'unknown' }, { ...npm(), version: '*' },
    { ...npm(), version: '-' }, { ...npm(), version: '>=1.0.0' }, { ...npm(), name: ' spaced ' },
    { ...npm(), name: 'x'.repeat(2049) }, { ...npm(), vendor: '' }, { ...npm(), purl: null },
    { ...npm(), product: 'other' }, { ...npm(), purl: 'bad' }, { ...npm(), purl: 'pkg:npm/demo@2.0.0' },
    { ...npm(), purl: 'pkg:npm/demo@1.0.0?arch=x64' }, { ...npm(), purl: 'pkg:npm/demo@1.0.0#lib' },
    { ...npm(), purl: 'pkg:golang/demo@1.0.0' }, { ...cpe, vendor: null }, { ...cpe, vendor: 'other' },
    { ...cpe, cpe23: 'cpe:2.3:a:*:http_server:2.4.57:*:*:*:*:*:*:*' }, { ...cpe, cpe23: 'cpe:2.3:a:-:http_server:2.4.57:*:*:*:*:*:*:*' },
    { ...cpe, product: 'other' }, { ...cpe, version: '2.4.58' }, { ...cpe, cpe23: 'bad' },
    { ...npm(), [Symbol('hidden')]: 1 }, Object.create(npm())
  ])('rejects invalid/incoherent components identically for create and update %#', input => {
    const item = service.create(npm()).item
    error(() => service.create(input), 'INVALID_ARGUMENT')
    error(() => service.update({ id: item.id, expectedUpdatedAt: item.updatedAt, component: input }), 'INVALID_ARGUMENT')
    expect(service.get({ id: item.id })).toEqual(item)
  })

  it.each([null, { id: 0 }, { id: '1' }, { id: 1, extra: 1 }])('validates read IDs %#', input => error(() => service.get(input), 'INVALID_ARGUMENT'))

  it.each([null, {}, { id: 1 }, { id: '1', expectedUpdatedAt: 'a' }, { id: 1, expectedUpdatedAt: '' },
    { id: 1, expectedUpdatedAt: 1 }, { id: 1, expectedUpdatedAt: 'x'.repeat(65) }, { id: 1, expectedUpdatedAt: '\u0000' },
    { id: 1, expectedUpdatedAt: 'a', extra: true }
  ])('requires a valid revision for deletion %#', input => error(() => service.remove(input), 'INVALID_ARGUMENT'))

  it('requires full replacement and accepts null-prototype filters/components', () => {
    const item = service.create(Object.assign(Object.create(null), npm())).item
    error(() => service.update({ id: item.id, expectedUpdatedAt: item.updatedAt, component: { name: 'Partial' } }), 'INVALID_ARGUMENT')
    error(() => service.update({ id: item.id, expectedUpdatedAt: item.updatedAt, component: npm(), extra: true }), 'INVALID_ARGUMENT')
    expect(service.list(Object.create(null)).total).toBe(1)
    expect(service.list({ limit: 100, offset: 1_000_000 }).items).toEqual([])
  })
})
