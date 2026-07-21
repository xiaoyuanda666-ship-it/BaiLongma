// web_search：第一梯队带 key 的 JSON API（serper/brave/tavily/searxng，串行），
// 第二梯队无 key 爬虫兜底（bing/jina/ddg，并行抢答）。
import { getWebSearchCredentials } from '../../../config.js'
import { createMergedAbortSignal, throwIfAborted } from '../../abort-utils.js'
import { WEB_HEADERS, webJson, htmlToText, decodeHtmlEntities } from './util.js'

// web_search 结果缓存：query::limit → { payload, fetchedAt }
// Map 的插入顺序即 LRU 顺序；写入时若超量则淘汰最老一条
const searchCache = new Map()
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000
const SEARCH_CACHE_MAX = 200

function searchCacheGet(key) {
  const entry = searchCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.fetchedAt >= SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key)
    return null
  }
  searchCache.delete(key)
  searchCache.set(key, entry)
  return entry.payload
}

function searchCacheSet(key, payload) {
  searchCache.set(key, { payload, fetchedAt: Date.now() })
  while (searchCache.size > SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value
    if (oldest === undefined) break
    searchCache.delete(oldest)
  }
}

// 从 config.json 或 process.env 读取上网工具配置
// 5 秒内复用结果，避免一次 web_search 在 5 引擎 fallback 时同步读盘 5 次
let _webConfigCache = null
let _webConfigFetchedAt = 0
const WEB_CONFIG_TTL_MS = 5000

function readWebConfig() {
  const now = Date.now()
  if (_webConfigCache && now - _webConfigFetchedAt < WEB_CONFIG_TTL_MS) {
    return _webConfigCache
  }
  _webConfigCache = getWebSearchCredentials()
  _webConfigFetchedAt = now
  return _webConfigCache
}

function unwrapDuckDuckGoUrl(url) {
  const decoded = decodeHtmlEntities(url)
  const uddg = decoded.match(/[?&]uddg=([^&]+)/)
  if (uddg) {
    try { return decodeURIComponent(uddg[1]) } catch { return uddg[1] }
  }
  if (decoded.startsWith('//')) return `https:${decoded}`
  return decoded
}

// Bing 搜索结果常用 bing.com/ck/a?...&u=a1<base64url> 中转链接；
// 不解包的话下游 web_read 会拿到跳转壳页而不是真正的目标页
function unwrapBingUrl(url) {
  try {
    if (!url || !/bing\.com\/ck\/a/i.test(url)) return url
    const u = new URL(url)
    const raw = u.searchParams.get('u')
    if (!raw) return url
    let encoded = raw.startsWith('a1') ? raw.slice(2) : raw
    encoded = encoded.replace(/-/g, '+').replace(/_/g, '/')
    while (encoded.length % 4) encoded += '='
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
    return /^https?:\/\//i.test(decoded) ? decoded : url
  } catch {
    return url
  }
}

function parseDuckDuckGoResults(html, limit) {
  const raw = []
  const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let match
  while ((match = resultRegex.exec(html)) !== null) {
    const url = unwrapDuckDuckGoUrl(match[1])
    const title = htmlToText(match[2])
    if (!url || !title) continue
    const nextStart = resultRegex.lastIndex
    const nextMatch = html.slice(nextStart).match(/<a[^>]+class="result__a"/i)
    const block = nextMatch ? html.slice(nextStart, nextStart + nextMatch.index) : html.slice(nextStart, nextStart + 2000)
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>|class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i)
    const snippet = htmlToText(snippetMatch?.[1] || snippetMatch?.[2] || '')
    raw.push({ title, url, snippet })
  }
  return normalizeResults(raw, limit)
}

// 引擎返回约定：
//   null                              → 未配置/跳过，不计入失败
//   { ok: true, results, source }     → 成功
//   { ok: false, reason }             → 已尝试但失败，reason 会聚合到最终错误
//
// reason 用简短可读字符串（"http 401"、"empty html"、"blocked or captcha"、"network: ..."），
// 让"key 失效"和"被限速"在日志里能分清楚

const SEARCH_TITLE_MAX = 200
const SEARCH_SNIPPET_MAX = 300
const SEARCH_LOG_QUERY_MAX = 100

function hasCJK(s) {
  return /[㐀-鿿豈-﫿]/.test(s)
}

function truncateForLog(s, max = SEARCH_LOG_QUERY_MAX) {
  const str = String(s || '')
  return str.length <= max ? str : `${str.slice(0, max)}…(${str.length})`
}

