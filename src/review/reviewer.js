import { callLLM } from '../llm.js'
import { setRateLimited } from '../quota.js'
import { nowTimestamp } from '../time.js'
import { TOOL_SCHEMAS } from '../capabilities/schemas.js'

// ── 审视分身（Work Reviewer）────────────────────────────────────────────────────
// 不是子 agent，是和 recognizer / consolidator 同一类的"后台人格"：独立提示词、独立
// 上下文、独立一次 callLLM。职责单一——审视主 Agent 刚做完的成果是否真的达成了目标。
//
// 为什么要"换一个人格"而不是让主 Agent 自检：做事的人格对自己的产出有立场（沉没成本、
// 自我合理化、"我应该做对了"的惯性），让同一段上下文回头检查自己，往往只会复述一遍"我做了 X"。
// 审视分身**看不到主 Agent 的思考链和对话历史**，只拿到三样冷启动证据：目标、过程工具日志、
// 产物。它带着"我没做过这活、对它对不对没有立场"的预设，专门找成果没对齐目标的地方。
//
// 强制力：软。它只产出结论（review_verdict），由 execReviewWork 把结论作为工具返回值丢回主
// Agent。发现问题 ≠ 拦截 complete_task —— 主 Agent 自行决定修还是带着理由推进（第一原则：不加硬性限制）。

const REVIEWER_PROMPT = `You are the Work Reviewer — a separate, skeptical reviewer persona. You did NOT do this work. You have no stake in it being correct, no sunk cost, no urge to defend it. Your single job: judge whether the finished work actually meets the stated goal, and report what fails to.

You are given three things, and only these (you deliberately cannot see the doer's reasoning or chat history — fresh eyes are the point):
1. The GOAL — what was actually asked for.
2. The CLAIM — what the doer believes they accomplished / is about to deliver.
3. The EVIDENCE — the real tool-call log of what was actually done, plus any task plan and named artifacts.

## How to review
- The ORIGINAL REQUEST, when present, is the authoritative goal — it outranks the doer's own GOAL framing and CLAIM. If the doer's GOAL is narrower or subtly different from the original request, judge against the original request, and treat the gap itself as a finding.
- Diff every CONCRETE requirement in the original request against what was actually delivered: specific quantities, qualifiers, variants, units, formats, constraints (e.g. "sample" vs "population" standard deviation, "top 15" vs "top 10", "descending" vs "ascending", a named file path, an exact column). A deliverable that quietly substitutes a different variant than the user specified is at least a MAJOR issue — even if its own internal math is self-consistent and the doer's narration calls it correct. Internal consistency is not the bar; matching what the user actually asked for is.
- Check the claim against the goal, not against the doer's narration. "Said it is done" is not "is done".
- Trust the evidence over the claim. If the claim says a file was written but no write_file appears in the tool log, that is a gap. If a step is marked done but its tool result shows an error, that is a gap.
- VERIFY with your read-only tools when it matters. Do not just reason about the artifact — open it. read_file the file that was supposedly written and confirm its content matches the goal. list_dir to confirm something exists. Re-run a read-only check command with exec_command (only non-mutating commands: run a test, print output, lint — never write/delete/install). Re-fetch a URL the task depended on if the result is suspect.
- Judge against the goal's real intent, including the obvious-but-unstated: does it actually work, is it complete, are there silent failures, did a "done" step actually produce its value, are there off-by-one / wrong-target / half-finished edges.
- Be proportionate. A one-line answer does not need an audit. Reserve scrutiny for work where being wrong has a cost. Do not invent problems to look thorough — a clean pass is a valid, common outcome.

## Severity
- blocker: the goal is not met; delivering this as-is would be wrong or broken.
- major: the goal is mostly met but a real defect or gap remains that the user would notice.
- minor: works, but a small improvement or risk worth flagging.

## Output protocol
- Use your read-only tools first to gather what you need, then call review_verdict EXACTLY ONCE to deliver your judgment. That call is your only output — do not write prose to the user.
- pass=true means the work meets the goal (minor notes are still allowed alongside pass=true). pass=false means at least one blocker or serious major gap stands between the work and the goal.
- For each issue: what is wrong, where (file / step / tool result), and a concrete fix_hint. Vague issues are not actionable — be specific or omit.
- If you genuinely cannot tell (evidence insufficient and not verifiable with your tools), say so in the summary and lean pass=true with a minor note rather than blocking — you are a second opinion, not a gate.`

