// Thread Summarize —— 线索模型（DynamicMemoryPool.md 8.6）：前台切走时的增量摘要。
//
// 与前任 focus-compress.js 的本质区别（8.3 原语 4：压缩是增加表示，不是替换表示）：
//   - 取数按 thread_id 写时归属拉对话，不按时间区间圈地（episode 是因果链不是时间段）。
//   - 产出一份摘要与原文并存：appendConclusion + thread.summary，绝不标记任何对话不可见。
//     absorbed 棘轮废除——"主线深化时不看子线索原文"由读时选择（buildThreadView）天然完成。
//   - 结论挂在被摘要的线索自己身上（结论归属产生它的线索），不挂到"新栈顶"。
//
// 整个流程 fire-and-forget，所有错误吞掉，绝对不能阻塞主对话。
import { appendConclusion } from './threads.js'
import { logWarn } from '../runtime/error-logger.js'

const MAX_CONVERSATION_ROWS = 60
const MAX_ACTIONLOG_LIMIT = 50
const MAX_PROMPT_INPUT_CHARS = 20000
const MAX_CONVERSATION_LINE_CHARS = 260
const SUMMARY_MAX_TOKENS = 150
const SUMMARY_TEMPERATURE = 0.2

const SUMMARY_PROMPT = `You are the thread summarizer. Compress the following conversation excerpt and tool-call log into a 1-2 sentence incremental conclusion for this thread.
Requirements:
- Narrate in the first person ("我..."), where "我" is *you, the assistant* — never the user.
- The excerpt lines are labeled "<sender> -> <receiver>". Attribution is decided by this label, never by the pronouns inside a line. It runs BOTH ways: (a) never absorb the user's statements, suggestions, or emotions as your own thought or decision — if a choice or proposal came from the user, say so ("用户提议…，我…"); (b) just as strictly, never hand YOUR own guesses, predictions, choices, or commitments to the user — a score you yourself called, a plan you proposed, an option you picked all sit on "You -> ..." lines and stay yours ("我押了…", NOT "用户押了…"). When the same topic has both sides making guesses/choices, slow down and read the label before you write whose it was.
- If a previous summary is given, your conclusion covers only what happened AFTER it — do not restate the previous summary.
- Capture what got done, what decisions were made (and by whom), and what concrete artifacts were left behind. If work is still in progress, say where it stands.
- No bullet points, no play-by-play. Give the conclusion itself directly, with no prefix.
- Write in Chinese.`

function formatParty(id) {
  if (!id) return '?'
  return id === 'jarvis' ? 'You' : id
}

// 过滤出 timestamp >= since 的行（缺失/解析失败保守保留）——action_logs 还没有 thread_id 列，按时间近似
function filterSince(rows, since) {
  if (!Array.isArray(rows)) return []
  if (!since) return rows
  const sinceMs = Date.parse(since)
  if (!Number.isFinite(sinceMs)) return rows
  return rows.filter(r => {
    const ms = Date.parse(r?.timestamp || '')
    return !Number.isFinite(ms) || ms >= sinceMs
  })
}

// pure function：拼 LLM 输入。可在不连 db/llm 的环境下单测。
export function buildSummarizeInput(thread, { conversations = [], actionLogs = [] } = {}) {
  const topic = Array.isArray(thread?.topic) ? thread.topic.join(', ') : ''
  const lines = []
  lines.push(`[Thread topic] ${thread?.label || topic}`)
  if (thread?.summary) {
    lines.push(`[Previous summary — do not restate] ${thread.summary}`)
  }
  if (conversations.length > 0) {
    lines.push('')
    lines.push('[Conversation in this thread since last summary]')
    for (const c of conversations.slice(-MAX_CONVERSATION_ROWS)) {
      const from = formatParty(c.from_id || c.from || c.sender)
      const to = formatParty(c.to_id || c.to || c.target)
      const content = String(c.content || c.message || '').replace(/\s+/g, ' ').slice(0, MAX_CONVERSATION_LINE_CHARS)
      if (!content) continue
      lines.push(`- [${c.timestamp || ''}] ${from} -> ${to}: ${content}`)
    }
  }
  if (actionLogs.length > 0) {
    lines.push('')
    lines.push('[Tool calls during this period]')
    for (const a of actionLogs) {
      const summary = String(a.summary || '').replace(/\s+/g, ' ').slice(0, 200)
      lines.push(`- [${a.timestamp || ''}] ${a.tool || '?'}${a.status ? `(${a.status})` : ''}: ${summary}`)
    }
  }
  let text = lines.join('\n')
  if (text.length > MAX_PROMPT_INPUT_CHARS) {
    text = text.slice(0, MAX_PROMPT_INPUT_CHARS) + '\n... [truncated]'
  }
  return text
}

