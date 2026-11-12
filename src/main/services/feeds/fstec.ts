import { and, eq } from 'drizzle-orm'
import type { Db } from '@main/db'
import { feeds, sourceRecords, vulnerabilities, vulnerabilitySources } from '@main/db/schema'
import { HttpClient } from '@main/services/httpclient'
import type { FeedAdapter, FeedFetchContext, FeedFetchResult, FeedUpsertResult } from './base'
import { withFstecStage, type FstecWorkerOptions } from './fstec-stage'
import { checkedFstecRecord, fstecAbort, fstecObject, FSTEC_MAX_COMPRESSED, FSTEC_MIRROR_URL,
  type FstecInput, type FstecRecord } from './fstec-data'

const sharedHttp = new HttpClient({ maxResponseBytes: FSTEC_MAX_COMPRESSED, attemptTimeoutMs: 60000, timeoutMs: 180000 })
const running = new WeakSet<object>()

/** Explicit mirror sync or manual file; never reads or transmits inventory. */
export class FstecAdapter implements FeedAdapter<FstecInput, FstecRecord, string> {
  readonly name = 'fstec' as const
  constructor(private readonly db: Db, private readonly options: FstecWorkerOptions, private readonly http = sharedHttp) {}

  async fetchIncremental(context: FeedFetchContext<string>): Promise<FeedFetchResult<FstecInput, string>> {
    fstecAbort(context.signal)
    const response = await this.http.request<Uint8Array>({ url: FSTEC_MIRROR_URL, responseType: 'arraybuffer',
      headers: context.cursor ? { 'If-None-Match': context.cursor } : undefined, signal: context.signal })
    fstecAbort(context.signal)
    if (response.status === 304) {
      if (!context.cursor) throw new Error('Unexpected FSTEC 304 without applied ETag')
      return { kind: 'not-modified' }
    }
    if (response.status !== 200 || !(response.data instanceof Uint8Array) || response.data.byteLength > FSTEC_MAX_COMPRESSED) {
      throw new Error('Invalid FSTEC mirror response')
    }
    const etag = response.headers.etag ?? null
    if (etag !== null && etag.length > 4096) throw new Error('Invalid FSTEC ETag')
    return { kind: 'data', raw: { kind: 'bytes', data: response.data, gzip: true }, nextCursor: etag }
  }

  /** Bounded convenience contract. Full imports use disk staging rather than an array. */
  async parse(input: FstecInput, signal?: AbortSignal): Promise<readonly FstecRecord[]> {
    return withFstecStage(input, 'manual', this.options, (stage, records) => {
      if (stage.count > 5000) throw new Error('Use importFile/syncMirror for FSTEC snapshots over 5000 records')
      return [...records]
    }, signal)
  }

  async upsert(records: readonly FstecRecord[], signal?: AbortSignal): Promise<FeedUpsertResult> {
    return this.apply(records, 'local:fstec-xml', null, signal)
  }

  async importFile(path: string, signal?: AbortSignal): Promise<FeedUpsertResult> {
    return this.lock(async () => withFstecStage({ kind: 'file', path, gzip: path.toLowerCase().endsWith('.gz') },
      'manual', this.options, (_stage, records) => this.apply(records, 'local:fstec-xml', null, signal), signal))
  }

  async syncMirror(signal?: AbortSignal): Promise<FeedUpsertResult & { kind: 'updated' | 'not-modified' }> {
    return this.lock(async () => {
      fstecAbort(signal)
      const feed = this.db.select().from(feeds).where(eq(feeds.name, 'fstec')).get()
      const fetched = await this.fetchIncremental({ cursor: feed?.etag ?? null, signal })
      if (fetched.kind === 'not-modified') return { kind: 'not-modified', processed: 0 }
      return withFstecStage(fetched.raw, 'mirror', this.options, (_stage, records) => {
        const result = this.apply(records, FSTEC_MIRROR_URL, fetched.nextCursor, signal)
        return { ...result, kind: 'updated' as const }
      }, signal)
    })
  }

  private async lock<T>(operation: () => Promise<T>): Promise<T> {
    if (running.has(this.db.$client)) throw new Error('FSTEC import already running')
    running.add(this.db.$client)
    try { return await operation() } finally { running.delete(this.db.$client) }
  }

  private apply(records: Iterable<FstecRecord>, origin: string, etag: string | null, signal?: AbortSignal): FeedUpsertResult {
    fstecAbort(signal)
    return this.db.transaction((tx) => {
      tx.insert(feeds).values({ name: 'fstec', source: origin }).onConflictDoNothing().run()
      const feed = tx.select().from(feeds).where(eq(feeds.name, 'fstec')).get()!
      let processed = 0
      let warnings = 0
      const seen = new Set<string>()
      for (const candidate of records) {
        fstecAbort(signal)
        const record = checkedFstecRecord(candidate)
        warnings += record.warnings.length
        if (seen.has(record.id)) throw new Error('Duplicate FSTEC identifier')
        seen.add(record.id)
        processed++
        const previous = tx.select().from(sourceRecords)
          .where(and(eq(sourceRecords.feedId, feed.id), eq(sourceRecords.sourceId, record.id))).get()
        if (previous?.rawJson) {
          let old: unknown
          try { old = JSON.parse(previous.rawJson) } catch { throw new Error('Invalid stored FSTEC source') }
          if (!fstecObject(old) || old.format !== 'fstec-xml-v1' || !fstecObject(old.fields) || old.fields.identifier !== record.id) {
            throw new Error('Invalid stored FSTEC source')
          }
          const oldModified = typeof old.modifiedAt === 'string' ? old.modifiedAt : null
          if (oldModified !== null && (record.modifiedAt === null || oldModified >= record.modifiedAt)) continue
          if (oldModified === null && record.modifiedAt === null) continue
        }
        // Keep normalized date next to original fields; no XML parsing in Main.
        const payload: unknown = JSON.parse(record.rawJson)
        if (!fstecObject(payload) || payload.format !== 'fstec-xml-v1' || !fstecObject(payload.fields)
          || payload.fields.identifier !== record.id) throw new Error('Invalid FSTEC source payload')
        const rawJson = JSON.stringify({ ...payload, modifiedAt: record.modifiedAt })
        tx.insert(sourceRecords).values({ feedId: feed.id, sourceId: record.id, rawJson })
          .onConflictDoUpdate({ target: [sourceRecords.feedId, sourceRecords.sourceId], set: { rawJson } }).run()
        const source = tx.select().from(sourceRecords)
          .where(and(eq(sourceRecords.feedId, feed.id), eq(sourceRecords.sourceId, record.id))).get()!
        tx.delete(vulnerabilitySources).where(eq(vulnerabilitySources.sourceRecordId, source.id)).run()
        const identifiers = record.cves.length ? [...new Set(record.cves)] : [record.id]
        for (const extId of identifiers) {
          tx.insert(vulnerabilities).values({ extId, feedId: feed.id, title: record.title, description: record.description,
            publishedAt: record.publishedAt, modifiedAt: record.modifiedAt }).onConflictDoNothing().run()
          const vuln = tx.select().from(vulnerabilities).where(eq(vulnerabilities.extId, extId)).get()!
          tx.insert(vulnerabilitySources).values({ vulnerabilityId: vuln.id, sourceRecordId: source.id }).run()
        }
      }
      if (!processed) throw new Error('Empty FSTEC import')
      fstecAbort(signal)
      tx.update(feeds).set({ etag, source: origin }).where(eq(feeds.id, feed.id)).run()
      return warnings ? { processed, warnings } : { processed }
    })
  }
}
