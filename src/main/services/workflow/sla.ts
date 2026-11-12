import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '@main/db'
import { sla } from '@main/db/schema'
import type { SlaEntry, SlaView } from '@shared/api'
import { ServiceError } from '../errors'
import { nextRevision, requireVulnerability, type Reader } from './records'
import { owner, readUtc, slaRemove, slaWrite } from './validation'

const columns = { id: sla.id, vulnerabilityId: sla.vulnerabilityId, revision: sla.revision,
  dueAt: sql<string>`substr(${sla.dueAt}, 1, 128)`, patchedAt: sql<string | null>`substr(${sla.patchedAt}, 1, 128)`,
  dateValuesTruncated: sql<boolean>`length(${sla.dueAt}) > 128 or coalesce(length(${sla.patchedAt}) > 128, 0)`.mapWith(Boolean) }

function view(db: Reader, vulnerabilityId: number, now: number): SlaView {
  const row = db.select(columns).from(sla).where(eq(sla.vulnerabilityId, vulnerabilityId)).get()
  let record: SlaEntry | null = null
  if (row) {
    const due = readUtc(row.dueAt)
    const patched = row.patchedAt === null ? null : readUtc(row.patchedAt)
    const valid = !row.dateValuesTruncated && due !== null
      && (row.patchedAt === null || patched !== null && patched <= now)
    record = { ...row, state: !valid ? 'unknown' : patched !== null ? 'completed' : now > due! ? 'overdue' : 'open',
      isOverdue: valid ? patched === null && now > due! : null,
      missedDeadline: valid ? (patched ?? now) > due! : null }
  }
  return { vulnerabilityId, record, evaluatedAt: new Date(now).toISOString() }
}

export class SlaService {
  constructor(private readonly db: Db) {}

  get(input: unknown): SlaView {
    const vulnerabilityId = owner(input)
    return this.db.transaction((tx) => { requireVulnerability(tx, vulnerabilityId); return view(tx, vulnerabilityId, Date.now()) })
  }

  set(input: unknown): SlaView {
    const now = Date.now()
    const value = slaWrite(input, now)
    return this.db.transaction((tx) => {
      requireVulnerability(tx, value.vulnerabilityId)
      const previous = tx.select({ id: sla.id, revision: sla.revision })
        .from(sla).where(eq(sla.vulnerabilityId, value.vulnerabilityId)).get()
      if (value.expected === null) {
        if (previous) throw new ServiceError('CONFLICT')
        tx.insert(sla).values({ vulnerabilityId: value.vulnerabilityId, dueAt: value.dueAt, patchedAt: value.patchedAt }).run()
      } else {
        if (!previous || previous.id !== value.expected.id || previous.revision !== value.expected.revision) throw new ServiceError('CONFLICT')
        const saved = tx.update(sla).set({ dueAt: value.dueAt, patchedAt: value.patchedAt, revision: nextRevision(previous.revision) })
          .where(and(eq(sla.id, value.expected.id), eq(sla.revision, value.expected.revision)))
          .returning({ id: sla.id }).get()
        if (!saved) throw new ServiceError('CONFLICT')
      }
      return view(tx, value.vulnerabilityId, now)
    }, { behavior: 'immediate' })
  }

  remove(input: unknown): SlaView {
    const { vulnerabilityId, expected } = slaRemove(input)
    return this.db.transaction((tx) => {
      requireVulnerability(tx, vulnerabilityId)
      const previous = tx.select({ id: sla.id, revision: sla.revision }).from(sla).where(eq(sla.vulnerabilityId, vulnerabilityId)).get()
      if (!previous) throw new ServiceError('NOT_FOUND')
      if (previous.id !== expected.id || previous.revision !== expected.revision) throw new ServiceError('CONFLICT')
      const removed = tx.delete(sla).where(and(eq(sla.id, expected.id), eq(sla.revision, expected.revision))).returning({ id: sla.id }).get()
      if (!removed) throw new ServiceError('CONFLICT')
      return view(tx, vulnerabilityId, Date.now())
    }, { behavior: 'immediate' })
  }
}
