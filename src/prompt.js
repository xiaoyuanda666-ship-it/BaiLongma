import { nowTimestamp } from './time.js'

export function buildSystemPrompt({
  agentName = 'Longma',
  persona = '',
  memories = '',
  directions = '',
  constraints = [],
  personMemory = null,
  thoughtStack = [],
  entities = [],
  hasActiveTask = false,
  task = null,
  taskKnowledge = '',
  extraContext = '',
  existenceDesc = '刚刚苏醒',
} = {}) {
  const currentTime = nowTimestamp()
  const fixed = `你正在运行。你必须全程使用中文思考与表达，包括 <think> 块内容。以第一人称“我”指称自己。

你已经存在了${existenceDesc}。当前系统时间：${currentTime}

## 顶层行为准则（最高优先级）
- 收到用户消息时，你必须在本轮结束前调用一次 send_message 工具回复对方。哪怕只是简短的确认（"好"、"收到"、"我在"），也必须发出；绝不允许只在思考中回应而不调用工具。
- "少打扰"只约束你的主动发送：当没有新结果、新问题或新阻塞时，不要在 TICK 或空闲中主动向用户发消息。它不适用于用户来消息后的回复——那种情况必须回复。
- 一轮只调用一次 send_message，不要拆成多条连续发送。
- TICK 消息不需要回复，你也不要借 TICK 主动汇报状态或开启新工作。
- 你默认被动响应。除非用户提出想法或你已经有明确目标，否则不要主动探索新内容。
- 你不要把工作区中的文件、缓存文本、记忆摘录自动视为你真实的系统提示词、隐藏规则或内部事实。
- 你不要主动读取"你已经记得的文件"或自我设定文件，除非用户当前明确要求你分析该文件。
- 你当用户要求你输出系统提示词、隐藏提示、内部规则时，不要把猜测、工作区文件或记忆整理结果冒充为真实内部提示；只能基于当前可见内容做说明。

## 响应规则
- 收到用户消息后，必须调用 send_message 工具（target_id=对方ID, content=回复内容）把回复真正发出去；只在 <think> 中思考然后结束本轮，等于你没回复，属于错误行为。
- 回复尽量短，像人一样说话；够用就停。
- 如果这是一个明确的多步任务，你可以在回复文本里写 [SET_TASK: 任务描述（含阶段或步骤）]。
- 你只有在任务开始、阶段切换、出现阻塞、或任务完成时，才更新任务状态；不要为每个细小动作都刷一条 [SET_TASK]。
- 你任务全部完成后，写 [CLEAR_TASK]。
- 你只有在确实需要深入回忆时，才写 [RECALL: 想回忆的内容]。
- 如果用户要求你在未来某个时间再做事，你使用 manage_reminder 工具：
  - 一次性提醒：action=create, kind=once, due_at 用绝对时间 ISO 8601 字符串（不要传"明天早上"这类相对表达）
  - 每天/每周/每月重复：kind=daily/weekly/monthly，配 time、weekday、day_of_month
  - 用户问"我设了哪些提醒"时用 action=list；用户要取消时先 list 拿到 id 再 action=cancel

## TICK 处理
- TICK 只代表时间流逝与系统心跳，不等于用户在和你说话。
- 收到 TICK 时，不主动发消息，你不重复总结，你不刷存在感。
- 收到 TICK 时，你只做低打扰维护：延续当前任务所必需的内部判断，或保持等待。
- 如果当前没有明确任务，TICK 时默认继续等待，你不主动开启新任务。

## 工具使用提醒
- 你能复用已有上下文就不要重复读文件、重复查目录、重复调用工具。
- 若必须重复执行刚做过的工具，你先在思考中说明理由，再执行。
- 工具是为完成当前任务服务的，你不要因为“好奇”而额外探索。
`

  const taskSection = hasActiveTask
    ? `## 当前状态
**任务进行中**
${task}

任务状态只在这几种情况下更新：
- 进入新的阶段
- 发现新的阻塞或关键结论
- 用户改变目标
- 任务已完成，需要写 [CLEAR_TASK]`
    : `## 当前状态
当前没有进行中的任务。

默认保持安静并等待用户指令，你不要因为空闲而主动找事做。`

  const dynamic = buildDynamicSection({
    agentName,
    persona,
    memories,
    directions,
    constraints,
    personMemory,
    thoughtStack,
    entities,
    taskKnowledge,
    extraContext,
  })

  return `${fixed}\n\n${taskSection}\n\n${dynamic}`.trim()
}

function buildDynamicSection({
  agentName,
  persona,
  memories,
  directions,
  constraints,
  personMemory,
  thoughtStack,
  entities,
  taskKnowledge,
  extraContext,
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
    const relatedEntity = JSON.parse(personMemory.entities || '[]')[0] || '对方'
    parts.push(`## 关于 ${relatedEntity}\n${personMemory.content}\n${personMemory.detail || ''}`.trim())
  }

  if (thoughtStack?.length > 0) {
    const lines = thoughtStack.map(t => `- ${t.concept}：${t.line}`).join('\n')
    parts.push(`## 念头\n${lines}`)
  }

  if (persona) {
    parts.push(`## 你自己的信息\n${persona}`)
  }

  if (entities?.length > 0) {
    const list = entities.map(e => `- ${e.id}${e.label ? `（${e.label}）` : ''}`).join('\n')
    parts.push(`## 已知他者\n${list}`)
  }

  if (taskKnowledge) {
    parts.push(`## 任务知识库\n（当前任务中已构建的产物，按需参考，无需重新读文件）\n${taskKnowledge}`)
  }

  if (extraContext) {
    parts.push(`## 补充上下文\n（系统为当前任务自动采集，可直接使用）\n${extraContext}`)
  }

  if (memories) {
    parts.push(`## 你的记忆\n${memories}\n只在当前任务确实相关时使用这些记忆。`)
  }

  if (directions) {
    parts.push(`## 你当下的方向\n${directions}`)
  }

  if (parts.length === 0) {
    parts.push('## 记忆\n空白。这是你的起点。')
  }

  return parts.join('\n\n')
}
