// Structure-aware text chunking for the knowledge store.  The returned shape maps
// directly to the planned knowledge_chunks columns: ordinal, text, context,
// locator_json, and token_count.

import { normalizeKnowledgeText } from './text.js'

const DEFAULT_MAX_CHARS = 1800
const DEFAULT_OVERLAP_CHARS = 180

export function estimateTokenCount(value = '') {
  // A conservative cross-language estimate; the embedding/generation provider remains
  // the authority for exact token counts.
  const text = String(value).trim()
  if (!text) return 0
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length
  const remaining = Math.max(0, text.length - cjk)
  return Math.ceil(cjk * 1.35 + remaining / 4)
}

function headingFor(line) {
  const match = String(line).match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
  return match ? { level: match[1].length, title: match[2].trim() } : null
}

function splitOversizedText(text, maxChars) {
  const sentences = String(text).match(/[^。！？.!?]+[。！？.!?]?|\S+/g) || []
  const pieces = []
  let current = ''
  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > maxChars) {
      pieces.push(current.trim())
      current = ''
    }
    if (sentence.length > maxChars) {
      if (current) { pieces.push(current.trim()); current = '' }
      for (let offset = 0; offset < sentence.length; offset += maxChars) pieces.push(sentence.slice(offset, offset + maxChars))
    } else current += `${current ? ' ' : ''}${sentence}`
  }
  if (current.trim()) pieces.push(current.trim())
  return pieces
}

function makeSections(normalizedText) {
  const sections = []
  const headingPath = []
  let current = { headingPath: [], startLine: 1, lines: [] }
  const pushCurrent = (endLine) => {
    const text = current.lines.join('\n').trim()
    if (text) sections.push({ ...current, text, endLine })
  }
  const lines = normalizedText.split('\n')
  lines.forEach((line, index) => {
    const heading = headingFor(line)
    if (heading) {
      pushCurrent(index)
      headingPath.splice(heading.level - 1)
      headingPath[heading.level - 1] = heading.title
      current = { headingPath: headingPath.filter(Boolean), startLine: index + 1, lines: [line] }
    } else current.lines.push(line)
  })
  pushCurrent(lines.length)
  return sections
}

/**
 * Chunk text without detaching it from its section.  `locator` is JSON-safe and may be
 * stored as locator_json directly. CSV lines receive a row locator when possible.
 */
export function chunkText(input = '', {
  mimeType = 'text/plain',
  sourceUri = '',
  title = '',
  maxChars = DEFAULT_MAX_CHARS,
  overlapChars = DEFAULT_OVERLAP_CHARS,
} = {}) {
  const normalized = normalizeKnowledgeText(input, mimeType)
  if (!normalized) return []
  const safeMaxChars = Math.max(200, Number(maxChars) || DEFAULT_MAX_CHARS)
  const safeOverlap = Math.max(0, Math.min(Number(overlapChars) || 0, Math.floor(safeMaxChars / 3)))
  const sections = makeSections(normalized)
  const chunks = []
  let ordinal = 0

  for (const section of sections) {
    const paragraphs = section.text.split(/\n{2,}/).map(value => value.trim()).filter(Boolean)
    let buffer = ''
    let chunkStartLine = section.startLine
    const emit = (value, endLine) => {
      const text = value.trim()
      if (!text) return
      const contextParts = []
      if (title) contextParts.push(`Document: ${String(title).trim()}`)
      if (section.headingPath.length) contextParts.push(`Section: ${section.headingPath.join(' > ')}`)
      const rowMatch = text.match(/^Row\s+(\d+):/m)
      const locator = {
        type: String(mimeType || 'text/plain').split(';')[0],
        source_uri: sourceUri || undefined,
        heading_path: section.headingPath,
        start_line: chunkStartLine,
        end_line: endLine,
      }
      if (rowMatch) locator.row = Number(rowMatch[1])
      Object.keys(locator).forEach(key => locator[key] === undefined && delete locator[key])
      chunks.push({ ordinal: ordinal++, text, context: contextParts.join('\n'), locator, tokenCount: estimateTokenCount(`${contextParts.join(' ')} ${text}`) })
    }

    for (const paragraph of paragraphs) {
      const parts = paragraph.length > safeMaxChars ? splitOversizedText(paragraph, safeMaxChars) : [paragraph]
      for (const part of parts) {
        if (buffer && buffer.length + part.length + 2 > safeMaxChars) {
          const endLine = chunkStartLine + buffer.split('\n').length - 1
          emit(buffer, endLine)
          const overlap = safeOverlap ? buffer.slice(-safeOverlap).trim() : ''
          buffer = overlap ? `${overlap}\n\n${part}` : part
          chunkStartLine = Math.max(section.startLine, endLine - (overlap ? overlap.split('\n').length - 1 : 0))
        } else buffer += `${buffer ? '\n\n' : ''}${part}`
      }
    }
    if (buffer) emit(buffer, section.endLine)
  }
  return chunks
}
