import { parseCpe23 } from '@main/services/matcher/cpe'
import type { NvdApplicability, VersionBound } from '@main/services/matcher/nvd-types'
import { object } from './nvd-data'

const MAX_ITEMS = 4096
const MAX_TEXT = 1024
const BOUNDS = ['versionStartIncluding', 'versionStartExcluding', 'versionEndIncluding', 'versionEndExcluding'] as const
const unknown = (reason: Extract<NvdApplicability, { kind: 'unknown' }>['reason']): NvdApplicability => ({ kind: 'unknown', reason })

/** Parse the current two-level NVD schema; future/unsupported conditions stay unknown.
 * Bounded work and no recursion into untrusted payload trees.
 */
export function parseNvdApplicability(payload: unknown): NvdApplicability {
  if (!object(payload)) return unknown('invalid_source')
  if (payload.vulnStatus === 'Rejected') return unknown('rejected_record')
  const configurations = payload.configurations
  if (configurations === undefined || (Array.isArray(configurations) && configurations.length === 0)) {
    return unknown('missing_configuration')
  }
  let remaining = MAX_ITEMS
  const list = (value: unknown, parse: (item: unknown) => NvdApplicability): NvdApplicability => {
    if (!Array.isArray(value) || !value.length || value.length > remaining) return unknown('invalid_configuration')
    remaining -= value.length
    return { kind: 'or', children: value.map(parse) }
  }
  const bound = (item: Record<string, unknown>, prefix: 'Start' | 'End'): VersionBound | undefined => {
    const included = item[`version${prefix}Including`]
    const excluded = item[`version${prefix}Excluding`]
    const value = included ?? excluded
    return value === undefined ? undefined : { value: value as string, inclusive: included !== undefined }
  }
  const leaf = (item: unknown): NvdApplicability => {
    if (!object(item) || typeof item.vulnerable !== 'boolean' || typeof item.criteria !== 'string'
      || item.criteria.length > MAX_TEXT || typeof item.matchCriteriaId !== 'string'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item.matchCriteriaId)
      || Object.keys(item).some((key) => !['vulnerable', 'criteria', 'matchCriteriaId', ...BOUNDS].includes(key))) {
      return unknown('invalid_configuration')
    }
    if (!item.vulnerable) return unknown('unsupported_logic')
    if (BOUNDS.some((key) => item[key] !== undefined && (typeof item[key] !== 'string'
      || !(item[key] as string).length || (item[key] as string).trim() !== item[key] || (item[key] as string).length > MAX_TEXT
      || ['*', '-'].includes(item[key] as string)))
      || (item.versionStartIncluding !== undefined && item.versionStartExcluding !== undefined)
      || (item.versionEndIncluding !== undefined && item.versionEndExcluding !== undefined)) return unknown('invalid_range')
    // The legacy CPE parser does not preserve all escape/wildcard semantics.
    if (item.criteria.includes('\\')) return unknown('unsupported_cpe')
    try {
      const cpe = parseCpe23(item.criteria)
      if (Object.values(cpe).some((v) => v !== '*' && !/^[a-z0-9._-]+$/i.test(v))) {
        return unknown('unsupported_cpe')
      }
      return { kind: 'cpe', cpe, criteria: item.criteria, matchCriteriaId: item.matchCriteriaId,
        start: bound(item, 'Start'), end: bound(item, 'End') }
    } catch { return unknown('unsupported_cpe') }
  }
  const node = (item: unknown): NvdApplicability => {
    if (!object(item) || (item.negate !== undefined && typeof item.negate !== 'boolean')
      || Object.keys(item).some((key) => !['operator', 'negate', 'cpeMatch'].includes(key))) return unknown('invalid_configuration')
    if (item.negate === true || item.operator === 'AND') return unknown('unsupported_logic')
    if (item.operator !== 'OR') return unknown('invalid_configuration')
    return list(item.cpeMatch, leaf)
  }
  return list(configurations, (item) => {
    if (!object(item) || (item.negate !== undefined && typeof item.negate !== 'boolean')
      || Object.keys(item).some((key) => !['operator', 'negate', 'nodes'].includes(key))) return unknown('invalid_configuration')
    if (item.negate === true || item.operator === 'AND') return unknown('unsupported_logic')
    if (item.operator !== 'OR' && !(item.operator === undefined && Array.isArray(item.nodes) && item.nodes.length === 1)) {
      return unknown('invalid_configuration')
    }
    return list(item.nodes, node)
  })
}
