import type { Severity, VulnStatus } from './enums'

export type FeedName = 'nvd' | 'osv' | 'cisa' | 'fstec'

export type StackKind = 'application' | 'system' | 'package'

export interface FeedInfo {
  id?: number
  name: FeedName
  source: string
  etag: string | null
  lastStartedAt: string | null
  lastFinishedAt: string | null
  lastError: string | null
}

export interface Vulnerability {
  id?: number
  extId: string
  feedId: number
  title: string | null
  description: string | null
  severity: Severity | null
  cvssScore: number | null
  cvssVector: string | null
  status: VulnStatus
  isKnownExploited: boolean
  publishedAt: string | null
  modifiedAt: string | null
}

export interface StackItem {
  id?: number
  kind: StackKind
  name: string
  vendor: string | null
  product: string
  version: string | null
  cpe23: string | null
  purl: string | null
}

export interface MatchRecord {
  id?: number
  vulnerabilityId: number
  stackId: number
  confidence: number
}

export interface Note {
  id?: number
  vulnerabilityId: number
  body: string
}

export interface SlaRecord {
  id?: number
  vulnerabilityId: number
  dueAt: string
  patchedAt: string | null
}
