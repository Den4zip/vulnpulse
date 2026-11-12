import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { fstecDate, fstecObject, type FstecOrigin, type FstecRecord } from '../fstec-data'

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false,
  parseAttributeValue: false, trimValues: true, maxNestedTags: 32, processEntities: true })

/** Called only in a worker. Original XML and all parsed fields stay in source payload. */
export function parseFstecRecord(xml: string, origin: FstecOrigin): FstecRecord {
  if (XMLValidator.validate(xml) !== true) throw new Error('Malformed FSTEC XML record')
  const document: unknown = parser.parse(xml)
  if (!fstecObject(document) || !fstecObject(document.vul)) throw new Error('Unsupported FSTEC record')
  const value = document.vul
  if (typeof value.identifier !== 'string' || !/^BDU:\d{4}-\d{5,10}$/.test(value.identifier)
    || typeof value.name !== 'string' || !value.name || value.name.length > 65536
    || (value.description !== undefined && typeof value.description !== 'string')) throw new Error('Invalid FSTEC fields')
  const cves = new Set<string>()
  const warnings: string[] = []
  if (value.identifiers !== undefined && value.identifiers !== '') {
    if (!fstecObject(value.identifiers)) throw new Error('Invalid FSTEC identifiers')
    const entries = value.identifiers.identifier
    for (const entry of Array.isArray(entries) ? entries : entries === undefined ? [] : [entries]) {
      if (!fstecObject(entry) || typeof entry['@_type'] !== 'string') throw new Error('Invalid FSTEC identifier')
      if (entry['@_type'].toUpperCase() !== 'CVE') continue
      const id = typeof entry['#text'] === 'string' ? entry['#text'].trim().toUpperCase() : ''
      if (!/^CVE-\d{4}-\d{4,19}$/.test(id)) {
        warnings.push('invalid_cve_reference')
        if (warnings.length > 1000) throw new Error('Too many FSTEC identifier warnings')
        continue
      }
      cves.add(id)
      if (cves.size > 100) throw new Error('Too many FSTEC CVE links')
    }
  }
  const date = (key: string): string | null => {
    try { return fstecDate(value[key]) }
    catch { warnings.push(`invalid_${key}`); return null }
  }
  const publishedAt = date('publication_date')
  const modifiedAt = date('last_upd_date') ?? publishedAt
  return { id: value.identifier, title: value.name, description: value.description as string | undefined ?? null,
    publishedAt, modifiedAt, cves: [...cves], warnings,
    rawJson: JSON.stringify({ format: 'fstec-xml-v1', origin, xml, fields: value, warnings }) }
}
