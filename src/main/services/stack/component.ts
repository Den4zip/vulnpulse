import type { StackKind } from '@shared/enums'
import { parseCpe23 } from '../matcher/cpe'
import { canonicalName, parsePurl } from '../matcher/purl'

export interface StackComponent {
  kind: StackKind
  name: string
  vendor: string | null
  product: string
  version: string
  cpe23: string | null
  purl: string | null
}

function text(value: unknown, field: string, optional = false): string | null {
  if (optional && (value === undefined || value === null)) return null
  if (typeof value !== 'string' || !value.length || value.length > 2048 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Поле ${field}: ожидается непустая строка без пробелов по краям (до 2048 символов).`)
  }
  return value
}

/** Shared policy for local JSON inventory and individual CRUD commands. */
export function parseStackComponent(input: unknown): StackComponent {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('Ожидается объект компонента.')
  const value = input as Record<string, unknown>
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string'
    || !['kind', 'name', 'vendor', 'product', 'version', 'cpe23', 'purl'].includes(key))) throw new Error('Неизвестное поле конфигурации.')
  if (!['application', 'system', 'package'].includes(value.kind as string)) throw new Error('Некорректный kind.')
  const name = text(value.name, 'name')!
  const vendor = text(value.vendor, 'vendor', true)
  const product = text(value.product, 'product')!
  const version = text(value.version, 'version')!
  const cpe23 = text(value.cpe23, 'cpe23', true)
  const purl = text(value.purl, 'purl', true)
  if (version === '-' || /[\s*?<>|^~=]/.test(version)) throw new Error('version должна быть конкретной установленной версией.')
  if (!cpe23 && !purl) throw new Error('Укажите cpe23 или purl.')
  if (cpe23) {
    const cpe = parseCpe23(cpe23)
    if (!vendor || /[*?]/.test(cpe.vendor + cpe.product) || cpe.vendor === '-' || cpe.product === '-'
      || cpe.vendor.toLowerCase() !== vendor.toLowerCase() || cpe.product.toLowerCase() !== product.toLowerCase()
      || cpe.version !== version) throw new Error('CPE должен содержать те же конкретные vendor, product и version.')
  }
  if (purl) {
    const parsed = parsePurl(purl)
    if (!['npm', 'pypi', 'maven'].includes(parsed.type) || Object.keys(parsed.qualifiers).length || parsed.subpath
      || purl.includes('?') || purl.includes('#') || parsed.version !== version || canonicalName(parsed) !== product) {
      throw new Error('PURL: npm/PyPI/Maven, product = canonical name, та же version, без qualifiers/subpath.')
    }
  }
  return { kind: value.kind as StackKind, name, vendor, product, version, cpe23, purl }
}