// 各引擎 raw 结果统一处理：截断超长字段、丢弃空 url/title、按 URL 去重（host+path，忽略 query/fragment）
function normalizeResults(raw, limit) {
  const out = []
  const seen = new Set()
  for (const r of raw) {
    const url = String(r?.url || '').trim()
    const title = String(r?.title || '').trim().slice(0, SEARCH_TITLE_MAX)
    if (!url || !title) continue
    let dedupKey
    try {
      const u = new URL(url)
      dedupKey = `${u.host}${u.pathname.replace(/\/$/, '')}`
    } catch {
      dedupKey = url
    }
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)
    out.push({
      title,
      url,
      snippet: String(r?.snippet || '').trim().slice(0, SEARCH_SNIPPET_MAX),
    })
    if (out.length >= limit) break
  }
  return out
}

// web_search 引擎1：Serper.dev（Google SERP JSON API，最稳定）
async function searchViaSerper(query, limit, signal) {
  const { serperKey } = readWebConfig()
  if (!serperKey) return null

  const merged = createMergedAbortSignal(signal, 12000)
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': serperKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query,
        num: limit,
        hl: hasCJK(query) ? 'zh-cn' : 'en',
        gl: hasCJK(query) ? 'cn' : 'us',
      }),
      signal: merged?.signal,
    })
    merged?.cleanup()
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? ' (check SERPER_API_KEY)' : ''
      return { ok: false, reason: `http ${res.status}${hint}` }
    }
    const data = await res.json()
    const raw = (data.organic || []).map(r => ({ title: r.title, url: r.link, snippet: r.snippet }))
    const results = normalizeResults(raw, limit)
    if (results.length === 0) return { ok: false, reason: 'empty results' }
    return { ok: true, results, source: 'serper' }
  } catch (err) {
    merged?.cleanup()
    if (err.name === 'AbortError') throw err
    return { ok: false, reason: `network: ${err.message || err}` }
  }
}

// web_search 引擎1b：Brave Search（独立索引的 JSON API，serper 的可靠兜底；免费 2000/月）
async function searchViaBrave(query, limit, signal) {
  const { braveKey } = readWebConfig()
  if (!braveKey) return null

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`
  const merged = createMergedAbortSignal(signal, 12000)
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': braveKey,
      },
      signal: merged?.signal,
    })
    merged?.cleanup()
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? ' (check brave_api_key)' : ''
      return { ok: false, reason: `http ${res.status}${hint}` }
    }
    const data = await res.json()
    const raw = (data?.web?.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.description }))
    const results = normalizeResults(raw, limit)
    if (results.length === 0) return { ok: false, reason: 'empty results' }
    return { ok: true, results, source: 'brave' }
  } catch (err) {
    merged?.cleanup()
    if (err.name === 'AbortError') throw err
    return { ok: false, reason: `network: ${err.message || err}` }
  }
}

// web_search 引擎1c：Tavily（面向 LLM 的搜索 API，JSON；免费 1000/月）
async function searchViaTavily(query, limit, signal) {
  const { tavilyKey } = readWebConfig()
  if (!tavilyKey) return null

  const merged = createMergedAbortSignal(signal, 12000)
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query,
        max_results: limit,
        search_depth: 'basic',
      }),
      signal: merged?.signal,
    })
    merged?.cleanup()
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? ' (check tavily_api_key)' : ''
      return { ok: false, reason: `http ${res.status}${hint}` }
    }
    const data = await res.json()
    const raw = (data?.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.content }))
    const results = normalizeResults(raw, limit)
    if (results.length === 0) return { ok: false, reason: 'empty results' }
    return { ok: true, results, source: 'tavily' }
  } catch (err) {
    merged?.cleanup()
    if (err.name === 'AbortError') throw err
    return { ok: false, reason: `network: ${err.message || err}` }
  }
}

// web_search 引擎2：SearXNG(自托管，JSON API)
async function searchViaSearXNG(query, limit, signal) {
  const { searxngUrl } = readWebConfig()
  if (!searxngUrl) return null

  if (!/^https?:\/\//i.test(searxngUrl)) {
    return { ok: false, reason: 'SEARXNG_URL must start with http:// or https://' }
  }

  const base = searxngUrl.replace(/\/$/, '').replace(/\/search$/i, '')
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&pageno=1`
  const merged = createMergedAbortSignal(signal, 12000)
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: merged?.signal })
    merged?.cleanup()
    if (!res.ok) return { ok: false, reason: `http ${res.status}` }
    const data = await res.json()
    const raw = (data.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.content }))
    const results = normalizeResults(raw, limit)
    if (results.length === 0) return { ok: false, reason: 'empty results' }
    return { ok: true, results, source: 'searxng' }
  } catch (err) {
    merged?.cleanup()
    if (err.name === 'AbortError') throw err
    return { ok: false, reason: `network: ${err.message || err}` }
  }
}

