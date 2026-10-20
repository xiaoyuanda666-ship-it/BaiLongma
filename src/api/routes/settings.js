import { emitEvent, setStickyEvent } from '../../events.js'
import { pushMessage } from '../../inbound-message.js'
import { restartConnector } from '../../social/index.js'
import { replaceProvider } from '../../providers/registry.js'
import { MinimaxProvider } from '../../providers/minimax.js'
import {
  config,
  getActivationStatus,
  getEmbeddingConfig,
  getContextWindowConfig,
  getHeartbeatConfig,
  getMinimaxKey,
  getNetworkConfig,
  getProviderSummaries,
  getProviderModels,
  getSecurity,
  getSocialConfig,
  getTTSConfig,
  getVoiceConfig,
  saveLLMSettings,
  setEmbeddingConfig,
  setContextWindowConfig,
  setHeartbeatConfig,
  setMinimaxKey,
  setSecurity,
  setSocialConfig,
  setTemperature,
  setThinking,
  setTTSConfig,
  setVoiceConfig,
  switchModel,
} from '../../config.js'
import { refreshScheduler } from '../../control.js'
import { EMBEDDING_PROVIDER_PRESETS } from '../../config.js'
import { TTS_PROVIDERS, TTS_VOICES } from '../../voice/tts-providers.js'
import { getAgentName, validateAgentName } from '../agent.js'
import { jsonResponse, readJsonBody } from '../utils.js'
import { setConfig } from '../../db.js'
import { getMapServiceSettings, setMapServiceSettings } from '../../map-service.js'
import QRCode from 'qrcode'
import { getMcpServersConfig, setMcpServersConfig } from '../../mcp/config.js'
import { getMcpStatus, reconcileMcpClients } from '../../mcp/client-manager.js'

function checkLocalOrToken(req, res, url, requireLocalOrToken) {
  if (typeof requireLocalOrToken === 'function') return requireLocalOrToken(req, res, url)
  jsonResponse(res, 403, { ok: false, error: 'forbidden' })
  return false
}

async function getNetworkSettingsForUi() {
  const network = getNetworkConfig()
  const accessEntries = await Promise.all((network.accessEntries || []).map(async entry => ({
    ...entry,
    qrDataUrl: await QRCode.toDataURL(entry.url, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: { dark: '#07110d', light: '#ffffff' },
    }),
    certificateQrDataUrl: await QRCode.toDataURL(entry.certificateUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 240,
      color: { dark: '#07110d', light: '#ffffff' },
    }),
  })))
  return {
    ...network,
    accessEntries,
    preferredAccessUrl: accessEntries[0]?.url || '',
  }
}

