import { describe, expect, it } from 'vitest'
import {
  CpeParseError,
  formatCpe23,
  isAny,
  isCpe23Uri,
  isNa,
  matchCpe,
  matchSegment,
  parseCpe23,
  type CpeParts
} from '@main/services/matcher/cpe'

function cpe(overrides: Partial<CpeParts>): CpeParts {
  return {
    part: 'a',
    vendor: 'apache',
    product: 'httpd',
    version: '2.4.57',
    update: '*',
    edition: '*',
    language: '*',
    swEdition: '*',
    targetSw: '*',
    targetHw: '*',
    other: '*',
    ...overrides
  }
}

describe('parseCpe23', () => {
  it('parses a standard NVD application CPE', () => {
    const parsed = parseCpe23('cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:*')
    expect(parsed).toEqual({
      part: 'a',
      vendor: 'apache',
      product: 'http_server',
      version: '2.4.57',
      update: '*',
      edition: '*',
      language: '*',
      swEdition: '*',
      targetSw: '*',
      targetHw: '*',
      other: '*'
    })
  })

  it('parses operating system CPE', () => {
    const parsed = parseCpe23('cpe:2.3:o:linux:linux_kernel:6.6.30:*:*:*:*:*:*:*')
    expect(parsed.part).toBe('o')
    expect(parsed.vendor).toBe('linux')
    expect(parsed.product).toBe('linux_kernel')
    expect(parsed.version).toBe('6.6.30')
  })

  it('parses hardware CPE', () => {
    const parsed = parseCpe23('cpe:2.3:h:cisco:catalyst_9200:-:*:*:*:*:*:*:*')
    expect(parsed.part).toBe('h')
    expect(parsed.version).toBe('-')
  })

  it('unescapes escaped colons and backslashes', () => {
    const parsed = parseCpe23('cpe:2.3:a:vendor\\:name:prod\\\\uct:1.0.0:*:*:*:*:*:*:*')
    expect(parsed.vendor).toBe('vendor:name')
    expect(parsed.product).toBe('prod\\uct')
    expect(parsed.product).toContain('\\')
  })

  it('parses windows-style update identifiers intact', () => {
    const parsed = parseCpe23('cpe:2.3:o:microsoft:windows_10:22h2:*:*:*:*:*:*:*')
    expect(parsed.update).toBe('*')
    expect(parsed.version).toBe('22h2')
  })

  it('rejects missing or wrong prefix', () => {
    expect(() => parseCpe23('cpe:/a:apache:http_server')).toThrow(CpeParseError)
    expect(() => parseCpe23('cpe:2.2:a:apache:http_server:*:*:*:*:*:*:*:*')).toThrow(CpeParseError)
    expect(() => parseCpe23('apache:http_server:2.4.57')).toThrow(/must start/)
  })

  it('rejects wrong part values', () => {
    expect(() => parseCpe23('cpe:2.3:x:apache:http_server:2.4.57:*:*:*:*:*:*:*')).toThrow(
      /part must be/
    )
    expect(() => parseCpe23('cpe:2.3:*:apache:http_server:2.4.57:*:*:*:*:*:*:*')).toThrow(
      /part must be/
    )
  })

  it('rejects wrong component count', () => {
    expect(() => parseCpe23('cpe:2.3:a:apache:http_server:2.4.57')).toThrow(/expected 11/)
    expect(() => parseCpe23('cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:*:*')).toThrow(
      /expected 11/
    )
  })

  it('rejects empty components', () => {
    expect(() => parseCpe23('cpe:2.3:a:apache::2.4.57:*:*:*:*:*:*:*')).toThrow(/is empty/)
  })

  it('rejects dangling escape', () => {
    expect(() => parseCpe23('cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:extra\\')).toThrow(
      /dangling escape/
    )
  })

  it('rejects illegal escape sequences', () => {
    expect(() => parseCpe23('cpe:2.3:a:apache:x\\q:2.4.57:*:*:*:*:*:*:*')).toThrow(
      /illegal escape/
    )
  })
})

describe('formatCpe23', () => {
  it('re-escapes special characters and round-trips through parse', () => {
    const source = 'cpe:2.3:a:vendor\\:name:prod\\\\uct:1.0.0:*:*:*:*:*:*:*'
    const parsed = parseCpe23(source)
    const formatted = formatCpe23(parsed)
    expect(formatted).toBe(source)
    expect(parseCpe23(formatted)).toEqual(parsed)
  })

  it('round-trips plain CPE', () => {
    const source = 'cpe:2.3:o:linux:linux_kernel:6.6.30:*:*:*:*:*:*:*'
    expect(formatCpe23(parseCpe23(source))).toBe(source)
  })
})

