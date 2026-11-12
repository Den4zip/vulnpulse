import { createTask, type ScheduledTask } from 'node-cron'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Db } from '@main/db'
import { feeds } from '@main/db/schema'
import type { FeedName } from '@shared/enums'
import type { OperationInfo } from '@shared/api'

export type ScheduledFeed = Exclude<FeedName, 'osv'>
export interface SyncResult { processed: number; kind?: 'updated' | 'not-modified'; warnings?: number }
export interface FeedJob {
  name: ScheduledFeed
  source: string
  intervalMs: number
  sync: (signal: AbortSignal) => Promise<SyncResult>
}
export type RunResult = { kind: 'completed'; result: SyncResult }
  | { kind: 'busy' | 'disposed' | 'failed' | 'cancelled' }

const RETRY_MS = 5 * 60_000
const owners = new WeakSet<object>()

/** Main-only orchestration. Adapters alone own payloads, ETags and checkpoints. */
export class FeedScheduler {
  private readonly enabled = new Set<ScheduledFeed>()
  private readonly listeners = new Set<() => void>()
  private readonly intervals = new Map<ScheduledFeed, number>()
  private readonly timer: ScheduledTask
  private active: { name: ScheduledFeed; controller: AbortController; task: Promise<RunResult> } | null = null
  private disposed = false
  private started = false
  private closing: Promise<void> | null = null
  private operation: OperationInfo | null = null

  constructor(private readonly db: Db, private readonly jobs: readonly FeedJob[],
    private readonly externalBusy: () => boolean = () => false) {
    if (owners.has(db.$client)) throw new Error('Scheduler already owns this database')
    const names = new Set<string>()
    for (const job of jobs) {
      if (!['cisa', 'nvd', 'fstec'].includes(job.name) || names.has(job.name)
        || !Number.isSafeInteger(job.intervalMs) || job.intervalMs < 60_000) {
        throw new Error('Invalid scheduler job')
      }
      names.add(job.name)
      this.intervals.set(job.name, job.intervalMs)
    }
    this.timer = createTask('* * * * *', () => this.poll(), { timezone: 'UTC', noOverlap: true })
    owners.add(db.$client)
  }

  start(): void {
    if (this.disposed || this.started) return
    this.started = true
    void this.timer.start()
    void this.poll()
  }

  get isRunning(): boolean { return this.active !== null }
  get activeFeed(): ScheduledFeed | null { return this.active?.name ?? null }
  get lastOperation(): OperationInfo | null { return this.operation ? structuredClone(this.operation) : null }
  isEnabled(name: ScheduledFeed): boolean { return this.enabled.has(name) }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Standalone/session toggle; the application menu persists through SettingsService. */
  setEnabled(name: ScheduledFeed, enabled: boolean): void {
    this.job(name)
    if (this.disposed) return
    if (enabled) this.enabled.add(name)
    else {
      this.enabled.delete(name)
      if (this.active?.name === name) this.cancel()
    }
    this.changed()
    if (enabled && this.started) void this.poll()
  }

