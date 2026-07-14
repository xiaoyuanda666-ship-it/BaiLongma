// 回复提示音偏好（localStorage）—— 镜像 tts-fx.js 的 jarvis.<feature> + getItem/setItem try/catch 模式
// 默认开（保留现状）；'0' = 关。
export const ALERT_SOUND_KEY = 'jarvis.alertSound'

// 纯函数：把存储值解析成开关状态（便于单测，不依赖 localStorage）。
// null / undefined / 非 '0' → true（默认开，保留现状）；'0' → false。
export function parseAlertEnabled(stored) {
  return stored !== '0'
}

export function isAlertEnabled() {
  try {
    return parseAlertEnabled(localStorage.getItem(ALERT_SOUND_KEY))
  } catch {
    return true // localStorage 不可用时默认开（保留现状）
  }
}

export function setAlertEnabled(enabled) {
  try {
    localStorage.setItem(ALERT_SOUND_KEY, enabled ? '1' : '0')
  } catch { /* ignore */ }
}
