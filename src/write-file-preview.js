import { getTerminalStreamSnapshot, recordTerminalStreamEvent } from './terminal-stream.js'

const STREAM_ID = 'write_file'
const DEFAULT_TITLE = 'Writing file'
const CONTENT_KEYS = [
  'content',
  'contents',
  'text',
  'body',
  'data',
  'markdown',
  'article',
  'html',
  'code',
  'source',
  'file_content',
  'text_content',
]
const PATH_KEYS = [
  'path',
  'filename',
  'file_name',
  'file_path',
  'filepath',
  'file',
  'output_path',
  'output',
  'target_path',
  'destination',
  'dest',
]
const RECENT_TTL_MS = 5 * 60 * 1000
const REPLAY_CHUNK_SIZE = 1200
const AUTO_CLOSE_DELAY_MS = 1600
const NON_FILE_WRITE_TOOLS = new Set([
  'send_message',
  'express',
  'terminal_stream',
  'upsert_memory',
  'merge_memories',
  'set_task',
  'update_task_step',
  'complete_task',
  'manage_reminder',
  'manage_prefetch_task',
  'install_tool',
  'manage_tool_factory',
  'exec_command',
  'exec_quick_command',
  'exec_task_command',
  'exec_background_command',
  'download_file',
])
const FILE_WRITE_NAME_RE = /(^|_)(write|save|create|append|edit|update|generate|export)(_|$)|(^|_)(file|document|doc|article|markdown|md|html|code|script|page|note|text)(_|$)/i
const FILE_OBJECT_NAME_RE = /(^|_)(file|document|doc|article|markdown|md|html|code|script|page|note|text)(_|$)/i
const MARKDOWN_PATH_RE = /\.(md|markdown|mdown|mkd|mdx)$/i
const ARTICLE_TOOL_RE = /(^|_)(article|essay|report|document|doc|markdown|md|note|text)(_|$)/i
const ARTICLE_BASENAME_RE = /(^|[_. -])(article|essay|report|document|doc|markdown|md|note|notes|plan|story|post|draft)([_. -]|$)/i
const CODE_PATH_RE = /\.(js|mjs|cjs|ts|tsx|jsx|py|java|c|cc|cpp|h|hpp|cs|go|rs|rb|php|swift|kt|kts|html|css|scss|sass|json|yaml|yml|toml|xml|sql|sh|bash|ps1|bat|cmd|vue|svelte)$/i

const recentPreviews = new Map()
const autoCloseTimers = new Map()

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cleanTitle(pathValue = '') {
  const path = String(pathValue || '').trim()
  return path ? `Writing ${path.slice(0, 96)}` : DEFAULT_TITLE
}

function cleanToolName(name = '') {
  return String(name || '').trim() || 'write_file'
}

function baseNameLike(pathValue = '') {
  return String(pathValue || '').split(/[\\/]/).pop() || ''
}

function emitTerminalEvent({
  action = 'write',
  stream_id = STREAM_ID,
  title = DEFAULT_TITLE,
  text = '',
  newline = true,
  level = 'info',
  format = '',
  artifact_kind = '',
  artifact_path = '',
  hold_open,
} = {}) {
  const bridge = globalThis?.terminalStreamBridge
  const normalizedAction = String(action || 'write').trim().toLowerCase()
  if (normalizedAction === 'clear' || normalizedAction === 'open') cancelAutoClose(stream_id)
  if (bridge && ['open', 'write', 'clear'].includes(normalizedAction)) {
    bridge.emit('open', { title, stream_id, placement: 'auto', focus: false, source: 'write_file_preview' })
  } else if (bridge && normalizedAction === 'close') {
    bridge.emit('close', { stream_id })
  }
  return recordTerminalStreamEvent({
    action: normalizedAction,
    stream_id,
    title,
    text,
    newline,
    level,
    format,
    artifact_kind,
    artifact_path,
    hold_open,
  })
}

function autoCloseDelayMs() {
  const override = Number(globalThis?.__JARVIS_WRITE_PREVIEW_AUTO_CLOSE_MS)
  return Number.isFinite(override) && override >= 0 ? override : AUTO_CLOSE_DELAY_MS
}

function cancelAutoClose(streamId = STREAM_ID) {
  const timer = autoCloseTimers.get(streamId)
  if (!timer) return
  clearTimeout(timer)
  autoCloseTimers.delete(streamId)
}

