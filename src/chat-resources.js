import path from 'path'
import { markdownImage, persistChatResourceDataUrl } from './chat-media.js'

export const CHAT_RESOURCE_CHANNEL = 'RESOURCE'
export const MAX_CHAT_RESOURCES = 8
export const MAX_CHAT_RESOURCE_BYTES = 20 * 1024 * 1024
export const MAX_CHAT_RESOURCE_TOTAL_BYTES = 40 * 1024 * 1024

function cleanResourceName(value = '', fallback = 'resource.bin') {
  const base = path.basename(String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim())
  return (base || fallback).slice(0, 180)
}

function safeMarkdownLabel(value = '', fallback = 'resource') {
  return String(value || fallback).replace(/[\[\]\r\n]/g, ' ').trim() || fallback
}

function dataUrlForResource(item = {}) {
  return String(item.data_url || item.dataUrl || item.url || item.src || '').trim()
}

function decodedDataUrlSize(dataUrl = '') {
  const match = String(dataUrl || '').trim().match(
    /^data:([^;,]+)(?:;[^,]*)?;base64,([a-z0-9+/=\s]*)$/i,
  )
  if (!match) throw new Error('expected a base64 data URL')
  const base64 = match[2].replace(/\s+/g, '')
  if (base64.length % 4 === 1) throw new Error('invalid base64 resource')
  const padding = base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0)
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding)
}

export function persistDroppedChatResources(input = []) {
  if (!Array.isArray(input) || input.length === 0) throw new Error('resources required')
  if (input.length > MAX_CHAT_RESOURCES) {
    throw new Error(`at most ${MAX_CHAT_RESOURCES} resources can be added at once`)
  }

  // Validate the entire batch before writing any content-addressed files. This
  // prevents a rejected oversized batch from leaving unreferenced files behind.
  const candidates = input
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item && typeof item === 'object')
    .map(({ item, index }) => {
      const dataUrl = dataUrlForResource(item)
      const size = decodedDataUrlSize(dataUrl)
      if (size > MAX_CHAT_RESOURCE_BYTES) {
        throw new Error(`resource is larger than ${Math.round(MAX_CHAT_RESOURCE_BYTES / 1024 / 1024)}MB`)
      }
      return { item, index, dataUrl, size }
    })
  if (candidates.length === 0) throw new Error('no valid resources')
  if (candidates.reduce((sum, candidate) => sum + candidate.size, 0) > MAX_CHAT_RESOURCE_TOTAL_BYTES) {
    throw new Error(`resources are larger than ${Math.round(MAX_CHAT_RESOURCE_TOTAL_BYTES / 1024 / 1024)}MB in total`)
  }

  const resources = []
  for (const { item, index, dataUrl } of candidates) {
    const name = cleanResourceName(item.name || item.filename, `resource-${index + 1}.bin`)
    const stored = persistChatResourceDataUrl(dataUrl, {
      originalFilename: name,
      maxBytes: MAX_CHAT_RESOURCE_BYTES,
    })
    resources.push({
      id: stored.filename,
      name,
      kind: stored.mime.startsWith('image/') ? 'image' : 'file',
      mime: stored.mime,
      size: stored.size,
      url: stored.url,
      path: stored.sandboxPath,
    })
  }
  return resources
}

export function buildChatResourceDisplayContent(resources = []) {
  return resources.map(resource => {
    const label = safeMarkdownLabel(resource?.name, 'resource')
    if (resource?.kind === 'image') return markdownImage(resource.url, label)
    return `📎 [${label}](${resource?.url || '#'})`
  }).join('\n\n')
}

export function parseConversationResourceMetadata(value = '') {
  if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object')
  try {
    const parsed = JSON.parse(String(value || ''))
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : []
  } catch {
    return []
  }
}

export function flattenConversationResources(rows = []) {
  return (Array.isArray(rows) ? rows : []).flatMap(row =>
    parseConversationResourceMetadata(row?.resource_metadata || row?.resourceMetadata))
}

export function mergePendingResourcesIntoConversationWindow(conversationWindow = [], pendingRows = []) {
  const merged = new Map()
  for (const row of [...(pendingRows || []), ...(conversationWindow || [])]) {
    if (!row) continue
    const key = row.id == null
      ? `${row.role || ''}:${row.timestamp || ''}:${row.content || ''}`
      : `id:${row.id}`
    merged.set(key, row)
  }
  return [...merged.values()].sort((left, right) => {
    const leftId = Number(left?.id)
    const rightId = Number(right?.id)
    if (Number.isFinite(leftId) && Number.isFinite(rightId)) return leftId - rightId
    return String(left?.timestamp || '').localeCompare(String(right?.timestamp || ''))
  })
}

function describeResource(resource = {}) {
  const name = String(resource.name || 'resource').replace(/[\r\n"]/g, ' ')
  const kind = resource.kind === 'image' ? 'image' : 'file'
  const fields = [
    `${kind} "${name}"`,
    resource.mime ? `mime=${resource.mime}` : '',
    Number.isFinite(Number(resource.size)) ? `bytes=${Number(resource.size)}` : '',
    resource.path ? `sandbox_path="${resource.path}"` : '',
    resource.url ? `chat_url="${resource.url}"` : '',
  ].filter(Boolean)
  return `- ${fields.join('; ')}`
}

export function formatConversationResourceForAgent(row = {}, { activatesCurrentTurn = false } = {}) {
  const resources = parseConversationResourceMetadata(row.resource_metadata || row.resourceMetadata)
  if (resources.length === 0) return String(row.content || '')
  const boundary = activatesCurrentTurn
    ? 'These resources were added earlier without starting the Agent. The current user message is their follow-up instruction; handle the resources and that instruction as one turn.'
    : 'These are resource records from chat history. They were not, by themselves, a request to process anything.'
  return [
    '[user-staged resources]',
    boundary,
    ...resources.map(describeResource),
  ].join('\n')
}

export function buildPendingResourceInjectorContext(rows = []) {
  const resources = flattenConversationResources(rows)
  if (resources.length === 0) return ''
  const visionHint = resources.some(resource => resource?.kind === 'image' || String(resource?.mime || '').startsWith('image/'))
    ? 'This turn contains staged visual content. If the instruction requires seeing it, analyze image content using the exact sandbox_path.'
    : ''
  return [
    '[resources awaiting this user instruction]',
    'The files/images below were already saved to chat history. Do not treat their arrival as a separate request; use them together with the current text or voice instruction.',
    visionHint,
    ...resources.map(describeResource),
  ].filter(Boolean).join('\n')
}
