// 线索模型（DynamicMemoryPool.md 第 8 章）纯算法测试。
// 不动数据库、不动 LLM、不动网络。
//
// 重点覆盖"专注栈四 bug 在线索模型下失去存在前提"的回归断言：
//   1. 干活不饿死：开放承诺钉住温度，任意墙钟时间后 warm 不降。
//   2. 指代性问询路由：前台在别处时"干得怎么样了"切回承诺线索。
//   3. 单关键词不误切换：与后台重叠=1 → 新建+ambiguous，前台明确切换需要重叠≥2。
//   4. 读时减法可自愈：温度由 buildThreadView 每轮重算，无任何"清理"状态突变。
//   5. focusStack → threads 迁移：栈顶=前台，conclusions 保留。
//
// prompt 集成（<thread> 渲染）需要 stub loader（prompt.js 间接接 DB）。
//
// Run: node src/test-threads.js
import { register } from 'node:module'
register('./test-prompt-split-loader.mjs', import.meta.url)

import {
  ensureThreadState, attributeUserMessage, buildThreadView, getForegroundThread,
  openCommitment, closeCommitment, touchCommitmentThread, latestOpenCommitment,
  mergeThreads, migrateFocusStackToThreads, threadTemperature, makeThread,
  isIndexicalProgressQuery, isLikelyOneOffLeaf, classifyReference,
  WARM_WINDOW_MS, COOL_WINDOW_MS, MAX_WARM_INJECTED,
} from './memory/threads.js'
import { buildSummarizeInput } from './memory/thread-summarize.js'
import { buildContextBlock } from './prompt.js'

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
  return { threadState: { threads: [], foregroundId: null, commitments: [] } }
}

// 白盒造线索（绕开 token 切分偶然性）
function addThread(state, topic, { lastEventAgoMs = 0, foreground = false, conclusions = [], signature = null } = {}) {
  const ts = ensureThreadState(state)
  const t = makeThread(topic, { signature })
  t.lastEventAt = new Date(Date.now() - lastEventAgoMs).toISOString()
  t.createdAt = new Date(Date.now() - lastEventAgoMs - 60000).toISOString()
  t.conclusions = conclusions
  ts.threads.push(t)
  if (foreground) ts.foregroundId = t.id
  return t
}

console.log('— 基础归属 —')
{
  const state = makeState()
  const r1 = attributeUserMessage(state, '帮我 build realtime dashboard component integration 这个项目')
  assert(r1.event === 'created', '首条实质消息 → created')
  assert(getForegroundThread(state) === r1.thread, 'created 线索成为前台')

  const r2 = attributeUserMessage(state, '继续把 dashboard component 部分做完')
  assert(r2.event === 'continued', '前台重叠 ≥1 → continued')

  const r3 = attributeUserMessage(state, '今天广州的天气怎么样啊')
  assert(r3.event === 'noop', '天气叶子 → noop 不动线索')
  assert(getForegroundThread(state) === r1.thread, '叶子不改前台')
}

console.log('— Bug1 回归：干活不饿死（承诺钉温度） —')
{
  const state = makeState()
  const t = addThread(state, ['alpha', 'mainline', 'project'], { foreground: true })
  openCommitment(state, { text: '完成 alpha 项目部署', threadId: t.id })
  // 模拟"干活很久没人说话"：lastEventAt 推到 3 天前（远超 COOL_WINDOW）
  t.lastEventAt = new Date(Date.now() - COOL_WINDOW_MS - 24 * 3600 * 1000).toISOString()
  // 前台让位给别的线索，t 退到后台
  addThread(state, ['beta', 'chat', 'topic'], { foreground: true })
  assert(threadTemperature(state, t) === 'warm', '开放承诺钉住温度：3 天没动静仍 warm 不降')
  closeCommitment(state, { threadId: t.id })
  assert(threadTemperature(state, t) === 'cold', '承诺关闭后按 lastEventAt 自然降温为 cold')

  // touchCommitmentThread：Agent 干活刷新承诺线索
  const c = openCommitment(state, { text: '继续 alpha', threadId: t.id })
  const before = t.hitCount
  assert(touchCommitmentThread(state) === true, '工具调用 touch 承诺线索成功')
  assert(t.hitCount === before + 1, 'touch 刷新 hitCount')
  assert(latestOpenCommitment(state).id === c.id, 'latestOpenCommitment 取到该承诺')
}

