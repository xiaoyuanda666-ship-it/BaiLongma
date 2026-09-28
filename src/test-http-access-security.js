import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createSessionCookie, hasValidSession, isTrustedRequestOrigin, hasAuthorizedAccess } from './api/request-security.js'

const token = 'http-access-test-token'
const mock = { headers: { host: '192.168.1.5:3721' }, socket: { remoteAddress: '192.168.1.20' } }
const now = Date.now()
const cookie = createSessionCookie(token, mock, now).split(';')[0]
assert(hasValidSession({ ...mock, headers: { ...mock.headers, cookie } }, token, now))
assert(!hasValidSession({ ...mock, headers: { ...mock.headers, cookie } }, token, now + 13 * 3600000))
assert(!hasValidSession({ ...mock, headers: { ...mock.headers, cookie } }, 'rotated-token', now))
assert(!hasValidSession({ ...mock, headers: { host: '192.168.1.5:9999', cookie } }, token, now))
assert(!isTrustedRequestOrigin({ ...mock, headers: { host: 'evil.example' } }))
assert(!hasAuthorizedAccess(mock, { lanEnabled: true, expectedToken: token }))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-http-security-'))
process.env.BAILONGMA_USER_DIR = tmp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
process.env.BAILONGMA_HOST = '127.0.0.1'
process.env.BAILONGMA_API_TOKEN = token
delete process.env.BAILONGMA_ALLOW_LAN
let server, closeDBForTest
function request(base, route, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${route}`, { method, headers }, res => {
      const chunks = []
      res.on('data', data => { chunks.push(data); if (route === '/events') res.destroy() })
      const finish = () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })
      res.on('end', finish)
      res.on('close', finish)
    })
    req.on('error', reject)
    req.end()
  })
}
try {
  const { startAPI } = await import('./api.js')
  // Deterministic fresh-install state, independent of development provider env.
  const { config } = await import('./config.js')
  config.needsActivation = true
  ;({ closeDBForTest } = await import('./db.js'))
  const { paths } = await import('./paths.js')
  fs.mkdirSync(path.join(paths.sandboxDir, 'audio'), { recursive: true })
  fs.writeFileSync(path.join(paths.sandboxDir, 'audio', 'security-test.mp3'), 'test audio')
  server = startAPI(0)
  await once(server, 'listening')
  process.env.BAILONGMA_ALLOW_LAN = '1'
  // Exercise the real router with deterministic LAN peer metadata on the accepted socket.
  // No dependency on a physical network interface or locally installed TLS certificate.
  server.prependListener('request', req => Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.20', configurable: true }))
  server.prependListener('upgrade', req => Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.20', configurable: true }))
  const base = `http://127.0.0.1:${server.address().port}`
  for (const route of ['/conversations', '/memories', '/events', '/audio/security-test.mp3', '/social/feishu/status']) {
    assert.equal((await request(base, route)).status, 403, route)
  }
  assert.equal((await request(base, '/message', {}, 'POST')).status, 403)
  assert.equal((await request(base, '/brain-ui')).status, 302) // Fresh install redirects to activation.
  assert.equal((await request(base, '/activation')).status, 200)
  const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-user': '?1' }
  assert.equal((await request(base, '/activation', navigation)).status, 200)
  assert.equal((await request(base, '/conversations', navigation)).status, 403)
  assert.equal((await request(base, '/activation', { ...navigation, 'sec-fetch-dest': 'iframe' })).status, 403)
  assert.equal((await request(base, '/src/ui/brain-ui/api-client.js')).status, 200)
  assert.equal((await request(base, '/auth/session', { authorization: `Bearer ${token}`, origin: 'null' }, 'POST')).status, 403)
  assert.equal((await request(base, '/social/wechat-clawbot/logout', { authorization: `Bearer ${token}`, origin: 'null' }, 'POST')).status, 403)
  assert.equal((await request(base, '/conversations', { authorization: `Bearer ${token}`, origin: 'https://evil.example' })).status, 403)
  assert.equal((await request(base, '/conversations', { authorization: `Bearer ${token}`, host: 'evil.example' })).status, 403)
  const paired = await request(base, '/auth/session', { authorization: `Bearer ${token}`, origin: base }, 'POST')
  assert.equal(paired.status, 200)
  const session = paired.headers['set-cookie'][0]
  assert.match(session, /HttpOnly; SameSite=Strict/)
  const headers = { cookie: session.split(';')[0] }
  assert.equal((await request(base, '/conversations', headers)).status, 200)
  assert.equal((await request(base, '/events', headers)).status, 200)
  assert.equal((await request(base, '/audio/security-test.mp3', headers)).body, 'test audio')
  assert.equal((await request(base, '/conversations', { ...headers, 'sec-fetch-site': 'cross-site' })).status, 403)
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/scene`, { headers, origin: base })
  await once(ws, 'open')
  ws.close()
  await once(ws, 'close')
  process.env.BAILONGMA_API_TOKEN = 'rotated-token'
  assert.equal((await request(base, '/conversations', headers)).status, 403)
  console.log('PASS HTTP/LAN routing, pairing cookie, SSE, media, WS, Origin/Host and token rotation')
} finally {
  if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)) }
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}
