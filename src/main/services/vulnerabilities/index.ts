import { and, asc, count, desc, eq, exists, inArray, isNull, notExists, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { Db } from '@main/db'
import { feeds, sourceRecords, vulnerabilities as v, vulnerabilitySources as links } from '@main/db/schema'
import type { FeedName } from '@shared/enums'
import type { VulnerabilityDetail, VulnerabilityPage, VulnerabilityQuery, VulnerabilitySummary } from '@shared/api'
import { ServiceError } from '../errors'
import { identity, query, statusChange } from './validation'

type Reader = Pick<Db, 'select' | 'selectDistinct'>
const selection = {
  id: v.id, extId: v.extId,
  title: sql<string | null>`substr(${v.title}, 1, 2048)`,
  titleTruncated: sql<boolean>`coalesce(length(${v.title}) > 2048, 0)`.mapWith(Boolean),
  severity: v.severity, cvssScore: v.cvssScore, status: v.status,
  isKnownExploited: v.isKnownExploited, publishedAt: v.publishedAt, modifiedAt: v.modifiedAt
}

function linkedSources(db: Reader) {
  return db.select({ id: links.vulnerabilityId }).from(links)
    .innerJoin(sourceRecords, eq(sourceRecords.id, links.sourceRecordId))
    .innerJoin(feeds, eq(feeds.id, sourceRecords.feedId))
    .where(eq(links.vulnerabilityId, v.id))
}

function filter(db: Reader, q: VulnerabilityQuery): SQL | undefined {
  const conditions: SQL[] = []
  if (q.search) {
    const pattern = `%${q.search.replace(/[!%_]/g, '!$&')}%`
    conditions.push(sql`(${v.extId} like ${pattern} escape '!' or ${v.title} like ${pattern} escape '!')`)
  }
  if (q.severity !== undefined) conditions.push(q.severity === null ? isNull(v.severity) : eq(v.severity, q.severity))
  if (q.status !== undefined) conditions.push(eq(v.status, q.status))
  if (q.knownExploited !== undefined) conditions.push(eq(v.isKnownExploited, q.knownExploited))
  if (q.feed !== undefined) {
    // Source links are authoritative. feedId is only a fallback for legacy rows without links.
    const linkedFeed = db.select({ id: links.vulnerabilityId }).from(links)
      .innerJoin(sourceRecords, eq(sourceRecords.id, links.sourceRecordId))
      .innerJoin(feeds, and(eq(feeds.id, sourceRecords.feedId), eq(feeds.name, q.feed)))
      .where(eq(links.vulnerabilityId, v.id))
    conditions.push(or(exists(linkedFeed), and(notExists(linkedSources(db)),
      inArray(v.feedId, db.select({ id: feeds.id }).from(feeds).where(eq(feeds.name, q.feed)))))!)
  }
  return and(...conditions)
}

function withSources<T extends Omit<VulnerabilitySummary, 'sources'>>(db: Reader, rows: T[]): (T & { sources: FeedName[] })[] {
  if (!rows.length) return []
  const ids = rows.map((row) => row.id)
  const sources = new Map<number, Set<FeedName>>()
  for (const row of db.selectDistinct({ id: links.vulnerabilityId, name: feeds.name }).from(links)
    .innerJoin(sourceRecords, eq(sourceRecords.id, links.sourceRecordId))
    .innerJoin(feeds, eq(feeds.id, sourceRecords.feedId)).where(inArray(links.vulnerabilityId, ids)).all()) {
    const set = sources.get(row.id) ?? new Set<FeedName>()
    set.add(row.name); sources.set(row.id, set)
  }
  for (const row of db.select({ id: v.id, name: feeds.name }).from(v)
    .innerJoin(feeds, eq(feeds.id, v.feedId)).where(inArray(v.id, ids)).all()) {
    if (!sources.has(row.id)) sources.set(row.id, new Set([row.name]))
  }
  return rows.map((row) => ({ ...row, sources: [...(sources.get(row.id) ?? [])].sort() }))
}

function detail(db: Reader, id: number): VulnerabilityDetail {
  const row = db.select({ ...selection, createdAt: v.createdAt,
    description: sql<string | null>`substr(${v.description}, 1, 65536)`,
    descriptionTruncated: sql<boolean>`coalesce(length(${v.description}) > 65536, 0)`.mapWith(Boolean),
    cvssVector: sql<string | null>`substr(${v.cvssVector}, 1, 2048)`,
    cvssVectorTruncated: sql<boolean>`coalesce(length(${v.cvssVector}) > 2048, 0)`.mapWith(Boolean) }).from(v).where(eq(v.id, id)).get()
  if (!row) throw new ServiceError('NOT_FOUND')
  const sourceReferences = db.select({ feed: feeds.name,
    sourceId: sql<string>`substr(${sourceRecords.sourceId}, 1, 1024)`,
    sourceIdTruncated: sql<boolean>`length(${sourceRecords.sourceId}) > 1024`.mapWith(Boolean) }).from(links)
    .innerJoin(sourceRecords, eq(sourceRecords.id, links.sourceRecordId))
    .innerJoin(feeds, eq(feeds.id, sourceRecords.feedId)).where(eq(links.vulnerabilityId, id))
    .orderBy(asc(feeds.name), asc(sourceRecords.sourceId), asc(sourceRecords.id)).limit(100).all()
  const total = db.select({ value: count() }).from(links).where(eq(links.vulnerabilityId, id)).get()!.value
  return { ...withSources(db, [row])[0], sourceReferences, sourceReferencesTotal: total }
}

/** All filtering, projection and workflow writes stay in Main; no matching is inferred here. */
export class VulnerabilityService {
  constructor(private readonly db: Db) {}

  list(input?: unknown): VulnerabilityPage {
    const q = query(input)
    return this.db.transaction((tx) => {
      const where = filter(tx, q)
      const order = q.direction === 'asc' ? asc : desc
      const column = q.sort === 'severity'
        ? sql`case ${v.severity} when 'Critical' then 4 when 'High' then 3 when 'Medium' then 2 when 'Low' then 1 when 'None' then 0 end`
        : v[q.sort]
      const rows = tx.select(selection).from(v).where(where)
        .orderBy(asc(sql`${column} is null`), order(column), order(v.id)).limit(q.limit).offset(q.offset).all()
      return { items: withSources(tx, rows), total: tx.select({ value: count() }).from(v).where(where).get()!.value,
        limit: q.limit, offset: q.offset }
    })
  }

  get(input: unknown): VulnerabilityDetail {
    const id = identity(input)
    return this.db.transaction((tx) => detail(tx, id))
  }

  setStatus(input: unknown): VulnerabilityDetail {
    const { id, status } = statusChange(input)
    return this.db.transaction((tx) => {
      const saved = tx.update(v).set({ status }).where(eq(v.id, id)).returning({ id: v.id }).get()
      if (!saved) throw new ServiceError('NOT_FOUND')
      return detail(tx, id)
    })
  }
}
