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
