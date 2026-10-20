import fs from 'fs'
import path from 'path'
import { pipeline } from 'node:stream'
import { config } from '../../config.js'
import { paths } from '../../paths.js'
import { contentTypeFor, isPathInside, parseByteRange } from '../utils.js'

const INDEX_PATH = paths.indexHtml
const DASHBOARD_PATH = paths.dashboardHtml
const BRAIN_PATH = paths.brainHtml
const BRAIN_UI_PATH = paths.brainUiHtml
const WEBSITE_PATH = paths.websiteHtml
const SYSTEM_PROMPT_PATH = paths.systemPromptHtml
const ACTIVATION_PATH = paths.activationHtml
const TURN_TRACE_PATH = paths.turnTraceHtml
const BRAIN_UI_ASSET_ROOT = paths.brainUiAssetRoot
const SITE_ICON_PATH = path.join(paths.resourcesDir, 'build', 'icon.png')
const SCENE_SHELL_ASSET_ROOT = path.join(paths.resourcesDir, 'src', 'ui', 'scene-shell')
const TERMINAL_STREAM_PATH = path.join(paths.resourcesDir, 'src', 'ui', 'terminal-stream', 'index.html')
const D3_VENDOR_PATH = path.join(paths.resourcesDir, 'node_modules', 'd3', 'dist', 'd3.min.js')

function serveHtml(res, filePath, notFoundText) {
  try {
    const html = fs.readFileSync(filePath, 'utf-8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  } catch {
    res.writeHead(404)
    res.end(notFoundText)
  }
}

function serveFile(res, filePath, notFoundText, cacheControl = 'no-cache') {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) {
      res.writeHead(404)
      res.end(notFoundText)
      return
    }
    res.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
    })
    pipeline(fs.createReadStream(filePath), res, () => {})
  } catch {
    res.writeHead(404)
    res.end(notFoundText)
  }
}

function serveAsset(req, res, assetRoot, relativePrefix) {
  const relativePath = decodeURIComponent(req.url.split('?')[0].slice(relativePrefix.length))
  const root = path.resolve(assetRoot)
  let assetPath = path.resolve(assetRoot, relativePath)
  const contentType = contentTypeFor(assetPath)

  if (!isPathInside(root, assetPath)) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }

  try {
    assetPath = fs.realpathSync(assetPath)
    if (!isPathInside(fs.realpathSync(root), assetPath)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    const stat = fs.statSync(assetPath)
    if (!stat.isFile()) {
      res.writeHead(404)
      res.end('asset not found')
      return
    }
    const byteRange = parseByteRange(req.headers.range, stat.size)
    if (byteRange?.unsatisfiable) {
      res.writeHead(416, {
        'Content-Range': `bytes */${stat.size}`,
        'Accept-Ranges': 'bytes',
      })
      res.end()
      return
    }
    if (byteRange) {
      const { start, end } = byteRange
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      })
      pipeline(fs.createReadStream(assetPath, { start, end }), res, () => {})
      return
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    })
    pipeline(fs.createReadStream(assetPath), res, () => {})
  } catch {
    res.writeHead(404)
    res.end('asset not found')
  }
}

export async function handleStaticRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/focus-banner.html') {
    serveHtml(res, path.join(paths.resourcesDir, 'focus-banner.html'), 'focus-banner.html not found')
    return true
  }

  if (req.method === 'GET' && url.pathname === '/bailongma-lan-root-ca.cer') {
    const caPath = String(globalThis.process?.env?.BAILONGMA_LAN_CA_CERT || '').trim()
    if (!caPath) {
      res.writeHead(404)
      res.end('LAN root certificate is not configured')
      return true
    }
    serveFile(res, caPath, 'LAN root certificate not found', 'no-store')
    return true
  }

  if (req.method === 'GET' && (url.pathname === '/turn-trace' || url.pathname === '/turn-trace.html')) {
    serveHtml(res, TURN_TRACE_PATH, 'turn-trace.html not found')
    return true
  }

  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    res.writeHead(204)
    res.end()
    return true
  }

  if (req.method === 'GET' && (url.pathname === '/activation' || url.pathname === '/activation.html')) {
    serveHtml(res, ACTIVATION_PATH, 'activation.html not found')
    return true
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    if (config.needsActivation) {
      res.writeHead(302, { Location: '/activation' })
      res.end()
      return true
    }
    try {
      const html = fs.readFileSync(INDEX_PATH, 'utf-8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    } catch {
      res.writeHead(302, { Location: '/brain-ui' })
      res.end()
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/dashboard.html') {
    serveHtml(res, DASHBOARD_PATH, 'dashboard.html not found')
    return true
  }

  if (req.method === 'GET' && url.pathname === '/brain.html') {
    serveHtml(res, BRAIN_PATH, 'brain.html not found')
    return true
  }

  if (req.method === 'GET' && (url.pathname === '/site' || url.pathname === '/site.html')) {
    serveHtml(res, WEBSITE_PATH, 'website.html not found')
    return true
  }

  if (req.method === 'GET' && url.pathname === '/site-assets/icon.png') {
    serveFile(res, SITE_ICON_PATH, 'site icon not found', 'public, max-age=31536000, immutable')
    return true
  }

  if (req.method === 'GET' && (url.pathname === '/brain-ui' || url.pathname === '/brain-ui.html')) {
    if (config.needsActivation && !url.searchParams.has('intro-preview')) {
      res.writeHead(302, { Location: '/activation' })
      res.end()
      return true
    }
    serveHtml(res, BRAIN_UI_PATH, 'brain-ui.html not found')
    return true
  }

  if (req.method === 'GET' && (url.pathname === '/terminal-stream' || url.pathname === '/terminal-stream.html')) {
    serveHtml(res, TERMINAL_STREAM_PATH, 'terminal-stream.html not found')
    return true
  }

  if (req.method === 'GET' && url.pathname === '/systemPrompt.html') {
    serveHtml(res, SYSTEM_PROMPT_PATH, 'systemPrompt.html not found')
    return true
  }

  if (req.method === 'GET' && url.pathname === '/vendor/d3/d3.min.js') {
    try {
      const stat = fs.statSync(D3_VENDOR_PATH)
      res.writeHead(200, {
        'Content-Type': contentTypeFor(D3_VENDOR_PATH),
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
      pipeline(fs.createReadStream(D3_VENDOR_PATH), res, () => {})
    } catch {
      res.writeHead(404)
      res.end('d3.min.js not found')
    }
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/src/ui/scene-shell/')) {
    serveAsset(req, res, SCENE_SHELL_ASSET_ROOT, '/src/ui/scene-shell/')
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/src/ui/brain-ui/')) {
    serveAsset(req, res, BRAIN_UI_ASSET_ROOT, '/src/ui/brain-ui/')
    return true
  }

  return false
}
