import type { OperationInfo, SyncView } from '@shared/api'
import { ServiceError } from './errors'
import type { ImportService } from './imports'
import type { FeedScheduler } from './scheduler'
import { enumeration, invalid, object } from './validation'

/** Bounded orchestration DTOs only. Scheduler/importers retain ownership of their work. */
export class SyncService {
  private disposed = false
  constructor(private readonly scheduler: FeedScheduler, private readonly imports: ImportService,
    private readonly settingsBusy: () => boolean) {}

  status(input?: unknown): SyncView {
    if (input !== undefined) invalid()
    this.available()
    const lastSync = this.scheduler.lastOperation
    const lastImport = this.imports.lastOperation
    return { feeds: this.scheduler.status().map(row => ({ ...row,
      lastStartedAt: this.time(row.lastStartedAt), lastFinishedAt: this.time(row.lastFinishedAt),
      lastError: row.lastError === null ? null : row.lastError === 'cancelled' || row.lastError === 'interrupted' ? row.lastError : 'failed' })),
      active: this.scheduler.isRunning ? lastSync : this.imports.isBusy ? lastImport : null,
      lastSync, lastImport, settingsBusy: this.settingsBusy(), osvMode: 'local-json', matchingRecomputed: false }
  }

  start(input: unknown): OperationInfo {
    const feed = enumeration(object(input, ['feed']).feed, ['cisa', 'nvd', 'fstec'] as const)
    this.available()
    if (this.scheduler.isRunning || this.imports.isBusy || this.settingsBusy()) throw new ServiceError('BUSY')
    const task = this.scheduler.run(feed)
    // Scheduler takes its lock synchronously; no rejected background promises escape.
    void task.catch(() => {})
    if (!this.scheduler.isRunning) throw new ServiceError('UNAVAILABLE')
    return this.scheduler.lastOperation!
  }

  importFile(input: unknown): OperationInfo {
    const kind = enumeration(object(input, ['kind']).kind, ['osv', 'fstec', 'stack'] as const)
    this.available()
    if (this.scheduler.isRunning || this.settingsBusy()) throw new ServiceError('BUSY')
    return this.imports.start(kind)
  }

  cancel(input: unknown): OperationInfo {
    const id = object(input, ['operationId']).operationId
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)) invalid()
    const active = this.status().active
    if (!active || active.id !== id) throw new ServiceError('CONFLICT')
    if (active.kind === 'sync') this.scheduler.cancel()
    else this.imports.cancel()
    return (active.kind === 'sync' ? this.scheduler.lastOperation : this.imports.lastOperation)!
  }

  dispose(): void { this.disposed = true }
  private available(): void { if (this.disposed) throw new ServiceError('UNAVAILABLE') }
  private time(value: string | null): string | null {
    if (value === null || value.length > 32) return null
    const time = Date.parse(value)
    return Number.isFinite(time) ? new Date(time).toISOString() : null
  }
}
