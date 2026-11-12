import { and, eq } from 'drizzle-orm'
import type { Db } from '@main/db'
import { feeds, sourceRecords, vulnerabilities, vulnerabilitySources } from '@main/db/schema'
import { HttpClient, NVD_RATE_LIMITS } from '@main/services/httpclient'
import type { FeedAdapter, FeedFetchContext, FeedFetchResult, FeedUpsertResult } from './base'
import { nvdCve, nvdPage, nvdScore, nvdTime, type NvdCve } from './nvd-data'
import { checkCursor, NVD_MAX_WINDOW_MS, NVD_OVERLAP_MS, readNvdState, type NvdCursor, type NvdSyncState } from './nvd-state'

export type { NvdCursor } from './nvd-state'
export const NVD_CVE_URL = 'https://services.nvd.nist.gov/rest/json/cves/2.0'
// Share conservative budgets across profiles, including adapter recreation.
const anonymousHttp = new HttpClient({ rateLimit: NVD_RATE_LIMITS.anonymous })
const authenticatedHttp = new HttpClient({ rateLimit: NVD_RATE_LIMITS.authenticated })
const runningDatabases = new WeakSet<object>()

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('NVD sync cancelled')
}

/** Imports NVD records without flattening unsupported applicability rules. */
export class NvdAdapter implements FeedAdapter<unknown, NvdCve, NvdCursor> {
  readonly name = 'nvd' as const
  private readonly http: HttpClient
  constructor(private readonly db: Db, private readonly apiKey?: string, http?: HttpClient) {
    this.http = http ?? (apiKey ? authenticatedHttp : anonymousHttp)
  }

  async fetchIncremental(context: FeedFetchContext<NvdCursor>): Promise<FeedFetchResult<unknown, NvdCursor>> {
    checkAbort(context.signal)
    const cursor = context.cursor ?? { startIndex: 0 }
    checkCursor(cursor)
    const params: Record<string, string | number> = { startIndex: cursor.startIndex }
    if (cursor.lastModStartDate !== undefined && cursor.lastModEndDate !== undefined) {
      params.lastModStartDate = cursor.lastModStartDate
      params.lastModEndDate = cursor.lastModEndDate
    }
    const result = await this.http.request<unknown>({ url: NVD_CVE_URL, params,
      headers: this.apiKey ? { apiKey: this.apiKey } : undefined, signal: context.signal })
    checkAbort(context.signal)
    if (result.status !== 200) throw new Error(`Unexpected NVD status: ${result.status}`)
    const data = nvdPage(result.data)
    if (data.startIndex !== cursor.startIndex) throw new Error('Unexpected NVD page offset')
    const next = data.startIndex + data.resultsPerPage
    return { kind: 'data', raw: data, nextCursor: next < data.totalResults ? { ...cursor, startIndex: next } : null }
  }

  async parse(raw: unknown, signal?: AbortSignal): Promise<readonly NvdCve[]> {
    checkAbort(signal)
    const data = nvdPage(raw)
    const ids = new Set<string>()
    return data.vulnerabilities.map((item) => {
      checkAbort(signal)
      const cve = nvdCve(item && typeof item === 'object' && 'cve' in item ? item.cve : null)
      if (ids.has(cve.id)) throw new Error('Invalid NVD CVE: duplicate ID')
      ids.add(cve.id)
      return cve
    })
  }

  async upsert(records: readonly NvdCve[], signal?: AbortSignal): Promise<FeedUpsertResult> {
    return this.apply(records, undefined, signal)
  }

