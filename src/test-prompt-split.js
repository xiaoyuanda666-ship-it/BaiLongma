// Lightweight sanity test for the system/context split.
// Pure prompt-assembly check — no database, no LLM, no network.
//
// This test uses a custom ESM resolve hook (via module.register) to stub the
// transitive ../agents/registry.js dependency, so it runs even when the
// project's better-sqlite3 native binding is mismatched against the current
// Node ABI (which is the case during plain `node` invocation since the
// installed binary is built for Electron). The shape of buildAgentContextBlock
// is preserved (returns a string) — we just bypass the DB call inside.
//
// Run: node src/test-prompt-split.js

import { register } from 'node:module'

// Register the loader before importing prompt.js so the agents/registry stub
// is in effect when prompt.js resolves its imports.
register('./test-prompt-split-loader.mjs', import.meta.url)

const { buildSystemPrompt, buildContextBlock, combinePromptForPreview } = await import('./prompt.js')
const { buildAutonomousTickDirections } = await import('./runtime/tick-policy.js')

function assert(cond, label) {
  if (!cond) {
    console.error(`FAIL: ${label}`)
    process.exitCode = 1
  } else {
    console.log(`PASS: ${label}`)
  }
}

const baseSystemArgs = {
  agentName: 'Longma',
  persona: 'Curious, brief, and a little philosophical.',
  existenceDesc: '3 hours',
  security: { execSandbox: true },
  systemEnv: '## Host\nLocale: zh-CN\n',
}

// 1) Stability across rounds: identical system args → identical system string,
//    even when we vary dynamic args (memories / directions / etc.).
const sys1 = buildSystemPrompt({
  ...baseSystemArgs,
  memories: 'round1 mem',
  directions: 'round1 dir',
  constraints: [{ content: 'r1' }],
})
const sys2 = buildSystemPrompt({
  ...baseSystemArgs,
  memories: 'round2 mem totally different',
  directions: 'round2 dir totally different',
  constraints: [{ content: 'r2' }],
  thoughtStack: [{ concept: 'X', line: 'y' }],
  awakeningTicks: 3,
  task: 'do thing',
})
assert(sys1 === sys2, 'system stays stable when only dynamic fields differ')
assert(sys1.includes('Longma'), 'system contains agent name')
assert(sys1.includes('Curious, brief'), 'system contains persona')
assert(sys1.includes('## Top-Level Behavior Rules'), 'system contains hard floor')
assert(sys1.includes('neither passive nor proactive by default'), 'system gives Tick posture judgment to the model')
assert(!sys1.includes('You are passive by default'), 'system no longer imposes a passive Tick default')
assert(sys1.includes('Progress notes are action-first'), 'system contains action-first progress note rule')
assert(sys1.includes('harmless, reversible local display actions'), 'system tells agent to directly open harmless local display results')
assert(!sys1.includes('round1 mem'), 'system does NOT contain dynamic memories')
assert(!sys1.includes('round1 dir'), 'system does NOT contain dynamic directions')
assert(!sys2.includes('do thing'), 'system does NOT contain active task content')
assert(!sys1.includes('## Memory'), 'system does NOT contain memory section header')

// 2) Context block varies with dynamic fields, and is wrapped in <context>.
const ctx1 = buildContextBlock({
  memories: 'round1 mem',
  directions: 'round1 dir',
  constraints: [{ content: 'r1' }],
  hasActiveTask: true,
  task: 'do thing',
  taskKnowledge: 'know X',
  extraContext: 'weather=22C',
  entities: [{ id: 'ID:000001', label: 'Yuanda' }],
  thoughtStack: [{ concept: 'mem-pool', line: 'first sketch' }],
  awakeningTicks: 2,
  security: { fileSandbox: true, execSandbox: true, updatedAt: '2026-05-25T22:30:00+08:00' },
})
assert(ctx1.startsWith('<context>'), 'context wrapped: opens with <context>')
assert(ctx1.endsWith('</context>'), 'context wrapped: closes with </context>')
assert(ctx1.includes('<constraints>'), 'context has <constraints>')
assert(ctx1.includes('round1 mem'), 'context contains memories')
assert(ctx1.includes('round1 dir'), 'context contains directions')
assert(ctx1.includes('<task active="true">'), 'context has active task tag')
assert(ctx1.includes('do thing'), 'context contains task body')
assert(ctx1.includes('<task-knowledge>'), 'context has task-knowledge tag')
assert(ctx1.includes('<extra>'), 'context has extra tag')
assert(ctx1.includes('weather=22C'), 'context contains extra body')
assert(ctx1.includes('<known-others>'), 'context has known-others tag')
assert(ctx1.includes('<thought-stack>'), 'context has thought-stack tag')
assert(ctx1.includes('<awakening ticks_remaining="2">'), 'context has awakening tag with ticks attr')
assert(ctx1.includes('<directions>'), 'context has directions tag')
assert(ctx1.includes('Sandbox Status:'), 'context includes sandbox runtime status')
assert(ctx1.includes('file_sandbox: ENABLED'), 'context advertises enabled file sandbox')
assert(ctx1.includes('exec_sandbox: ENABLED'), 'context advertises enabled exec sandbox')
assert(ctx1.includes('changed_at: 2026-05-25T22:30:00+08:00'), 'context includes sandbox change timestamp')

