// web 工具共享底层：HTTP 头、URL/HTML 处理、长文落盘
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { SANDBOX_ROOT } from '../../sandbox.js'

export const WEB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

export function webJson(payload) {
  return JSON.stringify(payload)
}

export function normalizeWebUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  return `https://${value}`
}

export function decodeHtmlEntities(value = '') {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

export function htmlToText(html = '') {
  return decodeHtmlEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function extractTitle(html = '') {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match ? htmlToText(match[1]).slice(0, 200) : ''
}

export function isLowValuePageText(text = '') {
  const compact = String(text || '').replace(/\s+/g, ' ').trim()
  if (compact.length < 80) return true
  return /^(please wait|just a moment|checking your browser|enable javascript|access denied|forbidden|captcha|安全验证|请稍候|请稍等|正在验证|访问受限)/i.test(compact)
}

// 长文阈值：抓取结果超过此长度时落盘，识别器只看摘要 + body_path
export const ARTICLE_LENGTH_THRESHOLD = 2000
export const ARTICLE_SUMMARY_EXCERPT = 800

function urlHash8(url) {
  return crypto.createHash('sha1').update(String(url || '')).digest('hex').slice(0, 8)
}

function sanitizeSlugPart(value, max = 40) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
}

// 把长文写入 sandbox/articles/{YYYY-MM}/{date}_{titleSlug}_{hash8}.md
// 同 URL 当天再次抓取直接复用已有文件，避免重复落盘
export function saveLongArticle({ url, finalUrl, title, body, source }) {
  const now = new Date()
  const yyyyMm = now.toISOString().slice(0, 7)
  const date = now.toISOString().slice(0, 10)
  const hash = urlHash8(finalUrl || url || '')
  const titleSlug = sanitizeSlugPart(title)
  const baseName = titleSlug ? `${date}_${titleSlug}_${hash}.md` : `${date}_${hash}.md`

  const monthDir = path.join(SANDBOX_ROOT, 'articles', yyyyMm)
  const absPath = path.join(monthDir, baseName)
  const relPath = path.posix.join('articles', yyyyMm, baseName)

  if (fs.existsSync(absPath)) {
    return { path: relPath, bytes: fs.statSync(absPath).size, reused: true }
  }

  fs.mkdirSync(monthDir, { recursive: true })
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title || '')}`,
    `source_url: ${url || ''}`,
    finalUrl && finalUrl !== url ? `final_url: ${finalUrl}` : null,
    `source_tool: ${source || 'web_read'}`,
    `fetched_at: ${now.toISOString()}`,
    '---',
    '',
  ].filter(Boolean).join('\n')
  const content = frontmatter + (title ? `# ${title}\n\n` : '') + body
  fs.writeFileSync(absPath, content, 'utf-8')
  return { path: relPath, bytes: Buffer.byteLength(content, 'utf-8'), reused: false }
}
