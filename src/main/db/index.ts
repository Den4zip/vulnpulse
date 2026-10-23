import { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/node-sqlite'
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
import { migrations } from './migrations'
import { applyMigrations } from './migrations/runner'

export const DB_FILENAME = 'vulnpulse.db'

export type Db = NodeSQLiteDatabase

export function initDb(dbPath: string): Db {
  const client = new DatabaseSync(dbPath)
  try {
    client.exec('PRAGMA foreign_keys = ON')
    if (dbPath !== ':memory:') {
      client.exec('PRAGMA journal_mode = WAL')
    }
    applyMigrations(client, migrations)
    return drizzle({ client })
  } catch (err) {
    client.close()
    throw err
  }
}
