import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getTTSCredentials } from '../config.js'
import { isDailyLimitReached } from '../quota.js'
import { stripMarkdownForSpeech } from '../capabilities/tools/media/speech.js'
import { synthesizeSpeechSegments } from '../voice/speech-session.js'

export function createSpeechExpression({
  filesystem: fs, sandboxRoot,
  synthesize = synthesizeSpeechSegments,
  readCredentials = getTTSCredentials,
  limitReached = isDailyLimitReached,
}) {
  return async function prepareSpeechExpression({ text }, context = {}) {
    if (limitReached('tts')) throw new Error('今日 TTS 配额已用完')
    const spokenText = stripMarkdownForSpeech(text)
    if (!spokenText || spokenText.length > 4000) throw new Error('语音表达需要 1–4000 字的可朗读文本')
    const id = randomUUID()
    const segments = []; const created = []
    try {
      for await (const segment of synthesize({ text: spokenText, credentials: readCredentials(), signal: context.signal })) {
        context.signal?.throwIfAborted()
        const relativePath = `audio/speech_${id}_${segment.index}.mp3`
        const filename = path.join(sandboxRoot, relativePath)
        fs.mkdirSync(path.dirname(filename), { recursive: true })
        created.push(filename)
        fs.writeFileSync(filename, segment.audio)
        const { audio, ...metadata } = segment
        segments.push({ ...metadata, path: relativePath })
      }
      return { version: 1, id, text: spokenText, segments }
    } catch (error) {
      for (const filename of created) {
        try { fs.rmSync(filename, { force: true }) } catch { /* Keep the original synthesis/write failure. */ }
      }
      throw error
    }
  }
}