  configure(values: readonly { name: ScheduledFeed; enabled: boolean; intervalMs: number }[]): void {
    if (this.disposed) return
    const names = new Set<ScheduledFeed>()
    for (const value of values) {
      this.job(value.name)
      if (names.has(value.name) || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.intervalMs) || value.intervalMs < 60_000) {
        throw new Error('Invalid scheduler configuration')
      }
      names.add(value.name)
    }
    if (names.size !== this.jobs.length) throw new Error('Incomplete scheduler configuration')
    for (const value of values) {
      this.intervals.set(value.name, value.intervalMs)
      if (value.enabled) this.enabled.add(value.name)
      else {
        this.enabled.delete(value.name)
        if (this.active?.name === value.name) this.cancel()
      }
    }
    this.changed()
    if (this.started) void this.poll()
  }

  status() {
    return this.jobs.map((job) => {
      const row = this.db.select().from(feeds).where(eq(feeds.name, job.name)).get()
      const unfinished = !!row?.lastStartedAt && (!row.lastFinishedAt || row.lastStartedAt > row.lastFinishedAt)
      return { name: job.name, enabled: this.enabled.has(job.name), running: this.active?.name === job.name,
        lastStartedAt: row?.lastStartedAt ?? null, lastFinishedAt: row?.lastFinishedAt ?? null,
        lastError: unfinished && this.active?.name !== job.name ? 'interrupted' : row?.lastError ?? null }
    })
  }

  /** Manual commands use exactly the same lock and accounting as cron. */
  run(name: ScheduledFeed): Promise<RunResult> {
    const job = this.job(name)
    if (this.disposed) return Promise.resolve({ kind: 'disposed' })
    if (this.active || this.externalBusy()) return Promise.resolve({ kind: 'busy' })
    const controller = new AbortController()
    // Defer execution until the lock is visible, including to synchronous listeners.
    const operation: OperationInfo = { id: randomUUID(), kind: 'sync', target: name, phase: 'running',
      startedAt: new Date().toISOString(), finishedAt: null, cancelRequested: false, result: null }
    this.operation = operation
    const task = Promise.resolve().then(() => this.execute(job, controller.signal)).then(outcome => {
      operation.phase = outcome.kind === 'completed' ? 'completed' : outcome.kind === 'cancelled' ? 'cancelled' : 'failed'
      if (outcome.kind === 'completed') operation.result = { processed: outcome.result.processed,
        warnings: outcome.result.warnings ?? 0, unchanged: outcome.result.kind === 'not-modified' }
      return outcome
    }, error => { operation.phase = 'failed'; throw error }).finally(() => {
      operation.finishedAt = new Date().toISOString()
      this.active = null
      this.changed()
    })
    this.active = { name, controller, task }
    this.changed()
    return task
  }

  cancel(): void {
    if (this.active) {
      this.operation!.cancelRequested = true
      this.active.controller.abort()
      this.changed()
    }
  }

  /** One missed interval yields one catch-up run, never a backlog of requests. */
  async tick(): Promise<void> {
    for (const job of this.jobs) {
      if (this.disposed || this.active || this.externalBusy()) return
      if (!this.enabled.has(job.name)) continue
      const row = this.db.select().from(feeds).where(eq(feeds.name, job.name)).get()
      const finished = row?.lastFinishedAt ? Date.parse(row.lastFinishedAt) : NaN
      const unfinished = !!row?.lastStartedAt && (!row.lastFinishedAt || row.lastStartedAt > row.lastFinishedAt)
      const interval = this.intervals.get(job.name)!
      const delay = row?.lastError ? Math.max(RETRY_MS, interval) : interval
      if (unfinished || !Number.isFinite(finished) || Date.now() >= finished + delay) await this.run(job.name)
    }
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing
    this.disposed = true
    this.enabled.clear()
    this.cancel()
    this.closing = (async () => {
      try { await this.timer.destroy() } finally {
        try { await this.active?.task } finally {
          this.listeners.clear()
          owners.delete(this.db.$client)
        }
      }
    })()
    return this.closing
  }

  private job(name: ScheduledFeed): FeedJob {
    const job = this.jobs.find((item) => item.name === name)
    if (!job) throw new Error('Unknown scheduled feed')
    return job
  }

  private async execute(job: FeedJob, signal: AbortSignal): Promise<RunResult> {
    // Do not store error objects/messages: they may contain API keys or payloads.
    this.db.insert(feeds).values({ name: job.name, source: job.source }).onConflictDoNothing().run()
    this.db.update(feeds).set({ lastStartedAt: new Date().toISOString(), lastFinishedAt: null, lastError: null })
      .where(eq(feeds.name, job.name)).run()
    let outcome: RunResult
    try {
      signal.throwIfAborted()
      const result = await job.sync(signal)
      // A completed commit remains successful even if cancellation arrives just afterwards.
      outcome = { kind: 'completed', result }
    } catch {
      outcome = { kind: signal.aborted ? 'cancelled' : 'failed' }
    }
    this.db.update(feeds).set({ lastFinishedAt: new Date().toISOString(),
      lastError: outcome.kind === 'completed' ? null : outcome.kind }).where(eq(feeds.name, job.name)).run()
    return outcome
  }

  private async poll(): Promise<void> {
    try { await this.tick() } catch { console.error('Feed scheduler could not update run state') }
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try { listener() } catch { console.error('Feed scheduler observer failed') }
    }
  }
}
