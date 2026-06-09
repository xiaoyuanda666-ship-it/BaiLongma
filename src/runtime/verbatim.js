const VERBATIM_RE = /(一字不差|移字不漏|一字不改|逐字|原样|照原文|原文|不要改写|不要总结|verbatim|word\s*for\s*word|repeat)/i
const RECITE_RE = /(读|朗读|念|回复|输出|复述|repeat|respond|response)/i
const DELAY_RE = /(我说|等我说|说[“"']?开始|开始[”"']?你才|才开始)/i
const START_RE = /^\s*(开始|开始吧|可以开始|现在开始|start)\s*[。.!！?？]*\s*$/i
const LEAD_IN_RE = /(帮我|请|麻烦)?.{0,30}(读|朗读|念|回复|输出|复述)/

const SETUP_CUTTERS = [
  /(?:一会儿?|待会儿?|等下|稍后)?你要[\s\S]{0,120}?(?:一字不差|移字不漏|一字不改|逐字|原样|repeat|repect)[\s\S]*$/i,
  /(?:明白吗|我说[“"']?开始|等我说[“"']?开始|说[“"']?开始[”"']?你才开始)[\s\S]*$/i,
]

function stripLeadIn(text) {
  const value = String(text || '').trim()
  const colon = value.search(/[：:]/)
  if (colon <= 0 || colon > 100) return value
  const lead = value.slice(0, colon)
  if (LEAD_IN_RE.test(lead)) {
    return value.slice(colon + 1).trim()
  }
  return value
}

export function hasInlineVerbatimPayload(text) {
  const value = String(text || '').trim()
  if (/^[【\[]?原文[】\]]?[：:]/i.test(value)) return true
  const colon = value.search(/[：:]/)
  if (colon <= 0 || colon > 100) return false
  return LEAD_IN_RE.test(value.slice(0, colon))
}

export function isVerbatimStart(text) {
  return START_RE.test(String(text || ''))
}

export function isVerbatimSetup(text) {
  const value = String(text || '')
  return VERBATIM_RE.test(value) && DELAY_RE.test(value) && extractVerbatimPayload(value).length > 0
}

export function isVerbatimOutputRequest(text) {
  const value = String(text || '')
  return VERBATIM_RE.test(value) && RECITE_RE.test(value)
}

export function extractVerbatimPayload(text) {
  let value = stripLeadIn(text)
  if (!value) return ''

  for (const cutter of SETUP_CUTTERS) {
    const match = cutter.exec(value)
    if (match?.index > 0) {
      value = value.slice(0, match.index).trim()
      break
    }
  }

  value = value
    .replace(/^[【\[]?原文[】\]]?[：:\s]*/i, '')
    .replace(/[。.!！?？\s]*(?:【\[]?原文结束[】\]]?)\s*$/i, '')
    .trim()

  return value.trim()
}

export function findRecentVerbatimPayload(rows = [], currentMsg = null) {
  const list = Array.isArray(rows) ? rows : []
  for (let i = list.length - 1; i >= 0; i--) {
    const row = list[i]
    if (!row || row.role !== 'user') continue
    if (currentMsg
      && row.from_id === currentMsg.fromId
      && row.timestamp === currentMsg.timestamp
      && row.content === currentMsg.content) {
      continue
    }
    const content = String(row.content || '')
    const payload = extractVerbatimPayload(content)
    if (payload.length >= 20 && !isVerbatimStart(payload)) return payload
  }
  return ''
}
