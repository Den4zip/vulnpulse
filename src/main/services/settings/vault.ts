import { ServiceError } from '../errors'
import { validKey } from './validation'

export interface SecretCrypto {
  isAsyncEncryptionAvailable(): Promise<boolean>
  getSelectedStorageBackend(): string
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

/** No plaintext fallback; all cryptographic errors stay private to Main. */
export class KeyVault {
  constructor(private readonly crypto: SecretCrypto, private readonly platform = process.platform) {}

  async available(): Promise<boolean> {
    try {
      if (!await this.crypto.isAsyncEncryptionAvailable()) return false
      return this.platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(this.crypto.getSelectedStorageBackend())
    } catch { return false }
  }

  async encrypt(value: string): Promise<Buffer> {
    try {
      if (!await this.available()) throw new Error()
      const encrypted = await this.crypto.encryptStringAsync(value)
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > 4096) throw new Error()
      return encrypted
    } catch { throw new ServiceError('UNAVAILABLE') }
  }

  async decrypt(ciphertext: Buffer): Promise<{ key: string; needsReencrypt: boolean }> {
    try {
      if (!Buffer.isBuffer(ciphertext) || !ciphertext.length || ciphertext.length > 4096 || !await this.available()) throw new Error()
      const decrypted = await this.crypto.decryptStringAsync(ciphertext)
      if (!validKey(decrypted.result) || typeof decrypted.shouldReEncrypt !== 'boolean') throw new Error()
      return { key: decrypted.result, needsReencrypt: decrypted.shouldReEncrypt }
    } catch { throw new ServiceError('UNAVAILABLE') }
  }
}
