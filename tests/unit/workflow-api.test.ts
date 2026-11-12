import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { initDb, type Db } from '@main/db'
import { feeds, notes, sla, vulnerabilities } from '@main/db/schema'
import type { ApiErrorCode, SlaEntry } from '@shared/api'
import { ServiceError } from '@main/services/errors'
import { NoteService } from '@main/services/workflow/notes'
import { SlaService } from '@main/services/workflow/sla'
import { nextRevision } from '@main/services/workflow/records'
import { OsvAdapter } from '@main/services/feeds/osv'

const NOW = '2026-11-07T12:00:00.000Z'
const PAST = '2026-11-06T12:00:00.000Z'
const FUTURE = '2026-11-08T12:00:00.000Z'
let db: Db
let noteService: NoteService
let slaService: SlaService
let owner: number
let other: number
const token = (row: Pick<SlaEntry, 'id' | 'revision'>) => ({ id: row.id, revision: row.revision })
const reject = (action: () => unknown, code: ApiErrorCode) => {
  try { action(); throw new Error('Expected error') } catch (error) {
    expect(error).toBeInstanceOf(ServiceError); expect((error as ServiceError).code).toBe(code)
  }
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(NOW))
  db = initDb(':memory:')
  const feed = db.insert(feeds).values({ name: 'nvd', source: 'fixture' }).returning().get()!
  owner = db.insert(vulnerabilities).values({ extId: 'CVE-2024-0001', feedId: feed.id, status: 'Affected', isKnownExploited: true }).returning().get()!.id
  other = db.insert(vulnerabilities).values({ extId: 'CVE-2024-0002', feedId: feed.id }).returning().get()!.id
  noteService = new NoteService(db); slaService = new SlaService(db)
})
afterEach(() => { db.$client.close(); vi.useRealTimers() })

