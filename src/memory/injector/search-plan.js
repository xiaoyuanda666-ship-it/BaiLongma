export function buildMemorySearchPlan({ hasHistory = false, hasHint = false, confidenceHint = null } = {}) {
  const CONF_MULT = { low: 1.5, medium: 1.0, high: 0.7 }
  const mult = CONF_MULT[confidenceHint] || 1.0
  const scale = (n) => Math.max(1, Math.round(n * mult))

  const baseFocusLimit      = hasHistory ? 15 : (hasHint ? 12 : 8)
  const baseContextLimit    = hasHistory ? 10 : 0
  const baseFocusKeywords   = hasHistory ? 10 : (hasHint ? 10 : 8)
  const baseContextKeywords = hasHistory ? 14 : 0

  return {
    focusLimit: scale(baseFocusLimit),
    contextLimit: baseContextLimit === 0 ? 0 : scale(baseContextLimit),
    focusKeywords: scale(baseFocusKeywords),
    contextKeywords: baseContextKeywords === 0 ? 0 : scale(baseContextKeywords),
    perKeyword: 5,
  }
}
