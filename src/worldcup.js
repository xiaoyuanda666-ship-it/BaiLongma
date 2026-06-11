// 世界杯模式后端：从直播吧（zhibo8.cc）首页解析世界杯赛程/比分，自算小组积分榜。
//
// 数据源说明：直播吧没有官方 API，这里解析首页赛程区的 <li label=...> 条目；
// 大陆直连可达、免费无 key、中文队名、北京时间。HTML 改版会导致解析失败，
// 失败时退 stale 缓存并在 status 里说明，Agent 侧由上下文引导退回 web_search。
//
// 比赛会随时间从首页消失，所以解析到的场次持久化到 data/worldcup-matches.json
// 累积合并（按 matchId upsert），积分榜从累积结果计算，覆盖整届赛事。
//
// 刻意不依赖 db.js：保持本模块纯 JS + fs，test-worldcup.js 无需原生模块即可跑。

import fs from 'fs'
import path from 'path'
import { paths } from './paths.js'

const ZHIBO8_URL = 'https://www.zhibo8.cc/'
// 比分接口：直播吧前端自己用的 qiumibao JSON（首页静态 HTML 里比分永远是"-"占位，
// 由浏览器 JS 动态填充，所以必须单独拉这个接口）。免签名、大陆直连。
// 不带日期 = 当天全部比赛；带日期可回填往日终场比分。
const BIFEN_BASE = 'https://bifen4pc.qiumibao.com/json'
// 事件流/比赛时钟（同为直播吧前端数据源）：进球/黄牌/换人事件带球员中文名，
// high_speed 给真实比赛分钟（period_cn 如 "55'"）——墙钟估算含中场休息会虚高
const DC_BASE = 'https://dc4pc.qiumibao.com/dc/matchs/data'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 15000

// 刷新节奏：有比赛进行中 2 分钟，平时 30 分钟（与热点的固定 30 分钟不同，赛况要新鲜）
const REFRESH_LIVE_MINUTES = 2
const REFRESH_IDLE_MINUTES = 30
const WORLDCUP_CONTEXT_TTL_MINUTES = 60

// 一场足球从开球到结束的窗口（含中场/补时/可能的加时点球），用于判定 live/finished
const LIVE_WINDOW_MS = 150 * 60 * 1000

const STORE_FILE = path.join(paths.dataDir, 'worldcup-matches.json')

let cache = null            // { fetchedAtMs, matches, standings, ... }
let inFlight = null
let storeLoaded = false
let matchStore = new Map()  // matchId → match

let panelActiveUntilMs = 0
let panelState = {
  active: false,
  updatedAtMs: 0,
  source: 'startup',
}

// ── 面板状态（与 hotspots.js 同构，供 worldcup_mode 工具与 brain-ui 上报） ─────

export function noteWorldcupPanelViewed() {
  panelActiveUntilMs = Date.now() + WORLDCUP_CONTEXT_TTL_MINUTES * 60 * 1000
  setWorldcupPanelState({ active: true, source: 'viewed' })
}

export function setWorldcupPanelState({ active, source = 'unknown' } = {}) {
  if (typeof active !== 'boolean') return getWorldcupPanelState()
  panelState = {
    active,
    updatedAtMs: Date.now(),
    source,
  }
  if (active) panelActiveUntilMs = Date.now() + WORLDCUP_CONTEXT_TTL_MINUTES * 60 * 1000
  return getWorldcupPanelState()
}

export function getWorldcupPanelState() {
  const now = Date.now()
  return {
    ...panelState,
    updatedAt: panelState.updatedAtMs ? new Date(panelState.updatedAtMs).toISOString() : null,
    contextActive: now < panelActiveUntilMs,
    contextTtlSeconds: Math.max(0, Math.round((panelActiveUntilMs - now) / 1000)),
  }
}

// ── 直播吧首页解析 ────────────────────────────────────────────────────────────

