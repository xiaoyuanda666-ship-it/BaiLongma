// Thread Model —— 动态上下文记忆池第 8 章：专注栈（focus.js）的继任者
//
// 三条修正（DynamicMemoryPool.md 8.2）：
//   - 认识论：焦点由行动者写入（touchCommitmentThread / openCommitment），不靠旁观者猜。
//   - 本体论：多条并发线索 + 一个前台指针，没有栈、没有 pop——前台切走线索只是去后台。
//   - 决策论：遗忘是读时纯函数（threadTemperature），不做写时状态突变；线索数据只增不删。
//
// 不在本模块的职责：
//   - 持久化（index.js 在状态变化后调 db.js saveThreadState）。
//   - LLM 调用（摘要在 thread-summarize.js，归属仲裁在 thread-classifier.js，本模块只产出事件）。
//   - prompt 渲染（prompt.js 按 threadTemperature 选粒度）。
//
// 与 focus.js 同款约束：直接从 keywords.js 拿 extractKeywords，纯 Node 可单测，不拉 SQLite。
import { extractKeywords } from './keywords.js'

// ── 温度窗口（墙钟时间，不是 tick——tick 间隔在任务/空闲模式下差 40 倍，不可作时间单位） ──
export const WARM_WINDOW_MS = 6 * 60 * 60 * 1000    // 6h 内活跃 → warm
export const COOL_WINDOW_MS = 48 * 60 * 60 * 1000   // 48h 内 → cool；更久 → cold

// 注入端配额：warm 线索一行摘要最多注入几条（少即是强约束的是注入结果，不是数据存亡）
export const MAX_WARM_INJECTED = 3

// 内存中保留的线索上限。超限时把最冷的「已关闭且无开放承诺」线索移出内存（db 里仍在）。
export const MAX_THREADS_IN_MEMORY = 12

// 单线索 conclusions 滚动上限（与专注栈时代一致）
export const THREAD_CONCLUSIONS_LIMIT = 5

// topic 关键词数量上限 / 抽取预算（沿用专注栈的标定）
const TOPIC_KEYWORDS_LIMIT = 3
const KEYWORD_EXTRACT_BUDGET = 12
const MIN_KEYWORDS_FOR_THREAD = 3
const MIN_MESSAGE_LENGTH = 4

// 线索"签名"：用于重叠匹配的关键词集合，比展示 topic 宽（提高 v0 字面匹配召回）。
const SIGNATURE_LIMIT = 8

// ngram 抽取器会把功能词碎片（"这个""续把""帮我"）排上来，它们跨话题高频出现，
// 用于归属匹配是纯噪声。匹配前过滤；展示 topic 也跟着干净。
const NOISE_TOKEN_RE = /^(这个|那个|什么|怎么|为什|可以|我们|你们|他们|帮我|给我|一下|一个|继续|部分|现在|今天|明天|昨天|晚上|早上|然后|还是|就是|但是|因为|所以|如果|这样|那样|的话|时候|问题|事情|东西|网页|网站|网址|页面|链接|地址|文件|文档|内容)/
const PRONOUN_FRAGMENT_RE = /^[你我他她它](?:现|在|要|想|能|会|是|不|还|正|刚|这|那|的|帮|给|下|看)/
const META_EVALUATION_SUFFIX_RE = /[，,；;]\s*(?:再)?(?:看看|看下|试试|验证(?:一下)?)\s*(?:你|这个|这次|新版本|这个新版本).{0,24}(?:表现|效果|怎么样|如何)[。.!！?？]*$/i
function normalizeAttributionToken(token) {
  const value = String(token || '').trim()
  return /^[a-z0-9_-]+$/i.test(value) ? value.toLowerCase() : value
}
function filterNoiseTokens(kws) {
  return (kws || []).filter(k => {
    const t = String(k || '').trim()
    if (!t) return false
    if (/^[a-z0-9_-]+$/i.test(t)) return t.length >= 3   // 英文/数字词：太短的丢掉
    if (NOISE_TOKEN_RE.test(t) || PRONOUN_FRAGMENT_RE.test(t)) return false
    return t.length >= 2
  }).map(normalizeAttributionToken)
}

