export const DEFAULT_TTS_PROVIDER = 'doubao'
export const DEFAULT_DOUBAO_VOICE_ID = 'zh_male_m191_uranus_bigtts'
export const DEFAULT_DOUBAO_SPEECH_RATE = 20

export function normalizeDoubaoSpeechRate(value, fallback = DEFAULT_DOUBAO_SPEECH_RATE) {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(-50, Math.min(100, numeric))
}
