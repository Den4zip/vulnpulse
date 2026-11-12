import workerPath from './workers/fstec-worker.ts?modulePath'
import type { Db } from '@main/db'
import { HttpClient } from '@main/services/httpclient'
import { FstecAdapter } from './fstec'

/** electron-vite emits the real worker and resolves its path in dev/build. */
export function createFstecAdapter(db: Db, http?: HttpClient): FstecAdapter {
  return new FstecAdapter(db, { workerPath }, http)
}
