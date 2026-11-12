import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { initDb, type Db } from '@main/db'
import { appSecrets, settings } from '@main/db/schema'
import { SettingsService } from '@main/services/settings'
import { KeyVault, type SecretCrypto } from '@main/services/settings/vault'
import { DEFAULT_FEEDS } from '@main/services/settings/validation'
import { ServiceError } from '@main/services/errors'
import { FeedScheduler } from '@main/services/scheduler'

const KEY = 'fixture-only-nvd-credential'
let db: Db
let service: SettingsService
let crypto: SecretCrypto & { isAsyncEncryptionAvailable: ReturnType<typeof vi.fn>; encryptStringAsync: ReturnType<typeof vi.fn>; decryptStringAsync: ReturnType<typeof vi.fn> }
const configured = (extra = {}) => ({ expectedRevision: 1, feeds: structuredClone(DEFAULT_FEEDS), ...extra })
beforeEach(() => {
  db = initDb(':memory:')
  // Test crypto only; production uses Electron safeStorage, exercised separately in E2E.
  const providerKey = randomBytes(32)
  crypto = {
    isAsyncEncryptionAvailable: vi.fn(async () => true), getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: vi.fn(async (value: string) => {
      expect(db.$client.isTransaction).toBe(false)
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', providerKey, iv)
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), bytes])
    }),
    decryptStringAsync: vi.fn(async (value: Buffer) => {
      expect(db.$client.isTransaction).toBe(false)
      const cipher = createDecipheriv('aes-256-gcm', providerKey, value.subarray(0, 12))
      cipher.setAuthTag(value.subarray(12, 28))
      return { result: Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8'), shouldReEncrypt: false }
    })
  }
  service = new SettingsService(db, new KeyVault(crypto, 'win32'))
})
afterEach(async () => { await service.dispose(); db.$client.close(); vi.restoreAllMocks() })

