import { Severity } from '@shared/enums'

export interface NvdCve extends Record<string, unknown> {
  id: string
  published: string
  lastModified: string
  descriptions: Array<{ lang: string; value: string }>
}

export interface NvdPage {
  startIndex: number
  resultsPerPage: number
  totalResults: number
  vulnerabilities: unknown[]
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** NVD returns UTC dates, commonly without the optional Z suffix. Reject rollover. */
export function nvdTime(value: unknown): number {
  if (typeof value !== 'string') return NaN
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?Z?$/.exec(value)
  if (!match) return NaN
  const time = Date.parse(value.endsWith('Z') ? value : `${value}Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === match[1] ? time : NaN
}

export function nvdPage(value: unknown): NvdPage {
  if (!object(value)) throw new Error('Invalid NVD page')
  const { startIndex, resultsPerPage, totalResults, vulnerabilities } = value
  if (!Number.isSafeInteger(startIndex) || (startIndex as number) < 0
    || !Number.isSafeInteger(resultsPerPage) || (resultsPerPage as number) < 0 || (resultsPerPage as number) > 2000
    || !Number.isSafeInteger(totalResults) || (totalResults as number) < 0
    || !Array.isArray(vulnerabilities) || vulnerabilities.length !== resultsPerPage
    || (vulnerabilities.length > 0 && (startIndex as number) + vulnerabilities.length > (totalResults as number))
    || (vulnerabilities.length === 0 && (startIndex as number) < (totalResults as number))) {
    throw new Error('Invalid NVD page metadata')
  }
  return value as unknown as NvdPage
}

interface Score { cvssScore: number; cvssVector: string; severity: Severity }

/** Deterministic display score; original metrics and provenance stay in raw JSON. */
export function nvdScore(cve: NvdCve): Score | null {
  if (cve.metrics === undefined) return null
  if (!object(cve.metrics)) throw new Error('Invalid NVD metrics')
  const candidates: Array<Score & { rank: string }> = []
  for (const [priority, key, version] of [
    [0, 'cvssMetricV40', '4.0'], [1, 'cvssMetricV31', '3.1'],
    [2, 'cvssMetricV30', '3.0'], [3, 'cvssMetricV2', '2.0']
  ] as const) {
    const metrics = cve.metrics[key]
    if (metrics === undefined) continue
    if (!Array.isArray(metrics)) throw new Error('Invalid NVD metrics')
    for (const metric of metrics) {
      if (!object(metric) || typeof metric.source !== 'string' || !metric.source
        || !['Primary', 'Secondary'].includes(metric.type as string) || !object(metric.cvssData)) {
        throw new Error('Invalid NVD metric')
      }
      const data = metric.cvssData
      if (data.version !== version || typeof data.baseScore !== 'number' || !Number.isFinite(data.baseScore)
        || data.baseScore < 0 || data.baseScore > 10 || typeof data.vectorString !== 'string'
        || !(version === '2.0' ? /^(?:CVSS:2\.0\/)?AV:/.test(data.vectorString)
          : data.vectorString.startsWith(`CVSS:${version}/`))) throw new Error('Invalid NVD score')
      const score = data.baseScore
      const severity = score === 0 ? Severity.None : score < 4 ? Severity.Low
        : score < 7 ? Severity.Medium : version !== '2.0' && score >= 9 ? Severity.Critical : Severity.High
      candidates.push({ cvssScore: score, cvssVector: data.vectorString, severity,
        rank: `${priority}:${metric.type === 'Primary' ? 0 : 1}:${metric.source}:${data.vectorString}` })
    }
  }
  candidates.sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0)
  const best = candidates[0]
  return best ? { cvssScore: best.cvssScore, cvssVector: best.cvssVector, severity: best.severity } : null
}

/** Validate fields we consume; unsupported applicability data remains opaque. */
export function nvdCve(value: unknown): NvdCve {
  if (!object(value) || typeof value.id !== 'string' || !/^CVE-\d{4}-\d{4,19}$/.test(value.id)
    || !Number.isFinite(nvdTime(value.published)) || !Number.isFinite(nvdTime(value.lastModified))
    || nvdTime(value.lastModified) < nvdTime(value.published)
    || !Array.isArray(value.descriptions) || value.descriptions.some((d) =>
      !object(d) || typeof d.lang !== 'string' || typeof d.value !== 'string')
    || !Array.isArray(value.references) || value.references.some((r) => !object(r) || typeof r.url !== 'string')) {
    throw new Error('Invalid NVD CVE')
  }
  const cve = value as NvdCve
  nvdScore(cve)
  return cve
}
