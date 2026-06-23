// Scene 端到端集成测试 —— 用真实 WebSocket 跑通 core 传输链(SCENE-PROTOCOL §2/§3/§8)。
//
// 覆盖:握手(hello→welcome→snapshot)、sceneStore 变更→scene.patch 广播(rev/base 正确)、
// resync→全量快照、intent 上行→处理器收到。用 scene-server.js 本体 + 真 ws 客户端,无 DB 依赖。
// 跑:`node src/scene/test-scene-e2e.js`(需要 ws 包,已是项目依赖)。

import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { sceneStore } from './scene-store.js'
import { handleSceneConnection, setSceneIntentHandler, sceneClientCount } from './scene-server.js'

let pass = 0, fail = 0
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}`) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 等待一条满足 predicate 的消息(带超时),返回该消息或 null。
function waitFor(inbox, predicate, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const start = Date.now()
    const tick = () => {
      const hit = inbox.find(predicate)
      if (hit) return resolve(hit)
      if (Date.now() - start > timeoutMs) return resolve(null)
      setTimeout(tick, 15)
    }
    tick()
  })
}

async function main() {
  // —— 起一个真 http + WebSocketServer,把 /scene 路由到 handleSceneConnection ——
  const intents = []
  setSceneIntentHandler((msg) => intents.push(msg))

  const server = http.createServer()
  const wss = new WebSocketServer({ noServer: true })
  wss.on('connection', (ws) => handleSceneConnection(ws))
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname === '/scene') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    } else socket.destroy()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  // —— 客户端连接 ——
  const inbox = []
  const client = new WebSocket(`ws://127.0.0.1:${port}/scene`)
  client.on('message', (raw) => { try { inbox.push(JSON.parse(raw.toString())) } catch {} })
  await new Promise((res, rej) => { client.on('open', res); client.on('error', rej) })

  // 1) 握手:发 hello → 收 welcome + 全量 scene
  client.send(JSON.stringify({ v: 1, type: 'hello', shell: 'test', caps: ['scene', 'patch'] }))
  const welcome = await waitFor(inbox, m => m.type === 'welcome')
  ok('收到 welcome', !!welcome && typeof welcome.rev === 'number')
  const snap = await waitFor(inbox, m => m.type === 'scene')
  ok('收到全量 scene 快照', !!snap && Array.isArray(snap.surfaces))
  await sleep(30)
  ok('服务端记录到 1 个就绪客户端', sceneClientCount() >= 1)

  // 2) sceneStore 变更 → 收到 scene.patch(upsert),rev/base 正确
  const revBefore = sceneStore.rev
  inbox.length = 0
  sceneStore.set('weather-bj', { kind: 'weather', data: { city: '北京', temp: 18 }, intent: 'inform' })
  const patch = await waitFor(inbox, m => m.type === 'scene.patch')
  ok('收到 scene.patch', !!patch)
  ok('patch.base = 变更前 rev', patch && patch.base === revBefore)
  ok('patch.rev = base + 1', patch && patch.rev === revBefore + 1)
  ok('patch 是 upsert 且带 surface', patch && patch.ops?.[0]?.op === 'upsert' && patch.ops[0].surface.id === 'weather-bj')
  ok('surface 经规范化(intent 保留)', patch && patch.ops[0].surface.intent === 'inform')

  // 3) remove → scene.patch(remove)
  inbox.length = 0
  sceneStore.set('weather-bj', null)
  const rmPatch = await waitFor(inbox, m => m.type === 'scene.patch')
  ok('收到 remove patch', !!rmPatch && rmPatch.ops?.[0]?.op === 'remove' && rmPatch.ops[0].id === 'weather-bj')

  // 4) resync → 重发全量快照
  inbox.length = 0
  client.send(JSON.stringify({ v: 1, type: 'resync', reason: 'gap' }))
  const resnap = await waitFor(inbox, m => m.type === 'scene')
  ok('resync 后收到全量快照', !!resnap && resnap.type === 'scene')

  // 5) intent 上行 → 处理器收到
  client.send(JSON.stringify({ v: 1, type: 'intent', surface: 'c1', name: 'select', data: { value: 'a' }, ts: Date.now() }))
  await sleep(60)
  const got = intents.find(i => i.name === 'select')
  ok('intent 上行被处理器收到', !!got && got.surface === 'c1' && got.data?.value === 'a')

  client.close()
  server.close()
  console.log(`\nScene e2e: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
