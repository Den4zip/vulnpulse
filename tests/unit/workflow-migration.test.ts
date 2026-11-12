import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDb } from '@main/db'
import { migrations } from '@main/db/migrations'
import { applyMigrations } from '@main/db/migrations/runner'

function legacy(path = ':memory:') {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys=ON')
  applyMigrations(db, migrations.slice(0, 3))
  db.exec(`INSERT INTO feeds(id,name,source,etag,sync_state) VALUES(1,'nvd','fixture','keep-etag','keep-state');
    INSERT INTO vulnerabilities(id,ext_id,feed_id,status) VALUES(5,'CVE-2024-0001',1,'Affected');
    INSERT INTO source_records(id,feed_id,source_id,raw_json) VALUES(7,1,'CVE-2024-0001','keep raw');
    INSERT INTO vulnerability_sources(vulnerability_id,source_record_id) VALUES(5,7);
    INSERT INTO stack(id,kind,name,product,version) VALUES(9,'package','Keep','keep','1.0');
    INSERT INTO matches(vulnerability_id,stack_id) VALUES(5,9);
    INSERT INTO notes(id,vulnerability_id,body,created_at) VALUES(20,5,'keep note','2026-11-06 12:00:00');
    INSERT INTO sla(id,vulnerability_id,due_at,patched_at) VALUES(30,5,'2026-12-01','legacy patch date');`)
  return db
}

describe('Workflow revision migration', () => {
  it('preserves a populated file database, IDs, text, dates and relationships across migration and reopening', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vulnpulse-workflow-migration-'))
    const path = join(directory, 'test.db')
    let old: DatabaseSync | undefined
    let db: ReturnType<typeof initDb> | undefined
    try {
      old = legacy(path)
      old.close(); old = undefined
      db = initDb(path)
      expect(db.$client.prepare('SELECT * FROM notes').get()).toMatchObject({ id: 20, vulnerability_id: 5, body: 'keep note', created_at: '2026-11-06 12:00:00', revision: 1 })
      expect(db.$client.prepare('SELECT * FROM sla').get()).toMatchObject({ id: 30, vulnerability_id: 5, due_at: '2026-12-01', patched_at: 'legacy patch date', revision: 1 })
      expect(db.$client.prepare('SELECT * FROM feeds').get()).toMatchObject({ etag: 'keep-etag', sync_state: 'keep-state' })
      expect(db.$client.prepare('SELECT * FROM vulnerabilities').get()).toMatchObject({ id: 5, status: 'Affected' })
      expect(db.$client.prepare('SELECT * FROM source_records').get()).toMatchObject({ id: 7, raw_json: 'keep raw' })
      expect(db.$client.prepare('SELECT * FROM vulnerability_sources').all()).toHaveLength(1)
      expect(db.$client.prepare('SELECT * FROM matches').all()).toHaveLength(1)
      expect(db.$client.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name='idx_notes_vulnerability_id'").get()).toBeTruthy()
      applyMigrations(db.$client, migrations)
      expect(db.$client.prepare('SELECT name FROM schema_migrations').all()).toHaveLength(migrations.length)
      const next = db.$client.prepare("INSERT INTO notes(vulnerability_id,body) VALUES(5,'new note') RETURNING id,revision").get()!
      expect(Number(next.id)).toBeGreaterThan(20)
      expect(next.revision).toBe(1)
      db.$client.close(); db = undefined
      db = initDb(path)
      expect(db.$client.prepare('SELECT count(*) AS n FROM notes').get()).toMatchObject({ n: 2 })
      expect(db.$client.prepare('SELECT revision FROM sla').get()).toMatchObject({ revision: 1 })
      expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { old?.close(); db?.$client.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('rolls back both new columns if index creation fails, then retries successfully', () => {
    const db = legacy()
    try {
      db.exec('CREATE INDEX idx_notes_vulnerability_id ON notes(body)')
      expect(() => applyMigrations(db, migrations)).toThrow()
      expect(db.prepare('PRAGMA table_info(notes)').all().some(row => row.name === 'revision')).toBe(false)
      expect(db.prepare('PRAGMA table_info(sla)').all().some(row => row.name === 'revision')).toBe(false)
      expect(db.prepare('SELECT name FROM schema_migrations').all()).toHaveLength(3)
      expect(db.prepare('SELECT body FROM notes').get()).toMatchObject({ body: 'keep note' })
      db.exec('DROP INDEX idx_notes_vulnerability_id')
      applyMigrations(db, migrations)
      expect(db.prepare('SELECT revision FROM notes').get()).toMatchObject({ revision: 1 })
      expect(db.prepare('SELECT revision FROM sla').get()).toMatchObject({ revision: 1 })
    } finally { db.close() }
  })
})
