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
    content: 'User is building Jarvis.',
    detail: 'Long-running AI agent with memory, context injection, and Electron desktop runtime.',
  },
  memories: [
    { content: 'Discussed LLM prompt/context/memory architecture.', detail: 'Needs user profile injection.' },
  ],
  conversation: [
    { content: '我要给 jarvis agent 加入用户画像能力，分析一下怎么做' },
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

console.log('[test-user-profile] ok')
