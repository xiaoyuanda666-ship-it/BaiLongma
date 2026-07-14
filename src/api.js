import http from 'http'
import crypto from 'crypto'
import { WebSocketServer } from 'ws'
import { handleSceneConnection, setSceneIntentHandler } from './scene/scene-server.js'
import { sceneStore } from './scene/scene-store.js'
import { pushMessage } from './inbound-message.js'
import { getConfig, insertUISignal } from './db.js'
import { emitEvent, setStickyEvent } from './events.js'
import { getNetworkConfig, getSecurity, getVoiceRuntimeConfig, setSecurity } from './config.js'
import { createCloudASRSession } from './voice/cloud-asr.js'
import { jsonResponse } from './api/utils.js'
import { handleActivationRoutes } from './api/routes/activation.js'
import { handleAdminRoutes } from './api/routes/admin.js'
import { handleEmbeddingRoutes } from './api/routes/embedding.js'
import { handleEventRoutes } from './api/routes/events.js'
import { handleMediaRoutes } from './api/routes/media.js'
import { handleMapRoutes } from './api/routes/map.js'
import { handleMemoryRoutes } from './api/routes/memory.js'
import { handleMessageRoutes } from './api/routes/message.js'
import { handlePanelRoutes } from './api/routes/panels.js'
import { handleSettingsRoutes } from './api/routes/settings.js'
import { handleSocialRoutes } from './api/routes/social.js'
import { handleStaticRoutes } from './api/routes/static.js'
import { handleTTSRoutes } from './api/routes/tts.js'
import {
  attachWebSocketIdleTimeout,
  authorizeWebSocketUpgrade,
  isLoopbackAddress,
  isPrivateLanAddress,
  rejectWebSocketUpgrade,
  selectWebSocketProtocol,
  timingSafeTokenEqual,
} from './api/websocket-security.js'

export { emitEvent }

const DEFAULT_API_HOST = '127.0.0.1'

function getApiHost() {
  const envHost = String(globalThis.process?.env?.BAILONGMA_HOST || '').trim()
  if (envHost) return envHost
  return getNetworkConfig().allowLanAccess ? '0.0.0.0' : DEFAULT_API_HOST
}

function isLanAccessEnabled() {
  return getNetworkConfig().allowLanAccess
    || /^(1|true|yes|on)$/i.test(String(globalThis.process?.env?.BAILONGMA_ALLOW_LAN || '').trim())
}

function isLoopbackRequest(req) {
  return isLoopbackAddress(req.socket?.remoteAddress)
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
  return timingSafeTokenEqual(bearer, expected) || timingSafeTokenEqual(queryToken, expected)
}

function requireLocalOrToken(req, res, url) {
  if (isLoopbackRequest(req) || hasValidAuthToken(req, url)) return true
  jsonResponse(res, 403, { ok: false, error: 'forbidden' })
  return false
}

function hasAllowedAccess(req, url) {
  return isLoopbackRequest(req) || hasValidAuthToken(req, url) || isLanRequest(req)
}

function isSensitivePath(pathname) {
  return pathname === '/activate'
    || pathname === '/activate/prepare'
    || pathname === '/settings'
    || pathname.startsWith('/settings/')
    || pathname.startsWith('/admin/')
    || pathname.startsWith('/memories/')
}

function setCorsHeaders(req, res, origin) {
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || 'null')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

async function dispatchHttpRoutes(req, res, url, context) {
  if (await handleMessageRoutes(req, res, url)) return true
  if (await handleEventRoutes(req, res, url)) return true
  if (await handleMemoryRoutes(req, res, url)) return true
  if (await handlePanelRoutes(req, res, url, context)) return true
  if (await handleMediaRoutes(req, res, url)) return true
  if (await handleMapRoutes(req, res, url, context)) return true
  if (await handleActivationRoutes(req, res, url, context)) return true
  if (await handleSettingsRoutes(req, res, url, context)) return true
  if (await handleEmbeddingRoutes(req, res, url)) return true
  if (await handleAdminRoutes(req, res, url, context)) return true
  if (await handleTTSRoutes(req, res, url)) return true
  if (await handleStaticRoutes(req, res, url)) return true
  return false
}