export async function handleSettingsRoutes(req, res, url, { requireLocalOrToken, hasAllowedAccess } = {}) {
  if (req.method === 'GET' && url.pathname === '/settings') {
    const status = getActivationStatus()
    const minimaxKey = getMinimaxKey()
    jsonResponse(res, 200, {
      agent_name: getAgentName(),
      llm: {
        activated: status.activated,
        apiFormat: status.apiFormat,
        provider: status.provider,
        model: status.model,
        baseURL: status.baseURL,
        models: status.models,
        temperature: config.temperature,
        thinking: config.thinking === true,
        contextWindow: getContextWindowConfig(),
        apiKey: config.apiKey || '',
      },
      providers: getProviderSummaries(),
      minimax: {
        configured: !!(globalThis.process?.env?.MINIMAX_API_KEY || minimaxKey),
      },
      heartbeat: getHeartbeatConfig(),
      network: getNetworkConfig(),
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/agent-name') {
    try {
      const { agentName, agent_name } = await readJsonBody(req)
      const trimmedName = validateAgentName(agentName ?? agent_name)
      if (trimmedName) setConfig('agent_name', trimmedName)
      const name = getAgentName()
      setStickyEvent('agent_name_updated', { name })
      emitEvent('agent_name_updated', { name })
      jsonResponse(res, 200, { ok: true, agent_name: name })
    } catch (err) {
      jsonResponse(res, err.statusCode === 413 ? 413 : 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/model') {
    try {
      const { provider, apiKey, model, baseURL, apiFormat } = await readJsonBody(req)
      const result = provider || apiKey || baseURL || apiFormat !== undefined
        ? await saveLLMSettings({ provider, apiKey, model, baseURL, apiFormat })
        : switchModel(model)
      emitEvent('model_switched', result)
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) {
      jsonResponse(res, err.statusCode === 413 ? 413 : 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/models') {
    try {
      const { provider, apiKey, baseURL, forceRefresh } = await readJsonBody(req)
      const catalog = await getProviderModels({ provider, apiKey, baseURL, forceRefresh: forceRefresh === true })
      jsonResponse(res, 200, { ok: true, provider, ...catalog })
    } catch (err) {
      jsonResponse(res, err.statusCode === 413 ? 413 : 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/temperature') {
    try {
      const { temperature } = await readJsonBody(req)
      const result = setTemperature(temperature)
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) {
      jsonResponse(res, err.statusCode === 413 ? 413 : 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/thinking') {
    try {
      const { thinking } = await readJsonBody(req)
      const result = setThinking(thinking)
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) {
      jsonResponse(res, err.statusCode === 413 ? 413 : 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/context-window') {
    try {
      const updates = await readJsonBody(req)
      const contextWindow = setContextWindowConfig(updates)
      jsonResponse(res, 200, { ok: true, contextWindow })
    } catch (err) {
      jsonResponse(res, err.statusCode === 413 ? 413 : 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/settings/heartbeat') {
    jsonResponse(res, 200, { ok: true, heartbeat: getHeartbeatConfig() })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/heartbeat') {
    try {
      const body = await readJsonBody(req)
      const heartbeat = setHeartbeatConfig(body)
      refreshScheduler()
      emitEvent('heartbeat_settings_updated', heartbeat)
      jsonResponse(res, 200, { ok: true, heartbeat })
    } catch (err) {
      jsonResponse(res, err.statusCode === 413 ? 413 : 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/settings/mcp') {
    if (!checkLocalOrToken(req, res, url, requireLocalOrToken)) return true
    jsonResponse(res, 200, {
      ok: true,
      mcp: getMcpServersConfig(),
      status: getMcpStatus(),
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/mcp') {
    if (!checkLocalOrToken(req, res, url, requireLocalOrToken)) return true
    try {
      const body = await readJsonBody(req)
      const mcp = setMcpServersConfig(body)
      const status = await reconcileMcpClients()
      emitEvent('mcp_settings_updated', {
        serverCount: mcp.servers.length,
        enabledCount: mcp.servers.filter(server => server.enabled).length,
        toolCount: status.toolCount,
      })
      jsonResponse(res, 200, { ok: true, mcp, status })
    } catch (err) {
      jsonResponse(res, err.statusCode === 413 ? 413 : 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/settings/security') {
    if (!hasAllowedAccess?.(req, url)) {
      jsonResponse(res, 403, { ok: false, error: 'forbidden' })
      return true
    }
    jsonResponse(res, 200, { ok: true, security: getSecurity(), network: await getNetworkSettingsForUi() })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/settings/map') {
    jsonResponse(res, 200, { ok: true, map: getMapServiceSettings() })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/map') {
    try {
      const body = await readJsonBody(req)
      const map = setMapServiceSettings(body)
      jsonResponse(res, 200, { ok: true, map })
    } catch (err) {
      jsonResponse(res, err.statusCode === 413 ? 413 : 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/security') {
    if (!checkLocalOrToken(req, res, url, requireLocalOrToken)) return true
    try {
      const updates = await readJsonBody(req)
      const previousNetwork = getNetworkConfig()
      const result = setSecurity(updates)
      const network = getNetworkConfig()
      jsonResponse(res, 200, {
        ok: true,
        security: result,
        network: {
          ...(network.allowLanAccess ? await getNetworkSettingsForUi() : network),
          restartRequired: previousNetwork.allowLanAccess !== network.allowLanAccess,
        },
      })
    } catch (err) {
      jsonResponse(res, err.statusCode === 413 ? 413 : 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/settings/social') {
    jsonResponse(res, 200, { ok: true, social: getSocialConfig() })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/social') {
    try {
      const updates = await readJsonBody(req)
      const PLATFORM_KEYS = {
        discord: ['DISCORD_BOT_TOKEN'],
        feishu: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'],
      }
      const previousValues = Object.fromEntries(
        Object.values(PLATFORM_KEYS).flat().map(key => [key, process.env[key] || ''])
      )
      setSocialConfig(updates)
      // Compare effective credentials only after a successful save. Clearing a
      // credential must also restart the connector so the old session is stopped.
      const restarts = new Set(Object.entries(PLATFORM_KEYS)
        .filter(([, keys]) => keys.some(key => previousValues[key] !== (process.env[key] || '')))
        .map(([platform]) => platform))
      if (updates._clawbot_connect) restarts.add('wechat-clawbot')
      if (updates._feishu_disconnect) restarts.add('feishu')
      for (const platform of restarts) {
        restartConnector(platform, { pushMessage, emitEvent }).catch(err =>
          console.warn(`[social] restart ${platform} failed:`, err.message)
        )
      }
      jsonResponse(res, 200, { ok: true, social: getSocialConfig() })
    } catch (err) {
      jsonResponse(res, err.statusCode === 413 ? 413 : 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/minimax') {
    try {
      const { apiKey } = await readJsonBody(req)
      const trimmed = String(apiKey || '').trim()
      if (!trimmed) throw new Error('API key cannot be empty')
      setMinimaxKey(trimmed)
      replaceProvider(new MinimaxProvider({ apiKey: trimmed }))
      jsonResponse(res, 200, { ok: true, configured: true })
    } catch (err) {
      jsonResponse(res, err.statusCode === 413 ? 413 : 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/settings/voice') {
    jsonResponse(res, 200, { ok: true, voice: getVoiceConfig() })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/voice') {
    try {
      const body = await readJsonBody(req)
      setVoiceConfig(body)
      jsonResponse(res, 200, { ok: true, voice: getVoiceConfig() })
    } catch (err) {
      jsonResponse(res, err.statusCode === 413 ? 413 : 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/settings/tts') {
    jsonResponse(res, 200, { ok: true, tts: getTTSConfig(), providers: TTS_PROVIDERS, voices: TTS_VOICES })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/tts') {
    try {
      const body = await readJsonBody(req)
      setTTSConfig(body)
      jsonResponse(res, 200, { ok: true, tts: getTTSConfig() })
    } catch (err) {
      jsonResponse(res, err.statusCode === 413 ? 413 : 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/settings/embedding') {
    jsonResponse(res, 200, {
      ok: true,
      embedding: getEmbeddingConfig(),
      presets: EMBEDDING_PROVIDER_PRESETS,
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/embedding') {
    try {
      const body = await readJsonBody(req)
      setEmbeddingConfig(body)
      try {
        const { clearEmbeddingCache } = await import('../../embedding.js')
        clearEmbeddingCache()
      } catch {}
      try {
        const { getEmbeddingCredentials } = await import('../../config.js')
        const cred = getEmbeddingCredentials()
        if (cred?.provider === 'local' && cred.model) {
          const { warmupLocalEmbedding } = await import('../../embedding-local.js')
          warmupLocalEmbedding(cred.model).catch(() => {})
        }
      } catch {}
      jsonResponse(res, 200, { ok: true, embedding: getEmbeddingConfig() })
    } catch (err) {
      jsonResponse(res, err.statusCode === 413 ? 413 : 400, { ok: false, error: err.message })
    }
    return true
  }

  return false
}
