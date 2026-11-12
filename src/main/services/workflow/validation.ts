import type { NoteQuery, NoteRevision, RecordRevision, SlaWrite } from '@shared/api'
import { enumeration, integer, invalid, object } from '../validation'

export const NOTE_MAX_LENGTH = 16_384
const id = (input: unknown): number => integer(input, 1, Number.MAX_SAFE_INTEGER)

export function owner(input: unknown): number { return id(object(input, ['vulnerabilityId']).vulnerabilityId) }

function body(input: unknown): string {
  if (typeof input !== 'string' || input.length > NOTE_MAX_LENGTH || !input.trim()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input)) return invalid()
  return input
}

export function noteQuery(input: unknown): NoteQuery & Required<Pick<NoteQuery, 'offset' | 'limit' | 'direction'>> {
  const raw = object(input, ['vulnerabilityId', 'offset', 'limit', 'direction'])
  return { vulnerabilityId: id(raw.vulnerabilityId), offset: raw.offset === undefined ? 0 : integer(raw.offset, 0, 1_000_000),
    limit: raw.limit === undefined ? 50 : integer(raw.limit, 1, 100),
    direction: raw.direction === undefined ? 'desc' : enumeration(raw.direction, ['asc', 'desc']) }
}

export function noteCreate(input: unknown): { vulnerabilityId: number; body: string } {
  const raw = object(input, ['vulnerabilityId', 'body'])
  return { vulnerabilityId: id(raw.vulnerabilityId), body: body(raw.body) }
}

export function noteRemove(input: unknown): NoteRevision {
  const raw = object(input, ['id', 'expectedRevision'])
  return { id: id(raw.id), expectedRevision: id(raw.expectedRevision) }
}

export function noteUpdate(input: unknown): NoteRevision & { body: string } {
  const raw = object(input, ['id', 'expectedRevision', 'body'])
  return { id: id(raw.id), expectedRevision: id(raw.expectedRevision), body: body(raw.body) }
}

function token(input: unknown): RecordRevision {
  const raw = object(input, ['id', 'revision'])
  return { id: id(raw.id), revision: id(raw.revision) }
}

/** Explicit canonical UTC instant, never an ambiguous local/date-only value. */
export function readUtc(input: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)) return null
  const value = Date.parse(input)
  return Number.isFinite(value) && new Date(value).toISOString() === input ? value : null
}

function utc(input: unknown): string {
  if (typeof input !== 'string' || readUtc(input) === null) return invalid()
  return input
}

export function slaWrite(input: unknown, now: number): SlaWrite {
  const raw = object(input, ['vulnerabilityId', 'dueAt', 'patchedAt', 'expected'])
  const dueAt = utc(raw.dueAt)
  const patchedAt = raw.patchedAt === null ? null : utc(raw.patchedAt)
  if (patchedAt !== null && Date.parse(patchedAt) > now) return invalid()
  return { vulnerabilityId: id(raw.vulnerabilityId), dueAt, patchedAt,
    expected: raw.expected === null ? null : token(raw.expected) }
}

export function slaRemove(input: unknown): { vulnerabilityId: number; expected: RecordRevision } {
  const raw = object(input, ['vulnerabilityId', 'expected'])
  return { vulnerabilityId: id(raw.vulnerabilityId), expected: token(raw.expected) }
}
