// LLM Provider 配置
//
// 查找顺序（先到先得）：
//   1. userData/config.json        —— 用户在激活页填入的 key
//   2. 环境变量 (.env)             —— 老的本地开发方式
//
// 如果两处都没有，config.needsActivation = true，
// 主循环会等待激活，API 只暴露激活相关路由和 /brain-ui 的前置落地页。
//
// 激活成功后调用 activate({ provider, apiKey }) 即可热更新配置并持久化到 config.json。

import fs from 'fs'
import path from 'path'
import { paths } from './paths.js'

const PROVIDERS = {
  minimax: {
    model: 'MiniMax-M2.7',
    baseURL: 'https://api.minimax.chat/v1',
    envVar: 'MINIMAX_API_KEY',
  },
  deepseek: {
    // deepseek-reasoner = DeepSeek-V3.2 思考模式；thinking=false 时会自动切到 deepseek-chat
    model: 'deepseek-reasoner',
    baseURL: 'https://api.deepseek.com/v1',
    envVar: 'DEEPSEEK_API_KEY',
  },
  openai: {
    model: 'gpt-5.4',
    baseURL: 'https://api.openai.com/v1',
    envVar: 'OPENAI_API_KEY',
  },
}

export const SUPPORTED_PROVIDERS = Object.keys(PROVIDERS)

function readStoredConfig() {
  try {
    if (!fs.existsSync(paths.configFile)) return null
    const raw = fs.readFileSync(paths.configFile, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.provider && parsed.apiKey) return parsed
    return null
  } catch {
    return null
  }
}

function writeStoredConfig(obj) {
  const tmp = paths.configFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8')
  fs.renameSync(tmp, paths.configFile)
}

function loadFromEnv() {
  const providerEnv = (process.env.LLM_PROVIDER || '').toLowerCase()
  const candidates = providerEnv ? [providerEnv] : SUPPORTED_PROVIDERS
  for (const name of candidates) {
    const spec = PROVIDERS[name]
    if (!spec) continue
    const key = process.env[spec.envVar]
    if (key) return { provider: name, apiKey: key }
  }
  return null
}

function shouldAllowEnvFallback() {
  // 打包后的 Electron 安装版必须走激活页，不应自动吃开发机/系统环境变量里的 key。
  // 仅在纯 Node 开发模式下保留 .env / 环境变量回退，方便本地调试。
  return !process.versions?.electron
}

function applyProvider(name, apiKey) {
  const spec = PROVIDERS[name]
  if (!spec) throw new Error(`不支持的 provider: ${name}`)
  config.provider = name
  config.model = spec.model
  config.baseURL = spec.baseURL
  config.apiKey = apiKey
  config.needsActivation = false
}

export const config = {
  // Tick 间隔（毫秒）- 默认空闲 TICK 10 分钟
  tickInterval: 10 * 60 * 1000,

  // LLM 配置 —— 运行时由 activate() 或启动时的 readStoredConfig/loadFromEnv 填充
  provider: null,
  model: null,
  apiKey: null,
  baseURL: null,

  // 首次启动还没拿到 key 时为 true；激活成功后翻成 false
  needsActivation: true,
}

// 启动时尝试载入已保存的激活信息
const stored = readStoredConfig()
if (stored) {
  try {
    applyProvider(stored.provider, stored.apiKey)
  } catch (err) {
    console.warn('[config] 激活文件里 provider 无效，忽略:', err.message)
  }
} else {
  if (shouldAllowEnvFallback()) {
    const fromEnv = loadFromEnv()
    if (fromEnv) {
      applyProvider(fromEnv.provider, fromEnv.apiKey)
    }
  }
}

// —— 激活 API ——
// 真正调用 LLM 验证 key 是否可用；成功则写盘并热更新 config
export async function activate({ provider, apiKey }) {
  const name = String(provider || '').toLowerCase()
  const spec = PROVIDERS[name]
  if (!spec) throw new Error(`不支持的 provider: ${provider}`)
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 8) {
    throw new Error('API Key 无效')
  }

  // 最小化验证：调一次 chat.completions，1 token，确认鉴权通过
  const { default: OpenAI } = await import('openai')
  const client = new OpenAI({ apiKey: apiKey.trim(), baseURL: spec.baseURL })
  try {
    await client.chat.completions.create({
      model: spec.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    })
  } catch (err) {
    const msg = err?.message || String(err)
    if (/401|unauthoriz|invalid.*api.*key|invalid_request_error/i.test(msg)) {
      throw new Error('API Key 无法通过鉴权，请检查是否选对了 provider')
    }
    // 网络层面的错误也视为失败，不写盘
    throw new Error(`激活验证失败: ${msg}`)
  }

  applyProvider(name, apiKey.trim())
  writeStoredConfig({ provider: name, apiKey: apiKey.trim(), activatedAt: new Date().toISOString() })
  return { provider: name, model: spec.model }
}

export function getActivationStatus() {
  return {
    activated: !config.needsActivation,
    provider: config.provider,
    model: config.model,
  }
}

// 仅供测试或管理用：清除激活信息
export function deactivate() {
  try { if (fs.existsSync(paths.configFile)) fs.unlinkSync(paths.configFile) } catch {}
  config.provider = null
  config.model = null
  config.apiKey = null
  config.baseURL = null
  config.needsActivation = true
}

// 隐藏字段写入时的辅助（不导出）
export const __internals = { PROVIDERS }