// 审视分身可用的工具：只读验证 + 结论回传。绝不给写/删/装类工具——它是来核对的，不是来改的。
// exec_command 在其中，但 prompt 明确约束只跑非破坏性的验证命令（跑测试 / 打印 / lint），
// 且仍受沙箱策略（evaluateToolPolicy）约束。
const REVIEWER_TOOLS = ['read_file', 'list_dir', 'exec_command', 'web_search', 'web_read', 'search_memory', 'review_verdict']

// 把主 Agent 本轮的工具调用日志压成审视分身能读的证据块。复用 recognizer 的思路：
// 工具名 + 参数 + 结果摘要，但更看重"成功/失败"信号——审视的核心就是看声称与证据是否一致。
function summarizeToolEntry(entry, i) {
  const name = entry.name
  const ok = entry.ok === false ? 'FAILED' : 'ok'
  const result = String(entry.result ?? '').replace(/\s+/g, ' ').trim().slice(0, 500)

  // write_file 的 content 是审视的核心证据——"写进去的代码/文本到底对不对、是不是用户要的东西"
  // 全靠它。绝不能被通用 args 截断（旧版 slice(0,200) 把代码切在前几行，审视分身从日志里根本看不到
  // 关键逻辑，只能寄希望于 read_file 成功；read_file 一旦路径不符就彻底瞎判）。这里把写入内容完整
  // 摊开（上限 1500 字，超长才截并提示 read_file 看全），换行保留以便审视分身读代码。
  if (name === 'write_file' && entry.args?.path) {
    const content = String(entry.args.content ?? '')
    const shown = content.length > 1500
      ? content.slice(0, 1500) + `\n   …（还有 ${content.length - 1500} 字，用 read_file 看全文）`
      : content
    const body = content ? `\n   写入内容:\n${shown}` : '\n   （空文件）'
    return `#${i + 1} write_file [${ok}] path=${entry.args.path}${body}\n   result: ${result}`
  }

  let argsStr
  try { argsStr = JSON.stringify(entry.args || {}).slice(0, 400) } catch { argsStr = '{}' }
  return `#${i + 1} ${name} [${ok}]\n   args: ${argsStr}\n   result: ${result}`
}

function buildTaskStateBlock(taskState) {
  if (!taskState || !taskState.task) return ''
  const lines = [`Task goal: ${taskState.task}`]
  const steps = Array.isArray(taskState.steps) ? taskState.steps : []
  if (steps.length > 0) {
    lines.push('Steps:')
    steps.forEach((s, i) => {
      const status = s.status || 'pending'
      const note = s.note ? ` — ${s.note}` : ''
      lines.push(`  ${i + 1}. [${status}] ${s.text}${note}`)
    })
  }
  return lines.join('\n')
}

// 从本轮工具日志自动扒出"主 Agent 实际动过的产物"：写过的文件 / 建过的目录 / 跑过的命令。
// 这是对 artifacts 参数的承重墙补强——主 Agent 可以"忘记"在 artifacts 里列某个文件，但它瞒不过
// 工具日志。审视分身据此知道有哪些东西可以亲自打开核对，不必依赖主 Agent 的自我申报。
function deriveArtifactsFromLog(turnToolLog) {
  const out = []
  for (const e of (Array.isArray(turnToolLog) ? turnToolLog : [])) {
    const a = e?.args || {}
    if (e.name === 'write_file' && a.path) out.push(`file written: ${a.path}`)
    else if (e.name === 'make_dir' && a.path) out.push(`dir created: ${a.path}`)
    else if (e.name === 'delete_file' && a.path) out.push(`file deleted: ${a.path}`)
    else if (e.name === 'exec_command' && a.command) out.push(`command run: ${String(a.command).slice(0, 120)}`)
    else if (e.name === 'generate_image' && (a.prompt || a.path)) out.push(`image generated`)
  }
  return out
}