function stripTags(html = '') {
  return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

// 标签或赛事名里出现这些词的不是足球世界杯正赛（男篮世界杯/U17/预选赛等）
const NON_FINALS_RE = /男篮|女篮|篮球|U\d+|青年|沙滩|室内|五人制|预选赛|电子|电竞/
// 不是比赛的世界杯节目条目（开幕式也带 data-type=football 和双"队名"，会被误解析成比赛）
const NON_MATCH_RE = /开幕式|闭幕式|抽签|颁奖|发布会|纪录片|典礼/

function isNonMatchEntry(...texts) {
  return texts.some(t => t && NON_MATCH_RE.test(t))
}

function parseStage(league = '') {
  const group = league.match(/([A-L])组/)?.[1] || null
  const round = league.match(/第(\d+)轮/) ? Number(league.match(/第(\d+)轮/)[1]) : null
  const knockout = league.match(/(1\/16决赛|1\/8决赛|1\/4决赛|半决赛|季军赛|决赛|32强|16强|8强|附加赛)/)?.[1] || null
  return { group, round, knockout }
}

// 单条 <li> → match 对象；不是世界杯足球正赛或缺队名时返回 null
function parseMatchItem(li, now = Date.now()) {
  const label = li.match(/label="([^"]*)"/)?.[1] || ''
  const dataType = li.match(/data-type="([^"]*)"/)?.[1] || ''
  const dataTime = li.match(/data-time="([^"]*)"/)?.[1] || ''
  const matchId = li.match(/id="saishi(\d+)"/)?.[1] || ''

  if (dataType !== 'football') return null
  if (!label.includes('世界杯')) return null
  if (NON_FINALS_RE.test(label) || isNonMatchEntry(label)) return null
  if (!matchId || matchId === '0' || !dataTime) return null

  const league = stripTags(li.match(/<span class="_league">([\s\S]*?)<\/span>/)?.[1] || '')
  if (NON_FINALS_RE.test(league) || isNonMatchEntry(league)) return null

  const teamsHtml = li.match(/<span class="_teams">([\s\S]*?)<\/span><\/b>/)?.[1] || ''
  // _teams 结构：主队文本 <img 主队徽/> 中间区（"-" 或比分） <img 客队徽/> 客队文本
  const imgSplit = teamsHtml.split(/<img[^>]*>/)
  if (imgSplit.length < 3) return null
  const home = stripTags(imgSplit[0])
  const away = stripTags(imgSplit[imgSplit.length - 1])
  if (!home || !away) return null
  const middleText = stripTags(imgSplit.slice(1, -1).join(' '))

  const logos = [...teamsHtml.matchAll(/<img src="([^"]+)"/g)].map(m => m[1])

  // 中间区出现 "数字 - 数字" 即比分；排除 NBA 式 "大比分1-2" 系列赛计数
  let score = null
  const scoreMatch = middleText.replace(/大比分\d+\s*-\s*\d+/g, '').match(/(\d+)\s*-\s*(\d+)/)
  if (scoreMatch) score = { home: Number(scoreMatch[1]), away: Number(scoreMatch[2]) }

  const startMs = parseBeijingTime(dataTime)
  let status = 'scheduled'
  if (startMs != null) {
    if (now >= startMs && now < startMs + LIVE_WINDOW_MS) status = 'live'
    else if (now >= startMs + LIVE_WINDOW_MS) status = score ? 'finished' : 'unknown'
  }

  const detailPath = li.match(/href="(\/?(?:https?:\/\/www\.zhibo8\.com)?\/zhibo\/zuqiu\/[^"]+)"/)?.[1] || ''
  const detailUrl = detailPath
    ? (detailPath.startsWith('http') ? detailPath : `https://www.zhibo8.com${detailPath.startsWith('/') ? '' : '/'}${detailPath}`)
    : ''
  // 第一个站内链接的文本通常是转播渠道（"咪咕 CCTV5 央视频"）
  const channels = stripTags(li.match(/<a [^>]*zhibo\/zuqiu[^>]*>([\s\S]*?)<\/a>/)?.[1] || '')
    .replace(/文字|手机看直播|比分|集锦|录像/g, '').trim()

  return {
    matchId,
    time: dataTime,            // 北京时间 "YYYY-MM-DD HH:mm"
    startMs,
    league,
    stage: parseStage(league),
    home,
    away,
    homeLogo: logos[0] || '',
    awayLogo: logos[logos.length - 1] || '',
    score,
    status,
    detailUrl,
    channels,
  }
}

function parseBeijingTime(text = '') {
  const m = String(text).match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/)
  if (!m) return null
  // 进程运行在用户本机（大陆，东八区），本地时间即北京时间
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime()
}

