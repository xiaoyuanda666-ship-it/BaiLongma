// Ticker：L2 自主调节 tick 节奏的机制
//
// 设计：
// - L2 通过 set_tick_interval 工具指定 { seconds, ttl }
// - seconds ∈ [2, 3600]，ttl ∈ [1, 50]，越界 clamp
// - 每次 onTick 执行后 ttl--，到 0 自动回归默认节奏
// - 优先级低于"有消息(0)"和"429 限流"，高于"有任务(2s)"和"空闲默认"

import { emitEvent } from './events.js'

const MIN_SECONDS = 2
const MAX_SECONDS = 3600
const MIN_TTL = 1
const MAX_TTL = 50

const state = {
  intervalMs: null,
  ttl: 0,
  reason: '',
  setAt: null,
}

function clampSeconds(n) {
  n = Number(n)
  if (!Number.isFinite(n)) return null
  return Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, Math.round(n)))
}

function clampTtl(n) {
  n = Number(n)
  if (!Number.isFinite(n) || n <= 0) return 10
  return Math.max(MIN_TTL, Math.min(MAX_TTL, Math.round(n)))
}

// L2 调节节奏。返回 { ok, seconds, ttl, clampedFrom } 供工具回包
export function setCustomInterval({ seconds, ttl, reason = '' }) {
  const s = clampSeconds(seconds)
  if (s === null) return { ok: false, error: 'seconds 必须是数字' }
  const t = clampTtl(ttl)
  const clampedFrom = {}
  if (s !== seconds) clampedFrom.seconds = seconds
  if (t !== ttl) clampedFrom.ttl = ttl

  state.intervalMs = s * 1000
  state.ttl = t
  state.reason = String(reason || '').slice(0, 80)
  state.setAt = Date.now()

  emitEvent('ticker_set', { seconds: s, ttl: t, reason: state.reason, clampedFrom })
  console.log(`[Ticker] L2 设置节奏：${s}s × ${t} 轮（${state.reason || '无理由'}）`)

  return { ok: true, seconds: s, ttl: t, clampedFrom }
}

// scheduleNextTick 用：取当前生效的自定义间隔（ms），无则返回 null
export function getCustomIntervalMs() {
  return state.ttl > 0 ? state.intervalMs : null
}

// onTick 结束后调：消耗一轮 TTL
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
  }
}

export function reset() {
  state.intervalMs = null
  state.ttl = 0
  state.reason = ''
  state.setAt = null
}