function scheduleAutoCloseWriteFilePreview({ title = DEFAULT_TITLE, artifact = {} } = {}) {
  if (artifact.hold_open) return false
  const streamId = STREAM_ID
  const expectedPath = previewKey(artifact.artifact_path)
  cancelAutoClose(streamId)

  const timer = setTimeout(() => {
    autoCloseTimers.delete(streamId)
    const snapshot = getTerminalStreamSnapshot(streamId)
    if (snapshot.closed || snapshot.hold_open) return
    if (expectedPath && previewKey(snapshot.artifact_path) !== expectedPath) return

    try {
      globalThis?.terminalStreamBridge?.emit?.('close', {
        stream_id: streamId,
        source: 'write_file_auto_close',
        artifact_path: snapshot.artifact_path,
      })
    } catch {}
    recordTerminalStreamEvent({ action: 'close', stream_id: streamId, title, force: true })
  }, autoCloseDelayMs())
  if (typeof timer.unref === 'function') timer.unref()
  autoCloseTimers.set(streamId, timer)
  return true
}

function inferWriteFileArtifact({ path = '', toolName = '' } = {}) {
  const cleanPath = String(path || '').trim()
  const cleanBaseName = baseNameLike(cleanPath)
  const cleanName = cleanToolName(toolName)
  const code = CODE_PATH_RE.test(cleanPath) && !MARKDOWN_PATH_RE.test(cleanPath)
  const markdown = MARKDOWN_PATH_RE.test(cleanPath)
    || (!code && (ARTICLE_TOOL_RE.test(cleanName) || ARTICLE_BASENAME_RE.test(cleanBaseName)))
  if (markdown) {
    return {
      format: 'markdown',
      artifact_kind: 'article',
      artifact_path: cleanPath,
      hold_open: true,
    }
  }
  if (code) {
    return {
      format: 'code',
      artifact_kind: 'code',
      artifact_path: cleanPath,
      hold_open: false,
    }
  }
  return {
    format: 'plain',
    artifact_kind: cleanPath ? 'file' : '',
    artifact_path: cleanPath,
    hold_open: false,
  }
}

function previewKey(pathValue = '') {
  return String(pathValue || '').trim().toLowerCase()
}

function markRecentPreview(pathValue, visibleLength) {
  const key = previewKey(pathValue)
  if (!key) return
  recentPreviews.set(key, {
    visibleLength: Math.max(0, Number(visibleLength) || 0),
    ts: Date.now(),
  })
}

function getRecentPreview(pathValue) {
  const key = previewKey(pathValue)
  if (!key) return null
  const preview = recentPreviews.get(key)
  if (!preview) return null
  if (Date.now() - preview.ts > RECENT_TTL_MS) {
    recentPreviews.delete(key)
    return null
  }
  return preview
}

function findStringValueStart(source, key) {
  const re = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"`, 'g')
  const match = re.exec(source)
  return match ? match.index + match[0].length : -1
}

function decodeJsonStringPrefix(source, start) {
  let value = ''
  let i = start

  while (i < source.length) {
    const ch = source[i]
    if (ch === '"') {
      return { value, closed: true, end: i + 1 }
    }
    if (ch !== '\\') {
      value += ch
      i += 1
      continue
    }

    if (i + 1 >= source.length) return { value, closed: false, end: i }
    const escaped = source[i + 1]
    switch (escaped) {
      case '"':
        value += '"'
        i += 2
        break
      case '\\':
        value += '\\'
        i += 2
        break
      case '/':
        value += '/'
        i += 2
        break
      case 'b':
        value += '\b'
        i += 2
        break
      case 'f':
        value += '\f'
        i += 2
        break
      case 'n':
        value += '\n'
        i += 2
        break
      case 'r':
        value += '\r'
        i += 2
        break
      case 't':
        value += '\t'
        i += 2
        break
      case 'u': {
        if (i + 6 > source.length) return { value, closed: false, end: i }
        const hex = source.slice(i + 2, i + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          value += escaped
          i += 2
          break
        }
        const code = parseInt(hex, 16)
        if (code >= 0xd800 && code <= 0xdbff) {
          if (i + 12 > source.length) return { value, closed: false, end: i }
          const lowPrefix = source.slice(i + 6, i + 8)
          const lowHex = source.slice(i + 8, i + 12)
          if (lowPrefix === '\\u' && /^[0-9a-fA-F]{4}$/.test(lowHex)) {
            const low = parseInt(lowHex, 16)
            if (low >= 0xdc00 && low <= 0xdfff) {
              value += String.fromCharCode(code, low)
              i += 12
              break
            }
          }
        }
        value += String.fromCharCode(code)
        i += 6
        break
      }
      default:
        value += escaped
        i += 2
        break
    }
  }

  return { value, closed: false, end: i }
}