const ctxSandboxOff = buildContextBlock({
  security: { fileSandbox: false, execSandbox: false },
})
assert(ctxSandboxOff.includes('file_sandbox: DISABLED'), 'context advertises disabled file sandbox')
assert(ctxSandboxOff.includes('exec_sandbox: DISABLED'), 'context advertises disabled exec sandbox')
assert(ctxSandboxOff.includes('changed_at: legacy setting; exact change time was not recorded'), 'context marks legacy sandbox change timestamp')
assert(!sys1.includes('Sandbox Status:'), 'system does NOT contain dynamic sandbox status')

// 3) Empty / minimal context block — always at least the task-active tag
const justNothing = buildContextBlock({ hasActiveTask: false })
assert(justNothing.startsWith('<context>'), 'minimal context still wrapped')
assert(justNothing.includes('<task active="false">'), 'minimal context advertises no active task')
assert(justNothing.includes('does not prescribe silence, activity, or communication'), 'no-task context remains behaviorally neutral')
assert(!justNothing.includes('Default to quiet presence'), 'no-task context has no forced quiet default')

const awakeningContext = buildContextBlock({ awakeningTicks: 2 })
assert(awakeningContext.includes('not a prescribed exploration program'), 'awakening is context rather than a fixed workflow')
assert(!awakeningContext.includes('Just go look'), 'awakening no longer forces exploration')
assert(!awakeningContext.includes('Do not ask again'), 'awakening no longer hard-codes communication behavior')

const tickContext = buildContextBlock({ directions: buildAutonomousTickDirections() })
assert(tickContext.includes('<directions>'), 'autonomous Tick policy is carried in round-local directions')
assert(tickContext.includes('make your own situational judgment'), 'final Tick context delegates semantic judgment to the model')

// 4) Person + curiosity composition
const ctxPerson = buildContextBlock({
  personMemory: {
    entities: JSON.stringify(['ID:000001']),
    content: 'Yuanda — project founder',
    detail: 'From Lufeng, Guangdong. Building a persistent AI consciousness framework. Likes philosophical discussions, asks directly.',
  },
})
assert(ctxPerson.includes('<person>'), 'context has <person> tag')
assert(ctxPerson.includes('About ID:000001'), 'person section references entity')
assert(ctxPerson.includes('Curiosity State'), 'person section embeds curiosity prompt')

// 5) Recall summary and round info
const ctxRecall = buildContextBlock({
  memories: 'base mems',
  recallSummary: 'Triggered by user asking about TICK mechanism',
  roundInfo: { round: 2 },
})
assert(ctxRecall.includes('<recall>'), 'context has <recall> when recallSummary supplied')
assert(ctxRecall.includes('<memory-refresh round="2">'), 'context has memory-refresh tag with round attr')

// 6) Combined preview = system + context
const combined = combinePromptForPreview(sys1, ctx1)
assert(combined.startsWith(sys1), 'preview begins with system part')
assert(combined.endsWith(ctx1), 'preview ends with context part')

// 7) Round-local context channel rule should be in the stable system
assert(sys1.includes('Round-Local Context Channel'), 'system explains the <context> channel to the model')

// =============================================================================
// Wave 2: 场景规则段按需注入 gate
// 默认 userMessage 为空 / 无信号位 → 场景段都不出现。Platform Routing 即使
// geo 缺失，也只有在当前请求确实需要选择视频/人物信息平台时才注入。
// =============================================================================

