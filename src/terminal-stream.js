import { emitEvent } from './events.js'

const MAX_CHUNKS = 800
const MAX_TOTAL_CHARS = 120_000
const DEFAULT_TITLE = 'Jarvis Terminal Stream'
const sessions = new Map()

function nowIso() {
  return new Date().toISOString()
}

function normalizeStreamId(value = '') {
  const id = String(value || 'default').trim()
  return id.replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 80) || 'default'
}

function normalizeLevel(value = '') {
  const level = String(value || 'info').trim().toLowerCase()
  return ['info', 'success', 'warning', 'error', 'muted'].includes(level) ? level : 'info'
}

function normalizeFormat(value = '') {
  const format = String(value || '').trim().toLowerCase()
  return ['plain', 'markdown', 'code'].includes(format) ? format : ''
}

function normalizeOptionalBoolean(value) {
  if (value === undefined) return undefined
  if (value === true || value === false) return value
  const text = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(text)) return true
  if (['false', '0', 'no', 'off', ''].includes(text)) return false
  return !!value
}

function getSession(streamId = 'default') {
  const id = normalizeStreamId(streamId)
  if (!sessions.has(id)) {
    sessions.set(id, {
      stream_id: id,
      title: DEFAULT_TITLE,
      format: 'plain',
      artifact_kind: '',
      artifact_path: '',
      hold_open: false,
      chunks: [],
      closed: false,
      updated_at: nowIso(),
    })
  }
  return sessions.get(id)
}

function trimSession(session) {
  while (session.chunks.length > MAX_CHUNKS) session.chunks.shift()

  let total = session.chunks.reduce((sum, chunk) => sum + String(chunk.text || '').length + 1, 0)
  while (total > MAX_TOTAL_CHARS && session.chunks.length > 1) {
    const removed = session.chunks.shift()
    total -= String(removed?.text || '').length + 1
  }
}

function snapshotFromSession(session) {
  return {
    stream_id: session.stream_id,
    title: session.title,
    format: session.format,
    artifact_kind: session.artifact_kind,
    artifact_path: session.artifact_path,
    hold_open: !!session.hold_open,
    closed: session.closed,
    updated_at: session.updated_at,
    chunks: session.chunks.map(chunk => ({ ...chunk })),
  }
}

export function getTerminalStreamSnapshot(streamId = 'default') {
  return snapshotFromSession(getSession(streamId))
}

function readDesktopLayoutSnapshot() {
  try {
    const reader = globalThis?.getJarvisWindowLayoutSnapshot
    return typeof reader === 'function' ? reader() : null
  } catch {
    return null
  }
}

