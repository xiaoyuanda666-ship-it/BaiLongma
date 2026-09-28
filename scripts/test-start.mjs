import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import test from 'node:test'
import { start } from './start.mjs'

function fixture(mode, { hasEnv = false, extraArgs = [], platform = 'darwin' } = {}) {
  const root = path.resolve('temporary project with spaces')
  const processRef = Object.assign(new EventEmitter(), {
    execPath: '/runtime/node', platform, env: { EXISTING: 'kept', ELECTRON_RUN_AS_NODE: '1' },
  })
  const child = new EventEmitter()
  const signals = []
  child.kill = signal => signals.push(signal)
  let invocation
  let consoleSetup
  start(mode, extraArgs, {
    execFileSyncImpl: (...args) => { consoleSetup = args },
    root, processRef, exists: () => hasEnv, electronPath: () => '/runtime with spaces/electron',
    spawnImpl: (...args) => { invocation = args; return child },
  })
  return { root, processRef, child, signals, invocation, consoleSetup }
}

test('backend runs without .env and preserves args and environment', () => {
  const { invocation: [command, args, options], root } = fixture('backend', { extraArgs: ['argument with spaces'] })
  assert.equal(command, '/runtime/node')
  assert.deepEqual(args, [path.join(root, 'src/index.js'), 'argument with spaces'])
  assert.equal(options.cwd, root)
  assert.equal(options.env.EXISTING, 'kept')
  assert.equal(options.stdio, 'inherit')
  assert.equal(options.shell, undefined)
})

test('dev includes optional .env before the watch entrypoint', () => {
  const { invocation: [, args], root } = fixture('dev', { hasEnv: true })
  assert.deepEqual(args, [`--env-file=${path.join(root, '.env')}`, '--watch', path.join(root, 'src/index.js')])
})

test('app launches Electron binary, without mutating parent environment', () => {
  const { invocation: [command, args, options], root, processRef } = fixture('app')
  assert.equal(command, '/runtime with spaces/electron')
  assert.deepEqual(args, [root])
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(processRef.env.ELECTRON_RUN_AS_NODE, '1')
})

test('forwards termination signals and propagates child status', () => {
  const { processRef, child, signals } = fixture('backend')
  processRef.emit('SIGINT')
  processRef.emit('SIGTERM')
  assert.deepEqual(signals, ['SIGINT', 'SIGTERM'])
  child.emit('exit', 17, null)
  assert.equal(processRef.exitCode, 17)
  assert.equal(processRef.listenerCount('SIGINT'), 0)
  assert.equal(processRef.listenerCount('SIGTERM'), 0)
})

test('signal exit and spawn failure are unsuccessful and clean up handlers', () => {
  const terminated = fixture('backend')
  terminated.child.emit('exit', null, 'SIGTERM')
  assert.equal(terminated.processRef.exitCode, 143)
  const failed = fixture('app')
  const originalError = console.error
  try {
    console.error = () => {}
    failed.child.emit('error', new Error('ENOENT'))
  } finally { console.error = originalError }
  assert.equal(failed.processRef.exitCode, 1)
  assert.equal(failed.processRef.listenerCount('SIGINT'), 0)
})

test('invalid mode is rejected before spawning', () => {
  assert.throws(() => start('invalid'), /Unknown startup mode/)
})

test('Windows initializes UTF-8 before launch; other platforms do not invoke cmd', () => {
  const windows = fixture('backend', { platform: 'win32' })
  assert.deepEqual(windows.consoleSetup, ['cmd.exe', ['/d', '/c', 'chcp 65001'], { stdio: 'ignore' }])
  assert.equal(fixture('backend').consoleSetup, undefined)
})
