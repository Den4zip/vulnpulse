import { describe, expect, it } from 'vitest'
import { parseCpe23 } from '@main/services/matcher/cpe'
import { matchStack, type StackItemForMatch, type VulnerabilityForMatch } from '@main/services/matcher/engine'
import { compareNvdVersions, evaluateNvd } from '@main/services/matcher/nvd'
import type { NvdApplicability } from '@main/services/matcher/nvd-types'
import { parseNvdApplicability } from '@main/services/feeds/nvd-applicability'

const ID = '12345678-1234-1234-1234-123456789abc'
const cpe = (version = '*', vendor = 'apache', product = 'http_server', rest = '*:*:*:*:*:*:*') =>
  `cpe:2.3:a:${vendor}:${product}:${version}:${rest}`
const criterion = (changes: Record<string, unknown> = {}) => ({ vulnerable: true, criteria: cpe(), matchCriteriaId: ID, ...changes })
const payload = (matches: unknown[] = [criterion()]) => ({ configurations: [{ nodes: [{ operator: 'OR', cpeMatch: matches }] }] })
const item = (version = '2.4.57', changes: Partial<StackItemForMatch> = {}): StackItemForMatch => ({
  id: 1, kind: 'application', name: 'HTTPD', vendor: 'apache', product: 'http_server',
  version, cpe23: cpe(version), purl: null, ...changes
})
const vulnerability = (raw: unknown): VulnerabilityForMatch => ({ id: 10, extId: 'CVE-2024-0001',
  cpes: [], packages: [], nvdApplicability: parseNvdApplicability(raw) })
const assess = (raw: unknown, inventory = item()) => matchStack([inventory], [vulnerability(raw)])
const decision = (raw: unknown, inventory = item()) => assess(raw, inventory).assessments[0]
const leaf = (): Extract<NvdApplicability, { kind: 'cpe' }> => ({ kind: 'cpe',
  criteria: cpe(), matchCriteriaId: ID, cpe: parseCpe23(cpe()) })

