import type { CpeParts } from './cpe'

export type ApplicabilityStatus = 'match' | 'no_match' | 'unknown'
export type ApplicabilityReason = 'missing_configuration' | 'invalid_configuration' | 'unsupported_logic'
  | 'unsupported_cpe' | 'invalid_range' | 'rejected_record' | 'invalid_source'
  | 'missing_inventory' | 'ambiguous_version' | 'unsupported_version' | 'criteria_matched' | 'criteria_not_matched'

export interface VersionBound { readonly value: string; readonly inclusive: boolean }

/** Main-only representation; never flatten a configuration into unconditional CPEs. */
export type NvdApplicability =
  | { readonly kind: 'unknown'; readonly reason: ApplicabilityReason }
  | { readonly kind: 'or'; readonly children: readonly NvdApplicability[] }
  | { readonly kind: 'cpe'; readonly criteria: string; readonly matchCriteriaId: string;
      readonly cpe: CpeParts; readonly start?: VersionBound; readonly end?: VersionBound }

export interface ApplicabilityDecision {
  readonly status: ApplicabilityStatus
  readonly reason: ApplicabilityReason
  readonly criteria?: string
  readonly matchCriteriaId?: string
  readonly evaluatedVersion?: string
}

export interface ApplicabilityAssessment extends ApplicabilityDecision {
  readonly vulnerabilityId: number
  readonly stackId: number
  readonly source: 'nvd'
  readonly matcherVersion: 'nvd-cpe-v1'
}
