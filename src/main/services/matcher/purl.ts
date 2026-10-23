export const PURL_PREFIX = 'pkg:'

export interface Purl {
  raw: string
  type: string
  namespace: string
  name: string
  version: string | null
  qualifiers: Record<string, string>
  subpath: string | null
}

export class PurlParseError extends Error {
  constructor(message: string) {
    super(`Invalid Package URL: ${message}`)
    this.name = 'PurlParseError'
  }
}

const TYPE_RE = /^[a-z][a-z0-9._-]*$/

function safeDecode(value: string, context: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new PurlParseError(`malformed percent-encoding in ${context}`)
  }
}

/** The version separator is the first '@' that comes after the last '/' in the path;
 * '@' characters inside a namespace (e.g. raw "@scope") therefore never trigger it. */
function findVersionSeparator(body: string): number {
  const lastSlash = body.lastIndexOf('/')
  if (lastSlash === -1) {
    return -1
  }
  return body.indexOf('@', lastSlash)
}

export function parsePurl(purl: string): Purl {
  if (!purl.startsWith(PURL_PREFIX)) {
    throw new PurlParseError('must start with "pkg:"')
  }

  let rest = purl.slice(PURL_PREFIX.length)

  const hashIndex = rest.indexOf('#')
  let subpath: string | null = null
  if (hashIndex !== -1) {
    const sub = rest.slice(hashIndex + 1)
    if (sub.length > 0) {
      subpath = safeDecode(sub, 'subpath')
    }
    rest = rest.slice(0, hashIndex)
  }

  const questionIndex = rest.indexOf('?')
  let qualifiers: Record<string, string> = {}
  if (questionIndex !== -1) {
    const qualifierPart = rest.slice(questionIndex + 1)
    rest = rest.slice(0, questionIndex)
    for (const pair of qualifierPart.split('&')) {
      if (pair.length === 0) continue
      const eq = pair.indexOf('=')
      const key = eq === -1 ? pair : pair.slice(0, eq)
      const value = eq === -1 ? '' : pair.slice(eq + 1)
      const decodedKey = safeDecode(key, 'qualifier key')
      const decodedValue = safeDecode(value, `qualifier "${decodedKey}"`)
      qualifiers[decodedKey] = decodedValue
    }
  }

  const atSignIndex = findVersionSeparator(rest)
  let version: string | null = null
  if (atSignIndex !== -1) {
    version = safeDecode(rest.slice(atSignIndex + 1), 'version')
    rest = rest.slice(0, atSignIndex)
  }

  const slashIndex = rest.indexOf('/')
  if (slashIndex === -1) {
    throw new PurlParseError('package type must be followed by "/" and a package path')
  }
  const typeRaw = rest.slice(0, slashIndex)
  if (!TYPE_RE.test(typeRaw)) {
    throw new PurlParseError(`type "${typeRaw}" is not a valid lowercase type`)
  }
  rest = rest.slice(slashIndex + 1)

  const pathSegments = rest.split('/').map((segment) => {
    if (segment.length === 0) {
      throw new PurlParseError('empty segment in package path')
    }
    if (segment.includes('@')) {
      throw new PurlParseError('raw "@" in package path; percent-encode it (e.g. %40 for npm scopes)')
    }
    return safeDecode(segment, 'package path')
  })

  const name = pathSegments[pathSegments.length - 1]
  const namespace = pathSegments.slice(0, -1).join('/')

  return {
    raw: purl,
    type: typeRaw,
    namespace,
    name,
    version,
    qualifiers,
    subpath
  }
}

function encodeSegments(segments: string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join('/')
}

export function formatPurl(purl: Omit<Purl, 'raw'>): string {
  if (!TYPE_RE.test(purl.type)) {
    throw new PurlParseError(`type "${purl.type}" is not a valid lowercase type`)
  }
  if (purl.name.includes('@')) {
    throw new PurlParseError('package name must not contain a raw "@", encode it or use a namespace')
  }
  if (purl.name.length === 0) {
    throw new PurlParseError('package name is empty')
  }

  let out = PURL_PREFIX + purl.type + '/'

  if (purl.namespace.length > 0) {
    out += encodeSegments(purl.namespace.split('/')) + '/'
  }

  out += encodeURIComponent(purl.name)

  if (purl.version) {
    out += `@${encodeURIComponent(purl.version)}`
  }

  const qualifierKeys = Object.keys(purl.qualifiers)
  if (qualifierKeys.length > 0) {
    const pairs = qualifierKeys
      .sort()
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(purl.qualifiers[key])}`)
    out += `?${pairs.join('&')}`
  }

  if (purl.subpath) {
    out += `#${purl.subpath}`
  }

  return out
}

/** Canonical registry name per ecosystem, safe to compare as a map key. */
export function canonicalName(purl: Purl): string {
  let name = purl.name
  const namespace = purl.namespace

  switch (purl.type) {
    case 'npm':
      name = name.toLowerCase()
      if (namespace.length > 0) {
        return `${namespace.toLowerCase()}/${name}`
      }
      return name
    case 'pypi':
      return name.toLowerCase().replace(/[-_.]+/g, '-')
    case 'maven':
      return namespace.length > 0 ? `${namespace}:${name}` : name
    default:
      return namespace.length > 0 ? `${namespace}/${name}` : name
  }
}

/** OSV.dev package key from a purl: OSV ecosystem names differ from purl types. */
export function toOsvPackageKey(purl: Purl): { ecosystem: string; name: string; purl: string } {
  const ecosystemByType: Record<string, string> = {
    npm: 'npm',
    pypi: 'PyPI',
    pip: 'PyPI',
    maven: 'Maven',
    cargo: 'crates.io',
    golang: 'Go'
  }
  return {
    ecosystem: ecosystemByType[purl.type] ?? purl.type,
    name: canonicalName(purl),
    purl: formatPurl(purl)
  }
}

export interface PackageIdentity {
  type: string
  namespace: string
  name: string
  version?: string | null
}

function identityKey(purl: Purl): string {
  return `${purl.type}\u0000${canonicalName(purl)}`
}

export function matchPurl(
  stackPurl: Purl,
  vulnPackageIdentity: PackageIdentity,
  compareVersions?: (vulnVersion: string, stackVersion: string) => boolean
): boolean {
  const vulnPurlLike: Purl = {
    raw: '',
    type: vulnPackageIdentity.type,
    namespace: vulnPackageIdentity.namespace,
    name: vulnPackageIdentity.name,
    version: vulnPackageIdentity.version ?? null,
    qualifiers: {},
    subpath: null
  }

  if (identityKey(stackPurl) !== identityKey(vulnPurlLike)) {
    return false
  }

  const { version: vulnVersion } = vulnPackageIdentity

  if (vulnVersion == null) {
    return true
  }

  if (stackPurl.version == null) {
    return false
  }

  if (compareVersions) {
    return compareVersions(vulnVersion, stackPurl.version)
  }

  return vulnVersion.toLowerCase() === stackPurl.version.toLowerCase()
}
