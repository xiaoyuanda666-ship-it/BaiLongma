import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleActivationRoutes } from './api/routes/activation.js'
import { ACTIVATION_INTRO_SOUND_EVENTS } from './ui/brain-ui/activation-intro-sound.js'
import { INTRO_START_DELAY_MS } from './ui/brain-ui/brain-ui-intro.js'

const testDir = path.dirname(fileURLToPath(import.meta.url))

function createResponse() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this.headers = headers
    },
    end(chunk = '') {
      this.body += String(chunk)
    },
  }
}

let completionCalls = 0
const response = createResponse()
const handled = await handleActivationRoutes(
  { method: 'POST' },
  response,
  new URL('http://localhost/activation/intro-complete'),
  { onActivationIntroComplete: () => { completionCalls += 1 } },
)

assert.equal(handled, true)
assert.equal(completionCalls, 1)
assert.equal(response.statusCode, 200)
assert.deepEqual(JSON.parse(response.body), { ok: true })

assert.equal(INTRO_START_DELAY_MS, 300)
assert.equal(ACTIVATION_INTRO_SOUND_EVENTS[0]?.id, 'startup')
assert.equal(ACTIVATION_INTRO_SOUND_EVENTS[0]?.at, 0)
const taskEvents = ACTIVATION_INTRO_SOUND_EVENTS.filter(event => event.id.startsWith('task-'))
const weekEvents = ACTIVATION_INTRO_SOUND_EVENTS.filter(event => event.id.startsWith('week-'))
assert.equal(taskEvents.length, 4)
assert.equal(weekEvents.length, 7)
assert.deepEqual(taskEvents.map(event => event.at), [3.34, 3.8, 4.26, 4.72])
assert.deepEqual(weekEvents.map(event => event.at), [6.6, 6.71, 6.82, 6.93, 7.04, 7.15, 7.26])
assert.equal(ACTIVATION_INTRO_SOUND_EVENTS.filter(event => event.id === 'bailongma').length, 1)
assert.equal(ACTIVATION_INTRO_SOUND_EVENTS.filter(event => event.id === 'time').length, 1)

const soundFiles = new Set(ACTIVATION_INTRO_SOUND_EVENTS.map(event => event.file))
assert.deepEqual([...soundFiles].sort(), [
  'intro-bailongma.mp3',
  'intro-startup.mp3',
  'intro-tasks.mp3',
  'intro-time.mp3',
  'intro-week.mp3',
])
for (const filename of soundFiles) {
  const file = path.join(testDir, 'ui', 'brain-ui', 'assets', filename)
  assert.equal(fs.existsSync(file), true, `${filename} must be packaged with the intro`)
  assert.ok(fs.statSync(file).size > 0, `${filename} must not be empty`)
}

console.log('activation intro gate and sound cue tests passed')
