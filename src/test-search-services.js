import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, after, beforeEach } from 'node:test'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-search-routing-'))
process.env.BAILONGMA_USER_DIR = dir
for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY']) delete process.env[key]
const { config } = await import('./config.js')
const { getSearchSettings, setSearchSettings, getSearchConfig, resolveSearchConnection } = await import('./search/connections.js')
const { execModelWeb } = await import('./search/service.js')
const { selectSearchRoute } = await import('./search/router.js')
const { getSearchUsage } = await import('./search/http.js')
const { getDB, closeDBForTest } = await import('./db/connection.js')
after(() => { closeDBForTest(); fs.rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => {
  fs.rmSync(path.join(dir, 'search-services.json'), { force: true })
  Object.assign(config, { provider: 'deepseek', apiKey: 'model-key', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-pro' })
})
function setup(extra = {}) {
  const discovered = getSearchSettings()
  return setSearchSettings({ ...discovered, connections: [...discovered.connections, {
    id: 'yuanbao-personal', name: '元宝', adapter: 'tencent-yuanbao', enabled: true,
    credentialSource: 'secret', apiKey: 'yuanbao-key',
  }], ...extra })
}
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const deepseekReply = () => reply({ results: [{ title: 'Example', url: 'https://example.com/', content: 'page text' }] })
const yuanbaoReply = () => reply({ Response: { Pages: [JSON.stringify({ title: 'Example', url: 'https://example.com/', passage: 'snippet', content: 'dynamic snippet', date: '2026-11-01 10:00:00' })] } })

test('discovers official model credentials; search remains independent of chat switching and key rotation', () => {
  const settings = setup({ defaultProvider: 'yuanbao-personal' })
  assert.equal(settings.connections[0].credentialSource, 'llm')
  assert.equal(JSON.stringify(settings).includes('yuanbao-key'), false)
  assert.equal(fs.readFileSync(path.join(dir, 'search-services.json'), 'utf8').includes('yuanbao-key'), false)
  assert.equal(JSON.stringify(getDB().prepare('SELECT * FROM search_service_secrets').all()).includes('yuanbao-key'), false)
  assert.equal(fs.existsSync(path.join(dir, 'data/api-capability-secrets.json')), false)
  config.apiKey = 'rotated'
  assert.equal(resolveSearchConnection(getSearchConfig().connections[0]).apiKey, 'rotated')
  Object.assign(config, { provider: 'minimax', apiKey: 'other' })
  assert.equal(selectSearchRoute(getSearchConfig(), { query: 'AI' }).connections[0].id, 'yuanbao-personal')
})

test('disabled discovered connections stay disabled and removed discovered connections do not resurrect', () => {
  const settings = getSearchSettings()
  settings.connections[0].enabled = false
  setSearchSettings(settings)
  assert.equal(selectSearchRoute(getSearchConfig()).connections.length, 0)
  setSearchSettings({ ...getSearchSettings(), connections: [] })
  assert.equal(getSearchSettings().connections[0].enabled, false)
})

test('third-party chat proxy credentials are never sent to official search endpoints', () => {
  config.baseURL = 'https://proxy.example/v1'
  assert.equal(getSearchSettings().connections.length, 0)
  assert.throws(() => setSearchSettings({ connections: [{ id: 'proxy', adapter: 'deepseek', enabled: true, credentialSource: 'secret', baseURL: 'https://proxy.example/v1' }] }), /官方/)
})

test('routing precedence: explicit, task preference, ordered rules, default; aliases remain compatible', () => {
  const settings = setup({ defaultProvider: 'llm-deepseek', rules: [
    { field: 'topic', value: 'news', provider: 'yuanbao-personal' },
    { field: 'language', value: 'zh', provider: 'llm-deepseek' },
  ] })
  const route = (args, context) => selectSearchRoute(settings, args, context).connections[0]?.id
  assert.equal(route({ query: '新闻', topic: 'news' }), 'yuanbao-personal')
  assert.equal(route({ query: '新闻', topic: 'news', provider: 'deepseek' }), 'llm-deepseek')
  assert.equal(route({ query: '新闻', topic: 'news' }, { searchProvider: 'llm-deepseek' }), 'llm-deepseek')
  assert.equal(route({ query: 'hello' }), 'llm-deepseek')
  assert.equal(route({ query: 'hello', provider: 'missing' }), undefined)
})

test('Yuanbao wire protocol, separate credentials, dynamic snippets and unknown dates are preserved', async () => {
  setup({ defaultProvider: 'yuanbao-personal' })
  const result = JSON.parse(await execModelWeb('web_search', { query: 'news', domains: ['example.com'], date_from: '2026-11-01' }, {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.wsa.cloud.tencent.com/SearchPro')
      assert.equal(options.headers.Authorization, 'Bearer yuanbao-key')
      assert.deepEqual(JSON.parse(options.body), { Query: 'news', Site: 'example.com' })
      return yuanbaoReply()
    },
  }))
  assert.equal(result.ok, true)
  assert.equal(result.provider, 'yuanbao-personal')
  assert.equal(result.results[0].evidence_kind, 'search_snippet')
  assert.equal(result.results[0].content, '')
  assert.equal(result.results[0].date_status, 'unknown')
  assert.ok(result.warnings.length)
  assert.ok(getSearchUsage()['yuanbao-personal'].requests > 0)
})

test('failover is opt-in, bounded, and reports attempts; explicit selection does not switch', async () => {
  setup({ fallback: { enabled: true, providers: ['yuanbao-personal'] } })
  const fetchImpl = async url => url.includes('deepseek') ? reply({ error: { message: 'busy' } }, 429) : yuanbaoReply()
  const result = JSON.parse(await execModelWeb('web_search', { query: 'AI' }, { fetchImpl }))
  assert.equal(result.ok, true)
  assert.equal(result.fallback_used, true)
  assert.equal(result.attempts.length, 2)
  const explicit = JSON.parse(await execModelWeb('web_search', { query: 'AI', provider: 'deepseek' }, { fetchImpl }))
  assert.equal(explicit.ok, false)
  assert.equal(explicit.attempts.length, 1)
})

test('authentication failures, empty results and cancellation never cause automatic failover', async () => {
  setup({ fallback: { enabled: true, providers: ['yuanbao-personal'] } })
  let calls = 0
  const bad = JSON.parse(await execModelWeb('web_search', { query: 'AI' }, { fetchImpl: async () => { calls++; return reply({ error: { message: 'bad model-key' } }, 401) } }))
  assert.equal(calls, 1)
  assert.equal(JSON.stringify(bad).includes('model-key'), false)
  const empty = JSON.parse(await execModelWeb('web_search', { query: 'AI' }, { fetchImpl: async () => reply({ results: [] }) }))
  assert.equal(empty.ok, true)
  assert.equal(empty.attempts.length, 1)
  const controller = new AbortController()
  await assert.rejects(() => execModelWeb('web_search', { query: 'AI' }, {
    signal: controller.signal, fetchImpl: async () => { controller.abort(); throw new Error('cancelled') },
  }))
})

test('strict content requirement rejects snippet-only services before billing', async () => {
  setup()
  let calls = 0
  const result = JSON.parse(await execModelWeb('web_search', { query: 'AI', provider: 'yuanbao-personal', require_content: true }, { fetchImpl: async () => { calls++; return yuanbaoReply() } }))
  assert.equal(result.ok, false)
  assert.equal(calls, 0)
})

test('blank keys preserve secrets; replacement is scoped to connection and invalid saves are atomic', () => {
  const settings = setup()
  settings.connections[1].apiKey = ''
  setSearchSettings(settings)
  assert.equal(resolveSearchConnection(getSearchConfig().connections[1]).apiKey, 'yuanbao-key')
  settings.connections[1].apiKey = 'replacement'
  settings.defaultProvider = 'missing'
  assert.throws(() => setSearchSettings(settings), /默认/)
  assert.equal(resolveSearchConnection(getSearchConfig().connections[1]).apiKey, 'yuanbao-key')
  settings.defaultProvider = 'auto'
  settings.connections[1].clearKey = true
  settings.connections[1].apiKey = ''
  setSearchSettings(settings)
  assert.equal(resolveSearchConnection(getSearchConfig().connections[1]), null)
})

test('corrupt configuration fails closed and invalid requests do not send network traffic', async () => {
  setup()
  let calls = 0
  const result = JSON.parse(await execModelWeb('web_search', { query: '', provider: 'yuanbao-personal' }, { fetchImpl: async () => { calls++; return deepseekReply() } }))
  assert.equal(result.ok, false)
  assert.equal(calls, 0)
  fs.writeFileSync(path.join(dir, 'search-services.json'), '{bad')
  assert.throws(() => getSearchSettings())
})

test('failed configuration commit rolls encrypted credentials back', () => {
  const settings = setup()
  settings.connections[1].apiKey = 'must-not-commit'
  const original = fs.renameSync
  fs.renameSync = (from, to) => {
    if (to === path.join(dir, 'search-services.json')) throw new Error('simulated disk failure')
    return original(from, to)
  }
  try { assert.throws(() => setSearchSettings(settings), /simulated disk failure/) }
  finally { fs.renameSync = original }
  assert.equal(resolveSearchConnection(getSearchConfig().connections[1]).apiKey, 'yuanbao-key')
})

test('multiple accounts for one adapter keep independent credentials and stable explicit IDs', async () => {
  const settings = setup()
  settings.connections.push({ ...settings.connections[1], id: 'yuanbao-work', apiKey: 'work-key' })
  setSearchSettings(settings)
  const result = JSON.parse(await execModelWeb('web_search', { query: 'AI', provider: 'yuanbao-work' }, {
    fetchImpl: async (_url, options) => { assert.equal(options.headers.Authorization, 'Bearer work-key'); return yuanbaoReply() },
  }))
  assert.equal(result.provider, 'yuanbao-work')
  assert.equal(resolveSearchConnection(getSearchConfig().connections[1]).apiKey, 'yuanbao-key')
})

test('non-JSON HTTP timeout responses still use the configured fallback', async () => {
  setup({ fallback: { enabled: true, providers: ['yuanbao-personal'] } })
  const result = JSON.parse(await execModelWeb('web_search', { query: 'AI' }, {
    fetchImpl: async url => url.includes('deepseek')
      ? { ok: false, status: 408, json: async () => { throw new Error('HTML timeout page') } }
      : yuanbaoReply(),
  }))
  assert.equal(result.ok, true)
  assert.equal(result.fallback_used, true)
  assert.equal(result.attempts.length, 2)
})
