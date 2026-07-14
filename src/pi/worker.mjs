// Pi SDK turn-engine WORKER。必须在【系统 node】下运行（父进程 child_process.fork 时
// execPath=系统 node），不能在 Electron 主进程 / utilityProcess 里——那些用 Electron 自带的
// Node，缺 webidl.util.markAsUncloneable，Pi SDK 自带的 undici websocket 层会崩。
// 见 learned skill: electron-runtime-isolation。
//
// 工具执行（executeTool）需要 BaiLongma 运行时（db/sandbox，Electron-bound，本进程没有），
// 故 worker 经 IPC RPC 回调父进程执行；本进程只跑 Pi 的 LLM 流式 + 工具循环编排。
import {
  createAgentSession, SessionManager, AuthStorage, ModelRegistry,
  DefaultResourceLoader, getAgentDir, defineTool,
} from '@earendil-works/pi-coding-agent'
import { getModel } from '@earendil-works/pi-ai'
import { toToolDefinition } from './tool-transform.js'
import { getToolSchemas } from '../capabilities/schemas.js'

let _runtime = null   // { auth, registry, loader }
function getRuntime(apiKey) {
  if (_runtime) return _runtime
  const auth = AuthStorage.create()
  auth.setRuntimeApiKey('minimax-cn', apiKey)
  const registry = ModelRegistry.create(auth)
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    systemPromptOverride: () => '你是 Jarvis 助手。',
  })
  _runtime = { auth, registry, loader }
  return _runtime
}

// 待回复的工具执行 RPC：reqId → resolve
const pendingRpc = new Map()
let reqCounter = 0
let currentTurnId = null
function rpcExecTool(name, params) {
  const reqId = ++reqCounter
  return new Promise(resolve => {
    pendingRpc.set(reqId, resolve)
    process.send({ type: 'exec_tool_req', reqId, turnId: currentTurnId, name, params })
  })
}

// schema → Pi customTool；execute 走 RPC 回父进程（父进程跑真实 executeTool）
function buildTools(toolNames) {
  const schemas = getToolSchemas(toolNames)
  const tools = []
  for (const s of schemas) {
    try {
      const def = toToolDefinition(s, null, (n, p) => rpcExecTool(n, p))
      tools.push(defineTool(def))
    } catch (e) {
      process.send?.({ type: 'log', level: 'warn', msg: `[pi-worker] 跳过工具 ${s?.function?.name || '?'}: ${e.message}` })
    }
  }
  return tools
}

async function runPrompt(msg) {
  const { id, systemPrompt, message, tools, modelId, apiKey, delivery } = msg
  currentTurnId = id
  try {
    const { auth, registry, loader } = getRuntime(apiKey)
    const model = getModel('minimax-cn', modelId) || registry.find('minimax-cn', modelId)
    if (!model) { process.send({ type: 'error', id, message: `getModel("minimax-cn","${modelId}") null` }); return }
    await loader.reload()
    const customTools = buildTools(tools)
    const { session } = await createAgentSession({
      model, authStorage: auth, modelRegistry: registry,
      tools: [...tools], customTools,
      sessionManager: SessionManager.inMemory(), resourceLoader: loader,
    })
    session.agent.state.systemPrompt = (systemPrompt || '你是 Jarvis 助手。')
      + (delivery?.mustReply && !delivery?.silentSignal
        ? '\n\n[运行时约束] 完成任何工具操作后，必须向用户给出简短中文回复：本地渠道（TUI/API/语音）直接写正文即可送达（无需 send_message）；社交渠道才调 send_message。绝不能在一轮里只调工具而不回复用户。'
        : '')

    let content = ''
    let modelSent = false
    let streamStarted = false
    const stop = () => { if (streamStarted) { streamStarted = false; process.send({ type: 'stream_end', id }) } }

    session.subscribe(e => {
      const t = e?.type
      if (t === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') {
        if (!streamStarted) { streamStarted = true; process.send({ type: 'stream_start', id }) }
        process.send({ type: 'stream_chunk', id, text: e.assistantMessageEvent.delta })
      } else if (t === 'tool_execution_start') {
        process.send({ type: 'tool_exec', id, name: e.toolName })
      } else if (t === 'tool_execution_end') {
        if (e.toolName === 'send_message' && !e.isError) modelSent = true
        process.send({ type: 'tool_result', id, name: e.toolName, isError: !!e.isError })
      }
    })

    try {
      await session.prompt(typeof message === 'string' ? message : String(message || ''))
    } finally { stop() }

    // 收集本轮正文
    try {
      const msgs = session.messages || []
      const last = msgs[msgs.length - 1]
      content = typeof last?.content === 'string' ? last.content
        : (Array.isArray(last?.content) ? last.content.map(b => b?.text || '').join('') : '')
    } catch { /* 正文已通过 stream_chunk 流回 */ }

    // 投递兜底（与 callLLM 同契约）：RPC send_message 回父进程执行
    let delivered = modelSent
    if (delivery?.mustReply && !delivered && content && !delivery.silentSignal) {
      const r = await rpcExecTool('send_message', { target_id: delivery.targetId ?? null, content })
      delivered = !/^(错误|执行失败)/.test(String(r).trim())
      process.send({ type: 'tool_result', id, name: 'send_message', isError: !delivered, fallback: true })
    }

    process.send({ type: 'end', id, content, delivered, aborted: false })
    try { session.dispose?.() } catch { /* 清理 */ }
  } catch (e) {
    process.send({ type: 'error', id, message: e?.message || String(e), stack: e?.stack })
  } finally {
    currentTurnId = null
  }
}

process.on('message', msg => {
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'prompt') {
    runPrompt(msg)   // 一次一个 turn（app 侧 queue 串行化）
  } else if (msg.type === 'exec_tool_res') {
    const resolve = pendingRpc.get(msg.reqId)
    if (resolve) { pendingRpc.delete(msg.reqId); resolve(msg.result) }
  } else if (msg.type === 'abort') {
    currentTurnId = null   // 最小中断：完整 session.abort 见 Slice 3
  } else if (msg.type === 'ping') {
    process.send({ type: 'pong', pid: process.pid, node: process.version })
  }
})

process.send({ type: 'ready', pid: process.pid, node: process.version })
