// 官方台风预警的可配置监测器。
// 不把网页路径或风速阈值当成预警：只有接入方提供的正式预警流中出现目标地区的橙/红预警才会自动打开面板。
import { getConfig, setConfig } from './db.js'
import { emitEvent } from './runtime/events.js'

const POLL_MS = 5 * 60 * 1000
const LAST_ALERT_KEY = 'typhoon_alert_last_id'

function textOf(alert = {}) {
  return [alert.title, alert.headline, alert.description, alert.content, alert.type, alert.event, alert.region, alert.area, alert.level, alert.severity]
    .filter(Boolean).join(' ')
}

export function normalizeTyphoonAlerts(payload) {
  const rows = Array.isArray(payload) ? payload : (payload?.alerts || payload?.data?.alerts || payload?.data || payload?.records || [])
  if (!Array.isArray(rows)) return []
  return rows.map((alert, index) => {
    const text = textOf(alert)
    const isTyphoon = /台风|热带气旋|typhoon|tropical cyclone/i.test(text)
    const severe = /红色|橙色|red|orange/i.test(String(alert?.level || alert?.severity || text))
    const id = String(alert?.id || alert?.identifier || alert?.warningId || `${alert?.title || alert?.event || 'alert'}-${alert?.publishedAt || alert?.issueTime || index}`)
    return { id, title: alert?.title || alert?.headline || alert?.event || '台风预警', level: alert?.level || alert?.severity || '', region: alert?.region || alert?.area || '', issuedAt: alert?.publishedAt || alert?.issueTime || alert?.effective || '', content: alert?.description || alert?.content || '', isTyphoon, severe, rawText: text }
  }).filter(alert => alert.isTyphoon && alert.severe)
}

async function fetchAlertFeed(url, token) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal })
    if (!res.ok) throw new Error(`预警源请求失败 (${res.status})`)
    return normalizeTyphoonAlerts(await res.json())
  } finally { clearTimeout(timer) }
}

export function startTyphoonAlertMonitor() {
  const url = String(process.env.TYPHOON_ALERT_URL || '').trim()
  const regions = String(process.env.TYPHOON_ALERT_REGION || '').split(',').map(item => item.trim()).filter(Boolean)
  if (!url || !regions.length) {
    console.log('[typhoon-alert] 自动弹窗未启用：需要配置 TYPHOON_ALERT_URL 和 TYPHOON_ALERT_REGION')
    return () => {}
  }
  const poll = async () => {
    try {
      const alerts = await fetchAlertFeed(url, String(process.env.TYPHOON_ALERT_TOKEN || '').trim())
      const alert = alerts.find(item => regions.some(region => item.rawText.includes(region)))
      if (!alert || getConfig(LAST_ALERT_KEY) === alert.id) return
      setConfig(LAST_ALERT_KEY, alert.id)
      emitEvent('typhoon_alert', { ...alert, source: 'official_alert_feed' })
      emitEvent('typhoon_mode', { action: 'show', active: true, reason: `${alert.region || regions.join('/')} ${alert.level || '高等级'}台风预警` })
      emitEvent('action', { tool: 'typhoon_alert_monitor', summary: '高等级台风预警触发台风大屏', detail: alert.title })
    } catch (err) {
      console.warn('[typhoon-alert] 轮询失败:', err?.message || err)
    }
  }
  poll()
  const timer = setInterval(poll, POLL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
