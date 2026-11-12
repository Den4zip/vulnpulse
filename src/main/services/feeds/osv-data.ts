export const OSV_MAX_BYTES = 32 * 1024 * 1024
export const OSV_MAX_RECORDS = 1000
export interface OsvRecord extends Record<string, unknown> {
  id: string
  modified: string
  aliases?: string[]
  summary?: string
  details?: string
  published?: string
}
export const osvObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export const osvId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(value)
export function osvAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('OSV import cancelled') }

/** Canonical UTC timestamp key with nanosecond precision for freshness checks. */
export function osvTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value)
  if (!match) return null
  const time = Date.parse(`${match[1]}Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== match[1]) return null
  return `${match[1]}.${(match[2] ?? '').padEnd(9, '0')}Z`
}

export function osvRecord(value: unknown): OsvRecord {
  if (!osvObject(value) || !osvId(value.id) || osvTime(value.modified) === null
    || (value.schema_version !== undefined && (typeof value.schema_version !== 'string' || !/^1\.\d+\.\d+$/.test(value.schema_version)))
    || ['published', 'withdrawn'].some((key) => value[key] !== undefined && osvTime(value[key]) === null)
    || ['summary', 'details'].some((key) => value[key] !== undefined && typeof value[key] !== 'string')
    || ['aliases', 'related', 'upstream'].some((key) => value[key] !== undefined && (!Array.isArray(value[key])
      || value[key].length > 1000 || !value[key].every(osvId)))
    || (value.affected !== undefined && value.affected !== null && (!Array.isArray(value.affected) || value.affected.length > 4096))) {
    throw new Error('Invalid OSV record')
  }
  return value as OsvRecord
}

export function osvRecords(raw: unknown, signal?: AbortSignal): readonly OsvRecord[] {
  osvAbort(signal)
  const values = Array.isArray(raw) ? raw : [raw]
  if (!values.length || values.length > OSV_MAX_RECORDS) throw new Error('Invalid OSV import count')
  const ids = new Set<string>()
  return values.map((value) => {
    osvAbort(signal)
    const record = osvRecord(value)
    if (ids.has(record.id)) throw new Error('Duplicate OSV ID')
    ids.add(record.id)
    return record
  })
}
