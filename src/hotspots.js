import fs from 'fs'
import crypto from 'crypto'
import { paths } from './paths.js'
import { upsertMemoryByMemId } from './db.js'
import { nowTimestamp } from './time.js'

const DEFAULT_REFRESH_MINUTES = 30
const HOTSPOT_CONTEXT_TTL_MINUTES = 60
const DEFAULT_TIMEOUT_MS = 10000
const USER_AGENT = 'Jarvis/1.0 (+https://localhost)'
const PUBLIC_HOTDATA_API_KEY = 'zIisgRZJLLXgqKCwBirNLegtNNRuL70eBsbHXPxEBWU='

const PLATFORM_ORDER = ['douyin', 'xiaohongshu', 'wechat', 'weibo']
const PLATFORM_LABELS = {
  douyin: '抖音',
  xiaohongshu: '小红书',
  wechat: '微信热点',
  weibo: '微博',
}

let cache = null
let inFlight = null
let panelActiveUntilMs = 0
let panelState = {
  active: false,
  updatedAtMs: 0,
  source: 'startup',
}

export function noteHotspotPanelViewed() {
  panelActiveUntilMs = Date.now() + HOTSPOT_CONTEXT_TTL_MINUTES * 60 * 1000
  setHotspotPanelState({ active: true, source: 'viewed' })
}

export function setHotspotPanelState({ active, source = 'unknown' } = {}) {
  if (typeof active !== 'boolean') return getHotspotPanelState()
  panelState = {
    active,
    updatedAtMs: Date.now(),
    source,
  }
  if (active) panelActiveUntilMs = Date.now() + HOTSPOT_CONTEXT_TTL_MINUTES * 60 * 1000
  return getHotspotPanelState()
}

export function getHotspotPanelState() {
  const now = Date.now()
  return {
    ...panelState,
    updatedAt: panelState.updatedAtMs ? new Date(panelState.updatedAtMs).toISOString() : null,
    contextActive: now < panelActiveUntilMs,
    contextTtlSeconds: Math.max(0, Math.round((panelActiveUntilMs - now) / 1000)),
  }
}

export function buildHotspotPanelStateContext() {
  const state = getHotspotPanelState()
  const status = state.active ? 'open' : 'closed'
  const ttl = state.contextActive ? `Hotspot context TTL has about ${Math.ceil(state.contextTtlSeconds / 60)} minutes remaining` : 'No active hotspot context TTL'
  return `## Hotspot Panel State
Current hotspot panel: ${status}. ${ttl}.
Use the hotspot_mode tool to open or close the hotspot panel only when display, demo, troubleshooting, or an explicit user request calls for it. Do not open it proactively for ordinary answers.`
}

function readHotspotConfig() {
  let stored = {}
  try {
    stored = JSON.parse(fs.readFileSync(paths.configFile, 'utf-8'))?.hotspots || {}
  } catch {}

  const refreshMinutes = Math.max(
    5,
    Math.min(24 * 60, Number(stored.refreshMinutes || process.env.HOTSPOT_REFRESH_MINUTES || DEFAULT_REFRESH_MINUTES) || DEFAULT_REFRESH_MINUTES)
  )

  const tianapiKey = String(stored.tianapiKey || process.env.TIANAPI_KEY || process.env.TIANAPI_DOUYIN_KEY || '').trim()

  return {
    provider: String(stored.provider || process.env.HOTSPOT_PROVIDER || 'auto').trim().toLowerCase(),
    refreshMinutes,
    tianapiKey,
    douyin: {
      url: String(stored.customDouyinUrl || process.env.HOTSPOT_DOUYIN_URL || '').trim(),
    },
    xiaohongshu: {
      url: String(stored.customXiaohongshuUrl || stored.customXhsUrl || process.env.HOTSPOT_XHS_URL || process.env.HOTSPOT_XIAOHONGSHU_URL || '').trim(),
      token: String(stored.tikhubToken || process.env.TIKHUB_TOKEN || process.env.HOTSPOT_TIKHUB_TOKEN || '').trim(),
    },
    hotdata: {
      key: String(stored.hotdataApiKey || process.env.HOTDATA_API_KEY || PUBLIC_HOTDATA_API_KEY || '').trim(),
    },
    wechat: {
      url: String(stored.customWechatUrl || process.env.HOTSPOT_WECHAT_URL || '').trim(),
      tianapiKey: String(stored.wechatTianapiKey || process.env.TIANAPI_WECHAT_KEY || tianapiKey || '').trim(),
    },
    weibo: {
      url: String(stored.customWeiboUrl || process.env.HOTSPOT_WEIBO_URL || '').trim(),
      tianapiKey: String(stored.weiboTianapiKey || process.env.TIANAPI_WEIBO_KEY || tianapiKey || '').trim(),
    },
  }
}

