import http from 'http'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { pushMessage } from './queue.js'
import { getDB, getConfig, setConfig } from './db.js'
import { emitEvent, addSSEClient, removeSSEClient } from './events.js'
import { getQuotaStatus } from './quota.js'
import { isRunning, stopLoop, startLoop } from './control.js'

export { emitEvent }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INDEX_PATH     = path.join(__dirname, '../index.html')
const DASHBOARD_PATH = path.join(__dirname, '../dashboard.html')
const BRAIN_PATH     = path.join(__dirname, '../brain.html')
const BRAIN_UI_PATH  = path.join(__dirname, '../brain-ui.html')
const BRAIN_UI_ASSET_ROOT = path.join(__dirname, 'ui', 'brain-ui')
const SANDBOX_PATH   = path.join(__dirname, '../sandbox')
const DEFAULT_AGENT_NAME = 'Longma'

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'text/plain; charset=utf-8'
  }
}

function getAgentName() {
  return (getConfig('agent_name') || '').trim() || DEFAULT_AGENT_NAME
}

function extractAgentRename(content) {
  const text = String(content || '').trim()
  if (!text) return null

  const intentPatterns = [
    /叫你/i,
    /你.*叫/i,
    /改名/i,
    /改个?名字/i,
    /换个?名字/i,
    /名字.*改/i,
    /name\s+is\s+now/i,
    /call\s+you/i,
    /rename\s+you/i,
    /自称/i,
    /对外.*叫/i,
    /别叫/i,
    /不要叫/i,
    /换个称呼/i,
    /给你.*起个?名字/i,
    /给你.*换个?名字/i,
  ]
  if (!intentPatterns.some((pattern) => pattern.test(text))) return null

  const normalizeName = (raw) => {
    const cleaned = String(raw || "")
      .trim()
      .replace(/^[“"'`「『【（(]+/, "")
      .replace(/[”"'`」』】）),。.!！？；;：:\s]+$/g, "")
      .replace(/\s+/g, " ")

    if (!cleaned) return null
    if (cleaned.length > 32) return null
    if (/^(你|我|我们|以后|之后|现在|一下|一个|这个|那个|名字|名称|称呼)$/i.test(cleaned)) return null
    if (!/^[\u4e00-\u9fa5A-Za-z0-9 _-]+$/.test(cleaned)) return null
    return cleaned
  }

  const rejectName = (name) => {
    const lowered = String(name || '').toLowerCase()
    return (
      /^(一下|一个|这个|那个|以后|现在|名字|名称|称呼|自己|原来|之前|刚才|以后吧)$/.test(name) ||
      /^(name|called|call|rename|my|your|you|me|it)$/.test(lowered)
    )
  }

  const tryName = (raw) => {
    const normalized = normalizeName(raw)
    if (!normalized || rejectName(normalized)) return null
    return normalized
  }

  const capturePatterns = [
    /(?:以后|之后|从现在起|从今以后)?(?:你|你以后|以后你)(?:就|还是|直接)?叫(?:做)?\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:把你|给你|帮你)(?:的名字|名字)?(?:改成|改为|换成|换做)\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:以后)?(?:我|我们)(?:就)?叫你\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:你的名字|你名字)(?:是|叫|改成|改为)\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:以后|之后|从现在起)?(?:称呼你|管你叫)\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:以后|之后)?(?:你)?(?:对外|今后)?(?:就)?自称\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:以后|之后)?(?:别|不要)(?:再)?叫(?:自己)?\s*[“"'`「『【（(]?\s*[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31}[”"'`」』】）)]?\s*(?:了)?[，,。.!！？；;\s]*(?:以后|现在|之后)?(?:就)?叫(?:自己|你)?\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:我想|我想要|我准备|我要)?(?:给你|帮你)(?:重新|再)?(?:起|取|换)(?:个)?名字(?:叫|是|为)?\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:把|将)(?:你的名字|你)(?:从)?\s*[“"'`「『【（(]?\s*[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31}[”"'`」』】）)]?\s*(?:改|换)(?:成|为)\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:以后|之后|从现在起)?(?:对外)?(?:你|你自己)?(?:就)?叫\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /your name is now\s+[“"'`(]?\s*([A-Za-z][A-Za-z0-9 _-]{0,31})/i,
    /i(?:'ll| will)? call you\s+[“"'`(]?\s*([A-Za-z][A-Za-z0-9 _-]{0,31})/i,
    /rename you to\s+[“"'`(]?\s*([A-Za-z][A-Za-z0-9 _-]{0,31})/i,
    /don't call yourself\s+[“"'`]?[A-Za-z][A-Za-z0-9 _-]{0,31}[”"'`]?\s*(?:anymore)?[, ]*(?:call yourself|be)\s+[“"'`]?\s*([A-Za-z][A-Za-z0-9 _-]{0,31})/i,
  ]

  for (const pattern of capturePatterns) {
    const match = text.match(pattern)
    if (!match) continue
    const nextName = tryName(match[1])
    if (nextName) return nextName
  }

  const colonMatch = text.match(/(?:名字|名称|称呼)[是为:：]\s*[“"'`「『【（(]?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i)
  if (colonMatch) {
    const nextName = tryName(colonMatch[1])
    if (nextName) return nextName
  }

  const quotedNames = [...text.matchAll(/[“"'`「『【（(]\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})\s*[”"'`」』】）)]/g)]
    .map((match) => tryName(match[1]))
    .filter(Boolean)
  if (quotedNames.length === 1) return quotedNames[0]

  const semanticWindows = [
    /(?:改名|换名字|换个名字|换个称呼|起个名字|取个名字|自称|对外叫)\s*(?:叫|成|为|是)?\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
    /(?:以后|之后|从现在起).{0,12}?(?:叫|自称|称呼).{0,4}?([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 _-]{0,31})/i,
  ]
  for (const pattern of semanticWindows) {
    const match = text.match(pattern)
    if (!match) continue
    const nextName = tryName(match[1])
    if (nextName) return nextName
  }

  return null
}

export function startAPI(port = 3721) {
  const server = http.createServer((req, res) => {
    const base = `http://localhost:${port}`
    const url = new URL(req.url, base)

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // POST /message — 发消息给意识体
    if (req.method === 'POST' && url.pathname === '/message') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8')
          const { from_id = 'ID:000001', content, channel = 'API' } = JSON.parse(body)
          if (!content?.trim()) return jsonResponse(res, 400, { error: 'content required' })
          const trimmed = content.trim()
          const renamedTo = extractAgentRename(trimmed)
          if (renamedTo) {
            setConfig('agent_name', renamedTo)
            emitEvent('agent_name_updated', { name: renamedTo })
          }
          pushMessage(from_id, trimmed, channel)
          emitEvent('message_in', { from_id, content: trimmed, channel, timestamp: new Date().toISOString() })
          jsonResponse(res, 200, { ok: true, agent_name: getAgentName() })
        } catch (e) {
          jsonResponse(res, 400, { error: e.message })
        }
      })
      return
    }

    // GET /events — SSE 实时事件流（双向通讯的出口）
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(`data: ${JSON.stringify({ type: 'connected', ts: new Date().toISOString() })}\n\n`)
      addSSEClient(res)
      const keepAlive = setInterval(() => {
        try { res.write(': ping\n\n') } catch (_) { clearInterval(keepAlive); removeSSEClient(res) }
      }, 15000)
      req.on('close', () => {
        clearInterval(keepAlive)
        removeSSEClient(res)
      })
      return
    }

    // GET /memories?limit=20&search=keyword
    if (req.method === 'GET' && url.pathname === '/memories') {
      const db = getDB()
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100)
      const search = url.searchParams.get('search')
      let rows
      if (search) {
        try {
          rows = db.prepare(`
            SELECT m.* FROM memories m
            JOIN memories_fts ON memories_fts.rowid = m.id
            WHERE memories_fts MATCH ?
            ORDER BY bm25(memories_fts), m.created_at DESC LIMIT ?
          `).all(search, limit)
        } catch {
          rows = db.prepare(`SELECT * FROM memories WHERE content LIKE ? OR detail LIKE ? ORDER BY created_at DESC LIMIT ?`)
            .all(`%${search}%`, `%${search}%`, limit)
        }
      } else {
        rows = db.prepare('SELECT * FROM memories ORDER BY created_at DESC LIMIT ?').all(limit)
      }
      jsonResponse(res, 200, rows)
      return
    }

    // GET /conversations?limit=60 — 聊天记录（按时间升序，最新的在最后）
    if (req.method === 'GET' && url.pathname === '/conversations') {
      const db = getDB()
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '60'), 500)
      const rows = db.prepare(`
        SELECT id, role, from_id, to_id, content, timestamp
        FROM conversations
        ORDER BY id DESC
        LIMIT ?
      `).all(limit)
      jsonResponse(res, 200, rows.reverse())
      return
    }

    // GET /status
    if (req.method === 'GET' && url.pathname === '/status') {
      const db = getDB()
      const { n } = db.prepare('SELECT COUNT(*) as n FROM memories').get()
      jsonResponse(res, 200, { ok: true, memory_count: n, running: isRunning() })
      return
    }

    // GET /quota
    if (req.method === 'GET' && url.pathname === '/quota') {
      jsonResponse(res, 200, getQuotaStatus())
      return
    }

    if (req.method === 'GET' && url.pathname === '/agent-profile') {
      jsonResponse(res, 200, { name: getAgentName() })
      return
    }

    // GET /favicon.ico ? silence the browser's automatic favicon request
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }

    // DELETE /memories/:id — 删除记忆
    if (req.method === 'DELETE' && url.pathname.startsWith('/memories/')) {
      const id = parseInt(url.pathname.split('/')[2])
      if (!id) return jsonResponse(res, 400, { error: 'invalid id' })
      const db = getDB()
      db.prepare('DELETE FROM memories WHERE id = ?').run(id)
      jsonResponse(res, 200, { ok: true })
      return
    }

    // PATCH /memories/:id — 修改记忆 content/detail
    if (req.method === 'PATCH' && url.pathname.startsWith('/memories/')) {
      const id = parseInt(url.pathname.split('/')[2])
      if (!id) return jsonResponse(res, 400, { error: 'invalid id' })
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        try {
          const { content, detail } = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
          const db = getDB()
          if (content !== undefined) db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(content, id)
          if (detail !== undefined) db.prepare('UPDATE memories SET detail = ? WHERE id = ?').run(detail, id)
          jsonResponse(res, 200, { ok: true })
        } catch (e) {
          jsonResponse(res, 400, { error: e.message })
        }
      })
      return
    }

    // GET /audio/:filename — 提供 sandbox 音频文件
    if (req.method === 'GET' && url.pathname.startsWith('/audio/')) {
      const filename = path.basename(url.pathname)
      const filePath = path.join(SANDBOX_PATH, 'audio', filename)
      try {
        const stat = fs.statSync(filePath)
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache',
        })
        fs.createReadStream(filePath).pipe(res)
      } catch {
        res.writeHead(404)
        res.end('audio not found')
      }
      return
    }

    // GET / — Dashboard
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      try {
        const html = fs.readFileSync(INDEX_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('index.html not found')
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/dashboard.html') {
      try {
        const html = fs.readFileSync(DASHBOARD_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('dashboard.html not found')
      }
      return
    }

    // GET /brain.html — Brain Monitor
    if (req.method === 'GET' && url.pathname === '/brain.html') {
      try {
        const html = fs.readFileSync(BRAIN_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('brain.html not found')
      }
      return
    }

    // GET /brain-ui — Brain UI（记忆图谱 + 思考流 + 聊天）
    if (req.method === 'GET' && (url.pathname === '/brain-ui' || url.pathname === '/brain-ui.html')) {
      try {
        const html = fs.readFileSync(BRAIN_UI_PATH, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch {
        res.writeHead(404)
        res.end('brain-ui.html not found')
      }
      return
    }

    if (req.method === 'GET' && url.pathname.startsWith('/src/ui/brain-ui/')) {
      const relativePath = decodeURIComponent(url.pathname.slice('/src/ui/brain-ui/'.length))
      const assetRoot = path.resolve(BRAIN_UI_ASSET_ROOT)
      const assetPath = path.resolve(BRAIN_UI_ASSET_ROOT, relativePath)

      if (!assetPath.startsWith(assetRoot + path.sep)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }

      try {
        const stat = fs.statSync(assetPath)
        if (!stat.isFile()) {
          res.writeHead(404)
          res.end('asset not found')
          return
        }

        res.writeHead(200, {
          'Content-Type': contentTypeFor(assetPath),
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache',
        })
        fs.createReadStream(assetPath).pipe(res)
      } catch {
        res.writeHead(404)
        res.end('asset not found')
      }
      return
    }

    // POST /admin/stop — 暂停意识循环（保留 HTTP 服务）
    if (req.method === 'POST' && url.pathname === '/admin/stop') {
      stopLoop()
      emitEvent('admin', { action: 'stop', running: false })
      jsonResponse(res, 200, { ok: true, running: false })
      return
    }

    // POST /admin/start — 恢复意识循环
    if (req.method === 'POST' && url.pathname === '/admin/start') {
      startLoop()
      emitEvent('admin', { action: 'start', running: true })
      jsonResponse(res, 200, { ok: true, running: true })
      return
    }

    // POST /admin/restart — 重启 Jarvis 进程（spawn 新进程后退出）
    if (req.method === 'POST' && url.pathname === '/admin/restart') {
      jsonResponse(res, 200, { ok: true, message: '正在重启…' })
      setTimeout(() => {
        const child = spawn('npm', ['start'], {
          cwd: path.join(__dirname, '../'),
          detached: true,
          stdio: 'ignore',
          shell: true,
        })
        child.unref()
        process.exit(0)
      }, 500)
      return
    }

    // POST /admin/reset-memories — 清除所有记忆和对话
    if (req.method === 'POST' && url.pathname === '/admin/reset-memories') {
      const db = getDB()
      db.prepare('DELETE FROM memories').run()
      db.prepare('DELETE FROM conversations').run()
      db.prepare("DELETE FROM config WHERE key != 'birth_time'").run()
      db.prepare('DELETE FROM entities').run()
      db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
      emitEvent('admin', { action: 'reset-memories' })
      jsonResponse(res, 200, { ok: true })
      return
    }

    // POST /admin/reset-files — 清除 sandbox 用户文件（保留 readme.txt、world.txt）
    if (req.method === 'POST' && url.pathname === '/admin/reset-files') {
      const sandboxPath = path.join(__dirname, '../sandbox')
      const KEEP = new Set(['readme.txt', 'world.txt'])
      function clearDir(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            clearDir(full)
            try { fs.rmdirSync(full) } catch (_) {}
          } else if (!KEEP.has(entry.name.toLowerCase())) {
            fs.unlinkSync(full)
          }
        }
      }
      try { clearDir(sandboxPath) } catch (_) {}
      emitEvent('admin', { action: 'reset-files' })
      jsonResponse(res, 200, { ok: true })
      return
    }

    jsonResponse(res, 404, { error: 'not found' })
  })

  server.listen(port, '0.0.0.0', () => {
    console.log(`[API] 监听 http://127.0.0.1:${port}`)
    console.log(`[API]   POST /message  — 发消息给意识体`)
    console.log(`[API]   GET  /events   — SSE 实时流（接收意识体消息）`)
    console.log(`[API]   GET  /memories — 查询记忆`)
    console.log(`[API]   GET  /status   — 状态`)
  })

  return server
}
