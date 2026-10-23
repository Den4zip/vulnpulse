export enum VulnStatus {
  New = 'New',
  Analyzing = 'Analyzing',
  Affected = 'Affected',
  InProgress = 'In Progress',
  Patched = 'Patched',
  FalsePositive = 'False Positive'
}

export enum Severity {
  Critical = 'Critical',
  High = 'High',
  Medium = 'Medium',
  Low = 'Low',
  None = 'None'
}

export type FeedName = 'nvd' | 'osv' | 'cisa' | 'fstec'

export type StackKind = 'application' | 'system' | 'package'
