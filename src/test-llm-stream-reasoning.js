// 测试：streamOnce 对推理流的 mode 路由（修复"TTS 把思考过程读出来"）
//
// 根因（已由 /tmp 探针确认）：MiniMax-M3 经 OpenAI 兼容接口把推理以 <think>…</think> 形式
// 流在 content 里（非 reasoning_content 字段）。llm.js 原有一段 DeepSeek 专用"早关 think 流"
// 逻辑（reasoning_content 字段 → content 字段切换时关闭），在内联 <think> 场景会在首个
// <think> chunk 之后误关，把后续推理当成正文(mode:'text')送进 TTS。
//
// 修复：加 thinkFromField 标志——字段式(DeepSeek)=true 走早关；内联 <think> 标签式(minimax)=false
// 不走早关，think 流由 </think> 闭合。本测试用合成客户端（绕过网络）断言两条路径的路由正确。
import assert from 'node:assert/strict'
import { streamOnce } from './llm.js'

// 合成 OpenAI 客户端：chat.completions.create 返回一段"增量流"（数组即可，for-await 能迭代）
function fakeClient(deltas) {
  const chunks = deltas.map(d => ({ choices: [{ delta: d }] }))
  return { chat: { completions: { create: async () => chunks } } }
}

// 把 onStream 事件序列折叠成 [{mode, text}]：mode 取最近一次 start.mode
function chunkModes(events) {
  let cur = null
  const out = []
  for (const ev of events) {
    if (ev.event === 'start') cur = ev.mode
    else if (ev.event === 'end') cur = null
    else if (ev.event === 'chunk') out.push({ mode: cur, text: ev.text })
  }
  return out
}

async function run(deltas) {
  const events = []
  // 用 client 参数注入合成客户端（绕过网络 + 绕过全局 _clientOverride，无并行污染）
  await streamOnce({
    messages: [{ role: 'user', content: '推导 13×17' }],
    toolSchemas: [],
    onStream: e => events.push(e),
    client: fakeClient(deltas),
  })
  return chunkModes(events)
}

// ── 用例 1：minimax 式（<think> 内联在 content）──────────────────────────────
// 关键：第 2 个推理增量 ' me to calculate' 必须落在 mode:'think'（修复前被误判为 text → 被朗读）
{
  const modes = await run([
    { content: '' },
    { content: '<think>The user is asking' },
    { content: ' me to calculate' },
    { content: ' 13*17.' },
    { content: '</think>221' },
    { content: '.' },
  ])

  const thinkText = modes.filter(m => m.mode === 'think').map(m => m.text).join('')
  const textText = modes.filter(m => m.mode === 'text').map(m => m.text).join('')

  // 修复核心断言：内联 <think> 内的每个增量都路由到 think，绝不 text
  const calcChunk = modes.find(m => m.text === ' me to calculate')
  assert.ok(calcChunk, '应捕获到 " me to calculate" 增量')
  assert.equal(calcChunk.mode, 'think', '内联 <think> 内的推理增量必须是 mode:think（这是 bug 的回归点）')

  // 推理内容聚在 think，正文聚在 text
  assert.ok(thinkText.includes('calculate'), '推理应落在 think 流里：' + thinkText)
  assert.equal(textText, '221.', '正文流只应含回答：' + textText)

  // PRD 指标：进入"正文(TTS)"流的文本里零推理泄漏
  assert.ok(!textText.includes('<think'), '正文流不得残留 <think 标记')
  assert.ok(!textText.includes('calculate'), '正文流不得含推理内容')
  console.log('✅ 用例1 minimax 内联 <think>：推理→think / 正文→text，零泄漏')
}

// ── 用例 2：DeepSeek 式（reasoning_content 字段）回归守护 ────────────────────
// 早关逻辑必须对字段式推理仍然生效：字段切换后正文落到 text
{
  const modes = await run([
    { reasoning_content: 'Reasoning step 1.' },
    { reasoning_content: 'Reasoning step 2.' },
    { content: 'Final answer.' },
  ])

  const thinkText = modes.filter(m => m.mode === 'think').map(m => m.text).join('')
  const textText = modes.filter(m => m.mode === 'text').map(m => m.text).join('')

  assert.ok(thinkText.includes('step 2'), 'DeepSeek 字段式推理应全在 think：' + thinkText)
  assert.equal(textText, 'Final answer.', 'DeepSeek 正文应落到 text（早关仍生效）：' + textText)
  assert.ok(!textText.includes('Reasoning'), 'DeepSeek 正文流不得含推理')
  console.log('✅ 用例2 DeepSeek reasoning_content 字段：推理→think / 正文→text，早关逻辑未回归')
}

console.log('\n全部通过 ✔')
