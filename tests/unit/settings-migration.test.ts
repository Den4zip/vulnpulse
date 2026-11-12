import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { applyMigrations } from '@main/db/migrations/runner'
import { migrations } from '@main/db/migrations'

describe('Settings migration', () => {
  it('adds separate stores without altering existing user workflow/source data and is idempotent', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('PRAGMA foreign_keys=ON')
      applyMigrations(db, migrations.slice(0, 4))
      db.exec(`INSERT INTO feeds(id,name,source,etag,sync_state) VALUES(1,'nvd','fixture','keep-etag','keep-state');
        INSERT INTO vulnerabilities(id,ext_id,feed_id,status) VALUES(1,'CVE-2024-0001',1,'Affected');
        INSERT INTO notes(id,vulnerability_id,body,revision) VALUES(2,1,'keep note',5);
        INSERT INTO sla(id,vulnerability_id,due_at,revision) VALUES(3,1,'2026-12-01',4);`)
      applyMigrations(db, migrations)
      applyMigrations(db, migrations)
      expect(db.prepare('SELECT * FROM settings').all()).toEqual([])
      expect(db.prepare('SELECT * FROM app_secrets').all()).toEqual([])
      expect(db.prepare('SELECT name FROM schema_migrations').all()).toHaveLength(5)
      expect(db.prepare('SELECT * FROM notes').get()).toMatchObject({ id: 2, body: 'keep note', revision: 5 })
      expect(db.prepare('SELECT * FROM sla').get()).toMatchObject({ id: 3, due_at: '2026-12-01', revision: 4 })
      expect(db.prepare('SELECT * FROM vulnerabilities').get()).toMatchObject({ status: 'Affected' })
      expect(db.prepare('SELECT * FROM feeds').get()).toMatchObject({ etag: 'keep-etag', sync_state: 'keep-state' })
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { db.close() }
  })
})
