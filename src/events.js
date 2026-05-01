// 内部事件总线：SSE 客户端管理 + 事件广播
const sseClients = new Set()

export function addSSEClient(res) {
  sseClients.add(res)
}

export function removeSSEClient(res) {
  sseClients.delete(res)
}

export function emitEvent(type, data) {
  if (sseClients.size === 0) return
  const payload = JSON.stringify({ type, data, ts: new Date().toISOString() })
  for (const res of sseClients) {
    try {
      res.write(`data: ${payload}\n\n`)
    } catch (_) {
      sseClients.delete(res)
    }
  }
}

// ACUI 通道：双向 ws 客户端集合
const acuiClients = new Set()

// 服务端存活卡片追踪：{ id → { component, mountedAt } }
const activeUICards = new Map()

export function addActiveUICard(id, meta = {}) {
  activeUICards.set(id, { ...meta, mountedAt: Date.now() })
}

export function removeActiveUICard(id) {
  activeUICards.delete(id)
}

export function getActiveUICards() {
  return [...activeUICards.entries()].map(([id, m]) => ({ id, ...m }))
}

export function addACUIClient(ws) {
  acuiClients.add(ws)
}

export function removeACUIClient(ws) {
  acuiClients.delete(ws)
}

export function hasACUIClient() {
  return acuiClients.size > 0
}

// 推送一条 ui.command（mount/update/unmount）到所有 ACUI 客户端
export function emitUICommand(payload) {
  if (acuiClients.size === 0) return false
  const msg = JSON.stringify({ v: 1, kind: 'ui.command', ...payload })
  for (const ws of acuiClients) {
    try { ws.send(msg) } catch (_) { acuiClients.delete(ws) }
  }
  return true
}

// 推送通用 ACUI 控制事件（如 acui:reload），由 client.js 路由
export function emitACUIEvent(kind, payload = {}) {
  if (acuiClients.size === 0) return false
  const msg = JSON.stringify({ v: 1, kind, ...payload })
  for (const ws of acuiClients) {
    try { ws.send(msg) } catch (_) { acuiClients.delete(ws) }
  }
  return true
}
