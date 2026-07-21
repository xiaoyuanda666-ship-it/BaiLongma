// web_read: one known URL, one stateless result.
// Strategy: protected direct HTTP -> local Playwright -> optional Jina Reader.
import { config } from '../../../config.js'
import { assertBrowserUrlAllowed } from '../browser/index.js'
import { createMergedAbortSignal, throwIfAborted } from '../../abort-utils.js'
import {
  WEB_HEADERS, webJson, normalizeWebUrl, htmlToText, extractTitle, isLowValuePageText,
  saveLongArticle, ARTICLE_LENGTH_THRESHOLD, ARTICLE_SUMMARY_EXCERPT,
} from './util.js'
import { execBrowserRead } from './browser-read.js'

const urlCache = new Map()
const URL_TTL_MS = {
  default: 60 * 60 * 1000,
  weather: 10 * 60 * 1000,
  news: 5 * 60 * 1000,
}

function getUrlTtl(url) {
  const value = url.toLowerCase()
  if (value.includes('wttr.in') || value.includes('weather') || value.includes('openweather') || value.includes('tianqi')) {
    return URL_TTL_MS.weather
  }
  if (value.includes('news') || value.includes('rss') || value.includes('feed')) return URL_TTL_MS.news
  return URL_TTL_MS.default
}

function isLikelyApiUrl(url) {
  const value = String(url || '').toLowerCase()
  return /\.json(?:\?|#|$)/.test(value)
    || /[?&](format|output|alt)=json\b/.test(value)
    || /\/api\//.test(value)
    || /\/(rest|graphql)\//.test(value)
}

async function allowedUrl(url) {
  return assertBrowserUrlAllowed(url, {
    allowPrivateNetwork: () => config.security?.browserPrivateNetwork === true,
  })
}

async function fetchWithProtectedRedirects(url, options = {}, maxRedirects = 5) {
  let current = await allowedUrl(url)
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const response = await fetch(current, { ...options, redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: current }
    }
    const location = response.headers.get('location')
    if (!location) return { response, finalUrl: current }
    if (redirects === maxRedirects) throw new Error(`too many redirects (>${maxRedirects})`)
    current = await allowedUrl(new URL(location, current).href)
  }
  throw new Error('redirect handling failed')
}

