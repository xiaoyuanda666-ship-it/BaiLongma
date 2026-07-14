import assert from 'node:assert/strict'
import { buildProfileFromSignals } from './profile/infer.js'
import { formatUserProfileForPrompt } from './profile/format.js'
import { buildContextBlock } from './prompt.js'

const profile = buildProfileFromSignals({
  userId: 'ID:000001',
  apps: [
    { name: 'Visual Studio Code' },
    { name: 'Git' },
    { name: 'Cursor' },
    { name: 'Figma' },
  ],
  personMemory: {
    content: 'User is building Bailongma.',
    detail: 'Long-running AI agent with memory, context injection, and Electron desktop runtime.',
  },
  memories: [
    { content: 'Discussed LLM prompt/context/memory architecture.', detail: 'Needs user profile injection.' },
  ],
  conversation: [
    { content: '我要给 bailongma agent 加入用户画像能力，分析一下怎么做' },
  ],
  actionLog: [
    { tool: 'read_file', summary: 'read src/prompt.js', detail: 'context injection code' },
  ],
})

assert.equal(profile.user_id, 'ID:000001')
assert.ok(profile.roles.length > 0)
assert.ok(profile.roles[0].confidence > 0.4)
assert.ok(profile.roles.every(role => role.status === 'user_stated' || role.confidence <= 0.85))
assert.ok(profile.expertise.every(item => item.confidence <= 0.85))
assert.ok(profile.domains.includes('AI agents'))
assert.ok(!profile.communication_style.some(item => /Chinese conversation/i.test(item.label)))

const text = formatUserProfileForPrompt(profile)
assert.match(text, /Current working impression/)
assert.match(text, /hypothesis/)

const context = buildContextBlock({
  userProfile: profile,
  security: { fileSandbox: false, execSandbox: false },
})
assert.match(context, /<user-profile>/)
assert.match(context, /trust the user/)

const corrected = buildProfileFromSignals({
  userId: 'ID:000001',
  apps: [{ name: 'Visual Studio Code' }, { name: 'Git' }],
  conversation: [{ content: '我不是程序员，我只是做产品的' }],
  previous: profile,
})
const developerRole = corrected.roles.find(role => /Software developer/i.test(role.label))
assert.ok(!developerRole || developerRole.confidence <= 0.18 || developerRole.status === 'contradicted_by_user')

const chineseInternalContextEnglishUser = buildProfileFromSignals({
  userId: 'ID:000001',
  personMemory: { content: '用户正在构建白龙马。' },
  memories: [{ content: '系统记忆、工具说明和启动自检全部是中文。' }],
  conversation: [
    { role: 'assistant', content: '你好，我是小白龙。' },
    { role: 'user', content: "Hello. What's your name?" },
  ],
  actionLog: [{ tool: 'send_message', summary: '已发送中文消息', detail: '中文动作日志' }],
})
assert.ok(!chineseInternalContextEnglishUser.communication_style.some(item => /Chinese/i.test(item.label)))

const explicitChinesePreference = buildProfileFromSignals({
  userId: 'ID:000001',
  conversation: [{ role: 'user', content: '以后一直用中文回复我。' }],
})
assert.ok(explicitChinesePreference.communication_style.some(item => item.label === 'explicitly prefers Chinese replies'))

const oneTurnChineseRequest = buildProfileFromSignals({
  userId: 'ID:000001',
  conversation: [{ role: 'user', content: '这一题请用中文回答。' }],
})
assert.ok(!oneTurnChineseRequest.communication_style.some(item => /Chinese/i.test(item.label)))

const staleLegacyLanguageProfile = buildProfileFromSignals({
  userId: 'ID:000001',
  memories: [{ content: '全中文的内部记忆。' }],
  conversation: [{ role: 'user', content: 'Hello again.' }],
  previous: {
    roles: [],
    domains: [],
    projects: [],
    communication_style: [{ label: 'prefers Chinese conversation', confidence: 0.6 }],
  },
})
assert.ok(!staleLegacyLanguageProfile.communication_style.some(item => /Chinese/i.test(item.label)))

const assistantPreferenceMustNotLeak = buildProfileFromSignals({
  userId: 'ID:000001',
  conversation: [
    { role: 'assistant', content: 'From now on, always reply in Chinese.' },
    { role: 'user', content: 'Hello there.' },
  ],
})
assert.ok(!assistantPreferenceMustNotLeak.communication_style.some(item => /Chinese/i.test(item.label)))

console.log('[test-user-profile] ok')