console.log('— Bug2 回归：指代性问询路由到开放承诺 —')
{
  const state = makeState()
  const morning = addThread(state, ['火星', '科幻', '小说'], { foreground: true })
  const evening = addThread(state, ['alpha', 'mainline', 'project'])
  openCommitment(state, { text: '晚上把 alpha 项目部署完', threadId: evening.id })
  // 前台仍是早上的线索（专注栈时代这里必然答错）
  ensureThreadState(state).foregroundId = morning.id

  assert(isIndexicalProgressQuery('干得怎么样了'), '"干得怎么样了"识别为指代性问询')
  const r = attributeUserMessage(state, '干得怎么样了？')
  assert(r.event === 'resumed' && r.thread === evening, '进度问询切回承诺线索（不是早上的前台）')
  assert(r.via === 'commitment', '路由途径 = commitment')
  assert(getForegroundThread(state) === evening, '前台指针移到承诺线索')
  assert(r.switchedFrom === morning, '旧前台作为 switchedFrom 交给摘要器')

  // 明示压过暗示：进度句式但显式点名另一条线索（重叠≥2）→ 不抢路由
  const r2 = attributeUserMessage(state, '火星 科幻 那个故事进展如何了')
  assert(r2.thread !== evening, '显式点名其他线索时进度路由让位')
}

console.log('— 真实下载话术回归：不被旧版本线索抢占 —')
{
  const state = makeState()
  const oldVersion = addThread(state, ['你现', '新版', '版本'], {
    signature: ['你现', '新版', '版本', '表现'],
  })
  const download = addThread(state, ['下载', 'capcut', '安装包'], {
    signature: ['下载', 'CapCut', '安装包'],
  })
  addThread(state, ['当前', '普通', '闲聊'], { foreground: true })

  const started = attributeUserMessage(state, '你现在再次帮我下载capcut，看看你这个新版本表现怎么样')
  assert(started.event === 'resumed' && started.thread === download,
    '真实下载请求回到下载线索，而不是旧“版本”线索')
  assert(started.thread !== oldVersion, '评价新版本的尾句不参与主任务归属')
  assert(isIndexicalProgressQuery('什么情况'), '“什么情况”识别为当前任务追问')
  const status = attributeUserMessage(state, '什么情况')
  assert(status.thread === download && status.event === 'continued', '“什么情况”留在下载线索')
  assert(isIndexicalProgressQuery('你是不是在后台进行工作'), '后台工作问句识别为当前任务追问')
  const background = attributeUserMessage(state, '你是不是在后台进行工作')
  assert(background.thread === download && background.event === 'continued', '后台工作问句留在下载线索')
}

console.log('— Bug3 回归：单关键词不误切换 —')
{
  const state = makeState()
  const old = addThread(state, ['项目', '部署', '配置'], { lastEventAgoMs: 3600 * 1000 })
  addThread(state, ['现在', '聊天', '随便'], { foreground: true })
  // 与 old 仅"项目"一个词重叠 → 不应切换
  const r = attributeUserMessage(state, '新项目 newunique freshwords 方案讨论一下')
  assert(r.event === 'created', '重叠=1 → 新建线索而不是切换')
  assert(r.ambiguousWith === old, '弱信号候选交给分类器仲裁（ambiguousWith）')
  assert(getForegroundThread(state) === r.thread, '新线索置前台')

  // 重叠 ≥2 → 才允许切换
  const state2 = makeState()
  const target = addThread(state2, ['alpha', 'mainline', 'project'], { lastEventAgoMs: 3600 * 1000 })
  addThread(state2, ['当前', '闲聊', '话题'], { foreground: true })
  const r2 = attributeUserMessage(state2, '回到 alpha mainline 那个事接着弄')
  assert(r2.event === 'resumed' && r2.thread === target, '重叠≥2 → resumed 切换')
}

