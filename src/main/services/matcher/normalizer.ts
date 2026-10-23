import type { CompareResult } from './version'

export type SystemVersionKind = 'prerelease' | 'plain' | 'fallback'

export interface ParsedSystemVersion {
  /** Numeric segments before the suffix (e.g. [1, 1, 1, 4] for 1.1.1d). */
  parts: number[]
  /** plain (no suffix) < prerelease/rc < fallback (Ubuntu/Debian residue). */
  kind: SystemVersionKind
  /** Keyword rank inside the prerelease kind: dev/alpha=1, beta/pre/test=2, rc=3. */
  order: number
  /** Numeric tail for prerelease identifiers (rc2 -> 2) and prerelease chain. */
  tail: number
  /** Lexicographic key for the fallback kind (Ubuntu revisions like 0ubuntu1). */
  lex: string
}

const PRERELEASE_ORDER: Record<string, number> = {
  dev: 1,
  alpha: 1,
  snapshot: 1,
  beta: 2,
  pre: 2,
  test: 2,
  rc: 3
}

const PRERELEASE_KEYWORD_RE = /^(dev|alpha|snapshot|beta|pre|test|rc)(\d+)?$/
const NUMERIC_PREFIX_RE = /^\d+/
const LETTER_PATCH_RE = /^[a-z]{1,2}$/

function letterRunToNumber(letters: string): number {
  let value = 0
  for (const ch of letters) {
    value = value * 26 + (ch.charCodeAt(0) - 'a'.charCodeAt(0) + 1)
  }
  return value
}

export function parseSystemVersion(rawVersion: string): ParsedSystemVersion | null {
  const raw = rawVersion
    .trim()
    .toLowerCase()
    .replace(/^[v]+/, '')
    .replace(/[_,]/g, '.')
    .replace(/^\./, '')

  const numericMatch = raw.match(NUMERIC_PREFIX_RE)
  if (!numericMatch) {
    return null
  }

  const parts: number[] = []
  let cursor = numericMatch[0].length
  parts.push(Number(numericMatch[0]))

  while (cursor < raw.length) {
    const ch = raw[cursor]
    if (ch === '.' && NUMERIC_PREFIX_RE.test(raw.slice(cursor + 1))) {
      const next = raw.slice(cursor + 1).match(NUMERIC_PREFIX_RE) as RegExpMatchArray
      parts.push(Number(next[0]))
      cursor += 1 + next[0].length
      continue
    }
    if (ch === '.' || ch === '-') {
      cursor += 1
      continue
    }
    break
  }

  let suffix = raw.slice(cursor)

  if (suffix.length === 0) {
    return { parts, kind: 'plain', order: 0, tail: 0, lex: '' }
  }

  const prereleaseMatch = suffix.match(PRERELEASE_KEYWORD_RE)
  if (prereleaseMatch) {
    const keyword = prereleaseMatch[1]
    const tail = prereleaseMatch[2] ? Number(prereleaseMatch[2]) : 0
    return { parts, kind: 'prerelease', order: PRERELEASE_ORDER[keyword], tail, lex: suffix }
  }

  if (LETTER_PATCH_RE.test(suffix)) {
    return { parts: [...parts, letterRunToNumber(suffix)], kind: 'plain', order: 0, tail: 0, lex: '' }
  }

  const leadingNumber = suffix.match(NUMERIC_PREFIX_RE)
  if (leadingNumber) {
    const tailParts = [...parts, Number(leadingNumber[0])]
    const residue = suffix.slice(leadingNumber[0].length)
    if (residue.length === 0) {
      return { parts: tailParts, kind: 'plain', order: 0, tail: 0, lex: '' }
    }
    return { parts: tailParts, kind: 'fallback', order: 0, tail: 0, lex: residue }
  }

  return { parts, kind: 'fallback', order: 0, tail: 0, lex: suffix }
}

function compareNumbers(a: number, b: number): CompareResult {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function compareParts(a: number[], b: number[]): CompareResult {
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    const result = compareNumbers(av, bv)
    if (result !== 0) {
      return result
    }
  }
  return 0
}

function compareKind(a: SystemVersionKind, b: SystemVersionKind): CompareResult {
  const kindRank: Record<SystemVersionKind, number> = {
    prerelease: 0,
    plain: 1,
    fallback: 2
  }
  return compareNumbers(kindRank[a], kindRank[b])
}

export function compareSystemVersions(
  aRaw: string,
  bRaw: string
): CompareResult | null {
  const a = parseSystemVersion(aRaw)
  const b = parseSystemVersion(bRaw)
  if (a === null || b === null) {
    return null
  }

  const byParts = compareParts(a.parts, b.parts)
  if (byParts !== 0) {
    return byParts
  }

  const byKind = compareKind(a.kind, b.kind)
  if (byKind !== 0) {
    return byKind
  }

  if (a.kind === 'prerelease' && b.kind === 'prerelease') {
    const byOrder = compareNumbers(a.order, b.order)
    if (byOrder !== 0) {
      return byOrder
    }
    return compareNumbers(a.tail, b.tail)
  }

  if (a.kind === 'fallback' && b.kind === 'fallback') {
    if (a.lex < b.lex) return -1
    if (a.lex > b.lex) return 1
    return 0
  }

  return 0
}

export function systemVersionEquals(a: string, b: string): boolean {
  return compareSystemVersions(a, b) === 0
}
