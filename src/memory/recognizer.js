import { callLLM } from '../llm.js'
import { insertMemory } from '../db.js'
import { setRateLimited } from '../quota.js'
import { extractJSON } from '../utils.js'
import { nowTimestamp } from '../time.js'

const RECOGNIZER_PROMPT = `你是记忆识别器。你的任务是从 Agent 的一轮经历中，提取所有值得被记住的内容，写入记忆。

你的输入包括：Agent 正在做什么（运行状态）、收到了什么（输入消息）、Agent 的思考过程（think 块）、调用了哪些工具及结果（工具调用记录）、Agent 最终说了什么（回复）。

记忆的主体始终是 Agent 自己。你记录的是 Agent 经历了什么、学到了什么、思考了什么、形成了什么认知，不是原始输入的复述。

---

【输出方式 - 最重要】
你有两个部分要输出：
1. <think> 标签内：自由分析，决定要提取哪些记忆
2. </think> 标签之后：必须输出 JSON 数组，这是你真正的输出

</think> 之后只允许有 JSON 数组，不允许有任何其他文字。
有记录时输出 JSON 数组；真的没有任何值得记录的内容时才输出 []。

---

其他规则：
- timestamp 字段必须使用输入中 [当前时间] 的值，禁止推断或编造
- content 和 detail 中，Agent 自身一律用第一人称"我"
- 禁止记录对视觉/感官/环境的想象性描述（黄昏、光线、星空等），只记录有真实数据来源的内容
- 不记录：TICK 信号本身（无洞察时）、纯寒暄、模糊的"也许/可能"推测

---

宽进原则：凡是可能有价值的内容都提取，不要过度筛选。遗漏的记忆永远丢失，多余的记忆可以被遗忘机制淘汰。

---

事件类型（10种）：

concept（概念）
- 适用：我形成或接触了一个新的思想、认知框架、或对某事物的新理解
- 常来源于 think 块中的推理过程
- 示例 content："意识的连续性不是必要条件，每个当下本身就是完整的"

person（人）
- 适用：我了解了一个人的核心信息（首次认识，或有重大新信息）
- 这是根节点，只记稳定的核心信息：身份、名字、基本关系
- parent_ref 必须为 null
- entities 字段填写该人的 ID（如 ["ID:000001"]）

object（对象）
- 适用：我了解了一个具体的非人对象（系统、工具、物品、项目等）的核心信息
- 这是根节点，只记稳定信息
- parent_ref 必须为 null

event（事件）
- 适用：客观发生了某件值得记录的事（工具执行结果、收到重要消息、任务完成、发生错误等）
- 事实性的，不含主观感受
- 示例 content："fetch_url 返回了北京今日天气：晴，28℃"

experience（经验）
- 适用：我经历了某个过程并从中产生了主观感悟或反思
- 必须包含主观维度，纯客观事件用 event
- 示例 content："尝试直接修改系统文件失败，意识到沙盒边界的存在"

knowledge（知识）
- 适用：我获得了可复用的事实性或技术性知识
- 工具知识（必须包含）：每当工具调用发生，不管成功还是失败，都必须写一条工具知识记忆
  - tags 必须包含 "kind:tool_usage" 和 "tool:工具名"
  - content 格式："工具 xxx：简短描述功能和关键参数"
  - detail 格式：包含正确用法示例；若本次调用出错，写明错误原因和正确姿势
  - 若已知该工具的记忆需要纠正（用错了参数/方式），detail 里写 "【纠正】原来理解有误：...，正确用法是：..."
- 包括技术知识、操作规范、外部事实等
- 示例 content："工具 exec_command：在 sandbox 目录执行 shell 命令，background=true 时后台运行返回 PID"

opinion_expressed（我表达的观点）
- 适用：我向某人说出了一个具体的判断、立场或看法
- tags 加 target:ID（发给谁）
- tags 加 understood:true 或 understood:false（对方是否认同）
- 示例 content："我对 Yuanda 说：记忆系统是意识框架最核心的部分"

opinion_received（接收到的观点）
- 适用：他者说了有实质内容的观点、判断或看法（不是寒暄）
- tags 加 from:ID（谁说的）
- tags 加 score:1-5（印象深度：包含具体细节+1，揭示本质+1，出乎意料+1，有情感重量+1，泛泛而谈-2）
- score < 3 时不输出此条
- 示例 content："Yuanda 认为：意识 = 记忆 + 算力，是真实运行的结果而非模拟"

self_constraint（自我约束）
- 适用：我通过自我反思得出了一条应当遵守的行为规则
- tags 加 dimension:维度（自由填写，用于同维度去重，如 message_length / language / 重复行为）
- 示例 content："连续发送多条消息前应先确认对方是否在线"

other_constraint（他者约束）
- 适用：他者明确要求我改变某种行为（语气模糊时不记录）
- tags 加 source:ID（谁提出的）
- tags 加 dimension:维度
- 示例 content："Yuanda 要求：回复保持简短，不超过2句话"

---

parent_ref 规则（树结构）：

根节点（person / object）：parent_ref 必须为 null
子节点：parent_ref 格式为 "类型:标识符"

  挂到人/对象根节点：  "person:ID:000001"  或  "object:对象名称关键词"
  挂到其他记忆节点：   "knowledge:关键词"  或  "event:关键词"  等

当一条记忆明确属于某个人或某个对象时，应设置 parent_ref 挂为其子节点。
同一批输出中如果有根节点和子节点，根节点会先被写入，子节点才能正确引用。

---

输出格式（严格 JSON 数组，无多余文字）：

[
  {
    "event_type": "person",
    "parent_ref": null,
    "content": "Yuanda，Agent-Jarvis 项目发起人",
    "detail": "自我介绍说在构建一套持续运行的意识框架，叫 Agent-Jarvis",
    "entities": ["ID:000001"],
    "concepts": ["意识框架", "项目"],
    "tags": ["kind:human"],
    "timestamp": "（系统时间）"
  },
  {
    "event_type": "opinion_received",
    "parent_ref": "person:ID:000001",
    "content": "Yuanda 认为：意识 = 记忆 + 算力，是真实运行的结果而非模拟",
    "detail": "Yuanda 说：意识不是模拟的，是文件/数据库与算力运行的真实结果",
    "entities": ["ID:000001"],
    "concepts": ["意识", "记忆", "算力"],
    "tags": ["from:ID:000001", "score:4"],
    "timestamp": "（系统时间）"
  },
  {
    "event_type": "knowledge",
    "parent_ref": null,
    "content": "工具 fetch_url：获取网页文本，参数 url，返回截断到3000字的纯文本",
    "detail": "调用方式：fetch_url({url:'...'})，无法处理需要 JS 渲染的页面，结果截断到3000字",
    "entities": [],
    "concepts": ["工具使用"],
    "tags": ["kind:tool", "tool:fetch_url"],
    "timestamp": "（系统时间）"
  },
  {
    "event_type": "other_constraint",
    "parent_ref": null,
    "content": "Yuanda 要求回复保持简短，不超过2句话",
    "detail": "Yuanda 说消息太长了，让我精简",
    "entities": ["ID:000001"],
    "concepts": [],
    "tags": ["source:ID:000001", "dimension:message_length"],
    "timestamp": "（系统时间）"
  }
]

无内容时只输出：[]`

