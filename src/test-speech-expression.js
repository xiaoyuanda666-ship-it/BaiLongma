import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-speech-expression-'))
process.env.BAILONGMA_USER_DIR = root
const { createSpeechExpression } = await import('./runtime/speech-expression.js')
const { createFilesystemPort } = await import('./kernel/filesystem.js')
const { closeDBForTest } = await import('./db.js')
const audioRoot = path.join(root, 'audio')
let permitted = true
const filesystem = createFilesystemPort({ assertAccess(filename) {
  assert.ok(permitted, 'permission revoked')
  assert.ok(filename.startsWith(root + path.sep), 'outside sandbox')
} })
const synthesize = async function* () {
  yield { index: 0, text: '第一句。', audio: Buffer.from([0xff, 0xfb, 0x01]) }
  yield { index: 1, text: '第二句。', audio: Buffer.from([0xff, 0xfb, 0x02]) }
}
const options = { filesystem, sandboxRoot: root, synthesize, readCredentials: () => ({}), limitReached: () => false }
try {
  const manifest = await createSpeechExpression(options)({ text: '第一句。第二句。' })
  assert.equal(manifest.segments.length, 2)
  assert.deepEqual(fs.readFileSync(path.join(root, manifest.segments[0].path)), Buffer.from([0xff, 0xfb, 0x01]))
  assert.equal(manifest.segments[0].audio, undefined)
  permitted = false
  assert.throws(() => filesystem.writeFileSync(path.join(audioRoot, 'denied.mp3'), Buffer.from('no')), /permission revoked/)
  permitted = true
  const before = fs.readdirSync(audioRoot)
  let writes = 0
  const failing = createSpeechExpression({ ...options, filesystem: { ...filesystem,
    writeFileSync(filename, bytes) {
      filesystem.writeFileSync(filename, bytes)
      if (++writes === 2) throw new Error('disk write failed')
    },
  } })
  await assert.rejects(failing({ text: '两句。' }), /disk write failed/)
  assert.deepEqual(fs.readdirSync(audioRoot), before, 'remove complete and partially written segments on failure')
  const interrupted = createSpeechExpression({ ...options, synthesize: async function* () {
    yield { index: 0, text: '一', audio: Buffer.from('audio') }
    throw new Error('synthesis interrupted')
  } })
  await assert.rejects(interrupted({ text: '一' }), /synthesis interrupted/)
  assert.deepEqual(fs.readdirSync(audioRoot), before)
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(createSpeechExpression(options)({ text: '一' }, { signal: abort.signal }), { name: 'AbortError' })
  assert.deepEqual(fs.readdirSync(audioRoot), before)
  console.log('PASS speech binary persistence, access checks, partial-write cleanup and interrupted synthesis')
} finally {
  closeDBForTest()
  fs.rmSync(root, { recursive: true, force: true })
}
