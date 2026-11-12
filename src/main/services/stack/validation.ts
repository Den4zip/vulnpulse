import type { StackQuery, StackRevision } from '@shared/api'
import type { StackKind } from '@shared/enums'
import { enumeration, integer, invalid, object } from '../validation'
import { parseStackComponent, type StackComponent } from './component'

export { identity } from '../validation'

export function component(input: unknown): StackComponent {
  try { return parseStackComponent(input) } catch { return invalid() }
}

export function query(input: unknown): StackQuery & Required<Pick<StackQuery, 'limit' | 'offset' | 'sort' | 'direction'>> {
  const raw = input === undefined ? {} : object(input, ['search', 'kind', 'sort', 'direction', 'limit', 'offset'])
  const result: ReturnType<typeof query> = {
    limit: raw.limit === undefined ? 50 : integer(raw.limit, 1, 100),
    offset: raw.offset === undefined ? 0 : integer(raw.offset, 0, 1_000_000),
    sort: raw.sort === undefined ? 'name' : enumeration(raw.sort, ['id', 'name', 'updatedAt']),
    direction: raw.direction === undefined ? 'asc' : enumeration(raw.direction, ['asc', 'desc'])
  }
  if (raw.kind !== undefined) result.kind = enumeration<StackKind>(raw.kind, ['application', 'system', 'package'])
  if (raw.search !== undefined) {
    if (typeof raw.search !== 'string' || raw.search.length > 200 || /[\u0000-\u001f\u007f]/.test(raw.search)) return invalid()
    result.search = raw.search.trim()
  }
  return result
}

function revision(raw: Record<string, unknown>): StackRevision {
  if (typeof raw.expectedUpdatedAt !== 'string' || !raw.expectedUpdatedAt.length
    || raw.expectedUpdatedAt.length > 64 || /[\u0000-\u001f\u007f]/.test(raw.expectedUpdatedAt)) return invalid()
  return { id: integer(raw.id, 1, Number.MAX_SAFE_INTEGER), expectedUpdatedAt: raw.expectedUpdatedAt }
}

export function removal(input: unknown): StackRevision {
  return revision(object(input, ['id', 'expectedUpdatedAt']))
}

export function update(input: unknown): StackRevision & { component: StackComponent } {
  const raw = object(input, ['id', 'expectedUpdatedAt', 'component'])
  return { ...revision(raw), component: component(raw.component) }
}
