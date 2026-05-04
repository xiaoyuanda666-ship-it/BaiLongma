import fs from 'fs'
import { paths } from './paths.js'

export const DEEPSEEK_PROVIDER = 'deepseek'
export const MINIMAX_PROVIDER = 'minimax'

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'
export const DEFAULT_MINIMAX_MODEL = 'MiniMax-M2.7'

export const DEEPSEEK_MODELS = [
  {
    id: 'deepseek-v4-flash',
    label: 'deepseek-v4-flash',
    deprecated: false,
  },
  {
    id: 'deepseek-v4-pro',
    label: 'deepseek-v4-pro',
    deprecated: false,
  },
  {
    id: 'deepseek-chat',
    label: 'deepseek-chat (将于 2026/07/24 弃用)',
    deprecated: true,
  },
  {
    id: 'deepseek-reasoner',
    label: 'deepseek-reasoner (将于 2026/07/24 弃用)',
    deprecated: true,
  },
]

export const MINIMAX_MODELS = [
  {
    id: 'MiniMax-M2.7',
    label: 'MiniMax-M2.7',
    deprecated: false,
  },
  {
    id: 'MiniMax-M1',
    label: 'MiniMax-M1',
    deprecated: false,
  },
]

const PROVIDER_CONFIG = {
  [DEEPSEEK_PROVIDER]: {
    baseURL: 'https://api.deepseek.com',
    envVar: 'DEEPSEEK_API_KEY',
    models: DEEPSEEK_MODELS,
    defaultModel: DEFAULT_DEEPSEEK_MODEL,
  },
  [MINIMAX_PROVIDER]: {
    baseURL: 'https://api.minimax.chat/v1',
    envVar: 'MINIMAX_API_KEY',
    models: MINIMAX_MODELS,
    defaultModel: DEFAULT_MINIMAX_MODEL,
  },
}

function normalizeModel(model, provider = DEEPSEEK_PROVIDER) {
  const pConfig = PROVIDER_CONFIG[provider] || PROVIDER_CONFIG[DEEPSEEK_PROVIDER]
  const value = String(model || '').trim()
  const validIds = new Set(pConfig.models.map(m => m.id))
  if (validIds.has(value)) return value
  return pConfig.defaultModel
}

function isThinkingEnabledForModel(model) {
  return normalizeModel(model) !== 'deepseek-chat'
}