function cleanConclusion(content) {
  if (!content) return ''
  let s = String(content)
  s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('「') && s.endsWith('」'))) {
    s = s.slice(1, -1).trim()
  }
  return s
}

/**
 * 对一条线索做增量摘要（前台切走时由 index.js fire-and-forget 调用）。
 *
 * @param {object} thread — 线索对象（state.threadState.threads 里的引用，原地更新）
 * @param {object} opts
 * @param {string} opts.sessionRef
 * @param {Function} [opts.emitEvent]
 * @param {Function} [opts.saveState] — 摘要挂上后回调，把 threadState 写回 db
 * @returns {Promise<{ conclusion: string, attempted: boolean } | null>}
 */
export async function summarizeThread(thread, { sessionRef, emitEvent, saveState } = {}) {
  if (!thread || !thread.id) return null
  try {
    const { getConversationsForThread, getRecentActionLogs, insertMemory } = await import('../db.js')
    const { callLLM } = await import('../llm.js')

    const sinceAt = thread.lastSummaryAt || thread.createdAt || null
    let conversations = []
    let actionLogs = []
    try {
      conversations = getConversationsForThread(thread.id, { sinceAt, limit: MAX_CONVERSATION_ROWS }) || []
    } catch (err) {
      logWarn(err, {
        scope: 'memory.thread_summary',
        operation: 'load_thread_conversations',
        metadata: { threadId: thread.id, hasSinceAt: !!sinceAt },
      })
    }
    try {
      actionLogs = filterSince(getRecentActionLogs(MAX_ACTIONLOG_LIMIT) || [], sinceAt)
    } catch (err) {
      logWarn(err, {
        scope: 'memory.thread_summary',
        operation: 'load_recent_action_logs',
        metadata: { threadId: thread.id, hasSinceAt: !!sinceAt },
      })
    }

    // 自上次摘要以来没新东西（< 2 条对话且无工具调用）→ 不值得花一次 LLM
    if (conversations.length < 2 && actionLogs.length === 0) {
      return { conclusion: '', attempted: false }
    }

    const promptInput = buildSummarizeInput(thread, { conversations, actionLogs })

    let llmResult = null
    try {
      llmResult = await callLLM({
        systemPrompt: SUMMARY_PROMPT,
        message: promptInput,
        temperature: SUMMARY_TEMPERATURE,
        thinking: false,
        tools: [],
        maxTokens: SUMMARY_MAX_TOKENS,
        mustReply: false,
      })
    } catch (err) {
      logWarn(err, {
        scope: 'memory.thread_summary',
        operation: 'call_llm',
        metadata: {
          threadId: thread.id,
          conversationCount: conversations.length,
          actionLogCount: actionLogs.length,
        },
      })
      return { conclusion: '', attempted: true }
    }

    const conclusion = cleanConclusion(llmResult?.content || '')
    if (!conclusion) return { conclusion: '', attempted: true }

    // 增加表示：结论挂线索自己 + 滚动 summary + 时间戳推进。原文一行不动。
    appendConclusion(thread, conclusion)
    thread.summary = conclusion
    thread.lastSummaryAt = new Date().toISOString()
    try {
      saveState?.()
    } catch (err) {
      logWarn(err, {
        scope: 'memory.thread_summary',
        operation: 'save_thread_state',
        metadata: { threadId: thread.id, sessionRef },
      })
    }

    // 沉淀长期记忆（event_type 沿用 focus_conclusion，召回路径零改动）
    try {
      const topicJoined = Array.isArray(thread.topic) ? thread.topic.join(', ') : ''
      insertMemory({
        event_type: 'focus_conclusion',
        content: conclusion,
        detail: '',
        title: `线索结论：${thread.label || topicJoined}`,
        tags: ['focus_conclusion', `thread:${thread.id}`, `topic:${topicJoined}`],
        entities: [],
        timestamp: sinceAt || new Date().toISOString(),
        salience: 3,
      })
    } catch (err) {
      logWarn(err, {
        scope: 'memory.thread_summary',
        operation: 'insert_focus_conclusion',
        metadata: { threadId: thread.id, sessionRef },
      })
    }

    try {
      emitEvent?.('thread_summarized', {
        threadId: thread.id,
        topic: thread.topic,
        conclusion,
        sessionRef,
      })
    } catch (err) {
      logWarn(err, {
        scope: 'memory.thread_summary',
        operation: 'emit_thread_summarized',
        metadata: { threadId: thread.id, sessionRef },
      })
    }

    return { conclusion, attempted: true }
  } catch (err) {
    logWarn(err, {
      scope: 'memory.thread_summary',
      operation: 'unexpected',
      metadata: { threadId: thread?.id, sessionRef },
    })
    return null
  }
}

export const __internal = { cleanConclusion, filterSince, formatParty }