function primaryAttributionText(text) {
  return String(text || '').replace(META_EVALUATION_SUFFIX_RE, '')
}

// 抽取用于归属判定的关键词（统一入口：消息侧与线索签名侧同源）
function extractAttributionKeywords(text) {
  // “再做一次 X，看看这个版本表现如何”里的后半句是在评价当前动作，不能让“版本/表现”
  // 把消息吸回一个旧版本话题。归属只取逗号前的主动作；原消息仍完整交给 Agent。
  return filterNoiseTokens(extractKeywords(primaryAttributionText(text), KEYWORD_EXTRACT_BUDGET))
}

// 切换门槛不对称（DynamicMemoryPool.md 8.5）：
//   前台续命是廉价操作 → 重叠 ≥1 即 continued；
//   后台切换是昂贵操作 → 重叠 ≥2 才 resumed（专注栈时代单关键词误 returned 的教训）。
const FOREGROUND_OVERLAP_MIN = 1
const BACKGROUND_RESUME_OVERLAP_MIN = 2

// 一次性叶子（沿用 focus.js 的标定）：不该开线索的消息。
const ONE_OFF_LEAF_RE = /天气|气温|温度|下雨|下雪|空气质量|AQI|几点|几号|星期几|汇率|股价|热搜|新闻|在吗|早上好|晚上好|谢谢|收到/i
const SUSTAINED_RE = /分析|优化|修复|实现|修改|设计|写|做|排查|调试|构建|部署|项目|代码|文件|机制|方案|测试|review|debug|fix|implement|build/i
const COMPACT_TARGETED_ACTION_RE = /(?:下载|安装|获取).{0,30}(?:[a-z][a-z0-9_-]{2,}|客户端|安装包|电脑版|桌面版)/i

// 指代性进度问询：设计上不含主题词（"它"=我最近答应的事），靠句式识别，路由到开放承诺。
const INDEXICAL_PROGRESS_RE = /(什么情况|怎么回事|咋回事|怎么样|咋样|如何了|进度|进展|搞定|好了吗|好了么|好了没|完成了吗|完成了没|弄完|做完|干完|干得|干的|还在弄|还在做|顺利|卡住|到哪|哪一步|(?:是不是|是否|还在|有没有).{0,12}(?:后台|工作|处理|执行|进行))/

export function isLikelyOneOffLeaf(body) {
  const text = String(body || '').trim()
  if (!text) return false
  if (SUSTAINED_RE.test(text)) return false
  if (/^(hello|hi|hey|在吗|早上好|晚上好|谢谢|收到)$/i.test(text)) return true
  return text.length <= 40 && ONE_OFF_LEAF_RE.test(text)
}

// 指代性问询 = 进度句式命中 + 不太长。不要求关键词稀薄——中文 ngram 抽取器
// 对"晚上的任务干得咋样"也能抽出一堆词，但句子的信息仍靠指代（"它"=我答应的事）。
// 显式点名别的话题时由调用方的 strong-overlap 守卫接管（明示压过暗示）。
export function isIndexicalProgressQuery(body) {
  const text = String(body || '').trim()
  // 指代性问询天然很短（"干得咋样""进度如何"）；长句里出现"进展"多半是实质请求的一部分
  if (!text || text.length > 25) return false
  return INDEXICAL_PROGRESS_RE.test(text)
}

