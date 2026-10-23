import { describe, expect, it } from 'vitest'
import {
  compareSemver,
  compareSemverOrThrow,
  InvalidVersionError,
  isSemver,
  semverEquals
} from '@main/services/matcher/version'

describe('isSemver', () => {
  it('accepts standard semver', () => {
    expect(isSemver('1.2.3')).toBe(true)
    expect(isSemver('0.0.1')).toBe(true)
  })

  it('accepts v-prefix and = padding', () => {
    expect(isSemver('v1.2.3')).toBe(true)
    expect(isSemver('=1.2.3')).toBe(true)
    expect(isSemver(' 1.2.3 ')).toBe(true)
  })

  it('accepts prerelease and build metadata', () => {
    expect(isSemver('1.2.0-rc.1')).toBe(true)
    expect(isSemver('1.2.3+build.7')).toBe(true)
    expect(isSemver('1.2.3-exp.2.5+build')).toBe(true)
  })

  it('rejects multi-dot shorthand', () => {
    expect(isSemver('1.2')).toBe(false)
    expect(isSemver('1')).toBe(false)
  })

  it('rejects system-software versions with letter suffixes', () => {
    expect(isSemver('1.1.1d')).toBe(false)
    expect(isSemver('non-numeric')).toBe(false)
    expect(isSemver('')).toBe(false)
  })

  it('treats hyphen suffixes as prerelease per spec', () => {
    expect(isSemver('6.6.30-git')).toBe(true)
    expect(isSemver('16.3.0-1')).toBe(true)
    expect(isSemver('16.3-1')).toBe(false)
    expect(compareSemver('6.6.30-rc2', '6.6.30')).toBeLessThan(0)
  })
})

describe('compareSemver', () => {
  it('orders patch versions', () => {
    expect(compareSemver('1.2.3', '1.2.4')).toBeLessThan(0)
    expect(compareSemver('1.2.4', '1.2.3')).toBeGreaterThan(0)
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
  })

  it('orders prerelease below release', () => {
    expect(compareSemver('1.2.0-rc.1', '1.2.0')).toBeLessThan(0)
    expect(compareSemver('1.2.0', '1.2.0-rc.1')).toBeGreaterThan(0)
    expect(compareSemver('1.2.0-rc.1', '1.2.0')).toBeLessThan(0)
  })

  it('orders prerelease identifiers lexicographically among themselves', () => {
    expect(compareSemver('1.2.0-alpha', '1.2.0-beta')).toBeLessThan(0)
    expect(compareSemver('1.2.0-rc.2.1', '1.2.0-rc.2.2')).toBeLessThan(0)
  })

  it('ignores build metadata in comparison', () => {
    expect(compareSemver('1.2.3+a', '1.2.3+b')).toBe(0)
    expect(compareSemver('1.2.3', '1.2.3+build.7')).toBe(0)
  })

  it('treats v-prefix as equivalent', () => {
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0)
    expect(compareSemver('=1.2.3', 'v1.2.3')).toBe(0)
  })

  it('returns null for non-semver input instead of throwing', () => {
    expect(compareSemver('1.2', '1.2.0')).toBeNull()
    expect(compareSemver('1.2.3', '1.1.1d')).toBeNull()
    expect(compareSemver('garbage', 'garbage')).toBeNull()
  })

  it('compares multi-digit components numerically, not lexically', () => {
    expect(compareSemver('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareSemver('2.0.0', '10.0.0')).toBeLessThan(0)
  })
})

describe('semverEquals', () => {
  it('matches same version from different ecosystems notation', () => {
    expect(semverEquals('v4.2.11', '4.2.11')).toBe(true)
    expect(semverEquals('4.2.11', '4.2.12')).toBe(false)
  })

  it('returns false for invalid versions', () => {
    expect(semverEquals('1.1.1d', '1.1.1d')).toBe(false)
  })
})

describe('compareSemverOrThrow', () => {
  it('throws InvalidVersionError for non-semver side', () => {
    expect(() => compareSemverOrThrow('1.1.1d', '1.2.0')).toThrow(InvalidVersionError)
    expect(() => compareSemverOrThrow('1.2.0', '1.2.0')).not.toThrow()
  })

  it('returns full ordering', () => {
    expect(compareSemverOrThrow('2.1.0', '2.0.9')).toBeGreaterThan(0)
    expect(compareSemverOrThrow('1.0.0', '2.0.0')).toBeLessThan(0)
    expect(compareSemverOrThrow('1.0.0', '1.0.0')).toBe(0)
  })
})
