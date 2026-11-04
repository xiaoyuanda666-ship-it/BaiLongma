import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { managedSession, parseArguments } from '../skills/bsk/scripts/session.mjs'

async function fixture(t) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blm-session-'))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const calls = [], sessions = [], requests = new Map()
  const f = { stateDir, calls, sessions, requests, browsers: [{ instance_id: 'chrome-a' }] }
  f.run = async args => {
    calls.push(args)
    if (args[0] === 'browsers') return f.browsers
    if (args[1] === 'list') {
      if (f.listError) throw new Error('daemon disconnected')
      return sessions
    }
    if (args[1] === 'request') {
      const id = args[2]
      if (args.includes('--prepare')) requests.set(id, { state: 'prepared' })
      if (args.includes('--claim')) requests.get(id).state = 'active'
      if (args.includes('--cancel')) requests.set(id, { state: 'closed' })
      return requests.get(id)
    }
    if (args[1] === 'start') {
      if (f.startDelay) await new Promise(resolve => setTimeout(resolve, f.startDelay))
      if (f.pending) throw new Error('timeout before result')
      const session = { session_id: `s${calls.filter(a => a[1] === 'start').length}`, browser_instance_id: args[args.indexOf('--browser') + 1] }
      sessions.push(session)
      requests.set(args.at(-1), { state: 'ready', session })
      if (f.lostResponse) throw new Error('timeout after window creation')
      return session
    }
    if (args[1] === 'stop') {
      if (f.cleanupFailure) return { stopped: [], failed: [args[2]] }
      sessions.splice(sessions.findIndex(s => s.session_id === args[2]), 1)
      return { stopped: [args[2]] }
    }
    throw new Error(`Unexpected command ${args}`)
  }
  f.ensure = options => managedSession({ stateDir, run: f.run, ...options })
  f.starts = () => calls.filter(a => a[1] === 'start').length
  return f
}

test('sequential requests reuse one owned window; unrelated sessions stay untouched', async t => {
  const f = await fixture(t)
  f.sessions.push({ session_id: 'other-tool', browser_instance_id: 'chrome-a' })
  const first = await f.ensure()
  const next = await f.ensure()
  assert.equal(next.session_id, first.session_id)
  assert.equal(next.reused, true)
  assert.equal(f.starts(), 1)
  await f.ensure({ action: 'close' })
  assert.deepEqual(f.sessions.map(s => s.session_id), ['other-tool'])
  assert.equal(f.calls.some(a => a.includes('--all')), false)
})

test('concurrent creation attempts converge on one window', async t => {
  const f = await fixture(t); f.startDelay = 50
  const results = await Promise.all([f.ensure(), f.ensure(), f.ensure()])
  assert.equal(new Set(results.map(r => r.session_id)).size, 1)
  assert.equal(f.starts(), 1)
})

test('a lost start response recovers the original request', async t => {
  const f = await fixture(t); f.lostResponse = true
  const result = await f.ensure()
  assert.equal(result.session_id, 's1')
  assert.equal(f.starts(), 1)
})

test('unresolved creation survives retries and is never replayed', async t => {
  const f = await fixture(t); f.pending = true
  await assert.rejects(f.ensure(), { code: 'START_PENDING' })
  await assert.rejects(f.ensure(), { code: 'START_PENDING' })
  assert.equal(f.starts(), 1)
  // A later response becomes available; the same request can be claimed.
  const request = [...f.requests.values()][0]
  request.session = { session_id: 'eventual', browser_instance_id: 'chrome-a' }
  assert.equal((await f.ensure()).session_id, 'eventual')
  assert.equal(f.starts(), 1)
})

test('manual window closure permits one replacement', async t => {
  const f = await fixture(t)
  await f.ensure()
  f.sessions.length = 0
  assert.equal((await f.ensure()).session_id, 's2')
  assert.equal(f.starts(), 2)
})