// 8.0 Neutral baseline：无 userMessage + 无信号位 → CORE 段保留、场景段不出现
const sysNeutral = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '你好' })
assert(!sysNeutral.includes('Music Mode: Highest Priority'), 'neutral input: no Music Mode block')
assert(!sysNeutral.includes('Video Mode: Reply Brevity'), 'neutral input: no Video Mode block')
assert(!sysNeutral.includes('WeatherCard Rules'), 'neutral input: no WeatherCard Rules block')
assert(!sysNeutral.includes('WeChat Connection'), 'neutral input: no WeChat Connection block')
assert(!sysNeutral.includes('WeChat Outbound Constraint'), 'neutral input: no WeChat Outbound block')
assert(!sysNeutral.includes('## Focus Banner'), 'neutral input: no Focus Banner block')
assert(!sysNeutral.includes('## Security Sandbox'), 'neutral input: no Security Sandbox block')
// Neutral baseline 只保留真正的 CORE；视觉、语音、TICK 等场景段不再常驻。
assert(sysNeutral.includes('## Top-Level Behavior Rules'), 'neutral: CORE Top-Level kept')
assert(!sysNeutral.includes('## Visual Surfaces'), 'neutral: Visual Surfaces omitted')
assert(!sysNeutral.includes('## Voice Input: Spoken Brevity'), 'neutral: Voice rules omitted')
assert(!sysNeutral.includes('### Kinds & Composition'), 'neutral: visual kind catalog omitted')
assert(!sysNeutral.includes('## TICK Handling'), 'neutral: TICK rules omitted')
assert(sysNeutral.includes('## Decision And Execution Core'), 'neutral: compact decision loop kept')
assert(sysNeutral.includes('## Tool Usage Core'), 'neutral: compact tool rules kept')

const sysVisual = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '给我展示一个进度面板' })
assert(sysVisual.includes('## Visual Surfaces'), 'visual request: Visual Surfaces injected')
assert(sysVisual.includes('### Kinds & Composition'), 'visual request: kind catalog injected')
const sysVoice = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '你好', isVoiceTurn: true })
assert(sysVoice.includes('## Voice Input: Spoken Brevity'), 'voice turn: spoken brevity injected')
const sysTick = buildSystemPrompt({ agentName: 'Longma', persona: 'p', isTick: true })
assert(sysTick.includes('## TICK Handling'), 'tick turn: TICK rules injected')
assert(sysTick.includes('## Presence Sense And Spoken Proactivity'), 'tick turn: presence rules injected')
assert(sysTick.includes('## Visual Surfaces'), 'tick turn: autonomous visual rules injected')

// 8.1 Music gate
const sysMusic = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '放首周杰伦的歌' })
assert(sysMusic.includes('Music Mode: Highest Priority'), 'music keyword: Music Mode injected')
const sysMusic2 = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: 'play a song please' })
assert(sysMusic2.includes('Music Mode: Highest Priority'), 'english "song": Music Mode injected')
const sysMusic3 = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '换一首' })
assert(sysMusic3.includes('Music Mode: Highest Priority'), '"换一首": Music Mode injected')

// 8.2 Video gate
const sysVideo = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '帮我在B站看视频' })
assert(sysVideo.includes('## Video Mode'), 'video keyword: Video Mode injected')
const sysVideo2 = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: 'open youtube' })
assert(sysVideo2.includes('## Video Mode'), 'youtube: Video Mode injected')

// 8.3 Weather Surface gate（工作流块现由 weather 能力经 capability-registry 注入）
const sysWeather = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '今天天气怎么样' })
assert(sysWeather.includes('Weather Surface Rules'), 'weather keyword: Weather Surface Rules injected')
assert(sysWeather.includes('wttr.in'), 'Weather block contains wttr.in source line')
const sysWeather2 = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: 'what about the weather' })
assert(sysWeather2.includes('Weather Surface Rules'), 'english weather: Weather Surface Rules injected')

// 8.3b 能力工作流块（hotspot / worldcup / software-install）经 capability-registry 注入
const sysHotspot = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '看看今天的热搜' })
assert(sysHotspot.includes('Hotspot Panel'), 'hotspot keyword: Hotspot Panel block injected (via capability)')
const sysWorldcup = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '世界杯比分怎么样' })
assert(sysWorldcup.includes('World Cup Panel'), 'worldcup keyword: World Cup Panel block injected (via capability)')
const sysInstall = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '帮我安装一个 QQ' })
assert(sysInstall.includes('Software Install Workflow'), 'install keyword: Software Install Workflow block injected (via capability)')
assert(!sysNeutral.includes('Hotspot Panel') && !sysNeutral.includes('World Cup Panel') && !sysNeutral.includes('Software Install Workflow'),
  'neutral input: no capability workflow blocks injected')

