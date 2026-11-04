import fs from 'node:fs'
import path from 'node:path'
import { paths } from '../paths.js'
import { getProviderConnection } from '../config.js'
import { getSecret, hasSecret, updateSecrets } from './secret-store.js'
import { SEARCH_PRESETS, WEB_ADAPTERS } from './registry.js'

const file = path.join(paths.userDir, 'search-services.json')
const secretRef = id => `search:${id}:apiKey`
const idPattern = /^[a-z][a-z0-9_-]{0,63}$/
const empty = () => ({ version: 1, connections: [], defaultProvider: 'auto', rules: [], fallback: { enabled: false, providers: [] } })
function read() {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (value.version !== 1 || !Array.isArray(value.connections)) throw new Error('搜索配置格式无效')
    return value
  } catch (error) { if (error.code === 'ENOENT') return empty(); throw error }
}
function official(adapter, baseURL) {
  try {
    const url = new URL(baseURL)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && url.hostname === new URL(SEARCH_PRESETS[adapter].baseURL).hostname
      && ['', '/', '/v1', '/v1/'].includes(url.pathname) && !url.search && !url.hash
  } catch { return false }
}
// Discovery does not persist duplicates or reactivate a connection explicitly disabled by the user.
export function getSearchConfig() {
  const store = read()
  const connections = [...store.connections]
  for (const adapter of ['deepseek', 'openai']) {
    const id = `llm-${adapter}`
    const llm = getProviderConnection(adapter)
    if (!connections.some(item => item.id === id) && llm && official(adapter, llm.baseURL)) {
      connections.push({ id, adapter, name: `${SEARCH_PRESETS[adapter].name}（复用模型凭证）`, enabled: true,
        credentialSource: 'llm', llmProvider: adapter, baseURL: SEARCH_PRESETS[adapter].baseURL,
        model: SEARCH_PRESETS[adapter].model })
    }
  }
  return { ...store, connections }
}
export function resolveSearchConnection(item) {
  if (!item?.enabled) return null
  const llm = item.credentialSource === 'llm' ? getProviderConnection(item.llmProvider) : null
  if (item.credentialSource === 'llm' && (!llm || !official(item.adapter, llm.baseURL))) return null
  const apiKey = llm ? llm.apiKey : getSecret(secretRef(item.id))
  if (!apiKey) return null
  return { id: item.id, provider: item.adapter, baseURL: item.baseURL, model: item.model, apiKey }
}
export function getSearchSettings() {
  const settings = getSearchConfig()
  return { ...settings, connections: settings.connections.map(item => {
    const llm = item.credentialSource === 'llm' ? getProviderConnection(item.llmProvider) : null
    return { ...item, configured: item.credentialSource === 'llm'
      ? !!llm && official(item.adapter, llm.baseURL) : hasSecret(secretRef(item.id)) }
  }), adapters: Object.entries(SEARCH_PRESETS).map(([id, preset]) => ({ id, ...preset, capabilities: WEB_ADAPTERS[id].capabilities })) }
}
export function setSearchSettings(input) {
  if (!input || !Array.isArray(input.connections) || input.connections.length > 30) throw new Error('搜索连接必须为数组，最多 30 个')
  const previous = getSearchConfig()
  const ids = new Set()
  const updates = []
  const connections = input.connections.map(raw => {
    if (!raw || !idPattern.test(raw.id) || raw.id === 'auto' || ids.has(raw.id)) throw new Error('连接 ID 无效或重复')
    ids.add(raw.id)
    if (!Object.hasOwn(SEARCH_PRESETS, raw.adapter)) throw new Error('不支持的搜索适配器')
    if (typeof raw.enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
    const preset = SEARCH_PRESETS[raw.adapter]
    const baseURL = raw.baseURL || preset.baseURL
    if (!official(raw.adapter, baseURL)) throw new Error('当前搜索适配器仅允许官方 HTTPS 地址；代理须通过独立适配器接入')
    if (!['llm', 'secret'].includes(raw.credentialSource)) throw new Error('凭证来源无效')
    if (raw.credentialSource === 'llm' && (!['deepseek', 'openai'].includes(raw.adapter) || raw.llmProvider !== raw.adapter)) throw new Error('只能引用同一家官方模型服务的凭证')
    const old = previous.connections.find(item => item.id === raw.id)
    const changedTarget = old && (old.adapter !== raw.adapter || old.credentialSource !== raw.credentialSource)
    if (raw.apiKey !== undefined && (typeof raw.apiKey !== 'string' || raw.apiKey.length > 16384)) throw new Error('API Key 无效')
    if (raw.credentialSource === 'secret' && raw.apiKey?.trim()) updates.push({ ref: secretRef(raw.id), value: raw.apiKey.trim() })
    else if (changedTarget || raw.clearKey === true) updates.push({ ref: secretRef(raw.id), value: '' })
    const model = String(raw.model || preset.model).trim()
    if (model.length > 200 || (raw.adapter === 'openai' && !model)) throw new Error('搜索模型无效')
    return { id: raw.id, name: String(raw.name || preset.name).slice(0, 100), adapter: raw.adapter,
      enabled: raw.enabled, credentialSource: raw.credentialSource, llmProvider: raw.credentialSource === 'llm' ? raw.adapter : null,
      baseURL, model }
  })
  // Persist disabled discovery records when removed, so discovery does not resurrect them.
  for (const item of previous.connections) if (!ids.has(item.id)) {
    updates.push({ ref: secretRef(item.id), value: '' })
    if (item.id === `llm-${item.adapter}`) connections.push({ ...item, enabled: false })
  }
  const validTarget = id => connections.some(item => item.id === id && item.enabled)
  const defaultProvider = input.defaultProvider || 'auto'
  if (defaultProvider !== 'auto' && !validTarget(defaultProvider)) throw new Error('默认连接必须存在且已启用')
  const rules = input.rules ?? []
  if (!Array.isArray(rules) || rules.length > 30) throw new Error('偏好规则最多 30 条')
  const normalizedRules = rules.map((rule, index) => {
    if (!rule || !validTarget(rule.provider) || !['language', 'topic', 'domain'].includes(rule.field)
      || typeof rule.value !== 'string' || !rule.value.trim() || rule.value.length > 200) throw new Error('偏好规则无效')
    if (rule.field === 'language' && !['zh', 'en'].includes(rule.value)) throw new Error('语言规则支持 zh / en')
    if (rule.field === 'topic' && !['general', 'news', 'technical', 'academic'].includes(rule.value)) throw new Error('主题规则无效')
    if (rule.field === 'domain' && !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(rule.value)) throw new Error('域名规则无效')
    return { id: `rule-${index + 1}`, field: rule.field, value: rule.value.toLowerCase(), provider: rule.provider }
  })
  const fallback = input.fallback ?? { enabled: false, providers: [] }
  if (typeof fallback.enabled !== 'boolean' || !Array.isArray(fallback.providers) || fallback.providers.length > 5
    || fallback.providers.some(id => !validTarget(id))) throw new Error('备用连接最多 5 个，必须存在且已启用')
  const next = { version: 1, connections, defaultProvider, rules: normalizedRules,
    fallback: { enabled: fallback.enabled, providers: [...new Set(fallback.providers)] } }
  updateSecrets(updates, () => {
    const tmp = `${file}.tmp`
    try { fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file) }
    finally { fs.rmSync(tmp, { force: true }) }
  })
  return getSearchSettings()
}
