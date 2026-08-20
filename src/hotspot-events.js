import crypto from 'crypto'
import { getHotspots, readHotspotConfig } from './hotspots.js'

const DEFAULT_REFRESH_MINUTES = 15
const DEFAULT_TIMEOUT_MS = 10000
const USER_AGENT = 'Bailongma/1.0 (+https://localhost)'
const PLATFORM_ORDER = ['douyin', 'xiaohongshu', 'wechat', 'weibo']
const PLATFORM_LABELS = {
  douyin: '抖音',
  xiaohongshu: '小红书',
  wechat: '微信热点',
  weibo: '微博',
}

function normalizeTitle(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 160)
}

function eventId(title = '') {
  const normalized = normalizeTitle(title) || String(title || '')
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16)
  return `hotspot_event_${hash}`
}

function stringValue(value) {
  return value == null ? '' : String(value).trim()
}

function validHttpUrl(value) {
  const raw = stringValue(value)
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : ''
  } catch {
    return ''
  }
}

function formatHotness(value) {
  const raw = stringValue(value)
  if (!raw || raw === '0') return ''
  const numeric = Number(raw)
  if (!Number.isFinite(numeric)) return raw
  if (numeric >= 100000000) return `${(numeric / 100000000).toFixed(numeric >= 1000000000 ? 1 : 2).replace(/\.0+$/, '')}亿`
  if (numeric >= 10000) return `${Math.round(numeric / 10000)}万`
  return String(numeric)
}

export function inferHotspotCategory(text = '') {
  const value = String(text || '')
  const rules = [
    ['自然灾害', /(地震|台风|暴雨|洪水|山火|海啸|泥石流|灾害|气象预警)/i],
    ['体育', /(足球|篮球|网球|乒乓|奥运|世界杯|联赛|比赛|夺冠|运动员|全运会|亚运会)/i],
    ['财经', /(股市|股票|基金|金融|财经|经济|油价|金价|汇率|银行|融资|市值|关税)/i],
    ['科技', /(人工智能|\bAI\b|芯片|科技|机器人|华为|苹果|小米|互联网|航天|卫星|大模型)/i],
    ['健康', /(医疗|医院|医生|疾病|病毒|疫苗|健康|药品|传染病)/i],
    ['政策', /(政策|法案|监管|国务院|条例|新规|立法|外交部|商务部|教育部)/i],
    ['文娱', /(电影|电视剧|演唱会|音乐|演员|歌手|综艺|票房|明星)/i],
    ['旅游', /(旅游|景区|游客|航班|酒店|文旅)/i],
  ]
  return rules.find(([, pattern]) => pattern.test(value))?.[0] || '社会'
}

function pickNetworkHotItems(data) {
  if (data?.code != null && Number(data.code) !== 200) {
    throw new Error(`TianAPI 业务错误 ${data.code}: ${stringValue(data.msg) || '未知错误'}`)
  }
  const candidates = [
    data?.result?.list,
    data?.result?.newslist,
    data?.result?.data,
    data?.newslist,
    data?.data?.list,
    data?.data,
    data?.list,
    data?.result,
  ]
  return candidates.find(Array.isArray) || []
}

export function normalizeNetworkHotEvents(data, { fetchedAt = new Date().toISOString() } = {}) {
  const seen = new Set()
  return pickNetworkHotItems(data)
    .map((item) => {
      const title = stringValue(item?.title || item?.name || item?.word || item?.keyword)
      const key = normalizeTitle(title)
      if (!title || !key || seen.has(key)) return null
      seen.add(key)
      const summary = stringValue(item?.digest || item?.description || item?.summary)
      return {
        id: eventId(title),
        title,
        summary,
        category: inferHotspotCategory(`${title} ${summary}`),
        categoryDerived: true,
        publishedAt: null,
        fetchedAt,
        location: null,
        source: 'TianAPI 全网热搜',
        sourceUrl: validHttpUrl(item?.url || item?.link),
        hotness: formatHotness(item?.hotnum ?? item?.heat ?? item?.hot_value),
        platforms: [],
      }
    })
    .filter(Boolean)
    .slice(0, 50)
}

