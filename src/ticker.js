// Ticker：L2 自主调节 tick 节奏的机制
//
// 设计：
// - L2 通过 set_tick_interval 工具指定 { seconds, ttl }
// - seconds ∈ [0, 36000]，ttl ∈ [1, 100]，越界 clamp
// - 每次成功完成的自主 TICK 后 ttl--；用户/后台消息和中断/失败不消耗
// - 优先级低于"有消息(0)"和"429 限流"，高于"有任务(30s)"和"空闲默认"

import { emitEvent } from './events.js'

const MIN_SECONDS = 0
const MAX_SECONDS = 36000
const MIN_TTL = 1
const MAX_TTL = 100

const state = {
  intervalMs: null,
  ttl: 0,
  reason: '',
  setAt: null,
  revision: 0,
}

function clampSeconds(n) {
  n = Number(n)
  if (!Number.isFinite(n)) return null
  return Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, Math.round(n)))
}

function clampTtl(n) {
  n = Number(n)
  if (!Number.isFinite(n)) return 10
  return Math.max(MIN_TTL, Math.min(MAX_TTL, Math.round(n)))
}

// L2 调节节奏。返回 { ok, seconds, ttl, clampedFrom, noop? } 供工具回包
export function setCustomInterval({ seconds, ttl, reason = '' }) {
  const s = clampSeconds(seconds)
  if (s === null) return { ok: false, error: 'seconds 必须是数字' }
  const t = clampTtl(ttl)
  const clampedFrom = {}
  if (s !== seconds) clampedFrom.seconds = seconds
  if (t !== ttl) clampedFrom.ttl = ttl

  // Wave 1 优化：idempotent 化。
  //   实测 log 显示模型每个 TICK 都重复调一次相同参数的 set_tick_interval
  //   （"节奏已设为 120s，持续 30 轮"），每次都重置 ttl 让节奏永远不衰减，
  //   同时浪费一轮 LLM。判定：当前已经是相同 intervalMs 且仍在生效（ttl > 0）→ noop。
  //   ttl 不重置——让自然衰减带模型回到"无定制"状态，避免它自己反复延长。
  if (state.intervalMs === s * 1000 && state.ttl > 0) {
    console.log(`[Ticker] 节奏已是 ${s}s（剩 ${state.ttl} 轮），重复调用判为 noop`)
    return {
      ok: true,
      seconds: s,
      ttl: state.ttl,  // 返回当前剩余，不刷新
      clampedFrom,
      noop: true,
    }
  }

  state.intervalMs = s * 1000
  state.ttl = t
  state.reason = String(reason || '').slice(0, 80)
  state.setAt = Date.now()
  state.revision++

  emitEvent('ticker_set', { seconds: s, ttl: t, reason: state.reason, clampedFrom })
  console.log(`[Ticker] L2 设置节奏：${s}s × ${t} 轮（${state.reason || '无理由'}）`)

  return { ok: true, seconds: s, ttl: t, clampedFrom }
}

// scheduleNextTick 用：取当前生效的自定义间隔（ms），无则返回 null
export function getCustomIntervalMs() {
  return state.ttl > 0 ? state.intervalMs : null
}

// 成功的自主 TICK 结束后调：消耗一轮 TTL
export function consumeTick() {
  if (state.ttl <= 0) return
  state.ttl--
  if (state.ttl === 0) {
    const expired = { seconds: state.intervalMs / 1000, reason: state.reason }
    state.intervalMs = null
    state.reason = ''
    state.setAt = null
    emitEvent('ticker_expired', expired)
    console.log(`[Ticker] 自定义节奏到期，恢复默认`)
  }
}

export function getStatus() {
  return {
    active: state.ttl > 0,
    seconds: state.intervalMs ? state.intervalMs / 1000 : null,
    ttl: state.ttl,
    reason: state.reason,
    revision: state.revision,
  }
}

export function reset() {
  state.intervalMs = null
  state.ttl = 0
  state.reason = ''
  state.setAt = null
  state.revision++
}
