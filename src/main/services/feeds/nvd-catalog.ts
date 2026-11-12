import { and, asc, eq, gt } from 'drizzle-orm'
import type { Db } from '@main/db'
import { feeds, sourceRecords, vulnerabilities, vulnerabilitySources } from '@main/db/schema'
import type { VulnerabilityForMatch } from '@main/services/matcher/engine'
import { object } from './nvd-data'
import { parseNvdApplicability } from './nvd-applicability'

/** Keyset page for the future Main matcher job. Never sends raw payload to Renderer.
 * Parse stored source data on read so older imports use the current parser too.
 */
export function loadNvdMatchPage(
  db: Db, options: { readonly afterId?: number; readonly limit?: number } = {}
): { vulnerabilities: VulnerabilityForMatch[]; nextAfterId: number | null } {
  const afterId = options.afterId ?? 0
  const limit = options.limit ?? 100
  if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError('Invalid NVD catalog page')
  }
  const rows = db.select({ id: vulnerabilities.id, extId: vulnerabilities.extId, rawJson: sourceRecords.rawJson })
    .from(vulnerabilities)
    .innerJoin(vulnerabilitySources, eq(vulnerabilitySources.vulnerabilityId, vulnerabilities.id))
    .innerJoin(sourceRecords, and(eq(sourceRecords.id, vulnerabilitySources.sourceRecordId), eq(sourceRecords.sourceId, vulnerabilities.extId)))
    .innerJoin(feeds, and(eq(feeds.id, sourceRecords.feedId), eq(feeds.name, 'nvd')))
    .where(gt(vulnerabilities.id, afterId)).orderBy(asc(vulnerabilities.id)).limit(limit + 1).all()
  const items = rows.slice(0, limit)
  return {
    vulnerabilities: items.map((row) => {
      let payload: unknown
      try { payload = JSON.parse(row.rawJson ?? 'null') } catch { payload = null }
      if (!object(payload) || payload.id !== row.extId) payload = null
      return { id: row.id, extId: row.extId, cpes: [], packages: [], nvdApplicability: parseNvdApplicability(payload) }
    }),
    nextAfterId: rows.length > limit ? items[items.length - 1].id : null
  }
}
