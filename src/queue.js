import { nowTimestamp } from './time.js'
import { normalizeConversationPartyId, upsertEntity, insertConversation } from './db.js'

// 内存消息队列
const queue = []

// 消息到达时的打断回调（由 index.js 注册）
let interruptCallback = null
export function setInterruptCallback(fn) { interruptCallback = fn }

export function pushMessage(fromId, content, channel = 'TUI') {
  const normalizedFromId = normalizeConversationPartyId(fromId)
  const timestamp = nowTimestamp()
  upsertEntity(normalizedFromId)
  // 消息一到就写入聊天记录（微信式：打开即可见所有未处理消息）。
  // 若随后 LLM 处理被新消息打断，本条仍然保留在 conversations 表中，
  // 下一轮处理最新消息时通过 conversationWindow 自动作为上下文可见。
  insertConversation({ role: 'user', from_id: normalizedFromId, content, timestamp })
  queue.push({
    raw: `[${normalizedFromId}] ${timestamp} [${channel}] ${content}`,
    fromId: normalizedFromId,
    content,
    timestamp,
    channel,
  })
  // 通知主循环打断当前处理
  interruptCallback?.()
}

export function popMessage() {
  return queue.shift() || null
}

// 把消息重新放回队列头部（LLM 失败后重试用），保留原始字段并带上 retryCount
export function requeueMessage(msg, retryCount) {
  queue.unshift({ ...msg, retryCount })
}

export function hasMessages() {
  return queue.length > 0
}
