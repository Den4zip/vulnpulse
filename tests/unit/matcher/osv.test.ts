import { describe, expect, it } from 'vitest'
import { matchStack, type StackItemForMatch, type VulnerabilityForMatch } from '@main/services/matcher/engine'
import { evaluateOsv, isOsvSemver, osvPackageName } from '@main/services/matcher/osv'
import { parseOsvApplicability } from '@main/services/feeds/osv-applicability'

const affected = (changes: Record<string, unknown> = {}) => ({ package: { ecosystem: 'npm', name: 'demo' },
  ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.0.0' }] }], ...changes })
const raw = (entries: unknown[] = [affected()], changes: Record<string, unknown> = {}) => ({ id: 'GHSA-test-unit-0001',
  modified: '2026-11-06T00:00:00.123456Z', schema_version: '1.7.0', affected: entries, ...changes })
const item = (version = '1.0.0', changes: Partial<StackItemForMatch> = {}): StackItemForMatch => ({ id: 1,
  kind: 'package', name: 'demo', product: 'demo', vendor: null, version, purl: `pkg:npm/demo@${version}`, cpe23: null, ...changes })
const vuln = (record: unknown): VulnerabilityForMatch => ({ id: 10, extId: 'GHSA-test-unit-0001',
  packages: [], cpes: [], osvApplicability: parseOsvApplicability(record) })
const result = (record: unknown, inventory = item()) => matchStack([inventory], [vuln(record)])
const decision = (record: unknown, inventory = item()) => result(record, inventory).assessments[0]
const range = (events: unknown[], type = 'SEMVER') => raw([affected({ ranges: [{ type, events }] })])

describe('OSV local matcher', () => {
  it('returns package/source/version evidence and the existing PURL match weight', () => {
    const found = result(raw())
    expect(found.matches).toEqual([{ vulnerabilityId: 10, stackId: 1, confidence: 0.8, source: 'purl' }])
    expect(found.assessments[0]).toEqual({ status: 'match', reason: 'affected_range', advisoryId: 'GHSA-test-unit-0001',
      packageName: 'demo', evaluatedVersion: '1.0.0', rangeIndex: 0, vulnerabilityId: 10, stackId: 1, source: 'osv', matcherVersion: 'osv-local-v1' })
  })
  it.each([
    ['0.0.1-alpha', 'match'], ['1.9.9', 'match'], ['2.0.0-alpha', 'match'], ['2.0.0', 'no_match'], ['2.0.1', 'no_match']
  ])('uses SemVer precedence, including prereleases, for %s', (version, status) => expect(decision(raw(), item(version)).status).toBe(status))

  it('honors introduced, fixed, last_affected and open intervals', () => {
    const introduced = range([{ introduced: '1.0.0' }, { fixed: '2.0.0' }])
    expect(decision(introduced, item('1.0.0-alpha')).status).toBe('no_match')
    expect(decision(introduced).status).toBe('match')
    const ceiling = range([{ introduced: '1.0.0' }, { last_affected: '2.0.0' }])
    expect(decision(ceiling, item('2.0.0')).status).toBe('match')
    expect(decision(ceiling, item('2.0.1')).status).toBe('no_match')
    expect(decision(range([{ introduced: '0' }]), item('999.0.0')).status).toBe('match')
  })

  it('sorts events and supports disjoint and adjacent intervals', () => {
    const disjoint = range([{ fixed: '4.0.0' }, { introduced: '3.0.0' }, { fixed: '2.0.0' }, { introduced: '1.0.0' }])
    expect(decision(disjoint, item('2.5.0')).status).toBe('no_match')
    expect(decision(disjoint, item('3.0.0')).status).toBe('match')
    const adjacent = range([{ introduced: '0' }, { fixed: '1.0.0' }, { introduced: '1.0.0' }])
    expect(decision(adjacent).status).toBe('match')
  })

  it('supplements ranges with explicit versions and ignores build metadata for npm', () => {
    const explicit = raw([affected({ versions: ['3.0.0'] })])
    expect(decision(explicit, item('3.0.0')).reason).toBe('affected_version')
    expect(decision(explicit, item('3.0.0+build')).reason).toBe('affected_version')
    expect(decision(raw([affected({ versions: ['3.0.0'], ranges: [] })])).status).toBe('no_match')
    expect(decision(raw([affected({ versions: ['not-semver'], ranges: [] })])).status).toBe('unknown')
  })

  it.each(['PyPI', 'Maven'])('matches explicit versions without inventing %s ordering', (ecosystem) => {
    const name = ecosystem === 'PyPI' ? 'Demo_Pkg' : 'org.example:Demo'
    const purl = ecosystem === 'PyPI' ? 'pkg:pypi/demo-pkg@1.0' : 'pkg:maven/org.example/Demo@1.0'
    const entry = affected({ package: { ecosystem, name }, versions: ['1.0'], ranges: [] })
    expect(decision(raw([entry]), item('1.0', { purl })).status).toBe('match')
    expect(decision(raw([entry]), item('1.0.0', { purl: purl.replace('@1.0', '@1.0.0') })).status).toBe('unknown')
    expect(decision(raw([affected({ package: { ecosystem, name } })]), item('1.0', { purl })).status).toBe('unknown')
  })

  it('compares scoped npm and Maven case correctly and separates package identities', () => {
    expect(decision(raw([affected({ package: { ecosystem: 'npm', name: '@Scope/Demo' } })]),
      item('1.0.0', { purl: 'pkg:npm/%40scope/demo@1.0.0' })).status).toBe('match')
    expect(decision(raw(), item('1.0.0', { purl: 'pkg:npm/other@1.0.0' })).status).toBe('no_match')
    expect(decision(raw(), item('1.0.0', { purl: 'pkg:pypi/demo@1.0.0' })).status).toBe('no_match')
    expect(decision(raw([affected({ package: { ecosystem: 'Maven', name: 'org.example:Demo' }, versions: ['1.0'], ranges: [] })]),
      item('1.0', { purl: 'pkg:maven/org.example/demo@1.0' })).status).toBe('no_match')
  })

  it.each(['v1.0.0', '1.0', '1.0.0-01', '*', '-', ''])('does not coerce inventory version %s into SemVer', (version) => {
    expect(decision(raw(), item(version)).status).toBe('unknown')
  })

  it('uses a separate version, detects conflicts, and rejects unknown package variants', () => {
    expect(decision(raw(), item('1.0.0', { purl: 'pkg:npm/demo' })).status).toBe('match')
    expect(decision(raw(), item('1.0.0', { version: null })).status).toBe('match')
    expect(decision(raw(), item('1.0.0', { purl: 'pkg:npm/demo', version: null })).status).toBe('unknown')
    expect(decision(raw(), item('2.0.0', { purl: 'pkg:npm/demo@1.0.0' })).reason).toBe('ambiguous_version')
    expect(decision(raw(), item('1.0.0', { purl: 'pkg:npm/demo@1.0.0?arch=x64' })).reason).toBe('unsupported_package')
    expect(decision(raw(), item('1.0.0', { purl: 'pkg:npm/demo@1.0.0#src' })).reason).toBe('unsupported_package')
    expect(decision(raw(), item('1.0.0', { purl: null })).reason).toBe('missing_inventory')
    expect(decision(raw(), item('1.0.0', { purl: 'pkg:cargo/demo@1.0.0' })).reason).toBe('unsupported_package')
    expect(decision(raw(), item('1.0.0', { purl: 'pkg:npm/%2A@1.0.0' })).reason).toBe('invalid_package')
    expect(decision(raw(), item('1.0.0', { purl: 'pkg:pypi/namespace/demo@1.0.0' })).reason).toBe('invalid_package')
    expect(decision(raw(), item('1.0.0', { purl: 'pkg:npm/%40scope%2Fdemo@1.0.0' })).reason).toBe('invalid_package')
    expect(decision(raw(), item('1.0.0', { purl: 'pkg:npm/demo@1.0.0?__proto__=variant' })).reason).toBe('unsupported_package')
    expect(decision(raw(), item(' 1.0.0', { purl: 'pkg:npm/demo' })).reason).toBe('ambiguous_version')
    expect(decision(raw(), item('1'.repeat(257), { purl: 'pkg:npm/demo' })).reason).toBe('ambiguous_version')
  })

  it('preserves unknown branches without allowing a flat package list to bypass them', () => {
    const unknown = range([{ introduced: '0' }, { fixed: '2.0.0' }], 'ECOSYSTEM')
    const v = vuln(unknown)
    v.packages = [{ type: 'npm', namespace: '', name: 'demo', version: '1.0.0' }]
    expect(matchStack([item()], [v]).matches).toHaveLength(0)
    expect(decision(range([{ introduced: 'hash' }], 'GIT')).status).toBe('unknown')
    expect(decision(range([{ introduced: '0' }, { limit: '2.0.0' }])).status).toBe('unknown')
    expect(decision(raw([affected({ ranges: [{ type: 'GIT', events: [{ introduced: 'hash' }] }], versions: ['1.0.0'] })])).status).toBe('match')
    expect(decision(raw([{}, affected()])).status).toBe('match')
    expect(decision(raw([{}, affected({ package: { ecosystem: 'npm', name: 'other' } })])).status).toBe('unknown')
  })

  it('keeps withdrawn and missing applicability unknown, never silently patched', () => {
    expect(decision(raw(undefined, { withdrawn: '2026-11-05T00:00:00Z' })).reason).toBe('withdrawn')
    expect(decision(raw([])).reason).toBe('missing_conditions')
    expect(decision(raw([affected({ versions: [], ranges: [] })])).reason).toBe('missing_conditions')
    expect(decision(null).reason).toBe('invalid_source')
  })

  it('retains independent NVD evidence when OSV is also evaluated', () => {
    const v = vuln(raw())
    v.cpes = ['cpe:2.3:a:vendor:demo:1.0.0:*:*:*:*:*:*:*']
    const found = matchStack([item('1.0.0', { cpe23: v.cpes[0] })], [v])
    expect(found.matches).toHaveLength(1)
    expect(found.matches[0].source).toBe('cpe')
  })
})

describe('OSV unsupported and malformed conditions', () => {
  it.each([
    [], [{ fixed: '2.0.0' }], [{ introduced: 'v1.0.0' }], [{ introduced: '1.0.0', fixed: '2.0.0' }],
    [null], [{ nonsense: '1.0.0' }], [{ introduced: 0 }], [{ introduced: '1.0.0' }, { introduced: '1.5.0' }],
    [{ introduced: '0' }, { fixed: '1.0.0' }, { fixed: '2.0.0' }],
    [{ introduced: '0' }, { fixed: '1.0.0' }, { last_affected: '2.0.0' }],
    [{ introduced: '0' }, { last_affected: '1.0.0' }, { introduced: '1.0.0' }],
    Array(257).fill({ introduced: '0' })
  ])('does not treat invalid events as safe: %j', (events) => expect(decision(range(events)).status).toBe('unknown'))

  it.each([
    null, { package: null }, { package: { ecosystem: 'npm' } }, { package: { ecosystem: 'Go', name: 'demo' } },
    { package: { ecosystem: 'npm', name: 'demo', purl: 'pkg:npm/other' } },
    { package: { ecosystem: 'npm', name: 'demo', purl: 'broken' } },
    { package: { ecosystem: 'npm', name: 'demo', purl: 'pkg:npm/demo@1.0.0' } },
    { package: { ecosystem: 'npm', name: 'demo', purl: 'pkg:npm/demo?arch=x64' } },
    { package: { ecosystem: 'npm', name: 'demo', purl: 'pkg:npm/demo#src' } },
    { package: { ecosystem: 'npm', name: 'demo', purl: 1 } },
    { package: { ecosystem: 'PyPI', name: 'demo', purl: 'pkg:pypi/namespace/demo' } },
    { package: { ecosystem: 'npm', name: '@scope/demo', purl: 'pkg:npm/%40scope%2Fdemo' } },
    affected({ versions: [''] }), affected({ versions: [1] }), affected({ versions: '1.0.0' }), affected({ ranges: {} }),
    affected({ versions: Array(8193).fill('1.0.0') }), affected({ ranges: [null] }),
    affected({ ranges: Array(40).fill({ type: 'SEMVER', events: Array(256).fill({ introduced: '0' }) }) })
  ])('retains unsupported affected entries as unknown: %j', (entry) => expect(decision(raw([entry])).status).toBe('unknown'))

  it('checks a consistent source PURL', () => {
    expect(decision(raw([affected({ package: { ecosystem: 'npm', name: 'demo', purl: 'pkg:npm/demo' } })])).status).toBe('match')
  })

  it('keeps the trusted empty IR and package normalization explicit', () => {
    expect(evaluateOsv({ kind: 'advisory', advisoryId: 'test', withdrawn: false, affected: [] }, null, null).status).toBe('unknown')
    expect(isOsvSemver('1.0.0')).toBe(true)
    expect(osvPackageName('npm', 'not/valid/name')).toBeNull()
    expect(osvPackageName('PyPI', '-bad')).toBeNull()
    expect(osvPackageName('Maven', 'bad')).toBeNull()
    expect(osvPackageName('Go', 'demo')).toBeNull()
  })
})
