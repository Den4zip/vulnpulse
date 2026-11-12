import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDb, type Db } from '@main/db'
import { feeds, sourceRecords, vulnerabilities, vulnerabilitySources } from '@main/db/schema'
import { DashboardService } from '@main/services/dashboard'
import { VulnerabilityService } from '@main/services/vulnerabilities'
import { ServiceError } from '@main/services/errors'
import type { FeedSyncStatus, SyncView } from '@shared/api'
import { Severity, VulnStatus } from '@shared/enums'

let db: Db
let service: DashboardService
let status: SyncView
let nvd: number
let cisa: number
beforeEach(() => {
  db = initDb(':memory:')
  nvd = db.insert(feeds).values({ name: 'nvd', source: 'private:provider-url' }).returning().get()!.id
  cisa = db.insert(feeds).values({ name: 'cisa', source: 'test' }).returning().get()!.id
  status = { feeds: ['nvd', 'cisa', 'fstec'].map(name => ({ name, running: false, enabled: false,
    lastStartedAt: null, lastFinishedAt: null, lastError: null })) as FeedSyncStatus[],
    active: null, lastImport: null, lastSync: null, settingsBusy: false, osvMode: 'local-json', matchingRecomputed: false }
  service = new DashboardService(db, () => status)
})
afterEach(() => db.$client.close())
const insert = (extId: string, fields: Partial<typeof vulnerabilities.$inferInsert> = {}) => db.insert(vulnerabilities)
  .values({ extId, feedId: nvd, ...fields }).returning().get()!.id

describe('Dashboard on real SQLite', () => {
  it('distinguishes a successfully read empty catalog from missing source history', () => {
    const value = service.get()
    expect(value).toMatchObject({ total: 0, knownExploited: 0, newCount: 0, criticalCount: 0 })
    expect(value.evaluatedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(value.severity).toEqual([...Object.values(Severity), null].map(severity => ({ severity, count: 0, knownExploited: 0 })))
    expect(value.statuses).toEqual(Object.values(VulnStatus).map(status => ({ status, count: 0 })))
    expect(value.feeds).toEqual(['nvd', 'cisa', 'osv', 'fstec'].map(name => ({ name, recordCount: 0,
      mode: name === 'osv' ? 'local' : 'manual', runState: name === 'osv' ? 'untracked' : 'never', lastStartedAt: null, lastFinishedAt: null })))
  })

  it('counts canonical cards once despite multiple source links, aliases and legacy rows', () => {
    const id = insert('CVE-2026-1234', { severity: Severity.Critical, isKnownExploited: true })
    const other = insert('CVE-2026-1235', { severity: Severity.None, cvssScore: 0, status: VulnStatus.Patched })
    insert('OSV-LOCAL', { severity: null, isKnownExploited: true }) // legacy card without source links
    const one = db.insert(sourceRecords).values({ feedId: nvd, sourceId: 'one', rawJson: 'private:raw' }).returning().get()!
    const two = db.insert(sourceRecords).values({ feedId: cisa, sourceId: 'two' }).returning().get()!
    db.insert(vulnerabilitySources).values([{ vulnerabilityId: id, sourceRecordId: one.id },
      { vulnerabilityId: id, sourceRecordId: two.id }, { vulnerabilityId: other, sourceRecordId: one.id }]).run()
    const before = db.$client.prepare('SELECT total_changes() AS changes').get()!.changes
    const value = service.get()
    expect(value).toMatchObject({ total: 3, knownExploited: 2, newCount: 2, criticalCount: 1 })
    expect(value.severity.find(row => row.severity === Severity.None)).toEqual({ severity: Severity.None, count: 1, knownExploited: 0 })
    expect(value.severity.find(row => row.severity === null)).toEqual({ severity: null, count: 1, knownExploited: 1 })
    expect(value.feeds.map(row => row.recordCount)).toEqual([1, 1, 0, 0])
    expect(JSON.stringify(value)).not.toMatch(/private|rawJson|sourceId|feedId|syncState|etag/)
    expect(db.$client.prepare('SELECT total_changes() AS changes').get()!.changes).toBe(before)
  })

  it('uses exactly the catalog filters for each severity, KEV and status drill-down', () => {
    let id = 0
    for (const severity of [...Object.values(Severity), null]) {
      for (const status of Object.values(VulnStatus)) {
        insert(`LOCAL-${id++}`, { severity, status, isKnownExploited: true })
        insert(`LOCAL-${id++}`, { severity, status, isKnownExploited: false })
      }
    }
    const value = service.get()
    const catalog = new VulnerabilityService(db)
    expect(value.total).toBe(72)
    expect(value.knownExploited).toBe(catalog.list({ knownExploited: true }).total)
    expect(value.criticalCount).toBe(catalog.list({ severity: Severity.Critical }).total)
    expect(value.newCount).toBe(catalog.list({ status: VulnStatus.New }).total)
    for (const row of value.severity) {
      expect(row.count).toBe(catalog.list({ severity: row.severity }).total)
      expect(row.knownExploited).toBe(catalog.list({ severity: row.severity, knownExploited: true }).total)
    }
    for (const row of value.statuses) expect(row.count).toBe(catalog.list({ status: row.status }).total)
    const first = catalog.list().items[0]
    catalog.setStatus({ id: first.id, status: VulnStatus.Patched })
    expect(service.get().statuses.find(row => row.status === VulnStatus.Patched)!.count).toBe(catalog.list({ status: VulnStatus.Patched }).total)
  })

  it.each([null, {}, [], 1, 'sql', { feed: 'nvd' }])('rejects unsupported input %j', input => {
    expect(() => service.get(input)).toThrow(ServiceError)
    try { service.get(input) } catch (error) { expect((error as ServiceError).code).toBe('INVALID_ARGUMENT') }
  })

  const start = '2026-11-08T09:00:00.000Z'
  const finish = '2026-11-08T09:01:00.000Z'
  it.each([
    [{ running: true, lastError: 'failed' }, 'running'],
    [{ lastStartedAt: start, lastFinishedAt: finish }, 'completed'],
    [{ lastStartedAt: start, lastFinishedAt: finish, lastError: 'failed' }, 'failed'],
    [{ lastStartedAt: start, lastFinishedAt: finish, lastError: 'cancelled' }, 'cancelled'],
    [{ lastStartedAt: start, lastError: 'interrupted' }, 'interrupted'],
    [{ lastStartedAt: start }, 'unknown'],
    [{ lastFinishedAt: finish }, 'unknown'],
    [{ lastStartedAt: finish, lastFinishedAt: start }, 'unknown']
  ] as const)('does not confuse a finished attempt %j with successful synchronization', (patch, expected) => {
    Object.assign(status.feeds[0], patch)
    expect(service.get().feeds[0].runState).toBe(expected)
  })

  it('handles absent scheduler status and retains OSV local-only mode', () => {
    status.feeds = []
    expect(service.get().feeds[0].runState).toBe('unknown')
    expect(service.get().feeds[2]).toMatchObject({ name: 'osv', mode: 'local', runState: 'untracked' })
    status.feeds = [{ name: 'nvd', running: false, enabled: true, lastStartedAt: null, lastFinishedAt: null, lastError: null }]
    expect(service.get().feeds[0].mode).toBe('scheduled')
  })
})
