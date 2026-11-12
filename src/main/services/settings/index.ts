import { and, eq } from 'drizzle-orm'
import type { Db } from '@main/db'
import { appSecrets, settings } from '@main/db/schema'
import type { NetworkFeed, SettingsView, StoredSettings } from '@shared/api'
import { ServiceError } from '../errors'
import { nextRevision } from '../validation'
import { DEFAULT_FEEDS, keyRemove, keyWrite, readSettings, settingsUpdate } from './validation'
import { KeyVault } from './vault'

const KEY_NAME = 'nvd_api_key'

export class SettingsService {
  private readonly listeners = new Set<(value: StoredSettings) => void>()
  private pending: Promise<unknown> | null = null
  private disposed = false

  constructor(private readonly db: Db, private readonly vault: KeyVault, private readonly externalBusy: () => boolean = () => false) {
    db.transaction((tx) => {
      tx.insert(settings).values({ id: 1, valueJson: JSON.stringify({ version: 1, feeds: DEFAULT_FEEDS }) }).onConflictDoNothing().run()
      tx.insert(appSecrets).values({ name: KEY_NAME }).onConflictDoNothing().run()
    })
    this.configuration()
  }

  get isWriting(): boolean { return this.pending !== null }

  configuration(): StoredSettings {
    this.open()
    try {
      const row = this.db.select().from(settings).where(eq(settings.id, 1)).get()!
      if (!row || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error()
      return { revision: row.revision, feeds: readSettings(row.valueJson) }
    } catch { throw new ServiceError('INTERNAL_ERROR') }
  }

  async get(input?: unknown): Promise<SettingsView> {
    if (input !== undefined) throw new ServiceError('INVALID_ARGUMENT')
    const config = this.configuration()
    const secret = this.secret()
    const storageAvailable = await this.vault.available()
    let status: SettingsView['nvdKey']['status'] = secret.ciphertext ? 'unavailable' : 'missing'
    let needsReencrypt = false
    if (secret.ciphertext && storageAvailable) {
      try { needsReencrypt = (await this.vault.decrypt(secret.ciphertext)).needsReencrypt; status = 'available' } catch { /* safe metadata only */ }
    }
    return { ...config, osvMode: 'local-json', nvdKey: { revision: secret.revision,
      configured: secret.ciphertext !== null, storageAvailable, status, needsReencrypt } }
  }

  update(input: unknown): Promise<SettingsView> {
    const value = settingsUpdate(input)
    return this.write(async () => {
      this.db.transaction((tx) => {
        const previous = tx.select().from(settings).where(eq(settings.id, 1)).get()!
        if (previous.revision !== value.expectedRevision) throw new ServiceError('CONFLICT')
        const row = tx.update(settings).set({ valueJson: JSON.stringify({ version: 1, feeds: value.feeds }), revision: nextRevision(previous.revision) })
          .where(and(eq(settings.id, 1), eq(settings.revision, value.expectedRevision))).returning({ id: settings.id }).get()
        if (!row) throw new ServiceError('CONFLICT')
      }, { behavior: 'immediate' })
      return this.get()
    })
  }

  setNvdApiKey(input: unknown): Promise<SettingsView> {
    const value = keyWrite(input)
    return this.write(async () => {
      // Never hold a SQLite transaction during OS keychain initialization/encryption.
      if (this.secret().revision !== value.expectedRevision) throw new ServiceError('CONFLICT')
      const ciphertext = await this.vault.encrypt(value.apiKey)
      this.open()
      this.replaceKey(value.expectedRevision, ciphertext)
      return this.get()
    })
  }

  removeNvdApiKey(input: unknown): Promise<SettingsView> {
    const value = keyRemove(input)
    return this.write(async () => { this.replaceKey(value.expectedRevision, null); return this.get() })
  }

  /** Main-only: used at the start of NVD sync, never registered as IPC. */
  async apiKeyForNvd(): Promise<string | undefined> {
    this.open()
    const row = this.secret()
    return row.ciphertext === null ? undefined : (await this.vault.decrypt(row.ciphertext)).key
  }

  setFeedEnabled(name: NetworkFeed, enabled: boolean): Promise<SettingsView> {
    const current = this.configuration()
    return this.update({ expectedRevision: current.revision, feeds: { ...current.feeds, [name]: { ...current.feeds[name], enabled } } })
  }

  subscribe(listener: (value: StoredSettings) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.pending?.catch(() => {})
    this.listeners.clear()
  }

  private secret() {
    const row = this.db.select().from(appSecrets).where(eq(appSecrets.name, KEY_NAME)).get()
    if (!row || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new ServiceError('INTERNAL_ERROR')
    return row
  }

  private replaceKey(expected: number, ciphertext: Buffer | null): void {
    this.db.transaction((tx) => {
      const previous = this.secret()
      if (previous.revision !== expected) throw new ServiceError('CONFLICT')
      const saved = tx.update(appSecrets).set({ ciphertext, revision: nextRevision(previous.revision) })
        .where(and(eq(appSecrets.name, KEY_NAME), eq(appSecrets.revision, expected))).returning({ name: appSecrets.name }).get()
      if (!saved) throw new ServiceError('CONFLICT')
    }, { behavior: 'immediate' })
  }

  private write(operation: () => Promise<SettingsView>): Promise<SettingsView> {
    this.open()
    if (this.pending || this.externalBusy()) throw new ServiceError('BUSY')
    const task = Promise.resolve().then(() => { this.open(); return operation() }).finally(() => {
      this.pending = null
      if (!this.disposed) {
        for (const listener of this.listeners) {
          try { listener(this.configuration()) } catch { console.error('Settings observer failed') }
        }
      }
    })
    this.pending = task
    return task
  }

  private open(): void { if (this.disposed) throw new ServiceError('UNAVAILABLE') }
}
