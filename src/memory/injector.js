import {
  searchMemories,
  getActiveConstraints,
  getTaskKnowledge,
  getPersonMemory,
  getMemoriesByEntity,
  getRecentConversation,
  getRecentConversationTimeline,
  getRecentActionLogs,
  getValidPrefetchCache,
  getUnconsumedUISignals,
  markUISignalsConsumed,
} from '../db.js'
import { getActiveUICards } from '../events.js'

function summarizeUISignals(signals = []) {
  if (!signals.length) return ''
  const now = Date.now()
  const lines = signals.map(s => {
    const age = Math.max(0, Math.round((now - s.ts) / 1000))
    let payload = {}
    try { payload = JSON.parse(s.payload || '{}') } catch {}
    const target = s.target ? `（${s.target}）` : ''
    let desc = s.type
    if (s.type === 'card.mounted')        desc = `卡片显示完成${target}`
    else if (s.type === 'card.dismissed') desc = `用户关闭了卡片${target}（${payload.by || '未知'}，停留 ${Math.round((payload.dwell_ms||0)/1000)}s）`
    else if (s.type === 'card.dwell')     desc = `卡片停留 ${Math.round((payload.dwell_ms||0)/1000)}s${target}`
    else if (s.type === 'card.action')    desc = `用户在卡片上操作 ${payload.action || ''}${target}`
    else if (s.type === 'card.error')     desc = `卡片错误：${payload.message || ''}${target}`
    return `- ${age}s 前：${desc}`
  })
  return `过去一分钟界面行为（这只是上下文，不要因此主动开口）：\n${lines.join('\n')}`
}

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
  } else if (message && /^TICK\s/i.test(message.trim())) {
    conversationWindow = getRecentConversationTimeline(20, 24)
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
    'send_message', 'web_search', 'fetch_url', 'browser_read', 'list_dir', 'read_file', 'write_file',
    'delete_file', 'make_dir', 'exec_command', 'kill_process', 'list_processes',
    'set_tick_interval', 'manage_reminder', 'manage_prefetch_task',
  ]
  const { listCapabilities } = await import('../providers/registry.js')
  const mmCaps = listCapabilities()
  if (mmCaps.includes('tts'))    baseTools.push('speak')
  if (mmCaps.includes('lyrics')) baseTools.push('generate_lyrics')
  if (mmCaps.includes('music'))  baseTools.push('generate_music')
  if (mmCaps.includes('image'))  baseTools.push('generate_image')
  if (senderId || state?.prev_recall) baseTools.push('search_memory')
  const tools = [...new Set(baseTools)]

  const actionLog = getRecentActionLogs(10)
  const prefetchedItems = getValidPrefetchCache()

  const uiSignals = getUnconsumedUISignals(60_000)
  const uiSignalSummary = summarizeUISignals(uiSignals)
  if (uiSignals.length) markUISignalsConsumed(uiSignals.map(s => s.id))

  const activeUICards = getActiveUICards()

  // Phase 1：ACUI 工具默认可用（组件少、token 成本低）；后续组件多了再上按需注入
  tools.push('ui_show', 'ui_update', 'ui_hide', 'ui_show_inline', 'ui_register')

  return {
    memories,
    recallMemories,
    conversationWindow,
    personMemory,
    directions,
    constraints,
    thought: null,
    taskKnowledge,
    tools: [...new Set(tools)],
    lastToolResult,
    actionLog,
    prefetchedItems,
    uiSignalSummary,
    activeUICards,
  }
}

// 从 memory.tags（JSON 字符串）中解出 body_path 标签
function extractBodyPath(memory) {
  try {
    const tags = JSON.parse(memory.tags || '[]')
    if (!Array.isArray(tags)) return null
    const tag = tags.find(t => typeof t === 'string' && t.startsWith('body_path:'))
    return tag ? tag.replace('body_path:', '') : null
  } catch {
    return null
  }
}

// 普通记忆：摘要行，带类型标签和 title（如有）。article 类型附正文路径提示。
// RECALL 记忆：带完整 detail
export function formatMemoriesForPrompt(memories, recallMemories = []) {
  const parts = []

  if (memories?.length > 0) {
    parts.push(memories.map(memory => {
      const typeLabel = memory.event_type ? `[${memory.event_type}] ` : ''
      const titlePart = memory.title ? `《${memory.title}》 ` : ''
      const bodyPath = extractBodyPath(memory)
      const bodyHint = bodyPath ? `\n  ↳ 正文：read_file("${bodyPath}")` : ''
      return `- [${memory.timestamp.slice(0, 10)}] ${typeLabel}${titlePart}${memory.content}${bodyHint}`
    }).join('\n'))
  }

  if (recallMemories?.length > 0) {
    parts.push('[回忆细节]\n' + recallMemories.map(memory => {
      const titlePart = memory.title ? `《${memory.title}》 ` : ''
      const bodyPath = extractBodyPath(memory)
      const bodyHint = bodyPath ? `\n  ↳ 正文：read_file("${bodyPath}")` : ''
      return `- [${memory.timestamp.slice(0, 10)}] ${titlePart}${memory.content}\n  ${memory.detail}${bodyHint}`
    }).join('\n'))
  }

  return parts.join('\n\n')
}

// 预热缓存：格式化注入文本
export function formatPrefetchedItems(prefetchedItems = []) {
  if (!prefetchedItems?.length) return ''
  const body = prefetchedItems.map(item => {
    const fetchedTime = item.fetched_at?.slice(11, 16) || ''
    return `【${item.source}】（${fetchedTime} 已查好）\n${item.content}`
  }).join('\n\n')
  return body + '\n\n以上数据已预查好，数据别出错，语言自己组织，不要每次都一个句式。'
}

// 当前屏幕上的存活 ACUI 卡片列表
export function formatActiveUICards(cards = []) {
  if (!cards?.length) return ''
  const lines = cards.map(c => `  - id="${c.id}"  组件=${c.component}`)
  return `【当前屏幕存活卡片】\n${lines.join('\n')}\n如需关闭请用 ui_hide 并传入对应 id；如需更新内容请用 ui_update。`
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
