import {
  addSSEClient,
  flushEventsSince,
  flushStickyEvents,
  getLatestEventId,
  removeSSEClient,
} from '../../events.js'
import { getBrainUiEventHistory } from '../../db.js'
import { getTerminalStreamSnapshot } from '../../terminal-stream.js'
import { jsonResponse } from '../utils.js'

export async function handleEventRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/events/history') {
    const requestedPath = url.searchParams.get('path')
    const path = requestedPath === 'all'
      ? 'all'
      : (requestedPath === 'l1' || requestedPath === 'l3' ? requestedPath : 'l2')
    const limit = Number(url.searchParams.get('limit') || 160)
    jsonResponse(res, 200, { ok: true, ...getBrainUiEventHistory({ path, limit }) })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    const clientId = String(url.searchParams.get('client_id') || '').trim()
    const lastEventId = Number(
      url.searchParams.get('last_event_id')
      || req.headers['last-event-id']
      || 0,
    ) || 0
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(`data: ${JSON.stringify({
      type: 'connected',
      data: {
        client_id: clientId,
        resumed_from_event_id: lastEventId,
        latest_event_id: getLatestEventId(),
      },
      ts: new Date().toISOString(),
    })}\n\n`)
    flushStickyEvents(res)
    const replay = flushEventsSince(res, lastEventId)
    if (lastEventId > 0) {
      console.log(
        `[SSE] client=${clientId || 'unknown'} reconnect from=${lastEventId}`
        + ` replayed=${replay.replayed} oldest=${replay.oldestEventId || 0}`
        + ` latest=${replay.latestEventId || getLatestEventId()}`,
      )
    }
    addSSEClient(res)
    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n') } catch (_) { clearInterval(keepAlive); removeSSEClient(res) }
    }, 15000)
    req.on('close', () => {
      clearInterval(keepAlive)
      removeSSEClient(res)
    })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/terminal-stream/history') {
    const streamId = url.searchParams.get('stream_id') || 'default'
    jsonResponse(res, 200, getTerminalStreamSnapshot(streamId))
    return true
  }

  return false
}
