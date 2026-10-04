import http from 'http'
import https from 'https'
import fs from 'fs'
import { WebSocketServer } from 'ws'
import { handleSceneConnection, setSceneIntentHandler } from './scene/scene-server.js'
import { sceneStore } from './scene/scene-store.js'
import { pushMessage } from './inbound-message.js'
import { getConfig, insertUISignal, markUISignalsConsumed } from './db.js'
import { publishInformationEventForMigration } from './information/activation-bridge.js'
import { emitEvent, setStickyEvent } from './events.js'
import { PRIMARY_USER_ID } from './identity.js'
import { getLanAccessToken, getNetworkConfig, getSecurity, getVoiceRuntimeConfig, setSecurity } from './config.js'
import { ensureLanTlsCertificates } from './lan-access.js'
import { createCloudASRSession } from './voice/cloud-asr.js'
import { jsonResponse } from './api/utils.js'
import { handleActivationRoutes } from './api/routes/activation.js'
import { createPreparedActivationStore } from './api/activation-draft.js'
import { handleAdminRoutes } from './api/routes/admin.js'
import { handleBrowserPreviewRoutes } from './api/routes/browser-preview.js'
import { handleEmbeddingRoutes } from './api/routes/embedding.js'
import { handleEventRoutes } from './api/routes/events.js'
import { handleMediaRoutes } from './api/routes/media.js'
import { handleMapRoutes } from './api/routes/map.js'
import { handleMemoryRoutes } from './api/routes/memory.js'
import { handleKnowledgeRoutes } from './api/routes/knowledge.js'
import { handleMessageRoutes } from './api/routes/message.js'
import { handlePanelRoutes } from './api/routes/panels.js'
import { handleSettingsRoutes } from './api/routes/settings.js'
import { isSocialWebhookPath } from './social/webhooks.js'
import { createSessionCookie, hasBearerToken, hasAuthorizedAccess, isTrustedRequestOrigin, isPublicBootstrapRequest } from './api/request-security.js'
import { handleSocialRoutes } from './api/routes/social.js'
import { handleStaticRoutes } from './api/routes/static.js'
import { handleTTSRoutes } from './api/routes/tts.js'
import {
  attachWebSocketIdleTimeout,
  authorizeWebSocketUpgrade,
  rejectWebSocketUpgrade,
  selectWebSocketProtocol,
} from './api/websocket-security.js'

export { emitEvent }

const DEFAULT_API_HOST = '127.0.0.1'

function getTlsOptions() {
  const pfxPath = String(globalThis.process?.env?.BAILONGMA_TLS_PFX || '').trim()
  const certPath = String(globalThis.process?.env?.BAILONGMA_TLS_CERT || '').trim()
  const keyPath = String(globalThis.process?.env?.BAILONGMA_TLS_KEY || '').trim()
  if (pfxPath) {
    return {
      pfx: fs.readFileSync(pfxPath),
      passphrase: String(globalThis.process?.env?.BAILONGMA_TLS_PFX_PASSPHRASE || ''),
    }
  }
  if (certPath && keyPath) {
    return {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    }
  }
  if (isLanAccessEnabled()) {
    const files = ensureLanTlsCertificates()
    globalThis.process.env.BAILONGMA_TLS_CERT = files.serverCert
    globalThis.process.env.BAILONGMA_TLS_KEY = files.serverKey
    globalThis.process.env.BAILONGMA_LAN_CA_CERT = files.rootCer
    return {
      cert: fs.readFileSync(files.serverCert),
      key: fs.readFileSync(files.serverKey),
    }
  }
  return null
}

function getApiHost() {
  const envHost = String(globalThis.process?.env?.BAILONGMA_HOST || '').trim()
  if (envHost) return envHost
  return getNetworkConfig().allowLanAccess ? '0.0.0.0' : DEFAULT_API_HOST
}

function isLanAccessEnabled() {
  return getNetworkConfig().allowLanAccess
    || /^(1|true|yes|on)$/i.test(String(globalThis.process?.env?.BAILONGMA_ALLOW_LAN || '').trim())
}

function getAuthToken() {
  return getLanAccessToken({ ensure: isLanAccessEnabled() })
}

