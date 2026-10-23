import { describe, expect, it } from 'vitest'
import {
  matchStack,
  versionsEqual,
  type StackItemForMatch,
  type VulnerabilityForMatch
} from '@main/services/matcher/engine'

function stackItem(overrides: Partial<StackItemForMatch> = {}): StackItemForMatch {
  return {
    id: 1,
    kind: 'application',
    name: 'Apache HTTPD',
    vendor: 'apache',
    product: 'http_server',
    version: '2.4.57',
    cpe23: null,
    purl: null,
    ...overrides
  }
}

function vuln(overrides: Partial<VulnerabilityForMatch> = {}): VulnerabilityForMatch {
  return {
    id: 10,
    extId: 'CVE-2024-0001',
    cpes: [],
    packages: [],
    ...overrides
  }
}

describe('versionsEqual helper', () => {
  it('compares semver-aware versions', () => {
    expect(versionsEqual('1.2.3', 'v1.2.3')).toBe(true)
    expect(versionsEqual('1.2.3', '1.2.4')).toBe(false)
  })

  it('delegates to system normalizer for non-semver versions', () => {
    expect(versionsEqual('1_24', '1.24')).toBe(true)
    expect(versionsEqual('1.1.1d', '1.1.1d')).toBe(true)
    expect(versionsEqual('1.1.1c', '1.1.1d')).toBe(false)
  })

  it('returns false for garbage on both sides', () => {
    expect(versionsEqual('unknown', 'noside')).toBe(false)
  })
})

describe('matchStack — CPE path', () => {
  const stackA = stackItem({
    id: 1,
    cpe23: 'cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:*'
  })
  const stackOpenSSL = stackItem({
    id: 2,
    name: 'OpenSSL',
    vendor: 'openssl',
    product: 'openssl',
    version: '1.1.1d',
    cpe23: 'cpe:2.3:a:openssl:openssl:1.1.1d:*:*:*:*:*:*:*'
  })
  const stackPostgres = stackItem({
    id: 3,
    kind: 'system',
    name: 'PostgreSQL',
    vendor: 'postgresql',
    product: 'postgresql',
    version: '16_3',
    cpe23: 'cpe:2.3:a:postgresql:postgresql:16_3:*:*:*:*:*:*:*'
  })
  const items = [stackA, stackOpenSSL, stackPostgres]

  it('match satisfies exact CPE versions', () => {
    const result = matchStack(items, [
      vuln({ cpes: ['cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:*'] })
    ])
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({
      vulnerabilityId: 10,
      stackId: 1,
      confidence: 1.0,
      source: 'cpe'
    })
    expect(result.warnings).toHaveLength(0)
  })

  it('vuln wildcard version matches concrete stack version', () => {
    const result = matchStack(items, [
      vuln({ cpes: ['cpe:2.3:a:apache:http_server:*:*:*:*:*:*:*:*'] })
    ])
    expect(result.matches.map((m) => m.stackId)).toEqual([1])
  })

  it('different product does not match', () => {
    const result = matchStack(items, [
      vuln({ cpes: ['cpe:2.3:a:nginx:http_server:2.4.57:*:*:*:*:*:*:*'] })
    ])
    expect(result.matches).toHaveLength(0)
  })

  it('matches openssl letter levels only on exact level', () => {
    const affected = matchStack(items, [
      vuln({ id: 11, cpes: ['cpe:2.3:a:openssl:openssl:1.1.1d:*:*:*:*:*:*:*'] })
    ])
    expect(affected.matches.map((m) => m.stackId)).toEqual([2])

    const notAffected = matchStack(items, [
      vuln({ id: 12, cpes: ['cpe:2.3:a:openssl:openssl:1.1.1c:*:*:*:*:*:*:*'] })
    ])
    expect(notAffected.matches).toHaveLength(0)
  })

  it('normalizes separator-involved product versions', () => {
    const result = matchStack(items, [
      vuln({ id: 13, cpes: ['cpe:2.3:a:postgresql:postgresql:16.3:*:*:*:*:*:*:*'] })
    ])
    expect(result.matches.map((m) => m.stackId)).toEqual([3])
  })

  it('cross product of several vulnerabilities', () => {
    const result = matchStack(items, [
      vuln({ id: 11, extId: 'CVE-A', cpes: ['cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:*'] }),
      vuln({ id: 12, extId: 'CVE-B', cpes: ['cpe:2.3:a:openssl:openssl:1.1.1d:*:*:*:*:*:*:*'] })
    ])
    expect(result.matches).toHaveLength(2)
    const pairs = result.matches.map((m) => `${m.vulnerabilityId}:${m.stackId}`)
    expect(pairs).toEqual(expect.arrayContaining(['11:1', '12:2']))
  })
})

