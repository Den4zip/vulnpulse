import { ServiceError } from './errors'

export function invalid(): never { throw new ServiceError('INVALID_ARGUMENT') }

export function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return invalid()
  if (Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !keys.includes(key))) return invalid()
  return input as Record<string, unknown>
}

export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid()
  return value
}

export function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return invalid()
  return value as T
}

export function identity(input: unknown): number {
  return integer(object(input, ['id']).id, 1, Number.MAX_SAFE_INTEGER)
}

export function nextRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value === Number.MAX_SAFE_INTEGER) throw new ServiceError('INTERNAL_ERROR')
  return value + 1
}