export function aggregateHotspotPlatformEvents(hotspots = {}) {
  const fetchedAt = stringValue(hotspots?.fetchedAt) || new Date().toISOString()
  const merged = new Map()

  for (const platform of PLATFORM_ORDER) {
    const items = Array.isArray(hotspots?.platforms?.[platform]) ? hotspots.platforms[platform] : []
    for (const [index, item] of items.entries()) {
      const title = stringValue(item?.title || item?.text || item?.word)
      const key = normalizeTitle(title)
      if (!title || !key) continue
      const rank = Number(item?.rank || index + 1) || index + 1
      const existing = merged.get(key)
      if (existing) {
        if (!existing.platforms.includes(platform)) existing.platforms.push(platform)
        existing.bestRank = Math.min(existing.bestRank, rank)
        if (!existing.sourceUrl) existing.sourceUrl = validHttpUrl(item?.url)
        if (!existing.hotness) existing.hotness = formatHotness(item?.heat)
        continue
      }
      merged.set(key, {
        id: eventId(title),
        title,
        summary: '',
        category: inferHotspotCategory(title),
        categoryDerived: true,
        publishedAt: null,
        fetchedAt,
        location: null,
        source: '',
        sourceUrl: validHttpUrl(item?.url),
        hotness: formatHotness(item?.heat),
        platforms: [platform],
        bestRank: rank,
      })
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.platforms.length - a.platforms.length || a.bestRank - b.bestRank)
    .map(({ bestRank, ...event }) => ({
      ...event,
      source: event.platforms.map(platform => PLATFORM_LABELS[platform] || platform).join(' / '),
    }))
    .slice(0, 50)
}

async function fetchJson(url, options = {}) {
  const res = await globalThis.fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json,text/plain,*/*',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('返回内容不是 JSON')
  }
}

async function loadNetworkHotEvents({ fetchedAt }) {
  const config = readHotspotConfig()
  if (!config.tianapiKey) throw new Error('未配置 TianAPI key')
  const data = await fetchJson(`https://apis.tianapi.com/networkhot/index?key=${encodeURIComponent(config.tianapiKey)}`)
  const events = normalizeNetworkHotEvents(data, { fetchedAt })
  if (!events.length) throw new Error('TianAPI 全网热搜返回空数据')
  return {
    events,
    source: 'tianapi-networkhot',
    sourceLabel: 'TianAPI 全网热搜',
    fetchedAt,
    stale: false,
  }
}

async function loadPlatformFallbackEvents() {
  const hotspots = await getHotspots()
  const events = aggregateHotspotPlatformEvents(hotspots)
  if (!events.length) throw new Error('四平台热榜没有可用事件')
  return {
    events,
    source: 'hotspot-platforms',
    sourceLabel: '四平台真实热榜',
    fetchedAt: hotspots.fetchedAt || new Date().toISOString(),
    stale: !!hotspots.stale,
  }
}

function sourceStatus(ok, extra = {}) {
  return { ok, ...extra }
}

export function createHotspotEventService({
  loadPrimary = loadNetworkHotEvents,
  loadFallback = loadPlatformFallbackEvents,
  now = () => Date.now(),
  refreshMinutes = DEFAULT_REFRESH_MINUTES,
} = {}) {
  let cache = null
  let cacheStoredAtMs = 0
  let inFlight = null

  const normalizedRefreshMinutes = Math.max(5, Math.min(24 * 60, Number(refreshMinutes) || DEFAULT_REFRESH_MINUTES))

  function isCacheFresh() {
    return !!cache && now() - cacheStoredAtMs < normalizedRefreshMinutes * 60 * 1000
  }

  async function fetchLatest() {
    const checkedAt = new Date(now()).toISOString()
    const status = {}
    try {
      const result = await loadPrimary({ fetchedAt: checkedAt })
      if (!Array.isArray(result?.events) || !result.events.length) throw new Error('主事件源返回空数据')
      status.primary = sourceStatus(true, { source: result.source || 'primary', count: result.events.length })
      status.fallback = sourceStatus(false, { skipped: true })
      return {
        ok: true,
        refreshMinutes: normalizedRefreshMinutes,
        fetchedAt: result.fetchedAt || checkedAt,
        checkedAt,
        stale: !!result.stale,
        source: result.source || 'primary',
        sourceLabel: result.sourceLabel || result.events[0]?.source || result.source || 'primary',
        events: result.events,
        status,
      }
    } catch (err) {
      status.primary = sourceStatus(false, { error: err.message })
    }

    try {
      const result = await loadFallback({ fetchedAt: checkedAt })
      if (!Array.isArray(result?.events) || !result.events.length) throw new Error('降级事件源返回空数据')
      status.fallback = sourceStatus(true, { source: result.source || 'fallback', count: result.events.length })
      return {
        ok: true,
        refreshMinutes: normalizedRefreshMinutes,
        fetchedAt: result.fetchedAt || checkedAt,
        checkedAt,
        stale: !!result.stale,
        source: result.source || 'fallback',
        sourceLabel: result.sourceLabel || result.source || 'fallback',
        events: result.events,
        status,
      }
    } catch (err) {
      status.fallback = sourceStatus(false, { error: err.message })
      const error = new Error(`主事件源：${status.primary.error}；降级事件源：${err.message}`)
      error.status = status
      throw error
    }
  }

  async function getHotspotEvents({ force = false } = {}) {
    if (!force && isCacheFresh()) return cache
    if (inFlight) return inFlight

    inFlight = fetchLatest()
      .then((result) => {
        cache = result
        cacheStoredAtMs = now()
        return result
      })
      .catch((err) => {
        if (cache) {
          return {
            ...cache,
            checkedAt: new Date(now()).toISOString(),
            stale: true,
            error: err.message,
            status: err.status || cache.status,
          }
        }
        throw err
      })
      .finally(() => {
        inFlight = null
      })

    return inFlight
  }

  return { getHotspotEvents }
}

const defaultService = createHotspotEventService()

export function getHotspotEvents(options = {}) {
  return defaultService.getHotspotEvents(options)
}