function decodeXmlEntitiesPrefix(value = '') {
  let text = String(value || '')
  const incomplete = text.match(/&(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]*|#x[0-9a-fA-F]*)?$/)
  if (incomplete && !text.endsWith(';')) text = text.slice(0, incomplete.index)
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export function extractPartialJsonStringValue(source, keys = []) {
  const body = String(source || '')
  for (const key of keys) {
    const start = findStringValueStart(body, key)
    if (start >= 0) return decodeJsonStringPrefix(body, start)
  }
  return null
}

export function extractPartialXmlParameterValue(source, keys = []) {
  const body = String(source || '')
  for (const key of keys) {
    const re = new RegExp(`<parameter\\s+name=["']${escapeRegExp(key)}["']\\s*>`, 'ig')
    let match
    let last = null
    while ((match = re.exec(body)) !== null) last = match
    if (!last) continue
    const start = last.index + last[0].length
    const rest = body.slice(start)
    const close = rest.search(/<\/parameter>/i)
    const raw = close >= 0 ? rest.slice(0, close) : rest
    return {
      value: decodeXmlEntitiesPrefix(raw),
      closed: close >= 0,
      end: close >= 0 ? start + close + '</parameter>'.length : body.length,
    }
  }
  return null
}

function extractPartialXmlInvoke(source = '') {
  const body = String(source || '')
  const re = /<invoke\s+name=["']([^"']+)["'][^>]*>/ig
  let match
  let last = null
  while ((match = re.exec(body)) !== null) last = match
  if (!last) return null
  return {
    name: last[1],
    start: last.index,
    body: body.slice(last.index + last[0].length),
  }
}

export function isWriteFileToolName(name = '') {
  return String(name || '').trim() === 'write_file'
}

function isGenericFileWriteToolName(name = '') {
  const toolName = cleanToolName(name)
  if (NON_FILE_WRITE_TOOLS.has(toolName)) return false
  return FILE_WRITE_NAME_RE.test(toolName)
}

function firstStringValue(args = {}, keys = []) {
  if (!args || typeof args !== 'object') return ''
  for (const key of keys) {
    const value = args[key]
    if (value !== undefined && value !== null && value !== '') return String(value)
  }
  return ''
}

function shouldPreviewPartialToolCall(toolName, argsText, pathInfo, contentInfo) {
  if (isWriteFileToolName(toolName)) return true
  if (!isGenericFileWriteToolName(toolName)) return false
  if (!contentInfo) return false
  return !!pathInfo || FILE_OBJECT_NAME_RE.test(cleanToolName(toolName))
}

export function extractFileWriteArgs(toolName = '', args = {}) {
  const cleanName = cleanToolName(toolName)
  const path = firstStringValue(args, PATH_KEYS)
  const content = firstStringValue(args, CONTENT_KEYS)
  if (!content) return null
  if (isWriteFileToolName(cleanName)) return { toolName: cleanName, path, content }
  if (!isGenericFileWriteToolName(cleanName)) return null
  if (!path && !FILE_OBJECT_NAME_RE.test(cleanName)) return null
  return { toolName: cleanName, path, content }
}

export function streamWriteFileArgumentPreview(toolCall = {}, state = {}) {
  const toolName = cleanToolName(toolCall.name)
  const args = String(toolCall.arguments || '')
  const pathInfo = extractPartialJsonStringValue(args, PATH_KEYS)
  if (pathInfo?.value) state.path = pathInfo.value
  const contentInfo = extractPartialJsonStringValue(args, CONTENT_KEYS)
  if (!shouldPreviewPartialToolCall(toolName, args, pathInfo, contentInfo)) return state

  state.toolName = toolName
  const title = cleanTitle(state.path)
  const artifact = inferWriteFileArtifact({ path: state.path, toolName })

  if (!state.opened) {
    if (state.session && state.session.cleared) {
      emitTerminalEvent({ action: 'open', title, ...artifact })
    } else {
      emitTerminalEvent({ action: 'clear', title, ...artifact })
      if (state.session) state.session.cleared = true
    }
    state.opened = true
  }

  if (!contentInfo) return state

  if (!state.headerWritten) {
    emitTerminalEvent({
      action: 'write',
      title,
      text: `$ ${toolName} ${state.path || '(pending path)'}\n\n`,
      newline: false,
      level: 'muted',
      ...artifact,
    })
    state.headerWritten = true
  }

  const visible = contentInfo.value || ''
  if (state.visibleLength > visible.length) state.visibleLength = 0
  const delta = visible.slice(state.visibleLength || 0)
  if (delta) {
    emitTerminalEvent({ action: 'write', title, text: delta, newline: false, ...artifact })
    state.visibleLength = visible.length
    if (state.path) markRecentPreview(state.path, state.visibleLength)
  }

  if (contentInfo.closed) state.contentClosed = true
  return state
}

export function streamXmlFileWriteArgumentPreview(source = '', state = {}) {
  const invoke = extractPartialXmlInvoke(source)
  if (!invoke) return state
  if (state.invokeStart !== undefined && state.invokeStart !== invoke.start) {
    state.opened = false
    state.headerWritten = false
    state.visibleLength = 0
    state.path = ''
    state.contentClosed = false
  }
  state.invokeStart = invoke.start

  const toolName = cleanToolName(invoke.name)
  const pathInfo = extractPartialXmlParameterValue(invoke.body, PATH_KEYS)
  if (pathInfo?.value) state.path = pathInfo.value
  const contentInfo = extractPartialXmlParameterValue(invoke.body, CONTENT_KEYS)
  if (!shouldPreviewPartialToolCall(toolName, invoke.body, pathInfo, contentInfo)) return state

  state.toolName = toolName
  const title = cleanTitle(state.path)
  const artifact = inferWriteFileArtifact({ path: state.path, toolName })

  if (!state.opened) {
    if (state.session && state.session.cleared) {
      emitTerminalEvent({ action: 'open', title, ...artifact })
    } else {
      emitTerminalEvent({ action: 'clear', title, ...artifact })
      if (state.session) state.session.cleared = true
    }
    state.opened = true
  }

  if (!contentInfo) return state

  if (!state.headerWritten) {
    emitTerminalEvent({
      action: 'write',
      title,
      text: `$ ${toolName} ${state.path || '(pending path)'}\n\n`,
      newline: false,
      level: 'muted',
      ...artifact,
    })
    state.headerWritten = true
  }

  const visible = contentInfo.value || ''
  if (state.visibleLength > visible.length) state.visibleLength = 0
  const delta = visible.slice(state.visibleLength || 0)
  if (delta) {
    emitTerminalEvent({ action: 'write', title, text: delta, newline: false, ...artifact })
    state.visibleLength = visible.length
    if (state.path) markRecentPreview(state.path, state.visibleLength)
  }

  if (contentInfo.closed) state.contentClosed = true
  return state
}

export function streamWriteFileExecutionPreview({ toolName = 'write_file', path = '', content = '', bytes = null, verified = null } = {}) {
  const cleanName = cleanToolName(toolName)
  const body = String(content ?? '')
  const title = cleanTitle(path)
  const artifact = inferWriteFileArtifact({ path, toolName: cleanName })
  const recent = getRecentPreview(path)
  const alreadyStreamed = recent && recent.visibleLength >= Math.min(body.length, 1)

  if (!alreadyStreamed) {
    emitTerminalEvent({ action: 'clear', title, ...artifact })
    emitTerminalEvent({
      action: 'write',
      title,
      text: `$ ${cleanName} ${path || '(unknown path)'}\n\n`,
      newline: false,
      level: 'muted',
      ...artifact,
    })
    for (let i = 0; i < body.length; i += REPLAY_CHUNK_SIZE) {
      emitTerminalEvent({
        action: 'write',
        title,
        text: body.slice(i, i + REPLAY_CHUNK_SIZE),
        newline: false,
        ...artifact,
      })
    }
    if (path) markRecentPreview(path, body.length)
  }

  if (verified !== null && verified !== undefined) {
    const status = verified === false ? 'failed' : 'done'
    const byteText = bytes === null || bytes === undefined ? '' : `, ${bytes} bytes`
    emitTerminalEvent({
      action: 'write',
      title,
      text: `\n\n[${cleanName} ${status}${byteText}]\n`,
      newline: false,
      level: verified === false ? 'error' : 'success',
      ...artifact,
    })
    if (verified === true) {
      scheduleAutoCloseWriteFilePreview({ title, artifact })
    } else if (verified === false) {
      cancelAutoClose(STREAM_ID)
    }
  }
}

export function streamToolFileWriteExecutionPreview(toolName, args = {}, outcome = {}) {
  const extracted = extractFileWriteArgs(toolName, args)
  if (!extracted) return false
  streamWriteFileExecutionPreview({
    toolName: extracted.toolName,
    path: extracted.path,
    content: extracted.content,
    bytes: outcome.bytes,
    verified: outcome.verified,
  })
  return true
}

export const __internals = {
  decodeJsonStringPrefix,
  decodeXmlEntitiesPrefix,
  extractPartialXmlInvoke,
  findStringValueStart,
  getRecentPreview,
  isGenericFileWriteToolName,
}
