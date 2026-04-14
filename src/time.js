// 统一时间工具，使用系统本地时区

export function nowISO() {
  return new Date().toLocaleString('sv-SE', { timeZoneName: 'short' })
    .replace(' ', 'T').replace(/\s.*/, '')
}

export function nowTimestamp() {
  // 格式：2026-04-11T15:32:00+08:00
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const absOffset = Math.abs(offset)
  const offsetStr = `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetStr}`
}

export function formatTick() {
  return `TICK ${nowTimestamp()}`
}

// 将毫秒时长转换为自然语言描述
export function describeExistence(birthTimeISO) {
  const ms = Date.now() - new Date(birthTimeISO).getTime()
  const minutes = Math.floor(ms / 60000)
  const hours = Math.floor(ms / 3600000)
  const days = Math.floor(ms / 86400000)

  if (minutes < 3)   return '刚刚苏醒'
  if (minutes < 15)  return `已经醒来 ${minutes} 分钟了`
  if (minutes < 60)  return `已经存在了约 ${minutes} 分钟`
  if (hours < 24)    return `已经存在了约 ${hours} 小时`
  if (days < 7)      return `已经存在了 ${days} 天`
  return `已经存在了 ${days} 天（${Math.floor(days / 7)} 周）`
}
