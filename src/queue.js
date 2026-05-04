import { nowTimestamp } from './time.js'
import { normalizeConversationPartyId, upsertEntity, insertConversation } from './db.js'

// 分级内存消息队列：用户消息永远优先于后台消息（提醒、系统消息等）
const queues = {
  user: [],
  background: [],
}

const PRIORITY = {
  user: 100,
  background: 50,
}

// 消息到达时的打断回调（由 index.js 注册）
let interruptCallback = null
export function setInterruptCallback(fn) { interruptCallback = fn }

function resolvePriority(fromId, channel, meta = {}) {
  if (typeof meta.priority === 'number') return meta.priority
  if (meta.queue === 'background') return PRIORITY.background
  if (channel === 'REMINDER' || channel === 'SYSTEM' || normalizeConversationPartyId(fromId) === 'SYSTEM') {
    return PRIORITY.background
  }
  return PRIORITY.user
}

function resolveQueueName(priority, meta = {}) {
  if (meta.queue === 'background') return 'background'
  return priority >= PRIORITY.user ? 'user' : 'background'
}

function pruneSupersededUserMessages(entry) {
  if (!entry || entry.queueName !== 'user') return

  for (let i = queues.user.length - 1; i >= 0; i--) {
    const pending = queues.user[i]
    if (!pending) continue
    if (pending.fromId !== entry.fromId) continue
    queues.user.splice(i, 1)
  }
}

export function pushMessage(fromId, content, channel = 'TUI', meta = {}) {
  const normalizedFromId = normalizeConversationPartyId(fromId)
  const timestamp = nowTimestamp()
  const priority = resolvePriority(normalizedFromId, channel, meta)
  const queueName = resolveQueueName(priority, meta)
  upsertEntity(normalizedFromId)
  // 消息一到就写入聊天记录（微信式：打开即可见所有未处理消息）。
  // 若随后 LLM 处理被新消息打断，本条仍然保留在 conversations 表中，
  // 下一轮处理最新消息时通过 conversationWindow 自动作为上下文可见。
  insertConversation({ role: 'user', from_id: normalizedFromId, content, timestamp, channel: channel || '' })
  const entry = {
    raw: `[${normalizedFromId}] ${timestamp} [${channel}] ${content}`,
    fromId: normalizedFromId,
    content,
    timestamp,
    channel,
    priority,
    queueName,
    ...meta,
  }
  pruneSupersededUserMessages(entry)
  queues[queueName].push(entry)
  // 通知主循环打断当前处理
  interruptCallback?.(entry)
}

export function popMessage() {
  return queues.user.shift() || queues.background.shift() || null
}

// 把消息重新放回队列头部（LLM 失败后重试用），保留原始字段并带上 retryCount
export function requeueMessage(msg, retryCount) {
  const queueName = msg?.queueName === 'background' ? 'background' : 'user'
  queues[queueName].unshift({ ...msg, retryCount, queueName })
}

export function hasMessages() {
  return queues.user.length > 0 || queues.background.length > 0
}

export function hasUserMessages() {
  return queues.user.length > 0
}

export function getQueueSnapshot() {
  return {
    user: queues.user.length,
    background: queues.background.length,
  }
}
