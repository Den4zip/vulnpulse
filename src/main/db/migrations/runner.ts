import type { DatabaseSync } from 'node:sqlite'

export interface Migration {
  readonly name: string
  readonly sql: string
}

export function applyMigrations(db: DatabaseSync, migrations: readonly Migration[]): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  )

  const appliedRows = db.prepare('SELECT name FROM schema_migrations').all() as Array<{
    name: string
  }>
  const applied = new Set(appliedRows.map((row) => row['name']))

  for (const migration of migrations) {
    if (applied.has(migration.name)) {
      continue
    }
    db.exec('BEGIN')
    try {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(migration.name)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`Migration ${migration.name} failed: ${(err as Error).message}`)
    }
  }
}
