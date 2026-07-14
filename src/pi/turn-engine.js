// Pi SDK 内层 turn-engine（worker 隔离版）。暴露与 src/llm.js callLLM 相同的 callback 面，
// 让 src/index.js runTurn 按 config.turnEngine 无缝分流（pi → runPiTurn，llm → callLLM）。
//
// ⚠️ Pi SDK 不能在 Electron 主进程 / utilityProcess 直接跑（Electron 自带 Node 缺
//   webidl.util.markAsUncloneable，Pi 自带的 undici websocket 层会崩）。故本模块 fork 一个
//   【系统 node】子进程跑 worker.mjs（= smoke 环境），主进程经 IPC 驱动。
//   工具执行（executeTool）需 BaiLongma 运行时（db/sandbox，Electron-bound，worker 没有），
//   worker 经 exec_tool_req/res RPC 回调本进程执行。见 learned skill: electron-runtime-isolation。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fork, spawnSync } from 'node:child_process'
import { config } from '../config.js'
import { executeTool } from '../capabilities/executor.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKER_PATH = path.join(__dirname, 'worker.mjs')

let _child = null
let _turnSeq = 0
const pendingTurns = new Map()        // turnId → { resolve, reject, onStream, onToolCall, onToolExecute }
const toolContextByTurn = new Map()   // turnId → toolContext（工具执行时主进程用它）

function getMinimaxCnKey() {
  if (config.provider === 'minimax' && config.apiKey) return config.apiKey
  try {
    if (fs.existsSync('/tmp/pi-key')) {
      const k = fs.readFileSync('/tmp/pi-key', 'utf8').trim()
      if (k) return k
    }
  } catch { /* 忽略 */ }
  return process.env.MINIMAX_API_KEY || process.env.MINIMAX_CN_API_KEY || ''
}

function resolveModelId() {
  if (config.provider === 'minimax' && config.model) return config.model
  return process.env.PI_MODEL || 'MiniMax-M3'
}

// 临时止血(A)：pi 引擎当前只支持 minimax provider（minimax-cn 内置）。
// Slice 4 才把配置页的 7 个 provider 映射到 Pi ModelRegistry。非 minimax 时
// index.js 据此回退 llm 引擎并 warn，绝不静默用 minimax 顶替用户配置的 provider。
export function isPiSupportedForConfig() {
  return config.provider === 'minimax'
}

// 找系统 node（Pi SDK 需系统 node 运行时；Electron 自带的不行）。macOS GUI 进程 PATH 常缺失 node。
function findNodeBin() {
  const candidates = [
    process.env.JARVIS_NODE_BIN,
    'node',
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    path.join(process.env.HOME || '', '.local/bin/node'),
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-v'], { timeout: 3000 })
      if (r.status === 0 && /v\d+\./.test(String(r.stdout))) return c
    } catch { /* 试下一个 */ }
  }
  return null
}

// worker 的 cwd=项目根，让 bare import '@earendil-works/...' 解析到 node_modules。
function projectRoot() {
  return path.resolve(__dirname, '..', '..')
}

function safeSend(msg) { try { _child?.send?.(msg) } catch { /* 通道关闭 */ } }

