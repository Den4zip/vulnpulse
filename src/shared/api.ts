import type { FeedName, Severity, StackKind, VulnStatus } from './enums'

/** Public read/command DTOs; no database, Electron or raw-provider types. */
export type ApiErrorCode = 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'CONFLICT' | 'BUSY' | 'FORBIDDEN' | 'INTERNAL_ERROR' | 'UNAVAILABLE'
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: { code: ApiErrorCode; message: string } }

export interface VulnerabilityQuery {
  search?: string
  severity?: Severity | null
  status?: VulnStatus
  knownExploited?: boolean
  feed?: FeedName
  sort?: 'id' | 'modifiedAt' | 'publishedAt' | 'severity'
  direction?: 'asc' | 'desc'
  offset?: number
  limit?: number
}

export interface VulnerabilitySummary {
  id: number
  extId: string
  title: string | null
  titleTruncated: boolean
  severity: Severity | null
  cvssScore: number | null
  /** Global vulnerability workflow, not an individual component's state. */
  status: VulnStatus
  isKnownExploited: boolean
  publishedAt: string | null
  modifiedAt: string | null
  sources: FeedName[]
}

export interface VulnerabilityPage {
  items: VulnerabilitySummary[]
  total: number
  offset: number
  limit: number
}

export interface VulnerabilityDetail extends VulnerabilitySummary {
  description: string | null
  descriptionTruncated: boolean
  cvssVector: string | null
  cvssVectorTruncated: boolean
  createdAt: string
  sourceReferences: { feed: FeedName; sourceId: string; sourceIdTruncated: boolean }[]
  sourceReferencesTotal: number
}

/** Counts of canonical stored cards, irrespective of applicability or catalog coverage. */
export interface DashboardView {
  evaluatedAt: string
  total: number
  knownExploited: number
  newCount: number
  criticalCount: number
  severity: { severity: Severity | null; count: number; knownExploited: number }[]
  statuses: { status: VulnStatus; count: number }[]
  feeds: DashboardFeed[]
}
export interface DashboardFeed {
  name: FeedName
  /** Source advisory records, not canonical vulnerability cards. */
  recordCount: number
  mode: 'local' | 'manual' | 'scheduled'
  runState: 'untracked' | 'never' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'
  lastStartedAt: string | null
  /** End of the latest network attempt, including failed/cancelled attempts. */
  lastFinishedAt: string | null
}

export interface StackComponentInput {
  kind: StackKind
  name: string
  vendor?: string | null
  product: string
  version: string
  cpe23?: string | null
  purl?: string | null
}

export interface StackEntry {
  id: number
  kind: StackKind
  name: string
  vendor: string | null
  product: string
  version: string | null
  cpe23: string | null
  purl: string | null
  createdAt: string
  updatedAt: string
}

export interface StackQuery {
  search?: string
  kind?: StackKind
  sort?: 'id' | 'name' | 'updatedAt'
  direction?: 'asc' | 'desc'
  offset?: number
  limit?: number
}

export interface StackPage { items: StackEntry[]; total: number; offset: number; limit: number }
export interface StackRevision { id: number; expectedUpdatedAt: string }
export interface StackUpdate extends StackRevision { component: StackComponentInput }
export interface StackWriteResult { item: StackEntry; invalidatedMatches: number; matchingRecomputed: false }
export interface StackDeleteResult { id: number; removedMatches: number }

/** User workflow still belongs to the global vulnerability. */
export interface RecordRevision { id: number; revision: number }
export interface NoteEntry extends RecordRevision {
  vulnerabilityId: number
  body: string
  bodyTruncated: boolean
  createdAt: string
}
export interface NoteQuery { vulnerabilityId: number; offset?: number; limit?: number; direction?: 'asc' | 'desc' }
export interface NotePage { items: NoteEntry[]; total: number; offset: number; limit: number }
export interface NoteCreate { vulnerabilityId: number; body: string }
export interface NoteRevision { id: number; expectedRevision: number }
export interface NoteUpdate extends NoteRevision { body: string }
export interface SlaEntry extends RecordRevision {
  vulnerabilityId: number
  dueAt: string
  patchedAt: string | null
  dateValuesTruncated: boolean
  state: 'open' | 'overdue' | 'completed' | 'unknown'
  isOverdue: boolean | null
  missedDeadline: boolean | null
}
export interface SlaView { vulnerabilityId: number; record: SlaEntry | null; evaluatedAt: string }
export interface SlaWrite { vulnerabilityId: number; dueAt: string; patchedAt: string | null; expected: RecordRevision | null }
export interface SlaRemove { vulnerabilityId: number; expected: RecordRevision }

export type NetworkFeed = 'cisa' | 'nvd' | 'fstec'
export interface FeedSettings { enabled: boolean; intervalMinutes: number }
export type FeedSettingsMap = Record<NetworkFeed, FeedSettings>
export interface StoredSettings { revision: number; feeds: FeedSettingsMap }
export interface NvdKeyInfo {
  revision: number
  configured: boolean
  storageAvailable: boolean
  status: 'missing' | 'available' | 'unavailable'
  needsReencrypt: boolean
}
export interface SettingsView extends StoredSettings { osvMode: 'local-json'; nvdKey: NvdKeyInfo }
export interface SettingsUpdate { expectedRevision: number; feeds: FeedSettingsMap }
export interface NvdKeyWrite { expectedRevision: number; apiKey: string }
export interface NvdKeyRemove { expectedRevision: number }

