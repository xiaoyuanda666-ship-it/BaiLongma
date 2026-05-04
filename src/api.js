import http from 'http'
import fs from 'fs'
import path from 'path'
import net from 'net'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import { pushMessage } from './queue.js'
import { getDB, getConfig, setConfig, insertUISignal, upsertMediaHistory, getMediaHistory } from './db.js'
import { emitEvent, addSSEClient, removeSSEClient, addACUIClient, removeACUIClient, removeActiveUICard } from './events.js'
import { getQuotaStatus } from './quota.js'
import { isRunning, stopLoop, startLoop } from './control.js'
import { buildHeartbeatSystemPromptPreview } from './system-prompt-preview.js'
import { paths } from './paths.js'
import { config, activate as activateLLM, getActivationStatus, switchModel, setTemperature, getMinimaxKey, setMinimaxKey, getSocialConfig, setSocialConfig, getVoiceConfig, setVoiceConfig, getTTSConfig, setTTSConfig, getTTSCredentials, DEEPSEEK_MODELS, MINIMAX_MODELS } from './config.js'
import { streamTTS, TTS_PROVIDERS, TTS_VOICES } from './voice/tts-providers.js'
import { restartConnector } from './social/index.js'
import { replaceProvider } from './providers/registry.js'
import { persistAppState } from './capabilities/executor.js'
import { MinimaxProvider } from './providers/minimax.js'
import { handleSocialWebhook, isSocialWebhookPath } from './social/webhooks.js'
import { getClawbotQR, logoutClawbot } from './social/wechat-clawbot.js'
import { startVoiceServer, stopVoiceServer, getVoiceStatus, restartVoiceServer } from './voice/manager.js'
import { createCloudASRSession } from './voice/cloud-asr.js'

export { emitEvent }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INDEX_PATH         = paths.indexHtml
const DASHBOARD_PATH     = paths.dashboardHtml
const BRAIN_PATH         = paths.brainHtml
const BRAIN_UI_PATH      = paths.brainUiHtml
const WEBSITE_PATH       = paths.websiteHtml
const SYSTEM_PROMPT_PATH = paths.systemPromptHtml
const ACTIVATION_PATH    = paths.activationHtml
const BRAIN_UI_ASSET_ROOT = paths.brainUiAssetRoot
const D3_VENDOR_PATH     = path.join(paths.resourcesDir, 'node_modules', 'd3', 'dist', 'd3.min.js')
const SANDBOX_PATH       = paths.sandboxDir
const DEFAULT_AGENT_NAME = 'Longma'
const DEFAULT_API_HOST = '127.0.0.1'

function getApiHost() {
  return String(globalThis.process?.env?.BAILONGMA_HOST || DEFAULT_API_HOST).trim() || DEFAULT_API_HOST
}

function isLanAccessEnabled() {
  return /^(1|true|yes|on)$/i.test(String(globalThis.process?.env?.BAILONGMA_ALLOW_LAN || '').trim())
}

function normalizeRemoteAddress(address = '') {
  const value = String(address || '').trim().toLowerCase()
  if (value.startsWith('::ffff:')) return value.slice('::ffff:'.length)
  return value
}

function isLoopbackAddress(address = '') {
  const value = normalizeRemoteAddress(address)
  return value === '127.0.0.1'
    || value === '::1'
    || value === 'localhost'
}

function isLoopbackRequest(req) {
  return isLoopbackAddress(req.socket?.remoteAddress)
}

function isPrivateLanAddress(address = '') {
  const value = normalizeRemoteAddress(address)
  if (!value) return false

  if (net.isIP(value) === 4) {
    const [a, b] = value.split('.').map(part => Number(part))
    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
  }

  if (net.isIP(value) === 6) {
    return value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')
  }

  return false
}

function isLanRequest(req) {
  return isLanAccessEnabled() && isPrivateLanAddress(req.socket?.remoteAddress)
}

function isLoopbackOrigin(origin = '') {
  if (!origin || origin === 'null') return true
  try {
    const parsed = new URL(origin)
    return ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
  } catch {
    return false
  }
}

function isAllowedOrigin(origin = '') {
  if (isLoopbackOrigin(origin)) return true
  if (!isLanAccessEnabled()) return false
  try {
    const parsed = new URL(origin)
    return isPrivateLanAddress(parsed.hostname)
  } catch {
    return false
  }
}

function getAuthToken() {
  return String(globalThis.process?.env?.BAILONGMA_API_TOKEN || '').trim()
}

function hasValidAuthToken(req, url) {
  const expected = getAuthToken()
  if (!expected) return false
  const header = req.headers.authorization || ''
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  const queryToken = url.searchParams.get('token')
  return bearer === expected || queryToken === expected
}

function requireLocalOrToken(req, res, url) {
  if (hasAllowedAccess(req, url)) return true
  jsonResponse(res, 403, { ok: false, error: 'forbidden' })
  return false
}