test('daemon failure does not discard ownership or create another window', async t => {
  const f = await fixture(t)
  await f.ensure(); f.listError = true
  await assert.rejects(f.ensure(), /disconnected/)
  f.listError = false
  assert.equal((await f.ensure()).reused, true)
  assert.equal(f.starts(), 1)
})

test('profile changes require explicit separate slots', async t => {
  const f = await fixture(t)
  f.browsers.push({ instance_id: 'chrome-b' })
  await assert.rejects(f.ensure(), { code: 'BROWSER_SELECTION_REQUIRED' })
  await f.ensure({ browser: 'chrome-a' })
  await assert.rejects(f.ensure({ browser: 'chrome-b' }), { code: 'PROFILE_MISMATCH' })
  await f.ensure({ browser: 'chrome-b', slot: 'explicit-second-profile' })
  assert.equal(f.starts(), 2)
})

test('failed cleanup retains ownership for retry', async t => {
  const f = await fixture(t)
  await f.ensure(); f.cleanupFailure = true
  await assert.rejects(f.ensure({ action: 'close' }), { code: 'CLEANUP_PENDING' })
  assert.equal((await f.ensure()).session_id, 's1')
  f.cleanupFailure = false
  await f.ensure({ action: 'close' })
  await f.ensure()
  assert.equal(f.starts(), 2)
})

test('corrupt saved state fails closed', async t => {
  const f = await fixture(t)
  await f.ensure()
  const filename = (await fs.readdir(f.stateDir)).find(p => p.endsWith('.json'))
  await fs.writeFile(path.join(f.stateDir, filename), '{broken')
  await assert.rejects(f.ensure(), SyntaxError)
  assert.equal(f.starts(), 1)
})

test('a held lock blocks creation rather than bypassing it', async t => {
  const f = await fixture(t)
  await f.ensure()
  const filename = (await fs.readdir(f.stateDir))[0]
  await fs.writeFile(path.join(f.stateDir, `${filename}.lock`), '{"pid":1}')
  await assert.rejects(f.ensure({ lockWaitMs: 0 }), { code: 'SESSION_BUSY' })
  assert.equal(f.starts(), 1)
})

test('CLI rejects unsupported options and parses explicit profile and slot', () => {
  assert.deepEqual(parseArguments(['ensure', '--browser', 'a', '--slot', 'research']), { action: 'ensure', browser: 'a', slot: 'research' })
  assert.throws(() => parseArguments(['ensure', '--browser']), { code: 'INVALID_ARGUMENT' })
  assert.throws(() => parseArguments(['ensure', '--force', 'yes']), { code: 'INVALID_ARGUMENT' })
})


test('close after manual window closure clears ownership without creating a window', async t => {
  const f = await fixture(t)
  await f.ensure()
  f.sessions.length = 0
  assert.equal((await f.ensure({ action: 'close' })).already_closed, true)
  assert.equal((await f.ensure({ action: 'close' })).closed, false)
  assert.equal(f.starts(), 1)
})

test('close refuses a session whose browser identity changed', async t => {
  const f = await fixture(t)
  await f.ensure()
  f.sessions[0].browser_instance_id = 'other-browser'
  await assert.rejects(f.ensure({ action: 'close' }), { code: 'PROFILE_MISMATCH' })
  assert.equal(f.calls.some(a => a[1] === 'stop'), false)
})


test('closed window retains its profile binding across failed discovery and retries', async t => {
  const f = await fixture(t)
  await f.ensure()
  f.sessions.length = 0
  f.browsers = [{ instance_id: 'chrome-b' }]
  await assert.rejects(f.ensure(), { code: 'BROWSER_SELECTION_REQUIRED' })
  await assert.rejects(f.ensure(), { code: 'BROWSER_SELECTION_REQUIRED' })
  assert.equal(f.starts(), 1)
  f.browsers.push({ instance_id: 'chrome-a' })
  assert.equal((await f.ensure()).browser_instance_id, 'chrome-a')
  assert.equal(f.starts(), 2)
})
