import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { executeExpression, expressionGuidance } from './runtime/expression.js'

// Keep the model-loop integration isolated from real user settings and accounts.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-expression-social-'))
process.env.BAILONGMA_USER_DIR = tmp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
const calls = []
const deps = {
  speak: async () => assert.fail('external reply must never synthesize local speaker audio'),
  deliver: async (args, context) => {
    calls.push({ args, context })
    return JSON.stringify({ ok: true, delivered: true, message_sent: true, target_id: args.target_id, channel: args.channel })
  },
}
for (const currentChannel of ['WECHAT_CLAWBOT', 'WECHAT_OFFICIAL', 'WECHAT', 'FEISHU', 'DISCORD', 'WECOM']) {
  const channel = currentChannel.startsWith('WECHAT') ? 'WECHAT' : currentChannel
  const context = { currentChannel, currentTargetId: 'ID:1', voiceReply: true }
  assert.match(expressionGuidance(context), new RegExp(`format="social", channel="${channel}"`))
  assert.doesNotMatch(expressionGuidance(context), /Prefer send_message with format="voice"/)
  for (const args of [{ format: 'voice' }, { format: 'text' }, { channel: 'TUI' }]) {
    const before = calls.length
    const result = JSON.parse(await executeExpression({ target_id: 'ID:1', content: '音乐已播放', ...args }, context, deps))
    assert.equal(result.delivered, false)
    assert.equal(result.error, 'external_reply_requires_social')
    assert.equal(calls.length, before)
  }
  await executeExpression({ target_id: 'ID:1', content: '音乐已播放', format: 'social', channel }, context, deps)
  assert.equal(calls.at(-1).args.channel, channel)
}
const { callLLM } = await import('./llm.js')
const context = { outputContract: 'explicit_send_only', currentChannel: 'WECHAT_CLAWBOT', currentExternalPartyId: 'wechat:clawbot:test', currentTargetId: 'ID:1' }
let round = 0
const before = calls.length
const result = await callLLM({
  systemPrompt: 'Execute the requested action, then reply.', message: '帮我播放音乐',
  tools: ['send_message'], mustReply: true, toolContext: context,
  _streamOnceForTest: async ({ messages }) => {
    assert.ok(messages.some(m => m.role === 'system' && m.content.includes('format="social", channel="WECHAT"')))
    round++
    if (round > 2) return { content: '', toolCalls: [] }
    if (round === 2) assert.ok(JSON.stringify(messages).includes('external_reply_requires_social'))
    return { content: '', toolCalls: [{ id: `reply-${round}`, name: 'send_message', arguments: JSON.stringify({
      target_id: 'ID:1', content: '音乐已播放', format: round === 1 ? 'voice' : 'social', channel: round === 1 ? 'AUTO' : 'WECHAT',
    }) }] }
  },
  _executeToolForTest: (name, args) => executeExpression(args, context, deps),
})
assert.equal(result.delivered, true)
assert.equal(calls.length, before + 1)
assert.equal(calls.at(-1).args.channel, 'WECHAT')
assert.equal(calls.at(-1).context.currentExternalPartyId, 'wechat:clawbot:test')
console.log('PASS external channel protection, stale voice preference, and model-loop correction to WeChat without local speech')
