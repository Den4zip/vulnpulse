import { describe, expect, it } from 'vitest'
import {
  PurlParseError,
  canonicalName,
  formatPurl,
  matchPurl,
  parsePurl,
  toOsvPackageKey,
  type Purl
} from '@main/services/matcher/purl'

describe('parsePurl', () => {
  it('parses a plain npm purl without version', () => {
    const parsed = parsePurl('pkg:npm/lodash')
    expect(parsed.type).toBe('npm')
    expect(parsed.namespace).toBe('')
    expect(parsed.name).toBe('lodash')
    expect(parsed.version).toBeNull()
    expect(parsed.qualifiers).toEqual({})
    expect(parsed.subpath).toBeNull()
  })

  it('parses npm purl with version', () => {
    const parsed = parsePurl('pkg:npm/lodash@4.17.21')
    expect(parsed.name).toBe('lodash')
    expect(parsed.version).toBe('4.17.21')
  })

  it('parses npm scoped purl with percent-encoded scope', () => {
    const parsed = parsePurl('pkg:npm/%40babel/core@7.24.0')
    expect(parsed.namespace).toBe('@babel')
    expect(parsed.name).toBe('core')
    expect(parsed.version).toBe('7.24.0')
  })

  it('parses a purl without version but with encoded namespace', () => {
    const parsed = parsePurl('pkg:npm/%40types/node')
    expect(parsed.namespace).toBe('@types')
    expect(parsed.name).toBe('node')
    expect(parsed.version).toBeNull()
  })

  it('raw "@scope/name" without encoding is rejected (spec)', () => {
    expect(() => parsePurl('pkg:npm/@scope/name@1.0.0')).toThrow(/percent-encode/)
  })

  it('parses pypi purl with percent-decoded characters intact', () => {
    const parsed = parsePurl('pkg:pypi/django%2Dutils@1.2.3')
    expect(parsed.type).toBe('pypi')
    expect(parsed.name).toBe('django-utils')
    expect(parsed.version).toBe('1.2.3')
  })

  it('parses real-world version strings as-is', () => {
    expect(parsePurl('pkg:pypi/psycopg2@2.9.9').version).toBe('2.9.9')
    expect(parsePurl('pkg:npm/lodash@4.17.21').version).toBe('4.17.21')
  })

  it('parses maven purl: namespace = groupId, name = artifactId', () => {
    const parsed = parsePurl('pkg:maven/org.apache.commons/commons-lang3@3.14.0')
    expect(parsed.type).toBe('maven')
    expect(parsed.namespace).toBe('org.apache.commons')
    expect(parsed.name).toBe('commons-lang3')
    expect(parsed.version).toBe('3.14.0')
  })

  it('parses qualifiers and subpath together', () => {
    const parsed = parsePurl('pkg:maven/org.springframework/spring-core@6.1.6?classifier=sources#pom.xml')
    expect(parsed.qualifiers).toEqual({ classifier: 'sources' })
    expect(parsed.subpath).toBe('pom.xml')
  })

  it('version with encoded characters decodes correctly', () => {
    const parsed = parsePurl('pkg:maven/org.apache.logging/logging-log4j-core@2.23.1')
    expect(parsed.version).toBe('2.23.1')
  })

  it('version with "v" prefix is kept as-is for later revision comparison', () => {
    const parsed = parsePurl('pkg:golang/github.com%2Fgin-gonic/gin@v1.10.0')
    expect(parsed.namespace).toBe('github.com/gin-gonic')
    expect(parsed.name).toBe('gin')
    expect(parsed.version).toBe('v1.10.0')
  })

  it('rejects missing pkg: prefix', () => {
    expect(() => parsePurl('npm/lodash@1.0.0')).toThrow(/must start with "pkg:"/)
  })

  it('rejects empty purl after prefix', () => {
    expect(() => parsePurl('pkg:')).toThrow()
  })

  it('rejects type without slash', () => {
    expect(() => parsePurl('pkg:npm')).toThrow(/must be followed by/)
  })

  it('rejects uppercase type', () => {
    expect(() => parsePurl('pkg:NPm/lodash')).toThrow(/lowercase/)
  })

  it('rejects empty name segment', () => {
    expect(() => parsePurl('pkg:npm/')).toThrow(/empty segment/)
    expect(() => parsePurl('pkg:npm//x')).toThrow(/empty segment/)
  })

  it('rejects malformed percent-encoding', () => {
    expect(() => parsePurl('pkg:npm/%ZZbad')).toThrow(/percent-encoding/)
  })

  it('ignores trailing hash without subpath payload', () => {
    const parsed = parsePurl('pkg:npm/lodash@4.17.21#')
    expect(parsed.subpath).toBeNull()
    expect(parsed.version).toBe('4.17.21')
  })

  it('skips empty qualifier pairs and supports bare keys', () => {
    const parsed = parsePurl('pkg:maven/g/a@1.0?k1&&k2=v&k3')
    expect(parsed.qualifiers).toEqual({ k1: '', k2: 'v', k3: '' })
  })
})

