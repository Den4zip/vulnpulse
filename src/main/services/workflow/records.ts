import { eq } from 'drizzle-orm'
import type { Db } from '@main/db'
import { vulnerabilities } from '@main/db/schema'
import { ServiceError } from '../errors'

export type Reader = Pick<Db, 'select'>

export function requireVulnerability(db: Reader, id: number): void {
  if (!db.select({ id: vulnerabilities.id }).from(vulnerabilities).where(eq(vulnerabilities.id, id)).get()) {
    throw new ServiceError('NOT_FOUND')
  }
}

export { nextRevision } from '../validation'