function readStoredConfig() {
  try {
    if (!fs.existsSync(paths.configFile)) return null
    const raw = fs.readFileSync(paths.configFile, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.provider || !PROVIDER_CONFIG[parsed.provider]) return null
    if (!parsed.apiKey || typeof parsed.apiKey !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

function writeStoredConfig(obj) {
  const tmp = paths.configFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8')
  fs.renameSync(tmp, paths.configFile)
}

function shouldAllowEnvFallback() {
  return !process.versions?.electron
}

function loadFromEnv() {
  const deepseekKey = process.env['DEEPSEEK_API_KEY']
  if (deepseekKey) {
    return {
      provider: DEEPSEEK_PROVIDER,
      apiKey: deepseekKey,
      model: normalizeModel(process.env.DEEPSEEK_MODEL, DEEPSEEK_PROVIDER),
    }
  }
  const minimaxKey = process.env['MINIMAX_API_KEY']
  if (minimaxKey) {
    return {
      provider: MINIMAX_PROVIDER,
      apiKey: minimaxKey,
      model: normalizeModel(process.env.MINIMAX_MODEL, MINIMAX_PROVIDER),
    }
  }
  return null
}

function applyConfig(provider, apiKey, model) {
  const pConfig = PROVIDER_CONFIG[provider]
  config.provider = provider
  config.model = normalizeModel(model, provider)
  config.apiKey = apiKey
  config.baseURL = pConfig.baseURL
  config.needsActivation = false
}

export const config = {
  tickInterval: 20 * 60 * 1000,
  provider: null,
  model: null,
  apiKey: null,
  baseURL: null,
  needsActivation: true,
  temperature: 0.5,
}

const stored = readStoredConfig()
if (stored) {
  applyConfig(stored.provider, stored.apiKey, stored.model)
  if (typeof stored.temperature === 'number' && stored.temperature >= 0 && stored.temperature <= 2) {
    config.temperature = stored.temperature
  }
} else if (shouldAllowEnvFallback()) {
  const fromEnv = loadFromEnv()
  if (fromEnv) applyConfig(fromEnv.provider, fromEnv.apiKey, fromEnv.model)
}

// 启动时把 config 文件里的 social 凭证写入 process.env，让各连接器能读到
;(function loadSocialEnv() {
  try {
    const raw = fs.readFileSync(paths.configFile, 'utf-8')
    const social = JSON.parse(raw)?.social || {}
    for (const [key, val] of Object.entries(social)) {
      if (typeof val === 'string' && val && globalThis.process?.env) {
        globalThis.process.env[key] = val
      }
    }
  } catch {}
})()

export async function activate({ provider = DEEPSEEK_PROVIDER, apiKey, model }) {
  const p = String(provider || DEEPSEEK_PROVIDER).toLowerCase()
  const pConfig = PROVIDER_CONFIG[p]
  if (!pConfig) {
    throw new Error(`不支持的 provider: "${p}"，可选: ${Object.keys(PROVIDER_CONFIG).join(', ')}`)
  }

  const normalizedKey = String(apiKey || '').trim()
  const normalizedModel = normalizeModel(model, p)
  if (normalizedKey.length < 8) {
    throw new Error(`${p} Key 无效`)
  }

  const { default: OpenAI } = await import('openai')
  const client = new OpenAI({ apiKey: normalizedKey, baseURL: pConfig.baseURL })

  try {
    const pingParams = {
      model: normalizedModel,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    }
    if (p === DEEPSEEK_PROVIDER) {
      pingParams.reasoning_effort = 'high'
      pingParams.extra_body = {
        thinking: { type: isThinkingEnabledForModel(normalizedModel) ? 'enabled' : 'disabled' }
      }
    }
    await client.chat.completions.create(pingParams)
  } catch (err) {
    const message = err?.message || String(err)
    if (/401|unauthoriz|invalid.*api.*key|authentication/i.test(message)) {
      throw new Error(`${p} Key 校验失败，请确认 key 是否正确`)
    }
    throw new Error(`${p} 验证失败: ${message}`)
  }

  applyConfig(p, normalizedKey, normalizedModel)
  writeStoredConfig({
    provider: p,
    apiKey: normalizedKey,
    model: normalizedModel,
    activatedAt: new Date().toISOString(),
  })

  return {
    provider: p,
    model: normalizedModel,
    models: pConfig.models,
  }
}

export function getActivationStatus() {
  const pConfig = config.provider ? PROVIDER_CONFIG[config.provider] : null
  return {
    activated: !config.needsActivation,
    provider: config.provider,
    model: config.model,
    models: pConfig ? pConfig.models : DEEPSEEK_MODELS,
    defaultModel: pConfig ? pConfig.defaultModel : DEFAULT_DEEPSEEK_MODEL,
  }
}

export function deactivate() {
  try {
    if (fs.existsSync(paths.configFile)) fs.unlinkSync(paths.configFile)
  } catch {}
  config.provider = null
  config.model = null
  config.apiKey = null
  config.baseURL = null
  config.needsActivation = true
}

export function switchModel(model) {
  if (!config.apiKey) throw new Error('尚未激活，无法切换模型')
  const normalized = normalizeModel(model, config.provider)
  config.model = normalized
  try {
    const existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))
    writeStoredConfig({ ...existing, model: normalized })
  } catch {}
  return { provider: config.provider, model: normalized }
}

export function setTemperature(t) {
  const v = Math.min(2, Math.max(0, Number(t) || 0.5))
  config.temperature = v
  try {
    const existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))
    writeStoredConfig({ ...existing, temperature: v })
  } catch {}
  return { temperature: v }
}

export function getMinimaxKey() {
  try {
    const raw = fs.readFileSync(paths.configFile, 'utf-8')
    const parsed = JSON.parse(raw)
    return typeof parsed?.minimax_api_key === 'string' ? parsed.minimax_api_key : null
  } catch { return null }
}

export function setMinimaxKey(key) {
  const trimmed = String(key || '').trim()
  let existing = {}
  try { existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) } catch {}
  if (trimmed) {
    writeStoredConfig({ ...existing, minimax_api_key: trimmed })
  } else {
    const { minimax_api_key: _removed, ...rest } = existing
    writeStoredConfig(rest)
  }
}

// ── Social media platform config ──

const SOCIAL_ENV_KEYS = [
  'DISCORD_BOT_TOKEN',
  'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_VERIFICATION_TOKEN',
  'WECHAT_OFFICIAL_APP_ID', 'WECHAT_OFFICIAL_APP_SECRET', 'WECHAT_OFFICIAL_TOKEN',
  'WECOM_BOT_KEY', 'WECOM_INCOMING_TOKEN',
]

// ── WeChat ClawBot 凭证（扫码后自动写入，不暴露到 SOCIAL_ENV_KEYS）──

export function getClawbotCredentials() {
  try {
    const stored = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))
    const c = stored?.clawbot
    return (c?.accountId && c?.botToken) ? c : null
  } catch { return null }
}