export function parseWorldcupMatches(html = '', now = Date.now()) {
  const items = String(html).match(/<li label="[^"]*"[\s\S]*?<\/li>/g) || []
  const matches = []
  const seen = new Set()
  for (const li of items) {
    const match = parseMatchItem(li, now)
    if (!match || seen.has(match.matchId)) continue
    seen.add(match.matchId)
    matches.push(match)
  }
  return matches.sort((a, b) => (a.startMs || 0) - (b.startMs || 0))
}

// ── 世界杯新闻（直播吧首页的新闻区锚文本，标题含"世界杯"即收录） ──────────────

export function parseWorldcupNews(html = '', limit = 12) {
  const out = []
  const seen = new Set()
  // 只匹配纯文本锚（直播吧新闻条目都是 <a href=...>标题</a> 形式）
  for (const m of String(html).matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<>]{8,90})<\/a>/g)) {
    const title = m[2].replace(/\s+/g, ' ').trim()
    if (!title.includes('世界杯')) continue
    if (NON_FINALS_RE.test(title)) continue
    const key = title.slice(0, 30)
    if (seen.has(key)) continue
    seen.add(key)
    let url = m[1]
    if (url.startsWith('//')) url = `https:${url}`
    else if (url.startsWith('/')) url = `https://www.zhibo8.cc${url}`
    if (!/^https?:\/\//.test(url)) continue
    out.push({ title, url })
    if (out.length >= limit) break
  }
  return out
}

// ── qiumibao 比分合并（2026-06-12 揭幕战实测：比分只能从这里拿，静态 HTML 没有） ──

// state 含义（实测批量接口）：1=未赛 2=进行中 3=完赛 4=延期 7=待定
const BIFEN_STATUS = { 1: 'scheduled', 2: 'live', 3: 'finished' }

function parseScorers(playerData) {
  if (!Array.isArray(playerData)) return []
  const out = []
  for (const p of playerData) {
    const min = parseInt(String(p?.value || ''), 10) // "9'" / "45+2'" → 9 / 45
    if (p?.player_name && Number.isFinite(min)) out.push({ min, name: p.player_name })
  }
  return out
}

// 把比分接口的行合并进比赛对象（原地改写）；返回是否有变化。
// 注意：state=1（未赛）时 left/right.score 是 "0"/"0" 占位，不能当真实 0-0 采纳。
export function applyScoreRows(matches = [], rows = []) {
  const byId = new Map()
  for (const row of rows) {
    if (row?.id != null) byId.set(String(row.id), row)
  }
  let changed = false
  for (const match of matches) {
    const row = byId.get(String(match.matchId))
    if (!row) continue
    const status = BIFEN_STATUS[String(row.state)]
    if (!status) continue // 延期/待定等留给首页启发式
    const before = JSON.stringify([match.status, match.score, match.scorersHome, match.scorersAway])
    match.status = status
    if (status === 'live' || status === 'finished') {
      const home = Number(row.left?.score)
      const away = Number(row.right?.score)
      // 接口的 left/right 即首页展示的左/右，与解析出的 home/away 同向（实测揭幕战核对）
      if (row.left?.score !== '' && row.right?.score !== '' && Number.isFinite(home) && Number.isFinite(away)) {
        match.score = { home, away }
      }
      const scorersHome = parseScorers(row.left?.player_data)
      const scorersAway = parseScorers(row.right?.player_data)
      if (scorersHome.length) match.scorersHome = scorersHome
      if (scorersAway.length) match.scorersAway = scorersAway
    }
    if (JSON.stringify([match.status, match.score, match.scorersHome, match.scorersAway]) !== before) changed = true
  }
  return changed
}

// 事件流行 → 面板事件对象；homeTeamId/awayTeamId 来自 high_speed，定哪侧的事件。
// is_hide 的行是被折叠进主事件的从属行（如进球行自带 sub 助攻，独立助攻行标 is_hide）。
export function parseMatchEvents(rows = [], { homeTeamId = '', awayTeamId = '' } = {}) {
  if (!Array.isArray(rows)) return []
  const out = []
  for (const row of rows) {
    if (!row || row.is_hide) continue
    const min = parseInt(String(row.time || ''), 10)
    const type = String(row.event_code_cn || '').trim()
    if (!Number.isFinite(min) || !type) continue
    const teamId = String(row.sl_team_id || '')
    const event = {
      min,
      type,
      name: String(row.player_name_cn || '').trim(),
      side: teamId && teamId === String(homeTeamId) ? 'home'
        : teamId && teamId === String(awayTeamId) ? 'away' : null,
    }
    const assist = row.sub?.player_name_cn
    if (assist && /助攻/.test(String(row.sub.event_code_cn || ''))) event.assist = String(assist).trim()
    out.push(event)
  }
  return out.sort((a, b) => a.min - b.min)
}

