import sql001 from './001_init.sql?raw'
import type { Migration } from './runner'

export const migrations: readonly Migration[] = [
  {
    name: '001_init',
    sql: sql001
  }
]
