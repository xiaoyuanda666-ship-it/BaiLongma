// 天气上下文注入模块
// 触发关键词 → 拉取用户当前城市天气 → 格式化为参考上下文注入提示词
// 不要求模型必须回复天气，天气是上下文信息，模型按需使用

import { getConfig, setConfig } from './db.js'

const CACHE_TTL_MS = 30 * 60 * 1000  // 30 分钟
const FETCH_TIMEOUT_MS = 6000
// 硬超时兜底:观测到 AbortSignal.timeout 在本运行时偶尔无法中断卡住的 fetch
//   (连接已建立但 wttr.in 限流/不响应)。用 Promise.race 保证 fetchAndCacheWeather
//   一定在此时限内 settle —— 天气快速路径(index.js)在 LLM 之前同步 await 它,
//   一旦卡死整个回合无回复。略大于 AbortSignal 时限,正常路径仍由 AbortSignal 先收口。
const HARD_TIMEOUT_MS = 8000

// 触发天气注入的关键词（中英双语）
const WEATHER_RE = /天气|气温|温度|下雨|下雪|晴天?|阴天?|多云|刮风|风大|雾霾|冷不冷|热不热|穿什么|穿衣|要下[雨雪]|今天冷|今天热|weather|forecast|raining|snowing|temperature|how.*cold|how.*hot/i
const WEATHER_WEEK_RE = /一周|一星期|7\s*天|七天|未来一周|接下来一周|下周|week|weekly|7-?day/i

const cache = new Map()  // key -> { location, mode, formatted, cardProps, fetchedAt }

const WEATHER_LOCATION_ALIASES = [
  { re: /汕尾.*陆丰|陆丰.*汕尾/i, value: '22.945,115.644', label: '汕尾陆丰' },
  { re: /陆丰/i, value: '22.945,115.644', label: '汕尾陆丰' },
  { re: /上海.*浦东|浦东.*上海|浦东/i, value: '31.2304,121.5440', label: '上海浦东' },
  { re: /汕尾/i, value: 'Shanwei Guangdong' },
  { re: /上海/i, value: 'Shanghai China', label: '上海' },
  { re: /广州/i, value: 'Guangzhou Guangdong China' },
  { re: /北京/i, value: 'Beijing China' },
  { re: /深圳/i, value: 'Shenzhen Guangdong China' },
  { re: /杭州/i, value: 'Hangzhou Zhejiang China' },
]
const WEATHER_LOCATION_LABELS = new Map(
  WEATHER_LOCATION_ALIASES
    .filter(item => item.label)
    .map(item => [item.value, item.label])
)

const LOCATION_PREFIX_RE = /^(?:呃|嗯|啊|那个|帮我|麻烦|请|给我|打开|开一下|查看|看一下|看下|查一下|查下|查询|搜一下|搜下|问一下|问下|告诉我|看看|一下|我)+/u
const LOCATION_NOISE_RE = /^(?:今天|明天|后天|现在|当前|实时|本地|当地|这里|我这边|附近|周边|未来|最近|怎么样|如何|咋样|怎样|好吗|好不好)+$/u

