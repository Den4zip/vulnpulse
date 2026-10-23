import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { initDb, type Db } from '@main/db'
import { feeds, vulnerabilities, stack, matches, notes, sla } from '@main/db/schema'
import { eq, sql } from 'drizzle-orm'

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'vulnpulse-db-'))
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function insertFeed(db: Db): number {
  const [row] = db
    .insert(feeds)
    .values({ name: 'cisa', source: 'https://example.org/kev.json' })
    .returning({ id: feeds.id })
    .all()
  return row.id
}

function insertVulnerability(db: Db, feedId: number, extId = 'CVE-2024-0001'): number {
  const [row] = db
    .insert(vulnerabilities)
    .values({
      extId,
      feedId,
      title: 'Test vulnerability',
      severity: 'High',
      cvssScore: 7.5,
      status: 'New',
      isKnownExploited: true
    })
    .returning({ id: vulnerabilities.id })
    .all()
  return row.id
}

describe('db layer (drizzle over node:sqlite)', () => {
  it('applies migration and creates all tables', () => {
    const db = initDb(':memory:')
    const client = db.$client
    const tables = client
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
    client.close()
  })

  it('is idempotent: reopening the same file does not reapply migrations', () => {
    const dbPath = path.join(tmpDir, 'test.db')

    const first = initDb(dbPath)
    first.$client.close()

    const second = initDb(dbPath)
    const rows = second.$client.prepare('SELECT name FROM schema_migrations').all() as Array<{
      name: string
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]['name']).toBe('001_init')
    second.$client.close()
  })

  it('defaults status, is_known_exploited and created_at', () => {
    const db = initDb(':memory:')
    const feedId = insertFeed(db)
    const [row] = db
      .insert(vulnerabilities)
      .values({ extId: 'CVE-DEFAULT-1', feedId })
      .returning()
      .all()

    expect(row.status).toBe('New')
    expect(row.isKnownExploited).toBe(false)
    expect(row.createdAt).not.toBeNull()
    expect(typeof row.createdAt).toBe('string')
    db.$client.close()
  })

  it('maps booleans through integer mode', () => {
    const db = initDb(':memory:')
    const feedId = insertFeed(db)
    const vulnId = insertVulnerability(db, feedId)
    const [row] = db.select().from(vulnerabilities).where(eq(vulnerabilities.id, vulnId)).all()

    expect(row.isKnownExploited).toBe(true)
    db.$client.close()
  })

  it('enables foreign keys and rejects orphans', () => {
    const db = initDb(':memory:')
    expect(() =>
      db
        .insert(vulnerabilities)
        .values({ extId: 'CVE-2024-7777', feedId: 999 })
        .returning()
        .all()
    ).toThrow()
    db.$client.close()
  })

  it('validates severity and status CHECK constraints', () => {
    const db = initDb(':memory:')
    const feedId = insertFeed(db)

    expect(() =>
      db
        .insert(vulnerabilities)
        .values({ extId: 'CVE-BAD-SEV', feedId, severity: 'Catastrophic' })
        .returning()
        .all()
    ).toThrow()

    expect(() =>
      db
        .insert(vulnerabilities)
        .values({ extId: 'CVE-BAD-STATUS', feedId, status: 'Closed' })
        .returning()
        .all()
    ).toThrow()
    db.$client.close()
  })

  it('cascades deletes from feeds down to notes and sla', () => {
    const db = initDb(':memory:')
    const feedId = insertFeed(db)
    const vulnId = insertVulnerability(db, feedId)

    db.insert(notes).values({ vulnerabilityId: vulnId, body: 'note' }).all()
    db.insert(sla).values({ vulnerabilityId: vulnId, dueAt: new Date().toISOString() }).all()

    db.delete(feeds).where(eq(feeds.id, feedId)).run()

    for (const table of [vulnerabilities, notes, sla]) {
      const [cnt] = db.select({ c: sql<number>`count(*)` }).from(table).all()
      expect(cnt.c).toBe(0)
    }
    db.$client.close()
  })

  it('enforces UNIQUE (vulnerability_id, stack_id) on matches', () => {
    const db = initDb(':memory:')
    const feedId = insertFeed(db)
    const vulnId = insertVulnerability(db, feedId)

    const [stackRow] = db
      .insert(stack)
      .values({ kind: 'package', name: 'nginx', product: 'nginx', version: '1.24.0' })
      .returning({ id: stack.id })
      .all()

    db.insert(matches).values({ vulnerabilityId: vulnId, stackId: stackRow.id, confidence: 0.95 }).all()
    expect(() =>
      db.insert(matches).values({ vulnerabilityId: vulnId, stackId: stackRow.id }).all()
    ).toThrow()
    db.$client.close()
  })
})
