import fs from 'fs'
import path from 'path'
import { pipeline } from 'node:stream'
import { paths } from '../../paths.js'
import { getMediaHistory, upsertMediaHistory } from '../../db.js'
import { execGenerateVideo, getVideoHistory, saveGeneratedVideo } from '../../capabilities/tools/media.js'
import { mimeFromChatMediaExt } from '../../chat-media.js'
import { isPathInside, jsonResponse, parseByteRange, readJsonBody } from '../utils.js'

function streamFile(req, res, filePath, contentType, { cacheControl = 'no-cache', range = false } = {}) {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) {
      res.writeHead(404)
      res.end('media not found')
      return
    }
    const total = stat.size
    const byteRange = range ? parseByteRange(req.headers.range, total) : null
    if (byteRange?.unsatisfiable) {
      res.writeHead(416, {
        'Content-Range': `bytes */${total}`,
        'Accept-Ranges': 'bytes',
      })
      res.end()
      return
    }
    if (byteRange) {
      const { start, end } = byteRange
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control': cacheControl,
      })
      pipeline(fs.createReadStream(filePath, { start, end }), res, () => {})
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': total,
        ...(range ? { 'Accept-Ranges': 'bytes' } : {}),
        'Cache-Control': cacheControl,
      })
      pipeline(fs.createReadStream(filePath), res, () => {})
    }
  } catch {
    res.writeHead(404)
    res.end('media not found')
  }
}

function resolveMediaPath(res, root, filePath, { allowRoot = true } = {}) {
  if (isPathInside(root, filePath) && (allowRoot || path.resolve(root) !== path.resolve(filePath))) {
    try {
      const realRoot = fs.realpathSync(root)
      const realPath = fs.realpathSync(filePath)
      if (isPathInside(realRoot, realPath) && (allowRoot || realRoot !== realPath)) return realPath
    } catch {
      res.writeHead(404)
      res.end('media not found')
      return null
    }
  }
  res.writeHead(403)
  res.end('forbidden')
  return null
}

export async function handleMediaRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/media/history') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '30'), 100)
    jsonResponse(res, 200, getMediaHistory(limit))
    return true
  }

  if (req.method === 'POST' && url.pathname === '/media/history') {
    try {
      const body = await readJsonBody(req)
      if (!body.url || !body.kind) {
        jsonResponse(res, 400, { ok: false, error: 'url and kind required' })
        return true
      }
      upsertMediaHistory(body)
      jsonResponse(res, 200, { ok: true })
    } catch (e) {
      jsonResponse(res, e.statusCode === 413 ? 413 : 400, { ok: false, error: e.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/aivideo/generate') {
    try {
      const body = await readJsonBody(req, { maxBytes: 30 * 1024 * 1024 })
      const result = await execGenerateVideo({
        action: 'generate',
        prompt: body.prompt,
        images: Array.isArray(body.images) ? body.images : undefined,
        image_url: body.image_url || body.image,
        ratio: body.ratio,
        resolution: body.resolution,
        duration: body.duration,
      })
      const parsed = typeof result === 'string' ? JSON.parse(result) : result
      jsonResponse(res, parsed.ok ? 200 : 400, parsed)
    } catch (e) {
      const status = e.statusCode === 413 ? 413 : 400
      const message = e.statusCode === 413 ? 'Request body too large. Please keep images under about 18MB.' : e.message
      jsonResponse(res, status, { ok: false, error: message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/aivideo/draft') {
    try {
      const body = await readJsonBody(req, { maxBytes: 256 * 1024 })
      const { setAIVideoPanelState } = await import('../../capabilities/tools/media.js')
      setAIVideoPanelState({ open: body.open, prompt: body.prompt })
      jsonResponse(res, 200, { ok: true })
    } catch (e) {
      jsonResponse(res, e.statusCode === 413 ? 413 : 400, { ok: false, error: e.message })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/aivideo/save') {
    try {
      const body = await readJsonBody(req)
      const result = saveGeneratedVideo(body.jobId)
      jsonResponse(res, result.ok ? 200 : 400, result)
    } catch (e) {
      jsonResponse(res, e.statusCode === 413 ? 413 : 400, { ok: false, error: e.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/aivideo/history') {
    try {
      jsonResponse(res, 200, { ok: true, jobs: getVideoHistory() })
    } catch (e) {
      jsonResponse(res, 200, { ok: false, jobs: [], error: e.message })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/media/music/')) {
    const raw = url.pathname.slice('/media/music/'.length)
    const filename = path.basename(decodeURIComponent(raw))
    const filePath = resolveMediaPath(res, paths.musicDir, path.join(paths.musicDir, filename))
    if (!filePath) return true
    const mimeMap = {
      '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav',
      '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
      '.opus': 'audio/ogg; codecs=opus',
    }
    const contentType = mimeMap[path.extname(filename).toLowerCase()] || 'audio/mpeg'
    streamFile(req, res, filePath, contentType, { range: true })
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/media/video/')) {
    const raw = url.pathname.slice('/media/video/'.length)
    const filename = path.basename(decodeURIComponent(raw))
    const videoDir = path.join(paths.sandboxDir, 'videos')
    const filePath = resolveMediaPath(res, videoDir, path.join(videoDir, filename))
    if (!filePath) return true
    const mimeMap = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' }
    const contentType = mimeMap[path.extname(filename).toLowerCase()] || 'video/mp4'
    streamFile(req, res, filePath, contentType, { range: true })
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/media/chat/')) {
    const raw = url.pathname.slice('/media/chat/'.length)
    const filename = path.basename(decodeURIComponent(raw))
    // 普通聊天媒体仍在 data/media；用户拖入的待处理资源存放在 sandbox/chat-uploads，
    // 以便开启文件沙箱时 Agent 也能读取。URL 命名空间保持统一，历史记录无需区分来源。
    const mediaDir = fs.existsSync(path.join(paths.mediaDir, filename))
      ? paths.mediaDir
      : paths.sandboxChatUploadsDir
    const filePath = resolveMediaPath(res, mediaDir, path.join(mediaDir, filename), { allowRoot: false })
    if (!filePath) return true
    const contentType = mimeFromChatMediaExt(path.extname(filename).toLowerCase())
    streamFile(req, res, filePath, contentType, { cacheControl: 'public, max-age=31536000, immutable' })
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/audio/')) {
    const filename = path.basename(url.pathname)
    const audioDir = path.join(paths.sandboxDir, 'audio')
    const filePath = resolveMediaPath(res, audioDir, path.join(audioDir, filename), { allowRoot: false })
    if (!filePath) return true
    streamFile(req, res, filePath, 'audio/mpeg')
    return true
  }

  return false
}
