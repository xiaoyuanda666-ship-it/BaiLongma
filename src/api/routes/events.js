import { addSSEClient, flushStickyEvents, removeSSEClient } from '../../events.js'
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
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(`data: ${JSON.stringify({ type: 'connected', ts: new Date().toISOString() })}\n\n`)
    flushStickyEvents(res)
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
