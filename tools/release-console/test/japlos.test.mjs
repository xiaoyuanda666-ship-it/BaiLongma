import assert from 'node:assert/strict'
import test from 'node:test'
import { validateJaplosAction } from '../japlos-console.mjs'

test('Japlos inspection rejects publishing and invalid architecture inputs', () => {
  for (const action of ['publish', 'build', '', undefined]) {
    assert.throws(() => validateJaplosAction({action, archs:['arm64']}))
  }
  for (const archs of [[], ['x86_64'], ['../arm64'], undefined]) {
    assert.throws(() => validateJaplosAction({action:'preflight', archs}))
  }
  assert.deepEqual(validateJaplosAction({action:'dry-run', archs:['arm64','arm64','x64']}), {action:'dry-run',archs:['arm64','x64']})
})