describe('NVD positive OR applicability through the matcher boundary', () => {
  it('matches an exact CPE with source criterion evidence', () => {
    const result = assess(payload([criterion({ criteria: cpe('2.4.57') })]))
    expect(result.matches).toEqual([{ vulnerabilityId: 10, stackId: 1, confidence: 1, source: 'cpe' }])
    expect(result.assessments).toEqual([{ status: 'match', reason: 'criteria_matched', vulnerabilityId: 10,
      stackId: 1, source: 'nvd', matcherVersion: 'nvd-cpe-v1', criteria: cpe('2.4.57'), matchCriteriaId: ID, evaluatedVersion: '2.4.57' }])
  })

  it.each([
    ['versionStartIncluding', '2.4.57', 'match'], ['versionStartExcluding', '2.4.57', 'no_match'],
    ['versionEndIncluding', '2.4.57', 'match'], ['versionEndExcluding', '2.4.57', 'no_match'],
    ['versionStartIncluding', '2.4.56', 'match'], ['versionStartExcluding', '2.4.56', 'match'],
    ['versionStartIncluding', '2.4.58', 'no_match'], ['versionEndIncluding', '2.4.58', 'match'],
    ['versionEndExcluding', '2.4.58', 'match'], ['versionEndIncluding', '2.4.56', 'no_match']
  ])('honors %s=%s at a boundary', (key, value, status) => {
    expect(decision(payload([criterion({ [key]: value })])).status).toBe(status)
  })

  it('uses both ends and never flattens a version range into an any-version match', () => {
    const raw = payload([criterion({ versionStartIncluding: '2.4.50', versionEndExcluding: '2.4.58' })])
    expect(decision(raw, item('2.4.49')).status).toBe('no_match')
    expect(decision(raw, item('2.4.57')).status).toBe('match')
    expect(decision(raw, item('2.4.58')).status).toBe('no_match')
  })

  it('does not infer ordering for letter suffixes or distro/prerelease revisions', () => {
    const raw = payload([criterion({ versionEndExcluding: '1.1.1f' })])
    expect(decision(raw, item('1.1.1d'))).toMatchObject({ status: 'unknown', reason: 'unsupported_version' })
    expect(decision(raw, item('1.1.1f')).status).toBe('no_match')
    expect(decision(payload([criterion({ criteria: cpe('1.0.dev') })]), item('1.0.alpha')).status).toBe('no_match')
    expect(decision(payload([criterion({ versionEndIncluding: '2.0.0' })]), item('1.0.0-rc1')).status).toBe('unknown')
  })

  it('can disprove one supported bound even if another bound has unknown ordering', () => {
    const raw = payload([criterion({ versionStartIncluding: '2.0.0-beta', versionEndExcluding: '2.4.57' })])
    expect(decision(raw).status).toBe('no_match')
  })

  it.each([
    { versionStartIncluding: '3.0', versionEndIncluding: '2.0' },
    { versionStartIncluding: '2.0', versionEndExcluding: '2.0' },
    { versionStartExcluding: '2.0', versionEndIncluding: '2.0' },
    { versionStartIncluding: '2', versionStartExcluding: '1' },
    { versionEndIncluding: '2', versionEndExcluding: '3' },
    { versionStartIncluding: '' }, { versionEndIncluding: null }, { versionEndExcluding: '*' },
    { versionEndExcluding: '-' }, { versionEndExcluding: '1'.repeat(1025) }, { versionEndExcluding: ' 1.0' }
  ])('does not turn inconsistent or malformed bounds into absence: %j', (changes) => {
    expect(decision(payload([criterion(changes)]))).toMatchObject({ status: 'unknown', reason: 'invalid_range' })
  })

  it('accepts a closed point interval and unknown ordering between suffix boundaries', () => {
    expect(decision(payload([criterion({ versionStartIncluding: '2.4.57', versionEndIncluding: '2.4.57' })])).status).toBe('match')
    expect(decision(payload([criterion({ versionStartIncluding: '1.0a', versionEndIncluding: '2.0a' })])).status).toBe('unknown')
  })

  it.each([
    ['3.0.0', 'no_match'], ['*', 'unknown'], ['2.*', 'unknown'], ['?', 'unknown'],
    ['-', 'no_match'], ['x'.repeat(1025), 'unknown']
  ])('handles version %s conservatively', (version, status) => {
    const raw = payload([criterion({ criteria: cpe('2.4.57') })])
    expect(decision(raw, item(version)).status).toBe(status)
  })

  it('uses the explicit inventory version for ANY, rejects contradictory version fields', () => {
    expect(decision(payload(), item('2.4.57', { cpe23: cpe('*') })).status).toBe('match')
    expect(decision(payload(), item('2.4.58', { cpe23: cpe('2.4.57') }))).toMatchObject({ status: 'unknown', reason: 'ambiguous_version' })
    expect(decision(payload(), item('2.4.57', { version: null })).status).toBe('match')
    expect(decision(payload(), item('2.4.57', { version: null, cpe23: cpe('*') })).status).toBe('unknown')
    expect(decision(payload(), item('', { cpe23: cpe('*') })).status).toBe('unknown')
    expect(decision(payload(), item(' 2.4.57', { cpe23: cpe('*') })).status).toBe('unknown')
  })

  it('handles NA explicitly and rejects unknown identity fields as proof of a match', () => {
    expect(decision(payload([criterion({ criteria: cpe('-') })]), item('-')).status).toBe('match')
    expect(decision(payload(), item('-')).status).toBe('unknown')
    expect(decision(payload(), item('2.4.57', { cpe23: cpe('2.4.57', '*') })).status).toBe('unknown')
    expect(decision(payload(), item('2.4.57', { cpe23: cpe('2.4.57', 'nginx') })).status).toBe('no_match')
    expect(decision(payload(), item('2.4.57', { cpe23: cpe('2.4.57', '-', '-') })).status).toBe('no_match')
    expect(decision(payload(), item('2.4.57', { cpe23: cpe('2.4.57', 'apa*') })).status).toBe('unknown')
    expect(decision(payload(), item('2.4.57', { cpe23: cpe('2.4.57', 'ap?che') })).status).toBe('unknown')
  })

  it('requires the remaining CPE attributes too, including target software and hardware', () => {
    const raw = payload([criterion({ criteria: cpe('*', 'apache', 'http_server', '*:*:*:*:linux:x64:*') })])
    expect(decision(raw, item()).status).toBe('unknown')
    expect(decision(raw, item('2.4.57', { cpe23: cpe('2.4.57', 'apache', 'http_server', '*:*:*:*:linux:x64:*') })).status).toBe('match')
    expect(decision(raw, item('2.4.57', { cpe23: cpe('2.4.57', 'apache', 'http_server', '*:*:*:*:windows:x64:*') })).status).toBe('no_match')
  })

  it('reports unknown for a missing or broken CPE, even if PURL is present', () => {
    expect(decision(payload(), item('2.4.57', { cpe23: null })).reason).toBe('missing_inventory')
    expect(decision(payload(), item('2.4.57', { cpe23: 'cpe:broken', purl: 'pkg:npm/foo@2.4.57' })).reason).toBe('missing_inventory')
  })

  it('combines OR alternatives using three-valued logic', () => {
    const miss = criterion({ criteria: cpe('*', 'other') })
    const uncertain = criterion({ vulnerable: false })
    expect(decision(payload([miss, uncertain, criterion()])).status).toBe('match')
    expect(decision(payload([miss, uncertain])).status).toBe('unknown')
    expect(decision(payload([miss])).status).toBe('no_match')
    expect(decision({ configurations: [{ operator: 'OR', nodes: [{ operator: 'OR', cpeMatch: [miss] },
      { operator: 'OR', cpeMatch: [criterion()] }] }] }).status).toBe('match')
  })

  it('never bypasses AND or negation via a supplied flattened CPE list', () => {
    for (const group of [{ operator: 'AND' }, { operator: 'OR', negate: true }]) {
      const raw = { configurations: [{ ...group, nodes: [{ operator: 'OR', cpeMatch: [criterion()] }] }] }
      const v = { ...vulnerability(raw), cpes: [cpe()] }
      const result = matchStack([item(), item('2.4.57', { id: 2 })], [v])
      expect(result.matches).toHaveLength(0)
      expect(result.assessments.map((d) => d.status)).toEqual(['unknown', 'unknown'])
    }
  })

  it('deduplicates NVD and PURL evidence while retaining the NVD assessment', () => {
    const v = vulnerability(payload())
    v.packages = [{ type: 'npm', namespace: '', name: 'foo', version: '2.4.57' }]
    const result = matchStack([item('2.4.57', { purl: 'pkg:npm/foo@2.4.57' })], [v])
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].source).toBe('cpe')
    expect(result.assessments).toHaveLength(1)
  })
})

