import { and, asc, count, desc, eq, isNull, ne, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { Db } from '@main/db'
import { matches, stack } from '@main/db/schema'
import type { StackDeleteResult, StackEntry, StackPage, StackWriteResult } from '@shared/api'
import { ServiceError } from '../errors'
import type { StackComponent } from './component'
import { component, identity, query, removal, update } from './validation'

type Reader = Pick<Db, 'select'>
const columns = { id: stack.id, kind: stack.kind, name: stack.name, vendor: stack.vendor,
  product: stack.product, version: stack.version, cpe23: stack.cpe23, purl: stack.purl,
  createdAt: stack.createdAt, updatedAt: stack.updatedAt }
const matchFields = ['kind', 'vendor', 'product', 'version', 'cpe23', 'purl'] as const

function existing(db: Reader, id: number, expected?: string): StackEntry {
  const row = db.select(columns).from(stack).where(eq(stack.id, id)).get()
  if (!row) throw new ServiceError('NOT_FOUND')
  if (expected !== undefined && row.updatedAt !== expected) throw new ServiceError('CONFLICT')
  return row
}

function unique(db: Reader, value: StackComponent, exceptId?: number): void {
  // SQLite UNIQUE does not de-duplicate NULL vendor identities; all supported writes must check them.
  if (db.select({ id: stack.id }).from(stack).where(and(
    value.vendor === null ? isNull(stack.vendor) : eq(stack.vendor, value.vendor),
    eq(stack.product, value.product), eq(stack.version, value.version),
    exceptId === undefined ? undefined : ne(stack.id, exceptId)
  )).limit(1).get()) throw new ServiceError('CONFLICT')
}

function nextTimestamp(previous: string): string {
  // Older imports used SQLite datetime('now') in UTC; newer CRUD uses ISO UTC.
  const timestamp = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(previous) ? previous.replace(' ', 'T') + 'Z' : previous)
  if (!Number.isFinite(timestamp)) throw new ServiceError('INTERNAL_ERROR')
  return new Date(Math.max(Date.now(), timestamp + 1)).toISOString()
}

/** Main-only inventory CRUD. Full replacement keeps CPE/PURL/version coherent. */
export class StackService {
  constructor(private readonly db: Db, private readonly importsBusy: () => boolean = () => false) {}

  list(input?: unknown): StackPage {
    const q = query(input)
    return this.db.transaction((tx) => {
      const conditions: SQL[] = []
      if (q.kind !== undefined) conditions.push(eq(stack.kind, q.kind))
      if (q.search) {
        const pattern = `%${q.search.replace(/[!%_]/g, '!$&')}%`
        conditions.push(sql`(${stack.name} like ${pattern} escape '!' or ${stack.vendor} like ${pattern} escape '!'
          or ${stack.product} like ${pattern} escape '!' or ${stack.version} like ${pattern} escape '!')`)
      }
      const where = and(...conditions)
      const direction = q.direction === 'asc' ? asc : desc
      const column = q.sort === 'updatedAt' ? sql`julianday(${stack.updatedAt})` : stack[q.sort]
      const items = tx.select(columns).from(stack).where(where)
        .orderBy(asc(sql`${column} is null`), direction(column), direction(stack.id))
        .limit(q.limit).offset(q.offset).all()
      return { items, total: tx.select({ total: count() }).from(stack).where(where).get()!.total,
        offset: q.offset, limit: q.limit }
    })
  }

  get(input: unknown): StackEntry { return existing(this.db, identity(input)) }

  create(input: unknown): StackWriteResult {
    const value = component(input)
    this.checkBusy()
    return this.db.transaction((tx) => {
      unique(tx, value)
      const now = new Date().toISOString()
      const item = tx.insert(stack).values({ ...value, createdAt: now, updatedAt: now }).returning(columns).get()!
      return { item, invalidatedMatches: 0, matchingRecomputed: false }
    }, { behavior: 'immediate' })
  }

  update(input: unknown): StackWriteResult {
    const { id, expectedUpdatedAt, component: value } = update(input)
    this.checkBusy()
    return this.db.transaction((tx) => {
      const previous = existing(tx, id, expectedUpdatedAt)
      unique(tx, value, id)
      const changed = matchFields.some((key) => previous[key] !== value[key])
      if (!changed && previous.name === value.name) return { item: previous, invalidatedMatches: 0, matchingRecomputed: false }
      const invalidatedMatches = changed ? tx.select({ total: count() }).from(matches).where(eq(matches.stackId, id)).get()!.total : 0
      if (changed) tx.delete(matches).where(eq(matches.stackId, id)).run()
      const item = tx.update(stack).set({ ...value, updatedAt: nextTimestamp(previous.updatedAt) })
        .where(and(eq(stack.id, id), eq(stack.updatedAt, expectedUpdatedAt))).returning(columns).get()
      if (!item) throw new ServiceError('CONFLICT')
      return { item, invalidatedMatches, matchingRecomputed: false }
    }, { behavior: 'immediate' })
  }

  remove(input: unknown): StackDeleteResult {
    const { id, expectedUpdatedAt } = removal(input)
    this.checkBusy()
    return this.db.transaction((tx) => {
      existing(tx, id, expectedUpdatedAt)
      const removedMatches = tx.select({ total: count() }).from(matches).where(eq(matches.stackId, id)).get()!.total
      const removed = tx.delete(stack).where(and(eq(stack.id, id), eq(stack.updatedAt, expectedUpdatedAt))).returning({ id: stack.id }).get()
      if (!removed) throw new ServiceError('CONFLICT')
      return { id, removedMatches }
    }, { behavior: 'immediate' })
  }

  private checkBusy(): void { if (this.importsBusy()) throw new ServiceError('BUSY') }
}