export type ImportKind = 'osv' | 'fstec' | 'stack'
export interface OperationInfo {
  id: string
  kind: 'sync' | 'import'
  target: NetworkFeed | ImportKind
  phase: 'selecting' | 'running' | 'completed' | 'cancelled' | 'failed'
  startedAt: string
  finishedAt: string | null
  cancelRequested: boolean
  result: { processed: number; warnings: number; unchanged: boolean }
    | { added: number; skipped: number; total: number } | null
}
export interface FeedSyncStatus {
  name: NetworkFeed
  enabled: boolean
  running: boolean
  lastStartedAt: string | null
  lastFinishedAt: string | null
  lastError: 'failed' | 'cancelled' | 'interrupted' | null
}
export interface SyncView {
  feeds: FeedSyncStatus[]
  active: OperationInfo | null
  lastSync: OperationInfo | null
  lastImport: OperationInfo | null
  settingsBusy: boolean
  osvMode: 'local-json'
  matchingRecomputed: false
}

export interface ElectronAPI {
  ping(): string
  dashboard: { get(): Promise<ApiResult<DashboardView>> }
  vulnerabilities: {
    list(query?: VulnerabilityQuery): Promise<ApiResult<VulnerabilityPage>>
    get(id: number): Promise<ApiResult<VulnerabilityDetail>>
    setStatus(id: number, status: VulnStatus): Promise<ApiResult<VulnerabilityDetail>>
  }
  stack: {
    list(query?: StackQuery): Promise<ApiResult<StackPage>>
    get(id: number): Promise<ApiResult<StackEntry>>
    create(component: StackComponentInput): Promise<ApiResult<StackWriteResult>>
    update(command: StackUpdate): Promise<ApiResult<StackWriteResult>>
    remove(command: StackRevision): Promise<ApiResult<StackDeleteResult>>
  }
  notes: {
    list(query: NoteQuery): Promise<ApiResult<NotePage>>
    get(id: number): Promise<ApiResult<NoteEntry>>
    create(command: NoteCreate): Promise<ApiResult<NoteEntry>>
    update(command: NoteUpdate): Promise<ApiResult<NoteEntry>>
    remove(command: NoteRevision): Promise<ApiResult<{ id: number }>>
  }
  sla: {
    get(vulnerabilityId: number): Promise<ApiResult<SlaView>>
    set(command: SlaWrite): Promise<ApiResult<SlaView>>
    remove(command: SlaRemove): Promise<ApiResult<SlaView>>
  }
  settings: {
    get(): Promise<ApiResult<SettingsView>>
    update(command: SettingsUpdate): Promise<ApiResult<SettingsView>>
    setNvdApiKey(command: NvdKeyWrite): Promise<ApiResult<SettingsView>>
    removeNvdApiKey(command: NvdKeyRemove): Promise<ApiResult<SettingsView>>
  }
  sync: {
    status(): Promise<ApiResult<SyncView>>
    start(command: { feed: NetworkFeed }): Promise<ApiResult<OperationInfo>>
    importFile(command: { kind: ImportKind }): Promise<ApiResult<OperationInfo>>
    cancel(command: { operationId: string }): Promise<ApiResult<OperationInfo>>
  }
}

export const IPC_CHANNELS = {
  dashboardGet: 'vulnpulse:dashboard:get',
  vulnerabilityList: 'vulnpulse:vulnerabilities:list',
  vulnerabilityGet: 'vulnpulse:vulnerabilities:get',
  vulnerabilitySetStatus: 'vulnpulse:vulnerabilities:set-status',
  stackList: 'vulnpulse:stack:list',
  stackGet: 'vulnpulse:stack:get',
  stackCreate: 'vulnpulse:stack:create',
  stackUpdate: 'vulnpulse:stack:update',
  stackRemove: 'vulnpulse:stack:remove',
  notesList: 'vulnpulse:notes:list',
  notesGet: 'vulnpulse:notes:get',
  notesCreate: 'vulnpulse:notes:create',
  notesUpdate: 'vulnpulse:notes:update',
  notesRemove: 'vulnpulse:notes:remove',
  slaGet: 'vulnpulse:sla:get',
  slaSet: 'vulnpulse:sla:set',
  slaRemove: 'vulnpulse:sla:remove',
  settingsGet: 'vulnpulse:settings:get',
  settingsUpdate: 'vulnpulse:settings:update',
  settingsSetNvdKey: 'vulnpulse:settings:set-nvd-key',
  settingsRemoveNvdKey: 'vulnpulse:settings:remove-nvd-key',
  syncStatus: 'vulnpulse:sync:status',
  syncStart: 'vulnpulse:sync:start',
  syncImportFile: 'vulnpulse:sync:import-file',
  syncCancel: 'vulnpulse:sync:cancel'
} as const
