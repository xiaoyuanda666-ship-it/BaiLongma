import { getInstalledSoftwareBlock } from '../installed-software-scanner.js'
import { getDeviceInformationBlock } from '../device-information-scanner.js'
import { nowTimestamp } from '../time.js'

const providers = new Map()

const INSTALLED_SOFTWARE_PATTERNS = [
  /软件|应用|程序|客户端|已安装|装了什么|用了什么|浏览器|启动程序/i,
  /代理|科学上网|翻墙|clash|mihomo|v2ray|xray|sing-?box|shadowrocket/i,
  /shadowsocks|wireguard|tailscale|zerotier|openvpn|\bvpn\b|\bproxy\b/i,
  /installed\s+(?:software|apps?)|application\s+list/i,
]

const DEVICE_INFORMATION_PATTERNS = [
  /(?:鼠标|键盘|耳机|麦克风|话筒|触控板|外设|设备).{0,16}(?:电量|电池|连接|蓝牙|有线|usb|状态)/i,
  /(?:电量|电池|连接|蓝牙|有线|usb|状态).{0,16}(?:鼠标|键盘|耳机|麦克风|话筒|触控板|外设|设备)/i,
  /(?:关注|留意|监控|盯着|提醒).{0,24}(?:鼠标|键盘|耳机|麦克风|外设|设备|电量|电池)/i,
  /(?:mouse|keyboard|headset|headphones?|microphone|peripheral|device).{0,24}(?:battery|power|connected|status|bluetooth|usb)/i,
  /(?:monitor|watch|notify|alert).{0,24}(?:mouse|keyboard|headset|headphones?|microphone|peripheral|device|battery)/i,
]

function normalizeProvider(provider = {}) {
  const id = String(provider.id || '').trim()
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(id)) {
    throw new Error('information provider id must be 2-64 lowercase letters, digits, dot, underscore, or hyphen')
  }
  if (typeof provider.collect !== 'function') {
    throw new Error(`information provider "${id}" must define collect(context)`)
  }
  const defaultMode = ['default', 'on_demand', 'disabled'].includes(provider.defaultMode)
    ? provider.defaultMode
    : 'disabled'
  return Object.freeze({
    id,
    label: String(provider.label || id).trim(),
    description: String(provider.description || '').trim(),
    category: String(provider.category || 'general').trim(),
    sensitivity: String(provider.sensitivity || 'normal').trim(),
    defaultMode,
    timeoutMs: Math.max(50, Math.min(15_000, Number(provider.timeoutMs) || 2_000)),
    maxChars: Math.max(256, Math.min(50_000, Number(provider.maxChars) || 12_000)),
    matches: typeof provider.matches === 'function' ? provider.matches : () => false,
    collect: provider.collect,
  })
}

export function registerInformationProvider(provider) {
  const normalized = normalizeProvider(provider)
  if (providers.has(normalized.id)) {
    throw new Error(`information provider "${normalized.id}" is already registered`)
  }
  providers.set(normalized.id, normalized)
  return normalized
}

export function getInformationProvider(id = '') {
  return providers.get(String(id || '').trim()) || null
}

export function listInformationProviders() {
  return [...providers.values()].map(({ collect, matches, ...provider }) => ({ ...provider }))
}

export function informationProviderMatches(provider, context = {}, keywords = []) {
  const text = String(context.message || '')
  const customKeywords = Array.isArray(keywords)
    ? keywords.map(value => String(value || '').trim().toLowerCase()).filter(Boolean)
    : []
  if (customKeywords.length > 0) {
    const lower = text.toLowerCase()
    if (customKeywords.some(keyword => lower.includes(keyword))) return true
  }
  try {
    return provider.matches(context) === true
  } catch {
    return false
  }
}

export async function collectInformationProvider(provider, context = {}) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`provider timed out after ${provider.timeoutMs}ms`)), provider.timeoutMs)
  })
  try {
    const value = await Promise.race([Promise.resolve(provider.collect(context)), timeout])
    const text = typeof value === 'string' ? value.trim() : String(value?.contextText || '').trim()
    if (!text) return ''
    return text.slice(0, provider.maxChars)
  } finally {
    clearTimeout(timer)
  }
}

function formatSystemTime() {
  const now = new Date()
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'system-local'
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(now)
  return [
    '## Current System Time',
    `Local timestamp: ${nowTimestamp()}`,
    `Timezone: ${timeZone}`,
    `Weekday: ${weekday}`,
    'Treat this as the authoritative clock for this turn. Re-read it next turn; do not carry an older timestamp forward.',
  ].join('\n')
}

registerInformationProvider({
  id: 'system_time',
  label: 'System time',
  description: 'The current local timestamp, timezone, and weekday.',
  category: 'temporal',
  sensitivity: 'normal',
  defaultMode: 'default',
  timeoutMs: 250,
  maxChars: 1_000,
  collect: formatSystemTime,
})

registerInformationProvider({
  id: 'installed_software',
  label: 'Installed software',
  description: 'A bounded snapshot of applications installed on this computer.',
  category: 'local_environment',
  sensitivity: 'local_inventory',
  defaultMode: 'on_demand',
  timeoutMs: 500,
  maxChars: 14_000,
  matches: ({ message = '' } = {}) => INSTALLED_SOFTWARE_PATTERNS.some(pattern => pattern.test(String(message))),
  collect: () => getInstalledSoftwareBlock(),
})

registerInformationProvider({
  id: 'device_peripherals',
  label: 'Device and peripheral status',
  description: 'Current computer power plus connected wired/Bluetooth keyboards, mice, headsets, microphones, audio devices, and any battery levels exposed by the operating system.',
  category: 'device_environment',
  sensitivity: 'local_device_inventory',
  defaultMode: 'on_demand',
  timeoutMs: 8_000,
  maxChars: 14_000,
  matches: ({ message = '' } = {}) => DEVICE_INFORMATION_PATTERNS.some(pattern => pattern.test(String(message))),
  collect: () => getDeviceInformationBlock(),
})
