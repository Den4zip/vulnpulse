import { Severity, VulnStatus, type FeedName } from '@shared/enums'
import type { VulnerabilityQuery } from '@shared/api'
import { enumeration, integer, invalid, object } from '../validation'
export { identity } from '../validation'

export function query(input: unknown): Required<Pick<VulnerabilityQuery, 'limit' | 'offset' | 'sort' | 'direction'>> & VulnerabilityQuery {
  const raw = input === undefined ? {} : object(input, ['search', 'severity', 'status', 'knownExploited', 'feed', 'sort', 'direction', 'offset', 'limit'])
  const result: ReturnType<typeof query> = {
    limit: raw.limit === undefined ? 50 : integer(raw.limit, 1, 100),
    offset: raw.offset === undefined ? 0 : integer(raw.offset, 0, 1_000_000),
    sort: raw.sort === undefined ? 'modifiedAt' : enumeration(raw.sort, ['id', 'modifiedAt', 'publishedAt', 'severity']),
    direction: raw.direction === undefined ? 'desc' : enumeration(raw.direction, ['asc', 'desc'])
  }
  if (raw.search !== undefined) {
    if (typeof raw.search !== 'string' || raw.search.length > 200 || /[\u0000-\u001f\u007f]/.test(raw.search)) return invalid()
    result.search = raw.search.trim()
  }
  if (raw.severity !== undefined) result.severity = raw.severity === null ? null : enumeration(raw.severity, Object.values(Severity))
  if (raw.status !== undefined) result.status = enumeration(raw.status, Object.values(VulnStatus))
  if (raw.knownExploited !== undefined) {
    if (typeof raw.knownExploited !== 'boolean') return invalid()
    result.knownExploited = raw.knownExploited
  }
  if (raw.feed !== undefined) result.feed = enumeration<FeedName>(raw.feed, ['nvd', 'osv', 'cisa', 'fstec'])
  return result
}

export function statusChange(input: unknown): { id: number; status: VulnStatus } {
  const raw = object(input, ['id', 'status'])
  return { id: integer(raw.id, 1, Number.MAX_SAFE_INTEGER), status: enumeration(raw.status, Object.values(VulnStatus)) }
}