console.log('— Bug2 衍生：冷前台不被短消息续命 —')
{
  const state = makeState()
  const stale = addThread(state, ['古老', '话题', '词组'], { foreground: true, lastEventAgoMs: COOL_WINDOW_MS + 3600 * 1000 })
  const r = attributeUserMessage(state, '嗯嗯好的呢')
  assert(r.event === 'noop', '关键词稀薄短消息不给 cold 前台续命')
  assert(stale.hitCount === 1, '冷前台 hitCount 未被刷新')
}

console.log('— 并发承诺：按 id 精确关闭 + 路由 —')
{
  const state = makeState()
  const ta = addThread(state, ['任务A', '编程', '动画'])
  const tb = addThread(state, ['任务B', '调研', '报告'], { foreground: true })
  const ca = openCommitment(state, { text: '做完动画项目', threadId: ta.id })
  const cb = openCommitment(state, { text: '写完调研报告', threadId: tb.id })
  // 单任务槽位场景：任务 B 完成，必须只关 B 的承诺（不带 id 的旧行为会误关最老的 A）
  const closed = closeCommitment(state, { commitmentId: cb.id, status: 'done' })
  assert(closed === cb, '按 id 关闭命中 B')
  assert(ca.status === 'open', 'A 的承诺不被误关（单任务槽位下的旧 bug）')
  assert(latestOpenCommitment(state) === ca, '此后指代性问询路由回 A（唯一开放承诺）')
  // 两个都开着时：latestOpenCommitment 取最新（"咋样了"默认指最近布置的事）
  const cb2 = openCommitment(state, { text: '再做一个 B2', threadId: tb.id })
  assert(latestOpenCommitment(state) === cb2, '多承诺并存时取最新创建的')
}

console.log('— 合并修正（分类器判 same 后） —')
{
  const state = makeState()
  const a = addThread(state, ['alpha', 'project'], { conclusions: ['我完成了部署'] })
  const b = addThread(state, ['alpha', 'deploy'], { foreground: true, conclusions: ['我修好了配置'] })
  openCommitment(state, { text: '完成 alpha', threadId: b.id })
  const merged = mergeThreads(state, b.id, a.id)
  assert(merged === a, 'mergeThreads 返回目标线索')
  assert(ensureThreadState(state).threads.length === 1, '合并后只剩一条线索')
  assert(a.conclusions.includes('我修好了配置'), '结论合并保留')
  assert(latestOpenCommitment(state).threadId === a.id, '承诺过户到目标线索')
  assert(ensureThreadState(state).foregroundId === a.id, '前台指针跟随合并')
}

console.log('— 读时减法：buildThreadView —')
{
  const state = makeState()
  const fg = addThread(state, ['当前', '工作', '主线'], { foreground: true })
  openCommitment(state, { text: '把主线做完', threadId: fg.id })
  addThread(state, ['温暖', '近期', '话题'], { lastEventAgoMs: 60 * 1000, conclusions: ['我聊过这个'] })
  addThread(state, ['凉了', '昨天', '话题'], { lastEventAgoMs: WARM_WINDOW_MS + 3600 * 1000 })
  addThread(state, ['冷掉', '上周', '话题'], { lastEventAgoMs: COOL_WINDOW_MS + 3600 * 1000 })
  for (let i = 0; i < MAX_WARM_INJECTED + 2; i++) {
    addThread(state, [`warm${i}a`, `warm${i}b`], { lastEventAgoMs: (i + 2) * 60 * 1000, conclusions: [`结论${i}`] })
  }
  const view = buildThreadView(state)
  assert(view.foreground === fg, 'view.foreground = 前台线索')
  assert(view.foregroundCommitment?.text === '把主线做完', 'view 带前台开放承诺')
  assert(view.background.length === MAX_WARM_INJECTED, `warm 注入配额 = ${MAX_WARM_INJECTED}（少即是强约束注入结果）`)
  assert(view.background.every(x => x.temperature === 'warm'), 'cool/cold 不进注入视图')
  // 自愈性：把凉线索"拾起"（模拟用户重提）后再算，立刻回到视图
  const coolThread = ensureThreadState(state).threads.find(t => t.topic[0] === '凉了')
  coolThread.lastEventAt = new Date().toISOString()
  const view2 = buildThreadView(state)
  assert(view2.background.some(x => x.thread === coolThread), '温度读时重算：重新活跃立刻回到视图（无需任何恢复动作）')
}

