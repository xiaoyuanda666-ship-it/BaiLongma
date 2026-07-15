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
let currentSession = null    // 当前活跃 session，供 abort 真正中断 session.prompt()
let currentAborted = false   // 本轮是否已 abort——abort 后跳过投递兜底，不再发 send_message
const RPC_TIMEOUT_MS = 60000  // 单次工具执行 RPC 超时——防止父进程不回 res 时 worker 永久挂起
function rpcExecTool(name, params) {
  const reqId = ++reqCounter
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (pendingRpc.has(reqId)) {
        pendingRpc.delete(reqId)
        resolve('执行失败：工具执行 RPC 超时（父进程 60s 未响应）')
      }
    }, RPC_TIMEOUT_MS)
    timer.unref?.()
    pendingRpc.set(reqId, (result) => {
      clearTimeout(timer)
      resolve(result)
    })
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
  currentAborted = false
  try {
    const { auth, registry, loader } = getRuntime(apiKey)
    const model = getModel('minimax-cn', modelId) || registry.find('minimax-cn', modelId)
    if (!model) { process.send({ type: 'error', id, message: `getModel("minimax-cn","${modelId}") null` }); return }
    await loader.reload()
    const customTools = buildTools(tools)
    const { session } = await createAgentSession({
      model, authStorage: auth, modelRegistry: registry,
      // noTools:'builtin' 显式关闭 Pi 内置工具（read/bash/edit/write）——
      // BaiLongma 自己提供全部工具（customTools），不应让 Pi 的内置 shell 工具混入，
      // 否则模型会绕过 BaiLongma 的沙箱/审计直接拿到一个无约束的 bash。
      // （修复前 `tools:[...tools]` 被当作「内置工具白名单」，而我们传的是自己的工具名，
      //  语义错配且无效；customTools 才是真正的注册入口。）
      noTools: 'builtin', customTools,
      sessionManager: SessionManager.inMemory(), resourceLoader: loader,
    })
    currentSession = session
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
    } catch (e) {
      // session.abort() 会让进行中的 prompt 抛出——视为中断而非错误
      if (!currentAborted) throw e
    } finally { stop() }

    // 收集本轮正文（abort 后 messages 里可能只有部分内容）
    try {
      const msgs = session.messages || []
      const last = msgs[msgs.length - 1]
      content = typeof last?.content === 'string' ? last.content
        : (Array.isArray(last?.content) ? last.content.map(b => b?.text || '').join('') : '')
    } catch { /* 正文已通过 stream_chunk 流回 */ }

    // abort 后不再投递：用户已主动停止，绝不在后台再发 send_message
    let delivered = modelSent
    if (currentAborted) {
      delivered = false
    } else if (delivery?.mustReply && !delivered && content && !delivery.silentSignal) {
      const r = await rpcExecTool('send_message', { target_id: delivery.targetId ?? null, content })
      delivered = !/^(错误|执行失败)/.test(String(r).trim())
      process.send({ type: 'tool_result', id, name: 'send_message', isError: !delivered, fallback: true })
    }

    process.send({ type: 'end', id, content, delivered, aborted: currentAborted })
    try { session.dispose?.() } catch { /* 清理 */ }
  } catch (e) {
    process.send({ type: 'error', id, message: e?.message || String(e), stack: e?.stack })
  } finally {
    currentTurnId = null
    currentSession = null
  }
}

process.on('message', msg => {
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'prompt') {
    runPrompt(msg)   // 一次一个 turn（app 侧 queue 串行化）
  } else if (msg.type === 'exec_tool_res') {
    const settle = pendingRpc.get(msg.reqId)
    if (settle) { pendingRpc.delete(msg.reqId); settle(msg.result) }
  } else if (msg.type === 'abort') {
    // 真正中断：调 session.abort() 让进行中的 prompt 抛出并停止（修复前只清 currentTurnId，
    // session.prompt 仍在后台跑工具/流式，abort 形同虚设）。abort 后投递兜底被 currentAborted 守卫跳过。
    currentAborted = true
    currentTurnId = null
    if (currentSession) {
      currentSession.abort?.().catch(() => { /* abort 失败不阻塞；prompt 路径仍会因 currentAborted 提前结束 */ })
    }
  } else if (msg.type === 'ping') {
    process.send({ type: 'pong', pid: process.pid, node: process.version })
  }
})

process.send({ type: 'ready', pid: process.pid, node: process.version })