// web_search 引擎3：Jina Search（s.jina.ai；无 key 时也能试，但现在 Jina 新版 API 要 key）
async function searchViaJina(query, limit, signal) {
  const { jinaKey } = readWebConfig()
  const url = `https://s.jina.ai/${encodeURIComponent(query)}`
  const merged = createMergedAbortSignal(signal, 18000)
  const headers = {
    'Accept': 'text/plain',
    'X-Respond-With': 'no-references',
    'User-Agent': WEB_HEADERS['User-Agent'],
  }
  if (jinaKey) headers['Authorization'] = `Bearer ${jinaKey}`
  try {
    const res = await fetch(url, { headers, signal: merged?.signal })
    merged?.cleanup()
    if (!res.ok) {
      let hint = ''
      if (res.status === 401 || res.status === 403) hint = jinaKey ? ' (check jina_api_key)' : ' (jina now requires api key, set it in 设置 → 上网)'
      else if (res.status === 429) hint = ' (rate-limited)'
      return { ok: false, reason: `http ${res.status}${hint}` }
    }
    const text = (await res.text()).trim()
    if (!text) return { ok: false, reason: 'empty body' }
    // 短到不可能是正常 SERP（Jina 限流时常返 200 + 几十字提示）
    if (text.length < 50) return { ok: false, reason: `short body (${text.length} chars, likely rate-limited)` }

    // Jina Search 返回格式：
    // [1] 标题
    // URL: https://...
    // Description: 摘要...
    //
    // [2] ...
    const raw = []
    const blocks = text.split(/\n(?=\[\d+\])/)
    for (const block of blocks) {
      const titleMatch = block.match(/^\[\d+\]\s*(.+)/)
      const urlMatch = block.match(/^URL:\s*(\S+)/m)
      const descMatch = block.match(/^Description:\s*(.+)/m)
      if (titleMatch && urlMatch) {
        raw.push({ title: titleMatch[1], url: urlMatch[1], snippet: descMatch?.[1] || '' })
      }
    }
    const results = normalizeResults(raw, limit)
    if (results.length === 0) return { ok: false, reason: 'parsed 0 results (format may have changed)' }
    return { ok: true, results, source: 'jina_search' }
  } catch (err) {
    merged?.cleanup()
    if (err.name === 'AbortError') throw err
    return { ok: false, reason: `network: ${err.message || err}` }
  }
}

