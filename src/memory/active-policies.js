import { searchMemories } from '../db.js'
import { extractKeywords } from './keywords.js'

const MAX_SEARCH_TERMS = 28
const MAX_HITS_PER_TERM = 6
const DEFAULT_LIMIT = 5

const POLICY_KIND_TAGS = new Set([
  'kind:procedure',
  'kind:constraint',
  'kind:failure_lesson',
  'kind:policy',
])

const POLICY_EVENT_TYPES = new Set([
  'self_constraint',
])

const POLICY_MEM_ID_RE = /^(procedure|constraint|policy|lesson|rule)_/i
const POLICY_CUE_RE = /(?:must|never|always|avoid|do not|don't|procedure|workflow|checklist|lesson|failure|correct way|next time|remember|constraint|hard rule|verify|validate|\u5fc5\u987b|\u4e0d\u8981|\u4e0d\u53ef|\u4e0d\u80fd|\u907f\u514d|\u6b63\u786e\u505a\u6cd5|\u89c4\u7a0b|\u6d41\u7a0b|\u65b9\u6cd5|\u4e0b\u6b21|\u4ee5\u540e|\u8bb0\u4f4f|\u6559\u8bad|\u5931\u8d25|\u9519\u8bef|\u9a8c\u8bc1|\u68c0\u67e5)/i
const ENGLISH_STOP_TERMS = new Set([
  'a', 'an', 'and', 'are', 'as', 'be', 'but', 'by', 'do', 'for', 'from', 'if',
  'in', 'is', 'it', 'of', 'on', 'or', 'please', 'then', 'the', 'them', 'this',
  'to', 'use', 'used', 'with', 'you',
])

const INTENT_LEXICON = [
  {
    id: 'desktop_control',
    triggers: [
      /screenshot|screen\s*(shot|capture)|capture|fullscreen|full-screen|window|desktop|f11/i,
      /\u622a\u56fe|\u622a\u5c4f|\u5c4f\u5e55|\u5168\u5c4f|\u7a97\u53e3|\u6700\u5927\u5316|\u5206\u8fa8\u7387|\u7f29\u653e/i,
    ],
    terms: [
      'desktop_control', 'screenshot', 'screen', 'capture', 'fullscreen', 'full-screen',
      'window', 'desktop', 'dpi', 'scaling', 'resolution', 'physical pixels', 'f11',
      '\u622a\u56fe', '\u622a\u5c4f', '\u5c4f\u5e55', '\u5168\u5c4f', '\u7a97\u53e3',
      '\u5206\u8fa8\u7387', '\u7f29\u653e',
    ],
  },
  {
    id: 'file_work',
    triggers: [
      /file|code|edit|patch|read|write|save|repo|project/i,
      /\u6587\u4ef6|\u4ee3\u7801|\u4fee\u6539|\u7f16\u8f91|\u4fdd\u5b58|\u8bfb\u53d6|\u5199\u5165|\u9879\u76ee/i,
    ],
    terms: [
      'file_work', 'file', 'code', 'edit', 'patch', 'read_file', 'write_file',
      'apply_patch', 'repo', 'project', '\u6587\u4ef6', '\u4ee3\u7801',
      '\u4fee\u6539', '\u7f16\u8f91', '\u4fdd\u5b58',
    ],
  },
  {
    id: 'web_research',
    triggers: [
      /search|web|url|source|citation|latest|news|browse|fetch/i,
      /\u641c\u7d22|\u7f51\u9875|\u94fe\u63a5|\u6765\u6e90|\u5f15\u7528|\u6700\u65b0|\u65b0\u95fb|\u67e5\u4e00\u4e0b/i,
    ],
    terms: [
      'web_research', 'search', 'web', 'url', 'source', 'citation', 'latest',
      'news', 'browse', 'web_read', 'fetch_url', '\u641c\u7d22', '\u7f51\u9875',
      '\u94fe\u63a5', '\u6765\u6e90', '\u6700\u65b0',
    ],
  },
  {
    id: 'message_delivery',
    triggers: [
      /send|message|wechat|discord|feishu|forward|reply/i,
      /\u53d1\u9001|\u53d1\u7ed9|\u6d88\u606f|\u5fae\u4fe1|\u56de\u590d|\u8f6c\u53d1/i,
    ],
    terms: [
      'message_delivery', 'send', 'message', 'send_message', 'wechat', 'discord',
      'feishu', 'forward', 'reply', '\u53d1\u9001', '\u53d1\u7ed9',
      '\u6d88\u606f', '\u5fae\u4fe1', '\u56de\u590d',
    ],
  },
  {
    id: 'verification',
    triggers: [
      /test|verify|check|error|wrong|failed|failure|bug|retry|again/i,
      /\u6d4b\u8bd5|\u9a8c\u8bc1|\u68c0\u67e5|\u62a5\u9519|\u9519\u4e86|\u5931\u8d25|\u91cd\u8bd5|\u518d/i,
    ],
    terms: [
      'verification', 'test', 'verify', 'check', 'error', 'wrong', 'failed',
      'failure', 'bug', 'retry', 'again', '\u6d4b\u8bd5', '\u9a8c\u8bc1',
      '\u68c0\u67e5', '\u9519\u4e86', '\u5931\u8d25',
    ],
  },
]

function safeJsonArray(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function normalizeTerm(term) {
  return String(term || '').trim().toLowerCase()
}

function isUsefulSearchTerm(term) {
  const normalized = normalizeTerm(term)
  if (!normalized) return false
  if (/^[a-z]+$/.test(normalized) && ENGLISH_STOP_TERMS.has(normalized)) return false
  if (/^[a-z]+$/.test(normalized) && normalized.length < 3) return false
  return true
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function termInText(lowerText, normalizedTerm) {
  if (!normalizedTerm) return false
  if (/^[a-z0-9_]+$/.test(normalizedTerm)) {
    const re = new RegExp(`(^|[^a-z0-9_])${escapeRegExp(normalizedTerm)}([^a-z0-9_]|$)`, 'i')
    return re.test(lowerText)
  }
  return lowerText.includes(normalizedTerm)
}

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function uniquePush(out, seen, value) {
  const normalized = normalizeTerm(value)
  if (!isUsefulSearchTerm(normalized) || seen.has(normalized)) return
  seen.add(normalized)
  out.push(String(value).trim())
}

function actionLogText(actionLog = []) {
  if (!Array.isArray(actionLog) || actionLog.length === 0) return ''
  return actionLog
    .slice(-5)
    .map(a => [a.tool, a.summary, a.detail, a.result_preview, a.error].filter(Boolean).join(' '))
    .join(' ')
}

function domainsForText(text) {
  return INTENT_LEXICON.filter(domain =>
    domain.triggers.some(re => re.test(text))
  )
}

function looksLikeAmbiguousFollowup(text) {
  const compact = cleanText(text)
  if (!compact) return true
  if (compact.length < 32) return true
  if (/(again|same|continue|that|it|retry|one more|do it|刚才|继续|一样|同样|再来|再试|那个|这个|它|还要|继续弄)/i.test(compact)) {
    return true
  }
  return extractKeywords(compact, 4).length < 2
}

export function buildPolicyActivationProfile({
  focusText = '',
  messageBody = '',
  contextText = '',
  actionLog = [],
} = {}) {
  const intentText = [messageBody, focusText]
    .filter(Boolean)
    .join(' ')
    .slice(0, 5000)
  const supportText = [actionLogText(actionLog), contextText].filter(Boolean).join(' ').slice(0, 4000)
  const currentDomains = domainsForText(intentText)
  const triggeredDomains = currentDomains.length > 0
    ? currentDomains
    : (looksLikeAmbiguousFollowup(intentText) ? domainsForText(supportText) : [])
  const currentText = [
    intentText,
    currentDomains.length > 0 ? '' : supportText,
  ].filter(Boolean).join(' ').slice(0, 7000)

  const terms = []
  const seen = new Set()
  for (const kw of extractKeywords(intentText, 12)) uniquePush(terms, seen, kw)
  if (currentDomains.length === 0) {
    for (const kw of extractKeywords(supportText, 8)) uniquePush(terms, seen, kw)
  }
  for (const domain of triggeredDomains) {
    uniquePush(terms, seen, domain.id)
    uniquePush(terms, seen, `domain:${domain.id}`)
    for (const term of domain.terms) uniquePush(terms, seen, term)
  }

  return {
    currentText,
    domains: triggeredDomains.map(d => d.id),
    terms: terms.slice(0, MAX_SEARCH_TERMS),
    termSet: new Set(terms.map(normalizeTerm)),
  }
}

function policyKindFromTags(tags) {
  const kindTag = tags.find(tag => String(tag).startsWith('kind:'))
  if (!kindTag) return ''
  return String(kindTag).slice('kind:'.length)
}

function memoryText(memory) {
  return [
    memory.mem_id,
    memory.title,
    memory.content,
    memory.detail,
    ...(safeJsonArray(memory.tags)),
  ].filter(Boolean).join(' ')
}

function isPolicyLike(memory) {
  const tags = safeJsonArray(memory.tags).map(String)
  if (tags.some(tag => POLICY_KIND_TAGS.has(tag))) return true
  if (POLICY_EVENT_TYPES.has(memory.event_type)) return true
  if (POLICY_MEM_ID_RE.test(memory.mem_id || '')) return true
  return POLICY_CUE_RE.test(memoryText(memory))
}

function hasDomainMatch(tags, domains) {
  return domains.some(domain => tags.includes(`domain:${domain}`))
}

function normalizeToolName(value) {
  const name = normalizeTerm(value)
  return /^[a-z][a-z0-9_]{1,49}$/.test(name) ? name : ''
}

function toolNamesFromTags(tags = []) {
  const out = []
  const seen = new Set()
  for (const tag of tags) {
    if (!String(tag).startsWith('tool:')) continue
    const name = normalizeToolName(String(tag).slice('tool:'.length))
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

function scorePolicy(memory, profile, matchedTerms = new Set()) {
  const tags = safeJsonArray(memory.tags).map(String)
  const lowerText = memoryText(memory).toLowerCase()
  let score = 0
  const reasons = []

  const kind = policyKindFromTags(tags)
  if (kind) {
    score += 6
    reasons.push(kind)
  }
  if (POLICY_EVENT_TYPES.has(memory.event_type)) {
    score += 5
    reasons.push(memory.event_type)
  }
  if (POLICY_MEM_ID_RE.test(memory.mem_id || '')) {
    score += 4
    reasons.push('mem_id')
  }
  if (POLICY_CUE_RE.test(lowerText)) {
    score += 3
    reasons.push('cue')
  }

  for (const domain of profile.domains) {
    if (tags.includes(`domain:${domain}`)) {
      score += 12
      reasons.push(`domain:${domain}`)
    }
  }

  for (const tag of tags) {
    if (!tag.startsWith('trigger:')) continue
    const trigger = normalizeTerm(tag.slice('trigger:'.length))
    if (!trigger) continue
    if (profile.termSet.has(trigger) || termInText(profile.currentText.toLowerCase(), trigger)) {
      score += 10
      reasons.push(`trigger:${trigger}`)
    }
  }

  for (const tool of toolNamesFromTags(tags)) {
    if (profile.termSet.has(tool) || termInText(profile.currentText.toLowerCase(), tool)) {
      score += 10
      reasons.push(`tool:${tool}`)
    }
  }

  for (const term of matchedTerms) {
    const normalized = normalizeTerm(term)
    if (!normalized) continue
    score += normalized.startsWith('domain:') ? 8 : 3
  }

  let textHits = 0
  for (const term of profile.terms) {
    const normalized = normalizeTerm(term)
    if (normalized.length < 2) continue
    if (termInText(lowerText, normalized)) textHits++
  }
  if (textHits > 0) {
    score += Math.min(10, textHits * 2)
    reasons.push(`${textHits} term hit${textHits === 1 ? '' : 's'}`)
  }

  const salience = Number(memory.salience) || 3
  if (salience >= 4) score += salience

  return {
    score,
    reasons: [...new Set(reasons)],
    hasDomainMatch: hasDomainMatch(tags, profile.domains),
  }
}

function mergeCandidate(map, memory, term = '') {
  if (!memory) return
  const key = memory.mem_id || `row:${memory.id}`
  const existing = map.get(key)
  if (existing) {
    if (term) existing._matchedTerms.add(term)
    return
  }
  map.set(key, { ...memory, _matchedTerms: new Set(term ? [term] : []) })
}

function candidatesFromSearchTerms(terms) {
  const candidates = new Map()
  for (const term of terms) {
    let hits = []
    try {
      hits = searchMemories(term, MAX_HITS_PER_TERM)
    } catch {
      hits = []
    }
    for (const hit of hits) mergeCandidate(candidates, hit, term)
  }
  return candidates
}

export function selectActivePolicies({
  focusText = '',
  messageBody = '',
  contextText = '',
  actionLog = [],
  baseMemories = [],
  limit = DEFAULT_LIMIT,
} = {}) {
  const profile = buildPolicyActivationProfile({ focusText, messageBody, contextText, actionLog })
  if (profile.terms.length === 0 && profile.domains.length === 0) return []

  const candidates = candidatesFromSearchTerms(profile.terms)
  for (const memory of baseMemories || []) mergeCandidate(candidates, memory, '')

  return [...candidates.values()]
    .filter(isPolicyLike)
    .map(memory => {
      const scored = scorePolicy(memory, profile, memory._matchedTerms)
      return {
        ...memory,
        _policyScore: scored.score,
        _policyReasons: scored.reasons,
        _hasPolicyDomainMatch: scored.hasDomainMatch,
      }
    })
    .filter(memory => {
      const matchedTerms = memory._matchedTerms?.size || 0
      const hasStrongRoute = memory._hasPolicyDomainMatch
        || memory._policyReasons.some(r => r.startsWith('trigger:') || r.startsWith('tool:'))
      const threshold = hasStrongRoute ? 10 : 12
      return memory._policyScore >= threshold && matchedTerms > 0
    })
    .sort((a, b) =>
      (b._policyScore - a._policyScore) ||
      ((Number(b.salience) || 3) - (Number(a.salience) || 3)) ||
      String(b.timestamp || '').localeCompare(String(a.timestamp || ''))
    )
    .slice(0, limit)
}

function truncate(text, max) {
  const value = cleanText(text)
  return value.length > max ? value.slice(0, max - 1) + '...' : value
}

function formatMemoryPolicy(memory) {
  const tags = safeJsonArray(memory.tags).map(String)
  const kind = policyKindFromTags(tags) || (memory.event_type === 'self_constraint' ? 'constraint' : 'policy')
  const id = memory.mem_id || `row:${memory.id}`
  const title = memory.title ? `${memory.title}: ` : ''
  const body = truncate(`${title}${memory.content || ''}`, 280)
  const detail = truncate(memory.detail || '', 220)
  const sameDetail = detail && cleanText(detail) === cleanText(memory.content || '')
  const reason = memory._policyReasons?.length
    ? ` (matched: ${memory._policyReasons.slice(0, 3).join(', ')})`
    : ''
  const detailLine = detail && !sameDetail ? `\n  Detail: ${detail}` : ''
  return `- [${kind}] ${id}${reason}: ${body}${detailLine}`
}

export function formatActivePoliciesForPrompt(policies = []) {
  if (!Array.isArray(policies) || policies.length === 0) return ''
  return policies.map(formatMemoryPolicy).join('\n')
}

function policyHintForTool(memory) {
  const tags = safeJsonArray(memory.tags).map(String)
  const kind = policyKindFromTags(tags) || (memory.event_type === 'self_constraint' ? 'constraint' : 'policy')
  const id = memory.mem_id || `row:${memory.id}`
  const title = memory.title ? `${memory.title}: ` : ''
  const body = truncate(`${title}${memory.content || ''}`, 220)
  const detail = truncate(memory.detail || '', 120)
  const sameDetail = detail && cleanText(detail) === cleanText(memory.content || '')
  return `[${kind}] ${id}: ${body}${detail && !sameDetail ? ` Detail: ${detail}` : ''}`
}

export function formatToolPromptHintsForSchemas(policies = [], toolNames = [], {
  limitPerTool = 2,
} = {}) {
  if (!Array.isArray(policies) || policies.length === 0) return {}
  const candidateTools = (Array.isArray(toolNames) ? toolNames : [])
    .map(normalizeToolName)
    .filter(Boolean)
  const byTool = new Map()

  for (const memory of policies) {
    if (!memory) continue
    const tags = safeJsonArray(memory.tags).map(String)
    const explicitTools = toolNamesFromTags(tags)
    const lowerText = memoryText(memory).toLowerCase()
    const tools = explicitTools.length > 0
      ? explicitTools
      : candidateTools.filter(tool => termInText(lowerText, tool))

    for (const tool of tools) {
      const arr = byTool.get(tool) || []
      if (arr.length >= limitPerTool) continue
      arr.push(policyHintForTool(memory))
      byTool.set(tool, arr)
    }
  }

  return Object.fromEntries(byTool.entries())
}
