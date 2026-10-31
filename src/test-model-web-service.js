import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-search-service-'))
process.env.BAILONGMA_USER_DIR = userDir
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
delete process.env.DEEPSEEK_API_KEY
delete process.env.OPENAI_API_KEY
const { config } = await import('./config.js')
const { paths } = await import('./paths.js')
const { searchModelWeb, execModelWeb, getModelWebConnection, normalizeWebSearchRequest } = await import('./providers/model-web.js')
const { collectVerifiedWebResearchSources, completeWebResearchCitations, actionContractCompletionIssue } = await import('./runtime/action-contract.js')
const { callLLM } = await import('./llm.js')
const { sanitizeAssistantReplyForDelivery } = await import('./runtime/markers.js')
after(() => fs.rmSync(userDir, { recursive: true, force: true }))
const connection = { provider: 'deepseek', apiKey: 'test-search-key', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-pro' }
const fixture = (results, inspect = () => {}) => ({ fetchImpl: async (url, options) => {
  inspect(url, JSON.parse(options.body), options)
  return { ok: true, json: async () => ({ results }) }
} })
const article = (name, extra = {}) => ({ title: name, url: `https://example.com/articles/${name}`, summary: `${name} summary`, content: `${name} original body`, ...extra })
const contract = { id: 'web_research', minimumVerifiedSources: 3, requiredTools: ['model_web_search', 'model_web_fetch'] }

test('DeepSeek maps content, dates, metadata, filters and Unicode length to the documented wire API', async () => {
  const result = await searchModelWeb(connection, { query: 'AI', count: 50, date_from: '2026-10-31', date_to: '2026-10-31',
    timezone: 'Asia/Shanghai', domains: ['example.com'], original_question: '今天的新闻' }, fixture([
    article('old', { date: '2026-10-30T15:59:59Z' }),
    article('current', { date: '2026-10-30T16:00:00Z', authority: 3, rerank_score: 2.4 }),
    article('undated'),
    article('next', { date: '2026-10-31T16:00:00Z' }),
    article('outside', { url: 'https://notexample.com/articles/other', date: '2026-10-31' }),
  ], (url, body) => {
    assert.equal(url, 'https://api.deepseek.com/v1/tools/search')
    assert.deepEqual(body, { query: 'AI after:2026-10-30 before:2026-11-01 site:example.com', count: 50,
      need_content: true, ori_question: '今天的新闻' })
  }))
  assert.deepEqual(result.results.map(item => item.title), ['current', 'undated'])
  assert.equal(result.results[0].date_status, 'in_range')
  assert.equal(result.results[0].authority, 3)
  assert.equal(result.results[0].evidence_kind, 'page_content')
  assert.equal(result.results[1].date_status, 'unknown')
  assert.ok(result.warnings.some(warning => warning.includes('域名之外')))
  assert.equal(collectVerifiedWebResearchSources([{ name: 'model_web_search', result: JSON.stringify({ ok: true, ...result }) }]).length, 1)
  await searchModelWeb(connection, { query: '😀'.repeat(128) }, fixture([]))
  await assert.rejects(() => searchModelWeb(connection, { query: '😀'.repeat(129) }, fixture([])), /128/)
})

test('today resolves in the selected timezone and invalid constraints fail before requests', () => {
  const request = normalizeWebSearchRequest({ query: '今天 AI 新闻', timezone: 'Asia/Shanghai' }, { now: '2026-10-30T17:00:00Z' })
  assert.equal(request.date_from, '2026-10-31')
  assert.equal(request.date_to, '2026-10-31')
  for (const args of [{ date_from: '2026-02-30' }, { date_from: '2026-11-01', date_to: '2026-10-31' },
    { count: 51 }, { need_content: 'true' }, { domains: ['example.com OR site:other.com'] }, { timezone: 'invalid/zone' }]) {
    assert.throws(() => normalizeWebSearchRequest({ query: 'AI', ...args }))
  }
})

test('snippets cannot become article evidence; content is deduplicated and bounded', async () => {
  const noBody = await searchModelWeb(connection, { query: 'AI', need_content: false }, fixture([article('alpha')]))
  assert.equal(noBody.results[0].evidence_kind, 'search_snippet')
  assert.equal(noBody.results[0].verified, false)
  assert.equal(collectVerifiedWebResearchSources([{ name: 'model_web_search', result: JSON.stringify({ ok: true, ...noBody }) }]).length, 0)
  const bounded = await searchModelWeb(connection, { query: 'AI', count: 10 }, fixture([
    article('alpha', { content: 'a'.repeat(20000) }), article('alpha'),
    ...['beta', 'gamma', 'delta', 'epsilon'].map(name => article(name, { content: 'b'.repeat(20000) })),
    article('invalid', { url: 'javascript:alert(1)' }),
  ]))
  assert.equal(bounded.results.length, 5)
  assert.equal(bounded.results.reduce((sum, item) => sum + item.content.length, 0), 48000)
  assert.equal(bounded.results.at(-1).verified, false)
})

test('saved DeepSeek works with another chat provider, explicit selections never silently fall back', async () => {
  fs.writeFileSync(path.join(paths.llmConfigDir, 'deepseek.json'), JSON.stringify(connection))
  Object.assign(config, { provider: 'openai', model: 'gpt-5.5', apiKey: 'openai-test', baseURL: 'https://api.openai.com/v1' })
  assert.equal(getModelWebConnection().provider, 'deepseek')
  assert.equal(getModelWebConnection({ provider: 'openai' }).provider, 'openai')
  assert.equal(getModelWebConnection({ provider: 'openai', fetchPage: true }), null)
  assert.equal(JSON.parse(await execModelWeb('model_web_search', { provider: 'unsupported', query: 'AI' })).error, 'not_configured')
  assert.equal(JSON.stringify(config).includes('test-search-key'), false, 'search must not change the active chat credentials')
  fs.unlinkSync(path.join(paths.llmConfigDir, 'deepseek.json'))
})

test('OpenAI preserves only real cited answers as evidence, separates uncited discovery and reports date limitations', async () => {
  const openai = { ...connection, provider: 'openai', model: 'gpt-5.5', baseURL: 'https://api.openai.com/v1' }
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses')
    const body = JSON.parse(options.body)
    assert.deepEqual(body.tools[0].filters, { allowed_domains: ['example.com'] })
    assert.equal(body.tool_choice, 'required')
    return { ok: true, json: async () => ({ status: 'completed', output: [
      { type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://example.com/articles/uncited' }] } },
      { type: 'message', content: [{ type: 'output_text', text: 'Provider summary.', annotations: [
        { type: 'url_citation', url: 'https://example.com/articles/cited', title: 'Cited' },
      ] }] },
    ] }) }
  }
  const result = await searchModelWeb(openai, { query: 'AI', domains: ['example.com'] }, { fetchImpl })
  assert.equal(result.results[0].evidence_kind, 'grounded_answer')
  assert.equal(result.results[0].verified, false, 'a provider answer is never represented as fetched page text')
  assert.equal(result.results[1].evidence_kind, 'search_snippet')
  const evidence = [{ name: 'model_web_search', result: JSON.stringify({ ok: true, ...result }) }]
  assert.deepEqual(collectVerifiedWebResearchSources(evidence).map(item => item.title), ['Cited'])
  const dated = await searchModelWeb(openai, { query: 'AI', domains: ['example.com'], date_from: '2026-10-31' }, { fetchImpl })
  assert.ok(dated.warnings.some(warning => warning.includes('日期')))
  assert.equal(dated.results[0].date_status, 'unknown')
})

test('three full texts satisfy research without redundant fetch; missing links are attached without erasing the summary', async () => {
  Object.assign(config, connection)
  const search = await searchModelWeb(connection, { query: 'AI' }, fixture(['alpha', 'beta', 'gamma'].map(name => article(name))))
  const options = { successfulToolEvidence: [{ name: 'model_web_search', result: JSON.stringify({ ok: true, ...search }) }] }
  const prose = 'Alpha 发布新模型。Beta 开源数据集。Gamma 推出开发工具。'
  const reply = completeWebResearchCitations(contract, prose, options)
  assert.equal(actionContractCompletionIssue(contract, reply, options), '')
  assert.equal(sanitizeAssistantReplyForDelivery(reply), reply)
  assert.ok(reply.startsWith(prose))
  assert.equal((reply.match(/https:\/\//g) || []).length, 3)
  const unsupported = `${prose} https://unverified.example/article`
  assert.equal(completeWebResearchCitations(contract, unsupported, options), unsupported)
  assert.match(actionContractCompletionIssue(contract, unsupported, options), /unverified/)
  let rounds = 0
  let delivered = ''
  const executions = []
  await callLLM({ systemPrompt: 'Search, summarize and cite.', message: '帮我搜索 AI 新闻',
    tools: ['model_web_search', 'model_web_fetch'], mustReply: true, localReply: true,
    toolContext: { currentTargetId: 'ID:test', actionContract: contract },
    _streamOnceForTest: async () => {
      if (++rounds === 1) return { content: '', toolCalls: [{ id: 'search', name: 'model_web_search', arguments: '{"query":"AI"}' }], aborted: false }
      assert.equal(rounds, 2, 'no redundant retrieval or regeneration required')
      return { content: prose, toolCalls: [], aborted: false }
    },
    _executeToolForTest: async (name, args) => {
      executions.push(name)
      if (name === 'model_web_search') return JSON.stringify({ ok: true, ...search })
      if (name === 'send_message') { delivered = args.content; return JSON.stringify({ ok: true, delivered: true }) }
      assert.fail('unexpected fetch')
    },
  })
  assert.deepEqual(executions, ['model_web_search', 'send_message'])
  assert.ok(delivered.startsWith(prose))
  assert.equal((delivered.match(/https:\/\//g) || []).length, 3)
})

test('independent API page fetches start concurrently in the real agent tool loop', async () => {
  Object.assign(config, connection)
  let rounds = 0
  let started = 0
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const timeout = setTimeout(() => release(), 1500)
  try {
    await callLLM({ systemPrompt: 'Read both pages.', message: '读取页面', tools: ['model_web_fetch'], mustReply: true, localReply: true,
      toolContext: { currentTargetId: 'ID:test' },
      _streamOnceForTest: async () => ++rounds === 1 ? { content: '', aborted: false, toolCalls: [1, 2].map(n => ({
        id: `fetch-${n}`, name: 'model_web_fetch', arguments: JSON.stringify({ url: `https://example.com/${n}` }),
      })) } : { content: '两页已读取。', aborted: false, toolCalls: [] },
      _executeToolForTest: async name => {
        if (name === 'model_web_fetch') {
          if (++started === 2) release()
          await barrier
          assert.equal(started, 2, 'both requests must start before either finishes')
          return JSON.stringify({ ok: true, content: 'page' })
        }
        return JSON.stringify({ ok: true, delivered: true })
      },
    })
  } finally { clearTimeout(timeout) }
})


test('malformed publication dates stay unknown instead of rolling into the requested date', async () => {
  const result = await searchModelWeb(connection, { query: 'AI', date_from: '2026-03-02', date_to: '2026-03-02', timezone: 'UTC' }, fixture([
    article('invalid-day', { date: '2026-02-30' }),
    article('invalid-timestamp', { date: '2026-02-30T00:00:00Z' }),
    article('missing-zone', { date: '2026-03-02T00:00:00' }),
    article('valid-timestamp', { date: '2026-03-02T00:00:00+00:00' }),
  ]))
  assert.deepEqual(result.results.map(item => item.date_status), ['unknown', 'unknown', 'unknown', 'in_range'])
})
