import assert from 'node:assert/strict'
import {
  __internal,
  buildMacOSMusicRuntimeContext,
  createMacOSMusicStatusReader,
  execSystemMusic,
} from './capabilities/tools/macos-music.js'
import { getCapability } from './capabilities/capability-registry.js'

const encode = state => [state, 'Example track', 'Artist', 'Album', '200', '20', '60'].join(__internal.FIELD_SEPARATOR)
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

// This runner deliberately never resolves. Unrelated input must not call it or
// consult any status reader, even on a cold cache.
let unrelatedCalls = 0
const unrelated = buildMacOSMusicRuntimeContext({
  platform: 'darwin',
  relevant: false,
  runner: () => { unrelatedCalls++; return new Promise(() => {}) },
  statusReader: { read() { throw new Error('unrelated prefeed must not read Music status') } },
})
assert.equal(await unrelated, '')
assert.equal(unrelatedCalls, 0)
const capability = getCapability('macos-system-music')
if (capability) {
  assert.equal(await capability.prefeed({ rawText: '你好，请总结这篇文章' }), '')
  assert.equal(capability.detect({ rawText: '暂停' }), true)
  assert.equal(capability.detect({ rawText: 'Music.app 现在播放的是什么？' }), true)
  for (const rawText of [
    '这首歌是谁唱的？', '这是什么歌', '现在放的是什么歌？', '正在播放哪首歌？',
    'what song is this?', 'what track is playing?', "what's playing?",
    'What is currently playing?', 'who sings this song?', 'who is the artist of this track?',
  ]) {
    assert.equal(capability.detect({ rawText }), true, rawText)
    assert.equal(capability.toolWhen({ rawText }), true, `${rawText}: status tool remains available`)
  }
  for (const rawText of ['你好', '请总结这篇文章', 'what is this code doing?', '播放视频']) {
    assert.equal(capability.detect({ rawText }), false, rawText)
  }
}

let clock = 0
let state = 'playing'
let probes = 0
let statusReads = 0
const runner = async (command, args) => {
  if (command.endsWith('pgrep')) { probes++; return { stdout: '123' } }
  if (args[1] === __internal.STATUS_SCRIPT) { statusReads++; return { stdout: encode(state) } }
  if (args[1] === __internal.ACTION_SCRIPTS.pause) state = 'paused'
  return { stdout: '' }
}
const reader = createMacOSMusicStatusReader({ platform: 'darwin', runner, now: () => clock, ttlMs: 2_000 })
const first = reader.read()
assert.equal(reader.read({ fresh: true }), first, 'concurrent readers share the same pending probe')
assert.equal((await first).playback_state, 'playing')
assert.equal(probes, 1)
assert.equal(statusReads, 1)
state = 'paused'
clock = 1_999
assert.equal((await reader.read()).playback_state, 'playing', 'opt-in cached reads use a short TTL')
assert.equal(probes, 1)
clock = 2_000
assert.equal((await reader.read()).playback_state, 'paused', 'TTL expiry refreshes status')
assert.equal(probes, 2)

state = 'playing'
const explicitContext = await buildMacOSMusicRuntimeContext({
  platform: 'darwin', statusReader: reader,
})
assert.match(explicitContext, /Authoritative playback state: playing/)
assert.equal(probes, 3, 'explicit music questions bypass a still-fresh cached snapshot')
state = 'paused'
const explicitStatus = JSON.parse(await execSystemMusic({ action: 'status' }, {
  platform: 'darwin', runSystemMusicProcess: runner, systemMusicStatusReader: reader,
}))
assert.equal(explicitStatus.playback_state, 'paused', 'system_music status is also fresh')

state = 'playing'
await reader.read({ fresh: true })
const action = JSON.parse(await execSystemMusic({ action: 'pause' }, {
  platform: 'darwin', runSystemMusicProcess: runner, systemMusicStatusReader: reader,
}))
assert.equal(action.ok, true)
assert.equal(action.playback_state, 'paused', 'actions verify a fresh post-action result')
assert.equal(reader.peek().playback_state, 'paused', 'verified action status refreshes the shared cache')

const oldResult = deferred()
const oldStarted = deferred()
let reads = 0
const racingReader = createMacOSMusicStatusReader({
  platform: 'darwin',
  now: () => clock,
  runner: async command => {
    if (command.endsWith('pgrep')) return { stdout: '123' }
    if (++reads === 1) {
      oldStarted.resolve()
      return oldResult.promise
    }
    return { stdout: encode('paused') }
  },
})
const beforeAction = racingReader.read()
await oldStarted.promise
racingReader.invalidate()
assert.equal((await racingReader.read({ fresh: true })).playback_state, 'paused')
oldResult.resolve({ stdout: encode('playing') })
await beforeAction
assert.equal(racingReader.peek().playback_state, 'paused', 'late pre-action reads cannot overwrite verified action state')

let fail = true
const failureReader = createMacOSMusicStatusReader({
  platform: 'darwin',
  now: () => clock,
  runner: async command => {
    if (fail) throw Object.assign(new Error('process probe denied'), { code: 'EACCES' })
    return { stdout: command.endsWith('pgrep') ? '123' : encode('playing') }
  },
})
const failedContext = await buildMacOSMusicRuntimeContext({ platform: 'darwin', statusReader: failureReader })
assert.match(failedContext, /could not be verified/)
assert.doesNotMatch(failedContext, /Music\.app is not open|Music\.app is open/)
assert.equal(failureReader.peek(), null, 'failed probes do not become factual cached state')
const unverifiablePause = JSON.parse(await execSystemMusic({ action: 'pause' }, {
  platform: 'darwin',
  systemMusicStatusReader: failureReader,
  runSystemMusicProcess: () => { throw new Error('must not send an Apple event when running state is unknown') },
}))
assert.equal(unverifiablePause.ok, false)
assert.equal(unverifiablePause.app_running, null)
assert.doesNotMatch(unverifiablePause.error, /not open/)
fail = false
assert.equal((await failureReader.read()).playback_state, 'playing', 'a failed probe does not poison subsequent reads')

console.log('PASS Music prefeed skips unrelated turns, dedupes pending reads, and preserves fresh verified action/question state')