function compactTerminalTitle(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

function compactBounds(bounds = null) {
  if (!bounds || typeof bounds !== 'object') return ''
  const x = Number(bounds.x)
  const y = Number(bounds.y)
  const width = Number(bounds.width)
  const height = Number(bounds.height)
  if (![x, y, width, height].every(Number.isFinite)) return ''
  return `x=${Math.round(x)} y=${Math.round(y)} width=${Math.round(width)} height=${Math.round(height)}`
}

function isTerminalStreamWindowSnapshot(win) {
  if (!win || typeof win !== 'object') return false
  if (win.kind === 'terminal_stream' || win.role === 'terminal_stream') return true
  if (win.terminal_stream_id) return true
  const title = compactTerminalTitle(win.title)
  return title === DEFAULT_TITLE || title.startsWith('Writing ')
}

function findTerminalStreamWindow(layout = null) {
  if (isTerminalStreamWindowSnapshot(layout?.terminal_stream_window)) return layout.terminal_stream_window
  const windows = Array.isArray(layout?.windows) ? layout.windows : []
  return windows.find(isTerminalStreamWindowSnapshot) || null
}

function hasWindowInventory(layout = null) {
  return !!layout && (Array.isArray(layout.windows) || layout.terminal_stream_window !== undefined)
}

function streamHasPromptValue(snapshot, windowStreamId = '') {
  if (!snapshot) return false
  if (windowStreamId && snapshot.stream_id === windowStreamId) return true
  if (snapshot.closed) return false
  return snapshot.chunks.length > 0
    || snapshot.title !== DEFAULT_TITLE
    || snapshot.format !== 'plain'
    || !!snapshot.artifact_kind
    || !!snapshot.artifact_path
    || !!snapshot.hold_open
}

function relevantTerminalSnapshots(windowStreamId = '') {
  const out = []
  const seen = new Set()
  for (const session of sessions.values()) {
    const snapshot = snapshotFromSession(session)
    if (!streamHasPromptValue(snapshot, windowStreamId)) continue
    out.push(snapshot)
    seen.add(snapshot.stream_id)
  }
  if (windowStreamId && !seen.has(windowStreamId) && sessions.has(windowStreamId)) {
    out.unshift(snapshotFromSession(sessions.get(windowStreamId)))
  }
  return out
}

export function formatTerminalStreamContext({ layout = readDesktopLayoutSnapshot() } = {}) {
  const terminalWindow = findTerminalStreamWindow(layout)
  const windowStreamId = terminalWindow?.terminal_stream_id
    ? normalizeStreamId(terminalWindow.terminal_stream_id)
    : ''
  const snapshots = relevantTerminalSnapshots(windowStreamId)
  if (!terminalWindow && snapshots.length === 0) return ''

  const visibleWindow = terminalWindow
    ? (terminalWindow.visible !== false && terminalWindow.minimized !== true)
    : (hasWindowInventory(layout) ? false : null)
  const activeSnapshot = snapshots.find(s => windowStreamId && s.stream_id === windowStreamId)
    || snapshots.find(s => !s.closed)
    || snapshots[0]
  const closeStreamId = windowStreamId || activeSnapshot?.stream_id || 'write_file'

  const lines = ['Terminal preview window state:']
  lines.push(`- visible_window: ${visibleWindow === null ? 'unknown' : (visibleWindow ? 'yes' : 'no')}`)

  if (terminalWindow) {
    const title = compactTerminalTitle(terminalWindow.title)
    if (title) lines.push(`- window_title: ${title}`)
    lines.push(`- window_stream_id: ${windowStreamId || 'unknown'}`)
    const bounds = compactBounds(terminalWindow.bounds)
    if (bounds) lines.push(`- window_bounds: ${bounds}`)
    if (terminalWindow.focused !== undefined) lines.push(`- window_focused: ${terminalWindow.focused ? 'yes' : 'no'}`)
  }

  for (const snapshot of snapshots) {
    const parts = [
      `closed=${snapshot.closed ? 'true' : 'false'}`,
      `format=${snapshot.format || 'plain'}`,
      `hold_open=${snapshot.hold_open ? 'true' : 'false'}`,
      `chunks=${snapshot.chunks.length}`,
    ]
    if (snapshot.artifact_kind) parts.push(`artifact_kind=${snapshot.artifact_kind}`)
    if (snapshot.artifact_path) parts.push(`artifact_path=${snapshot.artifact_path}`)
    const title = compactTerminalTitle(snapshot.title)
    lines.push(`- stream ${snapshot.stream_id}: title="${title}", ${parts.join(', ')}`)
  }

  lines.push('Terminal preview closing method:')
  lines.push(`- To close the visible preview, call terminal_stream with action="close", stream_id="${closeStreamId}".`)
  lines.push('- If the stream has hold_open=true, include force=true when the user explicitly asks to close it or when the same file is opened in another local app.')
  lines.push('- Do not tell the user no preview window exists while visible_window is yes.')

  return lines.join('\n')
}

export function recordTerminalStreamEvent({
  action = 'write',
  stream_id = 'default',
  title = '',
  text = '',
  newline = true,
  level = 'info',
  format = '',
  artifact_kind = '',
  artifact_path = '',
  hold_open,
  force = false,
} = {}) {
  let normalizedAction = String(action || 'write').trim().toLowerCase()
  const session = getSession(stream_id)
  const ts = nowIso()

  if (title !== undefined && String(title || '').trim()) {
    session.title = String(title).trim().slice(0, 120)
  }
  const normalizedFormat = normalizeFormat(format)
  if (normalizedFormat) session.format = normalizedFormat
  if (artifact_kind !== undefined && String(artifact_kind || '').trim()) {
    session.artifact_kind = String(artifact_kind).trim().slice(0, 80)
  }
  if (artifact_path !== undefined && String(artifact_path || '').trim()) {
    session.artifact_path = String(artifact_path).trim().slice(0, 260)
  }
  const normalizedHoldOpen = normalizeOptionalBoolean(hold_open)
  const forceClose = normalizeOptionalBoolean(force) === true
  if (normalizedHoldOpen !== undefined) session.hold_open = normalizedHoldOpen

  if (normalizedAction === 'clear') {
    if (!normalizedFormat) session.format = 'plain'
    if (!String(artifact_kind || '').trim()) session.artifact_kind = ''
    if (!String(artifact_path || '').trim()) session.artifact_path = ''
    if (normalizedHoldOpen === undefined) session.hold_open = false
    session.chunks = []
    session.closed = false
  } else if (normalizedAction === 'write') {
    const body = String(text ?? '')
    if (body) {
      session.chunks.push({
        text: body,
        newline: newline !== false,
        level: normalizeLevel(level),
        ts,
      })
    }
    session.closed = false
  } else if (normalizedAction === 'open') {
    session.closed = false
  } else if (normalizedAction === 'close') {
    if (session.hold_open && !forceClose) {
      normalizedAction = 'open'
      session.closed = false
    } else {
      session.closed = true
    }
  }

  session.updated_at = ts
  trimSession(session)

  const data = {
    action: normalizedAction,
    stream_id: session.stream_id,
    title: session.title,
    format: session.format,
    artifact_kind: session.artifact_kind,
    artifact_path: session.artifact_path,
    hold_open: !!session.hold_open,
    text: normalizedAction === 'write' ? String(text ?? '') : '',
    newline: newline !== false,
    level: normalizeLevel(level),
    closed: session.closed,
  }

  emitEvent('terminal_stream', data)
  return getTerminalStreamSnapshot(session.stream_id)
}