function attachCloudASR() {
  const cloudWss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    handleProtocols: selectWebSocketProtocol,
  })
  cloudWss.on('connection', (ws) => {
    let session = null
    let configured = false
    let cleanedUp = false
    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      session?.close()
      session = null
    }
    attachWebSocketIdleTimeout(ws, 60 * 1000, cleanup)

    ws.on('message', (raw) => {
      if (!configured) {
        try {
          const msg = JSON.parse(raw.toString())
          if (msg.type !== 'config') return
          const rawCfg = getVoiceRuntimeConfig(msg.provider || 'aliyun')
          const provider = rawCfg.provider
          const lang = msg.lang || rawCfg.lang || 'zh'
          session = createCloudASRSession(
            { ...rawCfg, provider, lang },
            (text, isFinal, seg) => {
              try { ws.send(JSON.stringify({ type: 'transcript', text, is_final: isFinal, seg })) } catch {}
            },
            (errMsg) => {
              try { ws.send(JSON.stringify({ type: 'error', message: errMsg })) } catch {}
            },
            () => { try { ws.close() } catch {} },
            (event, info) => {
              try { ws.send(JSON.stringify({ type: 'diag', event, info })) } catch {}
            },
          )
          configured = true
        } catch (err) {
          try {
            ws.send(JSON.stringify({
              type: 'error',
              message: `ASR 初始化失败: ${err?.message || String(err)}`,
            }))
          } catch {}
        }
        return
      }

      if (raw instanceof Buffer) {
        session?.sendAudio(raw)
      } else {
        try {
          const msg = JSON.parse(raw.toString())
          if (msg.type === 'flush') session?.flush()
        } catch {}
      }
    })

    ws.on('close', cleanup)
    ws.on('error', cleanup)
  })

  return cloudWss
}

function attachSceneProtocol() {
  const sceneWss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    handleProtocols: selectWebSocketProtocol,
  })
  sceneWss.on('connection', (ws) => handleSceneConnection(ws))

  const SCENE_PASSIVE_INTENTS = new Set(['dismiss', 'ended', 'mounted', 'dwell'])
  setSceneIntentHandler((msg) => {
    const surface = msg.surface || 'scene'
    const name = msg.name || 'unknown'
    const data = msg.data || {}
    const id = insertUISignal({ type: `scene.intent.${name}`, target: msg.surface || null, payload: data, ts: msg.ts || Date.now() })
    emitEvent('ui_signal', { id, type: name, target: msg.surface, payload: data })

    if (name === 'select' && surface.startsWith('security-confirm-')) {
      const pending = sceneStore.get(surface)?.data?.pending || {}
      sceneStore.set(surface, null)
      if (data.value === 'confirm') {
        const updates = {}
        if (pending.file_sandbox !== undefined) updates.fileSandbox = pending.file_sandbox === true
        if (pending.exec_sandbox !== undefined) updates.execSandbox = pending.exec_sandbox === true
        const result = Object.keys(updates).length > 0 ? setSecurity(updates) : getSecurity()
        const desc = Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(', ')
        pushMessage(
          'SYSTEM',
          `[security settings updated] User confirmed changes: ${desc}. changed_at=${result.updatedAt || 'not recorded'}\n(Internal context refresh only. Do NOT call send_message.)`,
          'APP_SIGNAL',
          { queue: 'background', persist: false, silent: true },
        )
      } else {
        pushMessage(
          'SYSTEM',
          '[security settings change] User cancelled - settings unchanged\n(Internal context refresh only. Do NOT call send_message.)',
          'APP_SIGNAL',
          { queue: 'background', persist: false, silent: true },
        )
      }
      return
    }

    if (!SCENE_PASSIVE_INTENTS.has(name)) {
      pushMessage(`UI:${surface}`, `[UI intent surface=${surface} name=${name}]\n${JSON.stringify(data, null, 2)}`, 'APP_SIGNAL')
    }
  })

  return sceneWss
}

