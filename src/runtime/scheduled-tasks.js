import { normalizeConversationPartyId } from '../db/utils.js'

function parseToolResult(result) {
  try {
    return JSON.parse(String(result || '{}'))
  } catch {
    return null
  }
}

export function hasVerifiedScheduledDelivery(toolCallLog = [], targetId = '') {
  const expectedTarget = normalizeConversationPartyId(targetId)
  if (!expectedTarget) return false

  return (Array.isArray(toolCallLog) ? toolCallLog : []).some(call => {
    if (call?.name !== 'send_message' || call.ok === false || call.ack === true) return false

    const result = parseToolResult(call.result)
    if (!result || result.ok === false || result.delivered !== true) return false

    const deliveredTarget = normalizeConversationPartyId(
      result.target_id || call?.args?.target_id || '',
    )
    return deliveredTarget === expectedTarget
  })
}
