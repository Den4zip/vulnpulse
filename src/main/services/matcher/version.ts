import { compare, valid } from 'semver'

export type CompareResult = -1 | 0 | 1

export class InvalidVersionError extends Error {
  constructor(message: string) {
    super(`Invalid version: ${message}`)
    this.name = 'InvalidVersionError'
  }
}

/** semver.valid() itself strips one leading "v"; raw texts may still carry "=" padding. */
function normalizeInput(raw: string): string {
  return raw.trim().replace(/^[v=]+/i, '')
}

export function isSemver(raw: string): boolean {
  return valid(normalizeInput(raw)) !== null
}

/** Compare two package versions using semver rules (prerelease < release,
 * build metadata is ignored). Returns null when either side is not semver so
 * callers can delegate to the system-version normalizer. */
export function compareSemver(a: string, b: string): CompareResult | null {
  const av = valid(normalizeInput(a))
  const bv = valid(normalizeInput(b))
  if (av === null || bv === null) {
    return null
  }
  return compare(av, bv) as CompareResult
}

export function semverEquals(a: string, b: string): boolean {
  return compareSemver(a, b) === 0
}

/** Strict variant: throws instead of returning null. For pipeline code that
 * has already verified versions with isSemver. */
export function compareSemverOrThrow(a: string, b: string): CompareResult {
  const result = compareSemver(a, b)
  if (result === null) {
    throw new InvalidVersionError(`"${a}" vs "${b}": not semver`)
  }
  return result
}