describe('Notes workflow', () => {
  it('creates text verbatim, paginates only the chosen vulnerability and preserves creation/ownership on edit', () => {
    expect(noteService.list({ vulnerabilityId: owner })).toEqual({ items: [], total: 0, offset: 0, limit: 50 })
    const first = noteService.create({ vulnerabilityId: owner, body: '  Кириллица\r\n\t<script>text only</script>  ' })
    const second = noteService.create({ vulnerabilityId: owner, body: 'Second' })
    noteService.create({ vulnerabilityId: other, body: 'Other vulnerability' })
    expect(first).toMatchObject({ vulnerabilityId: owner, revision: 1, bodyTruncated: false, body: '  Кириллица\r\n\t<script>text only</script>  ' })
    expect(noteService.get({ id: first.id })).toEqual(first)
    expect(noteService.list({ vulnerabilityId: owner }).items).toEqual([second, first])
    expect(noteService.list({ vulnerabilityId: owner, direction: 'asc', limit: 1, offset: 1 })).toMatchObject({ total: 2, items: [second] })
    expect(noteService.list({ vulnerabilityId: owner, limit: 100, offset: 1_000_000 })).toMatchObject({ total: 2, items: [] })
    const changed = noteService.update({ id: first.id, expectedRevision: first.revision, body: 'Edited' })
    expect(changed).toEqual({ ...first, body: 'Edited', revision: 2 })
    expect(db.select().from(vulnerabilities).where(eq(vulnerabilities.id, owner)).get()).toMatchObject({ status: 'Affected', isKnownExploited: true })
  })

  it('prevents stale edits/deletes and ABA after changing text back to its old value', () => {
    const first = noteService.create({ vulnerabilityId: owner, body: 'A' })
    const second = noteService.update({ id: first.id, expectedRevision: 1, body: 'B' })
    const third = noteService.update({ id: first.id, expectedRevision: second.revision, body: 'A' })
    expect(third.revision).toBe(3)
    reject(() => noteService.update({ id: first.id, expectedRevision: 1, body: 'Stale' }), 'CONFLICT')
    reject(() => noteService.remove({ id: first.id, expectedRevision: 1 }), 'CONFLICT')
    const fourth = noteService.update({ id: first.id, expectedRevision: 3, body: 'A' })
    expect(fourth.revision).toBe(4)
    expect(noteService.remove({ id: first.id, expectedRevision: 4 })).toEqual({ id: first.id })
    reject(() => noteService.get({ id: first.id }), 'NOT_FOUND')
    reject(() => noteService.update({ id: first.id, expectedRevision: 4, body: 'After delete' }), 'NOT_FOUND')
    reject(() => noteService.remove({ id: first.id, expectedRevision: 4 }), 'NOT_FOUND')
  })

  it('bounds legacy text explicitly without rewriting it and accepts the exact new-text limit', () => {
    const legacy = db.insert(notes).values({ vulnerabilityId: owner, body: 'x'.repeat(20_000) }).returning().get()!
    expect(noteService.get({ id: legacy.id })).toMatchObject({ body: 'x'.repeat(16_384), bodyTruncated: true, revision: 1 })
    expect(noteService.list({ vulnerabilityId: owner }).items[0].bodyTruncated).toBe(true)
    expect(db.select().from(notes).where(eq(notes.id, legacy.id)).get()!.body).toHaveLength(20_000)
    expect(noteService.create({ vulnerabilityId: owner, body: 'x'.repeat(16_384) }).bodyTruncated).toBe(false)
  })

  it('does not change unrelated notes/SLA when deleting a note and rejects missing parents', () => {
    const first = noteService.create({ vulnerabilityId: owner, body: 'first' })
    const second = noteService.create({ vulnerabilityId: owner, body: 'second' })
    slaService.set({ vulnerabilityId: owner, dueAt: FUTURE, patchedAt: null, expected: null })
    noteService.remove({ id: first.id, expectedRevision: 1 })
    expect(noteService.get({ id: second.id })).toEqual(second)
    expect(slaService.get({ vulnerabilityId: owner }).record!.dueAt).toBe(FUTURE)
    reject(() => noteService.create({ vulnerabilityId: 9999, body: 'Orphan' }), 'NOT_FOUND')
    reject(() => noteService.list({ vulnerabilityId: 9999 }), 'NOT_FOUND')
  })

  it.each(['INSERT', 'UPDATE', 'DELETE'])('rolls back note %s failure', (operation) => {
    const existing = noteService.create({ vulnerabilityId: owner, body: 'Keep' })
    db.$client.exec(`CREATE TRIGGER fail_note BEFORE ${operation} ON notes BEGIN SELECT RAISE(ABORT, 'fixture'); END`)
    expect(() => operation === 'INSERT' ? noteService.create({ vulnerabilityId: owner, body: 'New' })
      : operation === 'UPDATE' ? noteService.update({ id: existing.id, expectedRevision: 1, body: 'Changed' })
        : noteService.remove({ id: existing.id, expectedRevision: 1 })).toThrow()
    expect(noteService.list({ vulnerabilityId: owner }).items).toEqual([existing])
  })

  it.each([undefined, null, [], {}, { vulnerabilityId: 0 }, { vulnerabilityId: '1' }, { vulnerabilityId: 1, extra: true },
    { vulnerabilityId: 1, limit: 0 }, { vulnerabilityId: 1, limit: 101 }, { vulnerabilityId: 1, offset: -1 },
    { vulnerabilityId: 1, offset: 1_000_001 }, { vulnerabilityId: 1, direction: 'up' }
  ])('validates note pages %#', input => reject(() => noteService.list(input), 'INVALID_ARGUMENT'))

  it.each(['', ' \r\n\t ', 'x'.repeat(16_385), '\u0000', '\u000b', 1, null, undefined])('validates note text %#', body => {
    reject(() => noteService.create({ vulnerabilityId: owner, body }), 'INVALID_ARGUMENT')
    reject(() => noteService.update({ id: 1, expectedRevision: 1, body }), 'INVALID_ARGUMENT')
  })

  it.each([{ id: 0, expectedRevision: 1 }, { id: 1 }, { id: 1, expectedRevision: 0 }, { id: 1, expectedRevision: '1' },
    { id: 1, expectedRevision: 1.5 }, { id: 1, expectedRevision: 1, vulnerabilityId: 1 }])('validates note mutation identity %#', input => {
    reject(() => noteService.remove(input), 'INVALID_ARGUMENT')
    reject(() => noteService.update({ ...input, body: 'text' }), 'INVALID_ARGUMENT')
  })

  it('does not allow hidden fields or ownership reassignment', () => {
    reject(() => noteService.create({ vulnerabilityId: owner, body: 'x', [Symbol('hidden')]: true }), 'INVALID_ARGUMENT')
    reject(() => noteService.create({ vulnerabilityId: owner, body: 'x', createdAt: NOW }), 'INVALID_ARGUMENT')
    reject(() => noteService.update({ id: 1, expectedRevision: 1, body: 'x', vulnerabilityId: other }), 'INVALID_ARGUMENT')
    reject(() => noteService.get({ id: '1' }), 'INVALID_ARGUMENT')
  })
})

