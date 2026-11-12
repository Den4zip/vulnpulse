import type { CpeParts } from './cpe'
import type { CompareResult } from './version'
import type { ApplicabilityDecision, NvdApplicability } from './nvd-types'

/** Deliberately limited numeric ordering, not a universal system version scheme.
 * BigInt avoids rounding; separators follow the existing numeric normalizer.
 * Exact text equality can establish a boundary without guessing suffix ordering.
 */
export function compareNvdVersions(a: string, b: string): CompareResult | null {
  if (!a.length || !b.length || a.length > 1024 || b.length > 1024) return null
  if (a === b) return 0
  if (!/^\d+(?:[._,]\d+)*$/.test(a) || !/^\d+(?:[._,]\d+)*$/.test(b)) return null
  const left = a.split(/[._,]/).map((p) => BigInt(p))
  const right = b.split(/[._,]/).map((p) => BigInt(p))
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0n
    const y = right[i] ?? 0n
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

const ATTRIBUTES = ['part', 'vendor', 'product', 'update', 'edition', 'language',
  'swEdition', 'targetSw', 'targetHw', 'other'] as const
const unknown = (reason: ApplicabilityDecision['reason']): ApplicabilityDecision => ({ status: 'unknown', reason })
const miss = (): ApplicabilityDecision => ({ status: 'no_match', reason: 'criteria_not_matched' })

/** Evaluate only supported, positive OR statements against one component.
 * No environment inference across unrelated entries in the company stack.
 */
export function evaluateNvd(
  rule: NvdApplicability, inventory: CpeParts | null, inventoryVersion: string | null
): ApplicabilityDecision {
  if (rule.kind === 'unknown') return unknown(rule.reason)
  if (rule.kind === 'or') {
    let uncertain: ApplicabilityDecision | undefined
    for (const child of rule.children) {
      const result = evaluateNvd(child, inventory, inventoryVersion)
      if (result.status === 'match') return result
      if (result.status === 'unknown') uncertain = result
    }
    // An empty statement cannot establish absence of applicability.
    return uncertain ?? (rule.children.length ? miss() : unknown('missing_configuration'))
  }
  if (inventory === null) return unknown('missing_inventory')
  let uncertainAttribute = false
  for (const key of ATTRIBUTES) {
    const expected = rule.cpe[key].toLowerCase()
    const actual = inventory[key].toLowerCase()
    if ((actual.includes('*') && actual !== '*') || actual.includes('?') || actual.includes('\\')) {
      uncertainAttribute = true
    } else if (expected !== '*') {
      if (actual === '*') uncertainAttribute = true
      else if (actual !== expected) return miss()
    }
  }
  if (uncertainAttribute) return unknown('unsupported_cpe')
  let version = inventory.version
  if (inventoryVersion !== null) {
    if (version === '*') version = inventoryVersion
    else if (version.toLowerCase() !== inventoryVersion.toLowerCase()) return unknown('ambiguous_version')
  }
  if (!version.length || version.trim() !== version || version.includes('*') || version.includes('?')
    || version.includes('\\') || version.length > 1024) return unknown('ambiguous_version')
  if (rule.cpe.version !== '*' && rule.cpe.version.toLowerCase() !== version.toLowerCase()) return miss()
  if (version === '-' && rule.cpe.version !== '-') return unknown('ambiguous_version')
  if (rule.start && rule.end) {
    const order = compareNvdVersions(rule.start.value, rule.end.value)
    if (order !== null && (order > 0 || (order === 0 && (!rule.start.inclusive || !rule.end.inclusive)))) {
      return unknown('invalid_range')
    }
  }
  let unsupported = false
  for (const [bound, direction] of [[rule.start, 1], [rule.end, -1]] as const) {
    if (!bound) continue
    const comparison = compareNvdVersions(version, bound.value)
    if (comparison === null) unsupported = true
    else if (comparison === -direction || (comparison === 0 && !bound.inclusive)) return miss()
  }
  if (unsupported) return unknown('unsupported_version')
  return { status: 'match', reason: 'criteria_matched', criteria: rule.criteria,
    matchCriteriaId: rule.matchCriteriaId, evaluatedVersion: version }
}
