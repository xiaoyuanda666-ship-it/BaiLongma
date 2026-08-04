// Knowledge-source normalization and identity helpers.
//
// These functions deliberately have no filesystem, database, or network access.
// A storage adapter can therefore use them before deciding whether a source changed.

import { createHash } from 'node:crypto'

const HTML_ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

function decodeHtmlEntities(value = '') {
  return String(value).replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase()
    if (lower[0] === '#') {
      const radix = lower.startsWith('#x') ? 16 : 10
      const codePoint = Number.parseInt(lower.slice(radix === 16 ? 2 : 1), radix)
      if (Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        try { return String.fromCodePoint(codePoint) } catch {}
      }
      return match
    }
    return HTML_ENTITY_MAP[lower] ?? match
  })
}

/**
 * Normalize plain text while retaining line boundaries that carry document structure.
 */
export function normalizePlainText(input = '') {
  return String(input)
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .split('\n')
    .map(line => line.replace(/[\t \f\v]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Dependency-free, intentionally conservative HTML-to-text conversion.  It preserves
 * headings and table rows so the chunker can attach useful locators and context.
 */
export function normalizeHtml(input = '') {
  let html = String(input)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')

  html = html
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n${'#'.repeat(Number(level))} `)
    .replace(/<\/h[1-6]\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li\s*>/gi, '')
    .replace(/<tr\b[^>]*>/gi, '\n')
    .replace(/<t[hd]\b[^>]*>/gi, ' | ')
    .replace(/<\/t[hd]\s*>/gi, '')
    .replace(/<\/(?:p|div|section|article|main|header|footer|aside|blockquote|pre|ul|ol|table|figure|figcaption)\s*>/gi, '\n')
    .replace(/<(?:p|div|section|article|main|header|footer|aside|blockquote|pre|ul|ol|table|figure|figcaption)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')

  return normalizePlainText(decodeHtmlEntities(html))
}

function parseCsvRows(input = '') {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const value = String(input).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (quoted) {
      if (char === '"' && value[i + 1] === '"') { field += '"'; i += 1 } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') { row.push(field); field = '' }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else field += char
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

/**
 * Make CSV searchable without losing its header-to-value relationship.
 * Each non-empty record is one line beginning with "Row N:".
 */
export function normalizeCsv(input = '') {
  const rows = parseCsvRows(input)
    .map(row => row.map(cell => normalizePlainText(cell).replace(/\n+/g, ' ')))
    .filter(row => row.some(Boolean))
  if (!rows.length) return ''
  const headers = rows[0].map((header, index) => header || `column_${index + 1}`)
  return rows.slice(1).map((row, index) => {
    const fields = row.map((cell, column) => `${headers[column] || `column_${column + 1}`}: ${cell}`)
    return `Row ${index + 2}: ${fields.join(' | ')}`
  }).join('\n')
}

/** Normalize supported textual formats into a common structural text representation. */
export function normalizeKnowledgeText(input = '', mimeType = 'text/plain') {
  const mime = String(mimeType || 'text/plain').toLowerCase().split(';')[0].trim()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return normalizeHtml(input)
  if (mime === 'text/csv' || mime === 'application/csv') return normalizeCsv(input)
  // Markdown headings and lists are already useful structural syntax. Keep them.
  return normalizePlainText(input)
}

/** A SHA-256 digest for normalized content; safe to store and compare. */
export function hashContent(content = '') {
  return createHash('sha256').update(String(content), 'utf8').digest('hex')
}

/**
 * Remove URL credentials, query strings, and fragments before a source is hashed or
 * displayed in an audit key. Queries often contain short-lived signed credentials.
 */
export function canonicalizeSourceUri(sourceUri = '') {
  const raw = String(sourceUri || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) throw new Error('not a source URL')
    if (parsed.protocol === 'file:') return `file://${decodeURIComponent(parsed.pathname).replace(/\\/g, '/')}`
    return `${parsed.protocol}//${parsed.host}${decodeURIComponent(parsed.pathname)}`
  } catch {
    return raw.replace(/[?#][\s\S]*$/, '').replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  }
}

/** A SHA-256 digest of the sanitized, stable source identity. */
export function hashSource(sourceUri = '') {
  return hashContent(canonicalizeSourceUri(sourceUri))
}
