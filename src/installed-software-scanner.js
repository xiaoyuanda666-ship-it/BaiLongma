/**
 * installed-software-scanner.js
 *
 * Scans the user's installed applications once at startup and exposes a compact
 * context block when the current message needs software/app awareness.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import { paths } from './paths.js'

const CACHE_FILE = path.join(paths.dataDir, 'installed-software.json')
const CACHE_VERSION = 1
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const MAX_CONTEXT_APPS = 160

let _cached = null

const NETWORK_APP_PATTERNS = [
  /clash/i,
  /mihomo/i,
  /v2ray/i,
  /xray/i,
  /sing-?box/i,
  /shadowrocket/i,
  /shadowsocks/i,
  /wireguard/i,
  /tailscale/i,
  /zerotier/i,
  /openvpn/i,
  /\bvpn\b/i,
  /proxy/i,
  /nmap/i,
  /wireshark/i,
  /fiddler/i,
  /charles/i,
  /proxifier/i,
]

const SKIP_APP_NAMES = new Set([
  '回收站',
  'recycle bin',
  'desktop',
  'downloads',
  'documents',
  'pictures',
  'music',
  'videos',
])

function safe(fn, fallback = null) {
  try { return fn() } catch { return fallback }
}

function normalizeAppName(name = '') {
  return String(name || '')
    .replace(/\s+-\s+快捷方式$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function shouldSkipAppName(name, key = name.toLowerCase()) {
  if (SKIP_APP_NAMES.has(key)) return true
  if (/^(uninstall|readme|license|help)\b/i.test(name)) return true
  return /卸载|^帮助/.test(name)
}

function addApp(apps, rawName, source = 'unknown', extra = {}) {
  const name = normalizeAppName(rawName)
  if (!name) return
  const key = name.toLowerCase()
  if (shouldSkipAppName(name, key)) return
  const existing = apps.get(key)
  if (existing) {
    existing.sources = Array.from(new Set([...(existing.sources || []), source]))
    if (!existing.version && extra.version) existing.version = extra.version
    if (!existing.publisher && extra.publisher) existing.publisher = extra.publisher
    return
  }
  apps.set(key, {
    name,
    version: extra.version || '',
    publisher: extra.publisher || '',
    path: extra.path || '',
    sources: [source],
  })
}

function parseJsonArray(raw) {
  const parsed = safe(() => JSON.parse(raw), [])
  if (!parsed) return []
  return Array.isArray(parsed) ? parsed : [parsed]
}

function scanWindowsRegistry(apps) {
  const script = [
    "$paths=@(",
    "'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    ");",
    "Get-ItemProperty $paths -ErrorAction SilentlyContinue |",
    "Where-Object { $_.DisplayName -and -not $_.SystemComponent } |",
    "Select-Object DisplayName,DisplayVersion,Publisher |",
    "ConvertTo-Json -Compress",
  ].join(' ')

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024 * 6 }
  )
  if (result.status !== 0 || !result.stdout?.trim()) return

  for (const item of parseJsonArray(result.stdout.trim())) {
    addApp(apps, item.DisplayName, 'registry', {
      version: item.DisplayVersion,
      publisher: item.Publisher,
    })
  }
}

function walkFiles(root, visit, depth = 0) {
  if (!root || depth > 6 || !fs.existsSync(root)) return
  const entries = safe(() => fs.readdirSync(root, { withFileTypes: true }), [])
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      visit(fullPath, entry.name)
      walkFiles(fullPath, visit, depth + 1)
    } else if (entry.isFile()) {
      visit(fullPath, entry.name)
    }
  }
}

function scanWindowsStartMenu(apps) {
  const roots = [
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
  ].filter(Boolean)

  for (const root of roots) {
    walkFiles(root, (_fullPath, fileName) => {
      if (!fileName.toLowerCase().endsWith('.lnk')) return
      addApp(apps, path.basename(fileName, path.extname(fileName)), 'start_menu')
    })
  }
}

function scanMacApplications(apps) {
  for (const root of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    walkFiles(root, (fullPath, fileName) => {
      if (!fullPath.endsWith('.app') && !fileName.endsWith('.app')) return
      addApp(apps, path.basename(fileName, '.app'), 'applications', { path: fullPath })
    }, 1)
  }
}

function scanLinuxDesktopEntries(apps) {
  const roots = [
    '/usr/share/applications',
    '/usr/local/share/applications',
    path.join(os.homedir(), '.local', 'share', 'applications'),
  ]
  for (const root of roots) {
    walkFiles(root, (fullPath, fileName) => {
      if (!fileName.endsWith('.desktop')) return
      const content = safe(() => fs.readFileSync(fullPath, 'utf8'), '')
      const name = content.match(/^Name=(.+)$/m)?.[1] || path.basename(fileName, '.desktop')
      addApp(apps, name, 'desktop_entry')
    }, 2)
  }
}

function readFreshCache() {
  const stat = safe(() => fs.statSync(CACHE_FILE), null)
  if (!stat || Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null
  const cached = safe(() => JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')), null)
  if (cached?.version !== CACHE_VERSION || !Array.isArray(cached.apps)) return null
  return cached
}

function sortApps(apps = []) {
  return apps.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

export function collectInstalledSoftware({ force = false } = {}) {
  const cached = force ? null : readFreshCache()
  if (cached) {
    _cached = cached
    console.log('[installed-software] cache hit:', cached.apps.length, 'apps')
    return cached
  }

  const apps = new Map()
  if (IS_WIN) {
    scanWindowsRegistry(apps)
    scanWindowsStartMenu(apps)
  } else if (IS_MAC) {
    scanMacApplications(apps)
  } else {
    scanLinuxDesktopEntries(apps)
  }

  const result = {
    version: CACHE_VERSION,
    platform: process.platform,
    scanned_at: new Date().toISOString(),
    apps: sortApps([...apps.values()]),
  }

  safe(() => fs.writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2), 'utf8'))
  _cached = result
  console.log('[installed-software] scanned:', result.apps.length, 'apps')
  return result
}

export function __setInstalledSoftwareForTest(apps = []) {
  _cached = {
    version: CACHE_VERSION,
    platform: process.platform,
    scanned_at: new Date().toISOString(),
    apps: sortApps(apps.map(app => ({
      name: normalizeAppName(app.name || app),
      version: app.version || '',
      publisher: app.publisher || '',
      path: app.path || '',
      sources: app.sources || ['test'],
    })).filter(app => app.name && !shouldSkipAppName(app.name))),
  }
}

export function getInstalledSoftwareSnapshot() {
  if (!_cached) return { apps: [], platform: process.platform, scanned_at: null }
  return {
    platform: _cached.platform || process.platform,
    scanned_at: _cached.scanned_at || null,
    apps: Array.isArray(_cached.apps) ? _cached.apps.slice() : [],
  }
}

function normalizeLookupText(value = '') {
  return normalizeAppName(value)
    .replace(/\.app$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase()
}

export function findInstalledSoftware(query = '') {
  const needle = normalizeLookupText(query)
  if (!needle) return null
  const apps = Array.isArray(_cached?.apps) ? _cached.apps : []
  for (const app of apps) {
    const name = normalizeLookupText(app.name)
    if (name && (name === needle || name.includes(needle) || needle.includes(name))) {
      return { ...app, matched_by: 'installed_software_snapshot' }
    }
  }
  return null
}

function isNetworkApp(app) {
  return NETWORK_APP_PATTERNS.some(pattern => pattern.test(app.name))
}

function formatApp(app) {
  const parts = [app.name]
  if (app.version) parts.push(`v${app.version}`)
  if (app.publisher) parts.push(`(${app.publisher})`)
  return parts.join(' ')
}

export function getInstalledSoftwareBlock() {
  if (!_cached) return ''
  const apps = Array.isArray(_cached.apps) ? _cached.apps : []
  if (apps.length === 0) return ''

  const networkApps = apps.filter(isNetworkApp)
  const networkNames = networkApps.map(formatApp)
  const remaining = apps
    .filter(app => !isNetworkApp(app))
    .slice(0, Math.max(0, MAX_CONTEXT_APPS - networkApps.length))
    .map(formatApp)

  const lines = [
    '## Installed Software Snapshot',
    `(Scanned from local application registries/menus at startup; ${apps.length} apps found. Use this to infer which local client/app may explain the user's issue. Do not claim an app is installed unless it appears here.)`,
  ]

  if (networkNames.length > 0) {
    lines.push(`Network / proxy / VPN candidates (${networkNames.length}): ${networkNames.join(', ')}`)
  }

  const shown = [...networkNames, ...remaining]
  if (shown.length > 0) {
    const more = apps.length > shown.length ? ` ... (${apps.length - shown.length} more not shown)` : ''
    lines.push(`Installed apps shown (${shown.length}): ${shown.join(', ')}${more}`)
  }

  return lines.join('\n')
}