describe('SLA workflow and Main clock', () => {
  it('distinguishes missing SLA from missing vulnerability', () => {
    expect(slaService.get({ vulnerabilityId: owner })).toEqual({ vulnerabilityId: owner, record: null, evaluatedAt: NOW })
    reject(() => slaService.get({ vulnerabilityId: 9999 }), 'NOT_FOUND')
    reject(() => slaService.set({ vulnerabilityId: 9999, dueAt: FUTURE, patchedAt: null, expected: null }), 'NOT_FOUND')
  })

  it.each([[PAST, 'overdue', true], [NOW, 'open', false], [FUTURE, 'open', false]] as const)('evaluates an unpatched deadline %s', (dueAt, state, isOverdue) => {
    expect(slaService.set({ vulnerabilityId: owner, dueAt, patchedAt: null, expected: null })).toMatchObject({ evaluatedAt: NOW,
      record: { vulnerabilityId: owner, dueAt, patchedAt: null, revision: 1, state, isOverdue, missedDeadline: isOverdue } })
  })

  it('recalculates time-based state without changing a revision or writing data', () => {
    const created = slaService.set({ vulnerabilityId: owner, dueAt: NOW, patchedAt: null, expected: null }).record!
    vi.setSystemTime(new Date(Date.parse(NOW) + 1))
    expect(slaService.get({ vulnerabilityId: owner })).toMatchObject({ record: { revision: created.revision, state: 'overdue' }, evaluatedAt: '2026-11-07T12:00:00.001Z' })
    expect(db.select().from(sla).get()!.revision).toBe(1)
  })

  it.each([[PAST, NOW, true], [NOW, PAST, false], [NOW, NOW, false]] as const)('separates completion from missing its deadline %#', (dueAt, patchedAt, missedDeadline) => {
    expect(slaService.set({ vulnerabilityId: owner, dueAt, patchedAt, expected: null }).record).toMatchObject({ state: 'completed', isOverdue: false, missedDeadline })
    expect(db.select().from(vulnerabilities).where(eq(vulnerabilities.id, owner)).get()!.status).toBe('Affected')
  })

  it('reopens SLA explicitly and detects stale writes, stale deletes and create conflicts', () => {
    const first = slaService.set({ vulnerabilityId: owner, dueAt: PAST, patchedAt: NOW, expected: null }).record!
    reject(() => slaService.set({ vulnerabilityId: owner, dueAt: FUTURE, patchedAt: null, expected: null }), 'CONFLICT')
    const second = slaService.set({ vulnerabilityId: owner, dueAt: FUTURE, patchedAt: null, expected: token(first) }).record!
    expect(second).toMatchObject({ id: first.id, revision: 2, state: 'open' })
    reject(() => slaService.set({ vulnerabilityId: owner, dueAt: PAST, patchedAt: null, expected: token(first) }), 'CONFLICT')
    reject(() => slaService.remove({ vulnerabilityId: owner, expected: token(first) }), 'CONFLICT')
    expect(slaService.remove({ vulnerabilityId: owner, expected: token(second) })).toEqual({ vulnerabilityId: owner, record: null, evaluatedAt: NOW })
    reject(() => slaService.remove({ vulnerabilityId: owner, expected: token(second) }), 'NOT_FOUND')
    reject(() => slaService.set({ vulnerabilityId: owner, dueAt: FUTURE, patchedAt: null, expected: token(second) }), 'CONFLICT')
  })

  it('rejects an old SLA token after delete/recreate even if both revisions are 1', () => {
    const first = slaService.set({ vulnerabilityId: owner, dueAt: FUTURE, patchedAt: null, expected: null }).record!
    slaService.remove({ vulnerabilityId: owner, expected: token(first) })
    const recreated = slaService.set({ vulnerabilityId: owner, dueAt: FUTURE, patchedAt: null, expected: null }).record!
    expect(recreated.id).not.toBe(first.id)
    expect(recreated.revision).toBe(1)
    reject(() => slaService.set({ vulnerabilityId: owner, dueAt: PAST, patchedAt: null, expected: token(first) }), 'CONFLICT')
    reject(() => slaService.remove({ vulnerabilityId: owner, expected: token(first) }), 'CONFLICT')
    reject(() => slaService.remove({ vulnerabilityId: other, expected: token(recreated) }), 'NOT_FOUND')
  })

  it.each([['2026-11-06', null], ['bad', null], [PAST, 'bad'], [PAST, FUTURE], ['x'.repeat(200), null], [PAST, 'x'.repeat(200)]])('keeps ambiguous/invalid legacy times unknown %#', (dueAt, patchedAt) => {
    const row = db.insert(sla).values({ vulnerabilityId: owner, dueAt: dueAt!, patchedAt }).returning().get()!
    expect(slaService.get({ vulnerabilityId: owner }).record).toMatchObject({ state: 'unknown', isOverdue: null, missedDeadline: null,
      dateValuesTruncated: dueAt!.length > 128 || (patchedAt?.length ?? 0) > 128 })
    expect(db.select().from(sla).where(eq(sla.id, row.id)).get()).toEqual(row)
    const fixed = slaService.set({ vulnerabilityId: owner, dueAt: FUTURE, patchedAt: null, expected: token(row) }).record!
    expect(fixed.state).toBe('open')
  })

  it.each(['INSERT', 'UPDATE', 'DELETE'])('rolls back SLA %s failure and preserves notes/status', operation => {
    const note = noteService.create({ vulnerabilityId: owner, body: 'Keep' })
    const row = operation === 'INSERT' ? null : slaService.set({ vulnerabilityId: owner, dueAt: FUTURE, patchedAt: null, expected: null }).record!
    db.$client.exec(`CREATE TRIGGER fail_sla BEFORE ${operation} ON sla BEGIN SELECT RAISE(ABORT, 'fixture'); END`)
    expect(() => operation === 'DELETE' ? slaService.remove({ vulnerabilityId: owner, expected: token(row!) })
      : slaService.set({ vulnerabilityId: owner, dueAt: PAST, patchedAt: null, expected: row ? token(row) : null })).toThrow()
    expect(slaService.get({ vulnerabilityId: owner }).record).toEqual(row)
    expect(noteService.get({ id: note.id })).toEqual(note)
    expect(db.select().from(vulnerabilities).where(eq(vulnerabilities.id, owner)).get()!.status).toBe('Affected')
  })

  it.each(['2026-11-06', '2026-11-07T12:00:00Z', '2026-11-07T15:00:00.000+03:00', '2026-02-30T12:00:00.000Z',
    '2026-11-07T24:00:00.000Z', '2026-11-07T12:00:60.000Z', '2026-11-07T12:00:00.0000Z', '', null, 1])('validates explicit UTC input %#', dueAt => {
    reject(() => slaService.set({ vulnerabilityId: owner, dueAt, patchedAt: null, expected: null }), 'INVALID_ARGUMENT')
    if (dueAt !== null) reject(() => slaService.set({ vulnerabilityId: owner, dueAt: FUTURE, patchedAt: dueAt, expected: null }), 'INVALID_ARGUMENT')
  })

  it('rejects future patching and incomplete/extra/invalid command fields', () => {
    for (const input of [null, {}, { vulnerabilityId: owner, dueAt: FUTURE, patchedAt: FUTURE, expected: null },
      { vulnerabilityId: owner, dueAt: FUTURE, patchedAt: null }, { vulnerabilityId: owner, dueAt: FUTURE, expected: null },
      { vulnerabilityId: '1', dueAt: FUTURE, patchedAt: null, expected: null },
      { vulnerabilityId: owner, dueAt: FUTURE, patchedAt: null, expected: { id: 1, revision: 0 } },
      { vulnerabilityId: owner, dueAt: FUTURE, patchedAt: null, expected: null, status: 'Patched' }]) {
      reject(() => slaService.set(input), 'INVALID_ARGUMENT')
    }
    reject(() => slaService.get({ vulnerabilityId: '1' }), 'INVALID_ARGUMENT')
    reject(() => slaService.remove({ vulnerabilityId: owner, expected: null }), 'INVALID_ARGUMENT')
    reject(() => slaService.remove({ vulnerabilityId: owner, expected: { id: 1, revision: 1, dueAt: NOW } }), 'INVALID_ARGUMENT')
  })
})