describe('matchStack — PURL path', () => {
  const stackPypi = stackItem({
    id: 5,
    name: 'Django',
    product: 'django-utils',
    version: '4.2.11',
    cpe23: null,
    purl: 'pkg:pypi/django-utils@4.2.11'
  })
  const stackNpm = stackItem({
    id: 6,
    name: 'Babel core',
    vendor: 'babel',
    product: 'core',
    version: '7.24.0',
    cpe23: null,
    purl: 'pkg:npm/%40babel/core@7.24.0'
  })

  it('matches purl identity with equivalent pypi naming', () => {
    const result = matchStack([stackPypi], [
      vuln({
        id: 20,
        extId: 'GHSA-x1y2',
        packages: [{ type: 'pypi', namespace: '', name: 'django_utils', version: '4.2.11' }]
      })
    ])
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ stackId: 5, confidence: 0.8, source: 'purl' })
  })

  it('rejects different versions in purl matching', () => {
    const result = matchStack([stackPypi], [
      vuln({
        id: 21,
        packages: [{ type: 'pypi', namespace: '', name: 'django-utils', version: '4.2.12' }]
      })
    ])
    expect(result.matches).toHaveLength(0)
  })

  it('matches scoped npm purl', () => {
    const result = matchStack([stackNpm], [
      vuln({
        id: 22,
        packages: [{ type: 'npm', namespace: '@babel', name: 'core', version: '7.24.0' }]
      })
    ])
    expect(result.matches.map((m) => m.stackId)).toEqual([6])
  })

  it('collapses duplicate package identities into one match', () => {
    const result = matchStack([stackPypi], [
      vuln({
        id: 23,
        packages: [
          { type: 'pypi', namespace: '', name: 'django_utils', version: '4.2.11' },
          { type: 'pypi', namespace: '', name: 'django-utils', version: '4.2.11' }
        ]
      })
    ])
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ source: 'purl', confidence: 0.8 })
  })

  it('skips entries lacking the opposite identifier type', () => {
    const cpeOnly = stackItem({
      id: 11,
      cpe23: 'cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:*',
      purl: null
    })
    const purlOnly = stackItem({
      id: 12,
      cpe23: null,
      purl: 'pkg:pypi/django-utils@4.2.11',
      vendor: 'django',
      product: 'django-utils'
    })

    const cpeVulnHit = matchStack([purlOnly], [
      vuln({ cpes: ['cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:*'] })
    ])
    expect(cpeVulnHit.matches).toHaveLength(0)

    const purlVulnHit = matchStack([cpeOnly], [
      vuln({ packages: [{ type: 'pypi', namespace: '', name: 'django-utils', version: '4.2.11' }] })
    ])
    expect(purlVulnHit.matches).toHaveLength(0)

    const doubleHit = matchStack([cpeOnly, purlOnly], [
      vuln({
        cpes: ['cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:*'],
        packages: [{ type: 'pypi', namespace: '', name: 'django-utils', version: '4.2.11' }]
      })
    ])
    expect(doubleHit.matches.map((m) => m.stackId).sort()).toEqual([11, 12])
  })
})

describe('matchStack — dedup & resilience', () => {
  it('prefers higher-confidence CPE source when both paths hit', () => {
    const item = stackItem({
      id: 7,
      cpe23: 'cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:*',
      purl: null
    })
    const itemWithBoth = { ...item, id: 7, purl: 'pkg:generic/apache/httpd@2.4.57' }
    const result = matchStack(
      [itemWithBoth],
      [
        vuln({
          cpes: ['cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:*'],
          packages: [{ type: 'generic', namespace: 'apache', name: 'httpd', version: '2.4.57' }]
        })
      ]
    )
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ source: 'cpe', confidence: 1.0 })
  })

  it('skips stack entries without CPE or PURL and warns', () => {
    const bare = stackItem({ id: 8, cpe23: null, purl: null })
    const result = matchStack([bare], [vuln({ cpes: ['cpe:2.3:a:x:y:1.0:*:*:*:*:*:*:*'] })])
    expect(result.matches).toHaveLength(0)
    expect(result.warnings.some((w) => w.includes('8'))).toBe(true)
  })

  it('skips invalid CPE/PURL of stack and vulnerabilities with warnings', () => {
    const badItem = stackItem({ id: 9, cpe23: 'cpe:2.3:a:broken', purl: 'pkg:npm' })
    const result = matchStack([badItem], [
      vuln({ id: 30, cpes: ['cpe:/a:legacy:uri'] })
    ])
    expect(result.matches).toHaveLength(0)
    expect(result.warnings.length).toBeGreaterThanOrEqual(3)
  })

  it('empty inputs produce empty output', () => {
    expect(matchStack([], [])).toEqual({ matches: [], warnings: [] })
  })
})