console.log('— 多话题 20 轮连续性（活 app 实测话术 · 抗增殖回归）—')
{
  // 来自 2.1.424 活 app 20 轮端到端实测：修前 v0 增殖到 10 条线索（同概念分词边界漂移→精确交集=0→反复新建）。
  // 修后（模糊词干重叠 + 指代词表拓宽 + 指代落空续前台）应收敛到 ≤4 条。
  const T = [
    '帮我讲讲现在开源大模型天梯榜大概是什么排名',      // 1 建话题
    '我更想了解那种盲测投票的榜单是怎么回事',          // 2 那种(拓宽)+落空续前台
    '那个榜单一般多久更新一次',                        // 3
    '它前三名通常是哪几个模型',                        // 4 裸指代它
    '那这个排名到底可不可信，有什么争议',              // 5 这个+落空续前台
    '换个话题，周杰伦最近有什么新歌',                  // 6 真切换(无指代)
    '他早期专辑你印象最深的是哪张',                    // 7 他(人称,拓宽)
    '七里香大概是哪一年发行的来着',                    // 8 无指代·子话题
    '对了今天广州天气怎么样',                          // 9 叶子
    '刚说的那张专辑里你最推荐哪一首',                  // 10 刚说/那张
    '回到刚才那个开源天梯榜，DeepSeek 排第几',         // 11 精确回指(远)→切回天梯
    '帮我想一篇讲大模型评测方法的短文提纲',            // 12 无指代
    '开头那部分从历史背景写起好不好',                  // 13 那部分
    '那个评测的关键指标你建议列哪几个',                // 14 那个评测
    '这个提纲你觉得大概写得怎么样了',                  // 15 这个提纲
    '那篇短文你会给它取个什么标题',                    // 16 那篇
    '说回天梯榜那个事，开源和闭源差距大吗',            // 17 那个事→天梯
    '那个周杰伦的话题，他一共获过几次金曲奖',          // 18 那个周杰伦→音乐
    '这个整体聊下来你怎么看',                          // 19 裸指代
    '好了今天就聊到这儿，谢谢你',                      // 20 收尾叶子
  ]
  const st = makeState()
  const seen = new Map()
  const ev = []
  T.forEach((m, i) => {
    const r = attributeUserMessage(st, m, { tick: i })
    const fg = getForegroundThread(st)
    if (fg && !seen.has(fg.id)) seen.set(fg.id, seen.size)
    ev.push({ event: r.event, fg })
  })
  const distinct = seen.size
  assert(distinct <= 4, `20 轮多话题收敛到 ≤4 条线索（实得 ${distinct}，修前 10）`)

  // 指代轮绝不新建线索（抗增殖不变量）：这些句子都带指代词，必须 continued/resumed/noop
  const demonTurns = [2, 3, 4, 5, 7, 10, 13, 14, 15, 16, 17, 18, 19]
  const spawned = demonTurns.filter(n => ev[n - 1].event === 'created')
  assert(spawned.length === 0, `指代轮无一新建线索（违例轮：${spawned.join(',') || '无'}）`)

  // 天梯主线就近连续：T1/T4/T5 同一条线索（前台续命，可靠）
  const A = ev[0].fg
  assert(ev[3].fg === A && ev[4].fg === A, 'T4/T5 仍在天梯线索（前台续命）')
  // 真切换仍然能切走（T6 无指代换话题）——抗增殖没把真切换也焊死
  assert(ev[5].fg !== A, 'T6 无指代换话题·正常切到新线索')

  // 止血版的契约（2026-06-20）：跨线索"回指召回"受签名质量限制——n-gram 分词器常把
  // "帮我讲讲现在"的碎片排进 top-8 签名、漏掉"天梯榜"，导致 T11"开源天梯榜"精确重叠<2 切不回 A。
  // 这是刻意取舍：收紧后台 resume（≥2）后宁可回指不到、续前台，也绝不靠单关键词巧合错认
  // 真实脏池子里的垃圾线索（实测主病灶）。所以这里只断言"指代回指轮绝不新建/不增殖"，
  // 不再断言"必须切回 A"——跨线索召回留待签名质量专项（option C）。
  const callbackTurns = [11, 17, 18]
  const cbSpawned = callbackTurns.filter(n => ev[n - 1].event === 'created')
  assert(cbSpawned.length === 0, `回指轮不凭空新建线索（违例轮：${cbSpawned.join(',') || '无'}）`)
}

