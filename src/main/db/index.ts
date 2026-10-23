import { DatabaseSync } from 'node:sqlite'
import { migrations } from './migrations'
import { applyMigrations } from './migrations/runner'

export const DB_FILENAME = 'vulnpulse.db'

export type Db = DatabaseSync

export function initDb(dbPath: string): Db {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA foreign_keys = ON')
    if (dbPath !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL')
    }
    applyMigrations(db, migrations)
    return db
  } catch (err) {
    db.close()
    throw err
  }
}
