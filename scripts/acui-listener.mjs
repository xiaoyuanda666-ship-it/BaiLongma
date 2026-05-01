// 常驻 ACUI 监听器：连接 /acui，把所有收到的 ui.command 帧打印到 stdout，每行一个 JSON
import { WebSocket } from 'ws'

const url = 'ws://127.0.0.1:3721/acui'
const ttlMs = parseInt(process.argv[2] || '30000', 10)
const ws = new WebSocket(url)

const deadline = setTimeout(() => {
  console.log(JSON.stringify({ kind: 'listener.exit', reason: 'ttl' }))
  try { ws.close() } catch {}
  process.exit(0)
}, ttlMs)

ws.on('open', () => {
  console.log(JSON.stringify({ kind: 'listener.open' }))
})

ws.on('message', (raw) => {
  const text = raw.toString()
  let msg
  try { msg = JSON.parse(text) } catch { console.log(JSON.stringify({ kind: 'listener.nonjson', raw: text })); return }
  if (msg.kind === 'ui.command') {
    console.log(JSON.stringify({ kind: 'listener.ui_command', op: msg.op, id: msg.id, component: msg.component, props: msg.props }))
  } else if (msg.kind === 'ping') {
    try { ws.send(JSON.stringify({ v: 1, kind: 'pong' })) } catch {}
  } else if (msg.kind === 'acui:hello') {
    console.log(JSON.stringify({ kind: 'listener.hello' }))
  }
})

ws.on('error', (e) => {
  console.log(JSON.stringify({ kind: 'listener.error', message: e.message }))
  clearTimeout(deadline)
  process.exit(2)
})

ws.on('close', () => {
  console.log(JSON.stringify({ kind: 'listener.close' }))
})