async function fetchViaDirect(url, signal, { expectJson = false, timeoutMs = 12_000 } = {}) {
  const merged = createMergedAbortSignal(signal, timeoutMs)
  try {
    const { response, finalUrl } = await fetchWithProtectedRedirects(url, {
      headers: WEB_HEADERS,
      signal: merged?.signal,
    })
    if (!response.ok) return { ok: false, status: response.status, final_url: finalUrl }
    const contentType = response.headers.get('content-type') || ''
    if (contentType && !/text|html|xml|json/i.test(contentType)) {
      return { ok: false, status: response.status, content_type: contentType, final_url: finalUrl }
    }
    const raw = await response.text()
    const looksJson = (expectJson || /json/i.test(contentType)) && /^\s*[\[{]/.test(raw)
    if (looksJson) {
      let body = raw.trim()
      try { body = JSON.stringify(JSON.parse(raw), null, 2) } catch {}
      return { ok: true, status: response.status, title: '', body, is_json: true, final_url: finalUrl }
    }
    const text = htmlToText(raw)
    const title = extractTitle(raw)
    if (isLowValuePageText(text)) {
      return { ok: false, status: response.status, title, low_value: true, final_url: finalUrl }
    }
    return { ok: true, status: response.status, title, body: text, final_url: finalUrl }
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return { ok: false, code: err.code, error: err.message || String(err) }
  } finally {
    merged?.cleanup()
  }
}

async function fetchViaJina(url, signal, timeoutMs = 20_000) {
  const merged = createMergedAbortSignal(signal, timeoutMs)
  try {
    const response = await fetch(`https://r.jina.ai/${url}`, {
      headers: {
        Accept: 'text/plain',
        'X-Return-Format': 'markdown',
        'X-Timeout': String(Math.max(5, Math.floor(timeoutMs / 1000))),
        'User-Agent': WEB_HEADERS['User-Agent'],
      },
      signal: merged?.signal,
    })
    if (!response.ok) return { ok: false, status: response.status, error: `Jina HTTP ${response.status}` }
    const text = (await response.text()).trim()
    if (isLowValuePageText(text)) return { ok: false, error: 'Jina returned no readable content' }
    const titleMatch = text.match(/^Title:\s*(.+)/m)
    const title = titleMatch?.[1]?.trim() || ''
    const body = text
      .replace(/^Title:.*\n?/m, '')
      .replace(/^URL Source:.*\n?/m, '')
      .replace(/^Markdown Content:\n?/m, '')
      .trim()
    return { ok: true, title, body, final_url: url }
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return { ok: false, error: err.message || String(err) }
  } finally {
    merged?.cleanup()
  }
}

function buildPayload({ url, finalUrl, status = null, source, title = '', text, isJson = false, maxChars = 5_000 }) {
  const isLong = !isJson && text.length >= ARTICLE_LENGTH_THRESHOLD
  let bodyPath = null
  let bodyBytes = null
  if (isLong) {
    try {
      const saved = saveLongArticle({ url, finalUrl, title, body: text, source })
      bodyPath = saved.path
      bodyBytes = saved.bytes
    } catch (err) {
      console.warn(`[web_read] failed to save long article: ${err.message}`)
    }
  }
  const inlineLimit = Math.max(1_000, Math.min(Number(maxChars) || 5_000, 20_000))
  const content = isLong
    ? `${text.slice(0, ARTICLE_SUMMARY_EXCERPT)}\n\n...`
    : (text.length > inlineLimit ? `${text.slice(0, inlineLimit)}\n\n...` : text)
  return {
    ok: true,
    tool: 'web_read',
    url,
    final_url: finalUrl || url,
    status,
    read_source: source,
    is_json: isJson || undefined,
    title,
    content,
    truncated: isLong || text.length > inlineLimit,
    content_length: text.length,
    body_path: bodyPath,
    body_bytes: bodyBytes,
    hint: bodyPath
      ? `Long article saved. Full text at sandbox path: ${bodyPath}. Use read_file to open it.`
      : 'Use this page content with other sources if needed, then answer the user.',
  }
}

function shouldTryBrowser(result = {}) {
  return result.low_value === true
    || result.status === 403
    || result.status === 429
    || result.status === 503
    || (result.status == null && !result.code?.includes('PRIVATE_NETWORK'))
}

function parseToolJson(raw) {
  try { return JSON.parse(raw) } catch { return null }
}

export async function execWebRead(args, context = {}) {
  throwIfAborted(context.signal)
  const rawUrl = normalizeWebUrl(args.url || args.URL || args.link || args.href || args.uri)
  if (!rawUrl) return webJson({ ok: false, tool: 'web_read', error: 'missing url' })

  let url
  try {
    url = await allowedUrl(rawUrl)
  } catch (err) {
    return webJson({ ok: false, tool: 'web_read', url: rawUrl, code: err.code, error: err.message || String(err) })
  }

  const legacyNoBrowser = args.no_browser_fallback === true
  const render = legacyNoBrowser ? 'http' : String(args.render || 'auto').toLowerCase()
  if (!['auto', 'http', 'browser'].includes(render)) {
    return webJson({ ok: false, tool: 'web_read', url, error: `invalid render mode: ${render}` })
  }
  const remoteFallback = args.remote_fallback !== false
  const timeoutMs = Math.max(1_000, Math.min(Number(args.timeout_ms || args.timeout || 20_000), 45_000))
  const maxChars = Math.max(1_000, Math.min(Number(args.max_chars || args.maxChars || 5_000), 20_000))
  const cacheKey = `${url}::${render}::${remoteFallback}`
  const cached = urlCache.get(cacheKey)
  if (args.fresh !== true && cached && Date.now() - cached.fetchedAt < getUrlTtl(url)) {
    const ageMinutes = Math.round((Date.now() - cached.fetchedAt) / 60_000)
    return webJson({ ...cached.payload, cached: true, cache_age_minutes: ageMinutes })
  }

  console.log(`[web_read] ${render} -> ${url}`)
  const failures = []
  let directResult = null

  if (render !== 'browser') {
    directResult = await fetchViaDirect(url, context.signal, {
      expectJson: isLikelyApiUrl(url),
      timeoutMs,
    })
    if (directResult.ok) {
      const payload = buildPayload({
        url,
        finalUrl: directResult.final_url,
        status: directResult.status,
        source: 'http',
        title: directResult.title,
        text: directResult.body,
        isJson: directResult.is_json,
        maxChars,
      })
      urlCache.set(cacheKey, { payload, fetchedAt: Date.now() })
      return webJson(payload)
    }
    failures.push({ strategy: 'http', status: directResult.status, code: directResult.code, error: directResult.error || 'no readable content' })
    if (render === 'http') {
      return webJson({ ok: false, tool: 'web_read', url, failures, error: directResult.error || `HTTP read failed${directResult.status ? ` (${directResult.status})` : ''}` })
    }
  }

  if (render === 'browser' || shouldTryBrowser(directResult || {})) {
    const browserRaw = await execBrowserRead({ url, max_chars: maxChars, timeout_ms: timeoutMs }, context)
    const browserResult = parseToolJson(browserRaw)
    if (browserResult?.ok) {
      const payload = {
        ...browserResult,
        tool: 'web_read',
        read_source: 'playwright',
      }
      delete payload.fetch_source
      urlCache.set(cacheKey, { payload, fetchedAt: Date.now() })
      return webJson(payload)
    }
    failures.push({ strategy: 'playwright', code: browserResult?.code, error: browserResult?.error || 'browser rendering failed' })
    if (render === 'browser') {
      return webJson({ ok: false, tool: 'web_read', url, failures, error: 'local Playwright rendering failed' })
    }
  }

  if (remoteFallback) {
    const jinaResult = await fetchViaJina(url, context.signal, timeoutMs)
    if (jinaResult.ok) {
      const payload = buildPayload({
        url,
        finalUrl: jinaResult.final_url,
        source: 'jina',
        title: jinaResult.title,
        text: jinaResult.body,
        maxChars,
      })
      payload.remote_fallback = true
      urlCache.set(cacheKey, { payload, fetchedAt: Date.now() })
      return webJson(payload)
    }
    failures.push({ strategy: 'jina', status: jinaResult.status, error: jinaResult.error || 'remote reader failed' })
  }

  return webJson({
    ok: false,
    tool: 'web_read',
    url,
    error: 'all enabled read strategies failed',
    failures,
    hint: 'Try another reliable result URL from web_search.',
  })
}

// Backward-compatible executor alias. It is intentionally absent from schemas.
export const execFetchUrl = execWebRead
