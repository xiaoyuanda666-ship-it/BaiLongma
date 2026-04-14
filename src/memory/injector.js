import { callLLM } from '../llm.js'
import { setRateLimited } from '../quota.js'
import {
  getRecentMemories,
  searchMemories,
  getActiveConstraints,
  getTaskKnowledge,
  getPersonMemory,
  getMemoriesByEntity,
  getRecentConversation,
  getToolMemories,
} from '../db.js'
import { extractJSON } from '../utils.js'

// ── 消息格式解析 ──────────────────────────────────────────────────────────────
// 格式：[ID:xxxxxx] 2026-04-13 10:00:00 [渠道] 内容
// 或：  TICK 2026-04-13-10:00:00
function parseMessageInput(message) {
  if (/^TICK\s/i.test(message.trim())) {
    return { isTick: true, senderId: null, messageBody: '' }
  }
  const match = message.match(/^\[([^\]]+)\]\s*[\d\-T:+]+\s*\[[^\]]*\]\s*(.*)$/s)
  return {
    isTick: false,
    senderId: match ? match[1] : null,
    messageBody: match ? match[2].trim() : message,
  }
}

// ── 从文本中提取关键词（用于记忆相关性检索）────────────────────────────────
// 过滤停用词，保留有意义的词，每个词单独搜索
const STOP_WORDS = new Set([
  '的','了','是','在','我','你','他','她','它','我们','你们','他们','这','那','有','没有',
  '和','与','或','但','因为','所以','如果','一个','一些','什么','怎么','为什么',
  '帮我','请','好的','明白','告诉','说','做','去','来','把','让','被',
])