describe('isCpe23Uri / isAny / isNa', () => {
  it('detects prefix', () => {
    expect(isCpe23Uri('cpe:2.3:a:x:y:1:*:*:*:*:*:*:*')).toBe(true)
    expect(isCpe23Uri('cpe:/a:x:y')).toBe(false)
  })

  it('detects logical values', () => {
    expect(isAny('*')).toBe(true)
    expect(isAny('-')).toBe(false)
    expect(isNa('-')).toBe(true)
    expect(isNa('1.0.0')).toBe(false)
  })
})

describe('matchSegment', () => {
  it('ANY matches everything', () => {
    expect(matchSegment('*', '2.4.57')).toBe(true)
    expect(matchSegment('2.4.57', '*')).toBe(true)
  })

  it('literal match is case-insensitive', () => {
    expect(matchSegment('Apache', 'apache')).toBe(true)
    expect(matchSegment('apache', 'nginx')).toBe(false)
  })

  it('NA on stack side is conservative with literal and ANY on vuln side', () => {
    expect(matchSegment('apache', '-')).toBe(false)
    expect(matchSegment('*', '-')).toBe(false)
    expect(matchSegment('-', '-')).toBe(true)
    expect(matchSegment('-', 'apache')).toBe(false)
  })
})

describe('matchCpe', () => {
  const vuln = parseCpe23('cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:*')

  it('matches identical CPE', () => {
    const stack = parseCpe23('cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:*')
    expect(matchCpe(vuln, stack)).toBe(true)
  })

  it('matches case-insensitively', () => {
    const stack = parseCpe23('cpe:2.3:a:Apache:Http_Server:2.4.57:*:*:*:*:*:*:*')
    expect(matchCpe(vuln, stack)).toBe(true)
  })

  it('rejects different vendor or product', () => {
    const otherVendor = parseCpe23('cpe:2.3:a:nginx:http_server:2.4.57:*:*:*:*:*:*:*')
    const otherProduct = parseCpe23('cpe:2.3:a:apache:tomcat:2.4.57:*:*:*:*:*:*:*')
    expect(matchCpe(vuln, otherVendor)).toBe(false)
    expect(matchCpe(vuln, otherProduct)).toBe(false)
  })

  it('rejects different part', () => {
    const osCpe = parseCpe23('cpe:2.3:o:apache:http_server:2.4.57:*:*:*:*:*:*:*')
    expect(matchCpe(vuln, osCpe)).toBe(false)
  })

  it('vuln ANY version matches concrete stack version', () => {
    const vulnAny = parseCpe23('cpe:2.3:a:apache:http_server:*:*:*:*:*:*:*:*')
    const stack = parseCpe23('cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:*')
    expect(matchCpe(vulnAny, stack)).toBe(true)
  })

  it('vuln concrete version rejects stack with unknown version', () => {
    const stackUnknown = parseCpe23('cpe:2.3:a:apache:http_server:*:*:*:*:*:*:*:*')
    expect(matchCpe(vuln, stackUnknown)).toBe(false)
  })

  it('uses provided version comparator when versions differ textually', () => {
    const vulnRange = parseCpe23('cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:*')
    const stack = parseCpe23('cpe:2.3:a:apache:http_server:2.4.57.final:*:*:*:*:*:*:*')
    const normalizer: (a: string, b: string) => boolean = (a, b) =>
      a.split('.').join('.') === b.split('.').join('.').replace('.final', '')
    expect(matchCpe(vulnRange, stack, normalizer)).toBe(true)
    expect(matchCpe(vulnRange, stack)).toBe(false)
  })

  it('rejects version-less stack CPE against concrete vuln version', () => {
    const stackNaVersion = parseCpe23('cpe:2.3:a:apache:http_server:-:*:*:*:*:*:*:*')
    expect(matchCpe(vuln, stackNaVersion)).toBe(false)
  })

  it('update segment matches with ANY on either side', () => {
    const vulnAny = parseCpe23('cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:*')
    const stackWithUpdate = parseCpe23('cpe:2.3:a:apache:http_server:2.4.57:sp1:*:*:*:*:*:*')
    expect(matchCpe(vulnAny, stackWithUpdate)).toBe(true)

    const vulnWithUpdate = parseCpe23('cpe:2.3:a:apache:http_server:2.4.57:sp1:*:*:*:*:*:*')
    const stackAnyUpdate = parseCpe23('cpe:2.3:a:apache:http_server:2.4.57:*:*:*:*:*:*:*')
    expect(matchCpe(vulnWithUpdate, stackAnyUpdate)).toBe(true)
  })

  it('cpe() helper builds custom objects for comparator tests', () => {
    const stackCustom = cpe({ vendor: 'apache', product: 'http_server', version: '2.4.57' })
    expect(matchCpe(vuln, stackCustom)).toBe(true)
    expect(
      matchCpe(vuln, cpe({ vendor: 'apache', product: 'http_server', version: '2.4.58' }))
    ).toBe(false)
  })
})
