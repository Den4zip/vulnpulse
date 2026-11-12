import { compare, valid } from 'semver'
import { toOsvPackageKey, type Purl } from './purl'
import type { OsvApplicability, OsvDecision, OsvReason } from './osv-types'

/** OSV SEMVER forbids leading v; do not coerce or use npm range prerelease exclusions. */
export function isOsvSemver(value: string): boolean {
  return value.length <= 256 && /^\d+\.\d+\.\d+/.test(value) && valid(value) !== null
}

export function osvPackageName(ecosystem: string, name: string): string | null {
  if (ecosystem === 'npm') return /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ? name.toLowerCase() : null
  if (ecosystem === 'PyPI') return /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i.test(name) ? name.toLowerCase().replace(/[-_.]+/g, '-') : null
  if (ecosystem === 'Maven') return /^[a-z0-9._-]+:[a-z0-9._-]+$/i.test(name) ? name : null
  return null
}

const unknown = (reason: OsvReason): OsvDecision => ({ status: 'unknown', reason })

export function evaluateOsv(applicability: OsvApplicability, inventory: Purl | null, separateVersion: string | null): OsvDecision {
  if (applicability.kind === 'unknown') return unknown(applicability.reason)
  if (applicability.withdrawn) return unknown('withdrawn')
  if (inventory === null) return unknown('missing_inventory')
  if (!['npm', 'pypi', 'maven'].includes(inventory.type)) return unknown('unsupported_package')
  if ((inventory.type === 'pypi' && inventory.namespace !== '') || inventory.name.includes('/')) return unknown('invalid_package')
  const key = toOsvPackageKey(inventory)
  if (osvPackageName(key.ecosystem, key.name) === null) return unknown('invalid_package')
  let uncertain: OsvReason | undefined
  for (const rule of applicability.affected) {
    if (rule.kind === 'unknown') { uncertain = rule.reason; continue }
    if (rule.ecosystem !== key.ecosystem || rule.name !== key.name) continue
    if (Object.keys(inventory.qualifiers).length || inventory.subpath !== null || inventory.raw.includes('?')) return unknown('unsupported_package')
    const version = inventory.version ?? separateVersion
    if (!version || version.length > 256 || version.trim() !== version || version === '*' || version === '-') return unknown('ambiguous_version')
    if (inventory.version !== null && separateVersion !== null && inventory.version !== separateVersion) return unknown('ambiguous_version')
    const evidence = { advisoryId: applicability.advisoryId, packageName: key.name, evaluatedVersion: version }
    if (rule.versions.includes(version)) return { status: 'match', reason: 'affected_version', ...evidence }
    const semver = rule.ecosystem === 'npm' && isOsvSemver(version)
    if (rule.versions.length) {
      if (semver && rule.versions.every(isOsvSemver)) {
        if (rule.versions.some((affected) => compare(affected, version) === 0)) return { status: 'match', reason: 'affected_version', ...evidence }
      } else uncertain = 'unsupported_version'
    }
    for (const [rangeIndex, range] of rule.ranges.entries()) {
      if (range.kind === 'unknown') { uncertain = range.reason; continue }
      if (!semver) { uncertain = 'unsupported_version'; continue }
      for (const interval of range.intervals) {
        const lower = interval.introduced === null || compare(version, interval.introduced) >= 0
        const upper = interval.end === undefined ? true : interval.inclusive
          ? compare(version, interval.end) <= 0 : compare(version, interval.end) < 0
        if (lower && upper) return { status: 'match', reason: 'affected_range', ...evidence, rangeIndex }
      }
    }
    if (!rule.versions.length && !rule.ranges.length) uncertain = 'missing_conditions'
  }
  if (!applicability.affected.length) return unknown('missing_conditions')
  return uncertain ? unknown(uncertain) : { status: 'no_match', reason: 'not_affected' }
}
