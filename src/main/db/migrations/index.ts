import sql001 from './20261023190921_init/migration.sql?raw'
import type { Migration } from './runner'

export const migrations: readonly Migration[] = [
  {
    name: '001_init',
    sql: sql001
  }
]