describe('formatPurl', () => {
  it('encodes scope namespace with %40 and round-trips', () => {
    const source = 'pkg:npm/%40babel/core@7.24.0'
    const parsed = parsePurl(source)
    expect(formatPurl(parsed)).toBe(source)
  })

  it('round-trips maven purl', () => {
    const source = 'pkg:maven/org.apache.commons/commons-lang3@3.14.0'
    expect(formatPurl(parsePurl(source))).toBe(source)
  })

  it('round-trips qualifiers sorted by key', () => {
    const source = 'pkg:maven/x/y@1.0?a=1&b=2'
    expect(formatPurl(parsePurl(source))).toBe('pkg:maven/x/y@1.0?a=1&b=2')
  })

  it('respects reversed qualifier order on input', () => {
    const parsed = parsePurl('pkg:maven/x/y@1.0?b=2&a=1')
    expect(formatPurl(parsed)).toBe('pkg:maven/x/y@1.0?a=1&b=2')
  })

  it('round-trips subpath', () => {
    const source = 'pkg:maven/org.springframework/spring-core@6.1.6?classifier=sources#pom.xml'
    expect(formatPurl(parsePurl(source))).toBe(source)
  })

  it('rejects invalid type in formatPurl', () => {
    expect(() =>
      formatPurl({
        type: 'NPm',
        namespace: '',
        name: 'lodash',
        version: null,
        qualifiers: {},
        subpath: null
      })
    ).toThrow(/lowercase type/)
  })

  it('rejects raw @ in name and empty name in formatPurl', () => {
    expect(() =>
      formatPurl({
        type: 'npm',
        namespace: '',
        name: 'bad@name',
        version: null,
        qualifiers: {},
        subpath: null
      })
    ).toThrow(/raw/)
    expect(() =>
      formatPurl({
        type: 'npm',
        namespace: '',
        name: '',
        version: null,
        qualifiers: {},
        subpath: null
      })
    ).toThrow(/empty/)
  })
})

describe('canonicalName', () => {
  function purlOf(uri: string): Purl {
    return parsePurl(uri)
  }

  it('npm scope and name are lowercased', () => {
    expect(canonicalName(purlOf('pkg:npm/%40Babel/Core'))).toBe('@babel/core')
  })

  it('pypi names are equivalent across separators', () => {
    expect(canonicalName(purlOf('pkg:pypi/django_utils'))).toBe('django-utils')
    expect(canonicalName(purlOf('pkg:pypi/django-utils'))).toBe('django-utils')
    expect(canonicalName(purlOf('pkg:pypi/django.UTILS'))).toBe('django-utils')
  })

  it('maven is namespace:artifactId', () => {
    expect(canonicalName(purlOf('pkg:maven/org.apache.commons/commons-lang3'))).toBe(
      'org.apache.commons:commons-lang3'
    )
  })

  it('maven without namespace falls back to bare name', () => {
    expect(canonicalName(purlOf('pkg:maven/artifact-only'))).toBe('artifact-only')
  })

  it('namespaced unknown ecosystem uses namespace/name', () => {
    expect(canonicalName(purlOf('pkg:unknown/ecosystem/pkg@1.0'))).toBe('ecosystem/pkg')
  })

  it('toOsvPackageKey maps known types and passes through unknown ones', () => {
    expect(toOsvPackageKey(purlOf('pkg:pip/requests@2.31.0')).ecosystem).toBe('PyPI')
    expect(toOsvPackageKey(purlOf('pkg:cargo/serde@1.0.0')).ecosystem).toBe('crates.io')
    expect(toOsvPackageKey(purlOf('pkg:golang/github.com/x/y@v1')).ecosystem).toBe('Go')
    expect(toOsvPackageKey(purlOf('pkg:unknown-ecosystem/pkg')).ecosystem).toBe('unknown-ecosystem')
  })

  it('unknown ecosystems fall back to namespace/name', () => {
    expect(canonicalName(purlOf('pkg:cargo/serde@1.0.0'))).toBe('serde')
  })
})

