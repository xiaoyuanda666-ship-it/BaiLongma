// 回合上下文追踪器（Turn Trace）
//
// 目的：诊断"agent 把自己说的话和用户说的话搞混"这类**生成层**问题。要看清根因，必须能
// 还原模型每一轮实际看到的 Responses input Items 以及它的思考、正文与工具调用。
// 本模块就是这条取证通道：callLLM 在每个 turn 把这些原样记下来，
// 后台页面 /turn-trace 逐回合回放。
//
// 设计要点：
//   - messages 在一个 turn 内是**严格 append-only**（callLLM 只对它 push，从不 splice/删除）。
//     因此一个 turn 只需在结束时深拷贝一次最终 messages，再为每一轮记录它开始时的 offset，
//     前端用 messages.slice(0, offset) 即可精确还原"第 K 轮看到的上下文"。省内存、无重复大 system。
//   - 任何异常都不能影响主流程：所有入口 try/catch 包裹，失败静默。
//   - 内存环形缓冲（最近 MAX_TURNS 个 turn）+ 轻量 JSONL 落盘，重启后仍可回看最近的 turn。

import fs from 'fs'
import path from 'path'
import { paths } from '../paths.js'

const MAX_TURNS = 80                       // 内存里保留的最近 turn 数
const FILE_MAX_BYTES = 12 * 1024 * 1024   // JSONL 落盘文件上限，超过就用当前环形缓冲重写

const TRACE_FILE = path.join(paths.dataDir, 'turn-traces.jsonl')

let traces = []   // 环形缓冲，最新的在末尾
let seq = 0
let enabled = true
let loaded = false

function capText(value) {
  const s = typeof value === 'string' ? value : (value == null ? '' : String(value))
  return { text: s, truncated: 0 }
}

function safeParseArgs(raw) {
  if (raw == null) return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch { return { __raw: String(raw) } }
}

function responseItemText(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return value == null ? '' : String(value)
  return value
    .map(part => typeof part === 'string' ? part : (part?.text || part?.content || ''))
    .filter(Boolean)
    .join('')
}

// 把一条原始 message 转成可序列化、带上限的快照。保留 role 与原文（role 错配正是要查的东西）。
function snapshotMessage(m) {
  if (!m || typeof m !== 'object') return { role: 'unknown', content: '' }
  const out = { role: m.role || m.type || 'unknown' }
  if (m.type) out.type = m.type
  if (m.id) out.id = m.id
  if (m.call_id) out.call_id = m.call_id
  if (typeof m.name === 'string') out.name = m.name
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id
  const { text, truncated } = capText(responseItemText(m.content))
  out.content = text
  if (truncated) out.truncated = truncated
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    out.tool_calls = m.tool_calls.map(tc => ({
      name: tc?.function?.name || tc?.name || '?',
      args: safeParseArgs(tc?.function?.arguments ?? tc?.arguments),
    }))
  }
  if (m.reasoning_content) out.reasoning_content = capText(m.reasoning_content).text
  if (m.type === 'function_call') {
    out.tool_calls = [{ name: m.name || '?', args: safeParseArgs(m.arguments) }]
  }
  if (m.type === 'function_call_output') out.content = capText(m.output || '').text
  if (m.type === 'reasoning') {
    out.reasoning_content = [m.content, m.summary]
      .flat()
      .filter(Boolean)
      .map(part => part?.text || '')
      .join('')
  }
  return out
}

function sanitizeMeta(meta = {}) {
  const pick = (v, n = 200) => (v == null ? null : String(v).slice(0, n))
  return {
    label: pick(meta.label, 60) || 'turn',
    channel: pick(meta.channel, 40),
    fromId: pick(meta.fromId, 80),
    targetId: pick(meta.targetId, 80),
    userMessage: meta.userMessage == null ? null : String(meta.userMessage),
    silentSignal: !!meta.silentSignal,
    localReply: !!meta.localReply,
    mustReply: !!meta.mustReply,
    outputContract: pick(meta.outputContract, 40),
    tools: Array.isArray(meta.tools) ? meta.tools.slice(0, 80) : [],
  }
}

function pushTrace(t) {
  traces.push(t)
  if (traces.length > MAX_TURNS) traces = traces.slice(-MAX_TURNS)
}

