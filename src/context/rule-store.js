import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { paths } from '../paths.js'

export const DEFAULT_CONTEXT_RULES = [
  {
    id: 'ssh_local_resources',
    kind: 'context',
    provider: 'local_resources',
    enabled: true,
    status: 'active',
    risk: 'medium',
    source_kind: 'system_default',
    patterns: [
      '\\u670d\\u52a1\\u5668',
      '\\u4e0a.*\\u670d\\u52a1\\u5668',
      '(?:\\u767b(?:\\u5f55|\\u9646)|\\u8fde(?:\\u63a5|\\u4e0a)).*(?:\\u670d\\u52a1\\u5668|\\u4e3b\\u673a|vps|ecs|ssh|server|host)',
      '(?:\\u670d\\u52a1\\u5668|\\u4e3b\\u673a|vps|ecs|server|host).*(?:\\u767b(?:\\u5f55|\\u9646)|\\u8fde(?:\\u63a5|\\u4e0a))',
      '\\u514d\\u5bc6',
      'ssh',
      'known_hosts',
      'authorized_keys',
      'root@',
      '\\b(?:server|host|vps|ecs|ssh)\\b',
    ],
  },
  {
    id: 'ssh_powershell_remote_shell_quoting',
    kind: 'context',
    provider: 'static_text',
    enabled: true,
    status: 'active',
    risk: 'low',
    source_kind: 'system_default',
    patterns: [
      '\\u670d\\u52a1\\u5668',
      '(?:\\u767b(?:\\u5f55|\\u9646)|\\u8fde(?:\\u63a5|\\u4e0a)).*(?:\\u670d\\u52a1\\u5668|\\u4e3b\\u673a|vps|ecs|ssh|server|host)',
      '(?:\\u670d\\u52a1\\u5668|\\u4e3b\\u673a|vps|ecs|server|host).*(?:\\u767b(?:\\u5f55|\\u9646)|\\u8fde(?:\\u63a5|\\u4e0a))',
      'ssh',
      '\\b(?:server|host|vps|ecs|ssh)\\b',
    ],
    context: [
      'SSH command composition rule for this Windows host:',
      '- exec_command runs in local PowerShell. If an ssh command passes a remote Linux shell command, protect remote Bash syntax from local PowerShell expansion.',
      '- Especially escape or single-quote remote `$()`, `$VAR`, backticks, and nested double quotes. A local error mentioning Get-Date while running ssh usually means PowerShell expanded remote `$(date ...)` before it reached the server.',
      '- After such an error, retry once with corrected quoting instead of treating it as an SSH authentication or server-side failure.',
    ].join('\n'),
  },
  {
    id: 'installed_software_snapshot',
    kind: 'context',
    provider: 'installed_software',
    enabled: true,
    status: 'active',
    risk: 'low',
    source_kind: 'system_default',
    patterns: [
      '软件',
      '应用',
      '程序',
      '客户端',
      '工具',
      '已安装',
      '装了什么',
      '用了什么',
      '浏览器',
      '启动程序',
      '代理',
      '科学上网',
      '翻墙',
      '\\bvpn\\b',
      '\\bproxy\\b',
      'clash',
      'mihomo',
      'v2ray',
      'xray',
      'sing-?box',
      'shadowrocket',
      'shadowsocks',
      'wireguard',
      'tailscale',
      'zerotier',
      'openvpn',
    ],
  },
]

function readConfig({ strict = false } = {}) {
  try {
    const config = JSON.parse(fs.readFileSync(paths.configFile, 'utf8'))
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('Configuration must be a JSON object: config.json')
    }
    return config
  } catch (error) {
    if (strict && error.code !== 'ENOENT') throw error
    return {}
  }
}

