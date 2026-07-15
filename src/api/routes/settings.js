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
  getSecurity,
  getSocialConfig,
  getTTSConfig,
  getVoiceConfig,
  getWebSearchConfig,
  saveLLMSettings,
  setEmbeddingConfig,
  setContextWindowConfig,
  setHeartbeatConfig,
  setMinimaxKey,
  setNetworkConfig,
  setSecurity,
  setSocialConfig,
  setTemperature,
  setThinking,
  setTTSConfig,
  setVoiceConfig,
  setWebSearchConfig,
  switchModel,
} from '../../config.js'
import { refreshScheduler } from '../../control.js'
import { EMBEDDING_PROVIDER_PRESETS } from '../../config.js'
import { TTS_PROVIDERS, TTS_VOICES } from '../../voice/tts-providers.js'
import { getAgentName, validateAgentName } from '../agent.js'
import { jsonResponse, readJsonBody } from '../utils.js'
import { setConfig } from '../../db.js'
import { getMapServiceSettings, setMapServiceSettings } from '../../map-service.js'

function checkLocalOrToken(req, res, url, requireLocalOrToken) {
  if (typeof requireLocalOrToken === 'function') return requireLocalOrToken(req, res, url)
  jsonResponse(res, 403, { ok: false, error: 'forbidden' })
  return false
}

export async function handleSettingsRoutes(req, res, url, { requireLocalOrToken, hasAllowedAccess } = {}) {
  if (req.method === 'GET' && url.pathname === '/settings') {
    const status = getActivationStatus()
    const minimaxKey = getMinimaxKey()
    jsonResponse(res, 200, {
      agent_name: getAgentName(),
      llm: {
        activated: status.activated,
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
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/model') {
    try {
      const { provider, apiKey, model, baseURL } = await readJsonBody(req)
      const result = provider || apiKey || baseURL
        ? await saveLLMSettings({ provider, apiKey, model, baseURL })
        : switchModel(model)
      emitEvent('model_switched', result)
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/temperature') {
    try {
      const { temperature } = await readJsonBody(req)
      const result = setTemperature(temperature)
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/thinking') {
    try {
      const { thinking } = await readJsonBody(req)
      const result = setThinking(thinking)
      jsonResponse(res, 200, { ok: true, ...result })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/context-window') {
    try {
      const updates = await readJsonBody(req)
      const contextWindow = setContextWindowConfig(updates)
      jsonResponse(res, 200, { ok: true, contextWindow })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
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
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/settings/security') {
    if (!hasAllowedAccess?.(req, url)) {
      jsonResponse(res, 403, { ok: false, error: 'forbidden' })
      return true
    }
    jsonResponse(res, 200, { ok: true, security: getSecurity(), network: getNetworkConfig() })
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
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/security') {
    if (!checkLocalOrToken(req, res, url, requireLocalOrToken)) return true
    try {
      const updates = await readJsonBody(req)
      const result = setSecurity(updates)
      const network = Object.prototype.hasOwnProperty.call(updates, 'allowLanAccess')
        ? setNetworkConfig({ allowLanAccess: !!updates.allowLanAccess })
        : getNetworkConfig()
      jsonResponse(res, 200, { ok: true, security: result, network })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
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
      const feishuTouched = ('FEISHU_APP_ID' in updates) || ('FEISHU_APP_SECRET' in updates)
      const feishuChanged = feishuTouched && (
        (updates.FEISHU_APP_ID || '') !== (process.env.FEISHU_APP_ID || '') ||
        (updates.FEISHU_APP_SECRET || '') !== (process.env.FEISHU_APP_SECRET || '')
      )
      setSocialConfig(updates)
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
      if (feishuChanged && process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
        restartConnector('feishu', { pushMessage, emitEvent }).catch(err =>
          console.warn('[social] restart feishu failed:', err.message)
        )
      }
      if (updates._clawbot_connect) {
        restartConnector('wechat-clawbot', { pushMessage, emitEvent }).catch(err =>
          console.warn('[social] restart wechat-clawbot failed:', err.message)
        )
      }
      if (updates._feishu_disconnect) {
        restartConnector('feishu', { pushMessage, emitEvent }).catch(err =>
          console.warn('[social] restart feishu failed:', err.message)
        )
      }
      jsonResponse(res, 200, { ok: true, social: getSocialConfig() })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
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
      jsonResponse(res, 400, { ok: false, error: err.message })
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
      jsonResponse(res, 400, { ok: false, error: err.message })
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
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/settings/web-search') {
    jsonResponse(res, 200, { ok: true, webSearch: getWebSearchConfig() })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/settings/web-search') {
    try {
      const body = await readJsonBody(req)
      setWebSearchConfig(body)
      jsonResponse(res, 200, { ok: true, webSearch: getWebSearchConfig() })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
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
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  return false
}