function hasAllowedAccess(req) {
  return hasAuthorizedAccess(req, { lanEnabled: isLanAccessEnabled(), expectedToken: getAuthToken() })
}

function requireLocalOrToken(req, res) {
  if (hasAllowedAccess(req)) return true
  jsonResponse(res, 403, { ok: false, error: 'forbidden' })
  return false
}

async function dispatchHttpRoutes(req, res, url, context) {
  if (await handleMessageRoutes(req, res, url)) return true
  if (await handleEventRoutes(req, res, url)) return true
  if (await handleBrowserPreviewRoutes(req, res, url, context)) return true
  if (await handleMemoryRoutes(req, res, url)) return true
  if (await handleKnowledgeRoutes(req, res, url)) return true
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

    ws.on('message', async (raw) => {
      if (!configured) {
        try {
          const msg = JSON.parse(raw.toString())
          if (msg.type !== 'config') return
          configured = true
          const rawCfg = getVoiceRuntimeConfig(msg.provider || 'aliyun')
          const provider = rawCfg.provider
          const lang = msg.lang || rawCfg.lang || 'zh'
          const nextSession = await createCloudASRSession(
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
          if (cleanedUp) {
            nextSession?.close()
          } else {
            session = nextSession
          }
        } catch (err) {
          if (!cleanedUp) configured = false
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
    const shadowTopicSuffix = String(name || 'unknown')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'unknown'
    const passiveUiObservation = SCENE_PASSIVE_INTENTS.has(name)
    const informationInput = {
      topic: `ui.${passiveUiObservation ? 'observation' : 'intent'}.${shadowTopicSuffix}`,
      source: { id: 'ui:scene-protocol', kind: 'event' },
      subject: { surface, userId: PRIMARY_USER_ID },
      authorship: passiveUiObservation ? 'system' : 'user',
      semanticKind: 'ui_signal',
      payload: { name, data },
      occurredAt: msg.ts || Date.now(),
      expiresAt: new Date(Date.now() + (passiveUiObservation ? 5 * 60_000 : 24 * 60 * 60_000)),
      priority: passiveUiObservation ? 30 : 60,
      sensitivity: 'private',
      trust: 'observed',
      orderingKey: `ui:${surface}`,
      dedupeKey: `ui-signal:${id}`,
      correlationId: String(surface),
      metadata: { legacyUiSignalId: id },
    }
    const securityConfirmationIntent = name === 'select' && surface.startsWith('security-confirm-')
    // Passive observations create only an accumulated wake=never delivery;
    // every active intent, including security confirmation, wakes one typed
    // information turn. The legacy APP_SIGNAL below remains failure-only.
    const informationResult = publishInformationEventForMigration(informationInput, {
      domain: 'ui',
      queueMetadata: {
        surface,
        notificationTargetId: PRIMARY_USER_ID,
        notificationChannel: 'TUI',
      },
    })
    const shadowMeta = informationResult.event?.id
      ? { informationEventId: informationResult.event.id }
      : {}
    if (informationResult.handled) {
      // The durable Information Core delivery now owns this active intent.
      // Remove only its compatibility row; passive UI rows remain available
      // through the legacy next-turn context until that path is migrated too.
      try {
        markUISignalsConsumed([id])
      } catch (error) {
        console.warn('[information] failed to retire migrated UI compatibility row:', error?.message || error)
      }
    }

    if (securityConfirmationIntent) {
      const pending = sceneStore.get(surface)?.data?.pending || {}
      sceneStore.set(surface, null)
      if (data.value === 'confirm') {
        const updates = {}
        if (pending.file_sandbox !== undefined) updates.fileSandbox = pending.file_sandbox === true
        if (pending.exec_sandbox !== undefined) updates.execSandbox = pending.exec_sandbox === true
        if (pending.browser_private_network !== undefined) updates.browserPrivateNetwork = pending.browser_private_network === true
        const result = Object.keys(updates).length > 0 ? setSecurity(updates) : getSecurity()
        const desc = Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(', ')
        if (!informationResult.handled) {
          pushMessage(
            'SYSTEM',
            `[security settings updated] User confirmed changes: ${desc}. changed_at=${result.updatedAt || 'not recorded'}\n(Internal context refresh only. Do NOT call send_message.)`,
            'APP_SIGNAL',
            {
              queue: 'background',
              persist: false,
              silent: true,
              ...shadowMeta,
            },
          )
        }
      } else if (!informationResult.handled) {
        pushMessage(
          'SYSTEM',
          '[security settings change] User cancelled - settings unchanged\n(Internal context refresh only. Do NOT call send_message.)',
          'APP_SIGNAL',
          {
            queue: 'background',
            persist: false,
            silent: true,
            ...shadowMeta,
          },
        )
      }
      return
    }

    if (!SCENE_PASSIVE_INTENTS.has(name) && !informationResult.handled) {
      pushMessage(
        `UI:${surface}`,
        `[UI intent surface=${surface} name=${name}]\n${JSON.stringify(data, null, 2)}`,
        'APP_SIGNAL',
        shadowMeta,
      )
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

export function startAPI(port = 3721, {
  getStateSnapshot = null,
  onActivated = null,
  onActivationIntroComplete = null,
} = {}) {
  const onActivatedCallback = onActivated
  const onActivationIntroCompleteCallback = onActivationIntroComplete
  const host = getApiHost()
  const tlsOptions = getTlsOptions()
  const protocol = tlsOptions ? 'https' : 'http'
  const { storePreparedActivation, getPreparedActivation, clearPreparedActivation } = createPreparedActivationStore()

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
    onActivationIntroComplete: onActivationIntroCompleteCallback,
  }

  const requestHandler = async (req, res) => {
    const base = `${protocol}://localhost:${port}`
    const url = new URL(req.url, base)

    try {
      // Provider callbacks authenticate using their own signature/token checks.
      if (isSocialWebhookPath(url.pathname)) {
        await handleSocialRoutes(req, res, url, routeContext)
        return
      }
      if (!isTrustedRequestOrigin(req, { allowPublicNavigation: isPublicBootstrapRequest(req, url.pathname) })) {
        return jsonResponse(res, 403, { ok: false, error: 'forbidden origin' })
      }
      if (req.method === 'POST' && url.pathname === '/auth/session') {
        if (!hasAllowedAccess(req) || !hasBearerToken(req, getAuthToken())) {
          return jsonResponse(res, 403, { ok: false, error: 'forbidden' })
        }
        res.setHeader('Set-Cookie', createSessionCookie(getAuthToken(), req))
        res.setHeader('Cache-Control', 'no-store')
        return jsonResponse(res, 200, { ok: true })
      }
      if (!hasAllowedAccess(req) && !isPublicBootstrapRequest(req, url.pathname)) {
        return jsonResponse(res, 403, { ok: false, error: 'forbidden' })
      }
      res.setHeader('Referrer-Policy', 'same-origin')
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      if (await handleSocialRoutes(req, res, url, routeContext)) return

      if (await dispatchHttpRoutes(req, res, url, routeContext)) return
      jsonResponse(res, 404, { error: 'not found' })
    } catch (err) {
      console.error('[API] request failed:', err)
      if (!res.headersSent) jsonResponse(res, 500, { ok: false, error: err.message || 'internal error' })
      else try { res.end() } catch {}
    }
  }
  const server = tlsOptions
    ? https.createServer(tlsOptions, requestHandler)
    : http.createServer(requestHandler)

  const cloudWss = attachCloudASR()
  const sceneWss = attachSceneProtocol()
  attachWebSocketUpgrades(server, port, { sceneWss, cloudWss })

  server.listen(port, host, () => {
    console.log(`[API] Listening at ${protocol}://${host}:${port}`)
    console.log('[API]   POST /message  - send message to agent')
    console.log('[API]   GET  /events   - SSE real-time stream (receive agent messages)')
    console.log('[API]   GET  /memories - query memories')
    console.log('[API]   GET  /knowledge/regions, /knowledge/search - query source-backed knowledge')
    console.log('[API]   POST /knowledge/documents - ingest already-extracted source text')
    console.log('[API]   GET  /audit/recall, /audit/extract, /audit/stats - memory observability (Phase 0)')
    console.log('[API]   GET  /status   - status')
    console.log('[API]   WS   /scene    - Scene declarative UI channel')
  })

  return server
}
