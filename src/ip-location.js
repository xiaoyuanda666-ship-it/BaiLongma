/**
 * ip-location.js
 *
 * 根据访问者 IP 地址分析网络环境、定位位置，并提供建议。
 * 支持检测：
 *   - 本地访问（127.0.0.1/localhost）
 *   - 局域网访问（192.168.x.x/10.x.x.x/172.16-31.x.x）
 *   - 公网访问（包含地理位置定位）
 *
 * 对外接口：
 *   analyzeRequestIP(req)        → 分析单个请求的 IP 信息
 *   getNetworkInfo(ip)           → 获取网络环境分析
 *   getIPLocation(ip)            → 获取 IP 地理位置（仅限公网 IP）
 */

import fs from 'fs'
import path from 'path'
import net from 'net'
import os from 'os'
import { paths } from './paths.js'

const IP_LOCATION_CACHE_FILE = path.join(paths.dataDir, 'ip-location-cache.json')
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6 小时缓存

let _cache = null
let _currentVisitorInfo = null

function safe(fn, fallback = null) {
  try { return fn() } catch { return fallback }
}

// 加载缓存
function loadCache() {
  if (_cache) return _cache
  _cache = safe(() => JSON.parse(fs.readFileSync(IP_LOCATION_CACHE_FILE, 'utf8')), {})
  return _cache
}

// 保存缓存
function saveCache() {
  safe(() => fs.writeFileSync(IP_LOCATION_CACHE_FILE, JSON.stringify(_cache, null, 2), 'utf8'))
}

// 清理过期缓存
function cleanExpiredCache() {
  const cache = loadCache()
  const now = Date.now()
  let changed = false
  for (const ip of Object.keys(cache)) {
    if (now - cache[ip].cached_at > CACHE_TTL_MS) {
      delete cache[ip]
      changed = true
    }
  }
  if (changed) saveCache()
}

// 标准化 IP 地址
function normalizeIP(ip) {
  if (!ip) return ''
  ip = String(ip).trim()
  if (ip.startsWith('::ffff:')) return ip.slice(7)
  return ip
}

// 判断是否为回环地址
function isLoopbackIP(ip) {
  ip = normalizeIP(ip)
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost'
}

// 判断是否为局域网地址
function isPrivateIP(ip) {
  ip = normalizeIP(ip)
  if (!ip) return false

  if (net.isIP(ip) === 4) {
    const parts = ip.split('.').map(Number)
    return (parts[0] === 10) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254)
  }

  if (net.isIP(ip) === 6) {
    return ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')
  }

  return false
}

// 获取本地网络接口信息
function getLocalNetworkInfo() {
  const ifaces = os.networkInterfaces()
  const interfaces = []

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs || []) {
      if (!addr.internal && addr.family === 'IPv4') {
        interfaces.push({
          name,
          address: addr.address,
          netmask: addr.netmask,
          cidr: addr.cidr,
        })
      }
    }
  }

  return interfaces
}

// 分析 IP 所属网络类型
function analyzeNetworkType(ip) {
  ip = normalizeIP(ip)

  if (isLoopbackIP(ip)) {
    return {
      type: 'localhost',
      description: '本地访问（本机）',
      security_level: 'high',
      suggestions: [
        '这是安全的本地访问，您可以放心使用所有功能',
        '建议开启自动备份功能保护数据安全'
      ]
    }
  }

  if (isPrivateIP(ip)) {
    const parts = ip.split('.').map(Number)
    let subnetType = 'private'
    let subnetDesc = '局域网'

    if (parts[0] === 10) {
      subnetType = 'class_a_private'
      subnetDesc = 'A 类私有网络'
    } else if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
      subnetType = 'class_b_private'
      subnetDesc = 'B 类私有网络'
    } else if (parts[0] === 192 && parts[1] === 168) {
      subnetType = 'class_c_private'
      subnetDesc = 'C 类私有网络'
    } else if (parts[0] === 169 && parts[1] === 254) {
      subnetType = 'link_local'
      subnetDesc = '链路本地地址'
    }

    return {
      type: 'lan',
      subnet_type: subnetType,
      description: `局域网访问（${subnetDesc}）`,
      security_level: 'medium',
      suggestions: [
        '您正在同一局域网内访问，建议确保网络环境安全',
        '如果在公司网络，建议确认公司网络安全策略',
        '可以考虑使用 HTTPS 增强安全性'
      ]
    }
  }

  return {
    type: 'public',
    description: '公网访问',
    security_level: 'low',
    suggestions: [
        '检测到公网访问，请确保您的访问是安全的',
        '建议启用访问令牌（API Token）增强安全性',
        '请确认您信任的网络环境',
        '定期检查访问日志，留意异常访问'
    ]
  }
}