describe('Persistent settings and credential service', () => {
  it('creates opt-in defaults, returns only public metadata and never performs encryption just to initialize', async () => {
    expect(crypto.encryptStringAsync).not.toHaveBeenCalled()
    expect(await service.get()).toEqual({ revision: 1, feeds: DEFAULT_FEEDS, osvMode: 'local-json',
      nvdKey: { revision: 1, configured: false, storageAvailable: true, status: 'missing', needsReencrypt: false } })
    expect(await service.apiKeyForNvd()).toBeUndefined()
    expect(db.select().from(settings).all()).toHaveLength(1)
    expect(db.select().from(appSecrets).all()).toHaveLength(1)
    const other = new SettingsService(db, new KeyVault(crypto, 'win32'))
    try { expect(other.configuration()).toEqual(service.configuration()) } finally { await other.dispose() }
  })

  it('saves and reloads a full config, uses revisions and handles the native menu toggle through the same path', async () => {
    const feeds = structuredClone(DEFAULT_FEEDS)
    feeds.cisa.enabled = true; feeds.nvd.intervalMinutes = 240
    const saved = await service.update(configured({ feeds }))
    expect(saved).toMatchObject({ revision: 2, feeds })
    await expect(service.update(configured())).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await service.setFeedEnabled('cisa', false)).feeds.cisa.enabled).toBe(false)
    const other = new SettingsService(db, new KeyVault(crypto, 'win32'))
    try { expect(other.configuration()).toEqual(service.configuration()) } finally { await other.dispose() }
  })

  it('stores only ciphertext, decrypts only inside Main and removes without dropping revision history', async () => {
    const saved = await service.setNvdApiKey({ expectedRevision: 1, apiKey: KEY })
    expect(saved.nvdKey).toMatchObject({ revision: 2, configured: true, status: 'available' })
    expect(JSON.stringify(saved)).not.toContain(KEY)
    const row = db.select().from(appSecrets).get()!
    expect(Buffer.isBuffer(row.ciphertext)).toBe(true)
    expect(row.ciphertext!.includes(Buffer.from(KEY))).toBe(false)
    expect(db.select().from(settings).get()!.valueJson).not.toContain(KEY)
    expect(await service.apiKeyForNvd()).toBe(KEY)
    await expect(service.setNvdApiKey({ expectedRevision: 1, apiKey: 'another-fixture' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(service.removeNvdApiKey({ expectedRevision: 1 })).rejects.toMatchObject({ code: 'CONFLICT' })
    const removed = await service.removeNvdApiKey({ expectedRevision: 2 })
    expect(removed.nvdKey).toMatchObject({ revision: 3, configured: false, status: 'missing' })
    expect(await service.apiKeyForNvd()).toBeUndefined()
    expect((await service.setNvdApiKey({ expectedRevision: 3, apiKey: KEY })).nvdKey.revision).toBe(4)
    await expect(service.removeNvdApiKey({ expectedRevision: 2 })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('rejects key writes without OS protection, but permits ordinary config and deletion of an inaccessible key', async () => {
    await service.setNvdApiKey({ expectedRevision: 1, apiKey: KEY })
    const before = db.select().from(appSecrets).get()!
    crypto.isAsyncEncryptionAvailable.mockResolvedValue(false)
    expect((await service.get()).nvdKey).toMatchObject({ configured: true, storageAvailable: false, status: 'unavailable' })
    await expect(service.apiKeyForNvd()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(service.setNvdApiKey({ expectedRevision: 2, apiKey: 'replacement' })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(db.select().from(appSecrets).get()).toEqual(before)
    expect((await service.update(configured())).revision).toBe(2)
    expect((await service.removeNvdApiKey({ expectedRevision: 2 })).nvdKey).toMatchObject({ configured: false, storageAvailable: false })
  })

  it('treats damaged ciphertext as unavailable rather than silently using anonymous NVD', async () => {
    await service.setNvdApiKey({ expectedRevision: 1, apiKey: KEY })
    db.update(appSecrets).set({ ciphertext: Buffer.from('corrupt') }).run()
    expect((await service.get()).nvdKey).toMatchObject({ configured: true, status: 'unavailable' })
    await expect(service.apiKeyForNvd()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('reports OS key rotation metadata without returning plaintext or rewriting on read', async () => {
    await service.setNvdApiKey({ expectedRevision: 1, apiKey: KEY })
    const before = db.select().from(appSecrets).get()
    crypto.decryptStringAsync.mockResolvedValue({ result: KEY, shouldReEncrypt: true })
    expect((await service.get()).nvdKey).toMatchObject({ status: 'available', needsReencrypt: true })
    expect(db.select().from(appSecrets).get()).toEqual(before)
  })

  it('serializes async credential writes, blocks jobs during encryption and waits for OS work on shutdown', async () => {
    let release!: (value: Buffer) => void
    crypto.encryptStringAsync.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const task = service.setNvdApiKey({ expectedRevision: 1, apiKey: KEY })
    const checked = expect(task).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    const sync = vi.fn().mockResolvedValue({ processed: 0 })
    const scheduler = new FeedScheduler(db, [{ name: 'nvd', source: 'fixture', intervalMs: 7200000, sync }], () => service.isWriting)
    try {
      await vi.waitFor(() => expect(crypto.encryptStringAsync).toHaveBeenCalled())
      expect(service.isWriting).toBe(true)
      expect(() => service.update(configured())).toThrow(ServiceError)
      expect(await scheduler.run('nvd')).toEqual({ kind: 'busy' })
      let closed = false
      const closing = service.dispose().then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
      release(Buffer.from('encrypted'))
      await closing; await checked
      expect(db.select().from(appSecrets).get()!.ciphertext).toBeNull()
      expect(sync).not.toHaveBeenCalled()
    } finally { await scheduler.dispose() }
  })

  it('rejects all settings mutations while synchronization/import is active, allowing reads', async () => {
    const busy = new SettingsService(db, new KeyVault(crypto), () => true)
    try {
      expect((await busy.get()).revision).toBe(1)
      for (const action of [() => busy.update(configured()), () => busy.setNvdApiKey({ expectedRevision: 1, apiKey: KEY }),
        () => busy.removeNvdApiKey({ expectedRevision: 1 })]) {
        expect(action).toThrow(expect.objectContaining({ code: 'BUSY' }))
      }
    } finally { await busy.dispose() }
  })

  it('rolls back database failures and never leaves a plaintext/partial credential', async () => {
    const row = db.select().from(appSecrets).get()
    db.$client.exec("CREATE TRIGGER fail_secret BEFORE UPDATE ON app_secrets BEGIN SELECT RAISE(ABORT,'fixture'); END")
    await expect(service.setNvdApiKey({ expectedRevision: 1, apiKey: KEY })).rejects.toThrow()
    expect(db.select().from(appSecrets).get()).toEqual(row)
    db.$client.exec('DROP TRIGGER fail_secret')
    db.$client.exec("CREATE TRIGGER fail_settings BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT,'fixture'); END")
    await expect(service.update(configured())).rejects.toThrow()
    expect(service.configuration().revision).toBe(1)
  })

  it('does not reset malformed persisted settings or exhausted revisions', async () => {
    db.update(settings).set({ valueJson: '{bad' }).run()
    expect(() => service.configuration()).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }))
    expect(db.select().from(settings).get()!.valueJson).toBe('{bad')
    db.update(settings).set({ valueJson: JSON.stringify({ version: 1, feeds: DEFAULT_FEEDS }), revision: Number.MAX_SAFE_INTEGER }).run()
    await expect(service.update(configured({ expectedRevision: Number.MAX_SAFE_INTEGER }))).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    db.update(appSecrets).set({ revision: Number.MAX_SAFE_INTEGER }).run()
    await expect(service.removeNvdApiKey({ expectedRevision: Number.MAX_SAFE_INTEGER })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  it('publishes validated settings only after releasing the write lock; listener errors stay private', async () => {
    const listener = vi.fn(() => { expect(service.isWriting).toBe(false) })
    const unsubscribe = service.subscribe(listener)
    await service.update(configured())
    expect(listener).toHaveBeenCalledWith(service.configuration())
    unsubscribe()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    service.subscribe(() => { throw new Error(KEY) })
    await service.update(configured({ expectedRevision: 2 }))
    expect(log).toHaveBeenCalledWith('Settings observer failed')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it.each([null, {}, { ...configured(), unexpected: true }, { ...configured(), expectedRevision: '1' },
    { ...configured(), feeds: {} }, { ...configured(), feeds: { ...DEFAULT_FEEDS, osv: { enabled: true, intervalMinutes: 60 } } },
    ...['cisa', 'nvd', 'fstec'].flatMap(name => [
      { ...configured(), feeds: { ...DEFAULT_FEEDS, [name]: { enabled: 1, intervalMinutes: 1440 } } },
      { ...configured(), feeds: { ...DEFAULT_FEEDS, [name]: { enabled: true, intervalMinutes: 1 } } },
      { ...configured(), feeds: { ...DEFAULT_FEEDS, [name]: { enabled: true, intervalMinutes: 43201 } } }
    ])
  ])('validates settings input %#', input => { expect(() => service.update(input)).toThrow(ServiceError) })

  it.each(['', ' spaced ', 'line\nbreak', '\u0000', 'я', 'x'.repeat(257), null, 1])('rejects invalid header values without encryption %#', apiKey => {
    expect(() => service.setNvdApiKey({ expectedRevision: 1, apiKey })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    expect(crypto.encryptStringAsync).not.toHaveBeenCalled()
  })

  it('validates missing/extra key commands and read payloads and rejects after disposal', async () => {
    expect(() => service.setNvdApiKey({ apiKey: KEY })).toThrow(ServiceError)
    expect(() => service.removeNvdApiKey({ expectedRevision: 1, apiKey: KEY })).toThrow(ServiceError)
    await expect(service.get({})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await service.dispose()
    await expect(service.get()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(() => service.removeNvdApiKey({ expectedRevision: 1 })).toThrow(expect.objectContaining({ code: 'UNAVAILABLE' }))
  })
})

describe('OS vault boundary', () => {
  it.each(['basic_text', 'unknown'])('rejects Linux backend %s even if available reports true', async backend => {
    crypto.getSelectedStorageBackend = () => backend
    const vault = new KeyVault(crypto, 'linux')
    expect(await vault.available()).toBe(false)
    await expect(vault.encrypt(KEY)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(crypto.encryptStringAsync).not.toHaveBeenCalled()
  })

  it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])('accepts protected Linux backend %s', async backend => {
    crypto.getSelectedStorageBackend = () => backend
    const vault = new KeyVault(crypto, 'linux')
    expect(await vault.available()).toBe(true)
    expect((await vault.decrypt(await vault.encrypt(KEY))).key).toBe(KEY)
  })

  it('hides provider failures and rejects bad ciphertext/decrypted values', async () => {
    const vault = new KeyVault(crypto)
    crypto.isAsyncEncryptionAvailable.mockRejectedValueOnce(new Error(KEY))
    expect(await vault.available()).toBe(false)
    crypto.encryptStringAsync.mockRejectedValueOnce(new Error(KEY))
    await expect(vault.encrypt(KEY)).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'Сервис недоступен.' })
    for (const ciphertext of [Buffer.alloc(0), Buffer.alloc(4097), new Uint8Array([1])]) {
      await expect(vault.decrypt(ciphertext as Buffer)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    }
    for (const value of [Buffer.alloc(0), Buffer.alloc(4097)]) {
      crypto.encryptStringAsync.mockResolvedValueOnce(value)
      await expect(vault.encrypt(KEY)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    }
    crypto.decryptStringAsync.mockResolvedValueOnce({ result: '\r\n', shouldReEncrypt: false })
    await expect(vault.decrypt(Buffer.from('fixture'))).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    crypto.decryptStringAsync.mockResolvedValueOnce({ result: KEY, shouldReEncrypt: 'not boolean' })
    await expect(vault.decrypt(Buffer.from('fixture'))).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
})
