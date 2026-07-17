import fs from 'fs'
import path from 'path'
import { nowTimestamp } from '../../../time.js'
import { emitEvent } from '../../../events.js'
import { isDailyLimitReached } from '../../../quota.js'
import { getTTSCredentials } from '../../../config.js'
import { streamTTS, TTS_VOICES, validateTTSConfig } from '../../../voice/tts-providers.js'
import { SANDBOX_ROOT } from '../../sandbox.js'

// speak：将文字转为语音，保存为音频文件
function resolveProviderVoiceId(provider, requestedVoiceId, configuredVoiceId) {
  const voices = TTS_VOICES[provider] || []
  if (!voices.length) return requestedVoiceId || configuredVoiceId || undefined

  const validIds = new Set(voices.map(v => v.id))
  if (requestedVoiceId && validIds.has(requestedVoiceId)) return requestedVoiceId
  if (requestedVoiceId) {
    console.warn(`[speak] Ignoring voice_id "${requestedVoiceId}" because it is not valid for TTS provider "${provider}"`)
  }

  if (configuredVoiceId && validIds.has(configuredVoiceId)) return configuredVoiceId
  if (configuredVoiceId) {
    console.warn(`[speak] Ignoring configured voice "${configuredVoiceId}" because it is not valid for TTS provider "${provider}"`)
  }

  return voices[0]?.id
}

// 朗读文本长度上限（与 schema 描述对齐为同一常量；剥掉 markdown 后再计）
const SPEAK_MAX_CHARS = 1000

// 把流缓冲成完整音频 buffer；空音频视为失败（很多 provider 在音色无权限/参数错时返回空流）
async function collectAudioStream(nodeStream) {
  const chunks = []
  for await (const chunk of nodeStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

// 可重试的瞬时错误：网络抖动 / 限流 / 5xx。凭证错、参数错不在此列（重试无意义）。
function isTransientTTSError(err) {
  const m = String(err?.message || '')
  return /\b(429|500|502|503|504)\b/.test(m)
    || /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|aborted/i.test(m)
}

// 合成：瞬时失败自动重试一次；其余直接抛给上层归一化
async function synthSpeechBuffer({ text, provider, voiceId, creds }) {
  let lastErr
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const nodeStream = await streamTTS({ text, provider, voiceId, keys: creds })
      const buffer = await collectAudioStream(nodeStream)
      if (!buffer.length) throw new Error('TTS 返回空音频（音色可能未在账号开通，或参数不被支持）')
      return buffer
    } catch (err) {
      lastErr = err
      if (err.name === 'AbortError') throw err
      if (attempt === 0 && isTransientTTSError(err)) {
        console.warn(`[speak] 合成失败(瞬时，重试一次): ${err.message}`)
        await new Promise(r => setTimeout(r, 600))
        continue
      }
      throw err
    }
  }
  throw lastErr
}

// 把各家 SDK 的裸错误归一成"该去哪改什么"的可执行中文提示，供模型转述给用户
function normalizeTTSError(err, provider) {
  const msg = String(err?.message || '未知错误').slice(0, 200)
  if (/resource ID is mismatched|55000000/i.test(msg)) {
    return `语音合成失败：豆包音色与 Resource ID 不匹配。2.0 音色（*_uranus_bigtts）需用 seed-tts-2.0，旧 moon/BV 音色需 seed-tts-1.0。请去语音设置切换音色，或清空/改正 Resource ID。（${msg}）`
  }
  if (/\b(401|403)\b/.test(msg) || /unauthor|invalid.*(key|token)|api[ _-]?key/i.test(msg)) {
    return `语音合成失败：当前服务商（${provider}）的凭证可能无效或已过期。请去语音设置重新填写后再试。（${msg}）`
  }
  if (/\b429\b|rate.?limit|quota|配额|余额|insufficient/i.test(msg)) {
    return `语音合成失败：服务商（${provider}）触发限流或配额/余额不足。请稍后再试或检查账户。（${msg}）`
  }
  if (isTransientTTSError(err)) {
    return `语音合成失败：网络或服务暂时不可用（已自动重试一次）。请稍后再试。（${msg}）`
  }
  return `语音合成失败：${msg}`
}

export async function execSpeak(args, context = {}) {
  const rawText = args.text || args.content || args.words || args.speech
  const { filename } = args
  console.log(`[speak] args:`, JSON.stringify(args))
  if (!rawText) return '错误：未提供要朗读的文字'
  if (isDailyLimitReached('tts')) return '错误：今日 TTS 配额已用完'

  // 与流式 /tts/stream 入口对齐：先剥 markdown，避免把 * # ` 等符号念成"星号""井号"
  const text = stripMarkdownForSpeech(rawText)
  if (!text) return '错误：去掉符号后没有可朗读的文字'
  if (text.length > SPEAK_MAX_CHARS) return `错误：文字过长（${text.length} 字），请控制在 ${SPEAK_MAX_CHARS} 字以内`

  const creds = getTTSCredentials()

  // 合成前预检：当前服务商凭证没配齐就直接返回结构化引导，不冲到 API 才裸报错。
  const check = validateTTSConfig(creds)
  if (!check.ok) return `语音合成还不能用：${check.guide}`

  const requestedVoiceId = args.voice_id || args.voice
  const voiceId = resolveProviderVoiceId(creds.provider, requestedVoiceId, creds.voiceId)

  let buffer
  try {
    buffer = await synthSpeechBuffer({ text, provider: creds.provider, voiceId, creds })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    console.warn(`[speak] 合成失败: ${err.message}`)
    return normalizeTTSError(err, creds.provider)
  }

  const ts = nowTimestamp().replace(/[:.+]/g, '-').slice(0, 19)
  const fname = filename ? filename.replace(/[^a-zA-Z0-9_一-龥-]/g, '') + '.mp3' : `speech_${ts}.mp3`
  const resolved = path.resolve(SANDBOX_ROOT, 'audio', fname)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, buffer)

  const relPath = `audio/${fname}`
  emitEvent('audio_created', {
    path: relPath,
    text: text.slice(0, 60),
    autoPlay: true,
    target_client_id: context.replyClientId || '',
  })
  console.log(`[speak] 已生成: ${relPath}`)
  return `语音已生成：${relPath}`
}

// markdown → 朗读用纯文本：TTS 引擎会把 * # ` 等符号直接念出来（"星星"），
// 所有进入合成的文本都要先过这里——/tts/stream 入口统一调用，是剥离的单一权威
export function stripMarkdownForSpeech(text) {
  return String(text || '').trim()
    .replace(/^[ \t]*([-*+]|\d+[.、])\s+/gm, '')
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`{1,3}(.+?)`{1,3}/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/!\[[^\]]*\]\([^\)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/\*\*/g, '') // 加粗记号被流式切句切成两半时残留的半截
    .replace(/\n+/g, ' ')
    .trim()
}

// 语音消息自动回复 TTS：检测到用户用语音输入时，通知前端播放语音
// 由 index.js 调用，前端收到 tts_reply 事件后调用 /tts/stream 完成实际合成
export function autoSpeakForVoiceReply(text, { targetClientId = '' } = {}) {
  if (!text) return
  const plain = stripMarkdownForSpeech(text)
  if (!plain) return
  // 纯表情 / 标点（没有任何可读文字）不合成语音：播放确认现在用单个 emoji 代替，
  // 语音模式下不该把它念出来（\p{L}=字母含汉字，\p{N}=数字）。
  if (!/[\p{L}\p{N}]/u.test(plain)) return
  emitEvent('tts_reply', { text: plain, target_client_id: targetClientId })
}