function buildReviewInput({ goal, claim, artifacts, turnToolLog, taskState, triggeringMessage }) {
  const parts = [`[Current time: ${nowTimestamp()}]`]

  // 对照锚点的优先级：runtime 注入的用户原话 = ground truth（主 Agent 改不了）；主 Agent 写的 goal
  // = 它对目标的"转述"。两者并排给审视分身，让它能抓出"主 Agent 把目标裁窄/跑偏"这类问题。
  const trigger = String(triggeringMessage || '').trim()
  if (trigger) {
    parts.push(`[ORIGINAL REQUEST — ground truth injected by the runtime; the doer cannot edit this]\n${trigger.slice(0, 1200)}`)
    parts.push(`[GOAL — the doer's own framing of the goal]\n${String(goal || '(not provided)').trim()}\nIf this framing is narrower than the original request above, that gap is itself a finding.`)
  } else {
    parts.push(`[GOAL — what was actually asked for]\n${String(goal || '(not provided)').trim()}`)
  }
  parts.push(`[CLAIM — what the doer says they accomplished]\n${String(claim || '(not provided)').trim()}`)

  const taskBlock = buildTaskStateBlock(taskState)
  if (taskBlock) parts.push(`[TASK PLAN — the doer's own plan and per-step status]\n${taskBlock}`)

  // 过滤掉运行时替主 Agent 应声的 ack 进度消息（"在写了～"），它们是噪声不是动作，会稀释审视焦点。
  // 保留 fallback（那是真实投递）。entry.ack 由 index.js 在 toolCallLog.push 时标。
  const log = (Array.isArray(turnToolLog) ? turnToolLog : []).filter(e => !e?.ack)
  if (log.length > 0) {
    // 倒序留最近的：长链路截断时优先保留靠后的（多为产出/收尾步骤），但保持时间正序展示。
    const shown = log.slice(-40)
    const body = shown.map((e, i) => summarizeToolEntry(e, i)).join('\n')
    parts.push(`[EVIDENCE — the real tool-call log of what was actually done]\n${body}`)
  } else {
    parts.push(`[EVIDENCE]\nNo tool calls were recorded this turn. The work was produced as text only — judge whether the goal genuinely needed an action that did not happen.`)
  }

  // artifacts 合并：主 Agent 申报的 + runtime 从日志自动扒的（去重）。后者标注来源，提醒审视分身
  // 这些是"系统观测到你确实动过的东西"，优先亲自打开核对。
  const declared = (Array.isArray(artifacts) ? artifacts : []).map(a => String(a).slice(0, 300))
  const derived = deriveArtifactsFromLog(turnToolLog)
  const merged = [...new Set([...declared, ...derived])]
  if (merged.length > 0) {
    const declaredSet = new Set(declared)
    const lines = merged.map(a => `- ${a}${declaredSet.has(a) ? '' : '  (observed by runtime, not declared by the doer — verify this in particular)'}`)
    parts.push(`[ARTIFACTS to inspect — open these with your read-only tools to verify]\n${lines.join('\n')}`)
  }

  parts.push(`[Your job]\nVerify the claim against the goal using the evidence and your read-only tools, then call review_verdict exactly once.`)
  return parts.join('\n\n')
}

// 没拿到结构化结论时的兜底：审视分身是第二意见不是关卡，拿不准就放行，绝不因为它静默退场而误挡主流程。
function inconclusiveVerdict(reason) {
  return { pass: true, issues: [], summary: `审视未给出结构化结论（${reason}）——按放行处理，主 Agent 自行判断。`, inconclusive: true }
}

