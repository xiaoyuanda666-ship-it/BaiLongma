// Internal one-shot Playwright reader. This is retained as an executor
// compatibility path for historical browser_read calls, but is no longer
// exposed as a model tool. It shares BrowserSessionManager with browser_*.
import { throwIfAborted } from '../../abort-utils.js'
import { getBrowserSessionManager } from '../browser-tools.js'
import {
  webJson, normalizeWebUrl, isLowValuePageText,
  saveLongArticle, ARTICLE_LENGTH_THRESHOLD, ARTICLE_SUMMARY_EXCERPT,
} from './util.js'

export async function execBrowserRead(args, context = {}) {
  throwIfAborted(context.signal)
  const url = normalizeWebUrl(args.url || args.URL || args.link || args.href || args.uri)
  if (!url) return webJson({ ok: false, tool: 'browser_read', error: 'missing url' })

  const timeoutMs = Math.max(5_000, Math.min(Number(args.timeout_ms || args.timeout || 20_000), 45_000))
  const maxChars = Math.max(1_000, Math.min(Number(args.max_chars || args.maxChars || 8_000), 20_000))
  console.log(`[browser_read] -> ${url}`)

  try {
    const rendered = await getBrowserSessionManager().readOnce({
      url,
      timeout_ms: timeoutMs,
      extract_max_chars: 500_000,
    }, context)
    const text = String(rendered?.text || '').trim()
    if (!rendered?.ok || isLowValuePageText(text)) {
      return webJson({
        ok: false,
        tool: 'browser_read',
        url,
        final_url: rendered?.final_url,
        title: rendered?.title || '',
        error: 'no readable content rendered',
        content_preview: text.slice(0, 300),
        content_length: text.length,
        hint: 'The browser rendered the page but found no readable article text. The page may require login, CAPTCHA, or another source.',
      })
    }

    const isLong = text.length >= ARTICLE_LENGTH_THRESHOLD
    let bodyPath = null
    let bodyBytes = null
    if (isLong) {
      try {
        const saved = saveLongArticle({
          url,
          finalUrl: rendered.final_url,
          title: rendered.title,
          body: text,
          source: 'playwright',
        })
        bodyPath = saved.path
        bodyBytes = saved.bytes
      } catch (err) {
        console.warn(`[browser_read] failed to save long article: ${err.message}`)
      }
    }
    const content = isLong
      ? `${text.slice(0, ARTICLE_SUMMARY_EXCERPT)}\n\n...`
      : (text.length > maxChars ? `${text.slice(0, maxChars)}\n\n...` : text)
    return webJson({
      ok: true,
      tool: 'browser_read',
      url,
      final_url: rendered.final_url,
      title: rendered.title,
      content,
      truncated: isLong || text.length > maxChars || rendered.truncated === true,
      content_length: rendered.text_length || text.length,
      body_path: bodyPath,
      body_bytes: bodyBytes,
      hint: bodyPath
        ? `Long article saved. Full text at sandbox path: ${bodyPath}. Use read_file to open it.`
        : 'Rendered page content extracted by local Playwright.',
    })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return webJson({
      ok: false,
      tool: 'browser_read',
      url,
      code: err.code,
      error: err.message || String(err),
      hint: 'Local browser rendering failed. Try another accessible source.',
    })
  }
}
