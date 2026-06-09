// Focus Classifier 单元测试（第 5b 步 v1 LLM 仲裁路径）
//
// 用 stub classifierFn 替代 classifyFocusEvent，避免真去拉 LLM；
// 验证 updateFocusFrame 在不同 LLM 返回下的最终行为。
//
// 不动 DB、不动网络、不动真实 LLM。
//
// Run: node src/test-focus-classifier.js
import { register } from 'node:module'
register('./test-prompt-split-loader.mjs', import.meta.url)

import { updateFocusFrame, MAX_FOCUS_DEPTH } from './memory/focus.js'
import { __internal as classifierInternal } from './memory/focus-classifier.js'

let failed = 0
function assert(cond, label) {
  if (!cond) {
    console.error(`FAIL: ${label}`)
    failed++
    process.exitCode = 1
  } else {
    console.log(`PASS: ${label}`)
  }
}

function makeState() {
  return { focusStack: [], tickCounter: 0 }
}

function makeFrame(topic, { startedAtTick = 1, lastSeenTick = 1, hitCount = 1 } = {}) {
  return {
    topic,
    startedAtTick,
    lastSeenTick,
    hitCount,
    startedAt: new Date().toISOString(),
    conclusions: [],
  }
}

// stubClassifier(returnValue) → function 签名跟 classifyFocusEvent 一样
function stubClassifier(returnValue, capture) {
  return async (args) => {
    if (capture) capture.push(args)
    return returnValue
  }
}

// ========== LLM 同意 pushed + 给 topic_refined ==========
// v0 判 pushed（新消息与栈顶无交集），LLM 同意 + 给了语义化关键词
{
  const state = makeState()
  state.focusStack = [makeFrame(['prompt', 'caching'])]
  state.tickCounter = 5

  const captured = []
  const r = await updateFocusFrame(state, 'build realtime dashboard component integration', {
    isTick: false,
    tickCounter: state.tickCounter,
    classifierEnabled: true,
    classifierFn: stubClassifier(
      { action: 'pushed', topic: ['天气', '广州', '预报'], returnsToDepth: -1 },
      captured,
    ),
  })
  assert(r.event === 'pushed', `LLM-pushed event=${r.event}`)
  assert(state.focusStack.length === 2, `LLM-pushed depth=${state.focusStack.length}`)
  assert(
    JSON.stringify(state.focusStack[1].topic) === JSON.stringify(['天气', '广州', '预报']),
    `LLM-pushed top topic uses LLM-refined: ${JSON.stringify(state.focusStack[1].topic)}`
  )
  assert(captured.length === 1, 'classifierFn was called once')
  assert(captured[0].v0Event === 'pushed', `classifier saw v0Event=${captured[0].v0Event}`)
}

// ========== LLM 改判 returned + returnsToDepth=0 → pop 到栈底 ==========
// v0 判 pushed（无字面交集），LLM 看出是回到栈底主题，给 returned + depth=0
{
  const state = makeState()
  state.focusStack = [
    makeFrame(['ML', '机器学习', '神经网络']),       // 栈底 = depth 0
    makeFrame(['推荐系统', 'embedding']),            // depth 1
    makeFrame(['python', 'lib', 'pandas']),          // 栈顶 = depth 2
  ]
  state.tickCounter = 8

  const r = await updateFocusFrame(state, '回到刚才那个深度学习训练的话题', {
    isTick: false,
    tickCounter: state.tickCounter,
    classifierEnabled: true,
    classifierFn: stubClassifier(
      { action: 'returned', topic: ['深度学习', '训练'], returnsToDepth: 0 },
    ),
  })
  assert(r.event === 'returned', `LLM-returned event=${r.event}`)
  assert(state.focusStack.length === 1, `LLM-returned depth collapsed to 1: ${state.focusStack.length}`)
  assert(state.focusStack[0].topic.includes('ML'), 'LLM-returned: top is original bottom frame')
  assert(r.poppedFrames.length === 2, `LLM-returned popped 2 frames (got ${r.poppedFrames.length})`)
  assert(state.focusStack[0].lastSeenTick === 8, 'LLM-returned: new top lastSeenTick updated')
}

