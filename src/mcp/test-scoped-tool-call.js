import test from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { callToolWithScopedSignal } from './scoped-tool-call.js'

test('timed out screenshot reports its actual stage instead of prior download context', async () => {
  const parent = new AbortController()
  const browserOperation = { stage: 'downloadContext' }
  let childSignal
  const client = { callTool(request, schema, options) {
    assert.equal(browserOperation.stage, 'take_screenshot')
    assert.equal(request.name, 'take_screenshot')
    childSignal = options.signal
    assert.notEqual(childSignal, parent.signal)
    return new Promise(() => {}) // A bridge may ignore cancellation.
  } }
  await assert.rejects(callToolWithScopedSignal(client, { name: 'take_screenshot' }, {
    timeout: 20, signal: parent.signal, browserOperation,
  }), /Timeout 20ms/)
  assert.equal(browserOperation.stage, 'take_screenshot')
  assert.equal(childSignal.aborted, true)
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
})

test('success and cancellation preserve scoped listener cleanup and stage progression', async () => {
  const parent = new AbortController()
  const browserOperation = { stage: 'getTarget' }
  const options = { signal: parent.signal, browserOperation, timeout: 1000 }
  const result = await callToolWithScopedSignal({ callTool: async () => ({ ok: true }) },
    { name: 'list_pages' }, options)
  assert.deepEqual(result, { ok: true })
  assert.equal(browserOperation.stage, 'list_pages')
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
  const pending = callToolWithScopedSignal({ callTool() {
    parent.abort('User cancelled')
    return new Promise(() => {})
  } }, { name: 'select_page' }, options)
  await assert.rejects(pending, /User cancelled/)
  assert.equal(browserOperation.stage, 'select_page')
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
})
