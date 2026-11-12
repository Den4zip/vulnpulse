import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { build } from 'vite'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)

it('runs the bundled Argon2 fixture in an Electron worker outside node_modules', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vulnpulse-argon2-worker-'))
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: ['hash-wasm'] },
      build: {
        ssr: resolve('tests/fixtures/argon2-worker.ts'),
        outDir: dir,
        emptyOutDir: false,
        rollupOptions: { output: { format: 'cjs', entryFileNames: 'worker.cjs' } }
      }
    })
    const result = spawnSync(require('electron') as string,
      [resolve('tests/fixtures/argon2-worker-runner.cjs'), join(dir, 'worker.cjs')], {
        cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20000
      })
    expect(result.error?.message).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 30000)