// ========== LLM 返回 null（模拟超时）→ 回退 v0 pushed ==========
{
  const state = makeState()
  state.focusStack = [makeFrame(['prompt', 'caching'])]
  state.tickCounter = 5

  const r = await updateFocusFrame(state, 'build realtime dashboard component integration', {
    isTick: false,
    tickCounter: state.tickCounter,
    classifierEnabled: true,
    classifierFn: stubClassifier(null),
  })
  assert(r.event === 'pushed', `null-fallback event=${r.event} (expect pushed from v0)`)
  assert(state.focusStack.length === 2, `null-fallback depth=${state.focusStack.length}`)
  // v0 fallback → topic 用 ngram，包含天气相关字符
  const topTopic = state.focusStack[1].topic.join(',')
  assert(topTopic.length > 0, `null-fallback v0 topic non-empty: ${topTopic}`)
}

// ========== LLM 返回 null → 回退 v0 returned ==========
{
  const state = makeState()
  state.focusStack = [
    makeFrame(['design', 'prompt', 'caching']),
    makeFrame(['weather', 'guangzhou', 'today']),
  ]
  state.tickCounter = 7

  const r = await updateFocusFrame(state, '继续说 prompt 那个 caching design', {
    isTick: false,
    tickCounter: state.tickCounter,
    classifierEnabled: true,
    classifierFn: stubClassifier(null),
  })
  assert(r.event === 'returned', `null-fallback-returned event=${r.event}`)
  assert(state.focusStack.length === 1, 'null-fallback-returned collapses to 1')
  assert(state.focusStack[0].topic.includes('prompt'), 'null-fallback-returned: top is prompt frame')
}

// ========== LLM 抛错 → 回退 v0 ==========
{
  const state = makeState()
  state.focusStack = [makeFrame(['prompt', 'caching'])]
  state.tickCounter = 5

  const throwingClassifier = async () => { throw new Error('LLM blew up') }
  const r = await updateFocusFrame(state, '实现广州天气预报看板功能并联动实时数据', {
    isTick: false,
    tickCounter: state.tickCounter,
    classifierEnabled: true,
    classifierFn: throwingClassifier,
  })
  assert(r.event === 'pushed', `throw-fallback event=${r.event}`)
  assert(state.focusStack.length === 2, `throw-fallback depth=${state.focusStack.length}`)
}

// ========== LLM 改判 leaf → 不动栈 ==========
// v0 判 pushed，LLM 说这是一次性短问，应该忽略
{
  const state = makeState()
  state.focusStack = [makeFrame(['prompt', 'caching'])]
  state.tickCounter = 5
  const stackSnap = JSON.stringify(state.focusStack.map(f => f.topic))

  const r = await updateFocusFrame(state, '实现广州天气预报看板功能并联动实时数据', {
    isTick: false,
    tickCounter: state.tickCounter,
    classifierEnabled: true,
    classifierFn: stubClassifier(
      { action: 'leaf', topic: ['天气'], returnsToDepth: -1 },
    ),
  })
  assert(r.event === 'noop', `LLM-leaf event=${r.event} (expect noop)`)
  assert(state.focusStack.length === 1, `LLM-leaf stack unchanged depth=${state.focusStack.length}`)
  assert(
    JSON.stringify(state.focusStack.map(f => f.topic)) === stackSnap,
    'LLM-leaf: stack contents not modified',
  )
}

// ========== LLM 改判 kept（v0 误判 pushed）→ 深化栈顶 ==========
{
  const state = makeState()
  state.focusStack = [makeFrame(['transformers', 'attention'])]
  state.tickCounter = 5

  const r = await updateFocusFrame(state, '那 self attention 是怎么算的呀', {
    isTick: false,
    tickCounter: state.tickCounter,
    classifierEnabled: true,
    classifierFn: stubClassifier(
      { action: 'kept', topic: ['self-attention', 'transformer'], returnsToDepth: -1 },
    ),
  })
  assert(r.event === 'kept', `LLM-kept event=${r.event}`)
  assert(state.focusStack.length === 1, `LLM-kept depth stays 1: ${state.focusStack.length}`)
  assert(state.focusStack[0].hitCount === 2, `LLM-kept hitCount=${state.focusStack[0].hitCount}`)
  // 注意：kept 时不改栈顶 topic（保留旧帧身份）
  assert(state.focusStack[0].topic.includes('transformers'), 'LLM-kept: top topic stays original')
}

