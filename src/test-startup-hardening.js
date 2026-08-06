import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { withStartupTimeout } from './runtime/startup-timeout.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const successWarnings = []
const success = await withStartupTimeout(Promise.resolve('ready'), 10, '[test] success', {
  warn: (...args) => successWarnings.push(args.join(' ')),
})
assert.equal(success, 'ready')
await wait(25)
assert.deepEqual(successWarnings, [], 'a completed startup task must not emit a later false timeout')

const rejectionWarnings = []
const rejected = await withStartupTimeout(Promise.reject(new Error('boom')), 10, '[test] rejection', {
  warn: (...args) => rejectionWarnings.push(args.join(' ')),
})
assert.equal(rejected, null)
await wait(25)
assert.equal(rejectionWarnings.length, 1, 'a rejected task reports only its real failure')
assert.match(rejectionWarnings[0], /boom/)
assert.doesNotMatch(rejectionWarnings[0], /超时/)

const timeoutWarnings = []
const timedOut = await withStartupTimeout(new Promise(() => {}), 10, '[test] timeout', {
  warn: (...args) => timeoutWarnings.push(args.join(' ')),
})
assert.equal(timedOut, null)
assert.equal(timeoutWarnings.length, 1)
assert.match(timeoutWarnings[0], /超时 10ms/)

const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
assert(!pkg.build.files.some(pattern => String(pattern).includes('sandbox/')),
  'runtime sandbox contents must never be bundled as application resources')

console.log('PASS startup timeout cleanup and packaging boundaries')
