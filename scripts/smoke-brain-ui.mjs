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

    if (url.pathname === '/audit/stats') {
      sendJson(res, {
        windowHours: Number(url.searchParams.get('hours') || 1),
        sinceIso: new Date().toISOString(),
        recall: {},
        extract: {},
      })
      return
    }

    if (url.pathname === '/docs') {
      sendJson(res, { ok: true, topics: [] })
      return
    }

    if (url.pathname.startsWith('/docs/')) {
      sendJson(res, { ok: true, doc: { id: url.pathname.slice(6), title: 'Smoke Doc', body: '' } })
      return
    }

    if (url.pathname === '/aivideo/history') {
      sendJson(res, { ok: true, jobs: [] })
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

    if (url.pathname === '/settings/tts') {
      sendJson(res, {
        ok: true,
        tts: { ttsProvider: 'minimax', ttsVoiceId: 'male-qn-qingse' },
        providers: [{ id: 'minimax', label: 'MiniMax', streaming: false }],
        voices: { minimax: [{ id: 'male-qn-qingse', label: '青涩男声' }] },
      })
      return
    }

    if (url.pathname === '/hotspots') {
      sendJson(res, {
        ok: true,
        refreshMinutes: 30,
        fetchedAt: new Date().toISOString(),
        stale: false,
        platforms: {
          douyin: [
            { rank: 1, title: 'Smoke 热点一', heat: '100万', trend: 'same', isNew: false, source: 'smoke' },
            { rank: 2, title: 'Smoke 热点二', heat: '80万', trend: 'same', isNew: true, source: 'smoke' },
          ],
        },
      })
      return
    }

    if (url.pathname === '/person-card') {
      const name = url.searchParams.get('name') || ''
      if (name.includes('马云')) {
        sendJson(res, {
          ok: true,
          card: {
            name: '马云',
            title: '人物卡片',
            summary: '暂时没有内置资料。可以让 Longma 补充身份、代表作品和为什么被提到。',
            knownFor: [],
            tags: ['待补充'],
            image: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 640 360%22%3E%3Crect width=%22640%22 height=%22360%22 fill=%22%23112332%22/%3E%3Ccircle cx=%22320%22 cy=%22130%22 r=%2260%22 fill=%22%2382d2ff%22/%3E%3Crect x=%22205%22 y=%22210%22 width=%22230%22 height=%2280%22 rx=%2240%22 fill=%22%2382d2ff%22/%3E%3C/svg%3E',
            source: 'fallback',
            updatedAt: new Date().toISOString(),
          },
        })
        return
      }
      sendJson(res, {
        ok: true,
        card: {
          name: '周杰伦',
          title: '歌手 / 音乐人',
          summary: '华语流行音乐代表人物之一。',
          knownFor: ['七里香', '青花瓷'],
          tags: ['华语音乐', '创作歌手'],
          image: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 640 360%22%3E%3Crect width=%22640%22 height=%22360%22 fill=%22%23112332%22/%3E%3Ccircle cx=%22320%22 cy=%22130%22 r=%2260%22 fill=%22%2382d2ff%22/%3E%3Crect x=%22205%22 y=%22210%22 width=%22230%22 height=%2280%22 rx=%2240%22 fill=%22%2382d2ff%22/%3E%3C/svg%3E',
          source: 'smoke',
          updatedAt: new Date().toISOString(),
        },
      })
      return
    }

    if (url.pathname === '/person-card-state') {
      sendJson(res, { ok: true, state: { active: true } })
      return
    }

    if (url.pathname === '/social/wechat-clawbot/qr') {
      sendJson(res, { ok: true, qr: null, status: 'unavailable' })
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
  server.emitSse = (event) => {
    for (const client of sseClients) {
      try { client.write(`data: ${JSON.stringify(event)}\n\n`) } catch {}
    }
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
await page.addInitScript(() => {
  localStorage.setItem('jarvis-memory-graph-enabled', 'true')
})
const errors = []
page.on('pageerror', err => errors.push(err.message))
page.on('console', msg => {
  if (msg.text().includes('/acui') && msg.text().includes('WebSocket connection')) return
  if (msg.text().includes('Failed to load resource: the server responded with a status of 404')) return
  if (msg.type() === 'error') errors.push(msg.text())
})
page.on('response', response => {
  if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
})

try {
  const vendorResponse = await page.goto(`${baseUrl}/vendor/d3/d3.min.js`)
  if (!vendorResponse?.ok()) throw new Error('local d3 vendor route failed')

  await page.goto(`${baseUrl}/brain-ui`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#graph circle', { timeout: 5000 })
  await page.waitForFunction(() => window.d3 && document.querySelector('#agent-brand-name')?.textContent.includes('SmokeLongma'))
  await page.fill('#msg-input', '马云是谁')
  await page.click('#send-btn')
  await page.waitForTimeout(300)
  const appearedTooFast = await page.evaluate(() => document.body.classList.contains('person-card-mode'))
  if (appearedTooFast) throw new Error('person card appeared before the intended reveal delay')
  await page.waitForFunction(() => document.body.classList.contains('person-card-mode') && document.querySelector('#pc-name')?.textContent.includes('马云'))
  const enteringSeen = await page.evaluate(() => document.querySelector('#person-card-panel')?.classList.contains('pc-entering'))
  if (!enteringSeen) throw new Error('person card did not use the entering glitch state')
  server.emitSse({
    type: 'message',
    data: {
      from: 'consciousness',
      content: '马云，1964年生，浙江杭州人，阿里巴巴集团创始人，曾任董事局主席，创办了淘宝、支付宝，多次成为中国首富。',
    },
    ts: new Date().toISOString(),
  })
  await page.waitForFunction(() => document.querySelector('#pc-summary')?.textContent.includes('阿里巴巴集团创始人'))

  const snapshot = await page.evaluate(() => ({
    d3: Boolean(window.d3),
    nodes: document.querySelectorAll('#graph circle').length,
    links: document.querySelectorAll('#graph line').length,
    acuiHost: Boolean(document.getElementById('acui-host')),
    personCard: document.querySelector('#pc-name')?.textContent || '',
    personSummary: document.querySelector('#pc-summary')?.textContent || '',
    personKnownFor: [...document.querySelectorAll('#pc-known-list li')].map(li => li.textContent).join(' / '),
    personImage: !document.querySelector('#pc-hero-img')?.hidden,
    closeHidden: getComputedStyle(document.querySelector('#pc-exit-btn')).opacity === '0',
    brand: document.querySelector('#agent-brand-name')?.textContent || '',
  }))

  if (!snapshot.d3) throw new Error('d3 global missing')
  if (snapshot.nodes < 2) throw new Error(`expected at least 2 graph nodes, saw ${snapshot.nodes}`)
  if (!snapshot.acuiHost) throw new Error('ACUI host was not bootstrapped')
  if (!snapshot.personCard.includes('马云')) throw new Error('person card did not render the requested person')
  if (!snapshot.personSummary.includes('阿里巴巴集团创始人')) throw new Error('person card did not absorb assistant summary')
  if (!snapshot.personKnownFor.includes('淘宝')) throw new Error('person card did not absorb assistant known-for items')
  if (!snapshot.personImage) throw new Error('person card hero image was not visible')
  if (!snapshot.closeHidden) throw new Error('person card close button should be hidden until hover')
  await page.hover('.pc-card')
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#pc-exit-btn')).opacity) > 0.5)
  await page.click('#pc-exit-btn')
  const leavingSeen = await page.waitForFunction(() => document.querySelector('#person-card-panel')?.classList.contains('pc-leaving'), null, { timeout: 1000 })
  if (!leavingSeen) throw new Error('person card did not use the leaving glitch state')
  await page.waitForFunction(() => !document.body.classList.contains('person-card-mode') && !document.querySelector('#person-card-panel')?.classList.contains('pc-visible'))
  await page.fill('#msg-input', '帮我写一个项目介绍')
  await page.click('#send-btn')
  await page.waitForTimeout(1300)
  const falsePersonCard = await page.evaluate(() =>
    document.body.classList.contains('person-card-mode')
    || document.querySelector('#person-card-panel')?.classList.contains('pc-visible'))
  if (falsePersonCard) throw new Error('person card opened for a non-person introduction request')
  if (errors.length) throw new Error(`browser errors:\n${errors.join('\n')}`)

  console.log('[PASS] brain-ui smoke')
  console.log(JSON.stringify(snapshot, null, 2))
} finally {
  await browser.close()
  server.closeAllSse()
  await new Promise(resolve => server.close(resolve))
}