// 从请求中提取真实 IP
function extractClientIP(req) {
  // 优先检查常见的代理头
  const forwardedFor = req.headers['x-forwarded-for']
  if (forwardedFor) {
    const ips = forwardedFor.split(',').map(s => s.trim())
    for (const ip of ips) {
      if (ip) return normalizeIP(ip)
    }
  }

  if (req.headers['x-real-ip']) {
    return normalizeIP(req.headers['x-real-ip'])
  }

  if (req.headers['cf-connecting-ip']) { // Cloudflare
    return normalizeIP(req.headers['cf-connecting-ip'])
  }

  // 回退到 socket 地址
  return normalizeIP(req.socket?.remoteAddress)
}

// 获取网络环境分析
export function getNetworkInfo(ip) {
  const normalizedIP = normalizeIP(ip)
  const networkType = analyzeNetworkType(normalizedIP)
  const localInterfaces = getLocalNetworkInfo()

  return {
    ip: normalizedIP,
    ...networkType,
    local_network_interfaces: localInterfaces,
    analyzed_at: new Date().toISOString()
  }
}

// 获取 IP 地理位置（仅限公网 IP）
export async function getIPLocation(ip) {
  const normalizedIP = normalizeIP(ip)

  if (isLoopbackIP(normalizedIP) || isPrivateIP(normalizedIP)) {
    return {
      ip: normalizedIP,
      location_type: 'private',
      message: '内网 IP 不支持地理位置查询',
      analyzed_at: new Date().toISOString()
    }
  }

  // 检查缓存
  const cache = loadCache()
  if (cache[normalizedIP] && Date.now() - cache[normalizedIP].cached_at < CACHE_TTL_MS) {
    console.log('[ip-location] 使用缓存的地理位置:', normalizedIP)
    return cache[normalizedIP]
  }

  try {
    // 使用 ip-api.com 查询
    const response = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(normalizedIP)}?fields=status,query,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as`
    )

    if (!response.ok) {
      throw new Error('HTTP ' + response.status)
    }

    const data = await response.json()

    if (data.status !== 'success') {
      throw new Error(data.message || '定位失败')
    }

    const location = {
      ip: data.query,
      location_type: 'public',
      country: data.country,
      country_code: data.countryCode,
      region: data.regionName,
      region_code: data.region,
      city: data.city,
      zip: data.zip,
      latitude: data.lat,
      longitude: data.lon,
      timezone: data.timezone,
      isp: data.isp,
      org: data.org,
      as: data.as,
      formatted_address: [data.city, data.regionName, data.country].filter(Boolean).join(', '),
      cached_at: Date.now(),
      analyzed_at: new Date().toISOString()
    }

    // 缓存结果
    cache[normalizedIP] = location
    saveCache()

    console.log('[ip-location] 成功获取地理位置:', normalizedIP, '→', location.city)
    return location

  } catch (error) {
    console.warn('[ip-location] 定位失败:', error.message)
    return {
      ip: normalizedIP,
      location_type: 'public',
      error: error.message,
      message: '地理位置查询失败',
      analyzed_at: new Date().toISOString()
    }
  }
}

// 分析请求 IP 的完整信息
export async function analyzeRequestIP(req) {
  const ip = extractClientIP(req)
  const networkInfo = getNetworkInfo(ip)
  let location = null

  if (networkInfo.type === 'public') {
    location = await getIPLocation(ip)
  }

  // 生成 AI 建议
  const aiSuggestions = generateAISuggestions(networkInfo, location)

  const result = {
    ip,
    network: networkInfo,
    location,
    ai_suggestions: aiSuggestions,
    analyzed_at: new Date().toISOString()
  }

  // 设置当前访客信息
  setCurrentVisitorInfo(result)

  return result
}

// 生成 AI 建议
function generateAISuggestions(networkInfo, location) {
  const suggestions = []
  const context = []

  // 网络环境上下文
  if (networkInfo.type === 'localhost') {
    context.push('您正在本地访问，这是最安全的访问方式')
    suggestions.push('可以放心使用所有功能，包括文件操作和系统命令')
    suggestions.push('建议定期备份数据')
  } else if (networkInfo.type === 'lan') {
    context.push('您正在局域网内访问')
    suggestions.push('确保您的局域网是安全的')
    suggestions.push('避免在公共 WiFi 环境下使用')
    suggestions.push('可以使用大部分功能，但请注意保护隐私')
  } else {
    context.push('检测到公网访问，请务必注意安全')
    suggestions.push('建议设置强密码或 API 令牌')
    suggestions.push('避免在公网环境下执行敏感操作')
    suggestions.push('考虑使用 VPN 或专用网络访问')
  }

  // 地理位置上下文
  if (location?.location_type === 'public' && location.city) {
    context.push(`检测到您的大致位置在 ${location.formatted_address || location.city}`)
    suggestions.push(`可以为您提供 ${location.city} 当地的天气、时间等信息`)
    suggestions.push(`注意保护您的位置隐私`)
  }

  // 时间建议
  const now = new Date()
  const hour = now.getHours()
  if (hour >= 6 && hour < 12) {
    suggestions.push('早上好！新的一天开始了')
  } else if (hour >= 12 && hour < 18) {
    suggestions.push('下午好！工作辛苦了')
  } else if (hour >= 18 && hour < 23) {
    suggestions.push('晚上好！注意休息')
  } else {
    suggestions.push('夜深了，注意保护视力')
  }

  return {
    context,
    suggestions,
    generated_at: new Date().toISOString()
  }
}

// 获取用于 AI prompt 的信息块
export function getIPLocationBlock(info) {
  if (!info) return ''

  const lines = ['## Visitor Network & Location']

  lines.push(`Visitor IP: ${info.ip}`)
  lines.push(`Access Type: ${info.network.description}`)

  if (info.location && info.location.location_type === 'public' && info.location.city) {
    lines.push(`Approximate Location: ${info.location.formatted_address || info.location.city}`)
    if (info.location.timezone) {
      lines.push(`Timezone: ${info.location.timezone}`)
    }
    if (info.location.isp) {
      lines.push(`ISP: ${info.location.isp}`)
    }
  }

  if (info.ai_suggestions?.context?.length) {
    lines.push('')
    lines.push('Context:')
    for (const ctx of info.ai_suggestions.context) {
      lines.push(`- ${ctx}`)
    }
  }

  if (info.ai_suggestions?.suggestions?.length) {
    lines.push('')
    lines.push('Suggestions for you:')
    for (const suggestion of info.ai_suggestions.suggestions.slice(0, 3)) {
      lines.push(`- ${suggestion}`)
    }
  }

  return lines.join('\n')
}

// 设置当前访客信息
export function setCurrentVisitorInfo(info) {
  _currentVisitorInfo = info
}

// 获取当前访客信息
export function getCurrentVisitorInfo() {
  return _currentVisitorInfo
}

// 清除当前访客信息
export function clearCurrentVisitorInfo() {
  _currentVisitorInfo = null
}

// 初始化（清理过期缓存）
export function initIPLocation() {
  cleanExpiredCache()
  console.log('[ip-location] 模块已初始化')
}