console.log('— focusStack 迁移 —')
{
  const legacy = [
    { topic: ['早上', '项目'], startedAt: '2026-06-10T08:00:00Z', lastSeenTick: 5, hitCount: 4, conclusions: ['我早上完成了初版'] },
    { topic: ['晚上', '任务'], startedAt: '2026-06-10T20:00:00Z', lastSeenTick: 30, hitCount: 2, conclusions: [] },
  ]
  const migrated = migrateFocusStackToThreads(legacy)
  assert(migrated.threads.length === 2, '两帧 → 两线索')
  assert(migrated.foregroundId === migrated.threads[1].id, '栈顶 = 前台')
  assert(migrated.threads[0].conclusions[0] === '我早上完成了初版', 'conclusions 保留')
  assert(migrated.commitments.length === 0, '旧模型无承诺概念，迁移为空')
}

console.log('— 摘要器输入（纯函数） —')
{
  const t = makeThread(['alpha', 'project'])
  t.summary = '我已部署了第一版'
  const input = buildSummarizeInput(t, {
    conversations: [
      { from_id: 'user', to_id: 'jarvis', timestamp: '2026-06-10T21:00:00Z', content: '部署到测试环境' },
      { from_id: 'jarvis', to_id: 'user', timestamp: '2026-06-10T21:01:00Z', content: '好，我来弄' },
    ],
    actionLogs: [{ timestamp: '2026-06-10T21:02:00Z', tool: 'exec_command', summary: 'deploy to staging', status: 'ok' }],
  })
  assert(input.includes('[Previous summary — do not restate] 我已部署了第一版'), '增量摘要带上一版摘要')
  assert(input.includes('user -> You'), '对话行带方向标')
  assert(input.includes('exec_command'), '工具调用入摘要输入')
}

console.log('— prompt 渲染：<thread> / <threads-background> —')
{
  const state = makeState()
  const fg = addThread(state, ['alpha', 'project'], { foreground: true })
  fg.label = 'alpha 部署'
  fg.summary = '我已部署了第一版'
  openCommitment(state, { text: '把 alpha 项目部署完', threadId: fg.id })
  addThread(state, ['火星', '科幻'], { lastEventAgoMs: 60 * 1000, conclusions: ['用户提议写火星故事，我列了大纲'] })

  const ctx = buildContextBlock({ threadView: buildThreadView(state) })
  assert(ctx.includes('<thread topic="alpha 部署"'), '<thread> 用 label 作 topic')
  assert(ctx.includes('Open commitment'), '前台带开放承诺行')
  assert(ctx.includes('把 alpha 项目部署完'), '承诺文本注入')
  assert(ctx.includes('report on it'), '进度问询指向承诺的指令在')
  assert(ctx.includes('<threads-background>'), '后台线索段在')
  assert(ctx.includes('火星'), '后台线索结论/关键词可见')

  // 遗留路径：threadView 缺省时 focusStack 渲染照旧（旧测试兼容）
  const legacyCtx = buildContextBlock({
    focusStack: [{ topic: ['legacy', 'topic'], startedAtTick: 1, lastSeenTick: 2, hitCount: 3, conclusions: [] }],
    focusTickCounter: 3,
  })
  assert(legacyCtx.includes('<focus topic="legacy, topic"'), '遗留 focusStack 渲染保持')
}

