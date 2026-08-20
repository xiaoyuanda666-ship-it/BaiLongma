import { buildHeartbeatSystemPromptPreview } from '../../system-prompt-preview.js'
import { getHotspots, getHotspotPanelState, setHotspotPanelState } from '../../hotspots.js'
import { getHotspotEvents } from '../../hotspot-events.js'
import { getWorldcup, getWorldcupPanelState, setWorldcupPanelState } from '../../worldcup.js'
import { getTyphoons, getTyphoonPanelState, setTyphoonPanelState } from '../../typhoon.js'
import { DOC_TOPICS, getDocPanelState, setDocPanelState } from '../../docs.js'
import { getPersonCard, getPersonCardPanelState, setPersonCardPanelState } from '../../person-cards.js'
import { getKnowledgePanelState, setKnowledgePanelState } from '../../knowledge/panel-state.js'
import { getGeoWeatherSnapshot } from '../../geo-weather.js'
import { getAgentName } from '../agent.js'
import { jsonResponse, parseBooleanish, readJsonBody } from '../utils.js'

export async function handlePanelRoutes(req, res, url, { getStateSnapshot = null } = {}) {
  if (req.method === 'GET' && url.pathname === '/hotspots') {
    getHotspots({
      force: /^(1|true|yes)$/i.test(url.searchParams.get('refresh') || ''),
      viewed: /^(1|true|yes)$/i.test(url.searchParams.get('viewed') || ''),
    })
      .then((hotspots) => jsonResponse(res, 200, hotspots))
      .catch((err) => jsonResponse(res, 502, {
        ok: false,
        error: err.message,
        refreshMinutes: 30,
        platforms: {},
      }))
    return true
  }

  if (req.method === 'GET' && url.pathname === '/hotspot-events') {
    getHotspotEvents({
      force: /^(1|true|yes)$/i.test(url.searchParams.get('refresh') || ''),
    })
      .then((events) => jsonResponse(res, 200, events))
      .catch((err) => jsonResponse(res, 502, {
        ok: false,
        error: err.message,
        refreshMinutes: 15,
        events: [],
      }))
    return true
  }

  if (url.pathname === '/hotspot-state') {
    if (req.method === 'GET') {
      jsonResponse(res, 200, { ok: true, state: getHotspotPanelState() })
      return true
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const active = parseBooleanish(body.active)
        const state = setHotspotPanelState({ active, source: body.source || 'brain-ui' })
        jsonResponse(res, 200, { ok: true, state })
      } catch (err) {
        jsonResponse(res, 400, { ok: false, error: err.message })
      }
      return true
    }
  }

  if (req.method === 'GET' && url.pathname === '/worldcup') {
    getWorldcup({
      force: /^(1|true|yes)$/i.test(url.searchParams.get('refresh') || ''),
      viewed: /^(1|true|yes)$/i.test(url.searchParams.get('viewed') || ''),
    })
      .then((worldcup) => jsonResponse(res, 200, worldcup))
      .catch((err) => jsonResponse(res, 502, {
        ok: false,
        error: err.message,
        matches: [],
        standings: {},
      }))
    return true
  }

  if (url.pathname === '/worldcup-state') {
    if (req.method === 'GET') {
      jsonResponse(res, 200, { ok: true, state: getWorldcupPanelState() })
      return true
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const active = parseBooleanish(body.active)
        const state = setWorldcupPanelState({ active, source: body.source || 'brain-ui' })
        jsonResponse(res, 200, { ok: true, state })
      } catch (err) {
        jsonResponse(res, 400, { ok: false, error: err.message })
      }
      return true
    }
  }

  if (req.method === 'GET' && url.pathname === '/typhoons') {
    getTyphoons({
      force: /^(1|true|yes)$/i.test(url.searchParams.get('refresh') || ''),
      viewed: /^(1|true|yes)$/i.test(url.searchParams.get('viewed') || ''),
    })
      .then((typhoons) => jsonResponse(res, 200, typhoons))
      .catch((err) => jsonResponse(res, 502, { ok: false, error: err.message, typhoons: [], refreshMinutes: 10 }))
    return true
  }

  if (url.pathname === '/typhoon-state') {
    if (req.method === 'GET') {
      jsonResponse(res, 200, { ok: true, state: getTyphoonPanelState() })
      return true
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const state = setTyphoonPanelState({ active: parseBooleanish(body.active), source: body.source || 'brain-ui' })
        jsonResponse(res, 200, { ok: true, state })
      } catch (err) {
        jsonResponse(res, 400, { ok: false, error: err.message })
      }
      return true
    }
  }

  if (url.pathname === '/doc-panel-state') {
    if (req.method === 'GET') {
      jsonResponse(res, 200, { ok: true, state: getDocPanelState() })
      return true
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const active = parseBooleanish(body.active)
        const state = setDocPanelState({ active, topicId: body.topicId || null, source: body.source || 'brain-ui' })
        jsonResponse(res, 200, { ok: true, state })
      } catch (err) {
        jsonResponse(res, 400, { ok: false, error: err.message })
      }
      return true
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/docs/')) {
    const topicId = url.pathname.slice(6)
    const doc = DOC_TOPICS[topicId]
    if (!doc) {
      jsonResponse(res, 404, { ok: false, error: `unknown topic: ${topicId}` })
      return true
    }
    jsonResponse(res, 200, { ok: true, doc })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/docs') {
    const topics = Object.values(DOC_TOPICS).map(({ id, title, subtitle, icon, summary }) => ({ id, title, subtitle, icon, summary }))
    jsonResponse(res, 200, { ok: true, topics })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/person-card') {
    const name = url.searchParams.get('name') || url.searchParams.get('q') || ''
    jsonResponse(res, 200, { ok: true, card: getPersonCard(name) })
    return true
  }

  if (url.pathname === '/person-card-state') {
    if (req.method === 'GET') {
      jsonResponse(res, 200, { ok: true, state: getPersonCardPanelState() })
      return true
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const active = parseBooleanish(body.active)
        const state = setPersonCardPanelState({
          active,
          source: body.source || 'brain-ui',
          card: body.card || null,
          name: body.name || '',
        })
        jsonResponse(res, 200, { ok: true, state })
      } catch (err) {
        jsonResponse(res, 400, { ok: false, error: err.message })
      }
      return true
    }
  }

  if (url.pathname === '/knowledge-panel-state') {
    if (req.method === 'GET') {
      jsonResponse(res, 200, { ok: true, state: getKnowledgePanelState() })
      return true
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const state = setKnowledgePanelState({
          active: parseBooleanish(body.active),
          source: body.source || 'brain-ui',
          regionId: body.region_id ?? body.regionId,
          query: body.query,
          documentId: body.document_id ?? body.documentId,
        })
        jsonResponse(res, 200, { ok: true, state })
      } catch (err) {
        jsonResponse(res, 400, { ok: false, error: err.message })
      }
      return true
    }
  }

  if (req.method === 'GET' && url.pathname === '/system-prompt-preview') {
    Promise.resolve()
      .then(() => buildHeartbeatSystemPromptPreview({
        stateSnapshot: typeof getStateSnapshot === 'function' ? getStateSnapshot() : {},
      }))
      .then((preview) => jsonResponse(res, 200, preview))
      .catch((err) => jsonResponse(res, 500, { error: err.message }))
    return true
  }

  if (req.method === 'GET' && url.pathname === '/agent-profile') {
    jsonResponse(res, 200, { name: getAgentName() })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/environment-panel') {
    jsonResponse(res, 200, {
      ok: true,
      agentName: getAgentName(),
      ...getGeoWeatherSnapshot(),
      serverTime: new Date().toISOString(),
    })
    return true
  }

  return false
}