describe('NVD bounded parser resilience', () => {
  it.each([
    null, [], {}, { configurations: [] }, { configurations: {} }, { configurations: [null] },
    { configurations: [{ nodes: [] }] }, { configurations: [{ nodes: [{ operator: 'OR', cpeMatch: [] }] }] },
    { configurations: [{ nodes: [{ operator: 'XOR', cpeMatch: [criterion()] }] }] },
    { configurations: [{ negate: 'false', nodes: [] }] },
    { configurations: [{ nodes: [{ operator: 'OR', negate: 0, cpeMatch: [] }] }] },
    { configurations: [{ operator: 'XOR', nodes: [] }] },
    { configurations: [{ nodes: [{ operator: 'OR', cpeMatch: [criterion()] }, { operator: 'OR', cpeMatch: [criterion()] }] }] },
    { configurations: [{ nodes: [{ operator: 'OR', children: [], cpeMatch: [criterion()] }] }] },
    { configurations: [{ futureCondition: {}, nodes: [{ operator: 'OR', cpeMatch: [criterion()] }] }] }
  ])('retains malformed or missing conditions as unknown: %j', (raw) => {
    expect(decision(raw).status).toBe('unknown')
  })

  it.each([
    null, { ...criterion(), vulnerable: 'true' }, { ...criterion(), criteria: 1 },
    { ...criterion(), matchCriteriaId: 'not-uuid' }, { ...criterion(), futureVersionCondition: 'x' },
    criterion({ criteria: 'cpe:/a:apache:httpd' }), criterion({ criteria: cpe('2.*') }),
    criterion({ criteria: cpe('2.4.?') }), criterion({ criteria: cpe('2\\.4') }), criterion({ criteria: cpe(' 2') }),
    criterion({ criteria: cpe('2'.repeat(1025)) })
  ])('does not silently discard an invalid or unsupported leaf: %j', (entry) => {
    expect(decision(payload([entry])).status).toBe('unknown')
  })

  it('keeps missing, environmental, rejected, and negated statements distinct', () => {
    expect(decision({}).reason).toBe('missing_configuration')
    expect(decision({ ...payload(), vulnStatus: 'Rejected' }).reason).toBe('rejected_record')
    expect(decision(payload([criterion({ vulnerable: false })])).reason).toBe('unsupported_logic')
    expect(decision({ configurations: [{ nodes: [{ operator: 'AND', cpeMatch: [criterion()] }] }] }).reason).toBe('unsupported_logic')
    expect(decision({ configurations: [{ nodes: [{ operator: 'OR', negate: true, cpeMatch: [criterion()] }] }] }).reason).toBe('unsupported_logic')
  })

  it('bounds parser work, even for broad or deeply nested future input', () => {
    expect(decision({ configurations: Array(4097).fill({}) }).status).toBe('unknown')
    expect(decision(payload(Array(4096).fill(criterion()))).status).toBe('unknown')
    let nested: unknown = criterion()
    for (let i = 0; i < 1000; i++) nested = { operator: 'OR', children: [nested] }
    expect(decision({ configurations: [{ nodes: [nested] }] }).status).toBe('unknown')
  })
})

describe('numeric NVD comparator and trusted IR edge cases', () => {
  it.each([
    ['1.0', '1.0', 0], ['1.0', '1.0.0', 0], ['1_2', '1.2', 0], ['1,2', '1.2', 0],
    ['1.2', '1.10', -1], ['1.10', '1.2', 1], ['1.0.1', '1.0', 1], ['1.0', '1.0.1', -1],
    ['9007199254740992', '9007199254740993', -1], ['1.0rc1', '1.0', null], ['1.0', '1.0rc1', null],
    ['1'.repeat(1025), '2', null], ['2', '1'.repeat(1025), null], ['', '1', null], ['1', '', null]
  ])('compares %s and %s conservatively', (a, b, expected) => expect(compareNvdVersions(a, b)).toBe(expected))

  it('keeps empty OR unknown and escapes in pre-parsed inventory unsupported', () => {
    expect(evaluateNvd({ kind: 'or', children: [] }, null, null).status).toBe('unknown')
    expect(evaluateNvd(leaf(), { ...parseCpe23(cpe('2.4.57')), vendor: 'apa\\che' }, null).status).toBe('unknown')
    expect(evaluateNvd(leaf(), { ...parseCpe23(cpe('2.4.57')), version: '2\\4' }, null).status).toBe('unknown')
  })
})
