// 记忆识别器的去抖调度层。
//
// 问题：原本每个 turn 结束都同步唤起一次 recognizer LLM 调用去问"有啥要记的吗"，
// 而实测绝大多数轮（尤其 L2 TICK 心跳）的答案都是 skip——等于每轮花一次 LLM 调用
// 只为得到"没有"。
//
// 方案：不预筛内容（漏记是最贵的错误，语义判断仍全权交给 recognizer），只把"每轮一次"
// 摊薄成"一批一次"。turn 进缓冲区，满足任一条件才 flush 跑一次批量 recognizer：
//   - 空闲 IDLE_FLUSH_MS：对话/心跳停了，攒着的一起处理
//   - 攒满 MAX_BATCH：避免缓冲区无界增长
//   - 最久等 MAX_WAIT_MS：连续来料（心跳不断）时的兜底上限
//   - 本轮用过"产出耐久信息"的工具：立即 flush，避免快速退出丢失硬挣来的结论
//
// recognizer 仍然看到每一轮的全部内容，不丢信息——只是合并成更少的调用。
// "立即 flush"只影响时机、不影响是否运行/看到什么，故不属于"用浅规则 gate 能力"。

import { runRecognizerBatch } from './recognizer.js'

const IDLE_FLUSH_MS = 45_000      // 安静这么久就把攒着的批掉
const MAX_BATCH = 6               // 攒到这么多轮立即处理
const MAX_WAIT_MS = 180_000       // 最早一轮等待的硬上限（连续来料兜底）

// 仅用于决定"是否立即 flush"的时机优化——产出耐久外部信息的工具，结论值得尽快落库、
// 也防快速退出丢失。这是结构信号（工具名），不读消息正文，不改变 recognizer 是否运行。
const DURABLE_INFO_TOOLS = new Set(['web_search', 'fetch_url', 'browser_read', 'read_file', 'exec_command'])

const EXPLICIT_MEMORY_RE = /(?:记住|记一下|记得|别忘了|以后(?:你)?(?:要|记得|别|不要)?|保存(?:一下|到记忆)?|remember|keep in mind|note that|don't forget|do not forget)/i

let buffer = []
let idleTimer = null
let firstQueuedAt = 0
let resultHandler = null
let flushing = Promise.resolve()  // 串行化，避免并发批次交错

export function configureRecognizerScheduler({ onResult } = {}) {
  resultHandler = typeof onResult === 'function' ? onResult : null
}

function clearIdle() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
}

function turnHasDurableTool(turn) {
  return Array.isArray(turn?.toolCallLog)
    && turn.toolCallLog.some(t => DURABLE_INFO_TOOLS.has(t?.name) && t?.ok !== false)
}

function turnHasExplicitMemoryRequest(turn) {
  return EXPLICIT_MEMORY_RE.test(String(turn?.userMessage || ''))
}

// 立即把当前缓冲区作为一批跑掉。返回的 promise 在该批完成后 resolve。
export function flushRecognizer() {
  if (buffer.length === 0) return flushing
  const batch = buffer
  buffer = []
  firstQueuedAt = 0
  clearIdle()
  flushing = flushing.then(async () => {
    try {
      const memories = await runRecognizerBatch(batch)
      resultHandler?.(memories || [])
    } catch (err) {
      console.error('[recognizer-scheduler] 批量识别失败:', err?.message || err)
    }
  })
  return flushing
}

// 把一轮排进识别队列。fire-and-forget：不阻塞主对话。
export function enqueueTurnForRecognition(turn) {
  if (!turn) return
  buffer.push(turn)
  if (firstQueuedAt === 0) firstQueuedAt = Date.now()

  const waited = Date.now() - firstQueuedAt
  if (turnHasExplicitMemoryRequest(turn) || turnHasDurableTool(turn) || buffer.length >= MAX_BATCH || waited >= MAX_WAIT_MS) {
    flushRecognizer()
    return
  }

  // 重置空闲计时器：只要还在来料就往后推，停了 IDLE_FLUSH_MS 才掉这批
  clearIdle()
  idleTimer = setTimeout(() => flushRecognizer(), IDLE_FLUSH_MS)
  if (typeof idleTimer.unref === 'function') idleTimer.unref()  // 别因这个计时器吊住进程退出
}
