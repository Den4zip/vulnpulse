export const FSTEC_MIRROR_URL = 'https://raw.githubusercontent.com/velvetway/bdu-fstec-mirror/main/data/vulxml.xml.gz'
export const FSTEC_MAX_COMPRESSED = 64 * 1024 * 1024
export const FSTEC_MAX_XML = 1024 * 1024 * 1024
export const FSTEC_MAX_RECORD = 2 * 1024 * 1024
export const FSTEC_MAX_SPOOL = 1536 * 1024 * 1024
export const FSTEC_MAX_RECORDS = 150000

export type FstecInput = { readonly kind: 'file'; readonly path: string; readonly gzip?: boolean }
  | { readonly kind: 'bytes'; readonly data: Uint8Array; readonly gzip?: boolean }
export type FstecOrigin = 'manual' | 'mirror'
export interface FstecRecord {
  readonly id: string
  readonly title: string
  readonly description: string | null
  readonly publishedAt: string | null
  readonly modifiedAt: string | null
  readonly cves: readonly string[]
  readonly rawJson: string
  readonly warnings: readonly string[]
}
export interface FstecStage {
  readonly count: number
  readonly spoolBytes: number
  readonly spoolHash: string
  readonly sourceHash: string
}
export const fstecObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
export function fstecAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('FSTEC import cancelled') }

export function fstecDate(value: unknown): string | null {
  if (value === undefined || value === '') return null
  if (typeof value !== 'string') throw new Error('Invalid FSTEC date')
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value)
  if (!match) throw new Error('Invalid FSTEC date')
  const iso = `${match[3]}-${match[2]}-${match[1]}`
  const time = Date.parse(`${iso}T00:00:00Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== iso) throw new Error('Invalid FSTEC date')
  return iso
}

/** Main checks worker output without parsing XML in the main thread. */
export function checkedFstecRecord(value: unknown): FstecRecord {
  if (!fstecObject(value) || typeof value.id !== 'string' || !/^BDU:\d{4}-\d{5,10}$/.test(value.id)
    || typeof value.title !== 'string' || !value.title || value.title.length > 65536
    || (value.description !== null && typeof value.description !== 'string')
    || !Array.isArray(value.cves) || value.cves.length > 100
    || value.cves.some((v) => typeof v !== 'string' || !/^CVE-\d{4}-\d{4,19}$/.test(v))
    || !Array.isArray(value.warnings) || value.warnings.length > 1000 || value.warnings.some((w) => typeof w !== 'string' || w.length > 256)
    || typeof value.rawJson !== 'string' || Buffer.byteLength(value.rawJson) > FSTEC_MAX_RECORD * 4
    || [value.publishedAt, value.modifiedAt].some((v) => v !== null && (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)))) {
    throw new Error('Invalid FSTEC worker record')
  }
  return value as unknown as FstecRecord
}