// web_search 引擎3b：Bing（国内可访问，HTML 解析）
async function searchViaBing(query, limit, signal) {
  const searchUrl = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`
  const merged = createMergedAbortSignal(signal, 15000)
  try {
    const res = await fetch(searchUrl, {
      headers: { ...WEB_HEADERS, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: merged?.signal,
    })
    merged?.cleanup()
    if (!res.ok) return { ok: false, reason: `http ${res.status}` }
    const html = await res.text()
    // Bing 的 <li class="b_algo"> 不闭合 </li>，按下一个 b_algo 切块更稳
    const parts = html.split(/<li class="b_algo"/i).slice(1)
    const raw = []
    for (const part of parts) {
      // 标题在 <h2><a href="...">...内可能嵌 <strong>...</a></h2>
      const headerMatch = part.match(/<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      if (!headerMatch) continue
      const url = unwrapBingUrl(headerMatch[1])
      const title = htmlToText(headerMatch[2])
      if (!title || !url) continue
      // 摘要：优先 b_lineclamp* / b_caption 内的 <p>，兜底取第一个有内容的 <p>
      const snippetMatch =
        part.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
        part.match(/class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ||
        part.match(/<p[^>]*>([\s\S]{30,}?)<\/p>/i)
      const snippet = snippetMatch ? htmlToText(snippetMatch[1]) : ''
      raw.push({ title, url, snippet })
    }
    const results = normalizeResults(raw, limit)
    if (results.length === 0) {
      const blocked = /sorry|captcha|verify|访问被拒绝/i.test(html.slice(0, 4000))
      let reason
      if (blocked) reason = 'blocked or captcha'
      else if (parts.length === 0) reason = 'no b_algo found (layout may have changed)'
      else reason = `found ${parts.length} b_algo blocks but parsed 0 (h2>a structure may have changed)`
      return { ok: false, reason }
    }
    return { ok: true, results, source: 'bing' }
  } catch (err) {
    merged?.cleanup()
    if (err.name === 'AbortError') throw err
    return { ok: false, reason: `network: ${err.message || err}` }
  }
}

// web_search 引擎4：DuckDuckGo HTML（最后兜底，不稳定）
async function searchViaDDG(query, limit, signal) {
  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const merged = createMergedAbortSignal(signal, 15000)
  try {
    const res = await fetch(searchUrl, { headers: WEB_HEADERS, signal: merged?.signal })
    merged?.cleanup()
    if (!res.ok) return { ok: false, reason: `http ${res.status}` }
    const html = await res.text()
    // DDG 返回 403/CAPTCHA 页时 HTML 中不含 result__a
    if (!html.includes('result__a')) return { ok: false, reason: 'blocked or captcha (no result__a)' }
    const results = parseDuckDuckGoResults(html, limit)
    if (results.length === 0) return { ok: false, reason: 'parsed 0 results' }
    return { ok: true, results, source: 'duckduckgo' }
  } catch (err) {
    merged?.cleanup()
    if (err.name === 'AbortError') throw err
    return { ok: false, reason: `network: ${err.message || err}` }
  }
}

function buildSearchPayload(query, result) {
  return {
    ok: true, tool: 'web_search', query,
    source: result.source,
    results: result.results,
    hint: 'Open 1-3 reliable result URLs with web_read, then answer the user.',
  }
}

// 并行跑多个引擎，返回第一个 ok 的结果；全失败则给出 failures 汇总。
// 用于无 key 的爬虫兜底层：避免 bing→jina→ddg 串行把各自超时累加成 ~48s。
async function raceEnginesFirstOk(engines, query, limit, signal, failures) {
  return await new Promise((resolve, reject) => {
    let remaining = engines.length
    let settled = false
    const finish = (result) => { if (!settled) { settled = true; resolve(result) } }
    if (remaining === 0) return finish(null)
    for (const [name, engine] of engines) {
      Promise.resolve()
        .then(() => engine(query, limit, signal))
        .then((result) => {
          if (settled) return
          if (result && result.ok) return finish(result)
          if (result) {
            failures.push({ engine: name, reason: result.reason || 'unknown' })
            console.log(`[web_search] ${name} failed: ${result.reason || 'unknown'}`)
          }
          // result == null → 未配置，跳过
        })
        .catch((err) => {
          if (err && err.name === 'AbortError') { if (!settled) { settled = true; reject(err) } ; return }
          failures.push({ engine: name, reason: `threw: ${err?.message || err}` })
          console.log(`[web_search] ${name} threw: ${err?.message || err}`)
        })
        .finally(() => {
          if (settled) return
          remaining--
          if (remaining === 0) finish(null)
        })
    }
  })
}

export async function execWebSearch(args, context = {}) {
  throwIfAborted(context.signal)
  const query = String(args.query || args.q || args.keyword || '').trim()
  const limit = Math.max(1, Math.min(Number(args.limit) || 5, 8))
  if (!query) return webJson({ ok: false, tool: 'web_search', error: 'missing query' })

  const cacheKey = `${query}::${limit}`
  const cached = searchCacheGet(cacheKey)
  if (cached) return webJson({ ...cached, cached: true })

  console.log(`[web_search] ${truncateForLog(query)}`)

  const failures = []

  // 第一梯队：带 key 的可靠 JSON API，按优先级【串行】尝试。
  // 未配置的引擎瞬间返回 null（不发网络请求），所以串行不会拖慢——
  // 通常只有 serper 配了，~1.5s 就出结果。
  const tier1 = [
    ['serper', searchViaSerper],
    ['brave',  searchViaBrave],
    ['tavily', searchViaTavily],
    ['searxng', searchViaSearXNG],
  ]
  for (const [name, engine] of tier1) {
    throwIfAborted(context.signal)
    let result
    try {
      result = await engine(query, limit, context.signal)
    } catch (err) {
      if (err.name === 'AbortError') throw err
      failures.push({ engine: name, reason: `threw: ${err.message || err}` })
      console.log(`[web_search] ${name} threw: ${err.message || err}`)
      continue
    }
    if (result == null) continue  // 未配置
    if (result.ok) {
      const payload = buildSearchPayload(query, result)
      searchCacheSet(cacheKey, payload)
      return webJson(payload)
    }
    failures.push({ engine: name, reason: result.reason || 'unknown' })
    console.log(`[web_search] ${name} failed: ${result.reason || 'unknown'}`)
  }

  // 第二梯队：无 key 的爬虫兜底，【并行】抢答。最坏耗时压成单引擎超时（~18s）而非串行累加。
  throwIfAborted(context.signal)
  const tier2 = [
    ['bing', searchViaBing],
    ['jina', searchViaJina],
    ['ddg',  searchViaDDG],
  ]
  const raced = await raceEnginesFirstOk(tier2, query, limit, context.signal, failures)
  if (raced && raced.ok) {
    const payload = buildSearchPayload(query, raced)
    searchCacheSet(cacheKey, payload)
    return webJson(payload)
  }

  const summary = failures.length
    ? failures.map(f => `${f.engine}: ${f.reason}`).join('; ')
    : 'no engine configured'
  return webJson({
    ok: false, tool: 'web_search', query,
    error: `all search engines failed (${summary})`,
    failures,
    hint: 'All search engines failed. Try web_read with a known URL, or configure SERPER_API_KEY / BRAVE_API_KEY for reliable search.',
  })
}
