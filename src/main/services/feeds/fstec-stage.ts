import { Worker } from 'node:worker_threads'
import { mkdtemp, rm } from 'node:fs/promises'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { checkedFstecRecord, fstecAbort, fstecObject, FSTEC_MAX_RECORD, FSTEC_MAX_RECORDS,
  FSTEC_MAX_SPOOL, type FstecInput, type FstecOrigin, type FstecRecord, type FstecStage } from './fstec-data'

export interface FstecWorkerOptions { readonly workerPath: string; readonly timeoutMs?: number }

function workerStage(input: FstecInput, spoolPath: string, origin: FstecOrigin,
  options: FstecWorkerOptions, signal?: AbortSignal): Promise<FstecStage> {
  fstecAbort(signal)
  const timeoutMs = options.timeoutMs ?? 300000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('Invalid FSTEC worker timeout')
  return new Promise((resolveStage, reject) => {
    const worker = new Worker(options.workerPath, { workerData: { input, spoolPath, origin },
      resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 } })
    let done = false
    const finish = (error?: Error, stage?: FstecStage): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // Do not delete a spool while the worker still has it open (notably on Windows).
      void worker.terminate().then(() => error ? reject(error) : resolveStage(stage!), reject)
    }
    const onAbort = (): void => finish(new Error('FSTEC import cancelled'))
    const timer = setTimeout(() => finish(new Error('FSTEC worker timed out')), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.once('error', () => finish(new Error('FSTEC worker failed')))
    worker.once('exit', () => finish(new Error('FSTEC worker exited before completion')))
    worker.once('message', (message: unknown) => {
      if (!fstecObject(message) || message.ok !== true || !fstecObject(message.stage)) {
        finish(new Error(fstecObject(message) && typeof message.error === 'string' ? message.error : 'Invalid FSTEC worker response'))
        return
      }
      const stage = message.stage
      if (!Number.isSafeInteger(stage.count) || (stage.count as number) < 1 || (stage.count as number) > FSTEC_MAX_RECORDS
        || !Number.isSafeInteger(stage.spoolBytes) || (stage.spoolBytes as number) < 1 || (stage.spoolBytes as number) > FSTEC_MAX_SPOOL
        || typeof stage.spoolHash !== 'string' || !/^[0-9a-f]{64}$/.test(stage.spoolHash)
        || typeof stage.sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(stage.sourceHash)) {
        finish(new Error('Invalid FSTEC stage metadata')); return
      }
      finish(undefined, stage as unknown as FstecStage)
    })
    if (signal?.aborted) onAbort()
  })
}

export async function withFstecStage<T>(input: FstecInput, origin: FstecOrigin, options: FstecWorkerOptions,
  consume: (stage: FstecStage, records: Iterable<FstecRecord>) => T, signal?: AbortSignal): Promise<T> {
  fstecAbort(signal)
  const directory = await mkdtemp(join(tmpdir(), 'vulnpulse-fstec-'))
  const spoolPath = join(directory, 'records.ndjson')
  try {
    const stage = await workerStage(input, spoolPath, origin, options, signal)
    fstecAbort(signal)
    if (statSync(spoolPath).size !== stage.spoolBytes) throw new Error('FSTEC staging size mismatch')
    return consume(stage, readStage(spoolPath, stage, signal))
  } finally {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected FSTEC staging path')
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      .catch(() => console.warn('FSTEC temporary staging cleanup failed'))
  }
}

function* readStage(path: string, stage: FstecStage, signal?: AbortSignal): Generator<FstecRecord> {
  const fd = openSync(path, 'r')
  const buffer = Buffer.alloc(65536)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const hash = createHash('sha256')
  let pending = ''
  let count = 0
  let bytes = 0
  try {
    while (true) {
      fstecAbort(signal)
      const length = readSync(fd, buffer, 0, buffer.length, null)
      if (!length) break
      bytes += length
      if (bytes > stage.spoolBytes) throw new Error('FSTEC stage grew during import')
      hash.update(buffer.subarray(0, length))
      pending += decoder.decode(buffer.subarray(0, length), { stream: true })
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (++count > stage.count || Buffer.byteLength(line) > FSTEC_MAX_RECORD * 4) throw new Error('Invalid FSTEC stage count/record')
        yield checkedFstecRecord(JSON.parse(line))
      }
      if (Buffer.byteLength(pending) > FSTEC_MAX_RECORD * 4) throw new Error('FSTEC staged record too large')
    }
    pending += decoder.decode()
    if (pending || count !== stage.count || bytes !== stage.spoolBytes || hash.digest('hex') !== stage.spoolHash) {
      throw new Error('FSTEC staging integrity check failed')
    }
  } finally { closeSync(fd) }
}