function writeConfig(config) {
  const tmp = `${paths.configFile}.${crypto.randomUUID()}.tmp`
  fs.mkdirSync(path.dirname(paths.configFile), { recursive: true })
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    fs.renameSync(tmp, paths.configFile)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

export function normalizeRule(rule = {}, fallbackKind = 'context') {
  if (!rule || typeof rule !== 'object') return null
  const id = String(rule.id || '').trim()
  const provider = String(rule.provider || rule.action?.type || '').trim()
  const patterns = Array.isArray(rule.patterns)
    ? rule.patterns.map(pattern => String(pattern || '').trim()).filter(Boolean)
    : []

  if (!id || !provider || patterns.length === 0) return null
  return {
    ...rule,
    id,
    kind: rule.kind || fallbackKind,
    provider,
    patterns,
    enabled: rule.enabled !== false,
    status: rule.status || (rule.enabled === false ? 'draft' : 'active'),
  }
}

function mergeRules(...groups) {
  const byId = new Map()
  for (const group of groups) {
    if (!Array.isArray(group)) continue
    for (const rule of group) {
      const normalized = normalizeRule(rule)
      if (normalized) byId.set(normalized.id, normalized)
    }
  }
  return [...byId.values()]
}

export function loadContextRules({ includeDefaults = true, includeLegacy = true, strict = false } = {}) {
  const config = readConfig({ strict })
  const current = Array.isArray(config.contextRules) ? config.contextRules : []
  const legacy = includeLegacy && Array.isArray(config.keywordContextRules) ? config.keywordContextRules : []
  return mergeRules(includeDefaults ? DEFAULT_CONTEXT_RULES : [], legacy, current)
}

export function saveContextRules(rules = []) {
  const config = readConfig({ strict: true })
  const normalized = Array.isArray(rules)
    ? rules.map(rule => normalizeRule(rule, 'context')).filter(Boolean)
    : []
  config.contextRules = normalized
  writeConfig(config)
  return normalized
}

export function loadAutomationRules({ strict = false } = {}) {
  const config = readConfig({ strict })
  return Array.isArray(config.automationRules)
    ? config.automationRules.map(rule => normalizeRule(rule, 'automation')).filter(Boolean)
    : []
}

export function saveAutomationRules(rules = []) {
  const config = readConfig({ strict: true })
  const normalized = Array.isArray(rules)
    ? rules.map(rule => normalizeRule(rule, 'automation')).filter(Boolean)
    : []
  config.automationRules = normalized
  writeConfig(config)
  return normalized
}

export function upsertRule(kind = 'context', rule = {}) {
  const isAutomation = kind === 'automation'
  const rules = isAutomation
    ? loadAutomationRules({ strict: true })
    : loadContextRules({ includeDefaults: false, includeLegacy: false, strict: true })
  const normalized = normalizeRule({ ...rule, kind }, kind)
  if (!normalized) throw new Error('invalid rule: id, provider/action.type, and patterns are required')
  const next = rules.filter(existing => existing.id !== normalized.id)
  next.push(normalized)
  return {
    rule: normalized,
    rules: isAutomation ? saveAutomationRules(next) : saveContextRules(next),
  }
}

export function updateRule(kind = 'context', id = '', patch = {}) {
  const isAutomation = kind === 'automation'
  const rules = isAutomation
    ? loadAutomationRules({ strict: true })
    : loadContextRules({ includeDefaults: false, includeLegacy: false, strict: true })
  const targetId = String(id || '').trim()
  const index = rules.findIndex(rule => rule.id === targetId)
  const inherited = !isAutomation && index < 0
    ? loadContextRules({ strict: true }).find(rule => rule.id === targetId)
    : null
  if (index < 0 && !inherited) throw new Error(`rule "${targetId}" was not found`)
  const base = index >= 0 ? rules[index] : inherited
  const merged = normalizeRule({ ...base, ...patch, id: targetId }, kind)
  if (!merged) throw new Error('invalid rule update')
  const next = [...rules]
  if (index >= 0) next[index] = merged
  else next.push(merged)
  return {
    rule: merged,
    rules: isAutomation ? saveAutomationRules(next) : saveContextRules(next),
  }
}

export function deleteRule(kind = 'context', id = '') {
  const isAutomation = kind === 'automation'
  const rules = isAutomation
    ? loadAutomationRules({ strict: true })
    : loadContextRules({ includeDefaults: false, includeLegacy: false, strict: true })
  const targetId = String(id || '').trim()
  const next = rules.filter(rule => rule.id !== targetId)
  if (next.length === rules.length) throw new Error(`rule "${targetId}" was not found`)
  return isAutomation ? saveAutomationRules(next) : saveContextRules(next)
}
