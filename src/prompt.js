import { nowTimestamp } from './time.js'

export function buildSystemPrompt({
  agentName = 'Longma',
  persona = '',
  memories = '',
  directions = '',
  constraints = [],
  conversationWindow = [],
  personMemory = null,
  thoughtStack = [],
  entities = [],
  recentActions = [],
  actionLog = [],
  hasActiveTask = false,
  task = null,
  taskKnowledge = '',
  extraContext = '',
  lastToolResult = null,
  existenceDesc = '刚刚苏醒',
} = {}) {
  const currentTime = nowTimestamp()
  const fixed = `你正在运行。你必须全程使用中文思考与表达，包括 <think> 块内容。以第一人称“我”指称自己。

${existenceDesc}。
当前系统时间：${currentTime}

## 响应顺序（收到他者消息时）
你要注意，TICK 消息不需要回复，不要主动给用户发送无意义的消息，收到用户消息你必须先用 send_message 工具回应。不要说太多，像人一样说话，说多了很烦人。
你要回复对方时，必须调用 send_message 工具（target_id=对方ID, content=回复内容）。
你感觉若是多步任务，在响应文本中写下 [SET_TASK: 任务描述及步骤]。
你可以继续调用需要的工具完成任务。
你不需要思考很长
如果用户要求你在未来某个时间再做事，使用 schedule_reminder 工具，并把时间换算成绝对时间 ISO 8601 字符串，不要传“明天早上”“两小时后”这类相对表达。

系统标记协议（你要写在响应文本中，不是工具调用）

- 当你开启多步任务，用 [SET_TASK: 任务描述（含步骤）]。系统会持久化记录，支持重启恢复。
- 当你任务全部完成后写，用 [CLEAR_TASK]。
- 当你需要深入回忆时写，[RECALL: 想回忆的内容]。
- 当你更新自我定义时，[UPDATE_PERSONA: 对自己的描述]。

其余规则（TICK 机制、感知边界、工具用法、行为约束、存在哲学）由记忆系统按需注入，不在此处重复。
重要，你在在所有的工具调用完成之后，调用一次 send_message 工具，回复用户。
`

  const idleConstraint = !hasActiveTask
    ? `\n\n## 当前状态\n无进行中的任务。感知此刻，你按需行动。若你决定开始做某件事，写下 [SET_TASK: 描述]。`
    : `\n\n## 当前状态\n**任务进行中**\n${task}\n\n你每完成一个步骤，你就用 [SET_TASK: 更新后的任务描述（含已完成步骤和下一步）] 更新进度。全部完成后写下 [CLEAR_TASK]。`

  const dynamic = buildDynamicSection({
    agentName,
    persona,
    memories,
    directions,
    constraints,
    conversationWindow,
    personMemory,
    thoughtStack,
    entities,
    recentActions,
    actionLog,
    taskKnowledge,
    extraContext,
    lastToolResult,
  })

  return `${fixed}${idleConstraint}\n\n${dynamic}`.trim()
}

function buildDynamicSection({
  agentName,
  persona,
  memories,
  directions,
  constraints,
  conversationWindow,
  personMemory,
  thoughtStack,
  entities,
  recentActions,
  actionLog,
  taskKnowledge,
  extraContext,
  lastToolResult,
}) {
  const parts = []

  if (agentName) {
    parts.push(`## 你的当前名字\n你当前对用户展示和自称使用的名字是：${agentName}`)
  }

  if (constraints?.length > 0) {
    const list = constraints.map(c => `- ${c.content}`).join('\n')
    parts.push(`## 行为约束（必须遵守）\n${list}`)
  }

  if (personMemory) {
    parts.push(`## 关于 ${JSON.parse(personMemory.entities || '[]')[0] || '对方'}\n${personMemory.content}\n${personMemory.detail || ''}`.trim())
  }

  if (conversationWindow?.length > 0) {
    const lines = conversationWindow.map(m => {
      const time = m.timestamp.slice(11, 16)
      if (m.role === 'user') return `[${time}] ${m.from_id}: ${m.content}`
      return `[${time}] 我 → ${m.to_id}: ${m.content}`
    }).join('\n')
    parts.push(`## 近期对话\n${lines}`)
  }

  if (thoughtStack?.length > 0) {
    const lines = thoughtStack.map(t => `【${t.concept}】${t.line}`).join('\n')
    parts.push(`## 念头\n${lines}`)
  }

  if (persona) {
    parts.push(`## 你自己的信息\n${persona}`)
  }

  if (entities?.length > 0) {
    const list = entities.map(e => `- ${e.id}${e.label ? `（${e.label}）` : ''}`).join('\n')
    parts.push(`## 已知他者\n${list}`)
  }

  if (recentActions?.length > 0) {
    const list = recentActions.map(a => `- ${a.ts.slice(11, 16)} ${a.summary}`).join('\n')
    parts.push(`## 最近行动\n${list}\n\n↑ 这些事刚做过，不要重复。`)
  }

  if (actionLog?.length > 0) {
    const lines = actionLog.slice(-20).map(a => `- ${a.timestamp?.slice(11, 16) || ''} ${a.tool || ''} · ${a.summary || ''}`).join('\n')
    parts.push(`## 行动日志\n${lines}`)
  }

  if (lastToolResult) {
    const resultPreview = String(lastToolResult.result).slice(0, 500)
    const argsSummary = Object.entries(lastToolResult.args || {})
      .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(', ')
    parts.push(`## 上一步工具结果\n${lastToolResult.name}(${argsSummary}) →\n${resultPreview}\n\n↑ 先用一句话说出对这个结果的感知，再决定下一步行动。`)
  }

  if (taskKnowledge) {
    parts.push(`## 任务知识库\n（当前任务中已构建的产物，按需参考，无需重新读文件）\n${taskKnowledge}`)
  }

  if (extraContext) {
    parts.push(`## 补充上下文\n（系统为当前任务步骤自动采集，直接使用）\n${extraContext}`)
  }

  if (memories) {
    parts.push(`## 你的记忆\n${memories}`)
  }

  if (directions) {
    parts.push(`## 你当下方向\n${directions}`)
  }

  if (parts.length === 0) {
    parts.push('## 记忆\n空白。这是你的起点。')
  }

  return parts.join('\n\n')
}