async function fetchDcJson(kind, date, matchId) {
  try {
    const res = await fetch(`${DC_BASE}/${date}/${kind}_${matchId}.htm`, {
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://www.zhibo8.cc/' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    console.warn(`[Worldcup] ${kind} 接口失败(${matchId}):`, err.message)
    return null
  }
}

// live 场次的事件流+真实比赛时钟；完场后保留最后一次抓到的事件（焦点区回看赛果用）
const LIVE_DETAIL_MAX = 4 // 世界杯同时开球最多 4 场，防御性上限

async function refreshLiveDetails() {
  loadStoreOnce()
  const live = [...matchStore.values()].filter(m => m.status === 'live').slice(0, LIVE_DETAIL_MAX)
  if (!live.length) return
  let changed = false
  for (const match of live) {
    const date = String(match.time || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const [hs, ev] = await Promise.all([
      fetchDcJson('match_high_speed', date, match.matchId),
      fetchDcJson('match_event', date, match.matchId),
    ])
    const before = JSON.stringify([match.clock, match.events, match.teamIds])
    if (hs?.data?.period_cn) {
      match.clock = { periodCn: hs.data.period_cn, stoppage: Number(hs.data.stoppage) || 0 }
      if (hs.data.Team1Id) match.teamIds = { home: String(hs.data.Team1Id), away: String(hs.data.Team2Id || '') }
    }
    if (Array.isArray(ev?.data)) {
      const events = parseMatchEvents(ev.data, {
        homeTeamId: match.teamIds?.home, awayTeamId: match.teamIds?.away,
      })
      if (events.length || match.events) match.events = events
    }
    if (JSON.stringify([match.clock, match.events, match.teamIds]) !== before) changed = true
  }
  if (changed) saveStore()
}

async function fetchScoreRows(date = null) {
  const url = date ? `${BIFEN_BASE}/${date}/v2/list.htm` : `${BIFEN_BASE}/v2/list.htm`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://www.zhibo8.cc/' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    return Array.isArray(data?.list) ? data.list : []
  } catch (err) {
    console.warn(`[Worldcup] 比分接口失败(${date || '今日'}):`, err.message)
    return null // 比分拿不到不致命，赛程照常展示
  }
}

function localDateStr(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// 每个往日最多回填这么多天，避免长期停机后一次刷新打太多请求
const BACKFILL_DATES_PER_REFRESH = 3

async function refreshScores(now = Date.now()) {
  loadStoreOnce()
  const all = [...matchStore.values()]
  if (!all.length) return
  let changed = false
  const todayRows = await fetchScoreRows()
  if (todayRows) changed = applyScoreRows(all, todayRows) || changed
  // 回填：已开赛却始终没比分的往日场次（应用当天没开机就会漏终场比分）
  const today = localDateStr(now)
  const missingDates = [...new Set(
    all
      .filter(m => m.startMs != null && now >= m.startMs + LIVE_WINDOW_MS && !m.score)
      .map(m => String(m.time || '').slice(0, 10))
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d !== today)
  )].slice(0, BACKFILL_DATES_PER_REFRESH)
  for (const date of missingDates) {
    const rows = await fetchScoreRows(date)
    if (rows) changed = applyScoreRows(all, rows) || changed
  }
  if (changed) saveStore()
}

// ── 比赛持久化存储（首页条目会滚动消失，累积合并才能算整届积分榜） ─────────────

function loadStoreOnce() {
  if (storeLoaded) return
  storeLoaded = true
  try {
    const rows = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'))
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!row?.matchId) continue
        // 清洗历史污染：过滤规则升级后，老存储里的非比赛条目（如开幕式）在加载时剔除
        if (isNonMatchEntry(row.league, row.home, row.away)) continue
        matchStore.set(row.matchId, row)
      }
    }
  } catch {}
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...matchStore.values()], null, 2))
  } catch (err) {
    console.warn('[Worldcup] 保存比赛存储失败:', err.message)
  }
}