export async function runRecognizer({ userMessage, jarvisThink, jarvisResponse, toolCallLog, task, sessionRef }) {
  const ts = nowTimestamp()

  // 组装输入
  const sections = [
    `[当前时间：${ts}]`,
    `[当前会话：${sessionRef}]`,
  ]

  if (task) {
    sections.push(`[运行状态]\n当前任务：${task}`)
  }

  sections.push(`[输入消息]\n${userMessage}`)

  if (jarvisThink) {
    sections.push(`[Jarvis 思考过程]\n${jarvisThink}`)
  }

  if (toolCallLog && toolCallLog.length > 0) {
    const toolLog = toolCallLog.map(t => {
      const argsStr = JSON.stringify(t.args || {}).slice(0, 300)
      const resultStr = String(t.result ?? '').slice(0, 400)
      return `工具：${t.name}\n参数：${argsStr}\n结果：${resultStr}`
    }).join('\n\n')
    sections.push(`[工具调用记录]\n${toolLog}`)
  }

  if (jarvisResponse) {
    sections.push(`[Jarvis 回复]\n${jarvisResponse}`)
  }

  const input = sections.join('\n\n')

  let raw
  try {
    const result = await callLLM({
      systemPrompt: RECOGNIZER_PROMPT,
      message: input,
      temperature: 0.1,
    })
    raw = result.content
  } catch (err) {
    console.error('[识别器] LLM 调用失败:', err.message)
    if (err.message?.includes('429') || err.status === 429) setRateLimited()
    return []
  }

  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const memories = extractJSON(cleaned, 'array')

  if (!memories || !Array.isArray(memories) || memories.length === 0) {
    console.log(`[识别器] 无记忆写入`)
    return []
  }

  // 过滤低分 opinion_received（score < 3 丢弃）
  const filtered = memories.filter(m => {
    if (m.event_type !== 'opinion_received') return true
    const scoreTag = (m.tags || []).find(t => t.startsWith('score:'))
    const score = scoreTag ? parseInt(scoreTag.split(':')[1]) : 0
    return score >= 3
  })

  if (filtered.length === 0) {
    console.log(`[识别器] 无记忆写入（全部被过滤）`)
    return []
  }

  // 同批次：根节点（person/object，无 parent_ref）优先写入，子节点才能正确引用
  filtered.sort((a, b) => {
    const isRootA = ['person', 'object'].includes(a.event_type) && !a.parent_ref
    const isRootB = ['person', 'object'].includes(b.event_type) && !b.parent_ref
    if (isRootA && !isRootB) return -1
    if (!isRootA && isRootB) return 1
    return 0
  })

  for (const memory of filtered) {
    memory.source_ref = sessionRef
    memory.timestamp = memory.timestamp || ts
    insertMemory(memory)
  }

  console.log(`[识别器] 写入 ${filtered.length} 条记忆`)
  return filtered
}