describe('Workflow invariants', () => {
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, Infinity, NaN])('refuses invalid/exhausted revision %s', revision => {
    reject(() => nextRevision(revision), 'INTERNAL_ERROR')
  })

  it('rolls back exhausted note and SLA revisions', () => {
    const note = noteService.create({ vulnerabilityId: owner, body: 'Keep' })
    db.update(notes).set({ revision: Number.MAX_SAFE_INTEGER }).where(eq(notes.id, note.id)).run()
    reject(() => noteService.update({ id: note.id, expectedRevision: Number.MAX_SAFE_INTEGER, body: 'Changed' }), 'INTERNAL_ERROR')
    expect(noteService.get({ id: note.id }).body).toBe('Keep')
    const record = slaService.set({ vulnerabilityId: owner, dueAt: FUTURE, patchedAt: null, expected: null }).record!
    db.update(sla).set({ revision: Number.MAX_SAFE_INTEGER }).where(eq(sla.id, record.id)).run()
    reject(() => slaService.set({ vulnerabilityId: owner, dueAt: PAST, patchedAt: null, expected: { id: record.id, revision: Number.MAX_SAFE_INTEGER } }), 'INTERNAL_ERROR')
    expect(slaService.get({ vulnerabilityId: owner }).record!.dueAt).toBe(FUTURE)
  })

  it('preserves notes/SLA/IDs/revisions and global status across a newer OSV import', async () => {
    const adapter = new OsvAdapter(db)
    const advisory = { id: 'DEMO-WORKFLOW', modified: PAST, aliases: ['CVE-2024-0001'], summary: 'Before' }
    await adapter.importJson(JSON.stringify(advisory))
    const note = noteService.create({ vulnerabilityId: owner, body: 'Keep' })
    const record = slaService.set({ vulnerabilityId: owner, dueAt: FUTURE, patchedAt: null, expected: null }).record!
    await adapter.importJson(JSON.stringify({ ...advisory, modified: NOW, summary: 'New source metadata' }))
    expect(noteService.get({ id: note.id })).toEqual(note)
    expect(slaService.get({ vulnerabilityId: owner }).record).toEqual(record)
    expect(db.select().from(vulnerabilities).where(eq(vulnerabilities.id, owner)).get()!.status).toBe('Affected')
  })
})