function mergeIntoStore(matches = []) {
  loadStoreOnce()
  let changed = false
  for (const match of matches) {
    const prev = matchStore.get(match.matchId)
    if (!prev) {
      matchStore.set(match.matchId, match)
      changed = true
      continue
    }
    // 比分只进不退：首页条目滚动后可能丢失比分，不能用 null 覆盖已记录的比分
    const merged = {
      ...prev,
      ...match,
      score: match.score || prev.score || null,
    }
    // 完场也只进不退：比分接口定下的 finished 不被首页 150 分钟启发式打回 live/unknown
    if (prev.status === 'finished') merged.status = 'finished'
    if (merged.score && merged.status !== 'live') merged.status = 'finished'
    if (JSON.stringify(merged) !== JSON.stringify(prev)) {
      matchStore.set(match.matchId, merged)
      changed = true
    }
  }
  if (changed) saveStore()
}

export function getStoredMatches() {
  loadStoreOnce()
  return [...matchStore.values()].sort((a, b) => (a.startMs || 0) - (b.startMs || 0))
}

// ── 小组积分榜（从已结束的小组赛赛果计算，无需额外数据源） ─────────────────────

export function computeStandings(matches = []) {
  const groups = {}
  const ensureRow = (group, team, logo) => {
    groups[group] = groups[group] || {}
    groups[group][team] = groups[group][team] || {
      team, logo: logo || '', played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0,
    }
    if (logo && !groups[group][team].logo) groups[group][team].logo = logo
    return groups[group][team]
  }

  for (const match of matches) {
    const group = match?.stage?.group
    if (!group || !match.score || match.status !== 'finished') continue
    const homeRow = ensureRow(group, match.home, match.homeLogo)
    const awayRow = ensureRow(group, match.away, match.awayLogo)
    homeRow.played++; awayRow.played++
    homeRow.gf += match.score.home; homeRow.ga += match.score.away
    awayRow.gf += match.score.away; awayRow.ga += match.score.home
    if (match.score.home > match.score.away) { homeRow.won++; awayRow.lost++ }
    else if (match.score.home < match.score.away) { awayRow.won++; homeRow.lost++ }
    else { homeRow.drawn++; awayRow.drawn++ }
  }

  const result = {}
  for (const group of Object.keys(groups).sort()) {
    result[group] = Object.values(groups[group])
      .map(row => ({ ...row, gd: row.gf - row.ga, pts: row.won * 3 + row.drawn }))
      .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.team.localeCompare(b.team, 'zh'))
  }
  return result
}

// ── 抓取与缓存 ────────────────────────────────────────────────────────────────

function isAnyLive(matches = [], now = Date.now()) {
  return matches.some(m => m.startMs != null && now >= m.startMs - 10 * 60 * 1000 && now < m.startMs + LIVE_WINDOW_MS)
}

function currentRefreshMinutes(matches = []) {
  return isAnyLive(matches) ? REFRESH_LIVE_MINUTES : REFRESH_IDLE_MINUTES
}

function isCacheFresh(now = Date.now()) {
  if (!cache?.fetchedAtMs) return false
  return now - cache.fetchedAtMs < (cache.refreshMinutes || REFRESH_IDLE_MINUTES) * 60 * 1000
}

function isContextFresh(now = Date.now()) {
  if (!cache?.fetchedAtMs) return false
  return now - cache.fetchedAtMs < WORLDCUP_CONTEXT_TTL_MINUTES * 60 * 1000
}

async function fetchWorldcup() {
  const res = await fetch(ZHIBO8_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`直播吧 HTTP ${res.status}`)
  const html = await res.text()
  const parsed = parseWorldcupMatches(html)
  if (!parsed.length && !getStoredMatches().length) {
    throw new Error('直播吧首页未解析到世界杯条目（可能改版或赛程区为空）')
  }

  mergeIntoStore(parsed)
  await refreshScores() // 真实比分/状态来自 qiumibao 接口，覆盖首页启发式
  await refreshLiveDetails() // live 场次再补事件流+真实比赛时钟
  const matches = getStoredMatches()
  const fetchedAt = new Date()
  return {
    ok: true,
    source: 'zhibo8',
    fetchedAt: fetchedAt.toISOString(),
    fetchedAtMs: fetchedAt.getTime(),
    stale: false,
    refreshMinutes: currentRefreshMinutes(matches),
    parsedCount: parsed.length,
    matches,
    standings: computeStandings(matches),
    news: parseWorldcupNews(html),
  }
}

