import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { applyMigrations, type Migration } from '@main/db/migrations/runner'

describe('applyMigrations (runner)', () => {
  it('applies only newly added migrations on subsequent calls', () => {
    const db = new DatabaseSync(':memory:')
    const base: Migration[] = [
      { name: '001_base', sql: 'CREATE TABLE t1 (id INTEGER PRIMARY KEY)' }
    ]
    const extended: Migration[] = [
      ...base,
      { name: '002_extra', sql: 'CREATE TABLE t2 (id INTEGER PRIMARY KEY)' }
    ]

    applyMigrations(db, base)
    applyMigrations(db, extended)

    const rows = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as Array<{
      name: string
    }>
    expect(rows.map((r) => r.name)).toEqual(['001_base', '002_extra'])
    db.close()
  })

  it('rolls back a failing migration leaving no partial state', () => {
    const db = new DatabaseSync(':memory:')
    const list: Migration[] = [
      {
        name: '001_ok',
        sql: 'CREATE TABLE good_table (id INTEGER PRIMARY KEY)'
      },
      {
        name: '002_fail',
        sql: 'CREATE TABLE should_not_exist (id INTEGER); MISSING_SQL_KEYWORD ('
      }
    ]

    expect(() => applyMigrations(db, list)).toThrow(/002_fail/)

    const rows = db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>
    expect(rows.map((r) => r.name)).toEqual(['001_ok'])

    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).not.toContain('should_not_exist')
    db.close()
  })
})
