import { sql } from 'drizzle-orm'
import { VulnStatus } from '../../shared/enums'
import type { Severity, FeedName, StackKind } from '../../shared/enums'
import {
  integer,
  real,
  sqliteTable,
  text,
  index,
  primaryKey,
  uniqueIndex,
  check
} from 'drizzle-orm/sqlite-core'

export const feeds = sqliteTable('feeds', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').$type<FeedName>().notNull().unique(),
  source: text('source').notNull(),
  etag: text('etag'),
  lastStartedAt: text('last_started_at'),
  lastFinishedAt: text('last_finished_at'),
  lastError: text('last_error')
})

export const vulnerabilities = sqliteTable(
  'vulnerabilities',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    extId: text('ext_id').notNull().unique(),
    feedId: integer('feed_id')
      .notNull()
      .references(() => feeds.id, { onDelete: 'cascade' }),
    title: text('title'),
    description: text('description'),
    severity: text('severity').$type<Severity>(),
    cvssScore: real('cvss_score'),
    cvssVector: text('cvss_vector'),
    status: text('status').$type<VulnStatus>().notNull().default(VulnStatus.New),
    isKnownExploited: integer('is_known_exploited', { mode: 'boolean' })
      .notNull()
      .default(false),
    publishedAt: text('published_at'),
    modifiedAt: text('modified_at'),
    rawJson: text('raw_json'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    check('severity_check', sql`${table.severity} IS NULL OR ${table.severity} IN ('Critical', 'High', 'Medium', 'Low', 'None')`),
    check('status_check', sql`${table.status} IN ('New', 'Analyzing', 'Affected', 'In Progress', 'Patched', 'False Positive')`),
    index('idx_vulnerabilities_severity').on(table.severity),
    index('idx_vulnerabilities_status').on(table.status),
    index('idx_vulnerabilities_feed_id').on(table.feedId)
  ]
)

export const vulnerabilityCpes = sqliteTable(
  'vulnerability_cpes',
  {
    vulnerabilityId: integer('vulnerability_id')
      .notNull()
      .references(() => vulnerabilities.id, { onDelete: 'cascade' }),
    cpe23: text('cpe23').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.vulnerabilityId, table.cpe23] }),
    index('idx_vulnerability_cpes_cpe23').on(table.cpe23)
  ]
)

export const stack = sqliteTable(
  'stack',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').$type<StackKind>().notNull(),
    name: text('name').notNull(),
    vendor: text('vendor'),
    product: text('product').notNull(),
    version: text('version'),
    cpe23: text('cpe23'),
    purl: text('purl'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    check(
      'stack_kind_check',
      sql`${table.kind} IN ('application', 'system', 'package')`
    ),
    uniqueIndex('idx_stack_vendor_product_version').on(
      table.vendor,
      table.product,
      table.version
    ),
    index('idx_stack_cpe23').on(table.cpe23),
    index('idx_stack_purl').on(table.purl)
  ]
)

export const matches = sqliteTable(
  'matches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    vulnerabilityId: integer('vulnerability_id')
      .notNull()
      .references(() => vulnerabilities.id, { onDelete: 'cascade' }),
    stackId: integer('stack_id')
      .notNull()
      .references(() => stack.id, { onDelete: 'cascade' }),
    confidence: real('confidence').notNull().default(1.0),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    uniqueIndex('uq_matches_vulnerability_stack').on(
      table.vulnerabilityId,
      table.stackId
    ),
    index('idx_matches_stack_id').on(table.stackId)
  ]
)

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vulnerabilityId: integer('vulnerability_id')
    .notNull()
    .references(() => vulnerabilities.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`)
})

export const sla = sqliteTable('sla', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vulnerabilityId: integer('vulnerability_id')
    .notNull()
    .unique()
    .references(() => vulnerabilities.id, { onDelete: 'cascade' }),
  dueAt: text('due_at').notNull(),
  patchedAt: text('patched_at')
})

export type FeedRow = typeof feeds.$inferSelect
export type NewFeedRow = typeof feeds.$inferInsert
export type VulnerabilityRow = typeof vulnerabilities.$inferSelect
export type NewVulnerabilityRow = typeof vulnerabilities.$inferInsert
export type VulnerabilityCpeRow = typeof vulnerabilityCpes.$inferSelect
export type StackRow = typeof stack.$inferSelect
export type NewStackRow = typeof stack.$inferInsert
export type MatchRow = typeof matches.$inferSelect
export type NoteRow = typeof notes.$inferSelect
export type SlaRow = typeof sla.$inferSelect
