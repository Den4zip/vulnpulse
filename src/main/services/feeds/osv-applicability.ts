import { compare } from 'semver'
import { parsePurl, toOsvPackageKey } from '@main/services/matcher/purl'
import { isOsvSemver, osvPackageName } from '@main/services/matcher/osv'
import type { OsvApplicability, OsvInterval, OsvPackageRule, OsvRange } from '@main/services/matcher/osv-types'
import { osvObject, osvRecord } from './osv-data'

function semverRange(raw: unknown): OsvRange {
  const invalid: OsvRange = { kind: 'unknown', reason: 'invalid_range' }
  if (!osvObject(raw) || !Array.isArray(raw.events) || !raw.events.length || raw.events.length > 256) return invalid
  if (raw.type !== 'SEMVER' || raw.events.some((e) => osvObject(e) && e.limit !== undefined)) {
    return { kind: 'unknown', reason: 'unsupported_range' }
  }
  const events: Array<{ key: string; value: string }> = []
  for (const event of raw.events) {
    if (!osvObject(event) || Object.keys(event).length !== 1) return invalid
    const key = Object.keys(event)[0]
    const value = event[key]
    if (!['introduced', 'fixed', 'last_affected'].includes(key) || typeof value !== 'string'
      || !(key === 'introduced' && value === '0') && !isOsvSemver(value)) return invalid
    events.push({ key, value })
  }
  if (events.some((e) => e.key === 'fixed') && events.some((e) => e.key === 'last_affected')) return invalid
  events.sort((a, b) => {
    const order = a.value === b.value ? 0 : a.value === '0' ? -1 : b.value === '0' ? 1 : compare(a.value, b.value)
    return order || Number(a.key === 'introduced') - Number(b.key === 'introduced')
  })
  const intervals: OsvInterval[] = []
  let open: string | null | undefined
  for (const event of events) {
    if (event.key === 'introduced') {
      if (open !== undefined) return invalid
      const previous = intervals[intervals.length - 1]
      if (previous?.end !== undefined && previous.inclusive && compare(event.value, previous.end) === 0) return invalid
      open = event.value === '0' ? null : event.value
    } else {
      if (open === undefined) return invalid
      intervals.push({ introduced: open, end: event.value, inclusive: event.key === 'last_affected' })
      open = undefined
    }
  }
  if (open !== undefined) intervals.push({ introduced: open, inclusive: false })
  return intervals.length ? { kind: 'semver', intervals } : invalid
}

/** Raw source retained independently; unknown conditions cannot silently become unaffected. */
export function parseOsvApplicability(raw: unknown): OsvApplicability {
  try { osvRecord(raw) } catch { return { kind: 'unknown', reason: 'invalid_source' } }
  const record = raw as Record<string, unknown>
  let budget = 8192
  const affected: OsvPackageRule[] = []
  for (const entry of (record.affected ?? []) as unknown[]) {
    if (!osvObject(entry) || !osvObject(entry.package) || typeof entry.package.ecosystem !== 'string'
      || typeof entry.package.name !== 'string' || entry.package.name.length > 1024) {
      affected.push({ kind: 'unknown', reason: 'invalid_package' }); continue
    }
    const { ecosystem, name, purl } = entry.package
    const canonical = osvPackageName(ecosystem, name)
    if (canonical === null) { affected.push({ kind: 'unknown', reason: 'unsupported_package' }); continue }
    if (purl !== undefined) {
      try {
        if (typeof purl !== 'string' || purl.length > 2048 || purl.includes('?') || purl.includes('#')) throw new Error()
        const parsed = parsePurl(purl)
        const key = toOsvPackageKey(parsed)
        if ((parsed.type === 'pypi' && parsed.namespace !== '') || parsed.name.includes('/')
          || key.ecosystem !== ecosystem || key.name !== canonical || parsed.version !== null
          || parsed.subpath !== null || Object.keys(parsed.qualifiers).length) throw new Error()
      } catch { affected.push({ kind: 'unknown', reason: 'invalid_package' }); continue }
    }
    const versions = entry.versions ?? []
    const ranges = entry.ranges ?? []
    if (!Array.isArray(versions) || !Array.isArray(ranges) || versions.length + ranges.length > budget
      || versions.some((v) => typeof v !== 'string' || !v.length || v.length > 256)) {
      affected.push({ kind: 'unknown', reason: 'missing_conditions' }); continue
    }
    const eventCount = ranges.reduce((sum, r) => sum + (osvObject(r) && Array.isArray(r.events) ? r.events.length : 0), 0)
    if (eventCount > budget - versions.length - ranges.length) {
      affected.push({ kind: 'unknown', reason: 'missing_conditions' }); continue
    }
    budget -= versions.length + ranges.length + eventCount
    affected.push({ kind: 'package', ecosystem, name: canonical, versions,
      ranges: ranges.map((r) => ecosystem === 'npm' ? semverRange(r) : { kind: 'unknown', reason: 'unsupported_range' }) })
  }
  return { kind: 'advisory', advisoryId: record.id as string, withdrawn: record.withdrawn !== undefined, affected }
}
