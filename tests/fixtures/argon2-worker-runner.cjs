const assert = require('node:assert/strict')
const { Worker } = require('node:worker_threads')

const worker = new Worker(process.argv[2])
let completed = false
let ticks = 0
const heartbeat = setInterval(() => { ticks++ }, 1)
const timer = setTimeout(() => {
  console.error('worker timed out')
  process.exitCode = 1
  void worker.terminate()
}, 15000)
worker.once('message', result => {
  try {
    assert.ok(result.threadId > 0)
    assert.ok(ticks > 0, 'main event loop did not run during worker startup')
    assert.equal(result.hex, '9dfeb910e80bad0311fee20f9c0e2b12c17987b4cac90c2ef54d5b3021c68bfe')
    completed = true
  } catch (error) { console.error(error); process.exitCode = 1 }
})
worker.once('error', error => { console.error(error); process.exitCode = 1 })
worker.once('exit', code => {
  clearInterval(heartbeat)
  clearTimeout(timer)
  if (code !== 0 || !completed) process.exitCode = 1
})
