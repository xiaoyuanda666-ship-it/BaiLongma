import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { paths } from './paths.js'
import { supportsImageInput } from './model-capabilities.js'
import { assertInSandbox } from './capabilities/sandbox.js'

export const MAX_MODEL_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 28 * 1024 * 1024 // Fits within a 48 MiB JSON request after base64 encoding.
const MAX_IMAGES = 8

function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  throw new Error('图片格式不支持，请使用 PNG、JPEG、GIF 或 WebP')
}

export function markdownImageReferences(text = '') {
  return [...String(text).matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)]
    .map(match => match[1] || match[2])
}

// Auto attachments read only the stores populated by uploads. Local paths
// outside those stores require an explicit analyze_image tool call.
export function resolveModelImage(ref, { allowLocalFiles = false } = {}) {
  const raw = String(ref || '').trim()
  let bytes
  if (raw.startsWith('data:')) {
    const match = raw.match(/^data:image\/[\w.+-]+;base64,([a-z0-9+/=\s]+)$/i)
    if (!match) throw new Error('无效的图片 data URL')
    if (match[1].length > MAX_MODEL_IMAGE_BYTES * 1.38) throw new Error('图片超过 20MB')
    bytes = Buffer.from(match[1].replace(/\s/g, ''), 'base64')
  } else if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw)
    if (url.username || url.password || raw.length > 8192) throw new Error('无效的图片 URL')
    return { url: url.href, bytes: 0 }
  } else {
    let file
    if (raw.startsWith('/media/chat/')) {
      const name = decodeURIComponent(raw.slice('/media/chat/'.length))
      if (!/^[a-f0-9]{64}\.(?:png|jpe?g|gif|webp|bmp)$/i.test(name)) throw new Error('无效的聊天图片引用')
      file = [paths.mediaDir, paths.sandboxChatUploadsDir]
        .map(dir => path.join(dir, name)).find(candidate => fs.existsSync(candidate))
      if (!file) throw new Error('聊天图片不存在，请重新上传')
      const real = fs.realpathSync(file)
      if (![paths.mediaDir, paths.sandboxChatUploadsDir].some(dir => path.dirname(real) === fs.realpathSync(dir))) {
        throw new Error('聊天图片不能指向上传目录以外的文件')
      }
    } else {
      if (!allowLocalFiles) throw new Error('本地图片请通过 analyze_image 工具读取')
      const local = raw.startsWith('file://') ? fileURLToPath(raw) : raw
      file = path.resolve(paths.sandboxDir, local)
      assertInSandbox(file)
    }
    const stat = fs.statSync(file)
    if (!stat.isFile()) throw new Error('图片路径不是文件')
    if (stat.size > MAX_MODEL_IMAGE_BYTES) throw new Error('图片超过 20MB')
    bytes = fs.readFileSync(file)
  }
  if (!bytes.length || bytes.length > MAX_MODEL_IMAGE_BYTES) throw new Error('图片为空或超过 20MB')
  return { url: `data:${imageMime(bytes)};base64,${bytes.toString('base64')}`, bytes: bytes.length }
}

// Keep base64 out of stored history and traces; resolve only at the request
// boundary. Prefer recent attachments when the request budget is exhausted.
export function prepareImageMessages(messages = [], connection = {}) {
  const directVision = supportsImageInput(connection)
  let count = 0
  let total = 0
  const out = [...messages]
  for (let i = out.length - 1; i >= 0; i--) {
    const message = out[i]
    if (message?.role !== 'user' || typeof message.content !== 'string') continue
    const refs = [...new Set([
      ...markdownImageReferences(message.content), ...(message._image_refs || []),
    ])]
    if (!refs.length) continue
    if (!directVision) {
      // Text-only models must explicitly obtain visual evidence through the
      // vision tool. A Markdown URL alone does not provide any image pixels.
      out[i] = { ...message, content: `${message.content}\n\n[图片尚未传入当前对话模型。需要理解图片时，请调用 analyze_image，使用以下原始图片引用；获得实际识图结果后再回答，不能根据文件名或链接猜测内容。]\n${refs.join('\n')}` }
      continue
    }
    const parts = [{ type: 'text', text: message.content }]
    for (const ref of refs) {
      try {
        if (count >= MAX_IMAGES) throw new Error('本次最多传入 8 张图片，请按需用 analyze_image 查看其余图片')
        const image = resolveModelImage(ref)
        if (total + image.bytes > MAX_TOTAL_BYTES) throw new Error('图片总大小超过本轮上限，请分批查看')
        total += image.bytes
        count++
        parts.push({ type: 'image_url', image_url: { url: image.url } })
      } catch (error) {
        parts.push({ type: 'text', text: `[图片未传入：${error.message}。不能根据文件名猜测图片内容。]` })
      }
    }
    out[i] = { ...message, content: parts }
  }
  return out
}