describe('toOsvPackageKey', () => {
  it('maps pypi type to OSV "PyPI" ecosystem', () => {
    const key = toOsvPackageKey(parsePurl('pkg:pypi/Django@4.2.11'))
    expect(key.ecosystem).toBe('PyPI')
    expect(key.name).toBe('django')
  })

  it('maps maven to OSV "Maven"', () => {
    const key = toOsvPackageKey(parsePurl('pkg:maven/org.apache.commons/commons-lang3'))
    expect(key.ecosystem).toBe('Maven')
    expect(key.name).toBe('org.apache.commons:commons-lang3')
  })

  it('maps npm with scope', () => {
    const key = toOsvPackageKey(parsePurl('pkg:npm/%40babel/core'))
    expect(key.ecosystem).toBe('npm')
    expect(key.name).toBe('@babel/core')
  })
})

describe('matchPurl', () => {
  const stack = parsePurl('pkg:pypi/django-utils@4.2.11')

  it('matches same package regardless of ecosystem normalization', () => {
    expect(
      matchPurl(stack, { type: 'pypi', namespace: '', name: 'django_utils', version: '4.2.11' })
    ).toBe(true)
  })

  it('rejects different type', () => {
    expect(
      matchPurl(stack, { type: 'npm', namespace: '', name: 'django-utils', version: '4.2.11' })
    ).toBe(false)
  })

  it('rejects different version without comparator', () => {
    expect(
      matchPurl(stack, { type: 'pypi', namespace: '', name: 'django-utils', version: '4.2.12' })
    ).toBe(false)
  })

  it('uses comparator for range-based vulnerability data', () => {
    expect(
      matchPurl(
        stack,
        { type: 'pypi', namespace: '', name: 'django-utils', version: '4.2.0' },
        tupleCompare
      )
    ).toBe(true)
    expect(
      matchPurl(
        stack,
        { type: 'pypi', namespace: '', name: 'django-utils', version: '4.3.0' },
        tupleCompare
      )
    ).toBe(false)
  })

  it('vulnerability without version matches installed packages', () => {
    expect(
      matchPurl(stack, { type: 'pypi', namespace: '', name: 'django-utils' })
    ).toBe(true)
  })

  it('stack version known missing is rejected against concrete vuln version', () => {
    const stackNoVersion = parsePurl('pkg:pypi/django-utils')
    expect(
      matchPurl(stackNoVersion, { type: 'pypi', namespace: '', name: 'django-utils', version: '1.0' })
    ).toBe(false)
  })

  it('matches scoped npm packages', () => {
    const scoped = parsePurl('pkg:npm/%40babel/core@7.24.0')
    expect(
      matchPurl(scoped, { type: 'npm', namespace: '@babel', name: 'core', version: '7.24.0' })
    ).toBe(true)
    expect(
      matchPurl(scoped, { type: 'npm', namespace: '@babel', name: 'cli', version: '7.24.0' })
    ).toBe(false)
  })
})

function tupleCompare(vulnVersion: string, stackVersion: string): boolean {
  const vulnParts = vulnVersion.split('.').map(Number)
  const stackParts = stackVersion.split('.').map(Number)
  const length = Math.max(vulnParts.length, stackParts.length)
  for (let i = 0; i < length; i++) {
    const a = vulnParts[i] ?? 0
    const b = stackParts[i] ?? 0
    if (a !== b) {
      return a < b
    }
  }
  return true
}

