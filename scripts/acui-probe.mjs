// ACUI ws 通道探针：连接 /acui，期望 acui:hello，发一条 ui.signal，2s 后退出
import { WebSocket } from 'ws'

const url = 'ws://127.0.0.1:3721/acui'
const ws = new WebSocket(url)
let gotHello = false

const timer = setTimeout(() => {
  console.log(JSON.stringify({ ok: false, reason: 'timeout', gotHello }))
  process.exit(2)
}, 5000)

ws.on('open', () => {
  console.log('[probe] open')
})

ws.on('message', (raw) => {
  const text = raw.toString()
  console.log('[probe] recv:', text)
  let msg
  try { msg = JSON.parse(text) } catch { return }
  if (msg.kind === 'acui:hello') {
    gotHello = true
    ws.send(JSON.stringify({
      v: 1,
      kind: 'ui.signal',
      type: 'card.dismissed',
      target: 'probe-card',
      payload: { by: 'probe', dwell_ms: 1234 },
      ts: Date.now(),
    }))
    console.log('[probe] sent ui.signal')
    setTimeout(() => {
      console.log(JSON.stringify({ ok: true, gotHello }))
      clearTimeout(timer)
      ws.close()
      process.exit(0)
    }, 800)
  }
})

ws.on('error', (e) => {
  console.log('[probe] error:', e.message)
  clearTimeout(timer)
  process.exit(3)
})

ws.on('close', () => {
  console.log('[probe] closed')
})
