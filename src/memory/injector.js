import {
  searchMemories,
  getActiveConstraints,
  getTaskKnowledge,
  getPersonMemory,
  getMemoriesByEntity,
  getRecentConversation,
  getRecentActionLogs,
} from '../db.js'

// 消息格式解析
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

// 从文本中提取关键词（用于记忆相关性检索）
// 过滤停用词，保留有意义的词，每个词单独搜索
const STOP_WORDS = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '我们', '你们', '他们', '这', '那', '有', '没有',
  '和', '与', '把', '被', '因为', '所以', '如果', '一个', '一些', '什么', '怎么', '为什么',
  '帮我', '请', '好的', '明白', '告诉', '让', '做', '去', '来', '把', '说', '给',
])

function extractKeywords(text, maxKeywords = 8) {
  if (!text) return []

  const cleaned = text
    .replace(/[，。！？、；：“”"'‘’【】[\]()（）\d]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const freq = new Map()
  const bump = (word) => {
    if (!word || word.length < 2 || STOP_WORDS.has(word)) return
    freq.set(word, (freq.get(word) || 0) + 1)
  }

  const chinese = cleaned.replace(/[a-zA-Z]+/g, ' ')
  for (let i = 0; i < chinese.length - 1; i++) {
    for (let len = 2; len <= 4 && i + len <= chinese.length; len++) {
      bump(chinese.slice(i, i + len).trim())
    }
  }

  const english = text.match(/[a-zA-Z]{3,}/g) || []
  for (const word of english) {
    const normalized = word.toLowerCase()
    if (!STOP_WORDS.has(normalized)) bump(word)
  }

  return [...freq.entries()]
    .sort((a, b) => (b[0].length - a[0].length) || (b[1] - a[1]))
    .slice(0, maxKeywords)
    .map(([word]) => word)
}

// 相关记忆搜索：多个关键词分别搜索后合并
function searchRelevantMemories(text, limit = 20, maxKeywords = 8, perKeyword = 3) {
  const keywords = extractKeywords(text, maxKeywords)
  if (keywords.length === 0) return []

  const seen = new Set()
  const results = []

  for (const keyword of keywords) {
    const hits = searchMemories(keyword, perKeyword)
    for (const memory of hits) {
      if (!seen.has(memory.id)) {
        seen.add(memory.id)
        results.push(memory)
      }
    }
    if (results.length >= limit) break
  }

  return results.slice(0, limit)
}

function deduplicateMemories(arrays) {
  const seen = new Set()
  const result = []
  for (const memory of arrays.flat()) {
    if (!memory || seen.has(memory.id)) continue
    seen.add(memory.id)
    result.push(memory)
  }
  return result
}

// hint：一层思考器的输出文本，用于扩展 L2 的记忆检索范围
export async function runInjector({ message, state, hint = '' }) {
  const lastToolResult = state?.lastToolResult || null
  if (lastToolResult) state.lastToolResult = null

  const { senderId, messageBody } = parseMessageInput(message)
  const hasTask = !!state?.task

  const constraints = getActiveConstraints()

  let personMemory = null
  let conversationWindow = []
  let senderMemories = []

  if (senderId) {
    personMemory = getPersonMemory(senderId)
    conversationWindow = getRecentConversation(senderId, 20, 24)
    senderMemories = getMemoriesByEntity(senderId, 10)
  }

  const hintText = hint ? hint.replace(/<think>[\s\S]*?<\/think>/gi, '').slice(0, 400) : ''
  const conversationText = conversationWindow
    .map(item => item.content || '')
    .filter(Boolean)
    .join(' ')
    .slice(0, 4000)

  const searchText = [
    messageBody,
    hasTask ? state.task : '',
    hintText,
    conversationText,
  ].filter(Boolean).join(' ')

  const hasHistory = !!conversationText
  const memoryLimit = hasHistory ? 25 : (hint ? 12 : 8)
  const keywordLimit = hasHistory ? 24 : 10
  const relevantMemories = searchText
    ? searchRelevantMemories(searchText, memoryLimit, keywordLimit, 3)
    : []

  const taskKnowledge = hasTask ? getTaskKnowledge(20) : []
  const recallMemories = []
  const directions = []

  if (state?.prev_recall) {
    const query = state.prev_recall
    console.log(`[注入器] 处理 RECALL: ${query}`)

    let hits = searchMemories(query, 5)

    if (hits.length === 0) {
      const keywords = extractKeywords(query)
      const seen = new Set()
      for (const keyword of keywords) {
        for (const memory of searchMemories(keyword, 3)) {
          if (!seen.has(memory.id)) {
            seen.add(memory.id)
            hits.push(memory)
          }
        }
        if (hits.length >= 5) break
      }
    }

    if (hits.length > 0) {
      recallMemories.push(...hits)
      directions.push(`上一刻主动请求了回忆“${query}”，相关细节已注入。`)
    } else {
      directions.push(`主动请求了回忆“${query}”，但记忆库中未找到相关内容。`)
    }
  }

  const mergeCap = hasHistory ? 30 : 12
  const memories = deduplicateMemories([relevantMemories, senderMemories]).slice(0, mergeCap)

  const baseTools = [
    'send_message', 'fetch_url', 'list_dir', 'read_file', 'write_file',
    'delete_file', 'make_dir', 'exec_command', 'kill_process', 'list_processes',
    'set_tick_interval',
  ]
  if (senderId || state?.prev_recall) baseTools.push('search_memory')
  const tools = [...new Set(baseTools)]

  const actionLog = getRecentActionLogs(50)

  return {
    memories,
    recallMemories,
    conversationWindow,
    personMemory,
    directions,
    constraints,
    thought: null,
    taskKnowledge,
    tools,
    lastToolResult,
    actionLog,
  }
}

// 普通记忆：摘要行，带类型标签和 title（如有）
// RECALL 记忆：带完整 detail
export function formatMemoriesForPrompt(memories, recallMemories = []) {
  const parts = []

  if (memories?.length > 0) {
    parts.push(memories.map(memory => {
      const typeLabel = memory.event_type ? `[${memory.event_type}] ` : ''
      const titlePart = memory.title ? `《${memory.title}》 ` : ''
      return `- [${memory.timestamp.slice(0, 10)}] ${typeLabel}${titlePart}${memory.content}`
    }).join('\n'))
  }

  if (recallMemories?.length > 0) {
    parts.push('[回忆细节]\n' + recallMemories.map(memory => {
      const titlePart = memory.title ? `《${memory.title}》 ` : ''
      return `- [${memory.timestamp.slice(0, 10)}] ${titlePart}${memory.content}\n  ${memory.detail}`
    }).join('\n'))
  }

  return parts.join('\n\n')
}

// 任务知识库：显示完整 content + detail
export function formatTaskKnowledge(taskKnowledge = []) {
  if (!taskKnowledge?.length) return ''
  return taskKnowledge.map(memory => {
    const tags = JSON.parse(memory.tags || '[]')
    const kindTag = tags.find(tag => tag.startsWith('kind:'))
    const kind = kindTag ? kindTag.replace('kind:', '') : ''
    const prefix = kind ? `[${kind}] ` : ''
    return `${prefix}${memory.content}\n  ${memory.detail}`
  }).join('\n')
}
