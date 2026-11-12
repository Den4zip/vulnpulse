import { randomUUID } from 'node:crypto'
import type { ImportKind, OperationInfo } from '@shared/api'
import type { FeedUpsertResult } from './feeds/base'
import type { StackImportResult } from './stack/config'
import { ServiceError } from './errors'

export type FileImporter = (path: string, signal: AbortSignal) => Promise<FeedUpsertResult | StackImportResult>
export type FilePicker = (kind: ImportKind) => Promise<string | null>

/** Owns the lock from file selection until the importer has stopped. No path crosses IPC. */
export class ImportService {
  private active: { controller: AbortController; task: Promise<OperationInfo> } | null = null
  private last: OperationInfo | null = null
  private disposed = false
  private readonly listeners = new Set<() => void>()

  constructor(private readonly pick: FilePicker, private readonly importers: Partial<Record<ImportKind, FileImporter>>,
    private readonly externalBusy: () => boolean = () => false) {}

  get isBusy(): boolean { return this.active !== null }
  get lastOperation(): OperationInfo | null { return this.last ? structuredClone(this.last) : null }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  start(kind: ImportKind): OperationInfo {
    if (this.disposed || !this.importers[kind]) throw new ServiceError('UNAVAILABLE')
    if (this.isBusy || this.externalBusy()) throw new ServiceError('BUSY')
    const controller = new AbortController()
    const operation: OperationInfo = { id: randomUUID(), kind: 'import', target: kind, phase: 'selecting',
      startedAt: new Date().toISOString(), finishedAt: null, cancelRequested: false, result: null }
    this.last = operation
    const task = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted()
        const path = await this.pick(kind)
        controller.signal.throwIfAborted()
        if (!path) { operation.phase = 'cancelled'; return }
        operation.phase = 'running'
        this.changed()
        const result = await this.importers[kind]!(path, controller.signal)
        // A committed import wins over a cancellation arriving after its commit.
        operation.result = 'processed' in result ? { processed: result.processed, warnings: result.warnings ?? 0, unchanged: false }
          : { added: result.added, skipped: result.skipped, total: result.total }
        operation.phase = 'completed'
      } catch {
        operation.phase = controller.signal.aborted ? 'cancelled' : 'failed'
      } finally {
        operation.finishedAt = new Date().toISOString()
        this.active = null
        this.changed()
      }
    }).then(() => structuredClone(operation))
    this.active = { controller, task }
    this.changed()
    return structuredClone(operation)
  }

  /** Main-only await for native menu notifications; IPC starts return immediately. */
  wait(): Promise<OperationInfo> {
    if (!this.active) throw new ServiceError('CONFLICT')
    return this.active.task
  }

  cancel(): void {
    if (!this.active) return
    this.last!.cancelRequested = true
    this.active.controller.abort()
    this.changed()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.cancel()
    await this.active?.task
    this.listeners.clear()
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try { listener() } catch { console.error('Import observer failed') }
    }
  }
}
