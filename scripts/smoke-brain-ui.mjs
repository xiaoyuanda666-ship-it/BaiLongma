import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const brainUiRoot = path.join(root, 'src', 'ui', 'brain-ui')

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    default: return 'text/plain; charset=utf-8'
  }
}

function sendJson(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function isPathInside(parentDir, candidatePath) {
  const parent = path.resolve(parentDir)
  const candidate = path.resolve(candidatePath)
  const relative = path.relative(parent, candidate)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function sendFile(res, filePath) {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) throw new Error('not a file')
    res.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    })
    fs.createReadStream(filePath).pipe(res)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}

function createServer() {
  const sseClients = new Set()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')

    if (url.pathname === '/brain-ui' || url.pathname === '/brain-ui.html' || url.pathname === '/') {
      sendFile(res, path.join(root, 'brain-ui.html'))
      return
    }

    if (url.pathname === '/vendor/d3/d3.min.js') {
      sendFile(res, path.join(root, 'node_modules', 'd3', 'dist', 'd3.min.js'))
      return
    }

    if (url.pathname.startsWith('/src/ui/brain-ui/')) {
      const relativePath = decodeURIComponent(url.pathname.slice('/src/ui/brain-ui/'.length))
      const assetPath = path.resolve(brainUiRoot, relativePath)
      if (!isPathInside(brainUiRoot, assetPath)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      sendFile(res, assetPath)
      return
    }

    if (url.pathname === '/agent-profile') {
      sendJson(res, { name: 'SmokeLongma' })
      return
    }

    if (url.pathname === '/memories') {
      sendJson(res, [
        { id: 1, mem_id: 'm1', type: 'fact', content: 'Alpha memory', detail: 'First smoke node', created_at: new Date().toISOString() },
        { id: 2, mem_id: 'm2', type: 'preference', content: 'Beta memory', detail: 'Second smoke node', created_at: new Date().toISOString() },
      ])
      return
    }

    if (url.pathname === '/conversations') {
      sendJson(res, [])
      return
    }

    if (url.pathname === '/settings') {
      sendJson(res, {
        llm: { activated: true, provider: 'deepseek', model: 'smoke', models: [{ id: 'smoke', label: 'Smoke' }] },
        providers: { deepseek: { models: [{ id: 'smoke', label: 'Smoke' }] } },
        minimax: { configured: false },
      })
      return
    }

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(`data: ${JSON.stringify({ type: 'connected', data: {}, ts: new Date().toISOString() })}\n\n`)
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }

    if (url.pathname === '/message') {
      sendJson(res, { ok: true })
      return
    }

    res.writeHead(404)
    res.end('not found')
  })

  server.closeAllSse = () => {
    for (const client of sseClients) {
      try { client.end() } catch {}
    }
    sseClients.clear()
  }
  return server
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    server.on('error', reject)
  })
}

const server = createServer()
const port = await listen(server)
const baseUrl = `http://127.0.0.1:${port}`
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
const errors = []
page.on('pageerror', err => errors.push(err.message))
page.on('console', msg => {
  if (msg.text().includes('/acui') && msg.text().includes('WebSocket connection')) return
  if (msg.type() === 'error') errors.push(msg.text())
})

try {
  const vendorResponse = await page.goto(`${baseUrl}/vendor/d3/d3.min.js`)
  if (!vendorResponse?.ok()) throw new Error('local d3 vendor route failed')

  await page.goto(`${baseUrl}/brain-ui`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#graph circle', { timeout: 5000 })
  await page.waitForFunction(() => window.d3 && document.querySelector('#agent-brand-name')?.textContent.includes('SmokeLongma'))

  const snapshot = await page.evaluate(() => ({
    d3: Boolean(window.d3),
    nodes: document.querySelectorAll('#graph circle').length,
    links: document.querySelectorAll('#graph line').length,
    acuiHost: Boolean(document.getElementById('acui-host')),
    brand: document.querySelector('#agent-brand-name')?.textContent || '',
  }))

  if (!snapshot.d3) throw new Error('d3 global missing')
  if (snapshot.nodes < 2) throw new Error(`expected at least 2 graph nodes, saw ${snapshot.nodes}`)
  if (!snapshot.acuiHost) throw new Error('ACUI host was not bootstrapped')
  if (errors.length) throw new Error(`browser errors:\n${errors.join('\n')}`)

  console.log('[PASS] brain-ui smoke')
  console.log(JSON.stringify(snapshot, null, 2))
} finally {
  await browser.close()
  server.closeAllSse()
  await new Promise(resolve => server.close(resolve))
}