function ensureLoaded() {
  if (loaded) return
  loaded = true
  try {
    if (!fs.existsSync(TRACE_FILE)) return
    const lines = fs.readFileSync(TRACE_FILE, 'utf-8').split('\n').filter(Boolean)
    const tail = lines.slice(-MAX_TURNS)
    for (const line of tail) {
      try { traces.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
    }
    if (traces.length) seq = traces[traces.length - 1].seq || traces.length
  } catch { /* 落盘读取失败不影响运行 */ }
}

function persist(t) {
  try {
    fs.appendFileSync(TRACE_FILE, JSON.stringify(t) + '\n', 'utf-8')
    // 文件过大时用当前内存环形缓冲整体重写，把历史裁到最近 MAX_TURNS
    const size = fs.statSync(TRACE_FILE).size
    if (size > FILE_MAX_BYTES) {
      const body = traces.map(x => JSON.stringify(x)).join('\n') + '\n'
      fs.writeFileSync(TRACE_FILE, body, 'utf-8')
    }
  } catch { /* 落盘失败静默 */ }
}

const NULL_HANDLE = {
  recordRound() {},
  end() {},
}

// 开启一个 turn 的追踪。返回 handle，callLLM 用它逐轮记录、结束时收尾。
export function beginTurn(meta) {
  if (!enabled) return NULL_HANDLE
  ensureLoaded()
  try {
    const t = {
      id: `t${Date.now().toString(36)}_${++seq}`,
      seq,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      meta: sanitizeMeta(meta),
      rounds: [],
      messages: [],   // 结束时填充最终 messages 的深拷贝快照
      delivered: false,
      aborted: false,
      error: null,
    }
    pushTrace(t)

    let ended = false
    return {
      // 每一轮模型调用后记录：该轮开始时 messages 的长度（offset）+ 模型本轮输出。
      recordRound({ round, inputOffset, content, reasoningContent, toolCalls, aborted } = {}) {
        try {
          t.rounds.push({
            round: round ?? t.rounds.length,
            inputOffset: inputOffset ?? null,
            content: capText(content || '').text,
            reasoningContent: capText(reasoningContent || '').text,
            toolCalls: Array.isArray(toolCalls)
              ? toolCalls.map(tc => ({ name: tc?.name || '?', args: safeParseArgs(tc?.arguments ?? tc?.args) }))
              : [],
            aborted: !!aborted,
          })
        } catch { /* 记录失败静默 */ }
      },
      // turn 结束：快照最终 messages（前端据 inputOffset 还原每轮上下文），收尾并落盘。
      end({ messages, delivered, aborted, error } = {}) {
        if (ended) return
        ended = true
        try {
          if (Array.isArray(messages)) t.messages = messages.map(snapshotMessage)
          t.delivered = !!delivered
          t.aborted = !!aborted
          t.error = error ? String(error).slice(0, 500) : null
          t.finishedAt = new Date().toISOString()
          persist(t)
        } catch { /* 收尾失败静默 */ }
      },
    }
  } catch {
    return NULL_HANDLE
  }
}

function summarize(t) {
  // 取一个有信息量的预览：最后一条 assistant 正文 > 第一条 user 正文 > 用户消息 meta
  let preview = ''
  for (let i = t.rounds.length - 1; i >= 0; i--) {
    if (t.rounds[i].content) { preview = t.rounds[i].content; break }
  }
  if (!preview) preview = t.meta?.userMessage || ''
  const roleRibbon = (t.messages || []).map(m => (m.role || m.type || '?')[0].toUpperCase()).join('')
  return {
    id: t.id,
    seq: t.seq,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    meta: t.meta,
    roundCount: t.rounds.length,
    messageCount: (t.messages || []).length,
    roleRibbon,
    delivered: t.delivered,
    aborted: t.aborted,
    error: t.error,
    preview,
  }
}

export function getTraces(limit = 80) {
  ensureLoaded()
  const n = Math.max(1, Math.min(limit, MAX_TURNS))
  return traces.slice(-n).reverse().map(summarize)
}

export function getTrace(id) {
  ensureLoaded()
  return traces.find(t => t.id === id) || null
}

export function clearTraces() {
  traces = []
  try { fs.existsSync(TRACE_FILE) && fs.unlinkSync(TRACE_FILE) } catch {}
  return { ok: true }
}

export function setTraceEnabled(on) {
  enabled = !!on
  return { enabled }
}

export function getTraceStatus() {
  ensureLoaded()
  return { enabled, count: traces.length, maxTurns: MAX_TURNS }
}
