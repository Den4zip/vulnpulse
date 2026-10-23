export const CPE_PARTS = ['a', 'h', 'o'] as const

export type CpePart = (typeof CPE_PARTS)[number]

export interface CpeParts {
  part: CpePart
  vendor: string
  product: string
  version: string
  update: string
  edition: string
  language: string
  swEdition: string
  targetSw: string
  targetHw: string
  other: string
}

export const CPE_PREFIX = 'cpe:2.3:'

export class CpeParseError extends Error {
  constructor(message: string) {
    super(`Invalid CPE 2.3 URI: ${message}`)
    this.name = 'CpeParseError'
  }
}

const FIELD_KEYS = [
  'part',
  'vendor',
  'product',
  'version',
  'update',
  'edition',
  'language',
  'swEdition',
  'targetSw',
  'targetHw',
  'other'
] as const

function splitEscaped(body: string): string[] {
  const segments: string[] = []
  let current = ''
  let escapeActive = false

  for (const ch of body) {
    if (escapeActive) {
      if (ch !== '\\' && ch !== ':' && ch !== '|') {
        throw new CpeParseError(`illegal escape sequence \\${ch}`)
      }
      current += ch
      escapeActive = false
    } else if (ch === '\\') {
      escapeActive = true
    } else if (ch === ':') {
      segments.push(current)
      current = ''
    } else {
      current += ch
    }
  }

  if (escapeActive) {
    throw new CpeParseError('dangling escape character at end of URI')
  }

  segments.push(current)
  return segments
}

function escapeSegment(segment: string): string {
  let out = ''
  for (const ch of segment) {
    if (ch === '\\' || ch === ':' || ch === '|') {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return out
}

export function isCpe23Uri(value: string): boolean {
  return value.startsWith(CPE_PREFIX)
}

export function parseCpe23(uri: string): CpeParts {
  if (!isCpe23Uri(uri)) {
    throw new CpeParseError('URI must start with "cpe:2.3:"')
  }

  const segments = splitEscaped(uri.slice(CPE_PREFIX.length))

  if (segments.length !== FIELD_KEYS.length) {
    throw new CpeParseError(
      `expected ${FIELD_KEYS.length} components after the prefix, got ${segments.length}`
    )
  }

  const [part, vendor, product, version, update, edition, language, swEdition, targetSw, targetHw, other] =
    segments

  if (part !== 'a' && part !== 'h' && part !== 'o') {
    throw new CpeParseError(`part must be one of [a, h, o], got "${part}"`)
  }

  for (let i = 0; i < FIELD_KEYS.length; i++) {
    if (segments[i].length === 0) {
      throw new CpeParseError(`component "${FIELD_KEYS[i]}" is empty; use "-" or "*"`)
    }
  }

  return {
    part,
    vendor,
    product,
    version,
    update,
    edition,
    language,
    swEdition,
    targetSw,
    targetHw,
    other
  }
}

export function formatCpe23(parts: CpeParts): string {
  const ordered = FIELD_KEYS.map((key) => parts[key])
  return CPE_PREFIX + ordered.map(escapeSegment).join(':')
}

export function isAny(value: string): boolean {
  return value === '*'
}

export function isNa(value: string): boolean {
  return value === '-'
}

export type VersionComparator = (vulnVersion: string, stackVersion: string) => boolean

export function matchSegment(vulnVal: string, stackVal: string): boolean {
  if (isNa(stackVal) || isNa(vulnVal)) {
    return isNa(vulnVal) && isNa(stackVal)
  }
  if (isAny(vulnVal) || isAny(stackVal)) {
    return true
  }
  return vulnVal.toLowerCase() === stackVal.toLowerCase()
}

const SEQUENCE_KEYS = [
  'vendor',
  'product',
  'update',
  'edition',
  'language',
  'swEdition',
  'targetSw',
  'targetHw',
  'other'
] as const

export function matchCpe(
  vulnCpe: CpeParts,
  stackCpe: CpeParts,
  compareVersions?: VersionComparator
): boolean {
  if (vulnCpe.part !== stackCpe.part) {
    return false
  }

  for (const key of SEQUENCE_KEYS) {
    if (!matchSegment(vulnCpe[key], stackCpe[key])) {
      return false
    }
  }

  const { version: vulnVersion } = vulnCpe
  const { version: stackVersion } = stackCpe

  if (isAny(vulnVersion)) {
    return !isNa(stackVersion)
  }

  if (isAny(stackVersion) || isNa(stackVersion)) {
    return false
  }

  if (compareVersions) {
    return compareVersions(vulnVersion, stackVersion)
  }

  return vulnVersion.toLowerCase() === stackVersion.toLowerCase()
}
