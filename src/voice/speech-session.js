import { streamTTS, TTS_VOICES, validateTTSConfig } from './tts-providers.js'

// Provider-neutral transport: a segment contains audio bytes and optional
// source-text cues in milliseconds. UI code never consumes vendor events.
export function splitSpeechText(text, maxChars = 100) {
  const units = String(text).match(/[^。！？!?；;\n]+[。！？!?；;\n]*|[。！？!?；;\n]+/gu) || []
  return units.flatMap(unit => {
    const chars = Array.from(unit); const parts = []
    while (chars.length) parts.push(chars.splice(0, maxChars).join(''))
    return parts
  }).filter(Boolean)
}

export function normalizeDoubaoCues(event, sourceText) {
  const words = event?.sentence?.words || event?.subtitle?.words || event?.words || []
  let cursor = 0
  return words.flatMap(word => {
    const text = String(word.text || word.word || '')
    const offset = sourceText.indexOf(text, cursor)
    const startMs = Number(word.startTime ?? word.start_time) * 1000
    const endMs = Number(word.endTime ?? word.end_time) * 1000
    if (!text || offset < 0 || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return []
    cursor = offset + text.length
    return [{ startMs, endMs, endOffset: cursor }]
  })
}

export async function* synthesizeSpeechSegments({ text, credentials, signal }, { synthesize = streamTTS } = {}) {
  const check = validateTTSConfig(credentials)
  if (!check.ok) throw new Error(check.guide)
  const provider = credentials.provider
  const voices = TTS_VOICES[provider] || []
  const voiceId = voices.some(v => v.id === credentials.voiceId) ? credentials.voiceId : voices[0]?.id
  const parts = splitSpeechText(text)
  for (let index = 0; index < parts.length; index++) {
    signal?.throwIfAborted()
    const cues = []
    const timedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000)
    const stream = await synthesize({ text: parts[index], provider, voiceId, keys: credentials, signal: timedSignal,
      onMetadata: event => { if (provider === 'doubao') cues.push(...normalizeDoubaoCues(event, parts[index])) },
    })
    const cancel = () => stream.destroy(timedSignal.reason)
    timedSignal.addEventListener('abort', cancel, { once: true })
    const chunks = []
    try {
      if (timedSignal.aborted) cancel()
      for await (const chunk of stream) { timedSignal.throwIfAborted(); chunks.push(Buffer.from(chunk)) }
    } finally { timedSignal.removeEventListener('abort', cancel) }
    signal?.throwIfAborted()
    const audio = Buffer.concat(chunks)
    if (!audio.length) throw new Error(`${provider}: 未返回语音数据`)
    const unique = [...new Map(cues.map(c => [JSON.stringify(c), c])).values()].sort((a,b) => a.startMs-b.startMs)
    yield { index, text: parts[index], audio, mimeType: 'audio/mpeg', cues: unique, alignment: unique.length ? 'provider' : 'estimated' }
  }
}
