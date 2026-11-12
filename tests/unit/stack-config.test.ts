import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDb, type Db } from '@main/db'
import { stack } from '@main/db/schema'
import { importStackConfig, importStackConfigFile, parseStackConfig } from '@main/services/stack/config'

const example = readFileSync(resolve('examples/local-stack.example.json'), 'utf8')
const component = JSON.parse(example).components[0]
const config = (components: unknown[]) => JSON.stringify({ schemaVersion: 1, components })
let db: Db
beforeEach(() => { db = initDb(':memory:') })
afterEach(() => { db.$client.close() })

describe('local inventory configuration', () => {
  it('loads the distributed UTF-8 example and repeats without duplicate NULL-vendor rows', async () => {
    expect(await importStackConfigFile(db, resolve('examples/local-stack.example.json'))).toEqual({ added: 4, skipped: 0, total: 4 })
    expect(importStackConfig(db, '\uFEFF' + example)).toEqual({ added: 0, skipped: 4, total: 4 })
    expect(db.select().from(stack).all().map(row => row.version)).toEqual(['4.17.20', '4.2.0', '2.14.1', '2.4.57'])
  })

  it('rolls back preceding additions on a conflict and preserves existing ids/metadata', () => {
    importStackConfig(db, config([component]))
    const previous = db.select().from(stack).all()
    expect(() => importStackConfig(db, config([JSON.parse(example).components[1], { ...component, name: 'Changed' }]))).toThrow('Конфликт')
    expect(db.select().from(stack).all()).toEqual(previous)
  })

  it('does not silently accept legacy duplicate identities', () => {
    const parsed = parseStackConfig(config([component]))[0]
    db.insert(stack).values([parsed, parsed]).run()
    expect(() => importStackConfig(db, config([component]))).toThrow('Конфликт')
    expect(db.select().from(stack).all()).toHaveLength(2)
  })

  it.each([
    '{', 'null', '[]', '{"schemaVersion":2,"components":[]}', '{"schemaVersion":1,"components":[]}',
    JSON.stringify({ schemaVersion: 1, components: [component], apiKey: 'not-a-real-key' }),
    config([component, component]), config([null]), config([{ ...component, kind: 'invalid' }]),
    config([{ ...component, version: '*' }]), config([{ ...component, version: '-' }]),
    config([{ ...component, name: ' spaced ' }]), config([{ ...component, product: '' }]),
    config([{ ...component, purl: null }]), config([{ ...component, purl: 'not-purl' }]),
    config([{ ...component, purl: 'pkg:npm/lodash@4.17.21' }]),
    config([{ ...component, purl: 'pkg:npm/lodash@4.17.20?arch=x64' }]),
    config([{ ...component, purl: 'pkg:npm/lodash@4.17.20#lib' }]),
    config([{ ...component, product: 'other' }]),
    config([{ ...JSON.parse(example).components[3], vendor: '*' }]),
    config([{ ...JSON.parse(example).components[3], version: '2.4.58' }]),
    config([{ ...JSON.parse(example).components[3], cpe23: 'bad-cpe' }]),
    config(Array.from({ length: 1001 }, () => component)),
    ' '.repeat(4 * 1024 * 1024 + 1)
  ])('rejects invalid/configuration-mismatched input atomically (%#)', input => {
    expect(() => importStackConfig(db, input)).toThrow()
    expect(db.select().from(stack).all()).toHaveLength(0)
  })

  it('rejects missing, oversized and invalid UTF-8 files, and respects cancellation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vulnpulse-config-'))
    try {
      await expect(importStackConfigFile(db, join(dir, 'missing.json'))).rejects.toThrow()
      const path = join(dir, 'bad.json')
      writeFileSync(path, Buffer.from([0xff]))
      await expect(importStackConfigFile(db, path)).rejects.toThrow()
      writeFileSync(path, ' '.repeat(4 * 1024 * 1024 + 1))
      await expect(importStackConfigFile(db, path)).rejects.toThrow('4 МиБ')
      const controller = new AbortController()
      controller.abort()
      await expect(importStackConfigFile(db, resolve('examples/local-stack.example.json'), controller.signal)).rejects.toThrow()
      expect(() => importStackConfig(db, example, controller.signal)).toThrow()
      expect(db.select().from(stack).all()).toHaveLength(0)
    } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  })
})
