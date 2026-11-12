import { createReadStream } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import type { Db } from '@main/db'
import { feeds, sourceRecords, vulnerabilities, vulnerabilitySources } from '@main/db/schema'
import type { FeedAdapter, FeedFetchContext, FeedFetchResult, FeedUpsertResult } from './base'
import { OSV_MAX_BYTES, osvAbort, osvRecord, osvRecords, osvTime, type OsvRecord } from './osv-data'

export const OSV_LOCAL_SOURCE = 'local:osv-json'

/** Explicitly local: no HTTP dependency, querybatch, inventory reads, or remote fallback. */
export class OsvAdapter implements FeedAdapter<unknown, OsvRecord, never> {
  readonly name = 'osv' as const
  constructor(private readonly db: Db) {}

  async fetchIncremental(context: FeedFetchContext<never>): Promise<FeedFetchResult<unknown, never>> {
    osvAbort(context.signal)
    throw new Error('OSV is in local-import mode; network fetch is disabled')
  }

  async parse(raw: unknown, signal?: AbortSignal): Promise<readonly OsvRecord[]> {
    return osvRecords(raw, signal)
  }

  async importJson(text: string, signal?: AbortSignal): Promise<FeedUpsertResult> {
    osvAbort(signal)
    if (Buffer.byteLength(text, 'utf8') > OSV_MAX_BYTES) throw new Error('OSV JSON exceeds 32 MiB')
    let raw: unknown
    try { raw = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { throw new Error('Invalid OSV JSON') }
    return this.upsert(await this.parse(raw, signal), signal)
  }

  async importFile(filePath: string, signal?: AbortSignal): Promise<FeedUpsertResult> {
    osvAbort(signal)
    const stream = createReadStream(filePath, { highWaterMark: 64 * 1024, signal })
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of stream) {
      osvAbort(signal)
      const buffer = chunk as Buffer
      bytes += buffer.length
      if (bytes > OSV_MAX_BYTES) throw new Error('OSV JSON exceeds 32 MiB')
      chunks.push(buffer)
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    return this.importJson(text, signal)
  }

  async upsert(input: readonly OsvRecord[], signal?: AbortSignal): Promise<FeedUpsertResult> {
    // Validate the entire candidate batch before opening a synchronous transaction.
    const records = osvRecords(input, signal)
    if (records.reduce((sum, record) => sum + Math.max(1, record.aliases?.length ?? 0), 0) > 10000) {
      throw new Error('OSV import exceeds alias link budget')
    }
    return this.db.transaction((tx) => {
      tx.insert(feeds).values({ name: 'osv', source: OSV_LOCAL_SOURCE }).onConflictDoNothing().run()
      const feed = tx.select().from(feeds).where(eq(feeds.name, 'osv')).get()!
      for (const record of records) {
        osvAbort(signal)
        const old = tx.select().from(sourceRecords)
          .where(and(eq(sourceRecords.feedId, feed.id), eq(sourceRecords.sourceId, record.id))).get()
        if (old?.rawJson) {
          let previous: OsvRecord
          try {
            previous = osvRecord(JSON.parse(old.rawJson))
            if (previous.id !== record.id) throw new Error()
          } catch { throw new Error('Invalid stored OSV record') }
          if (osvTime(previous.modified)! >= osvTime(record.modified)!) continue
        }
        const rawJson = JSON.stringify(record)
        tx.insert(sourceRecords).values({ feedId: feed.id, sourceId: record.id, rawJson })
          .onConflictDoUpdate({ target: [sourceRecords.feedId, sourceRecords.sourceId], set: { rawJson } }).run()
        const source = tx.select().from(sourceRecords)
          .where(and(eq(sourceRecords.feedId, feed.id), eq(sourceRecords.sourceId, record.id))).get()!
        // Only explicit CVE identity/aliases are canonicalized. Never related or upstream.
        const cves = [record.id, ...(record.aliases ?? [])].filter((id) => /^CVE-\d{4}-\d{4,19}$/.test(id))
        const identities = [...new Set(cves.length ? cves : [record.id])]
        tx.delete(vulnerabilitySources).where(eq(vulnerabilitySources.sourceRecordId, source.id)).run()
        for (const extId of identities) {
          tx.insert(vulnerabilities).values({ extId, feedId: feed.id, title: record.summary,
            description: record.details, publishedAt: record.published, modifiedAt: record.modified }).onConflictDoNothing().run()
          const vulnerability = tx.select().from(vulnerabilities).where(eq(vulnerabilities.extId, extId)).get()!
          tx.insert(vulnerabilitySources).values({ vulnerabilityId: vulnerability.id, sourceRecordId: source.id }).run()
        }
      }
      osvAbort(signal)
      return { processed: records.length }
    })
  }
}
