import { emitEvent, setStickyEvent } from '../../events.js'
import {
  activate as activateLLM,
  commitPreparedActivation,
  getActivationStatus,
  prepareActivation as prepareLLMActivation,
} from '../../config.js'
import { getAgentName, validateAgentName } from '../agent.js'
import { jsonResponse, readJsonBody } from '../utils.js'
import { setConfig } from '../../db.js'

function publicActivationInfo(info) {
  return {
    provider: info.provider,
    model: info.model,
    models: info.models,
  }
}

export async function handleActivationRoutes(req, res, url, {
  storePreparedActivation,
  getPreparedActivation,
  clearPreparedActivation,
  onActivated,
  onActivationIntroComplete,
} = {}) {
  if (req.method === 'POST' && url.pathname === '/activation/intro-complete') {
    try {
      if (typeof onActivationIntroComplete === 'function') onActivationIntroComplete()
      jsonResponse(res, 200, { ok: true })
    } catch (err) {
      console.error('[API] activation intro completion callback error:', err)
      jsonResponse(res, 500, { ok: false, error: err.message || 'intro completion failed' })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/activation-status') {
    jsonResponse(res, 200, getActivationStatus())
    return true
  }

  if (req.method === 'POST' && url.pathname === '/activate/prepare') {
    try {
      const { apiKey, model, provider, baseURL } = await readJsonBody(req)
      const info = await prepareLLMActivation({ provider, apiKey, model, baseURL })
      const pending = storePreparedActivation({ apiKey, info })
      jsonResponse(res, 200, {
        ok: true,
        token: pending.token,
        ...publicActivationInfo(info),
        agent_name: getAgentName(),
        expiresAt: pending.expiresAt,
      })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/activate') {
    try {
      const { apiKey, model, provider, baseURL, agentName, preparedToken } = await readJsonBody(req)
      const trimmedName = validateAgentName(agentName)
      const prepared = getPreparedActivation(preparedToken, apiKey)
      const info = prepared
        ? commitPreparedActivation(prepared.info)
        : await activateLLM({ provider, apiKey, model, baseURL })
      if (prepared) clearPreparedActivation?.()

      if (trimmedName) {
        try {
          setConfig('agent_name', trimmedName)
          setStickyEvent('agent_name_updated', { name: trimmedName })
          emitEvent('agent_name_updated', { name: trimmedName })
        } catch (err) {
          console.error('[API] save agent_name failed:', err)
        }
      }

      emitEvent('activated', info)
      if (typeof onActivated === 'function') {
        try { onActivated() } catch (err) { console.error('[API] onActivated callback error:', err) }
      }
      jsonResponse(res, 200, { ok: true, ...info, agent_name: getAgentName() })
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message })
    }
    return true
  }

  return false
}
