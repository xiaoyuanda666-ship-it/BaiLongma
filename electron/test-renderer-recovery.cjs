'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { installRendererRecovery } = require('./renderer-recovery.cjs')

function fixture({ failReload = false } = {}) {
  const window = new EventEmitter()
  const contents = new EventEmitter()
  window.webContents = contents
  window.isDestroyed = contents.isDestroyed = () => false
  let quitting = false, reloads = 0, exhausted = 0, time = 0
  const pending = new Map()
  let id = 0
  installRendererRecovery(window, {
    isQuitting: () => quitting,
    reload: () => { reloads++; if (failReload) throw new Error('backend unavailable') },
    onExhausted: () => exhausted++,
    log: { error() {}, warn() {}, info() {} },
    now: () => time,
    schedule(fn) { pending.set(++id, fn); return id },
    cancel(key) { pending.delete(key) },
  })
  return {
    window, contents, pending,
    crash() { contents.emit('render-process-gone', {}, { reason: 'oom', exitCode: -1 }) },
    quit() { quitting = true },
    advance(ms) { time += ms },
    async flush() { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(fn => fn()); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() },
    get reloads() { return reloads },
    get exhausted() { return exhausted },
  }
}

test('exited renderer recovers once; transient hangs do not reload', async () => {
  const f = fixture()
  f.window.emit('unresponsive')
  f.window.emit('responsive')
  await f.flush()
  assert.equal(f.reloads, 0)
  f.crash(); f.crash()
  assert.equal(f.pending.size, 1)
  await f.flush()
  assert.equal(f.reloads, 1)
})

test('crash loop is bounded and a later isolated crash can recover', async () => {
  const f = fixture()
  for (let i = 0; i < 4; i++) { f.crash(); await f.flush() }
  assert.equal(f.reloads, 3)
  assert.equal(f.exhausted, 1)
  f.advance(60_001)
  f.crash(); await f.flush()
  assert.equal(f.reloads, 4)
})

test('closing the window removes listeners and cancels pending recovery', async () => {
  const f = fixture()
  f.crash()
  f.window.emit('closed')
  assert.equal(f.pending.size, 0)
  assert.equal(f.contents.listenerCount('render-process-gone'), 0)
  await f.flush()
  assert.equal(f.reloads, 0)
})

test('quitting suppresses scheduled and new recovery', async () => {
  const f = fixture()
  f.crash(); f.quit(); await f.flush(); f.crash()
  assert.equal(f.reloads, 0)
  assert.equal(f.pending.size, 0)
})


test('repeated crash notifications show only one recovery dialog per burst', async () => {
  const f = fixture()
  for (let i = 0; i < 10; i++) { f.crash(); await f.flush() }
  assert.equal(f.reloads, 3)
  assert.equal(f.exhausted, 1)
})

test('failed navigation retries are bounded too', async () => {
  const f = fixture({ failReload: true })
  f.crash()
  for (let i = 0; i < 5; i++) await f.flush()
  assert.equal(f.reloads, 3)
  assert.equal(f.exhausted, 1)
  assert.equal(f.pending.size, 0)
})
