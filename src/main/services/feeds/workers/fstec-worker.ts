import { parentPort, workerData } from 'node:worker_threads'
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { createHash } from 'node:crypto'
import { FSTEC_MAX_COMPRESSED, FSTEC_MAX_SPOOL, FSTEC_MAX_XML, type FstecInput, type FstecOrigin } from '../fstec-data'
import { FstecXmlStream } from './fstec-stream'
import { parseFstecRecord } from './fstec-xml'

async function run(): Promise<void> {
  const { input, spoolPath, origin } = workerData as { input: FstecInput; spoolPath: string; origin: FstecOrigin }
  const source = input.kind === 'file' ? createReadStream(input.path) : Readable.from([input.data])
  const sourceHash = createHash('sha256')
  let sourceBytes = 0
  const measured = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    sourceBytes += chunk.length
    if (sourceBytes > (input.gzip ? FSTEC_MAX_COMPRESSED : FSTEC_MAX_XML)) return callback(new Error('FSTEC input exceeds size limit'))
    sourceHash.update(chunk)
    callback(null, chunk)
  } })
  // Propagate upstream errors through the composed stream, including missing files.
  const stream = input.gzip ? source.compose(measured).compose(createGunzip()) : source.compose(measured)
  const spool = await open(spoolPath, 'wx')
  const spoolHash = createHash('sha256')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const xml = new FstecXmlStream()
  const ids = new Set<string>()
  let xmlBytes = 0
  let spoolBytes = 0
  try {
    const emit = async (fragment: string): Promise<void> => {
      const record = parseFstecRecord(fragment, origin)
      if (ids.has(record.id)) throw new Error('Duplicate FSTEC identifier')
      ids.add(record.id)
      const line = JSON.stringify(record) + '\n'
      spoolBytes += Buffer.byteLength(line)
      if (spoolBytes > FSTEC_MAX_SPOOL) throw new Error('FSTEC staging exceeds size limit')
      spoolHash.update(line)
      await spool.writeFile(line)
    }
    for await (const chunk of stream) {
      const buffer = chunk as Uint8Array
      xmlBytes += buffer.byteLength
      if (xmlBytes > FSTEC_MAX_XML) throw new Error('FSTEC XML exceeds 1 GiB')
      await xml.push(decoder.decode(buffer, { stream: true }), emit)
    }
    await xml.push(decoder.decode(), emit)
    xml.finish()
    await spool.close()
    parentPort!.postMessage({ ok: true, stage: { count: ids.size, spoolBytes,
      spoolHash: spoolHash.digest('hex'), sourceHash: sourceHash.digest('hex') } })
  } catch (error) {
    await spool.close()
    throw error
  } finally { source.destroy(); stream.destroy() }
}

void run().catch((error: unknown) => {
  parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : 'FSTEC worker failed' })
})
