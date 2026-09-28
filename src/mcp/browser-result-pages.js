import crypto from 'node:crypto'

const documents = new Map()
const TTL_MS = 5 * 60_000
const MAX_DOCUMENT_CHARS = 4_000_000
const MAX_CACHED_CHARS = 8_000_000
const PAGE_CHARS = 10_000

function owner(context) {
  return String(context.currentTargetId || context.browserLeaseOwnerId || 'local')
}

function prune() {
  for (const [id, entry] of documents) {
    if (Date.now() - entry.createdAt > TTL_MS) documents.delete(id)
  }
}

function page(entry, id, offset) {
  let end = Math.min(offset + PAGE_CHARS, entry.text.length)
  // Do not split a Unicode surrogate pair across pages.
  if (end < entry.text.length && /[\uD800-\uDBFF]/.test(entry.text[end - 1])) end -= 1
  const text = entry.text.slice(offset, end)
  return {
    ok: entry.ok, source: 'mcp', tool: 'browser_snapshot', remote_tool: 'browser_snapshot',
    content: [{ type: 'text', text }],
    truncated: end < entry.text.length,
    pagination: { offset, returned_chars: text.length, total_chars: entry.text.length,
      has_more: end < entry.text.length,
      next_cursor: end < entry.text.length ? `${id}:${end}` : null,
      captured_at: new Date(entry.createdAt).toISOString() },
    note: 'This is a saved browser result, not a new live snapshot. Read remaining content with browser_snapshot({cursor: pagination.next_cursor}). Do not infer missing page content from this partial result. Refresh the live snapshot before using element uids for actions.',
  }
}

export function paginateBrowserResult(payload, rawContent, context = {}) {
  const text = rawContent.filter(item => item?.type === 'text').map(item => String(item.text || '')).join('\n\n')
  if (text.length > MAX_DOCUMENT_CHARS) {
    return { ok: false, tool: payload.tool, code: 'BROWSER_RESULT_TOO_LARGE',
      error: 'Browser result exceeds the saved-result limit; narrow the query or read a more specific page.', total_chars: text.length }
  }
  prune()
  let size = [...documents.values()].reduce((sum, entry) => sum + entry.text.length, 0)
  while (documents.size && (size + text.length > MAX_CACHED_CHARS || documents.size >= 8)) {
    const id = documents.keys().next().value
    size -= documents.get(id).text.length
    documents.delete(id)
  }
  const id = crypto.randomBytes(16).toString('hex')
  const entry = { text, owner: owner(context), createdAt: Date.now(), ok: payload.ok !== false }
  documents.set(id, entry)
  const result = { ...page(entry, id, 0), tool: payload.tool, remote_tool: payload.remote_tool,
    server_id: payload.server_id, server_name: payload.server_name, ok: payload.ok }
  for (const key of ['structured_content', 'browser_preview', 'screenshot', 'error']) {
    if (payload[key] !== undefined && JSON.stringify(payload[key]).length <= 6000) result[key] = payload[key]
  }
  return result
}

export function readBrowserResultPage(cursor, context = {}) {
  prune()
  const match = String(cursor).match(/^([a-f0-9]{32}):(\d+)$/)
  const entry = match && documents.get(match[1])
  const offset = match && Number(match[2])
  if (!entry || entry.owner !== owner(context) || !Number.isSafeInteger(offset) || offset < 0 || offset >= entry.text.length) {
    return { ok: false, tool: 'browser_snapshot', code: 'BROWSER_CURSOR_EXPIRED',
      error: 'Saved page cursor is invalid, expired or belongs to another caller. Take a fresh browser_snapshot without cursor.' }
  }
  return page(entry, match[1], offset)
}