// ========== classifierEnabled=false → 完全走 v0，不调 stub ==========
{
  const state = makeState()
  state.focusStack = [makeFrame(['prompt', 'caching'])]
  state.tickCounter = 5

  let called = false
  const r = await updateFocusFrame(state, '实现广州天气预报看板功能并联动实时数据', {
    isTick: false,
    tickCounter: state.tickCounter,
    classifierEnabled: false,
    classifierFn: async () => { called = true; return { action: 'leaf', topic: [], returnsToDepth: -1 } },
  })
  assert(called === false, 'classifierEnabled=false: stub NOT called')
  assert(r.event === 'pushed', `disabled v0 event=${r.event}`)
  assert(state.focusStack.length === 2, 'disabled v0: stack pushed')
}

// ========== LLM 返回非法 action → normalizeClassifierResult 拒掉，回退 v0 ==========
// 通过 normalizeClassifierResult 直接拦：如果 classifierFn 返回非法值（如 action: 'bogus'），
// 调用方收到的应该是 null（focus-classifier 会过滤）。这里 stub 模拟「拦掉后返回 null」的情况。
// 等价场景：parseClassifierJson 解析非法 JSON 也会返回 null。
{
  const state = makeState()
  state.focusStack = [makeFrame(['prompt', 'caching'])]
  state.tickCounter = 5

  // 模拟「LLM 返回非法 JSON、classifier 拒掉 → 上游收到 null」
  const r = await updateFocusFrame(state, '广州今天天气怎么样啊预报呢', {
    isTick: false,
    tickCounter: state.tickCounter,
    classifierEnabled: true,
    classifierFn: stubClassifier(null),
  })
  assert(r.event === 'pushed', `invalid-json-fallback event=${r.event}`)
  assert(state.focusStack.length === 2, 'invalid-json-fallback: v0 still pushes')
}

// ========== normalizeClassifierResult 直接测：非法 action 拒掉 ==========
{
  const { normalizeClassifierResult } = classifierInternal
  assert(
    normalizeClassifierResult({ action: 'bogus' }, []) === null,
    'normalize: bogus action → null'
  )
  assert(
    normalizeClassifierResult(null, []) === null,
    'normalize: null input → null'
  )
  assert(
    normalizeClassifierResult({ action: 'returned', returns_to_depth: 99 }, [makeFrame(['a'])]) === null,
    'normalize: returned with out-of-range depth → null'
  )
  const ok = normalizeClassifierResult(
    { action: 'pushed', topic_refined: ['x', 'y'], returns_to_depth: -1 },
    []
  )
  assert(ok && ok.action === 'pushed' && ok.topic.length === 2, 'normalize: valid pushed accepted')
  const okReturned = normalizeClassifierResult(
    { action: 'returned', topic_refined: ['x'], returns_to_depth: 0 },
    [makeFrame(['a']), makeFrame(['b'])]
  )
  assert(
    okReturned && okReturned.action === 'returned' && okReturned.returnsToDepth === 0,
    'normalize: valid returned w/ depth accepted'
  )
}

// ========== parseClassifierJson 直接测：fence、混杂文字 ==========
{
  const { parseClassifierJson } = classifierInternal
  assert(parseClassifierJson('```json\n{"action":"pushed"}\n```').action === 'pushed', 'parse: ```json fence')
  assert(parseClassifierJson('解释下：{"action":"kept"} 完事').action === 'kept', 'parse: leading/trailing text')
  assert(parseClassifierJson('<think>hmm</think>{"action":"leaf"}').action === 'leaf', 'parse: strips <think>')
  assert(parseClassifierJson('not json at all') === null, 'parse: non-JSON → null')
  assert(parseClassifierJson('') === null, 'parse: empty → null')
  assert(parseClassifierJson('{broken') === null, 'parse: broken JSON → null')
}

// ========== describeStack 直接测：渲染快照 ==========
{
  const { describeStack } = classifierInternal
  assert(describeStack([]) === '[empty stack]', 'describeStack: empty → [empty stack]')
  const s = describeStack([
    makeFrame(['a', 'b']),
    makeFrame(['c']),
  ])
  assert(s.includes('bottom') && s.includes('top') && s.includes('a, b') && s.includes('c'),
    `describeStack: contains positions and topics (got ${s})`)
}

