import fs from 'fs'
import { paths } from './paths.js'

export const DEEPSEEK_PROVIDER = 'deepseek'
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'

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

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const DEEPSEEK_ENV_VAR = 'DEEPSEEK_API_KEY'
const SUPPORTED_MODEL_IDS = new Set(DEEPSEEK_MODELS.map(item => item.id))

function normalizeModel(model) {
  const value = String(model || '').trim()
  if (SUPPORTED_MODEL_IDS.has(value)) return value
  return DEFAULT_DEEPSEEK_MODEL
}

function isThinkingEnabledForModel(model) {
  const normalized = normalizeModel(model)
  if (normalized === 'deepseek-chat') return false
  return true
}

function readStoredConfig() {
  try {
    if (!fs.existsSync(paths.configFile)) return null
    const raw = fs.readFileSync(paths.configFile, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.provider && parsed.provider !== DEEPSEEK_PROVIDER) return null
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
  const apiKey = process.env[DEEPSEEK_ENV_VAR]
  if (!apiKey) return null
  return {
    apiKey,
    model: normalizeModel(process.env.DEEPSEEK_MODEL),
  }
}

function applyDeepSeekConfig(apiKey, model = DEFAULT_DEEPSEEK_MODEL) {
  config.provider = DEEPSEEK_PROVIDER
  config.model = normalizeModel(model)
  config.apiKey = apiKey
  config.baseURL = DEEPSEEK_BASE_URL
  config.needsActivation = false
}

export const config = {
  tickInterval: 10 * 60 * 1000,
  provider: null,
  model: null,
  apiKey: null,
  baseURL: null,
  needsActivation: true,
}

const stored = readStoredConfig()
if (stored) {
  applyDeepSeekConfig(stored.apiKey, stored.model)
} else if (shouldAllowEnvFallback()) {
  const fromEnv = loadFromEnv()
  if (fromEnv) applyDeepSeekConfig(fromEnv.apiKey, fromEnv.model)
}

export async function activate({ apiKey, model }) {
  const normalizedKey = String(apiKey || '').trim()
  const normalizedModel = normalizeModel(model)
  if (normalizedKey.length < 8) {
    throw new Error('DeepSeek Key 无效')
  }

  const { default: OpenAI } = await import('openai')
  const client = new OpenAI({ apiKey: normalizedKey, baseURL: DEEPSEEK_BASE_URL })

  try {
    await client.chat.completions.create({
      model: normalizedModel,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
      reasoning_effort: 'high',
      extra_body: {
        thinking: { type: isThinkingEnabledForModel(normalizedModel) ? 'enabled' : 'disabled' }
      },
    })
  } catch (err) {
    const message = err?.message || String(err)
    if (/401|unauthoriz|invalid.*api.*key|authentication/i.test(message)) {
      throw new Error('DeepSeek Key 校验失败，请确认 key 是否正确')
    }
    throw new Error(`DeepSeek 验证失败: ${message}`)
  }

  applyDeepSeekConfig(normalizedKey, normalizedModel)
  writeStoredConfig({
    provider: DEEPSEEK_PROVIDER,
    apiKey: normalizedKey,
    model: normalizedModel,
    activatedAt: new Date().toISOString(),
  })

  return {
    provider: DEEPSEEK_PROVIDER,
    model: normalizedModel,
    models: DEEPSEEK_MODELS,
  }
}

export function getActivationStatus() {
  return {
    activated: !config.needsActivation,
    provider: config.provider,
    model: config.model,
    models: DEEPSEEK_MODELS,
    defaultModel: DEFAULT_DEEPSEEK_MODEL,
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

export const __internals = {
  DEEPSEEK_MODELS,
  normalizeModel,
  isThinkingEnabledForModel,
}