export function setClawbotCredentials({ accountId, botToken, baseUrl }) {
  let existing = {}
  try { existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) } catch {}
  writeStoredConfig({ ...existing, clawbot: { accountId, botToken, baseUrl } })
}

export function clearClawbotCredentials() {
  let existing = {}
  try { existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) } catch {}
  const { clawbot: _, ...rest } = existing
  writeStoredConfig(rest)
}

export function getSocialConfig() {
  let stored = {}
  try { stored = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))?.social || {} } catch {}
  const result = {}
  for (const key of SOCIAL_ENV_KEYS) {
    const val = stored[key] || globalThis.process?.env?.[key] || ''
    result[key] = { configured: !!val }
  }
  return result
}

export function setSocialConfig(updates) {
  let existing = {}
  try { existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) } catch {}
  const current = existing.social || {}
  const next = { ...current }
  for (const [key, val] of Object.entries(updates)) {
    if (!SOCIAL_ENV_KEYS.includes(key)) continue
    const trimmed = String(val || '').trim()
    if (trimmed) {
      next[key] = trimmed
      // 立即生效，无需重启
      if (globalThis.process?.env) globalThis.process.env[key] = trimmed
    } else {
      delete next[key]
    }
  }
  writeStoredConfig({ ...existing, social: next })
}

const VOICE_CONFIG_KEYS = ['whisperModel', 'aliyunApiKey', 'tencentSecretId', 'tencentSecretKey', 'tencentAppId', 'xunfeiAppId', 'xunfeiApiKey', 'xunfeiApiSecret']

export function getVoiceConfig() {
  let stored = {}
  try { stored = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))?.voice || {} } catch {}
  const result = { whisperModel: stored.whisperModel || 'small' }
  for (const key of VOICE_CONFIG_KEYS.slice(1)) {
    result[key] = { configured: !!(stored[key]) }
  }
  return result
}

export function setVoiceConfig(updates) {
  let existing = {}
  try { existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) } catch {}
  const current = existing.voice || {}
  const next = { ...current }
  for (const [key, val] of Object.entries(updates)) {
    if (!VOICE_CONFIG_KEYS.includes(key)) continue
    const trimmed = String(val || '').trim()
    if (trimmed) next[key] = trimmed
    else delete next[key]
  }
  writeStoredConfig({ ...existing, voice: next })
}

// TTS 配置
const TTS_CONFIG_KEYS = [
  'ttsProvider', 'ttsVoiceId',
  'openaiTtsKey', 'openaiTtsBaseURL',
  'elevenLabsKey',
  'volcanoAppId', 'volcanoToken',
]

export function getTTSConfig() {
  let stored = {}
  try { stored = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))?.tts || {} } catch {}
  return {
    ttsProvider:     stored.ttsProvider  || 'minimax',
    ttsVoiceId:      stored.ttsVoiceId   || '',
    openaiTtsBaseURL: stored.openaiTtsBaseURL || '',
    openaiTtsKey:    { configured: !!(stored.openaiTtsKey) },
    elevenLabsKey:   { configured: !!(stored.elevenLabsKey) },
    volcanoAppId:    { configured: !!(stored.volcanoAppId), value: stored.volcanoAppId || '' },
    volcanoToken:    { configured: !!(stored.volcanoToken) },
  }
}

// 读取明文 TTS 凭证（仅供后端调用 TTS API 使用，不暴露给前端）
export function getTTSCredentials() {
  let stored = {}
  try { stored = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))?.tts || {} } catch {}
  return {
    provider:       stored.ttsProvider  || 'minimax',
    voiceId:        stored.ttsVoiceId   || '',
    minimaxKey:     process.env.MINIMAX_API_KEY || getMinimaxKey() || (config.provider === 'minimax' ? config.apiKey : '') || '',
    openaiKey:      stored.openaiTtsKey  || '',
    openaiBaseURL:  stored.openaiTtsBaseURL || '',
    elevenLabsKey:  stored.elevenLabsKey || '',
    volcanoAppId:   stored.volcanoAppId  || '',
    volcanoToken:   stored.volcanoToken  || '',
  }
}

export function setTTSConfig(updates) {
  let existing = {}
  try { existing = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8')) } catch {}
  const current = existing.tts || {}
  const next = { ...current }
  for (const [key, val] of Object.entries(updates)) {
    if (!TTS_CONFIG_KEYS.includes(key)) continue
    const trimmed = String(val || '').trim()
    if (trimmed) next[key] = trimmed
    else delete next[key]
  }
  writeStoredConfig({ ...existing, tts: next })
}

export const __internals = {
  DEEPSEEK_MODELS,
  MINIMAX_MODELS,
  normalizeModel,
  isThinkingEnabledForModel,
}