// ========== returns_to_depth 等于栈顶（length-1）→ 退化为 pushed ==========
// LLM 说回到栈顶，但栈顶就是栈顶，没东西可 pop —— 这种情况按 pushed 处理
{
  const state = makeState()
  state.focusStack = [
    makeFrame(['a', 'b']),
    makeFrame(['c', 'd']),
  ]
  state.tickCounter = 5

  const r = await updateFocusFrame(state, '完全新的主题 unrelated content here', {
    isTick: false,
    tickCounter: state.tickCounter,
    classifierEnabled: true,
    classifierFn: stubClassifier(
      { action: 'returned', topic: ['x'], returnsToDepth: 1 },  // 1 = 栈顶，没的可 pop
    ),
  })
  // 没有有效深度（要 < length-1 才有意义）→ 退化为 pushed
  assert(r.event === 'pushed', `bad-depth fallback event=${r.event}`)
  assert(state.focusStack.length === 3, 'bad-depth fallback: stack pushed')
}

// ========== async 模式：v0 立刻建帧 + LLM 后台 patch refined topic ==========
// 这条路径是 Step 6a 新增的，专为 fastUserPath 实时聊天用 —— 主调用立刻返回，
// LLM 仲裁 fire-and-forget 跑完后把语义化 topic 写回 frame.topic + 触发 onClassifierRefined。
{
  const state = makeState()
  state.focusStack = [makeFrame(['prompt', 'caching'])]
  state.tickCounter = 5

  // 用一个 deferred Promise 让 stub 可控地"晚一点"返回，确认主调用真的不等
  let resolveLLM
  const llmPending = new Promise(resolve => { resolveLLM = resolve })
  const refinedCalls = []

  const r = await updateFocusFrame(state, 'build realtime dashboard component integration', {
    isTick: false,
    tickCounter: state.tickCounter,
    classifierEnabled: true,
    classifierMode: 'async',
    onClassifierRefined: (args) => refinedCalls.push(args),
    classifierFn: async () => {
      await llmPending
      return { action: 'pushed', topic: ['天气', '广州', '预报'], returnsToDepth: -1 }
    },
  })

  // 主调用应立刻返回 v0 pushed —— LLM 还没回
  assert(r.event === 'pushed', `async-mode main return event=${r.event}`)
  assert(state.focusStack.length === 2, `async-mode stack pushed sync depth=${state.focusStack.length}`)
  // 此时 topic 还是 v0 的（基于 ngram 抽词），尚未被 LLM 改写
  const topicBeforeRefine = state.focusStack[1].topic.join(',')
  assert(topicBeforeRefine.length > 0, `async-mode pre-refine topic non-empty: ${topicBeforeRefine}`)
  assert(refinedCalls.length === 0, 'async-mode onClassifierRefined NOT yet called')

  // 现在解锁 LLM 让它返回
  resolveLLM()
  // 让 microtasks 跑完
  await new Promise(r => setTimeout(r, 10))

  // 帧的 topic 应该被 patch 为 LLM 给的语义化关键词
  const topicAfter = state.focusStack[1].topic
  assert(
    JSON.stringify(topicAfter) === JSON.stringify(['天气', '广州', '预报']),
    `async-mode post-refine topic=${JSON.stringify(topicAfter)}`
  )
  assert(refinedCalls.length === 1, `async-mode onClassifierRefined called once (got ${refinedCalls.length})`)
  assert(refinedCalls[0].v0Event === 'pushed', 'async-mode callback got v0Event=pushed')
}

// ========== async 模式：LLM 返回 null（超时）→ 不调 onClassifierRefined，保留 v0 topic ==========
{
  const state = makeState()
  state.focusStack = [makeFrame(['prompt', 'caching'])]
  state.tickCounter = 5

  const refinedCalls = []
  const r = await updateFocusFrame(state, 'build realtime dashboard component integration', {
    isTick: false,
    tickCounter: state.tickCounter,
    classifierEnabled: true,
    classifierMode: 'async',
    onClassifierRefined: (args) => refinedCalls.push(args),
    classifierFn: async () => null,  // 模拟超时/解析失败
  })
  assert(r.event === 'pushed', `async-null event=${r.event}`)
  assert(state.focusStack.length === 2, `async-null stack pushed`)
  await new Promise(r => setTimeout(r, 10))
  assert(refinedCalls.length === 0, 'async-null: onClassifierRefined NOT called when LLM returns null')
  // topic 保留 v0 ngram，未被改写
  const t = state.focusStack[1].topic.join(',')
  assert(t.length > 0, `async-null v0 topic kept: ${t}`)
}