export async function getWorldcup({ force = false, viewed = false } = {}) {
  if (viewed) noteWorldcupPanelViewed()
  if (!force && isCacheFresh()) return cache
  if (inFlight) return inFlight

  inFlight = fetchWorldcup()
    .then((result) => {
      cache = result
      return result
    })
    .catch((err) => {
      if (cache) {
        return { ...cache, ok: true, stale: true, error: err.message }
      }
      throw err
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}

// ── LLM 上下文注入（runtime-injector 调用，同步、无 IO） ──────────────────────

const STATUS_LABELS = { scheduled: '未开赛', live: '进行中', finished: '已结束', unknown: '已开赛' }

function formatMatchLine(match) {
  const score = match.score ? `${match.score.home}-${match.score.away}` : 'vs'
  const stage = match.league || '世界杯'
  const liveClock = match.status === 'live' && match.clock?.periodCn ? `，${match.clock.periodCn}` : ''
  return `${match.time} ${stage}：${match.home} ${score} ${match.away}（${STATUS_LABELS[match.status] || match.status}${liveClock}）`
}

// 事件时间线压成一行（进球/红黄牌/换人，带队属和助攻），live 和近期完赛都带上
function formatEventsLine(match) {
  if (!Array.isArray(match.events) || !match.events.length) return ''
  const teamOf = (e) => (e.side === 'home' ? match.home : e.side === 'away' ? match.away : '')
  const parts = match.events.map((e) => {
    const who = [teamOf(e), e.name].filter(Boolean).join(' ')
    return `${e.min}' ${e.type}${who ? `（${who}${e.assist ? `，${e.assist}助攻` : ''}）` : ''}`
  })
  return `  事件：${parts.join('；')}`
}

function formatMatchBlock(match) {
  return [formatMatchLine(match), formatEventsLine(match)].filter(Boolean).join('\n')
}

export function buildWorldcupPanelStateContext() {
  // 赛事是季节性功能：没有缓存数据且面板关着时不占系统提示词
  if (!cache && !panelState.active) return ''
  const state = getWorldcupPanelState()
  const status = state.active ? 'open' : 'closed'
  return `## Worldcup Panel State
Current worldcup panel: ${status}.
Use the worldcup_mode tool to open or close the worldcup panel only when display, demo, troubleshooting, or an explicit user request calls for it. Do not open it proactively for ordinary answers.`
}

const WORLDCUP_QUERY_RE = /世界杯|赛况|比分|赛程|对阵|积分榜|小组赛|谁赢|进球|几比几/

export function buildWorldcupRuntimeContext(message = '') {
  if (!cache || !isContextFresh()) return ''
  const matches = cache.matches || []
  if (!matches.length) return ''

  const text = String(message || '')
  const panelContextActive = Date.now() < panelActiveUntilMs
  const queryHit = WORLDCUP_QUERY_RE.test(text)
    || matches.some(m => m.home && text.includes(m.home) || m.away && text.includes(m.away))
  if (!panelContextActive && !queryHit) return ''

  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  const live = matches.filter(m => m.status === 'live')
  const recent = matches.filter(m => m.status === 'finished' && now - (m.startMs || 0) < 3 * dayMs).slice(-8)
  const upcoming = matches.filter(m => m.status === 'scheduled' && (m.startMs || 0) - now < 2 * dayMs).slice(0, 8)

  const blocks = []
  if (live.length) blocks.push(`Matches in progress:\n${live.map(formatMatchBlock).join('\n')}`)
  if (recent.length) blocks.push(`Recent results:\n${recent.map(formatMatchBlock).join('\n')}`)
  if (upcoming.length) blocks.push(`Upcoming matches (next 48h):\n${upcoming.map(formatMatchLine).join('\n')}`)
  if (!blocks.length) return ''

  return `## Worldcup Context
Source: worldcup mode (zhibo8.cc live feed), automatically collected by the system. Sender: SYSTEM. Times are Beijing time. Purpose: current World Cup status as background; this is not a user request.

The scores, match minutes and event timelines above are real-time data the system just fetched — answer questions about these matches directly from this context, and do NOT call web_search to re-check their current score, status or events. Use web_search only for what is not covered here (lineups, detailed stats, history, other competitions). Do not proactively summarize this context when the user's message is unrelated to football.

Fetched at: ${cache.fetchedAt}${cache.stale ? ' (stale cache, refresh failed)' : ''}

${blocks.join('\n\n')}`
}
