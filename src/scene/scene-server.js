// Scene 传输层 —— /scene WebSocket。
//
// 职责:管理已连接的 shell、把 SceneStore 的变更广播成协议消息(scene / scene.patch)、
// 处理上行的 hello / resync / intent / pong。声明式 Agent-UI 的唯一 UI 通道。
// 协议见仓库根目录 SCENE-PROTOCOL.md。

import { sceneStore } from './scene-store.js'

const clients = new Set()   // 每个元素:{ ws, ready } —— ready 在收到 hello 后置 true

function send(ws, msg) {
  try { ws.send(JSON.stringify(msg)) } catch { /* 连接已断,close 处理器会清理 */ }
}

// 订阅 store 变更,转成协议消息广播给所有已就绪 shell。整个进程只订阅一次。
let subscribed = false
function ensureSubscribed() {
  if (subscribed) return
  subscribed = true
  sceneStore.subscribe(({ rev, op }) => {
    // upsert / remove 走增量补丁;其他(如 clear)回退为全量快照。
    const msg = (op.op === 'upsert' || op.op === 'remove')
      ? { v: 1, type: 'scene.patch', rev, base: rev - 1, ops: [op] }
      : sceneStore.snapshot()
    for (const c of clients) {
      if (c.ready) send(c.ws, msg)
    }
  })
}

// intent 上行处理器,由 api.js 注入(负责落库 / 推进 agent 队列)。
let onIntent = null
export function setSceneIntentHandler(fn) { onIntent = fn }

// 由 api.js 在 /scene WebSocket 'connection' 时调用。
export function handleSceneConnection(ws) {
  ensureSubscribed()
  const client = { ws, ready: false }
  clients.add(client)

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (!msg || msg.v !== 1) return   // 忽略未知版本

    switch (msg.type) {
      case 'hello':
        // 握手:标记就绪,回 welcome + 全量快照,使 shell 与真相源对齐。
        client.ready = true
        send(ws, { v: 1, type: 'welcome', rev: sceneStore.rev })
        send(ws, sceneStore.snapshot())
        break
      case 'resync':
        // shell 检测到漏帧 / 初始化:重发全量快照。
        send(ws, sceneStore.snapshot())
        break
      case 'intent':
        // dismiss 是用户对顶层 surface 的直接关闭意图：由真相源移除，
        // 再广播 remove patch，保持所有界面客户端一致，而不是只在点击端隐藏 DOM。
        if (msg.name === 'dismiss' && typeof msg.surface === 'string' && msg.surface) {
          sceneStore.set(msg.surface, null)
        }
        if (onIntent) { try { onIntent(msg) } catch { /* 处理器出错不影响连接 */ } }
        break
      case 'pong':
        break
      default:
        break   // 未知 type 忽略(向前兼容)
    }
  })

  ws.on('close', () => clients.delete(client))
  ws.on('error', () => clients.delete(client))
}

// 已就绪的 shell 数量(供工具 / 诊断使用)。
export function sceneClientCount() {
  let n = 0
  for (const c of clients) if (c.ready) n++
  return n
}
