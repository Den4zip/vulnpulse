// Research fixture only. The parameters below are not suitable for a project vault.
import { parentPort, threadId, isMainThread } from 'node:worker_threads'
import { argon2id } from 'hash-wasm'

if (!parentPort || isMainThread) throw new Error('Worker required')

const port = parentPort
void argon2id({
  password: 'password', salt: 'somesalt', iterations: 2,
  parallelism: 1, memorySize: 256, hashLength: 32, outputType: 'binary'
}).then(result => {
  port.postMessage({ threadId, hex: Buffer.from(result).toString('hex') })
}).catch(() => { throw new Error('Argon2 evaluation failed') })
