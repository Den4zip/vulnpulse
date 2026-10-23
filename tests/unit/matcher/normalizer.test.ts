import { describe, expect, it } from 'vitest'
import {
  compareSystemVersions,
  parseSystemVersion,
  systemVersionEquals
} from '@main/services/matcher/normalizer'

function ordered(versions: string[]): void {
  for (let i = 0; i < versions.length - 1; i++) {
    expect(
      compareSystemVersions(versions[i], versions[i + 1]),
      `${versions[i]} < ${versions[i + 1]}`
    ).toBeLessThan(0)
    expect(
      compareSystemVersions(versions[i + 1], versions[i]),
      `${versions[i + 1]} > ${versions[i]}`
    ).toBeGreaterThan(0)
  }
}

describe('parseSystemVersion', () => {
  it('handles separators _ and ,', () => {
    expect(parseSystemVersion('1_24')?.parts).toEqual([1, 24])
    expect(parseSystemVersion('1,24')?.parts).toEqual([1, 24])
    expect(parseSystemVersion('16_2_1')?.parts).toEqual([16, 2, 1])
  })

  it('strips v prefix', () => {
    expect(parseSystemVersion('v1.25.4')?.parts).toEqual([1, 25, 4])
  })

  it('converts openssl letter patch levels to numeric parts', () => {
    const parsed = parseSystemVersion('1.1.1d')
    expect(parsed?.parts).toEqual([1, 1, 1, 4])
    expect(parsed?.kind).toBe('plain')
  })

  it('classifies prerelease identifiers', () => {
    const rc = parseSystemVersion('6.6.30-rc2')
    expect(rc?.kind).toBe('prerelease')
    expect(rc?.order).toBe(3)
    expect(rc?.tail).toBe(2)

    const alpha = parseSystemVersion('1.0.0-alpha')
    expect(alpha?.kind).toBe('prerelease')
    expect(alpha?.order).toBe(1)
  })

  it('consumes numeric post-revision into parts', () => {
    const parsed = parseSystemVersion('1.24.0-1')
    expect(parsed?.parts).toEqual([1, 24, 0, 1])
    expect(parsed?.kind).toBe('plain')
  })

  it('falls back for ubuntu revisions', () => {
    const parsed = parseSystemVersion('6.6.30-0ubuntu1')
    expect(parsed?.parts).toEqual([6, 6, 30, 0])
    expect(parsed?.kind).toBe('fallback')
    expect(parsed?.lex).toBe('ubuntu1')
  })

  it('returns null for garbage input', () => {
    expect(parseSystemVersion('unknown')).toBeNull()
    expect(parseSystemVersion('')).toBeNull()
    expect(parseSystemVersion('beta.1')).toBeNull()
  })

  it('parses plain versions of all target families', () => {
    expect(parseSystemVersion('16.3')?.parts).toEqual([16, 3])
    expect(parseSystemVersion('1.24.0')?.parts).toEqual([1, 24, 0])
    expect(parseSystemVersion('6.6.30')?.parts).toEqual([6, 6, 30])
  })
})

describe('compareSystemVersions', () => {
  it('orders nginx releases', () => {
    ordered(['1.24.0', '1.24.1', '1.25.0'])
  })

  it('orders openssl letter levels', () => {
    ordered(['1.1.1c', '1.1.1d', '1.1.1j'])
  })

  it('orders postgresql releases', () => {
    ordered(['16.2', '16.2.4', '16.3', '16.3.1', '17.0'])
  })

  it('orders kernel versions', () => {
    ordered(['5.15.0', '6.5.0', '6.6.30'])
  })

  it('makes separator variants equal', () => {
    expect(systemVersionEquals('1_24', '1.24')).toBe(true)
    expect(systemVersionEquals('1,24', '1.24')).toBe(true)
    expect(systemVersionEquals('16_3', '16.3')).toBe(true)
  })

  it('ranks prerelease below base release', () => {
    ordered(['6.6.30-rc1', '6.6.30-rc2', '6.6.30', '6.6.31'])
  })

  it('orders alpha < beta < rc', () => {
    ordered(['1.0.0-alpha', '1.0.0-beta', '1.0.0-rc1', '1.0.0'])
  })

  it('orders debian revisions above their base and among themselves', () => {
    ordered(['1.24.0', '1.24.0-1', '1.24.0-2', '1.24.1'])
  })

  it('breaks ubuntu revision ties lexicographically', () => {
    ordered(['6.6.30-0ubuntu1', '6.6.30-0ubuntu2', '6.6.31-0ubuntu1'])
  })

  it('treats identical fallback residues as equal', () => {
    expect(systemVersionEquals('6.6.30-0ubuntu1', '6.6.30-0ubuntu1')).toBe(true)
    expect(systemVersionEquals('6.6.30-0ubuntu1', '6.6.30-0ubuntu2')).toBe(false)
  })

  it('accepts prerelease keyword in second component position', () => {
    expect(parseSystemVersion('6.dev')?.kind).toBe('prerelease')
    expect(parseSystemVersion('6.dev')?.parts).toEqual([6])
  })

  it('routes mixed residue to the fallback chain', () => {
    const parsed = parseSystemVersion('16.3ng-fixed')
    expect(parsed?.kind).toBe('fallback')
    expect(parsed?.lex).toBe('ng-fixed')
  })

  it('returns null when either side is unparseable', () => {
    expect(compareSystemVersions('unknown', '1.24.0')).toBeNull()
    expect(compareSystemVersions('1.24.0', 'bro-ken')).toBeNull()
    expect(compareSystemVersions('1.24.0', '1.24.0')).toBe(0)
  })

  it('recognition workspace for mixed compare with semver style', () => {
    expect(systemVersionEquals('2.4.57', '2.4.57')).toBe(true)
    expect(compareSystemVersions('2.4.5', '2.4.57')).toBeLessThan(0)
  })
})

describe('systemVersionEquals', () => {
  it('matches exact normalized versions', () => {
    expect(systemVersionEquals('1.1.1d', '1.1.1d')).toBe(true)
    expect(systemVersionEquals('16.3', '16.3')).toBe(true)
  })

  it('matches across numeric notations', () => {
    expect(systemVersionEquals('1.0', '1.0.0')).toBe(true)
    expect(systemVersionEquals('1.0', '1.2')).toBe(false)
  })

  it('is false for letter-level differences', () => {
    expect(systemVersionEquals('1.1.1c', '1.1.1d')).toBe(false)
  })
})