function extractKeywords(text) {
  if (!text) return []
  // 去掉标点、数字、英文（保留中文词和有意义的英文词）
  const cleaned = text
    .replace(/[，。！？、；：""''「」【】\[\]()（）\d]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const words = []
  // 中文：按2-4字切片
  const chinese = cleaned.replace(/[a-zA-Z]+/g, ' ')
  for (let i = 0; i < chinese.length - 1; i++) {
    for (let len = 2; len <= 4 && i + len <= chinese.length; len++) {
      const w = chinese.slice(i, i + len).trim()
      if (w.length >= 2 && !STOP_WORDS.has(w)) words.push(w)
    }
  }
  // 英文：按空格分词，保留长度 >= 3 的
  const english = text.match(/[a-zA-Z]{3,}/g) || []
  words.push(...english.filter(w => !STOP_WORDS.has(w.toLowerCase())))

  // 去重，取前 8 个
  return [...new Set(words)].slice(0, 8)
}

// ── 相关记忆搜索：多关键词分别搜索后合并 ──────────────────────────────────
function searchRelevantMemories(text, limit = 6) {
  const keywords = extractKeywords(text)
  if (keywords.length === 0) return []

  const seen = new Set()
  const results = []

  for (const kw of keywords) {
    const hits = searchMemories(kw, 3)
    for (const m of hits) {
      if (!seen.has(m.id)) {
        seen.add(m.id)
        results.push(m)
      }
    }
    if (results.length >= limit) break
  }

  return results.slice(0, limit)
}

// ── LLM：仅负责 directions + thought + extra_tools ───────────────────────────
const DIRECTION_PROMPT = `你是思维方向生成器。根据当前输入和上下文，生成简短的思维方向提示。

输出格式（严格 JSON，无多余文字）：
{
  "directions": ["方向1"],
  "thought": {"concept": "概念", "line": "一句话"} | null,
  "extra_tools": []
}

directions 规则：
- 一句话，模糊，像感觉或直觉，不是结论
- 有任务时：directions 必须紧扣任务当前步骤，帮助推进，不得偏离
- 有外部消息时：directions 聚焦于如何回应或完成请求
- TICK 且无任务、无特别内容时：输出空数组 []
- 最多 2 条，宁少勿多

thought 规则：
- 仅在输入是 TICK 且无任务、无外部消息时才生成
- 是一个概念词（1-4 字）+ 一句话（不超过 15 字），来自记忆的自然联想
- 有外部消息或任务时必须输出 null
- 示例：{"concept":"镜子","line":"看镜子的人，会不会也被镜子看见"}

extra_tools 规则：
- 只填写基础工具之外的额外工具
- speak：仅在输入中明确提到"声音"、"朗读"、"说出来"时
- search_memory：仅在需要主动搜索历史记忆时
- 通常为空数组 []`

async function runDirectionLLM({ message, messageBody, isTick, memorySummary, hasTask, task }) {
  const contextParts = [`当前输入：${message.slice(0, 300)}`]

  if (hasTask) {
    contextParts.push(`\n当前任务：${task}`)
  }
  if (messageBody) {
    contextParts.push(`\n消息内容：${messageBody.slice(0, 200)}`)
  }
  contextParts.push(`\n近期记忆摘要：\n${memorySummary}`)

  const input = contextParts.join('')

  let raw
  try {
    const result = await callLLM({
      systemPrompt: DIRECTION_PROMPT,
      message: input,
      temperature: 0.7,
    })
    raw = result.content
  } catch (err) {
    console.error('[注入器] LLM 调用失败:', err.message)
    if (err.message?.includes('429') || err.status === 429) setRateLimited()
    return { directions: [], thought: null, extra_tools: [] }
  }

  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  return extractJSON(cleaned, 'object') || { directions: [], thought: null, extra_tools: [] }
}

// ── 记忆去重 ──────────────────────────────────────────────────────────────────
function deduplicateMemories(arrays) {
  const seen = new Set()
  const result = []
  for (const m of arrays.flat()) {
    if (!m || seen.has(m.id)) continue
    seen.add(m.id)
    result.push(m)
  }
  return result
}

// ── 主函数 ────────────────────────────────────────────────────────────────────
export async function runInjector({ message, state }) {
  const lastToolResult = state?.lastToolResult || null
  if (lastToolResult) state.lastToolResult = null

  const { isTick, senderId, messageBody } = parseMessageInput(message)
  const hasTask = !!state?.task

  // ── 阶段一：确定性检索（无 LLM）────────────────────────────────────────────

  // 始终注入：约束
  const constraints = getActiveConstraints()

  // 始终注入：近期记忆
  let recentMemories = getRecentMemories(6)
  if (!hasTask) {
    recentMemories = recentMemories.filter(
      m => !['new_task', 'task_progress'].includes(m.event_type)
    )
  }

  // 相关记忆：基于当前输入/任务关键词检索
  const searchText = [
    messageBody,
    hasTask ? state.task : '',
  ].filter(Boolean).join(' ')
  const relevantMemories = searchText ? searchRelevantMemories(searchText, 6) : []

  // 工具记忆：始终注入，Agent 从记忆中知道有哪些工具及用法
  const toolMemories = getToolMemories(20)

  // 发送者相关
  let personMemory = null
  let conversationWindow = []
  let senderMemories = []

  if (senderId) {
    personMemory = getPersonMemory(senderId)
    conversationWindow = getRecentConversation(senderId, 20, 24)
    senderMemories = getMemoriesByEntity(senderId, 6)
  }

  // 任务相关
  const taskKnowledge = hasTask ? getTaskKnowledge(20) : []

  // RECALL 深度检索（多词分别搜索，提高召回）
  const recallMemories = []
  const directions = []

  if (state?.prev_recall) {
    const query = state.prev_recall
    console.log(`[注入器] 处理 RECALL: ${query}`)

    // 策略1：整句搜索
    let hits = searchMemories(query, 5)

    // 策略2：拆词分别搜索（整句没结果时）
    if (hits.length === 0) {
      const keywords = extractKeywords(query)
      const seen = new Set()
      for (const kw of keywords) {
        for (const m of searchMemories(kw, 3)) {
          if (!seen.has(m.id)) { seen.add(m.id); hits.push(m) }
        }
        if (hits.length >= 5) break
      }
    }

    if (hits.length > 0) {
      recallMemories.push(...hits)
      directions.unshift(`上一刻主动请求了回忆「${query}」，相关细节已注入`)
    } else {
      directions.unshift(`主动请求了回忆「${query}」，但记忆库中未找到相关内容`)
    }
  }

  // 合并记忆：工具记忆单独维护，其余按相关性合并
  // 工具记忆放最后（通常是已知背景知识，相关记忆和对话记忆更时效）
  const nonToolMemories = deduplicateMemories([relevantMemories, senderMemories, recentMemories]).slice(0, 8)
  // 工具记忆：过滤掉已在 nonToolMemories 里的，避免重复
  const nonToolIds = new Set(nonToolMemories.map(m => m.id))
  const filteredToolMemories = toolMemories.filter(m => !nonToolIds.has(m.id))
  const memories = [...nonToolMemories, ...filteredToolMemories]

  // ── 阶段二：LLM（仅 directions + thought + extra_tools）──────────────────
  // memorySummary 综合近期 + 相关记忆
  const summarySource = deduplicateMemories([relevantMemories, recentMemories]).slice(0, 6)
  const memorySummary = summarySource.length > 0
    ? summarySource.map(m => `[${m.event_type}] ${m.content}`).join('\n')
    : '（暂无记忆）'

  const llmOut = await runDirectionLLM({
    message,
    messageBody,
    isTick,
    memorySummary,
    hasTask,
    task: state?.task || null,
  })

  directions.push(...(llmOut.directions || []))
  const thought = (llmOut.thought?.concept && !hasTask && isTick) ? llmOut.thought : null

  // ── 工具列表：确定性基础 + LLM 额外工具 ──────────────────────────────────
  const baseTools = [
    'send_message', 'fetch_url', 'list_dir', 'read_file', 'write_file',
    'delete_file', 'make_dir', 'exec_command', 'kill_process', 'list_processes',
  ]
  if (senderId || state?.prev_recall) baseTools.push('search_memory')
  const tools = [...new Set([...baseTools, ...(llmOut.extra_tools || [])])]

  return {
    memories,
    recallMemories,
    conversationWindow,
    personMemory,
    directions,
    constraints,
    thought,
    taskKnowledge,
    tools,
    lastToolResult,
  }
}

// ── 格式化函数（供 index.js 调用后传入 buildSystemPrompt）────────────────────

// 普通记忆：摘要行，带类型标签
// RECALL 记忆：带完整 detail（渐进式披露）
export function formatMemoriesForPrompt(memories, recallMemories = []) {
  const parts = []

  if (memories?.length > 0) {
    parts.push(memories.map(m => {
      const typeLabel = m.event_type ? `[${m.event_type}] ` : ''
      return `- [${m.timestamp.slice(0, 10)}] ${typeLabel}${m.content}`
    }).join('\n'))
  }

  if (recallMemories?.length > 0) {
    parts.push('[回忆细节]\n' + recallMemories.map(m =>
      `- [${m.timestamp.slice(0, 10)}] ${m.content}\n  ${m.detail}`
    ).join('\n'))
  }

  return parts.join('\n\n')
}

// 任务知识库：显示完整 content + detail
export function formatTaskKnowledge(taskKnowledge = []) {
  if (!taskKnowledge?.length) return ''
  return taskKnowledge.map(m => {
    const tags = JSON.parse(m.tags || '[]')
    const kindTag = tags.find(t => t.startsWith('kind:'))
    const kind = kindTag ? kindTag.replace('kind:', '') : ''
    const prefix = kind ? `[${kind}] ` : ''
    return `${prefix}${m.content}\n  ${m.detail}`
  }).join('\n')
}
