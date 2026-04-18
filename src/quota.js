/**
 * 配额管理器
 *
 * 文本生成限制（MiniMax 标准层）：
 *   RPM: 500 次/分钟
 *   TPM: 20,000,000 tokens/分钟
 *   策略：滑动窗口（60秒）追踪实际消耗，自适应调整 TICK 间隔
 *
 * 多模态每日限制：
 *   TTS: 4000 次/天
 *   音乐: 100 次/天
 *   歌词: 100 次/天
 *   图像: 50 次/天
 */

const LIMITS = {
  RPM: 500,
  TPM: 20_000_000,
}

// 滑动窗口记录，每条：{ ts: ms, tokens: number }
const window = []

const WINDOW_MS = 60 * 1000

function pruneWindow() {
  const cutoff = Date.now() - WINDOW_MS
  while (window.length > 0 && window[0].ts < cutoff) {
    window.shift()
  }
}

// 记录一次调用的 token 消耗
export function recordUsage(tokens) {
  pruneWindow()
  window.push({ ts: Date.now(), tokens })
}

// 获取当前窗口内的用量
export function getWindowUsage() {
  pruneWindow()
  const requests = window.length
  const tokens = window.reduce((s, e) => s + e.tokens, 0)
  return { requests, tokens }
}

// 获取当前用量百分比（取 RPM 和 TPM 中较高的）
export function getUsageRatio() {
  const { requests, tokens } = getWindowUsage()
  const rpmRatio = requests / LIMITS.RPM
  const tpmRatio = tokens / LIMITS.TPM
  return Math.max(rpmRatio, tpmRatio)
}

// 429 rate-limited 状态
let rateLimitedUntil = 0  // ms 时间戳，0 表示未限流

export function setRateLimited() {
  rateLimitedUntil = Date.now() + 10 * 60 * 1000  // 10 分钟后解除
  console.log('[配额] 429 rate-limited，TICK 间隔切换为 10 分钟')
}

export function clearRateLimit() {
  if (rateLimitedUntil > 0) {
    rateLimitedUntil = 0
    console.log('[配额] rate-limit 已解除，恢复正常 TICK 间隔')
  }
}

export function isRateLimited() {
  if (rateLimitedUntil === 0) return false
  if (Date.now() >= rateLimitedUntil) {
    clearRateLimit()
    return false
  }
  return true
}

// 根据用量动态计算建议的 TICK 间隔（ms）
export function getAdaptiveTickInterval(baseInterval = 20000) {
  if (isRateLimited()) return 10 * 60 * 1000  // 429 限流中，10 分钟

  const ratio = getUsageRatio()

  if (ratio > 0.90) return 120_000   // 接近限制，大幅放缓
  if (ratio > 0.80) return 40_000    // 偏高，放缓
  if (ratio > 0.60) return baseInterval  // 正常
  if (ratio > 0.30) return 12_000    // 用量较低，适度加快
  return 8_000                       // 用量很低，积极探索
}

// 是否应该等待（超过 95% 时拒绝调用）
export function shouldThrottle() {
  return getUsageRatio() > 0.95
}

export function getTickInterval(baseInterval = 300000) {
  if (isRateLimited()) return 10 * 60 * 1000
  return baseInterval
}

// ── 每日用量追踪 ──

const DAILY_LIMITS = { tts: 4000, music: 100, lyrics: 100, image: 50 }
const dailyUsage = {}   // { capability: { date: 'YYYY-MM-DD', count: number } }

function todayDate() {
  return new Date().toLocaleDateString('sv-SE')  // YYYY-MM-DD
}

export function recordDailyUsage(capability, count = 1) {
  const today = todayDate()
  if (!dailyUsage[capability] || dailyUsage[capability].date !== today) {
    dailyUsage[capability] = { date: today, count: 0 }
  }
  dailyUsage[capability].count += count
}

export function getDailyUsage(capability) {
  const today = todayDate()
  const entry = dailyUsage[capability]
  if (!entry || entry.date !== today) return 0
  return entry.count
}

export function isDailyLimitReached(capability) {
  const limit = DAILY_LIMITS[capability]
  if (!limit) return false
  return getDailyUsage(capability) >= limit
}

// ── 状态汇总 ──

export function getQuotaStatus(baseInterval = 300000) {
  const { requests, tokens } = getWindowUsage()
  const ratio = getUsageRatio()
  const daily = {}
  for (const [cap, limit] of Object.entries(DAILY_LIMITS)) {
    const used = getDailyUsage(cap)
    daily[cap] = { used, limit, ratio: ((used / limit) * 100).toFixed(1) + '%' }
  }
  return {
    requests,
    tokens,
    rpmUsed: `${requests}/${LIMITS.RPM}`,
    tpmUsed: `${tokens}/${LIMITS.TPM}`,
    ratio: (ratio * 100).toFixed(1) + '%',
    tickInterval: getTickInterval(baseInterval),
    daily,
  }
}