function isCacheFresh(now = Date.now()) {
  if (!cache?.fetchedAtMs) return false
  const ttlMs = cache.refreshMinutes * 60 * 1000
  return now - cache.fetchedAtMs < ttlMs
}

function isContextFresh(now = Date.now()) {
  if (!cache?.fetchedAtMs) return false
  const ttlMs = HOTSPOT_CONTEXT_TTL_MINUTES * 60 * 1000
  return now - cache.fetchedAtMs < ttlMs
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

function formatHeat(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value || '')
  if (n >= 100000000) return `${(n / 100000000).toFixed(n >= 1000000000 ? 1 : 2).replace(/\.0+$/, '')}亿`
  if (n >= 10000) return `${Math.round(n / 10000)}万`
  return String(n)
}

function labelText(label) {
  const value = String(label ?? '').trim()
  if (!value || value === '0') return ''
  const labels = {
    1: '热',
    3: '热',
    5: '荐',
    8: '新',
    16: '辟谣',
    17: '活动',
  }
  return labels[value] || value
}

function normalizeSearchText(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, '')
}

function hotspotTitle(item = {}) {
  return String(item.title || item.text || item.word || '').trim()
}

function extractHotspotKeywords(title = '') {
  const cleaned = String(title || '').replace(/[^\p{Script=Han}a-zA-Z0-9]+/gu, ' ').trim()
  const words = new Set()
  for (const part of cleaned.split(/\s+/).filter(Boolean)) {
    if (/^[a-zA-Z0-9]{3,}$/.test(part)) words.add(part.toLowerCase())
  }

  const compact = cleaned.replace(/\s+/g, '')
  for (let i = 0; i < compact.length - 1; i++) {
    for (let len = 2; len <= 5 && i + len <= compact.length; len++) {
      const token = compact.slice(i, i + len)
      if (/[\p{Script=Han}]/u.test(token)) words.add(token)
    }
  }

  return [...words].slice(0, 24)
}

function hotspotEventId(item = {}) {
  const platform = String(item.platform || 'hotspot')
  const title = normalizeSearchText(hotspotTitle(item)).slice(0, 80)
  const hash = crypto.createHash('sha1').update(`${platform}:${title || JSON.stringify(item)}`).digest('hex').slice(0, 12)
  return `hotspot_event_${hash}`
}

function platformLabel(platform) {
  return PLATFORM_LABELS[platform] || platform || '热点'
}

function getCurrentHotspotItems(perPlatformLimit = 20) {
  const items = []
  for (const platform of PLATFORM_ORDER) {
    const list = cache?.platforms?.[platform] || []
    if (Array.isArray(list)) items.push(...list.filter(item => hotspotTitle(item)).slice(0, perPlatformLimit))
  }
  return items
}

