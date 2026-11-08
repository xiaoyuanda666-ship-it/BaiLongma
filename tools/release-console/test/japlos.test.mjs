import assert from 'node:assert/strict'
import test from 'node:test'
import { validateJaplosAction } from '../japlos-console.mjs'

test('Japlos actions reject unconfirmed publication and invalid architecture inputs', () => {
  for (const action of ['publish', 'build', '', undefined]) {
    assert.throws(() => validateJaplosAction({action, archs:['arm64']}))
  }
  for (const archs of [[], ['x86_64'], ['../arm64'], undefined]) {
    assert.throws(() => validateJaplosAction({action:'preflight', archs}))
  }
  assert.deepEqual(validateJaplosAction({action:'dry-run', archs:['arm64','arm64','x64']}), {action:'dry-run',archs:['arm64','x64']})
})

test('Japlos publishing requires current version and explicit confirmation', () => {
  const body = {action:'publish', archs:['arm64','x64'], version:'1.2.3', confirmed:true}
  assert.deepEqual(validateJaplosAction(body, '1.2.3'), {action:'publish', archs:['arm64','x64'], version:'1.2.3'})
  assert.throws(() => validateJaplosAction({...body, confirmed:false}, '1.2.3'))
  assert.throws(() => validateJaplosAction(body, '1.2.4'))
  assert.throws(() => validateJaplosAction({...body, version:undefined}, undefined))
})
