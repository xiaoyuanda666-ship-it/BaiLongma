import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import test from 'node:test'
import vm from 'node:vm'
import { jsonResponse, readJsonBody } from './api/utils.js'

// Exercise the shipped handlers without starting connectors, opening the native
// database, or loading any real credentials. Persistence itself has separate tests.
const source = fs.readFileSync(new URL('./api/routes/settings.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*\n/gm, '')
  .replace(/export async function /g, 'async function ')

function createRoutes({ env = {}, allowAccess = true } = {}) {
  const state = {
    env: { ...env },
    security: { fileSandbox: true, execSandbox: true, blockedTools: [] },
    network: { allowLanAccess: false, accessEntries: [] },
    saves: [],
    restarts: [],
    saveError: null,
  }
  const context = vm.createContext({
    console,
    process: { env: state.env },
    jsonResponse,
    readJsonBody,
    emitEvent() {},
    saveLLMSettings: async updates => {
      state.saves.push({ ...updates })
      return { provider: 'custom', reasoningControl: updates.reasoningControl }
    },
    switchModel: () => { throw new Error('Capability-only settings must use saveLLMSettings') },
    pushMessage() {},
    QRCode: { toDataURL: async value => `qr:${value}` },
    getNetworkConfig: () => ({ ...state.network }),
    getSecurity: () => ({ ...state.security }),
    setSecurity: updates => {
      if (state.saveError) throw state.saveError
      state.saves.push({ ...updates })
      for (const key of ['fileSandbox', 'execSandbox', 'blockedTools']) {
        if (key in updates) state.security[key] = updates[key]
      }
      if ('allowLanAccess' in updates) {
        state.network.allowLanAccess = updates.allowLanAccess
        state.network.accessEntries = updates.allowLanAccess
          ? [{ url: 'https://192.168.1.2:3721/', certificateUrl: 'https://192.168.1.2:3721/certificate' }]
          : []
      }
      return { ...state.security }
    },
    setNetworkConfig: () => { throw new Error('Security settings must use one persistence call') },
    getSocialConfig: () => Object.fromEntries(Object.entries(state.env).map(([key, value]) => [key, { configured: !!value }])),
    setSocialConfig: updates => {
      if (state.saveError) throw state.saveError
      state.saves.push({ ...updates })
      for (const [key, value] of Object.entries(updates)) {
        if (key.startsWith('_')) continue
        const trimmed = String(value || '').trim()
        if (trimmed) state.env[key] = trimmed
        else delete state.env[key]
      }
    },
    restartConnector: async platform => { state.restarts.push(platform) },
  })
  vm.runInContext(source, context)
  return {
    state,
    async post(route, body) {
      const request = Readable.from([Buffer.from(JSON.stringify(body))])
      request.method = 'POST'
      request.headers = { 'content-type': 'application/json' }
      const response = {
        writeHead(status) { this.status = status },
        end(body) { this.body = JSON.parse(body) },
      }
      const handled = await context.handleSettingsRoutes(request, response, new URL(route, 'http://localhost'), {
        requireLocalOrToken: (_req, res) => {
          if (!allowAccess) jsonResponse(res, 403, { ok: false, error: 'forbidden' })
          return allowAccess
        },
      })
      assert.equal(handled, true)
      return response
    },
  }
}

test('model route forwards an explicit gateway reasoning capability even without other changes', async () => {
  const routes = createRoutes()
  const result = await routes.post('/settings/model', { reasoningControl: 'effort' })
  assert.equal(result.status, 200)
  assert.equal(result.body.reasoningControl, 'effort')
  assert.equal(routes.state.saves.length, 1)
  assert.equal(routes.state.saves[0].reasoningControl, 'effort')
})

test('security and LAN settings save together and retain the restart hint with QR codes', async () => {
  const routes = createRoutes()
  const updates = { fileSandbox: false, execSandbox: false, allowLanAccess: true }
  const result = await routes.post('/settings/security', updates)
  assert.equal(result.status, 200)
  assert.deepEqual(routes.state.saves, [updates])
  assert.equal(result.body.security.fileSandbox, false)
  assert.equal(result.body.network.allowLanAccess, true)
  assert.equal(result.body.network.restartRequired, true)
  assert.match(result.body.network.accessEntries[0].qrDataUrl, /^qr:https:/)
  assert.match(result.body.network.accessEntries[0].certificateQrDataUrl, /^qr:https:/)

  const unchanged = await routes.post('/settings/security', { execSandbox: true })
  assert.equal(unchanged.body.network.allowLanAccess, true)
  assert.equal(unchanged.body.network.restartRequired, false)

  const disabled = await routes.post('/settings/security', { allowLanAccess: false })
  assert.equal(disabled.body.network.allowLanAccess, false)
  assert.equal(disabled.body.network.restartRequired, true)
})

test('failed or unauthorized security saves do not commit settings or report success', async () => {
  const routes = createRoutes()
  routes.state.saveError = new Error('disk write failed')
  const failed = await routes.post('/settings/security', { fileSandbox: false, allowLanAccess: true })
  assert.equal(failed.status, 400)
  assert.equal(failed.body.ok, false)
  assert.equal(failed.body.error, 'disk write failed')
  assert.equal(routes.state.security.fileSandbox, true)
  assert.equal(routes.state.network.allowLanAccess, false)
  assert.equal(routes.state.saves.length, 0)

  const unauthorized = createRoutes({ allowAccess: false })
  const denied = await unauthorized.post('/settings/security', { allowLanAccess: true })
  assert.equal(denied.status, 403)
  assert.equal(unauthorized.state.saves.length, 0)
})

test('unchanged partial social updates do not restart existing connections', async () => {
  const routes = createRoutes({
    env: { FEISHU_APP_ID: 'app-id', FEISHU_APP_SECRET: 'app-secret', DISCORD_BOT_TOKEN: 'discord-token' },
  })
  for (const body of [
    { FEISHU_APP_ID: 'app-id' },
    { FEISHU_APP_SECRET: ' app-secret ' },
    { DISCORD_BOT_TOKEN: ' discord-token ' },
    { FEISHU_VERIFICATION_TOKEN: 'verification-token' },
  ]) {
    assert.equal((await routes.post('/settings/social', body)).status, 200)
  }
  assert.deepEqual(routes.state.restarts, [])
})

test('changed or cleared social credentials restart only the affected connectors', async () => {
  const routes = createRoutes({
    env: { FEISHU_APP_ID: 'app-id', FEISHU_APP_SECRET: 'app-secret', DISCORD_BOT_TOKEN: 'discord-token' },
  })
  assert.equal((await routes.post('/settings/social', { FEISHU_APP_SECRET: 'new-secret' })).status, 200)
  assert.deepEqual(routes.state.restarts, ['feishu'])
  routes.state.restarts.length = 0

  const cleared = await routes.post('/settings/social', { DISCORD_BOT_TOKEN: '', FEISHU_APP_SECRET: '' })
  assert.equal(cleared.status, 200)
  assert.deepEqual(routes.state.restarts, ['discord', 'feishu'])
  assert.equal(routes.state.env.DISCORD_BOT_TOKEN, undefined)
  assert.equal(routes.state.env.FEISHU_APP_SECRET, undefined)
})

test('explicit social actions are honored without restarting Feishu twice', async () => {
  const routes = createRoutes({ env: { FEISHU_APP_ID: 'app-id', FEISHU_APP_SECRET: 'app-secret' } })
  await routes.post('/settings/social', { FEISHU_APP_ID: '', FEISHU_APP_SECRET: '', _feishu_disconnect: '1' })
  assert.deepEqual(routes.state.restarts, ['feishu'])
  routes.state.restarts.length = 0
  await routes.post('/settings/social', { _clawbot_connect: '1' })
  assert.deepEqual(routes.state.restarts, ['wechat-clawbot'])
})

test('failed social saves leave active connections alone', async () => {
  const routes = createRoutes({ env: { DISCORD_BOT_TOKEN: 'existing-token' } })
  routes.state.saveError = new Error('disk write failed')
  const failed = await routes.post('/settings/social', { DISCORD_BOT_TOKEN: 'replacement-token' })
  assert.equal(failed.status, 400)
  assert.equal(failed.body.ok, false)
  assert.equal(routes.state.env.DISCORD_BOT_TOKEN, 'existing-token')
  assert.deepEqual(routes.state.restarts, [])
})
