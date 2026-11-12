import type { ApplicabilityStatus } from './nvd-types'

export type OsvReason = 'invalid_source' | 'withdrawn' | 'unsupported_package' | 'invalid_package'
  | 'missing_inventory' | 'ambiguous_version' | 'unsupported_version' | 'unsupported_range'
  | 'invalid_range' | 'missing_conditions' | 'affected_version' | 'affected_range' | 'not_affected'
export interface OsvInterval { readonly introduced: string | null; readonly end?: string; readonly inclusive: boolean }
export type OsvRange = { readonly kind: 'unknown'; readonly reason: OsvReason }
  | { readonly kind: 'semver'; readonly intervals: readonly OsvInterval[] }
export type OsvPackageRule = { readonly kind: 'unknown'; readonly reason: OsvReason }
  | { readonly kind: 'package'; readonly ecosystem: string; readonly name: string;
      readonly versions: readonly string[]; readonly ranges: readonly OsvRange[] }
export type OsvApplicability = { readonly kind: 'unknown'; readonly reason: OsvReason }
  | { readonly kind: 'advisory'; readonly advisoryId: string; readonly withdrawn: boolean; readonly affected: readonly OsvPackageRule[] }
export interface OsvDecision {
  readonly status: ApplicabilityStatus
  readonly reason: OsvReason
  readonly advisoryId?: string
  readonly packageName?: string
  readonly evaluatedVersion?: string
  readonly rangeIndex?: number
}
export interface OsvAssessment extends OsvDecision {
  readonly vulnerabilityId: number
  readonly stackId: number
  readonly source: 'osv'
  readonly matcherVersion: 'osv-local-v1'
}