function formatFetchedAt(value) {
  if (!value) return '未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未知'
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatHotspotLines(items = []) {
  return items.map((item, idx) => {
    const rank = item.rank || idx + 1
    const heat = item.heat ? `（热度 ${item.heat}）` : ''
    return `${platformLabel(item.platform)} ${rank}. ${hotspotTitle(item)}${heat}`
  }).join('\n')
}

function matchHotspots(message = '', items = getCurrentHotspotItems(20)) {
  const normalizedMessage = normalizeSearchText(message)
  if (!normalizedMessage) return []
  const rawMessage = String(message || '')

  const matches = []
  for (const item of items) {
    const title = hotspotTitle(item)
    const normalizedTitle = normalizeSearchText(title)
    if (!normalizedTitle) continue
    const rank = Number(item.rank || 0)
    const platform = platformLabel(item.platform)
    const rankRef = rank > 0 && (
      new RegExp(`(热搜|热点|榜单|${platform}).{0,4}(第\\s*${rank}|${rank}\\s*(条|名|位))`).test(rawMessage) ||
      (rank === 1 && new RegExp(`(热搜|热点|榜单|${platform}).{0,4}(第一|榜一|第\\s*1|1\\s*(条|名|位))`).test(rawMessage))
    )

    const direct =
      normalizedMessage.includes(normalizedTitle) ||
      (normalizedTitle.length >= 4 && normalizedTitle.includes(normalizedMessage))

    const keywords = extractHotspotKeywords(title)
    const hitCount = keywords.filter(k => normalizedMessage.includes(normalizeSearchText(k))).length

    if (direct || rankRef || hitCount >= 2) {
      matches.push({ item, keywords: keywords.slice(0, 8), direct, rankRef, hitCount })
    }
  }

  return matches.slice(0, 5)
}

function persistMentionedHotspot(match, message = '') {
  const item = match?.item
  if (!item) return null

  const title = hotspotTitle(item)
  const memId = hotspotEventId(item)
  const timestamp = nowTimestamp()
  const concepts = [...new Set([title, platformLabel(item.platform), ...(match.keywords || [])])].filter(Boolean).slice(0, 16)
  const source = item.source || 'hotspot-api'
  const content = `The user mentioned a recent hotspot: ${title}`
  const detail = [
    `Hotspot source: ${source}`,
    `Platform: ${platformLabel(item.platform)}`,
    `Rank: ${item.rank || 'unknown'}`,
    item.heat ? `Heat: ${item.heat}` : '',
    item.tag ? `Tag: ${item.tag}` : '',
    item.url ? `Link: ${item.url}` : '',
    cache?.fetchedAt ? `Fetched at: ${cache.fetchedAt}` : '',
    `Trigger message excerpt: ${String(message || '').slice(0, 120)}`,
    'This is an automatically archived hotspot-event fact. If later conversation adds user preferences, judgments, or event progress, the agent may update the same mem_id with upsert_memory.',
  ].filter(Boolean).join('\n')

  return upsertMemoryByMemId({
    mem_id: memId,
    type: 'hotspot_event',
    title: `Hotspot event: ${title}`,
    content,
    detail,
    entities: ['SYSTEM'],
    concepts,
    tags: ['hotspot', 'hotspot_event', `platform:${item.platform || 'unknown'}`, `source:${source}`],
    source_ref: 'hotspot_context',
    timestamp,
  })
}

function contextPlatformBlocks() {
  const blocks = []
  for (const platform of PLATFORM_ORDER) {
    const items = (cache?.platforms?.[platform] || []).filter(item => hotspotTitle(item)).slice(0, 10)
    if (!items.length) continue
    const source = items[0]?.source || 'hotspot-api'
    blocks.push(`Current ${platformLabel(platform)} hot list (source: ${source}):\n${formatHotspotLines(items)}`)
  }
  return blocks.join('\n\n')
}

export function buildHotspotRuntimeContext(message = '') {
  if (!cache || !isContextFresh()) return ''

  const items = getCurrentHotspotItems(20)
  if (!items.length) return ''

  const matches = matchHotspots(message, items)
  const persisted = []
  for (const match of matches) {
    try {
      const result = persistMentionedHotspot(match, message)
      if (result?.mem_id) persisted.push(result.mem_id)
    } catch (err) {
      console.warn('[Hotspot] failed to auto-archive hotspot memory:', err.message)
    }
  }

  const shouldInjectPanelContext = Date.now() < panelActiveUntilMs
  if (!shouldInjectPanelContext && !matches.length) return ''

  const matchText = matches.length
    ? `\n\nThe current user message may have mentioned these recent hotspots:\n${formatHotspotLines(matches.map(m => m.item))}${persisted.length ? `\nAutomatically archived as long-term hotspot memories: ${persisted.join(', ')}` : ''}`
    : ''

  return `## Hotspot Context
Source: hotspot mode UI, automatically collected by the system. Sender: SYSTEM. Purpose: provide current environment background; this is not a user request.

The user recently opened the hotspot panel. The following hotspots are contextual references only. Do not proactively summarize them, do not treat them as user messages, and do not reply to the user solely because of this context.

Mention hotspots proactively only when one of these is true:
- The hotspot is directly related to the user's current question, task, or topic.
- The hotspot contains an urgent risk, major change, or high-priority information that clearly needs the user's attention.
- The user explicitly asks about hotspots, trending searches, or what is happening now.

Fetched at: ${formatFetchedAt(cache.fetchedAt)}${cache.stale ? ', partly cached data' : ''}
Current hotspot panel: ${getHotspotPanelState().active ? 'open' : 'closed'}; after the panel opens, a multi-platform hotspot impression is retained for the most recent ${HOTSPOT_CONTEXT_TTL_MINUTES} minutes. Current injection scope is Top 10 per platform; automatic matching and persistence candidates use Top 20 per platform.

${contextPlatformBlocks()}${matchText}`
}

function pickArray(data) {
  if (Array.isArray(data)) return data
  const candidates = [
    data?.result,
    data?.data,
    data?.newslist,
    data?.list,
    data?.result?.list,
    data?.data?.list,
    data?.data?.items,
    data?.data?.data,
    data?.data?.data?.items,
    data?.data?.hot_list,
    data?.data?.hotList,
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate
  }
  return []
}

function normalizeItems(platform, rawItems, source) {
  const list = Array.isArray(rawItems) ? rawItems : []
  return list
    .map((item, idx) => {
      const title = item?.word || item?.hotword || item?.sentence || item?.title || item?.name || item?.keyword || item?.query || item?.text || item?.display_query || ''
      if (!String(title).trim()) return null
      const tag = labelText(item?.label ?? item?.sentence_tag ?? item?.tag ?? item?.type)
      return {
        platform,
        rank: Number(item?.position || item?.rank || item?.index || idx + 1),
        title: String(title).trim(),
        heat: formatHeat(item?.hot_value ?? item?.hotValue ?? item?.hotwordnum ?? item?.heat ?? item?.score ?? item?.views ?? item?.view_count ?? item?.num ?? ''),
        tag,
        trend: 'same',
        isNew: tag === '新' || item?.is_new === true || item?.isNew === true,
        url: item?.url || item?.share_url || item?.link || item?.jump_url || '',
        source,
      }
    })
    .filter(Boolean)
    .slice(0, 50)
}

async function fetchCustomPlatform(platform, url) {
  if (!url) throw new Error(`缺少 ${platformLabel(platform)} 自定义热榜地址`)
  const data = await fetchJson(url)
  const items = normalizeItems(platform, pickArray(data), 'custom')
  if (!items.length) throw new Error('自定义热榜返回空数据')
  return items
}

async function fetchTianapi(platform, apiName, key) {
  if (!key) throw new Error('缺少 TianAPI key')
  const data = await fetchJson(`https://apis.tianapi.com/${apiName}/index?key=${encodeURIComponent(key)}`)
  const items = normalizeItems(platform, pickArray(data), 'tianapi')
  if (!items.length) throw new Error('TianAPI 返回空热榜')
  return items
}

async function fetchHaotechsDouyin() {
  const data = await fetchJson('https://www.haotechs.cn/ljh-wx/api/douyinHot')
  const items = normalizeItems('douyin', pickArray(data), 'haotechs')
  if (!items.length) throw new Error('haotechs 返回空热榜')
  return items
}

async function fetchXxapi(platform, apiName) {
  const data = await fetchJson(`https://v2.xxapi.cn/api/${apiName}`)
  const items = normalizeItems(platform, pickArray(data), 'xxapi')
  if (!items.length) throw new Error('xxapi 返回空热榜')
  return items
}

async function fetchTikhubXiaohongshu(config) {
  if (!config.xiaohongshu.token) throw new Error('缺少 TikHub token')
  const data = await fetchJson('https://api.tikhub.io/api/v1/xiaohongshu/web_v2/fetch_hot_list', {
    headers: { Authorization: `Bearer ${config.xiaohongshu.token}` },
  })
  const items = normalizeItems('xiaohongshu', pickArray(data), 'tikhub')
  if (!items.length) throw new Error('TikHub 返回空热榜')
  return items
}

async function fetchHotData(platform, dataId, key) {
  if (!key) throw new Error('缺少 Hot Data key')
  const data = await fetchJson(`https://w-hotdata.aipromptnav.com/api/hot-data/${dataId}`, {
    headers: { 'X-API-Key': key },
  })
  const items = normalizeItems(platform, pickArray(data), 'hotdata')
  if (!items.length) throw new Error('Hot Data 返回空热榜')
  return items
}

async function fetchDouyin(config) {
  const providers = []
  if (config.provider === 'custom') providers.push(() => fetchCustomPlatform('douyin', config.douyin.url))
  if (config.provider === 'tianapi' || (config.provider === 'auto' && config.tianapiKey)) {
    providers.push(() => fetchTianapi('douyin', 'douyinhot', config.tianapiKey))
  }
  if (config.provider === 'haotechs' || config.provider === 'auto') providers.push(fetchHaotechsDouyin)
  if (config.provider === 'xxapi' || config.provider === 'auto') providers.push(() => fetchXxapi('douyin', 'douyinhot'))
  return runProviders(providers, `未知抖音热点 provider: ${config.provider}`)
}

async function fetchXiaohongshu(config) {
  const providers = []
  if (config.xiaohongshu.url) providers.push(() => fetchCustomPlatform('xiaohongshu', config.xiaohongshu.url))
  if (config.xiaohongshu.token) providers.push(() => fetchTikhubXiaohongshu(config))
  if (config.provider === 'auto' || config.provider === 'hotdata') providers.push(() => fetchHotData('xiaohongshu', 'xiaohongshu', config.hotdata.key))
  return runProviders(providers, '小红书实时源未配置')
}

async function fetchWechat(config) {
  const providers = []
  if (config.wechat.url) providers.push(() => fetchCustomPlatform('wechat', config.wechat.url))
  if (config.wechat.tianapiKey) providers.push(() => fetchTianapi('wechat', 'wxhottopic', config.wechat.tianapiKey))
  if (config.provider === 'auto' || config.provider === 'hotdata') providers.push(() => fetchHotData('wechat', 'wxhottopic', config.hotdata.key))
  return runProviders(providers, '微信热点实时源未配置')
}

async function fetchWeibo(config) {
  const providers = []
  if (config.weibo.url) providers.push(() => fetchCustomPlatform('weibo', config.weibo.url))
  if (config.weibo.tianapiKey) providers.push(() => fetchTianapi('weibo', 'weibohot', config.weibo.tianapiKey))
  if (config.provider === 'auto' || config.provider === 'hotdata') providers.push(() => fetchHotData('weibo', 'weibohot', config.hotdata.key))
  if (config.provider === 'auto' || config.provider === 'xxapi') providers.push(() => fetchXxapi('weibo', 'weibohot'))
  return runProviders(providers, '微博热搜实时源未配置')
}

async function runProviders(providers, emptyMessage) {
  if (!providers.length) throw new Error(emptyMessage)
  const errors = []
  for (const provider of providers) {
    try {
      return await provider()
    } catch (err) {
      errors.push(err.message)
    }
  }
  throw new Error(errors.join('；') || emptyMessage)
}

async function fetchPlatform(platform, loader) {
  try {
    const items = await loader()
    return { platform, items, status: { ok: true, count: items.length, source: items[0]?.source || 'hotspot-api' } }
  } catch (err) {
    return { platform, items: [], status: { ok: false, count: 0, error: err.message } }
  }
}

async function fetchHotspots() {
  const config = readHotspotConfig()
  const fetchedAt = new Date()
  const results = await Promise.all([
    fetchPlatform('douyin', () => fetchDouyin(config)),
    fetchPlatform('xiaohongshu', () => fetchXiaohongshu(config)),
    fetchPlatform('wechat', () => fetchWechat(config)),
    fetchPlatform('weibo', () => fetchWeibo(config)),
  ])

  const platforms = {}
  const status = {}
  for (const result of results) {
    platforms[result.platform] = result.items
    status[result.platform] = result.status
  }

  const hasAnyItems = Object.values(platforms).some(items => Array.isArray(items) && items.length)
  if (!hasAnyItems) {
    const errors = Object.entries(status).map(([platform, s]) => `${platformLabel(platform)}：${s.error || '无数据'}`).join('；')
    throw new Error(errors || '全部热点源均不可用')
  }

  return {
    ok: true,
    refreshMinutes: config.refreshMinutes,
    fetchedAt: fetchedAt.toISOString(),
    fetchedAtMs: fetchedAt.getTime(),
    stale: false,
    platforms,
    status,
  }
}

export async function getHotspots({ force = false, viewed = false } = {}) {
  if (viewed) noteHotspotPanelViewed()
  if (!force && isCacheFresh()) return cache
  if (inFlight) return inFlight

  inFlight = fetchHotspots()
    .then((result) => {
      cache = result
      return result
    })
    .catch((err) => {
      if (cache) {
        return {
          ...cache,
          ok: true,
          stale: true,
          error: err.message,
        }
      }
      throw err
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}
