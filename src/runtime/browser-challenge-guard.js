const BLOCKED_WEB_TOOLS = new Set([
  'web_search',
  'web_read',
  'fetch_url',
  'browser_read',
  'system_browser_open',
])

const NON_PAGE_BROWSER_TOOLS = new Set([
  'browser_clear_data',
  'browser_close',
  'browser_set_display_mode',
])

const STRONG_CHALLENGE_TITLE_RE = /^\s*(?:百度安全验证|人机验证|安全验证|验证码|captcha|verify\s+(?:that\s+)?you(?:'re|\s+are)?\s+(?:a\s+)?human|checking\s+(?:your\s+browser|if\s+you\s+are\s+human)|just\s+a\s+moment)[.!。…]*(?:\s*[-|–—·]\s*.{1,60})?\s*$/i
const STRONG_CHALLENGE_TEXT_RE = /(?:请输入验证码|完成(?:安全|人机)?验证(?:后|以便|才能)?继续|检测到异常请求|unusual\s+traffic\s+from\s+your\s+(?:computer\s+)?network|prove\s+(?:that\s+)?you(?:'re|\s+are)?\s+(?:a\s+)?human)/i

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function contentText(payload) {
  if (!Array.isArray(payload?.content)) return ''
  return payload.content
    .map(item => typeof item?.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n')
    .slice(0, 200_000)
}

function pageUrls(payload, text) {
  const values = []
  if (typeof payload?.browser_preview?.url === 'string') values.push(payload.browser_preview.url)
  if (typeof payload?.url === 'string') values.push(payload.url)
  for (const match of text.matchAll(/Page URL:\s*(https?:\/\/[^\s<>"']+)/gi)) {
    values.push(match[1])
    if (values.length >= 12) break
  }
  return values
}

function isChallengeUrl(value) {
  try {
    const url = new URL(String(value || ''))
    const hostname = url.hostname.toLowerCase()
    const pathname = decodeURIComponent(url.pathname).toLowerCase()
    if (/(?:^|\.)(?:captcha|challenge)\./.test(hostname)) return true
    if (hostname === 'wappass.baidu.com' && /\/(?:static\/)?captcha(?:\/|$)/.test(pathname)) return true
    return /\/(?:captcha|challenge)(?:[\/_-]|\/|$)/.test(pathname)
      || /\/(?:security-check|human-verification)(?:[\/_-]|\/|$)/.test(pathname)
  } catch {
    return false
  }
}

function pageTitles(payload, text) {
  const values = []
  if (typeof payload?.browser_preview?.title === 'string') values.push(payload.browser_preview.title)
  if (typeof payload?.title === 'string') values.push(payload.title)
  for (const match of text.matchAll(/Page Title:\s*([^\r\n]+)/gi)) {
    values.push(match[1])
    if (values.length >= 6) break
  }
  return values
}

export function detectBrowserChallenge(toolName, result) {
  const name = String(toolName || '')
  if (!name.startsWith('browser_') || NON_PAGE_BROWSER_TOOLS.has(name)) return null
  const payload = parseJsonObject(result)
  const text = payload ? contentText(payload) : String(result || '').slice(0, 200_000)
  if (pageUrls(payload, text).some(isChallengeUrl)) {
    return { detected: true, reason: 'challenge_url' }
  }
  if (pageTitles(payload, text).some(title => STRONG_CHALLENGE_TITLE_RE.test(title))) {
    return { detected: true, reason: 'challenge_title' }
  }
  if (STRONG_CHALLENGE_TEXT_RE.test(text)) {
    return { detected: true, reason: 'challenge_text' }
  }
  return null
}

export function isBrowserAccessBlockedAfterChallenge(toolName) {
  const name = String(toolName || '')
  if (name === 'browser_set_display_mode') return false
  return name.startsWith('browser_') || BLOCKED_WEB_TOOLS.has(name)
}

const STOP_INSTRUCTION = 'Stop all automated web access for this user turn. Do not navigate to another provider, click, type, inspect repeatedly, solve the challenge, or close the page. Leave it available for the user; The same real Chrome Agent Window remains available; use the browser task controls to take over and explicitly resume.'

export function markBrowserChallengeResult(result, detection) {
  const guard = {
    detected: true,
    reason: detection?.reason || 'challenge_detected',
    scope: 'current_user_turn',
    automated_web_access_blocked: true,
  }
  const payload = parseJsonObject(result)
  if (!payload) {
    return `${String(result || '')}\n\n[Bailongma browser challenge guard]\n${JSON.stringify({
      ok: false,
      browser_challenge: guard,
      instruction: STOP_INSTRUCTION,
    })}`
  }
  return JSON.stringify({
    ...payload,
    upstream_ok: payload.ok === true,
    ok: false,
    error: payload.error || 'browser challenge requires manual user action',
    browser_challenge: guard,
    instruction: STOP_INSTRUCTION,
  }, null, 2)
}

export function makeBrowserChallengeStoppedResult(toolName, detection) {
  return JSON.stringify({
    ok: false,
    tool: String(toolName || ''),
    skipped: 'browser_challenge_stop',
    error: 'automated web access stopped after a browser challenge was detected',
    browser_challenge: {
      detected: true,
      reason: detection?.reason || 'challenge_detected',
      scope: 'current_user_turn',
    },
    instruction: STOP_INSTRUCTION,
  }, null, 2)
}
