#!/usr/bin/env node
// 用法: node scripts/test-mimo.mjs <API_KEY> [model]
// 默认模型: mimo-v2.5
// 不会把 key 写入任何文件,只在内存里用一次。

const apiKey = process.argv[2]
const model  = process.argv[3] || 'mimo-v2.5'

if (!apiKey) {
  console.error('用法: node scripts/test-mimo.mjs <API_KEY> [model]')
  process.exit(2)
}

const BASE = 'https://api.xiaomimimo.com/v1'
const ENDPOINT = `${BASE}/chat/completions`

const body = {
  model,
  messages: [{ role: 'user', content: 'Reply with exactly: hello' }],
  max_tokens: 16,
  temperature: 0,
  stream: false,
}

async function tryRequest(label, headers) {
  console.log(`\n── [${label}] ${ENDPOINT}`)
  console.log('   headers:', Object.keys(headers).join(', '))
  console.log('   body:', JSON.stringify(body))
  const t0 = Date.now()
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    const ms = Date.now() - t0
    const text = await res.text()
    console.log(`   status: ${res.status} ${res.statusText}  (${ms}ms)`)
    // 截断超长响应,但保留前 1500 字符以便看 reason
    const trimmed = text.length > 1500 ? text.slice(0, 1500) + '\n…(truncated)' : text
    console.log('   body:', trimmed)
    return { ok: res.ok, status: res.status }
  } catch (err) {
    const ms = Date.now() - t0
    console.log(`   network error (${ms}ms):`, err.message)
    if (err.cause) console.log('   cause:', err.cause)
    return { ok: false, error: err.message }
  }
}

// 平台文档明确支持两种鉴权头:Authorization: Bearer 和 api-key
const results = []
results.push(await tryRequest('Authorization Bearer', { Authorization: `Bearer ${apiKey}` }))
results.push(await tryRequest('api-key header',       { 'api-key': apiKey }))

// 顺便用 OpenAI SDK 走一遍(模拟 jarvis 实际调用路径)
console.log('\n── [OpenAI SDK] 模拟 jarvis 调用')
try {
  const { default: OpenAI } = await import('openai')
  const client = new OpenAI({ apiKey, baseURL: BASE, timeout: 12000 })
  const t0 = Date.now()
  const resp = await client.chat.completions.create(body)
  const ms = Date.now() - t0
  console.log(`   ok (${ms}ms):`, JSON.stringify(resp).slice(0, 500))
  results.push({ ok: true })
} catch (err) {
  console.log('   error:', err.message)
  if (err.status) console.log('   status:', err.status)
  if (err.response?.data) console.log('   response.data:', JSON.stringify(err.response.data).slice(0, 500))
  if (err.cause) console.log('   cause:', err.cause)
  results.push({ ok: false, error: err.message })
}

console.log('\n── 汇总')
console.log('   Authorization Bearer:', results[0].ok ? 'OK' : `FAIL (${results[0].status || results[0].error})`)
console.log('   api-key header      :', results[1].ok ? 'OK' : `FAIL (${results[1].status || results[1].error})`)
console.log('   OpenAI SDK          :', results[2].ok ? 'OK' : `FAIL (${results[2].error})`)
