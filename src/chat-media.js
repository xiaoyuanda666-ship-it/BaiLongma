import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { paths } from './paths.js'

export const CHAT_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

const MIME_TO_EXT = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/bmp', '.bmp'],
  ['video/mp4', '.mp4'],
  ['video/quicktime', '.mov'],
  ['video/webm', '.webm'],
  ['video/x-matroska', '.mkv'],
  ['video/x-msvideo', '.avi'],
  ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['audio/wav', '.wav'],
  ['audio/silk', '.silk'],
  ['audio/amr', '.amr'],
  ['application/pdf', '.pdf'],
  ['application/msword', '.doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.ms-powerpoint', '.ppt'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['application/zip', '.zip'],
  ['application/x-tar', '.tar'],
  ['application/gzip', '.gz'],
  ['text/plain', '.txt'],
  ['text/csv', '.csv'],
])

const EXT_TO_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.mp4', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.mkv', 'video/x-matroska'],
  ['.avi', 'video/x-msvideo'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.wav', 'audio/wav'],
  ['.silk', 'audio/silk'],
  ['.amr', 'audio/amr'],
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.zip', 'application/zip'],
  ['.tar', 'application/x-tar'],
  ['.gz', 'application/gzip'],
  ['.txt', 'text/plain'],
  ['.csv', 'text/csv'],
])

function normalizeExt(ext = '', fallback = '.png') {
  const clean = String(ext || '').trim().toLowerCase()
  if (!clean) return fallback
  return clean.startsWith('.') ? clean : `.${clean}`
}

function extFromMime(mime = '', fallback = '.png') {
  return MIME_TO_EXT.get(String(mime || '').split(';')[0].trim().toLowerCase()) || fallback
}

function safeOriginalExt(originalFilename = '', mime = '') {
  const fromName = normalizeExt(path.extname(String(originalFilename || '')), '')
  if (/^\.[a-z0-9]{1,12}$/i.test(fromName)) return fromName
  return extFromMime(mime, '.bin')
}

export function mimeFromChatMediaExt(ext = '') {
  return EXT_TO_MIME.get(normalizeExt(ext)) || 'application/octet-stream'
}

export function persistChatMediaBuffer(buffer, { ext = '.png', mime = '', originalFilename = '' } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '')
  if (!buf.length) throw new Error('media buffer is empty')
  const cleanExt = normalizeExt(ext || extFromMime(mime, '.bin'), '.bin')
  const hash = crypto.createHash('sha256').update(buf).digest('hex')
  const storedName = `${hash}${cleanExt}`
  const storedPath = path.join(paths.mediaDir, storedName)
  if (!fs.existsSync(storedPath)) fs.writeFileSync(storedPath, buf)
  return {
    url: `/media/chat/${storedName}`,
    path: storedPath,
    filename: storedName,
    originalFilename,
    mime: String(mime || '').trim() || mimeFromChatMediaExt(cleanExt),
    size: buf.length,
  }
}

export function persistChatMediaPath(filePath = '') {
  let resolved = String(filePath || '').trim()
  if (!resolved) throw new Error('media path required')
  if (/^file:\/\//i.test(resolved)) resolved = fileURLToPath(resolved)
  resolved = path.resolve(resolved)
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) throw new Error(`media path is not a file: ${resolved}`)
  return persistChatMediaBuffer(fs.readFileSync(resolved), { ext: path.extname(resolved) || '.png' })
}

export function persistChatMediaDataUrl(dataUrl = '') {
  const raw = String(dataUrl || '').trim()
  const match = raw.match(/^data:([^;,]+)(?:;[^,]*)?;base64,([a-z0-9+/=\s]+)$/i)
  if (!match) throw new Error('expected a base64 data URL')
  const mime = match[1].toLowerCase()
  if (!mime.startsWith('image/')) throw new Error(`unsupported media type: ${mime}`)
  return persistChatMediaBuffer(Buffer.from(match[2].replace(/\s+/g, ''), 'base64'), {
    ext: extFromMime(mime),
  })
}

// 聊天拖入资源和“发图”是两种不同语义：前者可以是任意文件，并且必须落在
// sandbox 内，等用户下一条文字/语音指令到达后 Agent 才读取。保留独立函数，
// 避免放宽 persistChatMediaDataUrl 的 image-only 安全边界。
export function persistChatResourceDataUrl(dataUrl = '', {
  originalFilename = '',
  maxBytes = 20 * 1024 * 1024,
} = {}) {
  const raw = String(dataUrl || '').trim()
  const match = raw.match(/^data:([^;,]+)(?:;[^,]*)?;base64,([a-z0-9+/=\s]*)$/i)
  if (!match) throw new Error('expected a base64 data URL')
  const mime = String(match[1] || 'application/octet-stream').trim().toLowerCase()
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
  if (maxBytes > 0 && buffer.length > maxBytes) {
    throw new Error(`resource is larger than ${Math.round(maxBytes / 1024 / 1024)}MB`)
  }
  const ext = safeOriginalExt(originalFilename, mime)
  const hash = crypto.createHash('sha256').update(buffer).digest('hex')
  const storedName = `${hash}${ext}`
  const storedPath = path.join(paths.sandboxChatUploadsDir, storedName)
  if (!fs.existsSync(storedPath)) fs.writeFileSync(storedPath, buffer)
  return {
    url: `/media/chat/${storedName}`,
    path: storedPath,
    sandboxPath: path.relative(paths.sandboxDir, storedPath).replace(/\\/g, '/'),
    filename: storedName,
    originalFilename: String(originalFilename || '').trim(),
    mime,
    size: buffer.length,
  }
}

export function markdownImage(url = '', alt = 'image') {
  const safeAlt = String(alt || 'image').replace(/[\]\r\n]/g, ' ').trim() || 'image'
  return `![${safeAlt}](${url})`
}
