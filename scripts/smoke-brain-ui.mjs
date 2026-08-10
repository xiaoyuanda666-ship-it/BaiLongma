import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const brainUiRoot = path.join(root, 'src', 'ui', 'brain-ui')
const browserPreviewFixture = process.env.BRAIN_UI_PREVIEW_IMAGE
  ? path.resolve(process.env.BRAIN_UI_PREVIEW_IMAGE)
  : path.join(root, 'build', 'icon.png')
const browserPreviewDelayMs = Math.max(
  0,
  Number(process.env.BRAIN_UI_PREVIEW_DELAY_MS || 220) || 0,
)

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.png': return 'image/png'
    default: return 'text/plain; charset=utf-8'
  }
}

function sendJson(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readJsonRequest(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) }
      catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
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
  const brainUiEvents = []
  let conversations = []
  const persistedTypes = new Set([
    'message_received', 'tick', 'scheduled_task', 'scheduled_task_completed', 'scheduled_task_retry', 'scheduled_task_failed',
    'stream_start', 'stream_end', 'tool_preparing', 'tool_executing', 'tool_call',
    'response', 'processing_preempted', 'llm_retry', 'message_requeued', 'message_dropped',
    'error', 'protocol_violation',
  ])
  let brainUiPath = null
  let heartbeatCount = 0
  const settingsRequests = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')

    if (url.pathname === '/brain-ui' || url.pathname === '/brain-ui.html' || url.pathname === '/') {
      sendFile(res, path.join(root, 'brain-ui.html'))
      return
    }

    if (url.pathname === '/activation' || url.pathname === '/activation.html') {
      sendFile(res, path.join(root, 'activation.html'))
      return
    }

    if (url.pathname === '/electron/startup.html') {
      sendFile(res, path.join(root, 'electron', 'startup.html'))
      return
    }

    if (url.pathname === '/focus-banner' || url.pathname === '/focus-banner.html') {
      sendFile(res, path.join(root, 'focus-banner.html'))
      return
    }

    if (url.pathname === '/turn-trace' || url.pathname === '/turn-trace.html') {
      sendFile(res, path.join(root, 'turn-trace.html'))
      return
    }

    if (url.pathname === '/activation-status') {
      sendJson(res, { activated: false })
      return
    }

    if (url.pathname === '/vendor/d3/d3.min.js') {
      sendFile(res, path.join(root, 'node_modules', 'd3', 'dist', 'd3.min.js'))
      return
    }

    if (url.pathname === '/site-assets/browser-preview.png') {
      if (browserPreviewDelayMs > 0) {
        setTimeout(() => sendFile(res, browserPreviewFixture), browserPreviewDelayMs)
      } else {
        sendFile(res, browserPreviewFixture)
      }
      return
    }

    if (url.pathname === '/site-assets/icon.png') {
      sendFile(res, path.join(root, 'build', 'icon.png'))
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

    if (url.pathname.startsWith('/src/ui/scene-shell/')) {
      const sceneShellRoot = path.join(root, 'src', 'ui', 'scene-shell')
      const relativePath = decodeURIComponent(url.pathname.slice('/src/ui/scene-shell/'.length))
      const assetPath = path.resolve(sceneShellRoot, relativePath)
      if (!isPathInside(sceneShellRoot, assetPath)) {
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

    if (url.pathname === '/admin/traces') {
      sendJson(res, { ok: true, traces: [] })
      return
    }

    if (url.pathname === '/memories') {
      sendJson(res, Array.from({ length: 64 }, (_, index) => ({
        id: index + 1,
        mem_id: `m${index + 1}`,
        type: index % 3 === 0 ? 'preference' : 'fact',
        content: `Smoke memory ${index + 1}`,
        detail: `Graph layout smoke node ${index + 1}`,
        created_at: new Date(Date.now() - index * 60_000).toISOString(),
      })))
      return
    }

    if (url.pathname === '/conversations') {
      const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '60', 10)
      const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 60, 500))
      const beforeId = Number.parseInt(url.searchParams.get('before_id') || '', 10)
      const page = conversations
        .filter(row => !Number.isFinite(beforeId) || Number(row.id) < beforeId)
        .sort((left, right) => Number(left.id) - Number(right.id))
        .slice(-limit)
      sendJson(res, page)
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

    if (url.pathname === '/knowledge/regions') {
      sendJson(res, { ok: true, regions: [{ id: 'smoke-docs', name: '发布资料', description: 'Smoke 知识脑区文档' }] })
      return
    }

    if (url.pathname === '/knowledge/documents') {
      sendJson(res, { ok: true, documents: [{ id: 1, title: '发布验证手册', version: 2, mime_type: 'text/markdown', region_id: 'smoke-docs' }] })
      return
    }

    if (url.pathname === '/knowledge/documents/1') {
      sendJson(res, { ok: true, document: { id: 1, title: '发布验证手册', version: 2, mime_type: 'text/markdown', region_id: 'smoke-docs', region_name: '发布资料', source_uri: 'file:///smoke/release.md' } })
      return
    }

    if (url.pathname === '/knowledge/search') {
      sendJson(res, { ok: true, count: 1, hits: [{ document_id: 1, document_title: '发布验证手册', text: '发布前需执行签名、安装和回归验证。', citation_id: 'K:1:1', retrieval_method: 'fts' }] })
      return
    }

    if (url.pathname === '/knowledge-panel-state') {
      sendJson(res, { ok: true, state: { active: true } })
      return
    }

    if (url.pathname === '/social/wechat-clawbot/qr') {
      sendJson(res, { ok: true, qr: null, status: 'unavailable' })
      return
    }

    if (url.pathname === '/events/history') {
      sendJson(res, { ok: true, events: brainUiEvents.slice(-160), heartbeatCount })
      return
    }

    if (req.method === 'GET' && url.pathname === '/settings') {
      sendJson(res, {
        agent_name: 'SmokeLongma',
        llm: {
          activated: true,
          provider: 'deepseek',
          model: 'deepseek-chat',
          baseURL: 'https://api.deepseek.com',
          models: [],
          temperature: 0.5,
          thinking: false,
          contextWindow: { chatMessageLimit: 20, toolCallLimit: 5 },
          apiKey: '',
        },
        providers: {
          deepseek: {
            label: 'DeepSeek',
            defaultModel: 'deepseek-chat',
            model: 'deepseek-chat',
            models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }],
            apiKey: '',
          },
        },
        minimax: { configured: false },
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/settings/temperature') {
      readJsonRequest(req).then(body => {
        const temperature = Number(body.temperature)
        settingsRequests.push({ pathname: url.pathname, body: { temperature } })
        sendJson(res, { ok: true, temperature })
      }).catch(error => {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: error.message }))
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/settings/voice') {
      sendJson(res, { ok: true, voice: { voiceProvider: 'local' } })
      return
    }

    if (req.method === 'GET' && url.pathname === '/settings/tts') {
      sendJson(res, { ok: true, tts: { ttsProvider: 'doubao' }, voices: {} })
      return
    }

    if (req.method === 'GET' && url.pathname === '/settings/map') {
      sendJson(res, {
        ok: true,
        map: { configured: true, keyConfigured: true, securityConfigured: true },
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/settings/map') {
      readJsonRequest(req).then(body => {
        settingsRequests.push({ pathname: url.pathname, body })
        sendJson(res, {
          ok: true,
          map: { configured: true, keyConfigured: true, securityConfigured: true },
        })
      }).catch(error => {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: error.message }))
      })
      return
    }

    if (url.pathname === '/settings/heartbeat') {
      sendJson(res, {
        ok: true,
        heartbeat: {
          enabled: true,
          defaultIntervalMinutes: 20,
          defaultIntervalMs: 20 * 60 * 1000,
          updatedAt: null,
        },
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
  server.setConversations = (rows) => {
    conversations = Array.isArray(rows) ? rows : []
  }
  server.settingsRequests = settingsRequests
  server.emitSse = (event) => {
    if (event?.type === 'message_received') brainUiPath = 'l1'
    if (event?.type === 'tick') {
      brainUiPath = 'l2'
      heartbeatCount += 1
    }
    if (event?.type === 'scheduled_task') brainUiPath = 'l3'
    if ((brainUiPath === 'l1' || brainUiPath === 'l2' || brainUiPath === 'l3') && persistedTypes.has(event?.type)) {
      brainUiEvents.push({ ...event, path: brainUiPath })
      if (brainUiEvents.length > 800) brainUiEvents.shift()
    }
    if (['response', 'processing_preempted', 'message_dropped', 'protocol_violation'].includes(event?.type)) {
      brainUiPath = null
    }
    for (const client of sseClients) {
      try { client.write(`data: ${JSON.stringify(event)}\n\n`) } catch {}
    }
  }
  server.emitTransientSse = (event) => {
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
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined
const browser = await chromium.launch(executablePath ? { executablePath } : {})
const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
await page.addInitScript(() => {
  localStorage.setItem('bailongma-memory-graph-enabled', 'true')
  localStorage.setItem('bailongma-ui-language', 'zh-CN')
})
const errors = []
page.on('pageerror', err => errors.push(err.message))
page.on('console', msg => {
  if (msg.text().includes('/acui') && msg.text().includes('WebSocket connection')) return
  if (msg.text().includes("/scene") && msg.text().includes('WebSocket connection')) return
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
  await page.waitForSelector('#heartbeat-state[data-state="alive"]')
  await page.waitForFunction(() => document.querySelector('#heartbeat-state-label')?.textContent === '20 分钟')
  await page.evaluate(() => document.fonts.ready)

  const closedPhysicsLayout = await page.evaluate(() => ({
    controlHeight: document.querySelector('#physics-control')?.offsetHeight,
    actionsHeight: document.querySelector('.panel-actions')?.offsetHeight,
  }))
  await page.click('#physics-toggle')
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#physics-panel')).opacity === '1')
  const openPhysicsLayout = await page.evaluate(() => {
    const toggle = document.querySelector('#physics-toggle')?.getBoundingClientRect()
    const panel = document.querySelector('#physics-panel')?.getBoundingClientRect()
    const panelStyle = getComputedStyle(document.querySelector('#physics-panel'))
    return {
      controlHeight: document.querySelector('#physics-control')?.offsetHeight,
      actionsHeight: document.querySelector('.panel-actions')?.offsetHeight,
      opensUpward: panel?.bottom <= toggle?.top && panel?.top < toggle?.top,
      floating: panelStyle.position === 'absolute',
      interactive: panelStyle.pointerEvents === 'auto',
    }
  })
  if (Math.abs(openPhysicsLayout.controlHeight - closedPhysicsLayout.controlHeight) > 0.5
    || Math.abs(openPhysicsLayout.actionsHeight - closedPhysicsLayout.actionsHeight) > 0.5
    || !openPhysicsLayout.opensUpward
    || !openPhysicsLayout.floating
    || !openPhysicsLayout.interactive) {
    throw new Error(`graph controls must float upward without changing layout: ${JSON.stringify({ closedPhysicsLayout, openPhysicsLayout })}`)
  }
  await page.click('#physics-toggle')

  await page.click('#settings-btn')
  await page.waitForSelector('#settings-overlay:not([hidden])')
  await page.waitForFunction(() => document.querySelector('#settings-temperature')?.value === '0.5')
  const manualSaveButtons = await page.$$eval('#settings-overlay button', buttons => buttons
    .map(button => button.textContent.trim())
    .filter(text => /^保存(?:$|所有|心跳|地图)/.test(text)))
  if (manualSaveButtons.length > 0) {
    throw new Error(`settings still expose manual save buttons: ${manualSaveButtons.join(', ')}`)
  }
  const autosaveHeader = await page.textContent('#settings-autosave-status-text')
  if (autosaveHeader !== '所有更改自动保存') {
    throw new Error(`settings autosave status missing: ${autosaveHeader}`)
  }
  await page.evaluate(() => {
    const slider = document.querySelector('#settings-temperature')
    slider.value = '0.65'
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    slider.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.waitForFunction(() => (
    document.querySelector('#settings-autosave-status')?.dataset.state === 'saved'
    && document.querySelector('#settings-autosave-status-text')?.textContent === '已自动保存'
  ))
  const temperatureRequest = server.settingsRequests.find(request => (
    request.pathname === '/settings/temperature'
    && request.body.temperature === 0.65
  ))
  if (!temperatureRequest) throw new Error('temperature change was not auto-saved')

  await page.click('.settings-nav-item[data-tab="advanced"]')
  await page.fill('#settings-amap-key', 'smoke-amap-key')
  await page.click('#settings-amap-key-toggle')
  await page.waitForFunction(() => (
    document.querySelector('#settings-autosave-status')?.dataset.state === 'saved'
    && document.querySelector('#settings-amap-key')?.value === 'smoke-amap-key'
  ))
  const mapSecretState = await page.evaluate(() => {
    const toggles = [...document.querySelectorAll('.settings-secret-toggle')]
    const mapInput = document.querySelector('#settings-amap-key')
    const mapToggle = document.querySelector('#settings-amap-key-toggle')
    const iconStyle = getComputedStyle(mapToggle, '::before')
    return {
      allIconsAreTextless: toggles.every(toggle => toggle.textContent.trim() === ''),
      mapValueRetained: mapInput?.value === 'smoke-amap-key',
      mapValueVisible: mapInput?.type === 'text',
      openEyeState: mapToggle?.dataset.visible === 'true',
      monochromeMaskIcon: iconStyle.backgroundColor === getComputedStyle(mapToggle).color
        && iconStyle.webkitMaskImage !== 'none',
    }
  })
  const failedMapSecretChecks = Object.entries(mapSecretState)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)
  if (failedMapSecretChecks.length > 0) {
    throw new Error(`map secret field failed (${failedMapSecretChecks.join(', ')}): ${JSON.stringify(mapSecretState)}`)
  }
  await page.click('#settings-amap-key-toggle')
  const mapSecretClosedState = await page.evaluate(() => ({
    inputType: document.querySelector('#settings-amap-key')?.type,
    visible: document.querySelector('#settings-amap-key-toggle')?.dataset.visible,
  }))
  if (mapSecretClosedState.inputType !== 'password' || mapSecretClosedState.visible !== 'false') {
    throw new Error(`map secret did not return to closed-eye password state: ${JSON.stringify(mapSecretClosedState)}`)
  }
  const mapRequest = server.settingsRequests.find(request => (
    request.pathname === '/settings/map'
    && request.body.jsKey === 'smoke-amap-key'
  ))
  if (!mapRequest) throw new Error('map key was not auto-saved')
  await page.click('#settings-close')

  await page.evaluate(() => {
    window.__pttSmoke = { start: 0, end: 0 }
    window.bailongmaVoice.pttStart = () => { window.__pttSmoke.start += 1 }
    window.bailongmaVoice.pttEnd = () => { window.__pttSmoke.end += 1 }
  })
  await page.focus('#msg-input')
  await page.keyboard.down('Space')
  const heldPttState = await page.evaluate(() => ({
    ...window.__pttSmoke,
    activeClass: document.body.classList.contains('ptt-active'),
    value: document.querySelector('#msg-input')?.value,
  }))
  if (heldPttState.start !== 1 || heldPttState.end !== 0 || !heldPttState.activeClass || heldPttState.value !== '') {
    throw new Error(`empty focused message input did not start PTT: ${JSON.stringify(heldPttState)}`)
  }
  await page.keyboard.up('Space')
  const releasedPttState = await page.evaluate(() => ({
    ...window.__pttSmoke,
    activeClass: document.body.classList.contains('ptt-active'),
  }))
  if (releasedPttState.start !== 1 || releasedPttState.end !== 1 || releasedPttState.activeClass) {
    throw new Error(`PTT did not release cleanly: ${JSON.stringify(releasedPttState)}`)
  }
  await page.fill('#msg-input', '正常输入')
  await page.keyboard.press('Space')
  const typedSpaceState = await page.evaluate(() => ({
    ...window.__pttSmoke,
    value: document.querySelector('#msg-input')?.value,
  }))
  if (typedSpaceState.start !== 1 || typedSpaceState.end !== 1 || typedSpaceState.value !== '正常输入 ') {
    throw new Error(`Space in a non-empty message input did not remain text: ${JSON.stringify(typedSpaceState)}`)
  }
  await page.fill('#msg-input', '')
  await page.evaluate(() => {
    localStorage.setItem('bailongma-voice-space-ptt-enabled', 'false')
    window.dispatchEvent(new CustomEvent('bailongma:space-ptt-change', { detail: { enabled: false } }))
  })
  await page.keyboard.press('Space')
  const disabledPttState = await page.evaluate(() => ({
    ...window.__pttSmoke,
    value: document.querySelector('#msg-input')?.value,
    placeholder: document.querySelector('#msg-input')?.placeholder,
  }))
  if (disabledPttState.start !== 1 || disabledPttState.end !== 1 || disabledPttState.value !== ' ' || /空格键/.test(disabledPttState.placeholder)) {
    throw new Error(`disabled Space PTT did not restore normal typing: ${JSON.stringify(disabledPttState)}`)
  }
  await page.evaluate(() => {
    localStorage.setItem('bailongma-voice-space-ptt-enabled', 'true')
    window.dispatchEvent(new CustomEvent('bailongma:space-ptt-change', { detail: { enabled: true } }))
  })
  await page.fill('#msg-input', '')
  await page.click('#chat-pin-button')
  await page.mouse.move(0, 0)
  await page.waitForTimeout(180)
  const pinnedChatState = await page.evaluate(() => ({
    pressed: document.querySelector('#chat-pin-button')?.getAttribute('aria-pressed'),
    pinned: document.querySelector('#chat-area')?.classList.contains('chat-pinned'),
    open: document.querySelector('#chat-history')?.classList.contains('open'),
    stored: localStorage.getItem('bailongma-chat-pinned'),
  }))
  if (pinnedChatState.pressed !== 'true' || !pinnedChatState.pinned || !pinnedChatState.open || pinnedChatState.stored !== '1') {
    throw new Error(`chat pin did not keep history open: ${JSON.stringify(pinnedChatState)}`)
  }
  await page.click('#chat-pin-button')
  await page.mouse.move(0, 0)
  await page.waitForTimeout(180)
  const unpinnedChatState = await page.evaluate(() => ({
    pressed: document.querySelector('#chat-pin-button')?.getAttribute('aria-pressed'),
    pinned: document.querySelector('#chat-area')?.classList.contains('chat-pinned'),
    open: document.querySelector('#chat-history')?.classList.contains('open'),
    stored: localStorage.getItem('bailongma-chat-pinned'),
  }))
  if (unpinnedChatState.pressed !== 'false' || unpinnedChatState.pinned || unpinnedChatState.open || unpinnedChatState.stored !== '0') {
    throw new Error(`chat did not restore auto-collapse after unpinning: ${JSON.stringify(unpinnedChatState)}`)
  }
  server.setConversations(Array.from({ length: 145 }, (_, index) => ({
    id: index + 1,
    role: index % 2 === 0 ? 'user' : 'jarvis',
    content: `滚动位置回归消息 ${index + 1}：用户阅读较早聊天记录时，后台历史同步不能把视图拉回底部。`,
    channel: 'TUI',
    timestamp: `2026-07-30T${String(8 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00+08:00`,
  })))
  let historySyncResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/conversations')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await historySyncResponse
  await page.waitForFunction(() => document.querySelectorAll('#chat-messages .msg').length === 60)
  const visibleMessageTimes = await page.locator('#chat-messages .msg-time').allTextContents()
  if (visibleMessageTimes.length !== 60 || visibleMessageTimes[0] !== '09:25' || visibleMessageTimes.at(-1) !== '10:24') {
    throw new Error(`chat history timestamps were not rendered: ${JSON.stringify(visibleMessageTimes.slice(0, 2))}`)
  }
  const historyScrollBeforeSync = await page.evaluate(async () => {
    const history = document.querySelector('#chat-history')
    const messages = document.querySelector('#chat-messages')
    history.classList.add('open')
    await new Promise(resolve => setTimeout(resolve, 700))
    if (messages.scrollHeight <= messages.clientHeight) {
      throw new Error(`chat history did not overflow: ${messages.scrollHeight}/${messages.clientHeight}`)
    }
    messages.scrollTop = Math.max(0, messages.scrollHeight - messages.clientHeight - 200)
    return messages.scrollTop
  })
  historySyncResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/conversations')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await historySyncResponse
  await page.waitForTimeout(50)
  const historyScrollAfterSync = await page.locator('#chat-messages').evaluate(element => element.scrollTop)
  if (Math.abs(historyScrollAfterSync - historyScrollBeforeSync) > 1) {
    throw new Error(`chat history sync changed the reader's scroll position: ${historyScrollBeforeSync} -> ${historyScrollAfterSync}`)
  }

  const firstOlderPageResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/conversations' && url.searchParams.get('before_id') === '86'
  })
  const firstAnchorTop = await page.evaluate(() => {
    const messages = document.querySelector('#chat-messages')
    messages.scrollTop = 0
    return document.querySelector('[data-message-id="86"]').getBoundingClientRect().top
  })
  await firstOlderPageResponse
  await page.waitForFunction(() => document.querySelectorAll('#chat-messages .msg').length === 120)
  const firstPageState = await page.evaluate(() => ({
    firstId: document.querySelector('#chat-messages .msg')?.dataset.messageId,
    anchorTop: document.querySelector('[data-message-id="86"]')?.getBoundingClientRect().top,
    scrollTop: document.querySelector('#chat-messages')?.scrollTop,
  }))
  if (firstPageState.firstId !== '26' || Math.abs(firstPageState.anchorTop - firstAnchorTop) > 1 || firstPageState.scrollTop <= 0) {
    throw new Error(`first lazy history page did not preserve the viewport: ${JSON.stringify({ firstAnchorTop, ...firstPageState })}`)
  }

  const secondOlderPageResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/conversations' && url.searchParams.get('before_id') === '26'
  })
  const secondAnchorTop = await page.evaluate(() => {
    const messages = document.querySelector('#chat-messages')
    messages.scrollTop = 0
    return document.querySelector('[data-message-id="26"]').getBoundingClientRect().top
  })
  await secondOlderPageResponse
  await page.waitForFunction(() => document.querySelectorAll('#chat-messages .msg').length === 145)
  const secondPageState = await page.evaluate(() => ({
    firstId: document.querySelector('#chat-messages .msg')?.dataset.messageId,
    anchorTop: document.querySelector('[data-message-id="26"]')?.getBoundingClientRect().top,
    scrollTop: document.querySelector('#chat-messages')?.scrollTop,
  }))
  if (secondPageState.firstId !== '1' || Math.abs(secondPageState.anchorTop - secondAnchorTop) > 1 || secondPageState.scrollTop <= 0) {
    throw new Error(`second lazy history page did not preserve the viewport: ${JSON.stringify({ secondAnchorTop, ...secondPageState })}`)
  }
  server.setConversations([])
  const l2CardStyles = await page.evaluate(() => {
    const left = getComputedStyle(document.querySelector('#panel-l1'))
    const rail = getComputedStyle(document.querySelector('#panel-l2'))
    return {
      railOverflow: rail.overflow,
      left: {
        backgroundColor: left.backgroundColor,
        backgroundImage: left.backgroundImage,
        boxShadow: left.boxShadow,
        backdropFilter: left.backdropFilter,
      },
      cards: Array.from(document.querySelectorAll('#panel-l2 .l2-module')).map(element => {
        const visibleSurface = element.matches('.action-log-module')
          ? element.querySelector('.action-log-surface')
          : element.matches('.cognition-module')
            ? element.querySelector('.cognition-surface')
          : element
        const style = getComputedStyle(visibleSurface)
        return {
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          boxShadow: style.boxShadow,
          backdropFilter: style.backdropFilter,
        }
      }),
    }
  })
  if (l2CardStyles.cards.length !== 3) throw new Error(`expected 3 L2 cards, got ${l2CardStyles.cards.length}`)
  if (l2CardStyles.railOverflow !== 'visible') {
    throw new Error(`L2 rail clips card shadows: overflow is ${l2CardStyles.railOverflow}`)
  }
  if (l2CardStyles.cards.some(style => JSON.stringify(style) !== JSON.stringify(l2CardStyles.left))) {
    throw new Error(`L2 card surface styles do not match L1: ${JSON.stringify(l2CardStyles)}`)
  }
  server.emitSse({
    type: 'heartbeat_settings_updated',
    data: { enabled: true, defaultIntervalMinutes: 45, defaultIntervalMs: 45 * 60 * 1000 },
    ts: new Date().toISOString(),
  })
  await page.waitForFunction(() => document.querySelector('#heartbeat-state-label')?.textContent === '45 分钟')
  const heartbeatChartHeight = await page.locator('#heartbeat-chart').evaluate(element => element.getBoundingClientRect().height)
  if (heartbeatChartHeight < 92) throw new Error(`heartbeat chart is too short: ${heartbeatChartHeight}px`)
  await page.waitForSelector('.heartbeat-monitor:not([data-beat])')
  await page.evaluate(() => {
    window.__memoryTwitchHeartbeatSeen = false
    const monitor = document.querySelector('.heartbeat-monitor')
    new MutationObserver(() => {
      if (monitor?.dataset.beat === 'medium') window.__memoryTwitchHeartbeatSeen = true
    }).observe(monitor, { attributes: true, attributeFilter: ['data-beat'] })
  })
  await page.waitForTimeout(10_000)
  if (await page.evaluate(() => window.__memoryTwitchHeartbeatSeen)) {
    throw new Error('memory graph twitch must not trigger the heartbeat chart')
  }
  const idleHeartbeatPath = await page.locator('#heartbeat-wave').getAttribute('d')
  server.emitSse({ type: 'tool_executing', data: { name: 'read_file' }, ts: new Date().toISOString() })
  await page.waitForSelector('.heartbeat-monitor[data-beat="minor"]')
  await page.waitForFunction(() => {
    const values = document.querySelector('#heartbeat-wave')?.getAttribute('d')?.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || []
    const yValues = values.filter((_, index) => index % 2 === 1)
    return yValues.some(y => Math.abs(y - 36) > 19)
  })
  const countBeforeLongToolPulse = await page.locator('#heartbeat-count').textContent()
  await page.waitForSelector('.heartbeat-monitor:not([data-beat])')
  await page.waitForSelector('.heartbeat-monitor[data-beat="minor"]', { timeout: 3500 })
  if (await page.locator('#heartbeat-count').textContent() !== countBeforeLongToolPulse) {
    throw new Error('periodic tool pulse must not increment the L2 heartbeat count')
  }
  server.emitSse({ type: 'tool_call', data: { name: 'read_file', args: {}, result: 'done', ok: true }, ts: new Date().toISOString() })
  await page.waitForSelector('.heartbeat-monitor:not([data-beat])')
  await page.waitForTimeout(3200)
  if (await page.locator('.heartbeat-monitor').getAttribute('data-beat') !== null) {
    throw new Error('periodic tool pulse must stop after tool completion')
  }
  server.emitSse({ type: 'tick', data: { label: 'TICK' }, ts: new Date().toISOString() })
  await page.waitForSelector('.heartbeat-monitor[data-beat="major"]')
  await page.waitForFunction(() => {
    const values = document.querySelector('#heartbeat-wave')?.getAttribute('d')?.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || []
    const yValues = values.filter((_, index) => index % 2 === 1)
    return yValues.some(y => Math.abs(y - 36) > 24)
  })
  await page.waitForFunction(() => document.body.classList.contains('model-thinking'))
  const thinkingCanvasStyle = await page.locator('.voice-canvas-card').evaluate(element => {
    const style = getComputedStyle(element)
    const canvas = element.querySelector('#voice-canvas')
    const frameRect = element.getBoundingClientRect()
    const canvasRect = canvas.getBoundingClientRect()
    return {
      borderRadius: style.borderRadius,
      borderColor: style.borderColor,
      animationName: style.animationName,
      frameWidth: frameRect.width,
      canvasWidth: canvasRect.width,
      canvasBorderWidth: getComputedStyle(canvas).borderWidth,
    }
  })
  if (thinkingCanvasStyle.borderRadius !== '18px') throw new Error(`voice canvas card radius mismatch: ${thinkingCanvasStyle.borderRadius}`)
  if (thinkingCanvasStyle.animationName !== 'voice-card-thinking-glow') throw new Error('voice canvas thinking glow is not active')
  if (thinkingCanvasStyle.frameWidth <= thinkingCanvasStyle.canvasWidth) throw new Error('voice canvas card must sit outside the canvas')
  if (thinkingCanvasStyle.canvasBorderWidth !== '0px') throw new Error('voice canvas must not own the card border')
  await page.waitForFunction(previousPath => (
    document.querySelector('#heartbeat-wave')?.getAttribute('d') !== previousPath
  ), idleHeartbeatPath)
  server.emitSse({ type: 'stream_start', data: { mode: 'thinking' }, ts: new Date().toISOString() })
  server.emitSse({ type: 'tool_preparing', data: { name: 'read_file' }, ts: new Date().toISOString() })
  server.emitSse({ type: 'tool_executing', data: { name: 'read_file' }, ts: new Date().toISOString() })
  await page.waitForSelector('.heartbeat-monitor[data-beat="minor"]')
  await page.waitForFunction(() => !document.body.classList.contains('model-thinking'))
  server.emitSse({ type: 'tool_call', data: { name: 'read_file', args: { path: 'src/example.js' }, result: 'smoke file', ok: true }, ts: new Date().toISOString() })
  server.emitSse({ type: 'stream_start', data: { mode: 'thinking' }, ts: new Date().toISOString() })
  await page.waitForFunction(() => document.body.classList.contains('model-thinking'))
  server.emitSse({ type: 'response', data: {}, ts: new Date().toISOString() })
  await page.waitForFunction(() =>
    document.querySelector('#heartbeat-count')?.textContent === '1'
    && document.querySelector('#action-log')?.textContent.includes('读取文件 · src/example.js')
    && document.querySelector('#cognition-state')?.dataset.state === 'done'
    && !document.body.classList.contains('model-thinking')
    && Boolean(document.querySelector('#heartbeat-wave')?.getAttribute('d')))
  await page.waitForSelector('.heartbeat-monitor:not([data-beat])')
  server.emitSse({ type: 'message_received', data: { input: '请更新配置文件' }, ts: new Date().toISOString() })
  await page.waitForSelector('.heartbeat-monitor[data-beat="major"]')
  if (await page.locator('#heartbeat-count').textContent() !== '1') {
    throw new Error('L1 message pulse must not increment the L2 heartbeat count')
  }
  server.emitSse({ type: 'stream_start', data: { mode: 'thinking' }, ts: new Date().toISOString() })
  server.emitSse({ type: 'tool_preparing', data: { name: 'write_file' }, ts: new Date().toISOString() })
  server.emitSse({ type: 'tool_executing', data: { name: 'write_file' }, ts: new Date().toISOString() })
  server.emitSse({ type: 'tool_call', data: { name: 'write_file', args: { path: 'src/config-demo.js' }, result: '{"ok":true}', ok: true }, ts: new Date().toISOString() })
  await page.waitForFunction(() =>
    document.querySelector('#action-log')?.textContent.includes('写入文件 · src/config-demo.js')
    && document.querySelector('#si-l1')?.textContent.includes('请更新配置文件')
    && document.querySelector('#si-l1')?.textContent.includes('写入文件'))

  server.emitSse({
    type: 'command_run',
    data: {
      run_id: 'cmd_smoke_command_ui',
      state: 'running',
      pid: 43210,
      command: 'node smoke-command.js',
      started_at: new Date().toISOString(),
    },
    ts: new Date().toISOString(),
  })
  server.emitSse({
    type: 'command_output',
    data: { run_id: 'cmd_smoke_command_ui', pid: 43210, sequence: 1, stream: 'stdout', text: 'smoke output\n' },
    ts: new Date().toISOString(),
  })
  await page.waitForFunction(() => {
    const card = document.querySelector('#command-runs .command-run[data-state="running"]')
    return !document.querySelector('#command-runs')?.hidden
      && card?.textContent.includes('node smoke-command.js')
      && card?.textContent.includes('smoke output')
      && card?.textContent.includes('运行中')
  })
  // Replayed output records must not be duplicated after an SSE reconnect.
  server.emitSse({
    type: 'command_output',
    data: { run_id: 'cmd_smoke_command_ui', pid: 43210, sequence: 1, stream: 'stdout', text: 'smoke output\n' },
    ts: new Date().toISOString(),
  })
  server.emitSse({
    type: 'command_run',
    data: { run_id: 'cmd_smoke_command_ui', state: 'completed', pid: 43210, exit_code: 0 },
    ts: new Date().toISOString(),
  })
  await page.waitForFunction(() => {
    const card = document.querySelector('#command-runs .command-run[data-state="completed"]')
    return card?.textContent.includes('已完成')
      && (card?.textContent.match(/smoke output/g) || []).length === 1
  })

  // Electron uses a native WebContentsView rather than downloading the preview
  // screenshot. Keep this as a second page so the regular-browser fallback below
  // continues to exercise image loading independently.
  const nativePage = await browser.newPage({ viewport: { width: 1280, height: 840 } })
  let nativePreviewAssetRequests = 0
  nativePage.on('request', request => {
    if (new URL(request.url()).pathname === '/site-assets/browser-preview.png') {
      nativePreviewAssetRequests += 1
    }
  })
  await nativePage.addInitScript(() => {
    localStorage.setItem('bailongma-ui-language', 'zh-CN')
    const calls = []
    window.__browserEmbedCalls = calls
    window.bailongma = {
      isElectron: true,
      platform: 'darwin',
      getZoomFactor: () => 1.1,
      setZoomFactor: () => {},
      browserEmbed: {
        update(payload) {
          calls.push({ method: 'update', payload: structuredClone(payload) })
          return Promise.resolve({ ok: true })
        },
        hide() {
          calls.push({ method: 'hide' })
          return Promise.resolve({ ok: true })
        },
        getState() {
          calls.push({ method: 'getState' })
          return Promise.resolve({ visible: false })
        },
      },
    }
  })
  await nativePage.goto(`${baseUrl}/brain-ui`, { waitUntil: 'domcontentloaded' })
  await nativePage.waitForSelector('#heartbeat-state[data-state="alive"]')
  await nativePage.waitForFunction(() => (
    !document.querySelector('#music-btn')
    && !document.querySelector('#music-panel')
  ))
  await nativePage.waitForFunction(() => (
    window.__browserEmbedCalls?.some(call => call.method === 'hide')
    && window.__browserEmbedCalls?.some(call => call.method === 'getState')
  ))

  server.emitSse({
    type: 'tool_preparing',
    data: { name: 'browser_navigate', browser_display_mode: 'card' },
    ts: new Date().toISOString(),
  })
  await page.waitForFunction(() =>
    document.querySelector('#si-l1 .line-status')?.textContent === '准备打开网页…')
  await page.waitForFunction(() =>
    document.querySelector('#browser-preview')?.hidden
    && !document.querySelector('#action-log')?.hidden
    && !document.querySelector('.action-log-module')?.dataset.browserActive)
  await nativePage.waitForFunction(() =>
    document.querySelector('#browser-preview')?.hidden
    && !document.querySelector('#action-log')?.hidden
    && !document.querySelector('.action-log-module')?.dataset.browserActive)
  server.emitSse({
    type: 'tool_executing',
    data: { name: 'browser_navigate', browser_display_mode: 'card' },
    ts: new Date().toISOString(),
  })
  await page.waitForFunction(() =>
    document.querySelector('#si-l1 .line-status')?.textContent === '正在打开网页…')
  await page.waitForFunction(() =>
    document.querySelector('#browser-preview')?.hidden
    && !document.querySelector('#action-log')?.hidden
    && !document.querySelector('.action-log-module')?.dataset.browserActive)
  await nativePage.waitForFunction(() =>
    document.querySelector('#browser-preview')?.hidden
    && !document.querySelector('#action-log')?.hidden
    && !document.querySelector('.action-log-module')?.dataset.browserActive)
  server.emitSse({
    type: 'browser_preview',
    data: {
      mode: 'card',
      state: 'ready',
      action: 'browser_navigate',
      image_url: '/site-assets/browser-preview.png',
      revision: 'smoke-1',
      url: 'https://example.com/docs',
      title: 'Example Documentation',
    },
    ts: new Date().toISOString(),
  })
  await nativePage.waitForFunction(() => (
    document.querySelector('.action-log-module')?.dataset.browserPhase === 'browser'
  ))
  await nativePage.waitForFunction(() => {
    const moduleRect = document.querySelector('.action-log-module')?.getBoundingClientRect()
    const actionRect = document.querySelector('.action-log-surface')?.getBoundingClientRect()
    const browserRect = document.querySelector('#browser-preview')?.getBoundingClientRect()
    const nativeXs = (window.__browserEmbedCalls || [])
      .filter(call => call.method === 'update' && call.payload?.mode === 'card')
      .map(call => call.payload.bounds?.x)
      .filter(Number.isFinite)
    return Boolean(moduleRect && actionRect && browserRect)
      && actionRect.left < moduleRect.left
      && browserRect.left > moduleRect.left
      && nativeXs.length >= 2
      && nativeXs.at(-1) < nativeXs[0]
  }, null, { timeout: 1000 })
  const browserEntranceMotion = await nativePage.evaluate(() => {
    const moduleRect = document.querySelector('.action-log-module')?.getBoundingClientRect()
    const actionRect = document.querySelector('.action-log-surface')?.getBoundingClientRect()
    const browserRect = document.querySelector('#browser-preview')?.getBoundingClientRect()
    const nativeXs = (window.__browserEmbedCalls || [])
      .filter(call => call.method === 'update' && call.payload?.mode === 'card')
      .map(call => call.payload.bounds?.x)
      .filter(Number.isFinite)
    return {
      moduleRect: moduleRect?.toJSON(),
      actionRect: actionRect?.toJSON(),
      browserRect: browserRect?.toJSON(),
      nativeXs,
    }
  })
  if (
    !browserEntranceMotion.moduleRect
    || browserEntranceMotion.actionRect.left >= browserEntranceMotion.moduleRect.left
    || browserEntranceMotion.browserRect.left <= browserEntranceMotion.moduleRect.left
    || browserEntranceMotion.nativeXs.length < 2
    || browserEntranceMotion.nativeXs.at(-1) >= browserEntranceMotion.nativeXs[0]
  ) {
    throw new Error(`browser/log entrance is not moving in opposite directions: ${JSON.stringify(browserEntranceMotion)}`)
  }
  if (browserPreviewDelayMs > 0) {
    await page.waitForTimeout(Math.min(100, Math.max(20, browserPreviewDelayMs / 2)))
    const prematurePreview = await page.evaluate(() => ({
      hidden: document.querySelector('#browser-preview')?.hidden,
      actionLogHidden: document.querySelector('#action-log')?.hidden,
      browserActive: document.querySelector('.action-log-module')?.dataset.browserActive || '',
    }))
    if (
      prematurePreview.hidden !== true
      || prematurePreview.actionLogHidden !== false
      || prematurePreview.browserActive
    ) {
      throw new Error(
        'browser preview became visible before its image finished loading: '
        + JSON.stringify(prematurePreview),
      )
    }
  }
  await nativePage.waitForFunction(() => (
    window.__browserEmbedCalls?.some(call => (
      call.method === 'update'
      && call.payload?.mode === 'card'
      && call.payload?.visible === true
    ))
  ))
  await nativePage.waitForFunction(() => (
    document.querySelector('.action-log-module')?.dataset.browserPhase === 'browser'
    && document.querySelector('#action-log')?.hidden === true
  ))
  const nativeBrowserPreview = await nativePage.evaluate(() => {
    const calls = window.__browserEmbedCalls || []
    const updates = calls.filter(call => call.method === 'update' && call.payload?.mode === 'card')
    const latest = updates.at(-1)?.payload
    const slot = document.querySelector('#browser-preview-native-slot')
    const rect = slot?.getBoundingClientRect()
    const slotStyle = slot ? getComputedStyle(slot) : null
    const previewStyle = getComputedStyle(document.querySelector('#browser-preview'))
    const radius = slotStyle ? parseFloat(slotStyle.borderTopLeftRadius) : 0
    const zoom = Number(window.bailongma?.getZoomFactor?.()) || 1
    return {
      calls,
      latest,
      expected: rect ? {
        x: Math.round(rect.left * zoom),
        y: Math.round(rect.top * zoom),
        width: Math.round(rect.width * zoom),
        height: Math.round(rect.height * zoom),
        radius: Math.round(radius * zoom),
      } : null,
      previewHidden: document.querySelector('#browser-preview')?.hidden,
      renderer: document.querySelector('#browser-preview')?.dataset.renderer,
      actionLogHidden: document.querySelector('#action-log')?.hidden,
      imageSrc: document.querySelector('#browser-preview-image')?.getAttribute('src'),
      slotBackground: slotStyle?.backgroundColor,
      slotBoxShadow: slotStyle?.boxShadow,
      bezelColor: previewStyle.borderTopColor,
    }
  })
  const nativeGeometry = nativeBrowserPreview.latest?.bounds
  if (
    nativeBrowserPreview.previewHidden
    || nativeBrowserPreview.renderer !== 'native'
    || nativeBrowserPreview.actionLogHidden !== true
    || nativeBrowserPreview.imageSrc
    || nativeBrowserPreview.latest?.interactive !== true
    || nativeBrowserPreview.latest?.url !== 'https://example.com/docs'
    || nativeBrowserPreview.slotBoxShadow !== 'none'
    || nativeBrowserPreview.slotBackground !== nativeBrowserPreview.bezelColor
    || nativeBrowserPreview.latest?.radius !== nativeBrowserPreview.expected?.radius
    || !nativeGeometry
    || Math.abs(nativeGeometry.x - nativeBrowserPreview.expected.x) > 1
    || Math.abs(nativeGeometry.y - nativeBrowserPreview.expected.y) > 1
    || Math.abs(nativeGeometry.width - nativeBrowserPreview.expected.width) > 1
    || Math.abs(nativeGeometry.height - nativeBrowserPreview.expected.height) > 1
  ) {
    throw new Error(`native browser embed geometry/state mismatch: ${JSON.stringify(nativeBrowserPreview)}`)
  }
  if (nativePreviewAssetRequests !== 0) {
    throw new Error(`native browser embed requested ${nativePreviewAssetRequests} screenshot assets`)
  }
  const nativeUpdateCountBeforeResize = await nativePage.evaluate(() => (
    window.__browserEmbedCalls?.filter(call => call.method === 'update' && call.payload?.mode === 'card').length || 0
  ))
  await nativePage.setViewportSize({ width: 1180, height: 840 })
  await nativePage.waitForFunction(previousCount => (
    (window.__browserEmbedCalls?.filter(call => (
      call.method === 'update' && call.payload?.mode === 'card'
    )).length || 0) > previousCount
  ), nativeUpdateCountBeforeResize)
  const resizedNativeGeometryMatches = await nativePage.evaluate(() => {
    const payload = window.__browserEmbedCalls
      ?.filter(call => call.method === 'update' && call.payload?.mode === 'card')
      .at(-1)?.payload
    const rect = document.querySelector('#browser-preview-native-slot')?.getBoundingClientRect()
    const zoom = Number(window.bailongma?.getZoomFactor?.()) || 1
    return Boolean(payload && rect)
      && Math.abs(payload.bounds.x - Math.round(rect.left * zoom)) <= 1
      && Math.abs(payload.bounds.y - Math.round(rect.top * zoom)) <= 1
      && Math.abs(payload.bounds.width - Math.round(rect.width * zoom)) <= 1
      && Math.abs(payload.bounds.height - Math.round(rect.height * zoom)) <= 1
  })
  if (!resizedNativeGeometryMatches) {
    throw new Error('native browser embed bounds did not follow ResizeObserver')
  }
  const translatedNativeX = await nativePage.evaluate(() => {
    const preview = document.querySelector('#browser-preview')
    if (preview) preview.style.transform = 'translateX(-5px)'
    const rect = document.querySelector('#browser-preview-native-slot')?.getBoundingClientRect()
    const zoom = Number(window.bailongma?.getZoomFactor?.()) || 1
    window.dispatchEvent(new Event('scroll'))
    return rect ? Math.round(rect.left * zoom) : null
  })
  await nativePage.waitForFunction(expectedX => (
    window.__browserEmbedCalls
      ?.filter(call => call.method === 'update' && call.payload?.mode === 'card')
      .at(-1)?.payload?.bounds?.x === expectedX
  ), translatedNativeX)
  const restoredNativeX = await nativePage.evaluate(() => {
    const preview = document.querySelector('#browser-preview')
    if (preview) preview.style.transform = ''
    const rect = document.querySelector('#browser-preview-native-slot')?.getBoundingClientRect()
    const zoom = Number(window.bailongma?.getZoomFactor?.()) || 1
    window.visualViewport?.dispatchEvent(new Event('scroll'))
    return rect ? Math.round(rect.left * zoom) : null
  })
  await nativePage.waitForFunction(expectedX => (
    window.__browserEmbedCalls
      ?.filter(call => call.method === 'update' && call.payload?.mode === 'card')
      .at(-1)?.payload?.bounds?.x === expectedX
  ), restoredNativeX)
  await page.waitForFunction(() => {
    const preview = document.querySelector('#browser-preview')
    const image = document.querySelector('#browser-preview-image')
    return preview
      && !preview.hidden
      && preview.dataset.state === 'ready'
      && image?.complete
      && image.naturalWidth > 0
      && document.querySelector('.action-log-module')?.dataset.browserPhase === 'browser'
      && document.querySelector('#action-log')?.hidden === true
  })
  const browserPreviewLayout = await page.evaluate(() => {
    const preview = document.querySelector('#browser-preview')
    const image = document.querySelector('#browser-preview-image')
    const module = document.querySelector('.action-log-module')
    const actionSurface = module?.querySelector('.action-log-surface')
    const head = actionSurface?.querySelector(':scope > .l2-module-head')
    const moduleRect = module?.getBoundingClientRect()
    const actionSurfaceRect = actionSurface?.getBoundingClientRect()
    const previewRect = preview?.getBoundingClientRect()
    const viewport = document.querySelector('.browser-preview-viewport')
    const viewportRect = viewport?.getBoundingClientRect()
    const imageRect = image?.getBoundingClientRect()
    const moduleStyle = getComputedStyle(module)
    const actionSurfaceStyle = getComputedStyle(actionSurface)
    const previewStyle = getComputedStyle(preview)
    const viewportStyle = getComputedStyle(viewport)
    return {
      metrics: {
        moduleBorder: moduleStyle.borderTopWidth,
        moduleRadius: moduleStyle.borderTopLeftRadius,
        moduleBackground: moduleStyle.backgroundColor,
        previewBorder: previewStyle.borderTopWidth,
        previewRadius: previewStyle.borderTopLeftRadius,
        previewShadow: previewStyle.boxShadow,
        cardBorderColor: actionSurfaceStyle.borderTopColor,
        viewportRadius: viewportStyle.borderTopLeftRadius,
        viewportShadow: viewportStyle.boxShadow,
        imageObjectFit: getComputedStyle(image).objectFit,
        imageMaxWidth: getComputedStyle(image).maxWidth,
        viewportOverflow: viewportStyle.overflow,
        moduleRect: moduleRect.toJSON(),
        actionSurfaceRect: actionSurfaceRect.toJSON(),
        previewRect: previewRect.toJSON(),
        viewportRect: viewportRect.toJSON(),
        imageRect: imageRect.toJSON(),
      },
      checks: {
        actionLogHidden: document.querySelector('#action-log')?.hidden === true,
        moduleActive: module?.dataset.browserActive === 'true',
        modulePaddingRemoved: moduleStyle.paddingTop === '0px',
        moduleBorderRemoved: moduleStyle.borderTopWidth === '0px',
        frameRadiusUnified: moduleStyle.borderTopLeftRadius === previewStyle.borderTopLeftRadius,
        moduleShellTransparent: moduleStyle.backgroundColor === 'rgba(0, 0, 0, 0)',
        actionSurfaceExitedLeft: actionSurfaceRect.right <= moduleRect.left + 1
          && parseFloat(actionSurfaceStyle.opacity) === 0
          && document.querySelector('#action-log')?.hidden === true,
        headingRetainedForReverseAnimation: getComputedStyle(head).display === 'flex',
        synchronizedSurfaceMotion: actionSurfaceStyle.transitionProperty.includes('transform')
          && previewStyle.transitionProperty.includes('transform')
          && actionSurfaceStyle.transitionDuration === previewStyle.transitionDuration,
        noBrowserChrome: !document.querySelector('#browser-preview-address')
          && !document.querySelector('.browser-preview-caption'),
        noLoadingUi: !document.querySelector('#browser-preview-placeholder')
          && !document.querySelector('.browser-preview-orbit')
          && !document.querySelector('.browser-preview-scanline'),
        frameUsesBorderBox: previewStyle.boxSizing === 'border-box',
        frameHasThickBorder: parseFloat(previewStyle.borderTopWidth) >= 8,
        frameOutlineMatchesCard: previewStyle.boxShadow.includes(actionSurfaceStyle.borderTopColor),
        noInnerHighlightSeam: viewportStyle.boxShadow === 'none',
        concentricCorners: Math.abs(
          parseFloat(previewStyle.borderTopLeftRadius)
          - parseFloat(previewStyle.borderTopWidth)
          - parseFloat(viewportStyle.borderTopLeftRadius)
        ) <= 1,
        fullImageContained: getComputedStyle(image).objectFit === 'contain'
          && getComputedStyle(image).maxWidth === '100%',
        viewportClipsContent: viewportStyle.overflow === 'hidden',
        viewportInsideFrame: viewportRect.left >= previewRect.left + 8
          && viewportRect.right <= previewRect.right - 8
          && viewportRect.top >= previewRect.top + 8
          && viewportRect.bottom <= previewRect.bottom - 8,
        imageInsideViewport: imageRect.left >= viewportRect.left
          && imageRect.right <= viewportRect.right,
        frameReplacesCard: Math.abs(moduleRect.left - previewRect.left) <= 1
          && Math.abs(moduleRect.right - previewRect.right) <= 1
          && Math.abs(moduleRect.top - previewRect.top) <= 1
          && Math.abs(moduleRect.bottom - previewRect.bottom) <= 1,
      },
    }
  })
  const failedBrowserPreviewChecks = Object.entries(browserPreviewLayout.checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)
  if (failedBrowserPreviewChecks.length > 0) {
    throw new Error(
      `browser preview layout failed (${failedBrowserPreviewChecks.join(', ')}): `
      + JSON.stringify(browserPreviewLayout.metrics),
    )
  }
  if (process.env.BRAIN_UI_PREVIEW_SCREENSHOT) {
    await page.waitForTimeout(260)
    const screenshotPath = path.resolve(process.env.BRAIN_UI_PREVIEW_SCREENSHOT)
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })
    await page.screenshot({ path: screenshotPath, fullPage: true })
  }
  server.emitSse({
    type: 'tool_call',
    data: {
      name: 'browser_navigate',
      args: { url: 'https://example.com/docs' },
      result: '{"ok":true}',
      ok: true,
      browser_display_mode: 'card',
    },
    ts: new Date().toISOString(),
  })
  const nativeHideCountBeforeContinuousAction = await nativePage.evaluate(() => (
    window.__browserEmbedCalls?.filter(call => call.method === 'hide').length || 0
  ))
  server.emitTransientSse({
    type: 'tool_preparing',
    data: { name: 'browser_press_key', browser_display_mode: 'card' },
    ts: new Date().toISOString(),
  })
  for (const target of [page, nativePage]) {
    await target.waitForFunction(() => (
      !document.querySelector('#browser-preview')?.hidden
      && document.querySelector('.action-log-module')?.dataset.browserPhase === 'browser'
      && document.querySelector('#action-log')?.hidden === true
    ))
  }
  server.emitTransientSse({
    type: 'tool_executing',
    data: { name: 'browser_press_key', browser_display_mode: 'card' },
    ts: new Date().toISOString(),
  })
  for (const target of [page, nativePage]) {
    await target.waitForFunction(() => (
      !document.querySelector('#browser-preview')?.hidden
      && document.querySelector('.action-log-module')?.dataset.browserPhase === 'browser'
      && document.querySelector('#action-log')?.hidden === true
    ))
  }
  server.emitSse({
    type: 'tool_call',
    data: {
      name: 'browser_press_key',
      args: { key: 'End' },
      result: '{"ok":true}',
      ok: true,
      browser_display_mode: 'card',
    },
    ts: new Date().toISOString(),
  })
  server.emitSse({ type: 'response', data: {}, ts: new Date().toISOString() })
  await page.waitForFunction(() => {
    const streamText = document.querySelector('#si-l1')?.textContent || ''
    const actionText = document.querySelector('#action-log')?.textContent || ''
    const activityText = document.querySelector('#ai-activity')?.textContent || ''
    return streamText.includes('打开网页')
      && streamText.includes('example.com')
      && streamText.includes('滚动页面')
      && streamText.includes('全部操作')
      && actionText.includes('打开网页 · example.com')
      && actionText.includes('滚动页面 · End')
      && activityText.includes('项操作')
      && !streamText.includes('browser_navigate')
      && !streamText.includes('browser_press_key')
      && !streamText.includes('工具调用')
  })
  // A response used to start a 3.5-second auto-dismiss timer. Wait beyond it
  // and prove the live browser remains visible until the Agent explicitly calls
  // browser_close. A later user message must not dismiss it either.
  await page.waitForTimeout(4200)
  for (const target of [page, nativePage]) {
    const retained = await target.evaluate(() => ({
      previewHidden: document.querySelector('#browser-preview')?.hidden,
      browserPhase: document.querySelector('.action-log-module')?.dataset.browserPhase || '',
      browserActive: document.querySelector('.action-log-module')?.dataset.browserActive || '',
      actionLogHidden: document.querySelector('#action-log')?.hidden,
    }))
    if (
      retained.previewHidden !== false
      || retained.browserPhase !== 'browser'
      || retained.browserActive !== 'true'
      || retained.actionLogHidden !== true
    ) {
      throw new Error(`browser preview did not persist after response: ${JSON.stringify(retained)}`)
    }
  }
  const nativeHideCountAfterResponse = await nativePage.evaluate(() => (
    window.__browserEmbedCalls?.filter(call => call.method === 'hide').length || 0
  ))
  if (nativeHideCountAfterResponse !== nativeHideCountBeforeContinuousAction) {
    throw new Error('continuous browser action or response unexpectedly hid the native browser')
  }
  server.emitTransientSse({
    type: 'message_received',
    data: { input: '继续显示当前页面' },
    ts: new Date().toISOString(),
  })
  await page.waitForTimeout(120)
  for (const target of [page, nativePage]) {
    await target.waitForFunction(() => (
      !document.querySelector('#browser-preview')?.hidden
      && document.querySelector('.action-log-module')?.dataset.browserPhase === 'browser'
      && document.querySelector('#action-log')?.hidden === true
    ))
  }
  const nativeHideCountBeforeModeSwitch = await nativePage.evaluate(() => (
    window.__browserEmbedCalls?.filter(call => call.method === 'hide').length || 0
  ))
  server.emitTransientSse({
    type: 'tool_executing',
    data: {
      name: 'browser_set_display_mode',
      args: { mode: 'window' },
      browser_display_mode: 'window',
    },
    ts: new Date().toISOString(),
  })
  await nativePage.waitForFunction(() => (
    window.__browserEmbedCalls?.some(call => (
      call.method === 'update'
      && call.payload?.mode === 'window'
      && call.payload?.visible === true
      && call.payload?.interactive === true
      && call.payload?.transition?.enabled === true
      && call.payload?.transition?.durationMs === 480
    ))
  ))
  for (const target of [page, nativePage]) {
    await target.waitForFunction(() => (
      document.querySelector('#browser-preview')?.hidden
      && !document.querySelector('#action-log')?.hidden
      && !document.querySelector('.action-log-module')?.dataset.browserActive
    ))
  }
  server.emitTransientSse({
    type: 'tool_executing',
    data: {
      name: 'browser_set_display_mode',
      args: { mode: 'card' },
      browser_display_mode: 'card',
    },
    ts: new Date().toISOString(),
  })
  server.emitTransientSse({
    type: 'browser_preview',
    data: {
      mode: 'card',
      state: 'ready',
      action: 'browser_set_display_mode',
      native_view: true,
      transition: true,
      image_url: '/site-assets/browser-preview.png',
      revision: 'smoke-mode-switch',
      url: 'https://example.com/docs',
      title: 'Example Documentation',
    },
    ts: new Date().toISOString(),
  })
  await nativePage.waitForFunction(() => (
    window.__browserEmbedCalls?.some(call => (
      call.method === 'update'
      && call.payload?.mode === 'card'
      && call.payload?.visible === true
      && call.payload?.transition?.enabled === true
      && call.payload?.transition?.durationMs === 480
    ))
  ))
  for (const target of [page, nativePage]) {
    await target.waitForFunction(() => (
      !document.querySelector('#browser-preview')?.hidden
      && document.querySelector('.action-log-module')?.dataset.browserPhase === 'browser'
      && document.querySelector('#action-log')?.hidden === true
    ))
  }
  const modeSwitchState = await nativePage.evaluate(() => ({
    hideCount: window.__browserEmbedCalls?.filter(call => call.method === 'hide').length || 0,
    streamText: document.querySelector('#si-l1')?.textContent || '',
  }))
  if (modeSwitchState.hideCount !== nativeHideCountBeforeModeSwitch) {
    throw new Error('switching browser size must reparent the live view without hiding it')
  }
  if (
    !modeSwitchState.streamText.includes('切换到小浏览器')
    || modeSwitchState.streamText.includes('browser_set_display_mode')
  ) {
    throw new Error(`browser size switch is not user-friendly in Brain UI: ${modeSwitchState.streamText}`)
  }
  server.emitTransientSse({
    type: 'tool_preparing',
    data: { name: 'browser_close', browser_display_mode: 'card' },
    ts: new Date().toISOString(),
  })
  server.emitTransientSse({
    type: 'tool_executing',
    data: { name: 'browser_close', browser_display_mode: 'card' },
    ts: new Date().toISOString(),
  })
  for (const target of [page, nativePage]) {
    await target.waitForFunction(() => (
      !document.querySelector('#browser-preview')?.hidden
      && document.querySelector('.action-log-module')?.dataset.browserPhase === 'browser'
      && document.querySelector('#action-log')?.hidden === true
    ))
  }
  server.emitTransientSse({
    type: 'browser_preview',
    data: {
      mode: 'card',
      state: 'closed',
      action: 'browser_close',
      native_view: true,
    },
    ts: new Date().toISOString(),
  })
  server.emitTransientSse({
    type: 'tool_call',
    data: {
      name: 'browser_close',
      args: {},
      result: '{"ok":true}',
      ok: true,
      browser_display_mode: 'card',
    },
    ts: new Date().toISOString(),
  })
  await nativePage.waitForFunction(() => (
    !document.querySelector('#browser-preview')?.hidden
    && !document.querySelector('.action-log-module')?.dataset.browserPhase
    && !document.querySelector('#action-log')?.hidden
  ))
  await nativePage.waitForFunction(() => {
    const xs = (window.__browserEmbedCalls || [])
      .filter(call => call.method === 'update' && call.payload?.mode === 'card')
      .map(call => call.payload.bounds?.x)
      .filter(Number.isFinite)
    return xs.length >= 2 && xs.at(-1) > xs.at(-2)
  })
  const browserExitMotion = await nativePage.evaluate(() => {
    const moduleRect = document.querySelector('.action-log-module')?.getBoundingClientRect()
    const actionRect = document.querySelector('.action-log-surface')?.getBoundingClientRect()
    const browserRect = document.querySelector('#browser-preview')?.getBoundingClientRect()
    const nativeXs = (window.__browserEmbedCalls || [])
      .filter(call => call.method === 'update' && call.payload?.mode === 'card')
      .map(call => call.payload.bounds?.x)
      .filter(Number.isFinite)
    return {
      moduleRect: moduleRect?.toJSON(),
      actionRect: actionRect?.toJSON(),
      browserRect: browserRect?.toJSON(),
      nativeXs,
    }
  })
  if (
    !browserExitMotion.moduleRect
    || browserExitMotion.actionRect.left >= browserExitMotion.moduleRect.left
    || browserExitMotion.browserRect.left <= browserExitMotion.moduleRect.left
    || browserExitMotion.nativeXs.length < 2
    || browserExitMotion.nativeXs.at(-1) <= browserExitMotion.nativeXs.at(-2)
  ) {
    throw new Error(`browser/log exit is not reversing the entrance motion: ${JSON.stringify(browserExitMotion)}`)
  }
  await page.waitForFunction(() =>
    document.querySelector('#browser-preview')?.hidden
    && !document.querySelector('#action-log')?.hidden
    && !document.querySelector('.action-log-module')?.dataset.browserActive
    && getComputedStyle(document.querySelector('.action-log-surface > .l2-module-head')).display === 'flex'
    && document.querySelector('#action-log-title')?.textContent === '行动日志')
  await nativePage.waitForFunction(() => {
    const calls = window.__browserEmbedCalls || []
    const lastCardUpdate = calls.findLastIndex(call => (
      call.method === 'update' && call.payload?.mode === 'card'
    ))
    return lastCardUpdate >= 0
      && calls.slice(lastCardUpdate + 1).some(call => call.method === 'hide')
      && document.querySelector('#browser-preview')?.hidden
      && !document.querySelector('#action-log')?.hidden
  })
  server.emitSse({
    type: 'tool_executing',
    data: { name: 'browser_navigate', browser_display_mode: 'window' },
    ts: new Date().toISOString(),
  })
  await page.waitForFunction(() =>
    document.querySelector('#browser-preview')?.hidden
    && !document.querySelector('#action-log')?.hidden)
  await nativePage.waitForFunction(() => (
    window.__browserEmbedCalls?.some(call => (
      call.method === 'update'
      && call.payload?.mode === 'window'
      && call.payload?.visible === true
      && call.payload?.interactive === true
      && !call.payload?.bounds
    ))
    && document.querySelector('#browser-preview')?.hidden
    && !document.querySelector('#action-log')?.hidden
  ))
  if (nativePreviewAssetRequests !== 0) {
    throw new Error(`native browser embed requested screenshots after mode switch: ${nativePreviewAssetRequests}`)
  }
  await nativePage.close()

  server.emitSse({
    type: 'scheduled_task',
    data: {
      run_id: 11,
      reminder_id: 7,
      target_id: 'ID:000001',
      task: '提醒用户喝水',
    },
    ts: new Date().toISOString(),
  })
  server.emitSse({ type: 'stream_start', data: { mode: 'thinking' }, ts: new Date().toISOString() })
  server.emitSse({ type: 'tool_preparing', data: { name: 'send_message' }, ts: new Date().toISOString() })
  server.emitSse({ type: 'tool_executing', data: { name: 'send_message' }, ts: new Date().toISOString() })
  server.emitSse({
    type: 'tool_call',
    data: {
      name: 'send_message',
      args: { target_id: 'ID:000001', content: '该喝水了' },
      result: '{"ok":true}',
      ok: true,
    },
    ts: new Date().toISOString(),
  })
  server.emitSse({ type: 'scheduled_task_completed', data: { run_id: 11, reminder_id: 7 }, ts: new Date().toISOString() })
  server.emitSse({ type: 'response', data: { runtimeLane: 'l3' }, ts: new Date().toISOString() })
  await page.waitForFunction(() =>
    document.querySelector('#l3-state')?.dataset.state === 'done'
    && document.querySelector('#si-l2')?.textContent.includes('提醒用户喝水')
    && !document.querySelector('#si-l1')?.textContent.includes('提醒用户喝水'))

  await page.evaluate(() => {
    localStorage.removeItem('bailongma-action-log-v1')
    localStorage.removeItem('bailongma-heartbeat-count-v1')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#heartbeat-state[data-state="alive"]')
  await page.waitForFunction(() =>
    document.querySelector('#heartbeat-count')?.textContent === '1'
    && document.querySelector('#action-log')?.textContent.includes('读取文件 · src/example.js')
    && document.querySelector('#action-log')?.textContent.includes('写入文件 · src/config-demo.js')
    && document.querySelector('#si-l1')?.textContent.includes('请更新配置文件')
    && document.querySelector('#si-l1')?.textContent.includes('写入文件')
    && document.querySelector('#cognition-state')?.textContent.includes('最近一轮完成')
    && document.querySelector('#l3-state')?.dataset.state === 'done'
    && document.querySelector('#si-l2')?.textContent.includes('提醒用户喝水')
    && !document.querySelector('#si-l1')?.textContent.includes('提醒用户喝水')
    && document.querySelector('#si-l2')?.textContent.includes('读取文件'))
  await page.fill('#msg-input', '马云是谁')
  await page.click('#send-btn')
  await page.waitForTimeout(1300)
  const regexTriggeredCard = await page.evaluate(() =>
    Boolean(document.querySelector('#person-card-panel'))
    || document.querySelector('.cognition-module')?.dataset.personPhase === 'person')
  if (regexTriggeredCard) throw new Error('raw chat text opened person card without an agent intent event')

  server.emitSse({
    type: 'person_card_mode',
    data: {
      action: 'show',
      active: true,
      card: {
        name: '马云',
        title: '企业家',
        summary: '中国企业家，阿里巴巴集团主要创始人之一。',
        knownFor: ['阿里巴巴'],
        tags: ['企业家'],
        image: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 640 360%22%3E%3Crect width=%22640%22 height=%22360%22 fill=%22%23112332%22/%3E%3Ccircle cx=%22320%22 cy=%22130%22 r=%2260%22 fill=%22%2382d2ff%22/%3E%3Crect x=%22205%22 y=%22210%22 width=%22230%22 height=%2280%22 rx=%2240%22 fill=%22%2382d2ff%22/%3E%3C/svg%3E',
        source: 'agent_tool',
        updatedAt: new Date().toISOString(),
      },
    },
    ts: new Date().toISOString(),
  })
  await page.waitForTimeout(300)
  const appearedBeforeIntentDelay = await page.evaluate(() => Boolean(document.querySelector('#person-card-panel')))
  if (appearedBeforeIntentDelay) throw new Error('person card appeared before the intended reveal delay')
  await page.waitForFunction(() =>
    document.querySelector('.cognition-module')?.dataset.personPhase === 'person'
    && document.querySelector('#pc-name')?.textContent.includes('马云'))
  const enteringState = await page.evaluate(() => {
    const module = document.querySelector('.cognition-module')
    const panel = document.querySelector('#person-card-panel')
    return {
      insideCognitionModule: panel?.parentElement === module,
      phase: module?.dataset.personPhase || '',
      transitionDuration: panel ? getComputedStyle(panel).transitionDuration : '',
      legacyBodyMode: document.body.classList.contains('person-card-mode'),
    }
  })
  if (!enteringState.insideCognitionModule || enteringState.phase !== 'person') {
    throw new Error('person card did not enter as the cognition module replacement surface')
  }
  if (!enteringState.transitionDuration.includes('0.48s')) {
    throw new Error(`person card did not reuse the compact-browser transition duration: ${enteringState.transitionDuration}`)
  }
  if (enteringState.legacyBodyMode) throw new Error('person card still activated the legacy fixed overlay mode')
  server.emitSse({
    type: 'message',
    data: {
      from: 'consciousness',
      content: '马云，1964年生，浙江杭州人，阿里巴巴集团创始人，曾任董事局主席，创办了淘宝、支付宝，多次成为中国首富。',
    },
    ts: new Date().toISOString(),
  })
  await page.waitForFunction(() => document.querySelector('#pc-summary')?.textContent.includes('阿里巴巴集团创始人'))
  await page.waitForFunction(() => document.querySelector('#cognition-surface')?.getAttribute('aria-hidden') === 'true')

  const snapshot = await page.evaluate(() => {
    const module = document.querySelector('.cognition-module')
    const panel = document.querySelector('#person-card-panel')
    const cognitionSurface = document.querySelector('#cognition-surface')
    const moduleRect = module?.getBoundingClientRect()
    const panelRect = panel?.getBoundingClientRect()
    const cognitionRect = cognitionSurface?.getBoundingClientRect()
    const cognitionStyle = cognitionSurface ? getComputedStyle(cognitionSurface) : null
    return {
      d3: Boolean(window.d3),
      nodes: document.querySelectorAll('#graph circle').length,
      links: document.querySelectorAll('#graph line').length,
      sceneStage: Boolean(document.getElementById('stage')),
      heartbeatCount: document.querySelector('#heartbeat-count')?.textContent || '',
      actionLog: document.querySelector('#action-log')?.textContent || '',
      l1History: document.querySelector('#si-l1')?.textContent || '',
      l3History: document.querySelector('#si-l2')?.textContent || '',
      l3State: document.querySelector('#l3-state')?.textContent || '',
      cognitionState: document.querySelector('#cognition-state')?.textContent || '',
      personCard: document.querySelector('#pc-name')?.textContent || '',
      personSummary: document.querySelector('#pc-summary')?.textContent || '',
      personKnownFor: [...document.querySelectorAll('#pc-known-list li')].map(li => li.textContent).join(' / '),
      personImage: !document.querySelector('#pc-hero-img')?.hidden,
      closeVisible: Number(getComputedStyle(document.querySelector('#pc-exit-btn')).opacity) > 0.5,
      personInsideCognition: panel?.parentElement === module,
      personFillsCognition: Boolean(moduleRect && panelRect)
        && Math.abs(moduleRect.left - panelRect.left) <= 1
        && Math.abs(moduleRect.right - panelRect.right) <= 1
        && Math.abs(moduleRect.top - panelRect.top) <= 1
        && Math.abs(moduleRect.bottom - panelRect.bottom) <= 1,
      cognitionSurfaceHidden: cognitionSurface?.getAttribute('aria-hidden') === 'true'
        && Number(cognitionStyle?.opacity) === 0
        && cognitionRect?.right <= moduleRect?.left + 1,
      personCardMetrics: {
        scrollHeight: document.querySelector('.pc-card')?.scrollHeight || 0,
        clientHeight: document.querySelector('.pc-card')?.clientHeight || 0,
      },
      personHeroCompact: document.querySelector('#pc-hero')?.getBoundingClientRect().height < 140,
      brand: document.querySelector('#agent-brand-name')?.textContent || '',
    }
  })

  if (!snapshot.d3) throw new Error('d3 global missing')
  if (snapshot.nodes < 2) throw new Error(`expected at least 2 graph nodes, saw ${snapshot.nodes}`)
  if (!snapshot.sceneStage) throw new Error('scene shell was not bootstrapped')
  if (snapshot.heartbeatCount !== '1') throw new Error('heartbeat monitor did not count the Tick')
  if (!snapshot.actionLog.includes('读取文件 · src/example.js')) throw new Error('action log did not recover the file action')
  if (!snapshot.actionLog.includes('写入文件 · src/config-demo.js')) throw new Error('action log did not recover the L1 write action')
  if (!snapshot.l1History.includes('请更新配置文件') || !snapshot.l1History.includes('写入文件')) throw new Error('L1 processing history did not recover after reload')
  if (snapshot.l1History.includes('提醒用户喝水')) throw new Error('L3 task leaked into L1 processing history')
  if (!snapshot.l3History.includes('提醒用户喝水')) throw new Error('L3 task did not recover in the background cognition stream')
  if (!snapshot.l3State.includes('L3 已完成')) throw new Error('L3 completion state did not recover after reload')
  if (!snapshot.cognitionState.includes('最近一轮完成')) throw new Error('cognition history did not recover after reload')
  if (!snapshot.personCard.includes('马云')) throw new Error('person card did not render the requested person')
  if (!snapshot.personSummary.includes('阿里巴巴集团创始人')) throw new Error('person card did not absorb assistant summary')
  if (!snapshot.personKnownFor.includes('淘宝')) throw new Error('person card did not absorb assistant known-for items')
  if (!snapshot.personImage) throw new Error('person card hero image was not visible')
  if (!snapshot.closeVisible) throw new Error('person card close button was not persistently visible')
  if (!snapshot.personInsideCognition) throw new Error('person card escaped the cognition module')
  if (!snapshot.personFillsCognition) throw new Error('person card did not fill the entire cognition module')
  if (!snapshot.cognitionSurfaceHidden) throw new Error('cognition title/status surface stayed visible behind the person card')
  if (snapshot.personCardMetrics.scrollHeight > snapshot.personCardMetrics.clientHeight + 2) {
    throw new Error(`person card overflowed its normal cognition viewport: ${JSON.stringify(snapshot.personCardMetrics)}`)
  }
  if (!snapshot.personHeroCompact) throw new Error('person card retained the oversized landscape hero')
  if (process.env.BRAIN_UI_PERSON_SCREENSHOT) {
    const screenshotPath = path.resolve(process.env.BRAIN_UI_PERSON_SCREENSHOT)
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })
    await page.screenshot({ path: screenshotPath, fullPage: true })
  }

  const summaryBeforeNameOnlyReply = snapshot.personSummary
  server.emitSse({
    type: 'message_received',
    data: { input: '只复述马云，不要介绍人物' },
    ts: new Date().toISOString(),
  })
  server.emitSse({
    type: 'message',
    data: { from: 'consciousness', content: '马云。' },
    ts: new Date().toISOString(),
  })
  await page.waitForTimeout(120)
  const summaryAfterNameOnlyReply = await page.locator('#pc-summary').textContent()
  if (summaryAfterNameOnlyReply !== summaryBeforeNameOnlyReply) {
    throw new Error(`name-only assistant reply polluted person summary: ${summaryAfterNameOnlyReply}`)
  }

  await page.click('#pc-exit-btn')
  const leavingSeen = await page.waitForFunction(() =>
    !document.querySelector('.cognition-module')?.dataset.personPhase
    && Boolean(document.querySelector('#person-card-panel')), null, { timeout: 1000 })
  if (!leavingSeen) throw new Error('person card did not start the compact-browser-style exit transition')
  await page.waitForFunction(() =>
    !document.querySelector('#person-card-panel')
    && document.querySelector('#cognition-surface')?.getAttribute('aria-hidden') === 'false')
  await page.fill('#msg-input', '帮我写一个项目介绍')
  await page.click('#send-btn')
  await page.waitForTimeout(1300)
  const falsePersonCard = await page.evaluate(() =>
    Boolean(document.querySelector('#person-card-panel'))
    || document.querySelector('.cognition-module')?.dataset.personPhase === 'person')
  if (falsePersonCard) throw new Error('person card opened for a non-person introduction request')

  // Knowledge Cortex follows the same model-intent event path as the person
  // card. Raw text never opens it; an explicit agent event opens the browser
  // with a region/query focus and it loads source-backed data from its API.
  server.emitSse({
    type: 'knowledge_cortex_mode',
    data: { action: 'show', active: true, region_id: 'smoke-docs', query: '发布验证', document_id: '1' },
    ts: new Date().toISOString(),
  })
  try {
    await page.waitForFunction(() => (
      document.body.classList.contains('knowledge-cortex-mode')
      && document.querySelector('#kc-region-list')?.textContent.includes('发布资料')
      && document.querySelector('#kc-result-list')?.textContent.includes('签名、安装和回归验证')
      && document.querySelector('#kc-detail')?.textContent.includes('file:///smoke/release.md')
    ))
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      bodyClass: document.body.className,
      status: document.querySelector('#kc-status')?.textContent,
      regions: document.querySelector('#kc-region-list')?.textContent,
      results: document.querySelector('#kc-result-list')?.textContent,
      detail: document.querySelector('#kc-detail')?.textContent,
    }))
    throw new Error(`knowledge cortex did not finish loading: ${JSON.stringify(diagnostic)}`, { cause: error })
  }
  const knowledgeSurface = await page.evaluate(() => ({
    visible: document.querySelector('#knowledge-cortex-panel')?.getAttribute('aria-hidden') === 'false',
    regionCount: document.querySelector('#kc-region-count')?.textContent,
    resultCount: document.querySelector('#kc-result-count')?.textContent,
    documentTitle: document.querySelector('#kc-detail h2')?.textContent,
    panelRight: document.querySelector('#knowledge-cortex-panel')?.getBoundingClientRect().right || 0,
    consoleLeft: document.querySelector('.console')?.getBoundingClientRect().left || 0,
    consoleVisible: getComputedStyle(document.querySelector('.console')).display !== 'none',
  }))
  if (!knowledgeSurface.visible || knowledgeSurface.regionCount !== '1' || knowledgeSurface.resultCount !== '1' || knowledgeSurface.documentTitle !== '发布验证手册' || !knowledgeSurface.consoleVisible || knowledgeSurface.consoleLeft <= knowledgeSurface.panelRight) {
    throw new Error(`knowledge cortex surface did not render focused source data: ${JSON.stringify(knowledgeSurface)}`)
  }
  await page.click('#kc-close')
  await page.waitForFunction(() => !document.body.classList.contains('knowledge-cortex-mode'))

  server.emitSse({ type: 'message_received', data: { input: 'action log limit smoke' }, ts: new Date().toISOString() })
  server.emitSse({
    type: 'tool_call',
    data: { name: 'send_message', args: { content: 'action-log-hidden-message' }, result: 'ok', ok: true },
    ts: new Date().toISOString(),
  })
  server.emitSse({
    type: 'tool_call',
    data: { name: 'ui_set', args: { id: 'action-log-hidden-surface' }, result: 'ok', ok: true },
    ts: new Date().toISOString(),
  })
  server.emitSse({
    type: 'tool_call',
    data: { name: 'read_file', args: { path: 'failed-action.js' }, result: 'failed', ok: false },
    ts: new Date().toISOString(),
  })
  for (let index = 0; index < 60; index += 1) {
    server.emitSse({
      type: 'tool_call',
      data: { name: 'read_file', args: { path: `bulk-${index}.js` }, result: 'ok', ok: true },
      ts: new Date(Date.now() + index).toISOString(),
    })
  }
  server.emitSse({ type: 'response', data: {}, ts: new Date(Date.now() + 60).toISOString() })
  await page.waitForFunction(() => {
    const log = document.querySelector('#action-log')
    const entries = [...document.querySelectorAll('#action-log .action-log-entry')]
    return !document.querySelector('#action-log-count')
      && entries.length === 58
      && entries[0]?.textContent.includes('bulk-2.js')
      && entries.at(-1)?.textContent.includes('bulk-59.js')
      && Math.abs(log.scrollHeight - log.clientHeight - log.scrollTop) <= 1
      && !log?.textContent.includes('failed-action.js')
      && !log?.textContent.includes('action-log-hidden-message')
      && !log?.textContent.includes('action-log-hidden-surface')
      && !log?.textContent.includes('bulk-1.js')
      && log?.textContent.includes('bulk-2.js')
      && log?.textContent.includes('bulk-59.js')
  })

  await page.evaluate(() => localStorage.removeItem('bailongma-action-log-v1'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#heartbeat-state[data-state="alive"]')
  await page.waitForFunction(() => {
    const log = document.querySelector('#action-log')
    const entries = [...document.querySelectorAll('#action-log .action-log-entry')]
    return !document.querySelector('#action-log-count')
      && entries.length === 58
      && entries[0]?.textContent.includes('bulk-2.js')
      && entries.at(-1)?.textContent.includes('bulk-59.js')
      && Math.abs(log.scrollHeight - log.clientHeight - log.scrollTop) <= 1
      && !log?.textContent.includes('failed-action.js')
      && !log?.textContent.includes('action-log-hidden-message')
      && !log?.textContent.includes('action-log-hidden-surface')
      && !log?.textContent.includes('bulk-1.js')
      && log?.textContent.includes('bulk-2.js')
      && log?.textContent.includes('bulk-59.js')
  })

  const themeColorSwitch = await page.evaluate(() => {
    const probe = () => ({
      lineType: getComputedStyle(document.querySelector('#si-l1 .line-type')).color,
      lineTool: getComputedStyle(document.querySelector('#si-l1 .line-tool')).color,
    })
    document.body.dataset.theme = 'midnight'
    const midnight = probe()
    document.body.dataset.theme = 'sand'
    const sand = probe()
    document.body.dataset.theme = 'midnight'
    const restored = probe()
    return { midnight, sand, restored }
  })
  if (themeColorSwitch.midnight.lineType === themeColorSwitch.sand.lineType
      || themeColorSwitch.midnight.lineTool === themeColorSwitch.sand.lineTool) {
    throw new Error(`thought stream colors did not follow the theme: ${JSON.stringify(themeColorSwitch)}`)
  }
  if (themeColorSwitch.restored.lineType !== themeColorSwitch.midnight.lineType
      || themeColorSwitch.restored.lineTool !== themeColorSwitch.midnight.lineTool) {
    throw new Error(`dark theme colors were not restored: ${JSON.stringify(themeColorSwitch)}`)
  }

  await page.setViewportSize({ width: 1194, height: 834 })
  await page.waitForTimeout(650)
  const ipadLayout = await page.evaluate(() => {
    const rect = selector => {
      const value = document.querySelector(selector)?.getBoundingClientRect()
      return value ? {
        left: value.left,
        right: value.right,
        top: value.top,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      } : null
    }
    const circles = [...document.querySelectorAll('#graph circle')]
    const nodeCenter = circles.length ? {
      x: circles.reduce((sum, circle) => sum + Number(circle.getAttribute('cx') || 0), 0) / circles.length,
      y: circles.reduce((sum, circle) => sum + Number(circle.getAttribute('cy') || 0), 0) / circles.length,
    } : null
    const nodeBounds = circles.length ? circles.reduce((bounds, circle) => {
      const x = Number(circle.getAttribute('cx') || 0)
      const y = Number(circle.getAttribute('cy') || 0)
      const radius = Number(circle.getAttribute('r') || 0)
      bounds.left = Math.min(bounds.left, x - radius)
      bounds.right = Math.max(bounds.right, x + radius)
      bounds.top = Math.min(bounds.top, y - radius)
      bounds.bottom = Math.max(bounds.bottom, y + radius)
      return bounds
    }, { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }) : null
    return {
      layout: window.bailongmaGraphLayout?.(),
      leftPanel: rect('#panel-l1'),
      rightPanel: rect('#panel-l2'),
      console: rect('.console'),
      nodeCenter,
      nodeBounds,
    }
  })
  if (!ipadLayout.layout?.stage) throw new Error(`iPad graph diagnostics missing: ${JSON.stringify(ipadLayout)}`)
  if (ipadLayout.layout.viewport.width !== 1194 || ipadLayout.layout.viewport.height !== 834) {
    throw new Error(`iPad graph viewport was not refreshed: ${JSON.stringify(ipadLayout)}`)
  }
  if (ipadLayout.layout.stage.left < ipadLayout.leftPanel.right
      || ipadLayout.layout.stage.right > ipadLayout.rightPanel.left) {
    throw new Error(`iPad graph stage overlaps side panels: ${JSON.stringify(ipadLayout)}`)
  }
  if (ipadLayout.layout.stage.bottom > ipadLayout.console.top) {
    throw new Error(`iPad graph stage overlaps the composer: ${JSON.stringify(ipadLayout)}`)
  }
  if (ipadLayout.layout.stage.scale >= 1) {
    throw new Error(`iPad graph did not compact for the available stage: ${JSON.stringify(ipadLayout)}`)
  }
  if (!ipadLayout.nodeCenter
      || Math.abs(ipadLayout.nodeCenter.x - ipadLayout.layout.stage.centerX) > 110
      || Math.abs(ipadLayout.nodeCenter.y - ipadLayout.layout.stage.centerY) > 110) {
    throw new Error(`iPad graph nodes are not centered in the stage: ${JSON.stringify(ipadLayout)}`)
  }
  if (!ipadLayout.nodeBounds
      || ipadLayout.nodeBounds.left < ipadLayout.layout.stage.left - 36
      || ipadLayout.nodeBounds.right > ipadLayout.layout.stage.right + 36
      || ipadLayout.nodeBounds.top < ipadLayout.layout.stage.top - 36
      || ipadLayout.nodeBounds.bottom > ipadLayout.layout.stage.bottom + 36) {
    throw new Error(`iPad graph nodes do not fit the stage: ${JSON.stringify(ipadLayout)}`)
  }

  await page.hover('#graph')
  await page.mouse.wheel(0, -300)
  await page.waitForTimeout(100)
  const zoomedTransform = await page.locator('#graph > g').getAttribute('transform')
  if (!zoomedTransform || zoomedTransform === 'translate(0,0) scale(1)') {
    throw new Error(`graph zoom setup failed before resize: ${zoomedTransform}`)
  }

  await page.setViewportSize({ width: 1024, height: 768 })
  await page.waitForTimeout(650)
  const resizedGraph = await page.evaluate(() => ({
    layout: window.bailongmaGraphLayout?.(),
    transform: document.querySelector('#graph > g')?.getAttribute('transform') || '',
    nodeCenter: (() => {
      const circles = [...document.querySelectorAll('#graph circle')]
      if (!circles.length) return null
      return {
        x: circles.reduce((sum, circle) => sum + Number(circle.getAttribute('cx') || 0), 0) / circles.length,
        y: circles.reduce((sum, circle) => sum + Number(circle.getAttribute('cy') || 0), 0) / circles.length,
      }
    })(),
  }))
  if (resizedGraph.layout?.viewport.width !== 1024 || resizedGraph.layout?.viewport.height !== 768) {
    throw new Error(`resized graph viewport is stale: ${JSON.stringify(resizedGraph)}`)
  }
  if (resizedGraph.transform && resizedGraph.transform !== 'translate(0,0) scale(1)') {
    throw new Error(`graph zoom was not reset after resize: ${JSON.stringify(resizedGraph)}`)
  }
  if (!resizedGraph.nodeCenter
      || Math.abs(resizedGraph.nodeCenter.x - resizedGraph.layout.stage.centerX) > 110
      || Math.abs(resizedGraph.nodeCenter.y - resizedGraph.layout.stage.centerY) > 110) {
    throw new Error(`graph nodes were not recentered after resize: ${JSON.stringify(resizedGraph)}`)
  }

  await page.setViewportSize({ width: 320, height: 480 })
  await page.waitForTimeout(500)
  await page.evaluate(() => {
    document.querySelector('#chat-history')?.classList.remove('open')
    const transcript = document.querySelector('#voice-transcript')
    if (transcript) transcript.textContent = '这是紧凑窗口语音识别测试'
  })
  await page.waitForFunction(() => document.querySelector('#compact-voice-transcript')?.textContent === '这是紧凑窗口语音识别测试')
  const compactLayout = await page.evaluate(() => {
    const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect()
    return {
      bodyClass: document.body.className,
      graphDisplay: getComputedStyle(document.querySelector('#graph')).display,
      leftPanelDisplay: getComputedStyle(document.querySelector('#panel-l1')).display,
      rightPanelDisplay: getComputedStyle(document.querySelector('#panel-l2')).display,
      voiceStripDisplay: getComputedStyle(document.querySelector('#compact-voice-strip')).display,
      historyHeight: rect('#chat-history')?.height || 0,
      consoleHeight: rect('#chat-area')?.height || 0,
      consoleWidth: rect('#chat-area')?.width || 0,
      consoleLeft: rect('#chat-area')?.left || 0,
      bodyScrollWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      inputWidth: rect('#msg-input')?.width || 0,
      sendRight: rect('#send-btn')?.right || 0,
      transcriptWidth: rect('#compact-voice-transcript')?.width || 0,
    }
  })
  if (compactLayout.graphDisplay !== 'none') throw new Error('compact layout must hide the memory graph')
  if (compactLayout.leftPanelDisplay !== 'none' || compactLayout.rightPanelDisplay !== 'none') {
    throw new Error('compact layout must hide both side panels')
  }
  if (compactLayout.voiceStripDisplay !== 'flex') throw new Error('compact layout voice transcript strip is hidden')
  if (compactLayout.historyHeight < 250) throw new Error(`compact chat history collapsed: ${compactLayout.historyHeight}px`)
  if (compactLayout.consoleHeight < 430) throw new Error(`compact console does not fill the window: ${compactLayout.consoleHeight}px`)
  if (compactLayout.consoleWidth < 285 || compactLayout.consoleLeft > 20) {
    throw new Error(`compact console does not span the window: ${JSON.stringify(compactLayout)}`)
  }
  if (compactLayout.bodyScrollWidth > compactLayout.viewportWidth || compactLayout.sendRight > compactLayout.viewportWidth) {
    throw new Error(`compact layout overflows horizontally: ${JSON.stringify(compactLayout)}`)
  }
  if (compactLayout.inputWidth < 70 || compactLayout.transcriptWidth < 80) {
    throw new Error(`compact composer or transcript is too narrow: ${JSON.stringify(compactLayout)}`)
  }

  const englishPage = await browser.newPage({ viewport: { width: 1280, height: 840 } })
  englishPage.on('pageerror', err => errors.push(`English page: ${err.message}`))
  await englishPage.addInitScript(() => {
    localStorage.setItem('bailongma-ui-language', 'en-US')
    localStorage.setItem('bailongma-memory-graph-enabled', 'false')
  })
  await englishPage.goto(`${baseUrl}/brain-ui`, { waitUntil: 'domcontentloaded' })
  await englishPage.waitForSelector('#settings-btn[title="Settings"]')
  await englishPage.click('#settings-btn')
  await englishPage.waitForSelector('#settings-overlay:not([hidden])')
  const englishUi = await englishPage.evaluate(() => ({
    lang: document.documentElement.lang,
    settingsTitle: document.querySelector('.settings-title')?.textContent?.trim(),
    appearanceTab: document.querySelector('.settings-nav-item[data-tab="appearance"]')?.textContent?.trim(),
    languageValue: document.querySelector('#settings-ui-language')?.value,
    messagePlaceholder: document.querySelector('#msg-input')?.placeholder,
    sendLabel: document.querySelector('#send-btn')?.textContent?.trim(),
    connection: document.querySelector('#conn-state')?.textContent?.trim(),
    heartbeatInterval: document.querySelector('#heartbeat-state-label')?.textContent?.trim(),
  }))
  if (englishUi.lang !== 'en-US'
      || englishUi.settingsTitle !== 'Settings'
      || englishUi.appearanceTab !== 'Appearance'
      || englishUi.languageValue !== 'en-US'
      || englishUi.messagePlaceholder !== 'Hold Space to speak'
      || englishUi.sendLabel !== 'Send'
      || englishUi.connection !== 'Connected'
      || englishUi.heartbeatInterval !== '20 min') {
    throw new Error(`English UI localization failed: ${JSON.stringify(englishUi)}`)
  }
  await englishPage.click('#settings-close')

  const englishCognitionLayout = await englishPage.evaluate(() => {
    const l3State = document.querySelector('#l3-state')
    const cognitionState = document.querySelector('#cognition-state')
    if (l3State) l3State.textContent = 'L3 Thinking by scheduler'
    if (cognitionState) cognitionState.textContent = 'Previous round did not finish'

    const title = document.querySelector('.cognition-head > :first-child')?.getBoundingClientRect()
    const stateGroup = document.querySelector('.cognition-state-group')?.getBoundingClientRect()
    const surface = document.querySelector('#cognition-surface')?.getBoundingClientRect()
    const badges = [...document.querySelectorAll('.cognition-state-group > *')]
      .map(element => element.getBoundingClientRect().toJSON())
    const intersects = Boolean(title && stateGroup
      && title.left < stateGroup.right
      && title.right > stateGroup.left
      && title.top < stateGroup.bottom
      && title.bottom > stateGroup.top)

    return {
      intersects,
      title: title?.toJSON(),
      stateGroup: stateGroup?.toJSON(),
      surface: surface?.toJSON(),
      badges,
    }
  })
  if (englishCognitionLayout.intersects
      || englishCognitionLayout.badges.some(badge => (
        badge.left < englishCognitionLayout.surface.left
        || badge.right > englishCognitionLayout.surface.right
      ))) {
    throw new Error(`English cognition header overlaps or overflows: ${JSON.stringify(englishCognitionLayout)}`)
  }
  if (process.env.BRAIN_UI_COGNITION_SCREENSHOT) {
    const screenshotPath = path.resolve(process.env.BRAIN_UI_COGNITION_SCREENSHOT)
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })
    await englishPage.screenshot({ path: screenshotPath, fullPage: true })
  }

  server.emitTransientSse({ type: 'message_received', data: { input: 'English tool localization smoke' }, ts: new Date().toISOString() })
  server.emitTransientSse({ type: 'tool_call', data: { name: 'read_file', args: { path: '/smoke.txt' }, result: 'smoke file content', ok: true }, ts: new Date().toISOString() })
  await englishPage.waitForFunction(() => document.querySelector('#ai-activity-label')?.textContent === 'Currently scanning files')
  await englishPage.waitForFunction(() => {
    const stream = document.querySelector('#si-l1')?.textContent || ''
    return stream.includes('Read file') && stream.includes('Success') && stream.includes('Content preview: smoke file content')
  })

  const englishHotspot = await englishPage.evaluate(() => ({
    title: document.querySelector('#hotspot-panel .hs-title-zh')?.textContent?.trim(),
    alertLabel: document.querySelector('#hotspot-panel .hs-stat--warn .hs-stat-label')?.textContent?.trim(),
    heatmap: document.querySelector('#hotspot-panel .hs-earth-label')?.textContent?.trim(),
    emptySource: document.querySelector('#hs-douyin-list .hs-item-text')?.textContent?.trim(),
    cacheLabel: document.querySelector('#hs-stat-data-delta')?.textContent?.trim(),
  }))
  if (englishHotspot.title !== 'Global Hotspot Event Tracking System'
      || englishHotspot.alertLabel !== 'Global alerts'
      || englishHotspot.heatmap !== 'Global heatmap'
      || englishHotspot.emptySource !== 'Real-time source is unavailable or not configured'
      || englishHotspot.cacheLabel !== 'Four trending lists / 30-minute cache') {
    throw new Error(`English hotspot localization failed: ${JSON.stringify(englishHotspot)}`)
  }

  server.emitTransientSse({
    type: 'person_card_mode',
    data: { action: 'show', active: true, card: { name: 'Ada Lovelace', title: '', summary: '', knownFor: [], tags: [], source: 'smoke' } },
    ts: new Date().toISOString(),
  })
  await englishPage.waitForFunction(() => document.querySelector('#pc-name')?.textContent === 'Ada Lovelace')
  const englishPerson = await englishPage.evaluate(() => ({
    kicker: document.querySelector('#person-card-panel .pc-kicker')?.textContent?.trim(),
    title: document.querySelector('#pc-title')?.textContent?.trim(),
    summary: document.querySelector('#pc-summary')?.textContent?.trim(),
    knownFor: document.querySelector('#pc-known-list')?.textContent?.trim(),
    closeTitle: document.querySelector('#pc-exit-btn')?.title,
  }))
  if (englishPerson.kicker !== 'PERSON PROFILE'
      || englishPerson.title !== 'Person Card'
      || englishPerson.summary !== 'No summary available.'
      || englishPerson.knownFor !== 'No notable works or identifying details yet'
      || englishPerson.closeTitle !== 'Close person card') {
    throw new Error(`English person card localization failed: ${JSON.stringify(englishPerson)}`)
  }
  await englishPage.click('#pc-exit-btn')
  await englishPage.waitForFunction(() => !document.querySelector('#person-card-panel'))

  server.emitTransientSse({
    type: 'knowledge_cortex_mode',
    data: { action: 'show', active: true, region_id: 'smoke-docs', query: 'release', document_id: '1' },
    ts: new Date().toISOString(),
  })
  await englishPage.waitForFunction(() => (
    document.body.classList.contains('knowledge-cortex-mode')
    && document.querySelector('#kc-status')?.textContent?.includes('Found 1 citable evidence items')
    && document.querySelector('#kc-detail')?.textContent?.includes('file:///smoke/release.md')
  ))
  const englishKnowledge = await englishPage.evaluate(() => ({
    heading: document.querySelector('#knowledge-cortex-panel h1')?.textContent?.trim(),
    searchPlaceholder: document.querySelector('#kc-search-input')?.placeholder,
    resultsHeading: document.querySelector('.kc-results-pane .kc-pane-title')?.textContent?.replace(/\s+/g, ' ').trim(),
    detailLabels: [...document.querySelectorAll('#kc-detail dt')].map(el => el.textContent.trim()),
  }))
  if (englishKnowledge.heading !== 'Knowledge Base'
      || englishKnowledge.searchPlaceholder !== 'Search documents and evidence in the current region'
      || !englishKnowledge.resultsHeading?.includes('Search results')
      || englishKnowledge.detailLabels.join('|') !== 'Knowledge region|Version|Format|Source') {
    throw new Error(`English knowledge localization failed: ${JSON.stringify(englishKnowledge)}`)
  }
  await englishPage.click('#kc-close')
  await englishPage.waitForFunction(() => !document.body.classList.contains('knowledge-cortex-mode'))

  await englishPage.goto(`${baseUrl}/activation`, { waitUntil: 'domcontentloaded' })
  await englishPage.waitForFunction(() => document.documentElement.lang === 'en-US')
  const englishActivation = await englishPage.evaluate(() => ({
    title: document.title,
    heading: document.querySelector('main h1')?.textContent?.trim(),
    submit: document.querySelector('#activate')?.textContent?.trim(),
    customToggle: document.querySelector('#settings-toggle')?.textContent?.trim(),
  }))
  if (englishActivation.title !== 'Activate Bailongma'
      || englishActivation.heading !== 'Activate Bailongma'
      || englishActivation.submit !== 'Activate and continue'
      || englishActivation.customToggle !== 'Or use a custom endpoint (local model)') {
    throw new Error(`English activation localization failed: ${JSON.stringify(englishActivation)}`)
  }


  await englishPage.goto(`${baseUrl}/electron/startup.html?lang=en-US`, { waitUntil: 'domcontentloaded' })
  await englishPage.waitForFunction(() => document.documentElement.lang === 'en-US')
  const englishStartup = await englishPage.evaluate(() => ({
    title: document.title,
    message: document.querySelector('#message')?.textContent?.trim(),
    stepsTitle: document.querySelector('.steps-title')?.textContent?.trim(),
    firstStep: document.querySelector('#steps .label')?.textContent?.trim(),
    firstState: document.querySelector('#steps .state')?.textContent?.trim(),
  }))
  if (englishStartup.title !== 'Bailongma is starting'
      || englishStartup.message !== 'Preparing the startup environment'
      || englishStartup.stepsTitle !== 'Steps in progress'
      || englishStartup.firstStep !== 'Prepare local port'
      || englishStartup.firstState !== 'Waiting') {
    throw new Error(`English startup localization failed: ${JSON.stringify(englishStartup)}`)
  }

  await englishPage.goto(`${baseUrl}/focus-banner.html?lang=en-US`, { waitUntil: 'domcontentloaded' })
  await englishPage.waitForFunction(() => document.documentElement.lang === 'en-US')
  const englishFocus = await englishPage.evaluate(() => ({
    label: document.querySelector('.focus-label')?.textContent?.trim(),
    task: document.querySelector('#taskText')?.textContent?.trim(),
    send: document.querySelector('#voiceHint')?.textContent?.trim(),
    placeholder: document.querySelector('#voiceTranscript')?.dataset?.placeholder,
  }))
  if (englishFocus.label !== 'Focus'
      || englishFocus.task !== 'Focused'
      || englishFocus.send !== '↑ Send'
      || englishFocus.placeholder !== 'Click the microphone to speak…') {
    throw new Error(`English focus banner localization failed: ${JSON.stringify(englishFocus)}`)
  }

  await englishPage.goto(`${baseUrl}/turn-trace.html?lang=en-US`, { waitUntil: 'domcontentloaded' })
  await englishPage.waitForFunction(() => document.documentElement.lang === 'en-US')
  await englishPage.waitForFunction(() => document.querySelector('#list')?.textContent?.includes('No records yet'))
  const englishTrace = await englishPage.evaluate(() => ({
    title: document.title,
    heading: document.querySelector('header h1')?.textContent?.trim(),
    refresh: document.querySelector('#refresh')?.textContent?.trim(),
    clear: document.querySelector('#clear')?.textContent?.trim(),
    empty: document.querySelector('#list')?.textContent?.trim(),
  }))
  if (englishTrace.title !== 'Turn Context Forensics · Turn Trace'
      || englishTrace.heading !== 'Turn Context Forensics'
      || englishTrace.refresh !== 'Refresh'
      || englishTrace.clear !== 'Clear records'
      || englishTrace.empty !== 'No records yet (they appear after a conversation with the Agent)') {
    throw new Error(`English turn trace localization failed: ${JSON.stringify(englishTrace)}`)
  }
  await englishPage.close()

  if (errors.length) throw new Error(`browser errors:\n${errors.join('\n')}`)

  console.log('[PASS] brain-ui smoke')
  console.log(JSON.stringify(snapshot, null, 2))
} finally {
  if (errors.length) console.error(`[brain-ui smoke diagnostics]\n${errors.join('\n')}`)
  await browser.close()
  server.closeAllSse()
  await new Promise(resolve => server.close(resolve))
}
