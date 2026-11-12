import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const fixture = resolve('tests/fixtures/argon2-evaluation.cjs')

describe('Argon2id candidate compatibility', () => {
  it.each([
    ['Node', process.execPath, false],
    ['Electron Node runtime', require('electron') as string, true]
  ])('matches independent Argon2id vectors in %s', (_name, executable, electron) => {
    const env = { ...process.env }
    if (electron) env.ELECTRON_RUN_AS_NODE = '1'
    else delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(executable, [fixture], { env, encoding: 'utf8', timeout: 15000 })
    expect(result.error?.message).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
  })
})
