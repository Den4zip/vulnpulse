// Compatibility evaluation only: the small memory cost is a published test vector,
// not a setting for protecting project data.
const assert = require('node:assert/strict')
const { argon2id } = require('hash-wasm')

async function main() {
  for (const [parallelism, expected] of [
    [1, '9dfeb910e80bad0311fee20f9c0e2b12c17987b4cac90c2ef54d5b3021c68bfe'],
    [2, '6d093c501fd5999645e0ea3bf620d7b8be7fd2db59c20d9fff9539da2bf57037']
  ]) {
    const actual = await argon2id({
      password: 'password', salt: 'somesalt', iterations: 2,
      parallelism, memorySize: 256, hashLength: 32, outputType: 'binary'
    })
    assert.equal(Buffer.from(actual).toString('hex'), expected)
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
