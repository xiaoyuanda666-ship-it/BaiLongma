import { execFileSync } from 'child_process'
import { getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from 'undici'

const LOCAL_NO_PROXY = 'localhost,127.0.0.1,::1'
const DEBUG_NETWORK_PROXY = process.env.JARVIS_DEBUG_NETWORK === '1'

let configured = false
let status = {
  enabled: false,
  source: 'none',
  proxyURL: '',
  error: '',
}

function hasEnvProxy() {
  return !!(
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  )
}

function getEnvProxy() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ''
  )
}

function ensureLocalNoProxy() {
  const existing = process.env.NO_PROXY || process.env.no_proxy || ''
  if (!existing) {
    process.env.NO_PROXY = LOCAL_NO_PROXY
    return
  }
  const lower = existing.toLowerCase()
  const missing = LOCAL_NO_PROXY
    .split(',')
    .filter(item => !lower.split(',').map(x => x.trim()).includes(item.toLowerCase()))
  if (missing.length) process.env.NO_PROXY = `${existing},${missing.join(',')}`
}

function getNoProxyRules() {
  return String(process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean)
}

function splitNoProxyRule(rule) {
  if (rule.startsWith('[')) {
    const end = rule.indexOf(']')
    if (end > 0) {
      const host = rule.slice(1, end)
      const rest = rule.slice(end + 1)
      return [host, rest.startsWith(':') ? rest.slice(1) : '']
    }
  }
  const colonCount = (rule.match(/:/g) || []).length
  if (colonCount === 1) return rule.split(':')
  return [rule, '']
}

function shouldBypassProxy(origin) {
  let url
  try {
    url = origin instanceof URL ? origin : new URL(String(origin))
  } catch {
    return false
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')

  for (const rule of getNoProxyRules()) {
    if (rule === '*') return true
    const [ruleHost, rulePort] = splitNoProxyRule(rule)
    if (rulePort && rulePort !== port) continue
    if (ruleHost === hostname) return true
    if (ruleHost.startsWith('.') && hostname.endsWith(ruleHost)) return true
  }
  return false
}

class ProxyBypassDispatcher {
  constructor(proxyURL) {
    this.direct = getGlobalDispatcher()
    this.proxy = new ProxyAgent(proxyURL)
  }

  dispatch(options, handler) {
    if (shouldBypassProxy(options?.origin)) return this.direct.dispatch(options, handler)
    return this.proxy.dispatch(options, handler)
  }

  close(callback) {
    return this.proxy.close(callback)
  }

  destroy(error, callback) {
    return this.proxy.destroy(error, callback)
  }
}

function readWinRegValue(name) {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  const output = execFileSync('reg', ['query', key, '/v', name], {
    encoding: 'utf8',
    timeout: 2000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const line = output.split(/\r?\n/).find(item => item.includes(name))
  if (!line) return ''
  const parts = line.trim().split(/\s{2,}/)
  return parts.slice(2).join(' ').trim()
}

function parseWindowsProxyServer(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''

  let candidate = value
  if (value.includes('=')) {
    const entries = new Map()
    for (const part of value.split(';')) {
      const [rawKey, ...rawVal] = part.split('=')
      const key = String(rawKey || '').trim().toLowerCase()
      const val = rawVal.join('=').trim()
      if (key && val) entries.set(key, val)
    }
    candidate = entries.get('https') || entries.get('http') || entries.get('all') || ''
  }

  if (!candidate || /^socks/i.test(candidate)) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `http://${candidate}`

  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.toString()
  } catch {
    return ''
  }
}

function getWindowsSystemProxy() {
  if (process.platform !== 'win32') return ''
  try {
    const enabled = readWinRegValue('ProxyEnable')
    if (!/^(?:1|0x0*1)$/i.test(enabled)) return ''
    return parseWindowsProxyServer(readWinRegValue('ProxyServer'))
  } catch {
    return ''
  }
}

export function configureGlobalProxy() {
  if (configured) return status
  configured = true

  try {
    let source = 'env'
    let proxyURL = parseWindowsProxyServer(getEnvProxy())

    if (!proxyURL) {
      proxyURL = getWindowsSystemProxy()
      if (proxyURL) {
        process.env.HTTPS_PROXY = proxyURL
        process.env.HTTP_PROXY = proxyURL
        source = hasEnvProxy() ? 'windows-fallback' : 'windows'
      }
    }

    if (!proxyURL) return status

    ensureLocalNoProxy()
    setGlobalDispatcher(new ProxyBypassDispatcher(proxyURL))
    status = { enabled: true, source, proxyURL, error: '' }
    if (DEBUG_NETWORK_PROXY) console.log(`[network] using ${source} proxy ${proxyURL}`)
    return status
  } catch (err) {
    status = { enabled: false, source: 'error', proxyURL: '', error: err?.message || String(err) }
    console.warn('[network] proxy setup failed:', status.error)
    return status
  }
}

export function getGlobalProxyStatus() {
  return status
}

configureGlobalProxy()
