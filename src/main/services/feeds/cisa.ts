import { and, eq } from 'drizzle-orm'
import type { Db } from '@main/db'
import { feeds, sourceRecords, vulnerabilities, vulnerabilitySources } from '@main/db/schema'
import { HttpClient } from '@main/services/httpclient'
import type { FeedAdapter, FeedFetchContext, FeedFetchResult, FeedUpsertResult } from './base'

export const CISA_KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json'
type KevRecord = Record<string, unknown> & { cveID: string; vulnerabilityName: string; shortDescription: string }
const runningDatabases = new WeakSet<object>()

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('CISA sync cancelled')
}

function validDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const timestamp = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
}

/** CISA does not establish version applicability; this adapter only records KEV membership. */
export class CisaAdapter implements FeedAdapter<unknown, KevRecord, string> {
  readonly name = 'cisa' as const
  constructor(private readonly db: Db, private readonly http: HttpClient = new HttpClient()) {}

  async fetchIncremental(context: FeedFetchContext<string>): Promise<FeedFetchResult<unknown, string>> {
    const response = await this.http.request<unknown>({
      url: CISA_KEV_URL,
      headers: context.cursor ? { 'If-None-Match': context.cursor } : undefined,
      signal: context.signal
    })
    if (response.status === 304) {
      if (!context.cursor) throw new Error('Unexpected CISA 304 without cached ETag')
      return { kind: 'not-modified' }
    }
    if (response.status !== 200) throw new Error(`Unexpected CISA status: ${response.status}`)
    return { kind: 'data', raw: response.data, nextCursor: response.headers.etag ?? null }
  }

  async parse(raw: unknown, signal?: AbortSignal): Promise<readonly KevRecord[]> {
    aborted(signal)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid CISA catalog')
    const catalog = raw as Record<string, unknown>
    if (typeof catalog.catalogVersion !== 'string' || typeof catalog.dateReleased !== 'string'
      || !Number.isFinite(Date.parse(catalog.dateReleased)) || !Number.isSafeInteger(catalog.count)
      || !Array.isArray(catalog.vulnerabilities) || catalog.count !== catalog.vulnerabilities.length) {
      throw new Error('Invalid CISA catalog metadata')
    }
    const ids = new Set<string>()
    const required = ['vendorProject', 'product', 'vulnerabilityName', 'dateAdded',
      'shortDescription', 'requiredAction', 'dueDate']
    return catalog.vulnerabilities.map((value: unknown) => {
      aborted(signal)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid CISA entry')
      const item = value as Record<string, unknown>
      if (typeof item.cveID !== 'string' || !/^CVE-\d{4}-\d{4,19}$/.test(item.cveID)
        || required.some((key) => typeof item[key] !== 'string') || !validDate(item.dateAdded)
        || !validDate(item.dueDate) || ids.has(item.cveID)
        || ['knownRansomwareCampaignUse', 'forensicTriage', 'notes'].some(
          (key) => item[key] !== undefined && typeof item[key] !== 'string')
        || (item.cwes !== undefined && (!Array.isArray(item.cwes)
          || item.cwes.some((cwe: unknown) => typeof cwe !== 'string' || !/^CWE-\d+$/.test(cwe))))) {
        throw new Error('Invalid or duplicate CISA entry')
      }
      ids.add(item.cveID)
      return item as KevRecord
    })
  }

  async upsert(records: readonly KevRecord[], signal?: AbortSignal): Promise<FeedUpsertResult> {
    return this.apply(records, undefined, signal)
  }

  /** Fetch outside a transaction, then apply records and ETag atomically. */
  async sync(signal?: AbortSignal): Promise<{ kind: 'updated' | 'not-modified'; processed: number }> {
    if (runningDatabases.has(this.db)) throw new Error('CISA sync already running')
    runningDatabases.add(this.db)
    try {
      aborted(signal)
      const feed = this.db.select().from(feeds).where(eq(feeds.name, 'cisa')).get()
      const fetched = await this.fetchIncremental({ cursor: feed?.etag ?? null, signal })
      aborted(signal)
      if (fetched.kind === 'not-modified') return { kind: 'not-modified', processed: 0 }
      const records = await this.parse(fetched.raw, signal)
      const result = this.apply(records, fetched.nextCursor, signal)
      return { kind: 'updated', processed: result.processed }
    } finally {
      runningDatabases.delete(this.db)
    }
  }

  private apply(records: readonly KevRecord[], etag: string | null | undefined, signal?: AbortSignal): FeedUpsertResult {
    aborted(signal)
    return this.db.transaction((tx) => {
      tx.insert(feeds).values({ name: 'cisa', source: CISA_KEV_URL }).onConflictDoNothing().run()
      const feed = tx.select().from(feeds).where(eq(feeds.name, 'cisa')).get()
      if (!feed) throw new Error('CISA feed unavailable')
      for (const record of records) {
        aborted(signal)
        tx.insert(vulnerabilities).values({ extId: record.cveID, feedId: feed.id,
          title: record.vulnerabilityName, description: record.shortDescription, isKnownExploited: true
        }).onConflictDoUpdate({ target: vulnerabilities.extId, set: { isKnownExploited: true } }).run()
        const vulnerability = tx.select({ id: vulnerabilities.id }).from(vulnerabilities)
          .where(eq(vulnerabilities.extId, record.cveID)).get()
        if (!vulnerability) throw new Error('CISA vulnerability unavailable')
        tx.insert(sourceRecords).values({ feedId: feed.id, sourceId: record.cveID, rawJson: JSON.stringify(record) })
          .onConflictDoUpdate({ target: [sourceRecords.feedId, sourceRecords.sourceId],
            set: { rawJson: JSON.stringify(record) } }).run()
        const source = tx.select({ id: sourceRecords.id }).from(sourceRecords)
          .where(and(eq(sourceRecords.feedId, feed.id), eq(sourceRecords.sourceId, record.cveID))).get()
        if (!source) throw new Error('CISA source record unavailable')
        tx.insert(vulnerabilitySources).values({ vulnerabilityId: vulnerability.id, sourceRecordId: source.id })
          .onConflictDoNothing().run()
      }
      aborted(signal)
      if (etag !== undefined) tx.update(feeds).set({ etag }).where(eq(feeds.id, feed.id)).run()
      return { processed: records.length }
    })
  }
}
