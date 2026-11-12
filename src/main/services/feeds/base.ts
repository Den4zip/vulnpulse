import type { FeedName } from '@shared/enums'

/** State of a previously committed feed import. Its format belongs to the adapter. */
export interface FeedFetchContext<TCursor> {
  readonly cursor: TCursor | null
  readonly signal?: AbortSignal
}

/** Candidate state is only safe to persist after the complete batch was applied. */
export type FeedFetchResult<TRaw, TCursor> =
  | { readonly kind: 'data'; readonly raw: TRaw; readonly nextCursor: TCursor | null }
  | { readonly kind: 'not-modified' }

/** Source payload remains in Main and is not part of the public vulnerability DTO. */
export interface FeedSourceRecord<TPayload = unknown> {
  readonly sourceId: string
  readonly payload: TPayload
}

export interface FeedUpsertResult {
  readonly processed: number
  /** Non-fatal data-quality issues retained in source payloads. */
  readonly warnings?: number
}

/**
 * Feed-specific fetching and parsing, with persistence delegated to Main services.
 * Callers must not advance the cursor on fetch, parse, partial upsert, error or
 * cancellation. A not-modified response contains no new records or cursor.
 * Implementations must preserve user-managed data and other sources' records.
 * parse and upsert resolve only for complete success; failures and cancellation
 * reject instead of returning a partial result as a successful batch.
 * Network access must use the shared HttpClient; file imports may use local input.
 *
 * A cursor can represent an incremental page or a complete snapshot. Adapters
 * and the eventual synchronizer must define when a checkpoint represents a fully
 * applied unit; this contract does not implement transactions or scheduling.
 */
export interface FeedAdapter<TRaw, TRecord, TCursor> {
  readonly name: FeedName
  fetchIncremental(context: FeedFetchContext<TCursor>): Promise<FeedFetchResult<TRaw, TCursor>>
  parse(raw: TRaw, signal?: AbortSignal): Promise<readonly TRecord[]>
  upsert(records: readonly TRecord[], signal?: AbortSignal): Promise<FeedUpsertResult>
}