  /** Each validated page and checkpoint commit together, outside network waits.
   * Interrupted windows replay from zero because NVD is a live result set.
   * Initial population is unfiltered; later windows overlap and are <=120 days.
   */
  async sync(signal?: AbortSignal): Promise<{ processed: number; pages: number; completedThrough: string }> {
    if (runningDatabases.has(this.db.$client)) throw new Error('NVD sync already running')
    runningDatabases.add(this.db.$client)
    try {
      checkAbort(signal)
      const target = Date.now()
      const existing = this.db.select().from(feeds).where(eq(feeds.name, 'nvd')).get()
      let state = readNvdState(existing?.syncState ?? null)
      // Preserve the fixed interval, but replay moving offsets after interruption.
      if (state.pending) state = { ...state, pending: { ...state.pending, startIndex: 0 } }
      let processed = 0
      let pages = 0
      let total: number | undefined
      while (state.pending || state.completedThrough === null || nvdTime(state.completedThrough) < target) {
        checkAbort(signal)
        if (!state.pending) {
          const start = state.completedThrough === null ? null : Math.max(0, nvdTime(state.completedThrough) - NVD_OVERLAP_MS)
          state = { ...state, pending: start === null
            ? { startIndex: 0, baselineAt: new Date(target).toISOString() }
            : { startIndex: 0, lastModStartDate: new Date(start).toISOString(),
              lastModEndDate: new Date(Math.min(target, start + NVD_MAX_WINDOW_MS)).toISOString() } }
          // Persist the interval before its first request, including a failed one.
          this.apply([], state, signal)
          total = undefined
        }
        const pending = state.pending!
        const fetched = await this.fetchIncremental({ cursor: pending, signal })
        if (fetched.kind !== 'data') throw new Error('Unexpected NVD not-modified response')
        const page = nvdPage(fetched.raw)
        // New CVEs append during the unfiltered initial scan. Incremental membership
        // can also shrink as lastModified moves, so replay such a changing window.
        if (total !== undefined && (pending.baselineAt === undefined
          ? total !== page.totalResults : page.totalResults < total)) {
          throw new Error('NVD result set changed; replay required')
        }
        total = page.totalResults
        const records = await this.parse(page, signal)
        const next: NvdSyncState = fetched.nextCursor
          ? { ...state, pending: { ...pending, ...fetched.nextCursor } }
          : { version: 1, completedThrough: pending.baselineAt ?? pending.lastModEndDate!, pending: null }
        this.apply(records, next, signal)
        processed += records.length
        pages++
        state = next
      }
      return { processed, pages, completedThrough: state.completedThrough! }
    } finally {
      runningDatabases.delete(this.db.$client)
    }
  }

  private apply(records: readonly NvdCve[], state: NvdSyncState | undefined, signal?: AbortSignal): FeedUpsertResult {
    checkAbort(signal)
    return this.db.transaction((tx) => {
      tx.insert(feeds).values({ name: 'nvd', source: NVD_CVE_URL }).onConflictDoNothing().run()
      const feed = tx.select().from(feeds).where(eq(feeds.name, 'nvd')).get()
      if (!feed) throw new Error('NVD feed unavailable')
      for (const record of records) {
        checkAbort(signal)
        const cve = nvdCve(record)
        const source = tx.select().from(sourceRecords)
          .where(and(eq(sourceRecords.feedId, feed.id), eq(sourceRecords.sourceId, cve.id))).get()
        if (source?.rawJson) {
          let previous: NvdCve
          try { previous = nvdCve(JSON.parse(source.rawJson)) } catch { throw new Error('Invalid stored NVD source record') }
          // Equal timestamps are idempotent even if a stale replica changes a payload.
          if (nvdTime(previous.lastModified) >= nvdTime(cve.lastModified)) continue
        }
        const description = cve.descriptions.find((d) => d.lang === 'en')?.value
        const score = nvdScore(cve)
        const fields = { description, publishedAt: cve.published, modifiedAt: cve.lastModified,
          cvssScore: score?.cvssScore ?? null, cvssVector: score?.cvssVector ?? null, severity: score?.severity ?? null }
        // NVD owns technical fields regardless of import order; preserve KEV/title/workflow.
        tx.insert(vulnerabilities).values({ extId: cve.id, feedId: feed.id, ...fields })
          .onConflictDoUpdate({ target: vulnerabilities.extId, set: fields }).run()
        const vuln = tx.select().from(vulnerabilities).where(eq(vulnerabilities.extId, cve.id)).get()
        if (!vuln) throw new Error('NVD vulnerability unavailable')
        const rawJson = JSON.stringify(cve)
        tx.insert(sourceRecords).values({ feedId: feed.id, sourceId: cve.id, rawJson })
          .onConflictDoUpdate({ target: [sourceRecords.feedId, sourceRecords.sourceId], set: { rawJson } }).run()
        const saved = tx.select().from(sourceRecords)
          .where(and(eq(sourceRecords.feedId, feed.id), eq(sourceRecords.sourceId, cve.id))).get()
        if (!saved) throw new Error('NVD source record unavailable')
        tx.insert(vulnerabilitySources).values({ vulnerabilityId: vuln.id, sourceRecordId: saved.id }).onConflictDoNothing().run()
      }
      checkAbort(signal)
      if (state !== undefined) tx.update(feeds).set({ syncState: JSON.stringify(state) }).where(eq(feeds.id, feed.id)).run()
      return { processed: records.length }
    })
  }
}
