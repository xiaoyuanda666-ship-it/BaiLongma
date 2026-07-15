// Coding Discipline —— 编程工作法内化层（2026-06-10）
//
// 蒸馏自 github.com/mattpocock/skills（MIT，"Make them your own"）的三个工程 skill：
//   - tdd       → 垂直切片：一个行为→实现→验证→下一个，禁止横切（全写完才第一次跑）
//   - prototype → 原型规矩：一条命令能跑、状态摊在屏幕上、跳过打磨
//   - diagnose  → 排障纪律：反馈回路优先、多假设可证伪、一次只改一个变量
//
// 「内化」的定义（与读取 skill 的本质区别）：不靠模型自己想起来去读文件，
// 而是 runtime 检测到编程/排障场景时把方法段主动注入 system prompt——
// 系统递给 agent，不是 agent 发起。机制与 COMPLEX_TASK_BLOCK 等 gated 段同族。
//
// 触发三信号源（任一命中即注入）：
//   1. 本轮用户消息文本命中场景词
//   2. 当前 task 文本命中（线索模型红利：TICK 自主干活轮也能触发，哪怕用户一字未发）
//   3. 最近动作模式：recentActions 里出现 write_file + exec_command 组合 = 它正在写代码
//
// 实测依据（2026-06-10 霍曼/自由返回对照实验）：该模型的工程行为是上下文的函数——
// 交付探针上线前后行为序列完全不同。本段注入的同样是「行为序列纪律」，属同一可改变类别。
// 边界：内化提升工程纪律（动作顺序/验证习惯/排障方法），不提升基础模型写代码的智商。

export const CODING_BLOCK = `## Coding Discipline
You are writing or modifying code. Work in vertical slices, not horizontal ones:
1. **Skeleton first — run it immediately.** Write the smallest thing that can run (one entry file with stub content), start it, and verify it actually loads (exec_command to run it, web_read to see the page). Only then add features. Never write the whole project across several files and run it for the first time at the end — by then every bug is buried under four files at once.
2. **One slice = one verification.** After each meaningful addition, run/fetch again. One tool call buys you certainty about exactly which change broke what.
3. **Make state visible.** Demos and prototypes should render their internal state on screen (current phase, key values, sim time) so problems show themselves instead of hiding in silence.
4. **One command to run.** A single entry (node server.js or one HTML file). No build steps unless the user asked for them.
5. **web_read is your eyes — the stateful browser is the user's.** Before opening anything for the user or reporting done: read the page yourself, confirm the entry resources load, read the server's stderr. An unverified deliverable is a guess, not a result. Runtime probes URLs you open and writes the real HTTP status into the tool result — read it and act on it.
6. **Edit files with read_file + write_file — never with shell text replacement.** PowerShell Get-Content/-replace/Set-Content reads UTF-8 as GBK and silently destroys every multibyte character (Chinese, symbols) in the file; sed/python -c one-liners hit quote-escaping traps. For any edit, however small: read_file → modify in your head → write_file the whole file. If you need scripted processing, write the script to a file with write_file and run it with node.`

export const DIAGNOSE_BLOCK = `## Debugging Discipline
Something is broken. Before touching any code:
1. **Build a feedback loop first.** Construct a repeatable pass/fail check that reproduces the symptom — web_read asserting on the response, exec_command running the entry and reading its output, re-running the exact failing command. A reliable loop is 90% of the fix: every later step just consumes its signal.
2. **Reproduce before you hypothesize.** Run the loop and watch it fail the way the user described. If you cannot reproduce it, say so and ask for the missing artifact (exact error text, what the screen shows) — do not guess-fix.
3. **List 3 ranked, falsifiable hypotheses.** Each must make a prediction: "if X is the cause, changing Y makes the symptom disappear". A hypothesis without a prediction is a vibe — sharpen it or drop it. Never grab the first plausible idea and start editing.
4. **Change one variable at a time**, testing against the loop, starting from the top hypothesis.
5. **The fix is proven only when the loop flips to pass** — the original symptom, not a nearby one. Then tell the user the cause in one line.`

// ── 触发器（纯函数，可单测） ────────────────────────────────────────────────

// 写代码场景：动词+产物组合为主，少量强独立词。刻意避开「写文章/做计划/看动画」类误触。
const CODING_TEXT_RE = new RegExp(
  [
    // 中文动宾组合——动词和产物名词之间允许 ≤16 字修饰语（"做一个地月自由返回轨道的3D可视化"），
    // 但不许跨句读（排除句读符号，防止"写一下笔记。顺便查查页面"这种跨句误连）
    '(写|做|搞|弄|建|搭|搭建|重建|改|实现|开发|重构|优化)\\s*(个|一个|一下|下)?[^，。,.!?；;：:\\n]{0,16}(代码|脚本|程序|网页|页面|网站|项目|工具|插件|游戏|demo|原型|app|应用|动画|可视化|模拟|仿真|服务|接口|爬虫|机器人)',
    // 强独立词（出现即编程语境）
    '编程|代码|前端|后端|html|css|javascript|typescript|python脚本|three\\.js|api接口|webgl|3d\\s*(可视化|动画|模型|场景)',
    // 点名英文目录/文件 = 文件级工作（"把 free-return 目录清掉重做"——2.1.377 首轮漏报的教训）
    '[a-z][\\w.-]{2,}\\s*(目录|文件夹)',
    '\\.(js|html|css|py|ts|json|mjs)\\b',
    // 英文（同样允许形容词间隔："build a landing page"）
    'build (a|an|the|some)?[\\w -]{0,20}(app|page|site|tool|script|demo|prototype|server|game)',
    '(write|implement|refactor|code up) ',
  ].join('|'),
  'i'
)

// 排障场景：症状词。误触代价低（多 ~300 token 的无害纪律段），阈值放宽。
const DIAGNOSE_TEXT_RE = /报错|出错|错误|坏了|崩了|崩溃|打不开|不工作|不能用|用不了|没反应|不显示|白屏|黑屏|加载不出|404|500|修一下|修复|修好|排查|诊断|debug|broken|not working|error|bug\b|fix (this|it|the)/i

// 最近动作模式：它正在写代码（write_file + 执行/起服务 同窗出现）
function recentActionsLookLikeCoding(recentActionsText) {
  const t = String(recentActionsText || '')
  if (!t) return false
  return /write_file\(/.test(t) && /(exec_command\(|node |npm )/.test(t)
}

/**
 * @param {object} signals
 * @param {string} signals.userMessage       — 本轮用户消息正文
 * @param {string} signals.taskText          — 当前 active task 描述（state.task）
 * @param {string} signals.recentActionsText — 最近动作摘要拼接（state.recentActions summary）
 */
export function shouldInjectCoding({ userMessage = '', taskText = '', recentActionsText = '' } = {}) {
  if (CODING_TEXT_RE.test(String(userMessage))) return true
  if (CODING_TEXT_RE.test(String(taskText))) return true
  return recentActionsLookLikeCoding(recentActionsText)
}

export function shouldInjectDiagnose({ userMessage = '', taskText = '' } = {}) {
  if (DIAGNOSE_TEXT_RE.test(String(userMessage))) return true
  // task 文本命中症状词（例如「修复 XX 页面打不开」的任务在 TICK 轮继续时）
  return DIAGNOSE_TEXT_RE.test(String(taskText))
}

export const __internal = { CODING_TEXT_RE, DIAGNOSE_TEXT_RE, recentActionsLookLikeCoding }
