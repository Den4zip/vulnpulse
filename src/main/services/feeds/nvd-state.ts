import { nvdTime, object } from './nvd-data'

export const NVD_MAX_WINDOW_MS = 120 * 24 * 60 * 60 * 1000
export const NVD_OVERLAP_MS = 2 * 60 * 1000

export interface NvdCursor {
  readonly startIndex: number
  readonly lastModStartDate?: string
  readonly lastModEndDate?: string
}

export interface NvdSyncState {
  version: 1
  /** End of fully applied interval, or null before initial population. */
  completedThrough: string | null
  pending: (NvdCursor & { readonly baselineAt?: string }) | null
}

export function checkCursor(cursor: NvdCursor): void {
  const start = cursor.lastModStartDate
  const end = cursor.lastModEndDate
  if (!Number.isSafeInteger(cursor.startIndex) || cursor.startIndex < 0
    || ((start !== undefined || end !== undefined)
      && (!Number.isFinite(nvdTime(start)) || !Number.isFinite(nvdTime(end))
        || nvdTime(end) < nvdTime(start) || nvdTime(end) - nvdTime(start) > NVD_MAX_WINDOW_MS))) {
    throw new Error('Invalid NVD cursor')
  }
}

export function readNvdState(raw: string | null): NvdSyncState {
  if (raw === null) return { version: 1, completedThrough: null, pending: null }
  let state: unknown
  try { state = JSON.parse(raw) } catch { throw new Error('Invalid NVD checkpoint') }
  if (!object(state) || state.version !== 1
    || (state.completedThrough !== null && !Number.isFinite(nvdTime(state.completedThrough)))
    || (state.pending !== null && !object(state.pending))) throw new Error('Invalid NVD checkpoint')
  if (state.pending !== null) {
    const pending = state.pending as unknown as NvdCursor & { baselineAt?: string }
    checkCursor(pending)
    if (state.completedThrough === null
      ? !Number.isFinite(nvdTime(pending.baselineAt)) || pending.lastModStartDate !== undefined
      : pending.baselineAt !== undefined || pending.lastModStartDate === undefined
        || nvdTime(pending.lastModStartDate) > nvdTime(state.completedThrough)
        || nvdTime(pending.lastModEndDate) <= nvdTime(state.completedThrough)) {
      throw new Error('Invalid NVD checkpoint')
    }
  }
  return state as unknown as NvdSyncState
}