function normalizeWeatherLocation(location = '') {
  let loc = String(location || '')
    .replace(/[，。？！；、,.!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LOCATION_PREFIX_RE, '')
    .replace(/(?:今天|明天|后天|现在|当前|实时|未来(?:三天|两天|几天)?|最近|这几天|接下来|下周|一周|一星期|[0-9０-９]+\s*天|[一二三四五六七八九十]+天|一下|打开|查看|我|的|怎么样|如何|咋样|怎样|好吗|好不好)/gu, '')
    .trim()

  if (!loc || LOCATION_NOISE_RE.test(loc)) return ''
  for (const item of WEATHER_LOCATION_ALIASES) {
    if (item.re.test(loc)) return item.value
  }
  return loc
}

export function extractWeatherLocation(message = '') {
  const text = String(message || '').trim()
  if (!text) return ''

  const chineseBefore = text.match(/([\u4e00-\u9fa5A-Za-z0-9０-９\s,，.-]{1,50}?)(?:的)?(?:天气|气温|温度|预报)/u)
  const beforeLoc = normalizeWeatherLocation(chineseBefore?.[1] || '')
  if (beforeLoc) return beforeLoc

  const chineseAfter = text.match(/(?:天气|气温|温度|预报)(?:在|查|看|:|：)?\s*([\u4e00-\u9fa5A-Za-z0-9０-９\s,，.-]{1,50})/u)
  const afterLoc = normalizeWeatherLocation(chineseAfter?.[1] || '')
  if (afterLoc) return afterLoc

  const english = text.match(/(?:weather|forecast|temperature)\s+(?:in|for|of)?\s*([A-Za-z][A-Za-z\s,.-]{1,50})/i)
  return normalizeWeatherLocation(english?.[1] || '')
}

function resolveWeatherLocation(message = '') {
  return extractWeatherLocation(message) || getUserLocation()
}

/* ── 位置存取 ── */

export function getUserLocation() {
  return (getConfig('user_location') || '').trim()
}

export function setUserLocation(city) {
  const loc = String(city || '').trim()
  if (!loc) return
  setConfig('user_location', loc)
  cache.clear()  // 位置变了，让缓存失效
  console.log(`[天气] 用户位置已更新：${loc}`)
}

/* ── 缓存检查 ── */

function cacheKey(location, mode) {
  return `${mode || 'compact'}:${location}`
}

function getFreshCache(location, mode) {
  const item = cache.get(cacheKey(location, mode))
  if (!item || item.location !== location || item.mode !== mode) return null
  return Date.now() - item.fetchedAt < CACHE_TTL_MS ? item : null
}

/* ── 拉取 & 解析 wttr.in ── */

async function fetchWeatherData(location) {
  const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1&lang=zh`
  const res = await globalThis.fetch(url, {
    headers: { 'User-Agent': 'Jarvis/1.0 (+https://localhost)' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function fetchWeeklyData(lat, lon) {
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', String(lat))
  url.searchParams.set('longitude', String(lon))
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min')
  url.searchParams.set('forecast_days', '7')
  url.searchParams.set('timezone', 'auto')
  const res = await globalThis.fetch(url, {
    headers: { 'User-Agent': 'Jarvis/1.0 (+https://localhost)' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`weekly HTTP ${res.status}`)
  return res.json()
}

const WEATHER_DESC_ZH = {
  'Sunny': '晴',
  'Clear': '晴',
  'Partly cloudy': '多云',
  'Cloudy': '阴天',
  'Overcast': '阴云密布',
  'Mist': '薄雾',
  'Fog': '雾',
  'Freezing fog': '冻雾',
  'Light rain': '小雨',
  'Light rain shower': '小阵雨',
  'Moderate rain': '中雨',
  'Heavy rain': '大雨',
  'Light snow': '小雪',
  'Moderate snow': '中雪',
  'Heavy snow': '大雪',
  'Blizzard': '暴风雪',
  'Thundery outbreaks possible': '可能有雷暴',
  'Patchy rain possible': '局部有雨',
  'Patchy rain nearby': '局部有雨',
  'Patchy snow possible': '局部有雪',
  'Blowing snow': '吹雪',
  'Light drizzle': '细雨',
  'Freezing drizzle': '冻雨',
  'Heavy freezing drizzle': '强冻雨',
  'Light sleet': '小冻雨',
  'Moderate or heavy sleet': '中到大冻雨',
  'Thundery outbreaks in nearby': '附近有雷暴',
  'Patchy light rain with thunder': '局部雷阵雨',
  'Moderate or heavy rain with thunder': '雷雨',
}

function localizeDesc(desc = '') {
  const raw = String(desc || '').trim()
  if (!raw) return ''
  if (WEATHER_DESC_ZH[raw]) return WEATHER_DESC_ZH[raw]
  const lower = raw.toLowerCase()
  for (const [en, zh] of Object.entries(WEATHER_DESC_ZH)) {
    if (en.toLowerCase() === lower) return zh
  }
  return raw
}

function parseCoordinateLocation(location = '') {
  const m = String(location || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/)
  if (!m) return null
  return { lat: Number(m[1]), lon: Number(m[2]) }
}

function coordsFromWttrData(data, location) {
  const direct = parseCoordinateLocation(location)
  if (direct) return direct
  const area = data?.nearest_area?.[0]
  const lat = Number(area?.latitude)
  const lon = Number(area?.longitude)
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null
}

function weatherCodeDesc(code) {
  const n = Number(code)
  if ([0, 1].includes(n)) return '晴'
  if (n === 2) return '多云'
  if (n === 3) return '阴天'
  if ([45, 48].includes(n)) return '雾'
  if ([51, 53, 55].includes(n)) return '细雨'
  if ([56, 57, 66, 67].includes(n)) return '冻雨'
  if ([61, 80].includes(n)) return '小雨'
  if ([63, 81].includes(n)) return '中雨'
  if ([65, 82].includes(n)) return '大雨'
  if ([71, 77, 85].includes(n)) return '小雪'
  if (n === 73) return '中雪'
  if ([75, 86].includes(n)) return '大雪'
  if (n === 95) return '雷暴'
  if ([96, 99].includes(n)) return '雷雨'
  return '多云'
}

function dayLabel(date = '', index = 0, mode = 'compact') {
  if (index === 0) return '今天'
  if (index === 1) return '明天'
  if (index === 2 && mode === 'compact') return '后天'
  const d = new Date(`${date}T00:00:00`)
  if (Number.isNaN(d.getTime())) return date || ''
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
}

function wttrForecastDays(data, mode = 'compact') {
  return (data?.weather || []).slice(0, 3).map((d, i) => ({
    day: dayLabel(d.date, i, mode),
    condition: localizeDesc(d.hourly?.[4]?.lang_zh?.[0]?.value || d.hourly?.[4]?.weatherDesc?.[0]?.value || ''),
    high: Number(d.maxtempC),
    low: Number(d.mintempC),
  }))
}

function weeklyForecastDays(weekly) {
  const daily = weekly?.daily || {}
  const dates = Array.isArray(daily.time) ? daily.time : []
  return dates.slice(0, 7).map((date, i) => ({
    day: dayLabel(date, i, 'week'),
    condition: weatherCodeDesc(daily.weather_code?.[i]),
    high: Math.round(Number(daily.temperature_2m_max?.[i])),
    low: Math.round(Number(daily.temperature_2m_min?.[i])),
  })).filter(d => Number.isFinite(d.high) && Number.isFinite(d.low))
}

function parseWeatherData(data, location, { mode = 'compact', weekly = null } = {}) {
  const cur = data?.current_condition?.[0]
  if (!cur) return null

  const areaName = data?.nearest_area?.[0]?.areaName?.[0]?.value
  const desc = localizeDesc(cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '')
  const tempC = Number(cur.temp_C)
  const feelsC = Number(cur.FeelsLikeC)
  const humidity = cur.humidity
  const windKmph = cur.windspeedKmph
  const windDir = cur.winddir16Point || ''
  const visKm = cur.visibility

  const today = data?.weather?.[0]
  const maxC = today?.maxtempC
  const minC = today?.mintempC

  const weeklyDays = mode === 'week' ? weeklyForecastDays(weekly) : []
  const effectiveMode = mode === 'week' && weeklyDays.length >= 7 ? 'week' : 'compact'
  const forecastDays = effectiveMode === 'week' ? weeklyDays : wttrForecastDays(data, 'compact')

  const displayLocation = WEATHER_LOCATION_LABELS.get(location) || areaName || location

  const formatted = [
    `📍 ${displayLocation} 实时天气`,
    `天气：${desc}  气温：${tempC}°C（体感 ${feelsC}°C）`,
    `今日：${minC}～${maxC}°C  湿度：${humidity}%  风：${windDir} ${windKmph} km/h`,
    ...(visKm && Number(visKm) < 10 ? [`能见度：${visKm} km`] : []),
    ...(forecastDays.length ? [`未来预报：\n${forecastDays.map(d => `  ${d.day}  ${d.low}～${d.high}°C  ${d.condition}`).join('\n')}`] : []),
  ].join('\n')

  const cardProps = {
    variant: effectiveMode,
    city: displayLocation,
    temp: tempC,
    condition: desc,
    feel: feelsC,
    high: Number(maxC),
    low: Number(minC),
    wind: windDir ? `${windDir} ${windKmph} km/h` : `${windKmph} km/h`,
    forecast: forecastDays,
  }

  return { formatted, cardProps }
}

/* ── 公开 API ── */

// Wave 1：in-flight promise dedup —— runRuntimeInjector 并发后 buildWeatherRuntimeContext
//   和 getWeatherCardProps 会同时调本函数，cache 未 fresh 时两个都会发 HTTP。
//   用 inflight map 让同 location 的并发请求共享一个 promise。
const inflight = new Map()

async function fetchWeatherBundle(location, mode) {
  const data = await fetchWeatherData(location)
  let weekly = null
  if (mode === 'week') {
    const coords = coordsFromWttrData(data, location)
    if (coords) {
      try {
        weekly = await fetchWeeklyData(coords.lat, coords.lon)
      } catch (err) {
        console.warn(`[天气] 7天预报拉取失败：${err.message}`)
      }
    }
  }
  return parseWeatherData(data, location, { mode, weekly })
}

export async function fetchAndCacheWeather(location, { mode = 'compact' } = {}) {
  if (!location) return null
  const fresh = getFreshCache(location, mode)
  if (fresh) return fresh

  // 同 location 的请求已经在跑 → 直接复用
  const key = cacheKey(location, mode)
  if (inflight.has(key)) return inflight.get(key)

  const promise = (async () => {
    try {
      console.log(`[天气] 拉取 ${location} 天气(${mode})...`)
      const parsed = await Promise.race([
        fetchWeatherBundle(location, mode),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`hard timeout ${HARD_TIMEOUT_MS}ms`)), HARD_TIMEOUT_MS)),
      ])
      if (!parsed) return null
      const next = { location, mode, ...parsed, fetchedAt: Date.now() }
      cache.set(key, next)
      return next
    } catch (err) {
      console.warn(`[天气] 拉取失败：${err.message}`)
      return getFreshCache(location, mode)
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, promise)
  return promise
}

export function isWeatherQuery(message = '') {
  return WEATHER_RE.test(String(message))
}

export function weatherCardMode(message = '') {
  return WEATHER_WEEK_RE.test(String(message || '')) ? 'week' : 'compact'
}

// 关键词触发 → 注入天气上下文（异步）
// 返回空字符串表示不注入；同时在 cache.cardProps 里存放卡片数据
export async function buildWeatherRuntimeContext(message = '') {
  if (!isWeatherQuery(message)) return ''

  const location = resolveWeatherLocation(message)
  if (!location) return ''

  const mode = weatherCardMode(message)
  const result = await fetchAndCacheWeather(location, { mode })
  if (!result?.formatted) return ''

  const age = result.fetchedAt
    ? Math.round((Date.now() - result.fetchedAt) / 60000)
    : 0

  return `## Weather Reference
The following live weather was automatically fetched by the system. Treat it only as background context; do not proactively read or summarize it. Cite it only when useful.
Data age: about ${age} minutes (refreshed every 30 minutes)

${result.formatted}`
}

// 关键词触发时返回 WeatherCard 所需 props；无数据返回 null
export async function getWeatherCardProps(message = '') {
  if (!isWeatherQuery(message)) return null

  const location = resolveWeatherLocation(message)
  if (!location) return null

  const result = await fetchAndCacheWeather(location, { mode: weatherCardMode(message) })
  return result?.cardProps ?? null
}