// 8.4 WeChat Connection gate
const sysWcConn = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '帮我连接微信' })
assert(sysWcConn.includes('## WeChat Connection'), 'connect-wechat keyword: WeChat Connection injected')
const sysWcConn2 = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: 'please connect WeChat for me' })
assert(sysWcConn2.includes('## WeChat Connection'), 'english connect-wechat: injected')

// 8.5 WeChat Outbound gate —— channel 状态触发，关键词不需要
const sysWcOut = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '随便聊聊', currentChannel: 'WECHAT' })
assert(sysWcOut.includes('WeChat Outbound Constraint'), 'channel=WECHAT: Outbound Constraint injected')
const sysWcOut2 = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '随便聊聊', hasWechatHistory: true })
assert(sysWcOut2.includes('WeChat Outbound Constraint'), 'hasWechatHistory: Outbound Constraint injected')
const sysWcOut3 = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '随便聊聊' })
assert(!sysWcOut3.includes('WeChat Outbound Constraint'), 'no wechat signal: Outbound Constraint NOT injected')

// 8.6 Focus Banner gate
const sysFocus = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '帮我进入专注模式' })
assert(sysFocus.includes('## Focus Banner'), 'focus keyword: Focus Banner injected')
const sysFocus2 = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '吃了吗', hasActiveFocus: true })
assert(sysFocus2.includes('## Focus Banner'), 'hasActiveFocus=true: Focus Banner injected even without keyword')
const sysFocus3 = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '吃了吗' })
assert(!sysFocus3.includes('## Focus Banner'), 'no focus signal: Focus Banner NOT injected')

// 8.7 Security Sandbox gate
const sysSb = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '帮我解除沙箱限制' })
assert(sysSb.includes('## Security Sandbox'), 'sandbox keyword: Security Sandbox injected')
const sysSb2 = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: 'disable sandbox please' })
assert(sysSb2.includes('## Security Sandbox'), 'english sandbox: Security Sandbox injected')

// 8.8 Platform Routing gate
const sysPlatCN = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '帮我找一个视频', currentCountryCode: 'CN' })
assert(sysPlatCN.includes('## Platform Routing'), 'CN country: Platform Routing injected')
const sysPlatTZ = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '查一下这个明星的资料', currentTimezone: 'Asia/Shanghai' })
assert(sysPlatTZ.includes('## Platform Routing'), 'CN timezone: Platform Routing injected')
const sysPlatUS = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '帮我找一个视频', currentCountryCode: 'US', currentTimezone: 'America/New_York' })
assert(!sysPlatUS.includes('## Platform Routing'), 'US country+tz: Platform Routing NOT injected')
// 保守 fallback 只在确实需要选平台时注入；普通聊天不再承担这段成本。
const sysPlatUnknown = buildSystemPrompt({ agentName: 'Longma', persona: 'p', userMessage: '帮我找一个视频' })
assert(sysPlatUnknown.includes('## Platform Routing'), 'route-relevant request with unknown geo: default-to-CN injected')
assert(!sysNeutral.includes('## Platform Routing'), 'neutral request: Platform Routing omitted')

// 8.9 CORE 永远在 —— 不论 gate 命中与否
for (const s of [sysNeutral, sysMusic, sysVideo, sysWeather, sysWcConn, sysWcOut, sysFocus, sysSb, sysPlatCN, sysPlatUS]) {
  assert(s.includes('## Relationship Posture'), 'CORE: Relationship Posture always present')
  assert(s.includes('## Response Rules'), 'CORE: Response Rules always present')
  assert(s.includes('## Self-Sufficient Execution'), 'CORE: Self-Sufficient Execution always present')
}

// 8.10 Token 节省估算：neutral baseline vs full-injection
const sysAllScenarios = buildSystemPrompt({
  agentName: 'Longma',
  persona: 'p',
  userMessage: '放首歌 看视频 天气怎样 连接微信 专注模式 解除沙箱',
  currentChannel: 'WECHAT',
  hasActiveFocus: true,
  currentCountryCode: 'CN',
})
assert(sysNeutral.length < 26000, 'neutral prompt: stays below the 26K character budget')
assert(sysAllScenarios.length < 36000, 'all-scenarios prompt: stays below the 36K character budget')
console.log(`\n[wave2] neutral gated length: ${sysNeutral.length} chars`)
console.log(`[wave2] all-scenarios injection length: ${sysAllScenarios.length} chars`)
console.log(`[wave2] potential saving vs all-on: ${sysAllScenarios.length - sysNeutral.length} chars (~${Math.round((sysAllScenarios.length - sysNeutral.length) / 4)} tokens)`)

console.log('\nAll prompt-split sanity checks complete.')