// ── 指代-就近 / 精确回指（2026-06-19，治"打开那个网页"型话题漂移）─────────────
// 用户语言规律（来自实战 case：开源天梯榜对话连漂三轮到 YouTube）：
//   规律①「裸指代 / 泛指代」——只说"这个/那个"，或对泛称宾语施加操作（"打开那个网页""放一下"
//     "点开它"）。指代物不在这句话里，而在最近的对话里（用户倒数第二条 / 我上一条回复）。
//     这种句子绝不命名新话题，旧实现却按字面把"打开网页"切成"浏览器/网页"伪话题、挤掉真目标
//     ——这正是漂移源头。正解：续前台，从源头掐断伪话题诞生。
//   规律②「那个+具体名词」——用户特意点名一个较远的概念（"那个开源天梯"），名词本身就是
//     精确指代，是强 resume 信号，允许据此切回后台线索（门槛从≥2降到≥1）。
//
// 泛称宾语：本身不携带话题，只是"被操作的东西"的占位名词。
const GENERIC_OBJECT_RE = /(网页|网站|网址|页面|那页|这页|链接|地址|玩意儿?|东西|文件|文档|内容)/
// 操作动词：对宾语施加的动作，跨话题高频，本身不定义话题。
// 刻意不含 SUSTAINED_RE 里的"调试/部署/优化/实现"——那些动词本身就是话题。
const OPERATION_VERB_RE = /(打开|关闭|关掉|启动|运行|播放|暂停|下载|搜索|显示|发送|点开|访问|跳转|打开一?下|放一?下|查一?下|搜一?下|看一?下|念一?下|读一?下|发一?下)/
// 指代词 / 就近回指标记。
const DEMONSTRATIVE_RE = /(这|那)(个|种|些|位|款|家|件|批|类|段|张|篇|份|首|部|台|项|套|条|者|回|次)|它|他|她|刚才|刚刚|刚说|刚提|上面|前面|之前(说|讲|提|的|那)|你?刚(说|讲|发|放|提)/

/**
 * 把一条用户消息分类为 none / anaphora-recent / precise-callback。
 *   - anaphora-recent：就近回指（规律①）→ 上层应续前台，绝不新建/切走。
 *   - precise-callback：那个+具体名词（规律②）→ 上层用 referentKws 在所有线索里精确匹配，
 *       命中后台即 resume（门槛≥1）。
 *   - none：既非指代也非泛操作，走常规关键词归属。
 * substantive：句子剥掉操作动词/泛称后剩的实质话题词（供"明示压过暗示"守卫用）。
 */
export function classifyReference(body) {
  const text = String(body || '').trim()
  if (!text) return { kind: 'none', substantive: [] }
  const attributionText = primaryAttributionText(text)
  const hasDemon = DEMONSTRATIVE_RE.test(attributionText)
  const actsOnGeneric = GENERIC_OBJECT_RE.test(attributionText) && (OPERATION_VERB_RE.test(attributionText) || hasDemon)
  // 句子自身的实质话题词：剥掉操作动词、泛称、指代后还剩什么
  const substantive = extractAttributionKeywords(text)
    .filter(k => !OPERATION_VERB_RE.test(k) && !GENERIC_OBJECT_RE.test(k))
  // 光杆操作动词（"放一下""下载""打开吧"）：宾语缺省 = 指代最近对话里的东西。
  const bareOperation = OPERATION_VERB_RE.test(attributionText) && substantive.length === 0
  if (actsOnGeneric || bareOperation) return { kind: 'anaphora-recent', substantive }
  if (hasDemon && substantive.length === 0) return { kind: 'anaphora-recent', substantive }
  if (hasDemon && substantive.length > 0) return { kind: 'precise-callback', referentKws: substantive, substantive }
  return { kind: 'none', substantive }
}

// 按 lastEventAt 判断线索是否已冷（无视前台短路；开放承诺仍钉住温度）。
// 供归属规则里的守卫用："冷掉的前台不被弱信号续命"。
function isThreadColdByAge(state, thread, now = Date.now()) {
  if (!thread) return true
  const ts = ensureThreadState(state)
  if (ts.commitments.some(c => c.status === 'open' && c.threadId === thread.id)) return false
  const last = Date.parse(thread.lastEventAt || thread.createdAt || 0)
  const age = Number.isFinite(last) ? now - last : Infinity
  return age >= COOL_WINDOW_MS
}

function isTickMessage(message) {
  return typeof message === 'string' && /^TICK\s/i.test(message.trim())
}

// 与 focus.js 同款信封剥离：[ID:xxx] 时间戳 [渠道] 正文
export function stripMessageEnvelope(message) {
  if (!message) return ''
  if (isTickMessage(message)) return ''
  const m = message.match(/^\[[^\]]+\]\s*[\d\-T:+]+\s*\[[^\]]*\]\s*(.*)$/s)
  return m ? m[1].trim() : message.trim()
}