function onChildMessage(m) {
  if (!m || typeof m !== 'object') return

  // 工具执行 RPC：主进程跑 executeTool（持有 BaiLongma 运行时），结果回 worker
  if (m.type === 'exec_tool_req') {
    const ctx = toolContextByTurn.get(m.turnId) || {}
    Promise.resolve(executeTool(m.name, m.params || {}, ctx))
      .then(result => {
        const text = typeof result === 'string' ? result : JSON.stringify(result)
        safeSend({ type: 'exec_tool_res', reqId: m.reqId, result: text })
      })
      .catch(err => {
        safeSend({ type: 'exec_tool_res', reqId: m.reqId, result: `执行失败：${err.message}` })
      })
    return
  }
  if (m.type === 'ready') { console.log(`[pi] worker ready · node ${m.node} · pid ${m.pid}`); return }
  if (m.type === 'log') { (m.level === 'warn' ? console.warn : console.log)(m.msg); return }
  if (m.type === 'pong') { return }

  // turn 事件，按 turnId 分发
  const turn = pendingTurns.get(m.id)
  if (!turn) return
  switch (m.type) {
    case 'stream_start': turn.onStream?.({ event: 'start', mode: 'text' }); break
    case 'stream_chunk': turn.onStream?.({ event: 'chunk', mode: 'text', text: m.text }); break
    case 'stream_end': turn.onStream?.({ event: 'end', mode: 'text' }); break
    case 'tool_exec':
      turn.onStream?.({ event: 'tool_preparing', name: m.name })
      turn.onToolExecute?.(m.name)
      break
    case 'tool_result':
      turn.onToolCall?.(m.name, m.fallback ? { __fallback: true } : {}, m.isError ? '执行失败：pi tool error' : 'ok')
      break
    case 'end':
      pendingTurns.delete(m.id); toolContextByTurn.delete(m.id)
      turn.resolve({ content: m.content || '', toolResult: null, aborted: !!m.aborted, delivered: !!m.delivered })
      break
    case 'error':
      pendingTurns.delete(m.id); toolContextByTurn.delete(m.id)
      turn.reject(new Error(`[pi-worker] ${m.message}`))
      break
  }
}

function getChild() {
  if (_child && !_child.killed && _child.exitCode === null && _child.signalCode === null) return _child
  const nodeBin = findNodeBin()
  if (!nodeBin) throw new Error('[pi] 找不到系统 node（Pi SDK 需系统 node 运行时）。设 JARVIS_NODE_BIN 或把 node 放进 PATH。')
  console.log(`[pi] 启动 worker · ${nodeBin} ${WORKER_PATH}`)
  _child = fork(WORKER_PATH, [], {
    execPath: nodeBin,
    cwd: projectRoot(),
    env: { ...process.env },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  })
  _child.on('message', onChildMessage)
  _child.on('exit', (code, sig) => {
    console.warn(`[pi] worker exited · code=${code} sig=${sig}`)
    _child = null
    for (const [, t] of pendingTurns) t.reject(new Error('[pi] worker 进程退出'))
    pendingTurns.clear(); toolContextByTurn.clear()
  })
  _child.on('error', err => { console.error('[pi] worker error:', err.message); _child = null })
  return _child
}

// 与 callLLM 同构的回调面；返回 runTurn 读取的 { content, toolResult, aborted, delivered }。
export async function runPiTurn({
  systemPrompt, message, messages = null, tools = [], temperature, thinking,
  signal, toolContext = {}, onStream, onToolCall, onToolExecute, onRetry,
  mustReply = false, silentSignal = false, localReply = false,
} = {}) {
  const apiKey = getMinimaxCnKey()
  if (!apiKey) throw new Error('[pi] 无 minimax key（config.apiKey / /tmp/pi-key / MINIMAX_API_KEY）')
  const modelId = resolveModelId()
  const child = getChild()
  const id = ++_turnSeq
  toolContextByTurn.set(id, toolContext)
  const delivery = {
    mustReply, silentSignal, localReply,
    targetId: toolContext.currentTargetId || toolContext.currentExternalPartyId || null,
  }
  console.log(`[pi] turn 开始 · model=${modelId} · tools=[${tools.join(',')}] · worker=ipc`)

  return new Promise((resolve, reject) => {
    pendingTurns.set(id, { resolve, reject, onStream, onToolCall, onToolExecute })

    safeSend({
      type: 'prompt', id,
      systemPrompt,
      message: typeof message === 'string' ? message : String(message || ''),
      tools, modelId, apiKey, delivery,
    })

    // 最小中断：signal abort → 立即按 aborted 解决（worker 后续 end 因 entry 已删被忽略）。完整中断见 Slice 3。
    if (signal) {
      const onAbort = () => {
        if (pendingTurns.has(id)) {
          pendingTurns.delete(id); toolContextByTurn.delete(id)
          safeSend({ type: 'abort', id })
          resolve({ content: '', toolResult: null, aborted: true, delivered: false })
        }
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
