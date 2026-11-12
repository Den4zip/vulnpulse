import { createReadStream } from 'node:fs'
import { and, count, eq, isNull } from 'drizzle-orm'
import type { Db } from '../../db'
import { stack } from '../../db/schema'
import { parseStackComponent, type StackComponent } from './component'

const MAX_BYTES = 4 * 1024 * 1024
export interface StackImportResult { added: number; skipped: number; total: number }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const checkAbort = (signal?: AbortSignal): void => { signal?.throwIfAborted() }

function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Неизвестное поле конфигурации.')
}

/** Inventory only. No settings, credentials, HTTP, or advisory imports. */
export function parseStackConfig(input: string): StackComponent[] {
  if (Buffer.byteLength(input, 'utf8') > MAX_BYTES) throw new Error('Конфигурация превышает 4 МиБ.')
  let root: unknown
  try { root = JSON.parse(input.replace(/^\uFEFF/, '')) } catch { throw new Error('Некорректный JSON конфигурации.') }
  if (!object(root)) throw new Error('Ожидается объект конфигурации.')
  keys(root, ['schemaVersion', 'components'])
  if (root.schemaVersion !== 1) throw new Error('Поддерживается только schemaVersion: 1.')
  if (!Array.isArray(root.components) || !root.components.length || root.components.length > 1000) throw new Error('Ожидается от 1 до 1000 компонентов.')
  const identities = new Set<string>()
  return root.components.map((value, index) => {
    try {
      const component = parseStackComponent(value)
      const identity = JSON.stringify([component.vendor, component.product, component.version])
      if (identities.has(identity)) throw new Error('Повтор vendor/product/version внутри файла.')
      identities.add(identity)
      return component
    } catch (error) { throw new Error(`Компонент ${index + 1}: ${error instanceof Error ? error.message : 'ошибка формата'}`) }
  })
}

export function importStackConfig(db: Db, input: string, signal?: AbortSignal): StackImportResult {
  checkAbort(signal)
  const components = parseStackConfig(input)
  return db.transaction(tx => {
    let added = 0
    let skipped = 0
    for (const component of components) {
      checkAbort(signal)
      // NULL-safe identity also prevents duplicates left possible by SQLite's nullable UNIQUE index.
      const existing = tx.select().from(stack).where(and(
        component.vendor == null ? isNull(stack.vendor) : eq(stack.vendor, component.vendor),
        eq(stack.product, component.product), eq(stack.version, component.version!)
      )).all()
      if (existing.length) {
        if (existing.length !== 1 || Object.entries(component).some(([key, value]) => existing[0][key as keyof typeof existing[0]] !== value)) {
          throw new Error(`Конфликт компонента ${component.product} ${component.version}: существующая запись отличается. Данные не изменены.`)
        }
        skipped++
      } else {
        tx.insert(stack).values(component).run()
        added++
      }
    }
    checkAbort(signal)
    return { added, skipped, total: tx.select({ count: count() }).from(stack).get()!.count }
  })
}

export async function importStackConfigFile(db: Db, path: string, signal?: AbortSignal): Promise<StackImportResult> {
  checkAbort(signal)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024, signal })) {
    size += chunk.length
    if (size > MAX_BYTES) throw new Error('Конфигурация превышает 4 МиБ.')
    chunks.push(chunk as Buffer)
  }
  return importStackConfig(db, new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), signal)
}
