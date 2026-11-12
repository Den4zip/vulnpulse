import { and, asc, count, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '@main/db'
import { notes } from '@main/db/schema'
import type { NoteEntry, NotePage } from '@shared/api'
import { ServiceError } from '../errors'
import { identity } from '../validation'
import { nextRevision, requireVulnerability, type Reader } from './records'
import { NOTE_MAX_LENGTH, noteCreate, noteQuery, noteRemove, noteUpdate } from './validation'

const columns = { id: notes.id, vulnerabilityId: notes.vulnerabilityId, revision: notes.revision, createdAt: notes.createdAt,
  body: sql<string>`substr(${notes.body}, 1, ${NOTE_MAX_LENGTH})`,
  bodyTruncated: sql<boolean>`length(${notes.body}) > ${NOTE_MAX_LENGTH}`.mapWith(Boolean) }

function existing(db: Reader, id: number, expectedRevision?: number): NoteEntry {
  const row = db.select(columns).from(notes).where(eq(notes.id, id)).get()
  if (!row) throw new ServiceError('NOT_FOUND')
  if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new ServiceError('CONFLICT')
  return row
}

export class NoteService {
  constructor(private readonly db: Db) {}

  list(input: unknown): NotePage {
    const q = noteQuery(input)
    return this.db.transaction((tx) => {
      requireVulnerability(tx, q.vulnerabilityId)
      const where = eq(notes.vulnerabilityId, q.vulnerabilityId)
      const direction = q.direction === 'asc' ? asc : desc
      return { items: tx.select(columns).from(notes).where(where).orderBy(direction(notes.id)).limit(q.limit).offset(q.offset).all(),
        total: tx.select({ value: count() }).from(notes).where(where).get()!.value, offset: q.offset, limit: q.limit }
    })
  }

  get(input: unknown): NoteEntry { return existing(this.db, identity(input)) }

  create(input: unknown): NoteEntry {
    const value = noteCreate(input)
    return this.db.transaction((tx) => {
      requireVulnerability(tx, value.vulnerabilityId)
      const row = tx.insert(notes).values(value).returning({ id: notes.id }).get()!
      return existing(tx, row.id)
    }, { behavior: 'immediate' })
  }

  update(input: unknown): NoteEntry {
    const value = noteUpdate(input)
    return this.db.transaction((tx) => {
      const previous = existing(tx, value.id, value.expectedRevision)
      const row = tx.update(notes).set({ body: value.body, revision: nextRevision(previous.revision) })
        .where(and(eq(notes.id, value.id), eq(notes.revision, value.expectedRevision))).returning({ id: notes.id }).get()
      if (!row) throw new ServiceError('CONFLICT')
      return existing(tx, row.id)
    }, { behavior: 'immediate' })
  }

  remove(input: unknown): { id: number } {
    const value = noteRemove(input)
    return this.db.transaction((tx) => {
      existing(tx, value.id, value.expectedRevision)
      const row = tx.delete(notes).where(and(eq(notes.id, value.id), eq(notes.revision, value.expectedRevision)))
        .returning({ id: notes.id }).get()
      if (!row) throw new ServiceError('CONFLICT')
      return row
    }, { behavior: 'immediate' })
  }
}
