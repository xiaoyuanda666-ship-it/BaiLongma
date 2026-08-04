import assert from 'node:assert/strict'
import {
  __internal,
  buildMacOSMusicRuntimeContext,
  execSystemMusic,
  getMacOSMusicStatus,
  parseMacOSMusicStatus,
} from './capabilities/tools/macos-music.js'
import { getToolSchema } from './capabilities/schemas.js'
import { evaluateToolPolicy } from './capabilities/tool-policy.js'
import { executeTool } from './capabilities/executor.js'

const encoded = ['playing', '七里香', '周杰伦', '七里香', '299.5', '83.2', '64'].join(__internal.FIELD_SEPARATOR)
assert.deepEqual(parseMacOSMusicStatus(encoded), {
  ok: true,
  tool: 'system_music',
  platform: 'darwin',
  app: 'Music',
  app_running: true,
  playback_state: 'playing',
  title: '七里香',
  artist: '周杰伦',
  album: '七里香',
  duration_seconds: 299.5,
  position_seconds: 83.2,
  volume: 64,
})

const runningStatus = await getMacOSMusicStatus({
  platform: 'darwin',
  runner: async (command) => command.endsWith('pgrep') ? { stdout: '123\n' } : { stdout: encoded },
})
assert.equal(runningStatus.playback_state, 'playing')
assert.equal(runningStatus.title, '七里香')

const notRunningError = Object.assign(new Error('not found'), { code: 1 })
const closedContext = await buildMacOSMusicRuntimeContext({
  platform: 'darwin',
  runner: async () => { throw notRunningError },
})
assert.match(closedContext, /Music\.app is not open/)

let state = 'playing'
const calls = []
const runner = async (command, args) => {
  calls.push({ command, args })
  if (command.endsWith('pgrep')) return { stdout: '123\n' }
  const script = args[1]
  if (script === __internal.STATUS_SCRIPT) {
    return { stdout: [state, '七里香', '周杰伦', '七里香', '299.5', '83.2', '64'].join(__internal.FIELD_SEPARATOR) }
  }
  if (script === __internal.ACTION_SCRIPTS.pause) state = 'paused'
  return { stdout: '' }
}
const paused = JSON.parse(await execSystemMusic({ action: 'pause' }, {
  platform: 'darwin',
  runSystemMusicProcess: runner,
}))
assert.equal(paused.ok, true)
assert.equal(paused.playback_state, 'paused')
assert.equal(paused.title, '七里香')
assert(calls.some(call => call.args?.[1] === __internal.ACTION_SCRIPTS.pause), 'pause sends a real Music.app Apple event')

const unavailable = JSON.parse(await execSystemMusic({ action: 'pause' }, {
  platform: 'linux',
  runSystemMusicProcess: async () => { throw new Error('must not run') },
}))
assert.equal(unavailable.ok, false)
assert.equal(unavailable.playback_state, 'unavailable')

if (process.platform === 'darwin') {
  assert.ok(getToolSchema('system_music'), 'macOS exposes system_music')
  assert.equal(getToolSchema('music'), null, 'macOS removes Bailongma local music tool')
  assert(!getToolSchema('media_mode').function.parameters.properties.mode.enum.includes('music'))
  assert.equal(evaluateToolPolicy('system_music', { action: 'pause' }, { currentUserMessage: '暂停' }).allowed, true)
  assert.equal(evaluateToolPolicy('system_music', { action: 'pause' }, { currentUserMessage: '你好' }).allowed, false)
  const legacyLocalMusic = JSON.parse(await executeTool('music', { action: 'list' }, { source: 'test' }))
  assert.equal(legacyLocalMusic.ok, false)
  assert.match(legacyLocalMusic.error, /unavailable on macOS/)
} else {
  assert.equal(getToolSchema('system_music'), null)
  assert.ok(getToolSchema('music'))
}

console.log('test-macos-music passed')