function hasAllowedAccess(req, url) {
  return isLoopbackRequest(req) || hasValidAuthToken(req, url) || isLanRequest(req)
}

function isSensitivePath(pathname) {
  return pathname === '/activate'
    || pathname === '/settings'
    || pathname.startsWith('/settings/')
    || pathname.startsWith('/admin/')
    || pathname.startsWith('/memories/')
}

function isPathInside(parentDir, candidatePath) {
  const parent = path.resolve(parentDir)
  const candidate = path.resolve(candidatePath)
  const relative = path.relative(parent, candidate)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'text/plain; charset=utf-8'
  }
}

function getAgentName() {
  return (getConfig('agent_name') || '').trim() || DEFAULT_AGENT_NAME
}

function stripAssistantHistoryLabels(content) {
  return String(content || '')
    .trim()
    .replace(/^(?:\s*\[assistant(?:\s+to\s+[^\]\r\n]+)?(?:\s+\d{4}-\d{2}-\d{2}T[^\]\r\n]+)?\]\s*)+/giu, '')
    .trim()
}

function extractAgentRename(content) {
  const text = String(content || '').trim()
  if (!text) return null

  const questionPatterns = [
    /你叫什么(?:名字)?[？?]?\s*$/i,
    /你叫啥[？?]?\s*$/i,
    /你叫\.{0,3}什么[？?]?\s*$/i,
    /请问你叫什么(?:名字)?[？?]?\s*$/i,
    /what(?:'s| is)\s+your\s+name\??\s*$/i,
    /who\s+are\s+you\??\s*$/i,
  ]
  if (questionPatterns.some((pattern) => pattern.test(text))) return null

  const hasQuestionTone =
    /[？?]/.test(text) ||
    /(^|[，,。.!！\s])(什么|啥|几|吗|么|哪一个|哪个|是不是)($|[，,。.!！\s])/.test(text)
  const renameVerbHit =
    /(改成|改为|换成|换做|叫做|叫|自称|称呼你|管你叫|call you|rename you|name is now)/i.test(text)
  if (hasQuestionTone && !/(从.+起|以后|之后|现在起|改成|改为|换成|换做|rename|name is now)/i.test(text)) {
    return null
  }

  const intentPatterns = [
    /叫你/i,
    /你.*叫/i,
    /改名/i,
    /改个?名字/i,
    /换个?名字/i,
    /名字.*改/i,
    /name\s+is\s+now/i,
    /call\s+you/i,
    /rename\s+you/i,
    /自称/i,
    /对外.*叫/i,
    /别叫/i,
    /不要叫/i,
    /换个称呼/i,
    /给你.*起个?名字/i,
    /给你.*换个?名字/i,
  ]
  if (!intentPatterns.some((pattern) => pattern.test(text))) return null
  if (/^你.*叫/i.test(text) && !renameVerbHit && hasQuestionTone) return null

  const normalizeName = (raw) => {
    const cleaned = String(raw || "")
      .trim()
      .replace(/^[“"'`「『【（(]+/, "")
      .replace(/[”"'`」』】）),。.!！？；;：:\s]+$/g, "")
      .replace(/\s+/g, " ")

    if (!cleaned) return null
    if (cleaned.length > 32) return null
    if (/^(你|我|我们|以后|之后|现在|一下|一个|这个|那个|名字|名称|称呼)$/i.test(cleaned)) return null
    if (!/^[\u4e00-\u9fa5A-Za-z0-9 _-]+$/.test(cleaned)) return null
    return cleaned
  }

  const rejectName = (name) => {
    const lowered = String(name || '').toLowerCase()
    return (
      /^(一下|一个|这个|那个|以后|现在|名字|名称|称呼|自己|原来|之前|刚才|以后吧)$/.test(name) ||
      /^(name|called|call|rename|my|your|you|me|it)$/.test(lowered)
    )
  }

  const tryName = (raw) => {
    const normalized = normalizeName(raw)
    if (!normalized || rejectName(normalized)) return null
    return normalized
  }

  const capturePatterns = [
    /(?:以后|之后|从现在起|从今以后)?(?:你|你以后|以后你)(?:就|还是|直接)?叫(?:做)?\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:把你|给你|帮你)(?:的名字|名字)?(?:改成|改为|换成|换做)\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:以后)?(?:我|我们)(?:就)?叫你\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:你的名字|你名字)(?:是|叫|改成|改为)\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:以后|之后|从现在起)?(?:称呼你|管你叫)\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:以后|之后)?(?:你)?(?:对外|今后)?(?:就)?自称\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:以后|之后)?(?:别|不要)(?:再)?叫(?:自己)?\s*[“"'`「『【（(]?\s*[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31}[”"'`」』】）)]?\s*(?:了)?[，,。.!！？；;\s]*(?:以后|现在|之后)?(?:就)?叫(?:自己|你)?\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:我想|我想要|我准备|我要)?(?:给你|帮你)(?:重新|再)?(?:起|取|换)(?:个)?名字(?:叫|是|为)?\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:把|将)(?:你的名字|你)(?:从)?\s*[“"'`「『【（(]?\s*[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31}[”"'`」』】）)]?\s*(?:改|换)(?:成|为)\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:以后|之后|从现在起)?(?:对外)?(?:你|你自己)?(?:就)?叫\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /your name is now\s+[“"'`(]?\s*([A-Za-z][A-Za-z0-9 _-]{0,31})/i,
    /i(?:'ll| will)? call you\s+[“"'`(]?\s*([A-Za-z][A-Za-z0-9 _-]{0,31})/i,
    /rename you to\s+[“"'`(]?\s*([A-Za-z][A-Za-z0-9 _-]{0,31})/i,
    /don't call yourself\s+[“"'`]?[A-Za-z][A-Za-z0-9 _-]{0,31}[”"'`]?\s*(?:anymore)?[, ]*(?:call yourself|be)\s+[“"'`]?\s*([A-Za-z][A-Za-z0-9 _-]{0,31})/i,
  ]

  for (const pattern of capturePatterns) {
    const match = text.match(pattern)
    if (!match) continue
    const nextName = tryName(match[1])
    if (nextName) return nextName
  }

  const colonMatch = text.match(/(?:名字|名称|称呼)[是为:：]\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i)
  if (colonMatch) {
    const nextName = tryName(colonMatch[1])
    if (nextName) return nextName
  }

  const quotedNames = [...text.matchAll(/[“"'`「『【（(]\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})\s*[”"'`」』】）)]/g)]
    .map((match) => tryName(match[1]))
    .filter(Boolean)
  if (quotedNames.length === 1) return quotedNames[0]

  const semanticWindows = [
    /(?:改名|换名字|换个名字|换个称呼|起个名字|取个名字|自称|对外叫)\s*(?:叫|成|为|是)?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:以后|之后|从现在起).{0,12}?(?:叫|自称|称呼).{0,4}?([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
  ]
  for (const pattern of semanticWindows) {
    const match = text.match(pattern)
    if (!match) continue
    const nextName = tryName(match[1])
    if (nextName) return nextName
  }

  return null
}

export function startAPI(port = 3721, { getStateSnapshot = null, onActivated = null } = {}) {
  const onActivatedCallback = onActivated
  const host = getApiHost()
  const server = http.createServer((req, res) => {
    const base = `http://localhost:${port}`
    const url = new URL(req.url, base)
    const origin = req.headers.origin

    // GET /social/wechat-clawbot/qr — 获取当前二维码状态和 URL
    if (req.method === 'GET' && url.pathname === '/social/wechat-clawbot/qr') {
      if (!hasAllowedAccess(req, url)) return jsonResponse(res, 403, { ok: false, error: 'forbidden' })
      return jsonResponse(res, 200, { ok: true, ...getClawbotQR() })
    }

    // POST /social/wechat-clawbot/logout — 清除凭证并断开连接
    if (req.method === 'POST' && url.pathname === '/social/wechat-clawbot/logout') {
      if (!requireLocalOrToken(req, res, url)) return
      logoutClawbot()
      emitEvent('social_status', { platform: 'wechat-clawbot', status: 'idle' })
      return jsonResponse(res, 200, { ok: true })
    }

    if (isSocialWebhookPath(url.pathname)) {
      return handleSocialWebhook(req, res, url)
    }

    if (origin && !isAllowedOrigin(origin)) {
      return jsonResponse(res, 403, { ok: false, error: 'forbidden origin' })
    }

    if (!hasAllowedAccess(req, url)) {
      return jsonResponse(res, 403, { ok: false, error: 'forbidden' })
    }

    if (isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin || 'null')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method !== 'OPTIONS' && isSensitivePath(url.pathname) && !requireLocalOrToken(req, res, url)) return

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // POST /message — 发消息给意识体
    if (req.method === 'POST' && url.pathname === '/message') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8')
          const { from_id = 'ID:000001', content, channel = 'API' } = JSON.parse(body)
          if (!content?.trim()) return jsonResponse(res, 400, { error: 'content required' })
          const trimmed = content.trim()
          const renamedTo = extractAgentRename(trimmed)
          if (renamedTo) {
            setConfig('agent_name', renamedTo)
            emitEvent('agent_name_updated', { name: renamedTo })
          }
          pushMessage(from_id, trimmed, channel)
          emitEvent('message_in', { from_id, content: trimmed, channel, timestamp: new Date().toISOString() })
          jsonResponse(res, 200, { ok: true, agent_name: getAgentName() })
        } catch (e) {
          jsonResponse(res, 400, { error: e.message })
        }
      })
      return
    }

    // GET /events — SSE 实时事件流（双向通讯的出口）
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(`data: ${JSON.stringify({ type: 'connected', ts: new Date().toISOString() })}\n\n`)
      addSSEClient(res)
      const keepAlive = setInterval(() => {
        try { res.write(': ping\n\n') } catch (_) { clearInterval(keepAlive); removeSSEClient(res) }
      }, 15000)
      req.on('close', () => {
        clearInterval(keepAlive)
        removeSSEClient(res)
      })
      return
    }

    // GET /memories?limit=20&search=keyword
    if (req.method === 'GET' && url.pathname === '/memories') {
      const db = getDB()
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100)
      const search = url.searchParams.get('search')
      let rows
      if (search) {
        try {
          rows = db.prepare(`
            SELECT m.* FROM memories m
            JOIN memories_fts ON memories_fts.rowid = m.id
            WHERE memories_fts MATCH ?
            ORDER BY bm25(memories_fts), m.created_at DESC LIMIT ?
          `).all(search, limit)
        } catch {
          rows = db.prepare(`SELECT * FROM memories WHERE content LIKE ? OR detail LIKE ? ORDER BY created_at DESC LIMIT ?`)
            .all(`%${search}%`, `%${search}%`, limit)
        }
      } else {
        rows = db.prepare('SELECT * FROM memories ORDER BY created_at DESC LIMIT ?').all(limit)
      }
      jsonResponse(res, 200, rows)
      return
    }

    // GET /conversations?limit=60 — 聊天记录（按时间升序，最新的在最后）
    if (req.method === 'GET' && url.pathname === '/conversations') {
      const db = getDB()
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '60'), 500)
      const rows = db.prepare(`
        SELECT id, role, from_id, to_id, content, timestamp
        FROM conversations
        ORDER BY id DESC
        LIMIT ?
      `).all(limit)
      jsonResponse(res, 200, rows.reverse().map(row => (
        row.role === 'jarvis'
          ? { ...row, content: stripAssistantHistoryLabels(row.content) }
          : row
      )))
      return
    }

    // GET /status
    if (req.method === 'GET' && url.pathname === '/status') {
      const db = getDB()
      const { n } = db.prepare('SELECT COUNT(*) as n FROM memories').get()
      jsonResponse(res, 200, { ok: true, memory_count: n, running: isRunning() })
      return
    }

    // GET /quota
    if (req.method === 'GET' && url.pathname === '/quota') {
      jsonResponse(res, 200, getQuotaStatus())
      return
    }

    if (req.method === 'GET' && url.pathname === '/system-prompt-preview') {
      Promise.resolve()
        .then(() => buildHeartbeatSystemPromptPreview({
          stateSnapshot: typeof getStateSnapshot === 'function' ? getStateSnapshot() : {},
        }))
        .then((preview) => jsonResponse(res, 200, preview))
        .catch((err) => jsonResponse(res, 500, { error: err.message }))
      return
    }

    if (req.method === 'GET' && url.pathname === '/agent-profile') {
      jsonResponse(res, 200, { name: getAgentName() })
      return
    }

    // GET /media/history?limit=30
    if (req.method === 'GET' && url.pathname === '/media/history') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '30'), 100)
      jsonResponse(res, 200, getMediaHistory(limit))
      return
    }

    // POST /media/history — { kind, url, title, videoId, platform }
    if (req.method === 'POST' && url.pathname === '/media/history') {
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString())
          if (!body.url || !body.kind) return jsonResponse(res, 400, { ok: false, error: 'url and kind required' })
          upsertMediaHistory(body)
          jsonResponse(res, 200, { ok: true })
        } catch (e) {
          jsonResponse(res, 400, { ok: false, error: e.message })
        }
      })
      return
    }

    // GET /favicon.ico ? silence the browser's automatic favicon request
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }

    // DELETE /memories/:id — 删除记忆
    if (req.method === 'DELETE' && url.pathname.startsWith('/memories/')) {
      const id = parseInt(url.pathname.split('/')[2])
      if (!id) return jsonResponse(res, 400, { error: 'invalid id' })
      const db = getDB()
      db.prepare('DELETE FROM memories WHERE id = ?').run(id)
      jsonResponse(res, 200, { ok: true })
      return
    }

    // PATCH /memories/:id — 修改记忆 content/detail
    if (req.method === 'PATCH' && url.pathname.startsWith('/memories/')) {
      const id = parseInt(url.pathname.split('/')[2])
      if (!id) return jsonResponse(res, 400, { error: 'invalid id' })
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const { content, detail } = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
          const db = getDB()
          if (content !== undefined) db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(content, id)
          if (detail !== undefined) db.prepare('UPDATE memories SET detail = ? WHERE id = ?').run(detail, id)
          jsonResponse(res, 200, { ok: true })
        } catch (e) {
          jsonResponse(res, 400, { error: e.message })
        }
      })
      return
    }

    // GET /media/music/:filename — 提供 musicDir 音频文件（避免 file:// 跨源限制）
    if (req.method === 'GET' && url.pathname.startsWith('/media/music/')) {
      const raw = url.pathname.slice('/media/music/'.length)
      const filename = path.basename(decodeURIComponent(raw))
      const filePath = path.join(paths.musicDir, filename)
      const resolvedFile = path.resolve(filePath)
      const resolvedDir  = path.resolve(paths.musicDir)
      if (!resolvedFile.startsWith(resolvedDir + path.sep) && resolvedFile !== resolvedDir) {
        res.writeHead(403); res.end('forbidden'); return
      }
      const mimeMap = {
        '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav',
        '.aac': 'audio/aac',  '.ogg': 'audio/ogg',   '.m4a': 'audio/mp4',
        '.opus': 'audio/ogg; codecs=opus',
      }
      const contentType = mimeMap[path.extname(filename).toLowerCase()] || 'audio/mpeg'
      try {
        const stat = fs.statSync(filePath)
        const total = stat.size
        const rangeHeader = req.headers.range
        if (rangeHeader) {
          const m = rangeHeader.match(/bytes=(\d*)-(\d*)/)
          const start = m[1] ? parseInt(m[1]) : 0
          const end   = m[2] ? parseInt(m[2]) : total - 1
          res.writeHead(206, {
            'Content-Type': contentType,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Cache-Control': 'no-cache',
          })
          fs.createReadStream(filePath, { start, end }).pipe(res)
        } else {
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': total,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
          })
          fs.createReadStream(filePath).pipe(res)
        }
      } catch {
        res.writeHead(404); res.end('music file not found')
      }
      return
    }

    // GET /audio/:filename — 提供 sandbox 音频文件
    if (req.method === 'GET' && url.pathname.startsWith('/audio/')) {
      const filename = path.basename(url.pathname)
      const filePath = path.join(SANDBOX_PATH, 'audio', filename)
      try {
        const stat = fs.statSync(filePath)
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache',
        })
        fs.createReadStream(filePath).pipe(res)
      } catch {
        res.writeHead(404)
        res.end('audio not found')
      }
      return
    }

    // GET /activation-status — 查询是否已经激活
    if (req.method === 'GET' && url.pathname === '/activation-status') {
      jsonResponse(res, 200, getActivationStatus())
      return
    }

    // POST /activate — 填入 API Key 完成激活
    if (req.method === 'POST' && url.pathname === '/activate') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', async () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8')
          const { apiKey, model, provider } = JSON.parse(body || '{}')
          const info = await activateLLM({ provider, apiKey, model })
          emitEvent('activated', info)
          // 通知 index.js 启动主循环
          if (typeof onActivatedCallback === 'function') {
            try { onActivatedCallback() } catch (err) { console.error('[API] onActivated 回调出错:', err) }
          }
          jsonResponse(res, 200, { ok: true, ...info })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // GET /settings — 返回当前 LLM + MiniMax 配置状态
    if (req.method === 'GET' && url.pathname === '/settings') {
      const status = getActivationStatus()
      const minimaxKey = getMinimaxKey()
      jsonResponse(res, 200, {
        llm: {
          activated: status.activated,
          provider: status.provider,
          model: status.model,
          models: status.models,
          temperature: config.temperature,
        },
        providers: {
          deepseek: { models: DEEPSEEK_MODELS },
          minimax: { models: MINIMAX_MODELS },
        },
        minimax: {
          configured: !!(globalThis.process?.env?.MINIMAX_API_KEY || minimaxKey),
        },
      })
      return
    }

    // POST /settings/model — 仅切换模型（不需重新输入 Key）
    if (req.method === 'POST' && url.pathname === '/settings/model') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const { model } = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          const result = switchModel(model)
          emitEvent('model_switched', result)
          jsonResponse(res, 200, { ok: true, ...result })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // POST /settings/temperature — 设置 LLM temperature
    if (req.method === 'POST' && url.pathname === '/settings/temperature') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const { temperature } = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          const result = setTemperature(temperature)
          jsonResponse(res, 200, { ok: true, ...result })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // GET /settings/social — 读取各平台配置状态（不返回明文 key）
    if (req.method === 'GET' && url.pathname === '/settings/social') {
      jsonResponse(res, 200, { ok: true, social: getSocialConfig() })
      return
    }

    // POST /settings/social — 保存平台凭证，并热重启受影响的连接器
    if (req.method === 'POST' && url.pathname === '/settings/social') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', async () => {
        try {
          const updates = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          setSocialConfig(updates)
          // 哪些平台的 key 被更新了，就重启对应连接器
          const PLATFORM_KEYS = {
            discord: ['DISCORD_BOT_TOKEN'],
          }
          for (const [platform, keys] of Object.entries(PLATFORM_KEYS)) {
            if (keys.some(k => updates[k])) {
              restartConnector(platform, { pushMessage, emitEvent }).catch(err =>
                console.warn(`[social] restart ${platform} failed:`, err.message)
              )
            }
          }
          // 用户点击「连接微信」时触发 ClawBot 连接器重启
          if (updates._clawbot_connect) {
            restartConnector('wechat-clawbot', { pushMessage, emitEvent }).catch(err =>
              console.warn('[social] restart wechat-clawbot failed:', err.message)
            )
          }
          jsonResponse(res, 200, { ok: true, social: getSocialConfig() })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // POST /settings/minimax — 设置 MiniMax API Key
    if (req.method === 'POST' && url.pathname === '/settings/minimax') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const { apiKey } = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          const trimmed = String(apiKey || '').trim()
          if (!trimmed) throw new Error('API Key 不能为空')
          setMinimaxKey(trimmed)
          replaceProvider(new MinimaxProvider({ apiKey: trimmed }))
          jsonResponse(res, 200, { ok: true, configured: true })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // GET /activation — 激活引导页
    if (req.method === 'GET' && (url.pathname === '/activation' || url.pathname === '/activation.html')) {
      try {
        const html = fs.readFileSync(ACTIVATION_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('activation.html not found')
      }
      return
    }

    // GET / — 未激活时进入激活页，已激活时进入 brain-ui
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (config.needsActivation) {
        res.writeHead(302, { Location: '/activation' })
        res.end()
        return
      }
      try {
        const html = fs.readFileSync(INDEX_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        // 没有 index.html 时，直接去 brain-ui
        res.writeHead(302, { Location: '/brain-ui' })
        res.end()
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/dashboard.html') {
      try {
        const html = fs.readFileSync(DASHBOARD_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('dashboard.html not found')
      }
      return
    }

    // GET /brain.html — Brain Monitor
    if (req.method === 'GET' && url.pathname === '/brain.html') {
      try {
        const html = fs.readFileSync(BRAIN_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('brain.html not found')
      }
      return
    }

    // GET /brain-ui — Brain UI（记忆图谱 + 思考流 + 聊天）
    if (req.method === 'GET' && (url.pathname === '/site' || url.pathname === '/site.html')) {
      try {
        const html = fs.readFileSync(WEBSITE_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('website.html not found')
      }
      return
    }

    if (req.method === 'GET' && (url.pathname === '/brain-ui' || url.pathname === '/brain-ui.html')) {
      if (config.needsActivation) {
        res.writeHead(302, { Location: '/activation' })
        res.end()
        return
      }
      try {
        const html = fs.readFileSync(BRAIN_UI_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('brain-ui.html not found')
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/systemPrompt.html') {
      try {
        const html = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('systemPrompt.html not found')
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/vendor/d3/d3.min.js') {
      try {
        const stat = fs.statSync(D3_VENDOR_PATH)
        res.writeHead(200, {
          'Content-Type': contentTypeFor(D3_VENDOR_PATH),
          'Content-Length': stat.size,
          'Cache-Control': 'public, max-age=31536000, immutable',
        })
        fs.createReadStream(D3_VENDOR_PATH).pipe(res)
      } catch {
        res.writeHead(404)
        res.end('d3.min.js not found')
      }
      return
    }

    if (req.method === 'GET' && url.pathname.startsWith('/src/ui/brain-ui/')) {
      const relativePath = decodeURIComponent(url.pathname.slice('/src/ui/brain-ui/'.length))
      const assetRoot = path.resolve(BRAIN_UI_ASSET_ROOT)
      const assetPath = path.resolve(BRAIN_UI_ASSET_ROOT, relativePath)

      if (!isPathInside(assetRoot, assetPath)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }

      try {
        const stat = fs.statSync(assetPath)
        if (!stat.isFile()) {
          res.writeHead(404)
          res.end('asset not found')
          return
        }

        res.writeHead(200, {
          'Content-Type': contentTypeFor(assetPath),
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache',
        })
        fs.createReadStream(assetPath).pipe(res)
      } catch {
        res.writeHead(404)
        res.end('asset not found')
      }
      return
    }

    // POST /admin/stop — 暂停意识循环（保留 HTTP 服务）
    if (req.method === 'POST' && url.pathname === '/admin/stop') {
      stopLoop()
      emitEvent('admin', { action: 'stop', running: false })
      jsonResponse(res, 200, { ok: true, running: false })
      return
    }

    // POST /admin/start — 恢复意识循环
    if (req.method === 'POST' && url.pathname === '/admin/start') {
      startLoop()
      emitEvent('admin', { action: 'start', running: true })
      jsonResponse(res, 200, { ok: true, running: true })
      return
    }

    // POST /admin/restart — 重启 Jarvis 进程（spawn 新进程后退出）
    if (req.method === 'POST' && url.pathname === '/admin/restart') {
      jsonResponse(res, 200, { ok: true, message: '正在重启…' })
      setTimeout(() => {
        const child = spawn('npm', ['start'], {
          cwd: path.join(__dirname, '../'),
          detached: true,
          stdio: 'ignore',
          shell: true,
        })
        child.unref()
        process.exit(0)
      }, 500)
      return
    }

    // POST /admin/reset-memories — 清除所有记忆和对话
    if (req.method === 'POST' && url.pathname === '/admin/reset-memories') {
      const db = getDB()
      db.prepare('DELETE FROM memories').run()
      db.prepare('DELETE FROM conversations').run()
      db.prepare("DELETE FROM config WHERE key != 'birth_time'").run()
      db.prepare('DELETE FROM entities').run()
      db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
      emitEvent('admin', { action: 'reset-memories' })
      jsonResponse(res, 200, { ok: true })
      return
    }

    // POST /admin/reset-files — 清除 sandbox 用户文件（保留 readme.txt、world.txt）
    if (req.method === 'POST' && url.pathname === '/admin/reset-files') {
      const sandboxPath = SANDBOX_PATH
      const KEEP = new Set(['readme.txt', 'world.txt'])
      function clearDir(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            clearDir(full)
            try { fs.rmdirSync(full) } catch (_) {}
          } else if (!KEEP.has(entry.name.toLowerCase())) {
            fs.unlinkSync(full)
          }
        }
      }
      try { clearDir(sandboxPath) } catch (_) {}
      emitEvent('admin', { action: 'reset-files' })
      jsonResponse(res, 200, { ok: true })
      return
    }

    // GET /voice/status — 语音服务状态
    if (req.method === 'GET' && url.pathname === '/voice/status') {
      jsonResponse(res, 200, { ok: true, voice: getVoiceStatus() })
      return
    }

    // POST /voice/start — 启动语音服务 { model: 'base' }
    if (req.method === 'POST' && url.pathname === '/voice/start') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8')
          const { model = 'turbo' } = body ? JSON.parse(body) : {}
          const result = startVoiceServer({ model })
          jsonResponse(res, 200, { ok: true, voice: result })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // POST /voice/stop — 停止语音服务
    if (req.method === 'POST' && url.pathname === '/voice/stop') {
      const result = stopVoiceServer()
      jsonResponse(res, 200, { ok: true, voice: result })
      return
    }

    // GET /settings/voice — 读取语音配置（凭证只返回 configured 状态）
    if (req.method === 'GET' && url.pathname === '/settings/voice') {
      jsonResponse(res, 200, { ok: true, voice: getVoiceConfig() })
      return
    }

    // POST /settings/voice — 保存语音配置 { whisperModel?, aliyunApiKey?, ... }
    if (req.method === 'POST' && url.pathname === '/settings/voice') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          setVoiceConfig(body)
          // 若更换了 Whisper 模型，热重启语音服务
          if (body.whisperModel) restartVoiceServer(body.whisperModel)
          jsonResponse(res, 200, { ok: true, voice: getVoiceConfig() })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // GET /settings/tts — 读取 TTS 配置状态（不返回明文密钥）
    if (req.method === 'GET' && url.pathname === '/settings/tts') {
      jsonResponse(res, 200, { ok: true, tts: getTTSConfig(), providers: TTS_PROVIDERS, voices: TTS_VOICES })
      return
    }

    // POST /settings/tts — 保存 TTS 配置
    if (req.method === 'POST' && url.pathname === '/settings/tts') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          setTTSConfig(body)
          jsonResponse(res, 200, { ok: true, tts: getTTSConfig() })
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message })
        }
      })
      return
    }

    // POST /tts/stream — 流式 TTS 合成，返回 audio/mpeg 流
    if (req.method === 'POST' && url.pathname === '/tts/stream') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
          const { text } = body
          if (!text?.trim()) { jsonResponse(res, 400, { ok: false, error: '缺少 text 参数' }); return }
          const creds = getTTSCredentials()
          const audioStream = await streamTTS({
            text: text.slice(0, 500),
            provider: creds.provider,
            voiceId:  body.voiceId || creds.voiceId || undefined,
            keys: {
              minimaxKey:    creds.minimaxKey,
              openaiKey:     creds.openaiKey,
              openaiBaseURL: creds.openaiBaseURL,
              elevenLabsKey: creds.elevenLabsKey,
              volcanoAppId:  creds.volcanoAppId,
              volcanoToken:  creds.volcanoToken,
            },
          })
          res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Transfer-Encoding': 'chunked',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
          })
          audioStream.pipe(res)
          audioStream.on('error', () => { try { res.end() } catch {} })
        } catch (err) {
          console.warn('[TTS] 流式合成失败:', err.message)
          if (!res.headersSent) jsonResponse(res, 500, { ok: false, error: err.message })
          else try { res.end() } catch {}
        }
      })
      return
    }

    jsonResponse(res, 404, { error: 'not found' })
  })

  // Cloud ASR ws 通道：前端 PCM → 后端代理 → 云端 ASR
  const cloudWss = new WebSocketServer({ noServer: true })
  cloudWss.on('connection', (ws) => {
    let session = null
    let configured = false

    ws.on('message', (raw) => {
      // 第一帧必须是 JSON config 帧
      if (!configured) {
        try {
          const msg = JSON.parse(raw.toString())
          if (msg.type !== 'config') return
          // 从 config.json 读取凭证原始值
          let rawCfg = {}
          try { rawCfg = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))?.voice || {} } catch {}
          session = createCloudASRSession(
            { provider: msg.provider || 'aliyun', lang: msg.lang || 'zh', ...rawCfg },
            (text, isFinal) => {
              try { ws.send(JSON.stringify({ type: 'transcript', text, is_final: isFinal })) } catch {}
            },
            (errMsg) => {
              try { ws.send(JSON.stringify({ type: 'error', message: errMsg })) } catch {}
            },
            () => { try { ws.close() } catch {} }
          )
          configured = true
        } catch {}
        return
      }
      // 后续帧为 PCM 二进制
      if (raw instanceof Buffer) {
        session?.sendAudio(raw)
      } else {
        try {
          const msg = JSON.parse(raw.toString())
          if (msg.type === 'flush') session?.flush()
        } catch {}
      }
    })

    ws.on('close', () => { session?.close(); session = null })
    ws.on('error', () => { session?.close(); session = null })
  })

  // ACUI ws 通道：双向控制 + 感知
  const acuiWss = new WebSocketServer({ noServer: true })
  acuiWss.on('connection', (ws) => {
    addACUIClient(ws)
    try { ws.send(JSON.stringify({ v: 1, kind: 'acui:hello' })) } catch {}

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg?.kind === 'ui.signal') {
          const id = insertUISignal({
            type: msg.type,
            target: msg.target || null,
            payload: msg.payload || {},
            ts: msg.ts || Date.now(),
          })
          emitEvent('ui_signal', { id, type: msg.type, target: msg.target, payload: msg.payload })
          // card.mounted：检查 render_preview，CSS/HTML 泄漏时才通知 agent
          if (msg.type === 'card.mounted') {
            const preview = msg.payload?.render_preview || ''
            if (preview && /font-size|rgba\(|<span|<\/[a-z]|px;|z-index|text-shadow/.test(preview)) {
              pushMessage('SYSTEM',
                `[渲染异常 app=${msg.target || 'unknown'}]\n组件挂载后文本内容疑似包含未渲染的 HTML/CSS，请立刻检查代码并用 ui_hide + ui_show_inline 重新生成：\n${preview.slice(0, 200)}`,
                'APP_SIGNAL')
            }
          }
          // card.dismissed：从服务端存活表移除
          if (msg.type === 'card.dismissed') {
            removeActiveUICard(msg.target)
          }
          // 只有用户主动交互（card.action）才推入 agent 队列
          // card.dismissed 等其他生命周期信号不触发 agent
          if (msg.type === 'card.action') {
            const appId = msg.target || 'ui'
            const action = msg.payload?.action || 'unknown'
            const payload = msg.payload?.payload || msg.payload || {}
            // app:saveState 是组件自动上报的状态快照，直接落盘，不触发 agent
            if (action === 'app:saveState') {
              persistAppState(appId, payload)
            } else {
              const signalContent = `[App信号 app=${appId} action=${action}]\n${JSON.stringify(payload, null, 2)}`
              pushMessage(`APP:${appId}`, signalContent, 'APP_SIGNAL')
            }
          }
        } else if (msg?.kind === 'pong') {
          // ignore
        }
      } catch (e) {
        // 拒绝非 JSON 帧
      }
    })

    ws.on('close', () => removeACUIClient(ws))
    ws.on('error', () => removeACUIClient(ws))
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://localhost:${port}`)
    if (url.pathname === '/acui') {
      const origin = req.headers.origin
      if (origin && !isAllowedOrigin(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      if (!hasAllowedAccess(req, url)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      acuiWss.handleUpgrade(req, socket, head, (ws) => acuiWss.emit('connection', ws, req))
    } else if (url.pathname === '/voice/cloud') {
      cloudWss.handleUpgrade(req, socket, head, (ws) => cloudWss.emit('connection', ws, req))
    } else {
      socket.destroy()
    }
  })

  // 心跳：每 30s 给所有 ACUI 客户端发 ping
  const acuiHeartbeat = setInterval(() => {
    for (const client of acuiWss.clients) {
      try { client.send(JSON.stringify({ v: 1, kind: 'ping' })) } catch {}
    }
  }, 30000)
  acuiHeartbeat.unref?.()

  server.listen(port, host, () => {
    console.log(`[API] 监听 http://${host}:${port}`)
    console.log(`[API]   POST /message  — 发消息给意识体`)
    console.log(`[API]   GET  /events   — SSE 实时流（接收意识体消息）`)
    console.log(`[API]   GET  /memories — 查询记忆`)
    console.log(`[API]   GET  /status   — 状态`)
    console.log(`[API]   WS   /acui     — ACUI 双向通道（控制 + 感知）`)
  })

  return server
}
