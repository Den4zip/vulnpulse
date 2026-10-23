import type { MatchRecord, StackKind } from '@shared/types'
import { matchCpe, parseCpe23, type CpeParts } from './cpe'
import { matchPurl, parsePurl, type PackageIdentity, type Purl } from './purl'
import { systemVersionEquals } from './normalizer'
import { compareSemver } from './version'

export type { PackageIdentity }

export interface StackItemForMatch {
  id: number
  kind: StackKind
  name: string
  vendor: string | null
  product: string
  version: string | null
  cpe23: string | null
  purl: string | null
}

export interface VulnerabilityForMatch {
  id: number
  extId: string
  cpes: string[]
  packages: PackageIdentity[]
}

export type MatchSource = 'cpe' | 'purl'

export interface MatchResult extends MatchRecord {
  source: MatchSource
}

export interface MatchEngineResult {
  matches: MatchResult[]
  warnings: string[]
}

const CPE_CONFIDENCE = 1.0
const PURL_CONFIDENCE = 0.8

export function versionsEqual(a: string, b: string): boolean {
  const semverResult = compareSemver(a, b)
  if (semverResult !== null) {
    return semverResult === 0
  }
  return systemVersionEquals(a, b)
}

interface StackEntry {
  itemId: number
  cpe: CpeParts | null
  purl: Purl | null
}

export function matchStack(
  stackItems: readonly StackItemForMatch[],
  vulnerabilities: readonly VulnerabilityForMatch[]
): MatchEngineResult {
  const warnings: string[] = []
  const entries: StackEntry[] = []

  for (const item of stackItems) {
    let cpe: CpeParts | null = null
    let purl: Purl | null = null

    if (item.cpe23) {
      try {
        cpe = parseCpe23(item.cpe23)
      } catch (err) {
        warnings.push(`stack item ${item.id}: skipped CPE (${(err as Error).message})`)
      }
    }

    if (item.purl) {
      try {
        purl = parsePurl(item.purl)
      } catch (err) {
        warnings.push(`stack item ${item.id}: skipped PURL (${(err as Error).message})`)
      }
    }

    if (cpe !== null || purl !== null) {
      entries.push({ itemId: item.id, cpe, purl })
    } else {
      warnings.push(
        `stack item ${item.id}: no parsable CPE or PURL (name: ${item.name}) — cannot match`
      )
    }
  }

  const pairConfidence = new Map<string, MatchResult>()

  const record = (
    vulnerabilityId: number,
    stackItemId: number,
    source: MatchSource,
    confidence: number
  ): void => {
    const key = `${vulnerabilityId}:${stackItemId}`
    const existing = pairConfidence.get(key)
    if (existing !== undefined && existing.source === 'cpe') {
      return
    }
    pairConfidence.set(key, {
      vulnerabilityId,
      stackId: stackItemId,
      confidence,
      source
    })
  }

  for (const vuln of vulnerabilities) {
    for (const cpeUri of vuln.cpes) {
      let vulnCpe: CpeParts
      try {
        vulnCpe = parseCpe23(cpeUri)
      } catch (err) {
        warnings.push(`vulnerability ${vuln.extId}: skipped bad CPE (${(err as Error).message})`)
        continue
      }
      for (const entry of entries) {
        if (entry.cpe === null) continue
        if (matchCpe(vulnCpe, entry.cpe, versionsEqual)) {
          record(vuln.id, entry.itemId, 'cpe', CPE_CONFIDENCE)
        }
      }
    }

    for (const identity of vuln.packages) {
      for (const entry of entries) {
        if (entry.purl === null) continue
        if (matchPurl(entry.purl, identity, versionsEqual)) {
          record(vuln.id, entry.itemId, 'purl', PURL_CONFIDENCE)
        }
      }
    }
  }

  return {
    matches: [...pairConfidence.values()].sort(
      (a, b) => b.confidence - a.confidence || a.stackId - b.stackId
    ),
    warnings
  }
}
