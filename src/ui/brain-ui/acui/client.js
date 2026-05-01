import { initRenderer, mount, update, unmount, patch, reloadRegistry } from './renderer.js'

let socket = null
let reconnectDelay = 1000
const MAX_RECONNECT = 8000

export async function startACUI({ wsUrl, hostElement }) {
  await initRenderer(hostElement, sendSignal)
  connect(wsUrl)
}

function connect(wsUrl) {
  try {
    socket = new WebSocket(wsUrl)
  } catch (e) {
    scheduleReconnect(wsUrl)
    return
  }

  socket.addEventListener('open', () => {
    reconnectDelay = 1000
    console.log('[ACUI] 连接成功')
  })

  socket.addEventListener('message', (event) => {
    let msg
    try { msg = JSON.parse(event.data) } catch { return }
    if (!msg || msg.v !== 1) return

    if (msg.kind === 'ui.command') {
      if (msg.op === 'mount')   mount(msg)
      else if (msg.op === 'update')  update(msg)
      else if (msg.op === 'unmount') unmount(msg.id, 'agent')
      else if (msg.op === 'patch')   patch(msg)
    } else if (msg.kind === 'ping') {
      try { socket.send(JSON.stringify({ v: 1, kind: 'pong' })) } catch {}
    } else if (msg.kind === 'acui:hello') {
      // welcome, no-op
    } else if (msg.kind === 'acui:reload') {
      reloadRegistry()
    }
  })

  socket.addEventListener('close', () => scheduleReconnect(wsUrl))
  socket.addEventListener('error', () => { try { socket.close() } catch {} })
}

function scheduleReconnect(wsUrl) {
  setTimeout(() => connect(wsUrl), reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT)
}

function sendSignal({ type, target, payload }) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  try {
    socket.send(JSON.stringify({
      v: 1,
      kind: 'ui.signal',
      type,
      target: target || null,
      payload: payload || {},
      ts: Date.now()
    }))
  } catch {}
}