function attachWebSocketUpgrades(server, port, { sceneWss, cloudWss }) {
  const routes = new Map([
    ['/scene', sceneWss],
    ['/voice/cloud', cloudWss],
  ])
  const knownPaths = new Set(routes.keys())
  server.on('upgrade', (req, socket, head) => {
    let url
    try { url = new URL(req.url, `http://localhost:${port}`) } catch {
      return rejectWebSocketUpgrade(socket, 404)
    }
    const target = routes.get(url.pathname)
    const auth = authorizeWebSocketUpgrade(req, {
      pathname: url.pathname,
      lanEnabled: isLanAccessEnabled(),
      expectedToken: getAuthToken(),
      knownPaths,
    })
    if (!auth.ok || !target) return rejectWebSocketUpgrade(socket, auth.status)
    target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req))
  })
}

export function startAPI(port = 3721, { getStateSnapshot = null, onActivated = null } = {}) {
  const onActivatedCallback = onActivated
  const host = getApiHost()
  let pendingActivation = null

  function storePreparedActivation({ apiKey, info }) {
    pendingActivation = {
      token: crypto.randomUUID(),
      apiKey: String(apiKey || '').trim(),
      info,
      expiresAt: Date.now() + 10 * 60 * 1000,
    }
    return pendingActivation
  }

  function getPreparedActivation(token, apiKey) {
    if (!pendingActivation) return null
    if (pendingActivation.expiresAt <= Date.now()) {
      pendingActivation = null
      return null
    }
    if (!token || pendingActivation.token !== token) return null
    if (pendingActivation.apiKey !== String(apiKey || '').trim()) return null
    return pendingActivation
  }

  function clearPreparedActivation() {
    pendingActivation = null
  }

  try {
    const storedName = (getConfig('agent_name') || '').trim()
    if (storedName) setStickyEvent('agent_name_updated', { name: storedName })
  } catch {}

  const routeContext = {
    getStateSnapshot,
    hasAllowedAccess,
    requireLocalOrToken,
    storePreparedActivation,
    getPreparedActivation,
    clearPreparedActivation,
    onActivated: onActivatedCallback,
  }

  const server = http.createServer(async (req, res) => {
    const base = `http://localhost:${port}`
    const url = new URL(req.url, base)
    const origin = req.headers.origin

    try {
      if (await handleSocialRoutes(req, res, url, { hasAllowedAccess, requireLocalOrToken })) return

      if (origin && !isAllowedOrigin(origin)) {
        return jsonResponse(res, 403, { ok: false, error: 'forbidden origin' })
      }

      if (!hasAllowedAccess(req, url)) {
        return jsonResponse(res, 403, { ok: false, error: 'forbidden' })
      }

      setCorsHeaders(req, res, origin)

      if (req.method !== 'OPTIONS' && isSensitivePath(url.pathname) && !requireLocalOrToken(req, res, url)) return

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      if (await dispatchHttpRoutes(req, res, url, routeContext)) return
      jsonResponse(res, 404, { error: 'not found' })
    } catch (err) {
      console.error('[API] request failed:', err)
      if (!res.headersSent) jsonResponse(res, 500, { ok: false, error: err.message || 'internal error' })
      else try { res.end() } catch {}
    }
  })

  const cloudWss = attachCloudASR()
  const sceneWss = attachSceneProtocol()
  attachWebSocketUpgrades(server, port, { sceneWss, cloudWss })

  server.listen(port, host, () => {
    console.log(`[API] Listening at http://${host}:${port}`)
    console.log('[API]   POST /message  - send message to agent')
    console.log('[API]   GET  /events   - SSE real-time stream (receive agent messages)')
    console.log('[API]   GET  /memories - query memories')
    console.log('[API]   GET  /audit/recall, /audit/extract, /audit/stats - memory observability (Phase 0)')
    console.log('[API]   GET  /status   - status')
    console.log('[API]   WS   /scene    - Scene declarative UI channel')
  })

  return server
}