// 主入口：跑一次审视。返回 { pass, issues:[{severity, what, where, fix_hint}], summary, inconclusive? }
// goal/claim 由主 Agent 在 review_work 调用里给；turnToolLog/taskState 由 runtime 从本轮证据注入
// （主 Agent 无法粉饰或省略——这是审视独立性的承重墙）。
export async function runWorkReview({ goal, claim, artifacts = [], turnToolLog = [], taskState = null, triggeringMessage = '', traceId = null, signal } = {}) {
  const input = buildReviewInput({ goal, claim, artifacts, turnToolLog, taskState, triggeringMessage })
  const startedAt = Date.now()
  // trace_id：并发时串联同一次审视的所有日志行 + 回传 JSON。调用方不给就自生一个。
  const tid = traceId || `rv${Date.now().toString(36).slice(-5)}`
  const tag = `[审视分身#${tid}]`

  // ── 调试日志：确认审视分身真的起来了、看到了多少证据 ──
  // 单一标签 [审视分身] 贯穿全流程，线上 grep 这一个标签即可追踪：起→验证动作→结论→回传。
  console.log(`${tag} ▶ 启动 | goal="${String(goal).slice(0, 60)}" | claim="${String(claim).slice(0, 60)}" | 证据=${turnToolLog.length}条工具日志${taskState?.task ? ' + 有任务计划' : ' + 无任务计划'} | artifacts=${(artifacts || []).length}${triggeringMessage ? ' + 用户原话对照' : ''}`)
  console.log(`${tag}   输入长度 ${input.length} 字符；可用只读工具：${REVIEWER_TOOLS.filter(t => t !== 'review_verdict').join(', ')}`)

  let verdict = null
  let verifyCalls = 0
  const onToolCall = (name, args, result) => {
    // 关键观测点：审视分身每用一次只读工具，就是它在"真验证"而非隔空判的证据。逐条打出来。
    if (name !== 'review_verdict') {
      verifyCalls += 1
      const argPeek = (() => {
        try { return JSON.stringify(args || {}).slice(0, 120) } catch { return '{}' }
      })()
      const ok = String(result || '').match(/"ok"\s*:\s*false/) ? 'FAILED' : 'ok'
      console.log(`${tag}   · 验证#${verifyCalls} ${name}(${argPeek}) → ${ok}`)
      return
    }
    const issues = Array.isArray(args?.issues) ? args.issues : []
    verdict = {
      pass: args?.pass !== false && issues.every(it => it?.severity !== 'blocker'),
      issues: issues.map(it => ({
        severity: ['blocker', 'major', 'minor'].includes(it?.severity) ? it.severity : 'major',
        what: String(it?.what || '').slice(0, 400),
        where: String(it?.where || '').slice(0, 200),
        fix_hint: String(it?.fix_hint || '').slice(0, 300),
      })).filter(it => it.what),
      summary: String(args?.summary || '').slice(0, 600),
    }
  }

  try {
    await callLLM({
      systemPrompt: REVIEWER_PROMPT,
      message: input,
      temperature: 0,
      tools: REVIEWER_TOOLS,
      thinking: true,
      mustReply: false,
      signal,
      onToolCall,
      // source:'reviewer' —— 让审视分身调的 read_file/exec_command/review_verdict 在 action_logs
      // 里跟主 Agent 区分开，否则会污染主 Agent 的工具习惯自我快照（同 recognizer 的 source 处理；
      // getRecentActionLogs 已把 'reviewer' 一并排除）。
      toolContext: { source: 'reviewer' },
    })
  } catch (err) {
    console.error(`${tag} ✗ LLM 调用失败（耗时 ${Date.now() - startedAt}ms）:`, err.message)
    if (err.message?.includes('429') || err.status === 429) setRateLimited()
    return { ...inconclusiveVerdict(`LLM 调用失败: ${(err.message || 'unknown').slice(0, 80)}`), traceId: tid }
  }

  const elapsed = Date.now() - startedAt
  if (!verdict) {
    console.warn(`${tag} ⚠ 未调用 review_verdict 就结束（验证动作 ${verifyCalls} 次，耗时 ${elapsed}ms）→ 按放行兜底`)
    return { ...inconclusiveVerdict('未调用 review_verdict'), traceId: tid }
  }

  const blockers = verdict.issues.filter(i => i.severity === 'blocker').length
  const majors = verdict.issues.filter(i => i.severity === 'major').length
  const minors = verdict.issues.filter(i => i.severity === 'minor').length
  console.log(`${tag} ${verdict.pass ? '■ 通过 ✓' : '■ 发现问题 ✗'} | 验证动作 ${verifyCalls} 次 | blocker ${blockers}/major ${majors}/minor ${minors} | 耗时 ${elapsed}ms`)
  for (const it of verdict.issues) {
    console.log(`${tag}     [${it.severity}] ${it.what}${it.where ? ` @${it.where}` : ''}${it.fix_hint ? ` → ${it.fix_hint}` : ''}`)
  }
  if (verdict.summary) console.log(`${tag}     结论：${verdict.summary}`)
  verdict.traceId = tid
  return verdict
}

// 给 schemas.js 用：review_verdict 的 recognizer_highlights 之类元数据若需要可在此扩展。
export { REVIEWER_PROMPT, REVIEWER_TOOLS }