let idCounter = 0
function newId(prefix) {
  idCounter = (idCounter + 1) % 10000
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function makeThread(topic, { tick = 0, label = '', signature = null } = {}) {
  const now = new Date().toISOString()
  const topicArr = Array.isArray(topic) ? topic.slice(0, TOPIC_KEYWORDS_LIMIT) : []
  return {
    id: newId('th'),
    topic: topicArr,
    // signature：匹配用的宽关键词集（展示用 topic 是它的前缀子集）
    signature: Array.isArray(signature) && signature.length > 0
      ? signature.slice(0, SIGNATURE_LIMIT)
      : [...topicArr],
    label: label || '',
    summary: '',
    conclusions: [],
    status: 'open',
    createdAt: now,
    lastEventAt: now,
    lastEventTick: tick,
    hitCount: 1,
    lastSummaryAt: now,
  }
}

// ── ThreadState 形状与访问器 ──────────────────────────────────────────────
// state.threadState = { threads: Thread[], foregroundId: string|null, commitments: Commitment[] }

export function ensureThreadState(state) {
  if (!state.threadState || typeof state.threadState !== 'object') {
    state.threadState = { threads: [], foregroundId: null, commitments: [] }
  }
  const ts = state.threadState
  if (!Array.isArray(ts.threads)) ts.threads = []
  if (!Array.isArray(ts.commitments)) ts.commitments = []
  if (ts.foregroundId === undefined) ts.foregroundId = null
  return ts
}

export function getForegroundThread(state) {
  const ts = ensureThreadState(state)
  if (!ts.foregroundId) return null
  return ts.threads.find(t => t.id === ts.foregroundId) || null
}

export function getThreadById(state, id) {
  if (!id) return null
  return ensureThreadState(state).threads.find(t => t.id === id) || null
}

export function getOpenCommitments(state) {
  return ensureThreadState(state).commitments.filter(c => c.status === 'open')
}

// 最近的开放承诺（指代性问询的解析锚点）。channel 给了就优先同渠道。
// 同毫秒创建的承诺按数组序（即创建序）后者胜——commitments 是 push 进来的，数组序可信。
export function latestOpenCommitment(state, { channel = '' } = {}) {
  const open = getOpenCommitments(state)
  if (open.length === 0) return null
  const newestOf = (list) => {
    let best = null
    let bestTs = -Infinity
    for (const c of list) {
      const ts = Date.parse(c.createdAt || 0) || 0
      if (ts >= bestTs) { best = c; bestTs = ts }
    }
    return best
  }
  if (channel) {
    const sameChannel = open.filter(c => c.channel === channel)
    if (sameChannel.length > 0) return newestOf(sameChannel)
  }
  return newestOf(open)
}

// ── 承诺生命周期（行动者写入路径之一：set_task / clear_task 钩子调这里） ──────

// "好的我去做" = 单 Agent 版 spawn 时刻：开承诺，钉住线索温度。
// threadId 缺省挂到前台线索；前台为空就为这个承诺开一条新线索。
export function openCommitment(state, { text, threadId = null, channel = '', tick = 0 } = {}) {
  const ts = ensureThreadState(state)
  let thread = threadId ? getThreadById(state, threadId) : getForegroundThread(state)
  if (!thread) {
    const kws = extractAttributionKeywords(String(text || ''))
    thread = makeThread(kws.length ? kws.slice(0, TOPIC_KEYWORDS_LIMIT) : ['任务'], { tick, signature: kws })
    ts.threads.push(thread)
    ts.foregroundId = thread.id
  }
  // 同一线索上已有开放承诺 → 更新文本而不是叠加（task 是单例的）
  const existing = ts.commitments.find(c => c.status === 'open' && c.threadId === thread.id)
  if (existing) {
    existing.text = String(text || existing.text)
    return existing
  }
  const commitment = {
    id: newId('cm'),
    threadId: thread.id,
    text: String(text || ''),
    status: 'open',
    channel: channel || '',
    createdAt: new Date().toISOString(),
    closedAt: null,
  }
  ts.commitments.push(commitment)
  touchThread(state, thread.id, { tick })
  return commitment
}

// 交差/取消。承诺关闭后线索不再被钉住，按 lastEventAt 自然降温——没有任何突变动作。
export function closeCommitment(state, { threadId = null, commitmentId = null, status = 'done' } = {}) {
  const ts = ensureThreadState(state)
  const target = commitmentId
    ? ts.commitments.find(c => c.id === commitmentId && c.status === 'open')
    : ts.commitments.find(c => c.status === 'open' && (!threadId || c.threadId === threadId))
  if (!target) return null
  target.status = status === 'cancelled' ? 'cancelled' : 'done'
  target.closedAt = new Date().toISOString()
  return target
}

// ── 行动者写入路径之二：Agent 干活就是注意力事件 ─────────────────────────────
// index.js 在本轮有工具调用时调它（有开放承诺 touch 承诺线索，否则 touch 前台）。
// 这一条直接消灭"干活时饿死"——不需要任何 stale 阈值调优。
export function touchThread(state, threadId, { tick = 0 } = {}) {
  const thread = getThreadById(state, threadId)
  if (!thread) return false
  thread.lastEventAt = new Date().toISOString()
  thread.lastEventTick = tick
  thread.hitCount += 1
  return true
}

export function touchCommitmentThread(state, { tick = 0 } = {}) {
  const ts = ensureThreadState(state)
  const open = latestOpenCommitment(state)
  const targetId = open ? open.threadId : ts.foregroundId
  if (!targetId) return false
  return touchThread(state, targetId, { tick })
}

// ── 读时温度函数（DynamicMemoryPool.md 8.6）—— 注入粒度由这里决定，永不写回 ──
export function threadTemperature(state, thread, { now = Date.now() } = {}) {
  if (!thread) return 'cold'
  const ts = ensureThreadState(state)
  if (thread.id === ts.foregroundId) return 'foreground'
  // 开放承诺钉住温度，无视时间
  if (ts.commitments.some(c => c.status === 'open' && c.threadId === thread.id)) return 'warm'
  const last = Date.parse(thread.lastEventAt || thread.createdAt || 0)
  const age = Number.isFinite(last) ? now - last : Infinity
  if (age < WARM_WINDOW_MS) return 'warm'
  if (age < COOL_WINDOW_MS) return 'cool'
  return 'cold'
}

// 注入视图：prompt.js 的唯一入口。每轮重算（读时减法），不缓存、不落库。
export function buildThreadView(state, { now = Date.now() } = {}) {
  const ts = ensureThreadState(state)
  const foreground = getForegroundThread(state)
  const openCommitments = getOpenCommitments(state)
  const background = ts.threads
    .filter(t => t.id !== ts.foregroundId)
    .map(t => ({ thread: t, temperature: threadTemperature(state, t, { now }) }))
    .filter(x => x.temperature === 'warm')
    .sort((a, b) => Date.parse(b.thread.lastEventAt || 0) - Date.parse(a.thread.lastEventAt || 0))
    .slice(0, MAX_WARM_INJECTED)
  return {
    foreground,
    foregroundCommitment: foreground
      ? openCommitments.find(c => c.threadId === foreground.id) || null
      : null,
    background, // [{ thread, temperature }]
    openCommitments,
  }
}

// ── 关键词重叠：对线索的 signature ∪ topic 做字面交集 ──
// 注（2026-06-20）：曾试过"词干包含"模糊匹配（"天梯"⊂"版天梯"），干净起点能多连上同概念，
// 但活 app 实测它在真实脏线索池里把全新内容也凭子串撞进垃圾线索（n-gram 切的"它是有/么死"
// 含高频碎片，模糊后到处命中），净负收益，已撤回。回到精确匹配。
function overlapCount(thread, kws) {
  if (!thread) return 0
  const set = new Set([...(thread.signature || []), ...(thread.topic || [])].map(normalizeAttributionToken))
  if (set.size === 0) return 0
  let n = 0
  for (const k of kws) if (set.has(normalizeAttributionToken(k))) n++
  return n
}

// ── 用户消息归属判定（唯一需要"判断"的入口；Agent 侧走声明，不经过这里） ─────
//
// 返回 { event, thread, switchedFrom }：
//   created   — 新建线索并置前台
//   continued — 命中前台线索
//   resumed   — 前台切到既有后台线索（指代性问询路由 / 重叠≥2）
//   ambiguous — 与某后台线索重叠=1：不切换（保持前台不动），返回候选给分类器仲裁
//   noop      — 叶子/太短/TICK，不动
//
// switchedFrom：resumed/created 导致前台易主时的旧前台线索（上层对它发增量摘要）。
export function attributeUserMessage(state, message, {
  tick = 0,
  channel = '',
} = {}) {
  const ts = ensureThreadState(state)
  const body = stripMessageEnvelope(message)
  if (!body || body.length < MIN_MESSAGE_LENGTH) return { event: 'noop', thread: null, switchedFrom: null }
  if (isLikelyOneOffLeaf(body)) return { event: 'noop', thread: null, switchedFrom: null }

  const kws = extractAttributionKeywords(body)
  const foreground = getForegroundThread(state)

  // 1) 指代性进度问询 → 最近开放承诺的线索。
  //    守卫：消息显式点名了另一条线索（重叠≥2）时，明示压过暗示，落到规则 3/4 走正常切换。
  if (isIndexicalProgressQuery(body)) {
    const commitment = latestOpenCommitment(state, { channel })
    if (commitment) {
      const target = getThreadById(state, commitment.threadId)
      const namesOtherThread = ts.threads.some(t =>
        target && t.id !== target.id && overlapCount(t, kws) >= BACKGROUND_RESUME_OVERLAP_MIN
      )
      if (target && !namesOtherThread) {
        const switchedFrom = foreground && foreground.id !== target.id ? foreground : null
        ts.foregroundId = target.id
        touchThread(state, target.id, { tick })
        return { event: switchedFrom ? 'resumed' : 'continued', thread: target, switchedFrom, via: 'commitment' }
      }
      // namesOtherThread：不在这里 return，落到下面的常规归属规则
    } else {
      // 没有开放承诺的进度问句：当作对前台的继续（若前台还没冷），否则 noop
      if (foreground && !isThreadColdByAge(state, foreground)) {
        touchThread(state, foreground.id, { tick })
        return { event: 'continued', thread: foreground, switchedFrom: null }
      }
      return { event: 'noop', thread: null, switchedFrom: null }
    }
  }

  // 1.5) 指代-就近 / 精确回指（2026-06-19）。在常规关键词归属之前拦截。
  const ref = classifyReference(body)
  if (ref.kind === 'anaphora-recent') {
    // 规律①：指代物在最近对话里 = 续前台，绝不新建/切走 → 从源头掐断"浏览器"型伪话题。
    // 守卫一（明示压过暗示）：句子的实质词若强匹配某后台线索(≥2)，说明用户其实点了名，
    //   不当就近回指，落常规切换。
    const namesOther = (ref.substantive || []).length > 0 && ts.threads.some(t =>
      (!foreground || t.id !== foreground.id) && overlapCount(t, ref.substantive) >= BACKGROUND_RESUME_OVERLAP_MIN
    )
    // 守卫二：冷掉的前台不当就近锚点（沿用 bug2 教训）——落常规规则。
    if (!namesOther && foreground && !isThreadColdByAge(state, foreground)) {
      touchThread(state, foreground.id, { tick })
      return { event: 'continued', thread: foreground, switchedFrom: null, via: 'anaphora-recent' }
    }
  } else if (ref.kind === 'precise-callback' && ref.referentKws.length > 0) {
    // 规律②：那个+具体名词是强 resume 信号。具体词命中前台→continued，命中后台→resume（门槛≥1）。
    const rkws = ref.referentKws
    if (foreground && overlapCount(foreground, rkws) >= 1) {
      touchThread(state, foreground.id, { tick })
      return { event: 'continued', thread: foreground, switchedFrom: null, via: 'callback' }
    }
    let cbBest = null
    let cbOverlap = 0
    for (const t of ts.threads) {
      if (foreground && t.id === foreground.id) continue
      const n = overlapCount(t, rkws)
      if (n > cbOverlap) { cbBest = t; cbOverlap = n }
    }
    // 收紧（2026-06-20）：切到后台线索需 ≥2 个关键词命中。单关键词巧合多是脏池子里的垃圾线索
    // 碰瓷，不足以夺走话题——宁可走下面的 fallback 续前台，也不错认旧垃圾线索（实测的主病灶）。
    if (cbBest && cbOverlap >= BACKGROUND_RESUME_OVERLAP_MIN) {
      const switchedFrom = foreground && foreground.id !== cbBest.id ? foreground : null
      ts.foregroundId = cbBest.id
      touchThread(state, cbBest.id, { tick })
      return { event: switchedFrom ? 'resumed' : 'continued', thread: cbBest, switchedFrom, via: 'callback' }
    }
    // 落空 fallback（2026-06-19，治话题增殖）：带指代词的句子（"这个排名""那种榜单"）哪怕
    // 一个既有线索都没字面命中，也几乎不会是凭空的新话题——指代词本身就宣告"我在指刚才聊的东西"。
    // 此时续前台，而不是新建一条伪线索。前台冷/无前台才落常规（真·指向一个已淡出的远概念时新建）。
    if (foreground && !isThreadColdByAge(state, foreground)) {
      touchThread(state, foreground.id, { tick })
      return { event: 'continued', thread: foreground, switchedFrom: null, via: 'callback-fallback' }
    }
  }

  // 2) 关键词稀薄的短消息：续前台（廉价、可自愈）。
  //    守卫：冷掉的前台不续命——这是专注栈时代"短问句给过期栈顶续命"的教训；
  //    冷判断是读时的纯函数，不需要任何清理动作配合。
  // “下载 CapCut”只有两个高信息关键词，但它是明确的新动作，不能因为词少就无条件黏在
  // 任意前台闲聊上。其余普通短句仍沿用廉价续前台策略。
  const compactTargetedAction = kws.length >= 2 && COMPACT_TARGETED_ACTION_RE.test(body)
  if (kws.length < MIN_KEYWORDS_FOR_THREAD && !compactTargetedAction) {
    if (foreground && !isThreadColdByAge(state, foreground)) {
      touchThread(state, foreground.id, { tick })
      return { event: 'continued', thread: foreground, switchedFrom: null }
    }
    return { event: 'noop', thread: null, switchedFrom: null }
  }

  // 3) 前台重叠 ≥1 → continued
  if (foreground && overlapCount(foreground, kws) >= FOREGROUND_OVERLAP_MIN) {
    touchThread(state, foreground.id, { tick })
    return { event: 'continued', thread: foreground, switchedFrom: null }
  }

  // 4) 后台线索：≥2 切换；=1 不切换、报 ambiguous 给分类器
  let best = null
  let bestOverlap = 0
  for (const t of ts.threads) {
    if (foreground && t.id === foreground.id) continue
    const n = overlapCount(t, kws)
    if (n > bestOverlap) { best = t; bestOverlap = n }
  }
  if (best && bestOverlap >= BACKGROUND_RESUME_OVERLAP_MIN) {
    ts.foregroundId = best.id
    touchThread(state, best.id, { tick })
    return { event: 'resumed', thread: best, switchedFrom: foreground || null }
  }

  // 5) 新建线索置前台。误判的代价是多一条线索（合并可修正），不是失忆。
  const created = makeThread(kws.slice(0, TOPIC_KEYWORDS_LIMIT), { tick, signature: kws })
  ts.threads.push(created)
  const switchedFrom = foreground || null
  ts.foregroundId = created.id
  evictColdThreads(state)
  if (best && bestOverlap === 1) {
    // 弱信号候选：留给后台分类器仲裁，确认是同一事则 mergeThreads（合并永远安全）
    return { event: 'created', thread: created, switchedFrom, ambiguousWith: best }
  }
  return { event: 'created', thread: created, switchedFrom }
}

// ── 合并（分类器事后仲裁"其实是同一条线索"时的修正动作；无栈序，永远安全） ────
// 把 source 并入 target：事件归属（db 行的 thread_id 重写由上层做），内存侧合 topic/结论/计数。
export function mergeThreads(state, sourceId, targetId) {
  const ts = ensureThreadState(state)
  const source = getThreadById(state, sourceId)
  const target = getThreadById(state, targetId)
  if (!source || !target || source.id === target.id) return null
  const topicSet = new Set([...(target.topic || []), ...(source.topic || [])])
  target.topic = [...topicSet].slice(0, TOPIC_KEYWORDS_LIMIT)
  const sigSet = new Set([...(target.signature || []), ...(source.signature || [])])
  target.signature = [...sigSet].slice(0, SIGNATURE_LIMIT)
  for (const c of source.conclusions || []) {
    if (!target.conclusions.includes(c)) target.conclusions.push(c)
  }
  while (target.conclusions.length > THREAD_CONCLUSIONS_LIMIT) target.conclusions.shift()
  if (source.summary && !target.summary) target.summary = source.summary
  target.hitCount += source.hitCount || 0
  if (Date.parse(source.lastEventAt || 0) > Date.parse(target.lastEventAt || 0)) {
    target.lastEventAt = source.lastEventAt
    target.lastEventTick = source.lastEventTick
  }
  // 承诺过户
  for (const c of ts.commitments) {
    if (c.threadId === source.id) c.threadId = target.id
  }
  ts.threads = ts.threads.filter(t => t.id !== source.id)
  if (ts.foregroundId === source.id) ts.foregroundId = target.id
  return target
}

// 给线索挂结论（增量摘要器回填用）。滚动上限，绝不替换原文。
export function appendConclusion(thread, conclusion) {
  if (!thread || !conclusion) return
  if (!Array.isArray(thread.conclusions)) thread.conclusions = []
  const text = String(conclusion).trim()
  if (!text || thread.conclusions.includes(text)) return
  thread.conclusions.push(text)
  while (thread.conclusions.length > THREAD_CONCLUSIONS_LIMIT) thread.conclusions.shift()
}

// 内存瘦身（不是遗忘）：超限时把 cold 且无开放承诺、已有摘要沉淀的线索移出内存。
// db 里整条仍在（saveThreadState 落库在先），召回走仓库。前台永不出列。
export function evictColdThreads(state, { now = Date.now() } = {}) {
  const ts = ensureThreadState(state)
  if (ts.threads.length <= MAX_THREADS_IN_MEMORY) return []
  const evictable = ts.threads
    .filter(t => t.id !== ts.foregroundId)
    .filter(t => threadTemperature(state, t, { now }) === 'cold')
    .sort((a, b) => Date.parse(a.lastEventAt || 0) - Date.parse(b.lastEventAt || 0))
  const excess = ts.threads.length - MAX_THREADS_IN_MEMORY
  const evicted = evictable.slice(0, excess)
  if (evicted.length === 0) return []
  const ids = new Set(evicted.map(t => t.id))
  ts.threads = ts.threads.filter(t => !ids.has(t.id))
  return evicted
}

// ── 从专注栈一次性迁移（首启 threads 为空且 focus_stack 有货时） ─────────────
// 帧→线索：栈顶=前台，其余=后台。承诺无从恢复（旧模型没有这个概念），留空。
export function migrateFocusStackToThreads(focusStack, { tick = 0 } = {}) {
  const threads = []
  for (const frame of (focusStack || [])) {
    if (!frame || !Array.isArray(frame.topic) || frame.topic.length === 0) continue
    const t = makeThread(frame.topic, { tick, signature: frame.topic })
    t.createdAt = frame.startedAt || t.createdAt
    t.lastEventAt = frame.startedAt || t.lastEventAt
    t.lastEventTick = frame.lastSeenTick || tick
    t.hitCount = frame.hitCount || 1
    t.conclusions = Array.isArray(frame.conclusions) ? frame.conclusions.slice(-THREAD_CONCLUSIONS_LIMIT) : []
    threads.push(t)
  }
  return {
    threads,
    foregroundId: threads.length > 0 ? threads[threads.length - 1].id : null,
    commitments: [],
  }
}

// 便捷：渲染线索为单行人话（brain-ui / 日志用）
export function describeThread(thread) {
  if (!thread) return ''
  const label = thread.label || (Array.isArray(thread.topic) ? thread.topic.join(',') : '')
  const lastConclusion = Array.isArray(thread.conclusions) && thread.conclusions.length > 0
    ? thread.conclusions[thread.conclusions.length - 1]
    : ''
  return lastConclusion ? `${label} — ${lastConclusion}` : label
}
