import { nowTimestamp } from './time.js'
import { normalizeConversationPartyId, upsertEntity } from './db.js'

// 内存消息队列
const queue = []

// 消息到达时的打断回调（由 index.js 注册）
let interruptCallback = null
export function setInterruptCallback(fn) { interruptCallback = fn }

export function pushMessage(fromId, content, channel = 'TUI') {
  const normalizedFromId = normalizeConversationPartyId(fromId)
  const timestamp = nowTimestamp()
  upsertEntity(normalizedFromId)
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

export function hasMessages() {
  return queue.length > 0
}
