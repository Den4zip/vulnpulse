import sql001 from './20261023190921_init/migration.sql?raw'
import sql002 from './20261105132927_dark_masque/migration.sql?raw'
import sql003 from './20261106163217_nvd_checkpoint/migration.sql?raw'
import sql004 from './20261107133358_workflow_revisions/migration.sql?raw'
import sql005 from './20261107135229_app_settings/migration.sql?raw'
import type { Migration } from './runner'

export const migrations: readonly Migration[] = [
  {
    name: '001_init',
    sql: sql001
  },
  { name: '002_source_records', sql: sql002 },
  { name: '003_nvd_checkpoint', sql: sql003 },
  { name: '004_workflow_revisions', sql: sql004 },
  { name: '005_app_settings', sql: sql005 }
]
