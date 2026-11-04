import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { jsonResponse, readJsonBody } from './api/utils.js'
const source = fs.readFileSync(new URL('./api/routes/settings.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*\n/gm, '')
  .replace(/export async function /g, 'async function ')
function harness(allowed = true) {
  const calls = []
  const context = vm.createContext({ jsonResponse, readJsonBody, AbortController,
    getSearchSettings: () => ({ connections: [{ id: 'example', configured: true }] }),
    getSearchUsage: () => ({ example: { requests: 1 } }),
    setSearchSettings: value => { calls.push(['save', value]); if (!value.connections) throw new Error('invalid'); return value },
    execModelWeb: async (name, args, options) => { calls.push(['search', args, options]); return JSON.stringify({ ok: true, provider: args.provider, results: [] }) },
    emitEvent: (...args) => calls.push(['event', ...args]),
  })
  vm.runInContext(source, context)
  return { calls, async invoke(method, path, body = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = method; req.headers = { 'content-type': 'application/json' }
    const res = new EventEmitter()
    res.writeHead = status => { res.status = status }
    res.end = body => { res.body = JSON.parse(body) }
    await context.handleSettingsRoutes(req, res, new URL(path, 'http://localhost'), { requireLocalOrToken: (_req, response) => {
      if (!allowed) jsonResponse(response, 403, { ok: false, error: 'forbidden' })
      return allowed
    } })
    return res
  } }
}
test('search settings and connection tests all require local/token authorization', async () => {
  const h = harness(false)
  for (const [method, path] of [['GET', '/settings/search'], ['POST', '/settings/search'], ['POST', '/settings/search/test']]) {
    assert.equal((await h.invoke(method, path)).status, 403)
  }
  assert.equal(h.calls.length, 0)
})
test('settings read/save uses safe summaries, emits configuration change and reports validation errors', async () => {
  const h = harness()
  assert.equal((await h.invoke('GET', '/settings/search')).body.search.connections[0].configured, true)
  assert.equal((await h.invoke('POST', '/settings/search', { connections: [] })).body.ok, true)
  assert.equal(h.calls[1][1], 'search_settings_updated')
  assert.equal((await h.invoke('POST', '/settings/search', {})).status, 400)
})
test('connection test is explicit, uses a fixed public query, returns no search content and cleans cancellation listener', async () => {
  const h = harness()
  assert.equal((await h.invoke('POST', '/settings/search/test', { provider: 'auto' })).status, 400)
  const response = await h.invoke('POST', '/settings/search/test', { provider: 'example', query: 'private supplied data' })
  assert.equal(response.body.ok, true)
  assert.equal(response.body.results, undefined)
  assert.equal(h.calls[0][1].query, 'Bailongma')
  assert.equal(response.listenerCount('close'), 0)
})
