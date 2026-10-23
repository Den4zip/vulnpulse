import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { initDb, type Db } from '@main/db'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'vulnpulse-db-'))
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function insertFeed(db: Db): number {
  const res = db.prepare('INSERT INTO feeds (name, source) VALUES (?, ?)').run('cisa', 'https://example.org/kev.json')
  return Number(res.lastInsertRowid)
}

function insertVulnerability(db: Db, feedId: number, extId = 'CVE-2024-0001'): number {
  const res = db
    .prepare(
      'INSERT INTO vulnerabilities (ext_id, feed_id, title, severity, cvss_score, status, is_known_exploited) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(extId, feedId, 'Test vulnerability', 'High', 7.5, 'New', 1)
  return Number(res.lastInsertRowid)
}

describe('db layer', () => {
  it('applies migration and creates all tables', () => {
    const db = initDb(':memory:')
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
    const names = tables.map((t) => t.name).sort()

    expect(names).toEqual(
      expect.arrayContaining([
        'schema_migrations',
        'feeds',
        'vulnerabilities',
        'vulnerability_cpes',
        'stack',
        'matches',
        'notes',
        'sla'
      ])
    )
    db.close()
  })

  it('is idempotent: reopening the same file does not reapply migrations', () => {
    const dbPath = path.join(tmpDir, 'test.db')

    const first = initDb(dbPath)
    first.close()

    const second = initDb(dbPath)
    const rows = second.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]['name']).toBe('001_init')
    second.close()
  })

  it('enables foreign keys and rejects orphans', () => {
    const db = initDb(':memory:')
    expect(() =>
      db
        .prepare('INSERT INTO vulnerabilities (ext_id, feed_id) VALUES (?, ?)')
        .run('CVE-2024-7777', 999)
    ).toThrow()
    db.close()
  })

  it('validates severity and status CHECK constraints', () => {
    const db = initDb(':memory:')
    const feedId = insertFeed(db)

    expect(() =>
      db
        .prepare('INSERT INTO vulnerabilities (ext_id, feed_id, severity) VALUES (?, ?, ?)')
        .run('CVE-BAD-SEV', feedId, 'Catastrophic')
    ).toThrow()

    expect(() =>
      db
        .prepare('INSERT INTO vulnerabilities (ext_id, feed_id, status) VALUES (?, ?, ?)')
        .run('CVE-BAD-STATUS', feedId, 'Closed')
    ).toThrow()
    db.close()
  })

  it('cascades deletes from feeds down to notes and sla', () => {
    const db = initDb(':memory:')
    const feedId = insertFeed(db)
    const vulnId = insertVulnerability(db, feedId)

    db.prepare('INSERT INTO notes (vulnerability_id, body) VALUES (?, ?)').run(vulnId, 'note')
    db
      .prepare('INSERT INTO sla (vulnerability_id, due_at) VALUES (?, ?)')
      .run(vulnId, new Date().toISOString())

    db.prepare('DELETE FROM feeds WHERE id = ?').run(feedId)

    expect(db.prepare('SELECT COUNT(*) AS c FROM vulnerabilities').get()).toEqual({ c: 0 })
    expect(db.prepare('SELECT COUNT(*) AS c FROM notes').get()).toEqual({ c: 0 })
    expect(db.prepare('SELECT COUNT(*) AS c FROM sla').get()).toEqual({ c: 0 })
    db.close()
  })

  it('enforces UNIQUE (vulnerability_id, stack_id) on matches', () => {
    const db = initDb(':memory:')
    const feedId = insertFeed(db)
    const vulnId = insertVulnerability(db, feedId)

    db
      .prepare('INSERT INTO stack (kind, name, product, version) VALUES (?, ?, ?, ?)')
      .run('package', 'nginx', 'nginx', '1.24.0')

    db.prepare('INSERT INTO matches (vulnerability_id, stack_id, confidence) VALUES (?, ?, ?)').run(
      vulnId,
      1,
      0.95
    )
    expect(() =>
      db.prepare('INSERT INTO matches (vulnerability_id, stack_id) VALUES (?, ?)').run(vulnId, 1)
    ).toThrow()
    db.close()
  })
})
