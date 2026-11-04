import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { shellEnvironment } from './capabilities/tools/shell-environment.js'

test('GUI PATH can resolve the standard bsk installation without a login shell', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-gui-path-'))
  try {
    const bin = path.join(home, '.local', 'bin'); fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'bsk'), '#!/bin/sh\necho bsk-fixture\n', { mode: 0o755 })
    const original = { PATH: '/usr/bin:/bin', TEST_VALUE: 'preserved' }
    const env = shellEnvironment(original, { platform: 'darwin', home })
    assert.equal(env.TEST_VALUE, original.TEST_VALUE)
    assert.equal(original.PATH, '/usr/bin:/bin')
    const result = spawnSync('/bin/sh', ['-c', 'bsk --version'], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'bsk-fixture')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})
