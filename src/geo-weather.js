/**
 * geo-weather.js
 *
 * 启动时自动采集位置坐标 + 实时天气，落盘缓存，注入 system prompt。
 *
 * 数据分两层：
 *   location  — 坐标 + 地址详情，IP 未变时最长 7 天复用缓存
 *   weather   — 当前天气 + 今明两天，每次启动刷新
 *
 * 数据来源（全部免费，无需 API Key）：
 *   ip-api.com          → 公网 IP 反查坐标 / 城市 / 时区
 *   nominatim (OSM)     → 坐标反解详细地址（区级）
 *   wttr.in             → 天气（当前 + 今明两天）
 *
 * 对外接口：
 *   collectGeoWeather()    → 启动时调用一次，async
 *   getGeoWeatherBlock()   → 返回注入 prompt 的纯文本块，同步
 */

import fs from 'fs'
import path from 'path'
import { paths } from './paths.js'

const GEO_WEATHER_FILE = path.join(paths.dataDir, 'geo-weather.json')
const GEO_WEATHER_VERSION = 1
const LOCATION_REFRESH_MS = 7 * 24 * 60 * 60 * 1000  // 位置信息兜底 7d 刷新一次

let _cached = null

function loadStoredGeoWeather() {
  if (!_cached && fs.existsSync(GEO_WEATHER_FILE)) {
    _cached = safe(() => JSON.parse(fs.readFileSync(GEO_WEATHER_FILE, 'utf8')))
  }
  return _cached
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

function safe(fn, fallback = null) {
  try { return fn() } catch { return fallback }
}

async function fetchJSON(url, options = {}, timeoutMs = 8000) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(url, { signal: ctrl.signal, ...options })
    clearTimeout(t)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// ─── 位置采集 ─────────────────────────────────────────────────────────────────

async function fetchLocation() {
  // Step 1：IP 反查坐标（同时拿到城市 / 时区 / ISP）
  const ipData = await fetchJSON(
    'http://ip-api.com/json/?fields=status,query,city,regionName,country,countryCode,lat,lon,timezone,isp'
  )
  if (!ipData || ipData.status !== 'success') {
    console.warn('[geo-weather] ip-api.com 定位失败')
    return null
  }

  const { lat, lon, city, regionName, country, countryCode, timezone, isp, query: ip } = ipData

  // Step 2：Nominatim 反解精细地址（区 / 街道级）
  // User-Agent 是 Nominatim 免费使用协议要求
  const nominatim = await fetchJSON(
    'https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lon + '&format=json&accept-language=zh',
    { headers: { 'User-Agent': 'BaiLongma/2.0 (personal-assistant; contact: user@example.com)' } },
    10000
  )

  const addr = nominatim?.address || {}

  return {
    lat: Number(lat),
    lon: Number(lon),
    ip,
    isp: isp || null,
    city:         addr.city || addr.town || addr.village || city,
    district:     addr.suburb || addr.district || addr.county || null,
    region:       addr.state || regionName,
    country:      addr.country || country,
    country_code: (addr.country_code || countryCode || '').toUpperCase(),
    timezone:     timezone || null,
    display_name: nominatim?.display_name || (city + ', ' + regionName + ', ' + country),
    collected_at: new Date().toISOString(),
  }
}

// ─── 天气采集 ─────────────────────────────────────────────────────────────────

function parseWttrDay(day) {
  if (!day) return null
  // hourly 索引 4 ≈ 12:00，作为当天代表天气描述
  const noon = day.hourly?.[4]
  const condition = noon?.lang_zh?.[0]?.value || noon?.weatherDesc?.[0]?.value
    || day.hourly?.[0]?.lang_zh?.[0]?.value || ''
  return {
    date:      day.date || '',
    high:      Number(day.maxtempC),
    low:       Number(day.mintempC),
    condition,
    sunrise:   day.astronomy?.[0]?.sunrise || '',
    sunset:    day.astronomy?.[0]?.sunset  || '',
  }
}

async function fetchWeather(lat, lon, city) {
  // 优先用坐标精确定位，坐标缺失时降级到城市名
  const query = (lat != null && lon != null)
    ? (lat + ',' + lon)
    : encodeURIComponent(city || 'Beijing')

  const data = await fetchJSON(
    'https://wttr.in/' + query + '?format=j1&lang=zh',
    {},
    12000
  )
  if (!data) {
    console.warn('[geo-weather] wttr.in 天气获取失败')
    return null
  }

  const cur = data.current_condition?.[0]
  if (!cur) return null

  return {
    temp:       Number(cur.temp_C),
    feels_like: Number(cur.FeelsLikeC),
    humidity:   Number(cur.humidity),
    condition:  cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '',
    wind_kmh:   Number(cur.windspeedKmph),
    wind_dir:   cur.winddir16Point || '',
    uv_index:   Number(cur.uvIndex),
    visibility: Number(cur.visibility),
    today:      parseWttrDay(data.weather?.[0]),
    tomorrow:   parseWttrDay(data.weather?.[1]),
    fetched_at: new Date().toISOString(),
  }
}

// ─── 核心：采集 + 落盘 ────────────────────────────────────────────────────────

export async function collectGeoWeather() {
  // 读取已有缓存
  let stored = null
  if (fs.existsSync(GEO_WEATHER_FILE)) {
    stored = safe(() => JSON.parse(fs.readFileSync(GEO_WEATHER_FILE, 'utf8')))
  }

  let location = (stored?.version === GEO_WEATHER_VERSION) ? (stored.location || null) : null

  // 先轻量查一次当前公网 IP（复用 ip-api 调用，不做完整定位）
  const ipCheck = await fetchJSON(
    'http://ip-api.com/json/?fields=status,query',
    {},
    5000
  )
  const currentIP = (ipCheck?.status === 'success') ? ipCheck.query : null

  // 触发重查的两个条件：IP 变更（网络切换 / 出差），或缓存超过 7 天
  const cachedIP = location?.ip || null
  const locationAge = location?.collected_at
    ? Date.now() - new Date(location.collected_at).getTime()
    : Infinity
  const ipChanged  = currentIP && cachedIP && currentIP !== cachedIP
  const tooOld     = locationAge > LOCATION_REFRESH_MS

  if (ipChanged || tooOld || !location) {
    const reason = !location ? '首次采集' : ipChanged ? ('IP 变更 ' + cachedIP + ' → ' + currentIP) : '缓存超 7 天'
    console.log('[geo-weather] 刷新位置信息（' + reason + ')...')
    const fresh = await fetchLocation()
    if (fresh) {
      location = fresh
    } else if (location) {
      console.warn('[geo-weather] 位置刷新失败，沿用缓存')
    }
  } else {
    console.log('[geo-weather] 位置缓存有效（IP 未变），跳过重新定位')
  }

  // 天气：每次启动都刷新
  let weather = null
  if (location) {
    console.log('[geo-weather] 获取天气数据...')
    weather = await fetchWeather(location.lat, location.lon, location.city)
  }

  const result = {
    version:  GEO_WEATHER_VERSION,
    location: location || null,
    weather:  weather  || null,
  }

  safe(() => fs.writeFileSync(GEO_WEATHER_FILE, JSON.stringify(result, null, 2), 'utf8'))
  _cached = result

  const locLabel = location ? (location.city + ' (' + location.lat + ', ' + location.lon + ')') : '未知'
  const wxLabel  = weather  ? (weather.condition + ' ' + weather.temp + '°C') : '获取失败'
  console.log('[geo-weather] 完成 — 位置:', locLabel, '| 天气:', wxLabel)
  return result
}

// ─── 对外接口 ─────────────────────────────────────────────────────────────────

/**
 * 同步返回缓存的国家代码（大写，如 "CN"）。collectGeoWeather() 完成前或失败时返回 null。
 * 供工具层（如 media_mode 视频平台决策）快速判断用户地区，无需走 prompt。
 */
export function getCountryCode() {
  const cc = loadStoredGeoWeather()?.location?.country_code
  return cc ? String(cc).toUpperCase() : null
}

/**
 * 返回可供本地 UI 使用的脱敏天气快照。
 * 不包含公网 IP、运营商、精确坐标或完整地址。
 */
export function getGeoWeatherSnapshot() {
  loadStoredGeoWeather()

  const loc = _cached?.location
  const weather = _cached?.weather
  return {
    location: loc ? {
      city: loc.city || null,
      district: loc.district || null,
      region: loc.region || null,
      country: loc.country || null,
      countryCode: loc.country_code || null,
      timezone: loc.timezone || null,
    } : null,
    weather: weather ? {
      temp: weather.temp,
      feelsLike: weather.feels_like,
      humidity: weather.humidity,
      condition: weather.condition || '',
      windKmh: weather.wind_kmh,
      windDir: weather.wind_dir || '',
      uvIndex: weather.uv_index,
      visibility: weather.visibility,
      today: weather.today || null,
      tomorrow: weather.tomorrow || null,
      fetchedAt: weather.fetched_at || null,
    } : null,
  }
}

/**
 * 返回注入 system prompt 的纯文本块。
 * 必须在 collectGeoWeather() 完成后调用。
 */
export function getGeoWeatherBlock() {
  if (!_cached) return ''
  const parts = []

  // —— 位置块 ——
  const loc = _cached.location
  if (loc) {
    const lines = ['## Location & Coordinates']
    lines.push('Coordinates: ' + loc.lat + ', ' + loc.lon)

    const place = [loc.district, loc.city, loc.region, loc.country].filter(Boolean).join(', ')
    if (place) lines.push('Address: ' + place)
    if (loc.country_code) lines.push('Country Code: ' + loc.country_code)
    if (loc.timezone)     lines.push('Timezone: ' + loc.timezone)
    if (loc.ip)           lines.push('Public IP: ' + loc.ip + (loc.isp ? ' · ' + loc.isp : ''))
    if (loc.display_name) lines.push('Full Address: ' + loc.display_name)

    parts.push(lines.join('\n'))
  }

  // —— 天气块 ——
  const w = _cached.weather
  if (w) {
    const lines = ['## Current Weather']
    lines.push(
      'Now: ' + w.condition +
      ' · ' + w.temp + '°C (feels like ' + w.feels_like + '°C)' +
      ' · Humidity ' + w.humidity + '%'
    )
    lines.push(
      'Wind: ' + w.wind_kmh + ' km/h ' + w.wind_dir +
      ' · UV Index ' + w.uv_index +
      ' · Visibility ' + w.visibility + ' km'
    )

    if (w.today) {
      let todayLine = 'Today (' + w.today.date + '): ' + w.today.condition +
        ' · High ' + w.today.high + '°C / Low ' + w.today.low + '°C'
      if (w.today.sunrise) todayLine += ' · Sunrise ' + w.today.sunrise + ' / Sunset ' + w.today.sunset
      lines.push(todayLine)
    }

    if (w.tomorrow) {
      lines.push(
        'Tomorrow (' + w.tomorrow.date + '): ' + w.tomorrow.condition +
        ' · High ' + w.tomorrow.high + '°C / Low ' + w.tomorrow.low + '°C'
      )
    }

    parts.push(lines.join('\n'))
  }

  return parts.join('\n\n')
}
