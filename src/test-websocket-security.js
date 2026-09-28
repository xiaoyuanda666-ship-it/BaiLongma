import assert from 'assert/strict'
import http from 'http'
import { WebSocket, WebSocketServer } from 'ws'
import {
  WS_TOKEN_PROTOCOL_PREFIX,
  WS_PUBLIC_PROTOCOL,
  attachWebSocketIdleTimeout,
  authorizeWebSocketUpgrade,
  rejectWebSocketUpgrade,
  selectWebSocketProtocol,
} from './api/websocket-security.js'

const TEST_TOKEN = 'ws-security-test-secret'
let passed = 0

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  PASS ${name}`)
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`)
    throw err
  }
}

function mockRequest(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers: { host: headers.origin && headers.origin !== 'null' ? new URL(headers.origin).host : '127.0.0.1:3721', ...headers } }
}

function authorize(pathname, remoteAddress, headers = {}, options = {}) {
  return authorizeWebSocketUpgrade(mockRequest(remoteAddress, headers), {
    pathname,
    lanEnabled: options.lanEnabled ?? true,
    expectedToken: options.expectedToken ?? TEST_TOKEN,
  })
}

function connect(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function rejectedStatus(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options)
    ws.once('unexpected-response', (_req, res) => {
      res.resume()
      resolve(res.statusCode)
    })
    ws.once('open', () => reject(new Error('connection unexpectedly opened')))
    ws.once('error', () => {})
  })
}

function waitForClose(ws, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs)
    ws.once('close', (code) => { clearTimeout(timer); resolve(code) })
  })
}

async function createTestServer() {
  const server = http.createServer()
  const sceneWss = new WebSocketServer({ noServer: true, maxPayload: 128, handleProtocols: selectWebSocketProtocol })
  const voiceWss = new WebSocketServer({ noServer: true, maxPayload: 128, handleProtocols: selectWebSocketProtocol })
  const routes = new Map([['/scene', sceneWss], ['/voice/cloud', voiceWss]])

  sceneWss.on('connection', (ws) => ws.on('error', () => {}))
  voiceWss.on('connection', (ws) => {
    ws.on('error', () => {})
    attachWebSocketIdleTimeout(ws, 80)
  })
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname
    const target = routes.get(pathname)
    const auth = authorizeWebSocketUpgrade(req, {
      pathname,
      lanEnabled: true,
      expectedToken: TEST_TOKEN,
      knownPaths: new Set(routes.keys()),
    })
    if (!auth.ok || !target) return rejectWebSocketUpgrade(socket, auth.status)
    target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    close: async () => {
      for (const wss of [sceneWss, voiceWss]) for (const ws of wss.clients) ws.terminate()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

async function main() {
  const fixture = await createTestServer()
  try {
    await test('loopback /scene succeeds', async () => {
      const ws = await connect(`${fixture.url}/scene`)
      ws.close()
    })

    await test('loopback /voice/cloud succeeds', async () => {
      const encoded = Buffer.from(TEST_TOKEN).toString('base64url')
      const ws = await connect(`${fixture.url}/voice/cloud`, [WS_PUBLIC_PROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}${encoded}`])
      assert.equal(ws.protocol, WS_PUBLIC_PROTOCOL)
      ws.close()
    })

    await test('invalid Origin is rejected with 403', async () => {
      assert.equal(await rejectedStatus(`${fixture.url}/scene`, { origin: 'https://evil.example' }), 403)
      assert.equal(authorize('/voice/cloud', '192.168.1.20', {
        origin: 'https://evil.example', authorization: `Bearer ${TEST_TOKEN}`,
      }).reason, 'forbidden_origin')
    })

    await test('opaque browser origins are rejected even on loopback', async () => {
      assert.equal(await rejectedStatus(`${fixture.url}/scene`, { origin: 'null' }), 403)
      assert.equal(authorize('/scene', '127.0.0.1', { origin: 'http://localhost:8888', host: '127.0.0.1:3721' }).ok, false)
    })

    await test('non-loopback request without Token is rejected', () => {
      assert.equal(authorize('/scene', '192.168.1.20', { origin: 'http://192.168.1.5:3721' }).ok, false)
      assert.equal(authorize('/voice/cloud', '192.168.1.20', { origin: 'http://192.168.1.5:3721' }).ok, false)
    })

    await test('non-loopback request with wrong Token is rejected', () => {
      const result = authorize('/voice/cloud', '192.168.1.20', {
        origin: 'http://192.168.1.5:3721', authorization: 'Bearer wrong-length-token',
      })
      assert.deepEqual(result, { ok: false, status: 403, reason: 'forbidden' })
    })

    await test('non-loopback request with correct Token follows LAN policy', () => {
      const headers = { origin: 'http://192.168.1.5:3721', authorization: `Bearer ${TEST_TOKEN}` }
      assert.equal(authorize('/scene', '192.168.1.20', headers).ok, true)
      assert.equal(authorize('/voice/cloud', '192.168.1.20', headers).ok, true)
      assert.equal(authorize('/voice/cloud', '192.168.1.20', headers, { lanEnabled: false }).ok, false)

      const encoded = Buffer.from(TEST_TOKEN).toString('base64url')
      assert.equal(authorize('/voice/cloud', '192.168.1.20', {
        origin: 'http://192.168.1.5:3721',
        'sec-websocket-protocol': `app-protocol, ${WS_TOKEN_PROTOCOL_PREFIX}${encoded}`,
      }).ok, true)
      assert.equal(selectWebSocketProtocol(new Set([`${WS_TOKEN_PROTOCOL_PREFIX}${encoded}`])), false)
      assert.equal(selectWebSocketProtocol(new Set([`${WS_TOKEN_PROTOCOL_PREFIX}${encoded}`, WS_PUBLIC_PROTOCOL])), WS_PUBLIC_PROTOCOL)
      assert.equal(authorize('/scene', '::1', { origin: 'http://[::1]:3721' }).ok, true)
    })

    await test('unknown WebSocket path is closed', async () => {
      assert.equal(await rejectedStatus(`${fixture.url}/not-a-websocket`), 404)
    })

    await test('Token is absent from logs and rejection response', () => {
      const captured = []
      const originalError = console.error
      console.error = (...args) => captured.push(args.join(' '))
      let response = ''
      try {
        const result = authorize('/voice/cloud', '192.168.1.20', {
          origin: 'http://192.168.1.5:3721', authorization: `Bearer ${TEST_TOKEN}x`,
        })
        const socket = { write: chunk => { response += chunk }, destroy() {} }
        rejectWebSocketUpgrade(socket, result.status)
      } finally {
        console.error = originalError
      }
      assert.equal(captured.join('\n').includes(TEST_TOKEN), false)
      assert.equal(response.includes(TEST_TOKEN), false)
      assert.match(response, /^HTTP\/1\.1 403 Forbidden/)
    })

    await test('oversized message is closed and voice idle connection is reclaimed', async () => {
      const oversized = await connect(`${fixture.url}/voice/cloud`)
      const oversizedClosed = waitForClose(oversized)
      oversized.send(Buffer.alloc(129))
      assert.equal(await oversizedClosed, 1009)

      const idle = await connect(`${fixture.url}/voice/cloud`)
      assert.equal(await waitForClose(idle), 1006)
    })
  } finally {
    await fixture.close()
  }

  console.log(`\nWebSocket security: ${passed} passed, 0 failed`)
}

main().catch(() => { process.exitCode = 1 })
