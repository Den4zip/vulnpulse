import { and, asc, eq, gt } from 'drizzle-orm'
import type { Db } from '@main/db'
import { feeds, sourceRecords, vulnerabilities, vulnerabilitySources } from '@main/db/schema'
import type { VulnerabilityForMatch } from '@main/services/matcher/engine'
import { parseOsvApplicability } from './osv-applicability'
import { osvObject } from './osv-data'

/** Page by source ID, then load its links. A source may prove several CVE aliases. */
export function loadOsvMatchPage(db: Db, options: { afterSourceId?: number; limit?: number } = {}): {
  vulnerabilities: VulnerabilityForMatch[]; nextAfterSourceId: number | null
} {
  const after = options.afterSourceId ?? 0
  const limit = options.limit ?? 100
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError('Invalid OSV catalog page')
  }
  const records = db.select({ id: sourceRecords.id, sourceId: sourceRecords.sourceId, rawJson: sourceRecords.rawJson })
    .from(sourceRecords).innerJoin(feeds, and(eq(feeds.id, sourceRecords.feedId), eq(feeds.name, 'osv')))
    .where(gt(sourceRecords.id, after)).orderBy(asc(sourceRecords.id)).limit(limit + 1).all()
  const selected = records.slice(0, limit)
  const result: VulnerabilityForMatch[] = []
  for (const source of selected) {
    let raw: unknown
    try { raw = JSON.parse(source.rawJson ?? 'null') } catch { raw = null }
    if (!osvObject(raw) || raw.id !== source.sourceId) raw = null
    const applicability = parseOsvApplicability(raw)
    const links = db.select({ id: vulnerabilities.id, extId: vulnerabilities.extId }).from(vulnerabilitySources)
      .innerJoin(vulnerabilities, eq(vulnerabilities.id, vulnerabilitySources.vulnerabilityId))
      .where(eq(vulnerabilitySources.sourceRecordId, source.id)).orderBy(asc(vulnerabilities.id)).all()
    for (const link of links) result.push({ ...link, cpes: [], packages: [], osvApplicability: applicability })
  }
  return { vulnerabilities: result, nextAfterSourceId: records.length > limit ? selected[selected.length - 1].id : null }
}
