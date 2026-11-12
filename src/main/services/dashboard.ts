import { count, eq } from 'drizzle-orm'
import type { Db } from '@main/db'
import { feeds, sourceRecords, vulnerabilities } from '@main/db/schema'
import type { DashboardFeed, DashboardView, FeedSyncStatus, SyncView } from '@shared/api'
import { Severity, VulnStatus, type FeedName } from '@shared/enums'
import { invalid } from './validation'

const feedOrder: FeedName[] = ['nvd', 'cisa', 'osv', 'fstec']
const severityOrder = [Severity.Critical, Severity.High, Severity.Medium, Severity.Low, Severity.None, null]

function runState(row: FeedSyncStatus | undefined): DashboardFeed['runState'] {
  if (!row) return 'unknown'
  if (row.running) return 'running'
  if (row.lastError) return row.lastError
  if (!row.lastStartedAt && !row.lastFinishedAt) return 'never'
  if (row.lastStartedAt && row.lastFinishedAt && Date.parse(row.lastFinishedAt) >= Date.parse(row.lastStartedAt)) return 'completed'
  return 'unknown'
}

/** One synchronous read transaction; never joins source links into vulnerability counts. */
export class DashboardService {
  constructor(private readonly db: Db, private readonly syncStatus: () => SyncView) {}

  get(input?: unknown): DashboardView {
    if (input !== undefined) invalid()
    return this.db.transaction(tx => {
      const sync = this.syncStatus()
      const groups = tx.select({ severity: vulnerabilities.severity, status: vulnerabilities.status,
        kev: vulnerabilities.isKnownExploited, count: count() }).from(vulnerabilities)
        .groupBy(vulnerabilities.severity, vulnerabilities.status, vulnerabilities.isKnownExploited).all()
      const records = tx.select({ name: feeds.name, count: count(sourceRecords.id) }).from(feeds)
        .leftJoin(sourceRecords, eq(sourceRecords.feedId, feeds.id)).groupBy(feeds.name).all()
      return {
        evaluatedAt: new Date().toISOString(),
        total: groups.reduce((sum, row) => sum + row.count, 0),
        knownExploited: groups.reduce((sum, row) => sum + (row.kev ? row.count : 0), 0),
        newCount: groups.reduce((sum, row) => sum + (row.status === VulnStatus.New ? row.count : 0), 0),
        criticalCount: groups.reduce((sum, row) => sum + (row.severity === Severity.Critical ? row.count : 0), 0),
        severity: severityOrder.map(severity => ({ severity,
          count: groups.reduce((sum, row) => sum + (row.severity === severity ? row.count : 0), 0),
          knownExploited: groups.reduce((sum, row) => sum + (row.severity === severity && row.kev ? row.count : 0), 0) })),
        statuses: Object.values(VulnStatus).map(status => ({ status,
          count: groups.reduce((sum, row) => sum + (row.status === status ? row.count : 0), 0) })),
        feeds: feedOrder.map(name => {
          const row = sync.feeds.find(feed => feed.name === name)
          return { name, recordCount: records.find(record => record.name === name)?.count ?? 0,
            mode: name === 'osv' ? 'local' : row?.enabled ? 'scheduled' : 'manual',
            runState: name === 'osv' ? 'untracked' : runState(row),
            lastStartedAt: row?.lastStartedAt ?? null, lastFinishedAt: row?.lastFinishedAt ?? null }
        })
      }
    })
  }
}
