// Manual smoke: pass a Xiaomi test key on stdin; never persists or prints it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getTTSCredentials } from '../src/config.js'
import { synthesizeSpeechSegments } from '../src/voice/speech-session.js'
const key = (await new Promise(resolve => process.stdin.once('data', data => resolve(String(data).trim()))))
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-speech-probe-'))
for (const provider of ['doubao', 'xiaomi']) {
  const credentials = { ...getTTSCredentials(), provider, ...(provider === 'xiaomi' ? { xiaomiKey: key, voiceId: 'mimo_default' } : {}) }
  const results = []
  try {
    for await (const segment of synthesizeSpeechSegments({ text: '你好，这是语音同步测试。文字会跟随声音逐步显示。', credentials })) {
      fs.writeFileSync(path.join(output, `${provider}-${segment.index}.mp3`), segment.audio)
      results.push({ index: segment.index, bytes: segment.audio.length, alignment: segment.alignment, cues: segment.cues.length })
    }
    console.log(JSON.stringify({ provider, ok: true, segments: results, output }))
  } catch (error) { console.log(JSON.stringify({ provider, ok: false, error: error.message })); process.exitCode = 1 }
}
process.stdin.destroy()