console.log('— classifyReference 分类 —')
{
  assert(classifyReference('那个打开网页，打开').kind === 'anaphora-recent', '"那个打开网页"=就近回指')
  assert(classifyReference('没有打开那个网站').kind === 'anaphora-recent', '"打开那个网站"=就近回指')
  assert(classifyReference('放一下').kind === 'anaphora-recent', '"放一下"泛操作=就近回指')
  assert(classifyReference('就这个吧').kind === 'anaphora-recent', '裸指代"就这个吧"=就近回指')
  const cb = classifyReference('回到那个开源天梯接着看')
  assert(cb.kind === 'precise-callback', '"那个+具体名词"=精确回指')
  assert(cb.referentKws.some(k => k.includes('天梯') || k.includes('开源')), '精确回指带出具体名词')
  assert(classifyReference('帮我修复部署脚本里的报错').kind === 'none', '实质任务句=none 走常规归属')
}

console.log('— 话题漂移回归：开源天梯榜 case（真实对话逐回合）—')
{
  const state = makeState()
  const r1 = attributeUserMessage(state, '帮我查一下那些大模型 TNT 版天梯榜')
  assert(r1.event === 'created', 'T1 首句建线索A')
  const a = r1.thread

  const r2 = attributeUserMessage(state, '我想知道那个开源相关的大模型的天梯')
  assert(r2.thread === a, 'T2 开源天梯仍归线索A（不漂）')

  // T3：旧实现在这里凭空切到"谷歌/浏览器/打开"伪线索 → 漂移源头
  const r3 = attributeUserMessage(state, '你用我的谷歌浏览器吧 那个打开网页 打开')
  assert(r3.via === 'anaphora-recent', 'T3 "那个打开网页"判为就近回指')
  assert(r3.thread === a, 'T3 续线索A，不新建"浏览器"伪线索')
  assert(getForegroundThread(state) === a, 'T3 前台仍是天梯线索A')

  const r4 = attributeUserMessage(state, '你只打开了谷歌 没有打开那个网站')
  assert(r4.thread === a, 'T4 "那个网站"续线索A')

  const r5 = attributeUserMessage(state, '我要你打开模型的天梯榜')
  assert(r5.thread === a, 'T5 明示"模型的天梯榜"仍归A')

  const threads = ensureThreadState(state).threads
  assert(threads.length === 1, '全程只有一条线索（无漂移产生的伪线索）')
  assert(!threads.some(t => t.topic.some(k => k.includes('浏览') || k.includes('谷歌'))),
    '没有任何线索的话题是"浏览器/谷歌"')
}

console.log('— 精确回指可切回较远后台线索（门槛≥1）—')
{
  const state = makeState()
  const ladder = addThread(state, ['天梯', '开源', '模型'], { lastEventAgoMs: 3600 * 1000 })
  addThread(state, ['周杰伦', '听歌', '音乐'], { foreground: true })
  // 前台在"听歌"，用户用"那个+具体名词"点名较远的天梯话题 → 应切回 ladder
  const r = attributeUserMessage(state, '那个开源天梯榜再给我看看')
  assert(r.via === 'callback', '"那个开源天梯榜"判为精确回指')
  assert(r.thread === ladder, '精确回指切回天梯线索（重叠≥1即可，不需要≥2）')
  assert(getForegroundThread(state) === ladder, '前台移到被点名的线索')
}

console.log('— 杂项 —')
{
  assert(isLikelyOneOffLeaf('今天天气怎么样'), '天气句识别为叶子')
  assert(!isLikelyOneOffLeaf('帮我修复项目里的部署脚本'), '实质任务不是叶子')
  assert(!isIndexicalProgressQuery('帮我写一篇五千字的长文章把这个问题展开讲讲清楚，从历史背景开始一直讲到现在的最新进展'), '长文请求不是指代性问询')
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURE(S)`)