// ========== async 模式：明显叶子查询不建帧、不调 LLM ==========
{
  const state = makeState()
  state.focusStack = [makeFrame(['prompt', 'caching'])]
  state.tickCounter = 5

  let called = false
  const r = await updateFocusFrame(state, '今天天气怎么样啊', {
    isTick: false,
    tickCounter: state.tickCounter,
    classifierEnabled: true,
    classifierMode: 'async',
    classifierFn: async () => { called = true; return { action: 'pushed', topic: ['天气'], returnsToDepth: -1 } },
  })
  assert(r.event === 'noop', `async-leaf-guard event=${r.event}`)
  assert(state.focusStack.length === 1, 'async-leaf-guard: stack unchanged')
  assert(called === false, 'async-leaf-guard: classifierFn not called')
}

// ========== async 模式：LLM 改判 leaf → 撤销简单 v0 push ==========
{
  const state = makeState()
  state.focusStack = [makeFrame(['prompt', 'caching'])]
  state.tickCounter = 5

  let resolveLLM
  const llmPending = new Promise(resolve => { resolveLLM = resolve })
  const refinedCalls = []
  const r = await updateFocusFrame(state, '临时讨论一个外部查询接口的返回字段和缓存策略', {
    isTick: false,
    tickCounter: state.tickCounter,
    classifierEnabled: true,
    classifierMode: 'async',
    onClassifierRefined: (args) => refinedCalls.push(args),
    classifierFn: async () => {
      await llmPending
      return { action: 'leaf', topic: ['临时查询'], returnsToDepth: -1 }
    },
  })
  assert(r.event === 'pushed', `async-leaf-rollback initial event=${r.event}`)
  assert(state.focusStack.length === 2, 'async-leaf-rollback: v0 pushed before LLM returns')
  resolveLLM()
  await new Promise(r => setTimeout(r, 10))
  assert(state.focusStack.length === 1, 'async-leaf-rollback: LLM removed pushed frame')
  assert(refinedCalls.length === 1, 'async-leaf-rollback: save callback fired once')
  assert(refinedCalls[0].correction === 'removed_leaf_frame', 'async-leaf-rollback: correction marker set')
}

// ========== async 模式：帧在 LLM 返回前被后续操作 pop 出栈 → 丢弃 refine ==========
// 模拟实战：用户连发两条无关消息，第一条建的帧被第二条挤掉栈底（栈深超 MAX）
{
  const state = makeState()
  state.focusStack = [
    makeFrame(['a', 'b', 'c']),
    makeFrame(['d', 'e', 'f']),
    makeFrame(['g', 'h', 'i']),
    makeFrame(['j', 'k', 'l']),  // 已经 4 帧到上限
  ]
  state.tickCounter = 5

  let resolveLLM
  const llmPending = new Promise(resolve => { resolveLLM = resolve })
  const refinedCalls = []

  // 这条消息会触发 pushed → state.focusStack shift 出栈底（旧 ['a','b','c']）
  const r = await updateFocusFrame(state, '完全新的主题 something brand new here unique', {
    isTick: false,
    tickCounter: state.tickCounter,
    classifierEnabled: true,
    classifierMode: 'async',
    onClassifierRefined: (args) => refinedCalls.push(args),
    classifierFn: async () => {
      await llmPending
      return { action: 'pushed', topic: ['新主题'], returnsToDepth: -1 }
    },
  })
  assert(r.event === 'pushed', `async-pop event=${r.event}`)
  // 拿到 v0 刚 push 进去的栈顶帧的引用
  const newTopRef = state.focusStack[state.focusStack.length - 1]

  // 现在手动把这帧从栈里弹出（模拟后续轮次 pop）
  state.focusStack.length = 0

  resolveLLM()
  await new Promise(r => setTimeout(r, 10))

  // 帧已不在栈里，refine 应该被丢弃
  assert(refinedCalls.length === 0, 'async-pop: refine discarded when frame no longer in stack')
  // 帧对象的 topic 应该没被改（虽然这点不严格 —— frameRef 仍在外面）
  // 关键是：onClassifierRefined 不能被调（避免误触发 saveFocusStack）
  void newTopRef
}

if (failed === 0) {
  console.log('\nAll focus-classifier sanity checks complete.')
} else {
  console.log(`\n${failed} check(s) failed.`)
}
