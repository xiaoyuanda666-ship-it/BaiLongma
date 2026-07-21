import {
  getMemoriesByEntity,
  getPersonMemory,
  getRecentActionLogs,
  getRecentConversation,
  getUserProfile,
  upsertUserProfile,
} from '../db.js'
import { getInstalledSoftwareSnapshot } from '../installed-software-scanner.js'
import { PRIMARY_USER_ID } from '../identity.js'

const ROLE_RULES = [
  {
    label: 'AI agent / LLM product builder',
    keywords: [/bailongma/i, /agent/i, /llm/i, /prompt/i, /context/i, /memory/i, /codex/i, /claude/i, /openai/i, /minimax/i],
    apps: [/cursor/i, /claude/i, /codex/i, /chatgpt/i, /ollama/i, /lm studio/i],
    domains: ['AI agents', 'LLM context', 'memory systems'],
  },
  {
    label: 'Software developer / project maintainer',
    keywords: [/electron/i, /node/i, /javascript/i, /typescript/i, /sqlite/i, /database/i, /build/i, /ci/i, /github/i, /api/i],
    apps: [/visual studio code/i, /\bvscode\b/i, /git/i, /github/i, /node/i, /python/i, /docker/i, /powershell/i, /visual studio/i],
    domains: ['software engineering', 'desktop apps', 'tooling'],
  },
  {
    label: 'Product / system designer',
    keywords: [/prototype/i, /design/i, /ui/i, /ux/i, /figma/i, /interaction/i, /prototype/i],
    apps: [/figma/i, /adobe/i, /photoshop/i, /illustrator/i, /sketch/i, /framer/i],
    domains: ['product design', 'interaction design'],
  },
  {
    label: 'Creative media producer',
    keywords: [/video/i, /music/i, /audio/i, /image/i, /animation/i, /render/i],
    apps: [/blender/i, /davinci/i, /premiere/i, /after effects/i, /audition/i, /obs/i, /capcut/i],
    domains: ['media production', 'visual creation'],
  },
  {
    label: 'Business / operations user',
    keywords: [/crm/i, /sales/i, /operation/i, /marketing/i, /spreadsheet/i, /excel/i, /finance/i],
    apps: [/excel/i, /office/i, /wps/i, /feishu/i, /lark/i, /wecom/i, /dingtalk/i, /notion/i],
    domains: ['operations', 'business workflows'],
  },
]

const EXPERTISE_RULES = [
  { label: 'high technical depth', patterns: [/architecture/i, /context injection/i, /prompt cache/i, /sqlite/i, /electron/i, /llm/i, /agent/i] },
  { label: 'comfortable with implementation details', patterns: [/src\//i, /\.js/i, /database/i, /schema/i, /tool/i, /build/i] },
  { label: 'cares about product behavior and user experience', patterns: [/用户画像|用户体验|交互|服务|理解用户|personality|profile/i] },
]

const STYLE_RULES = [
  // Language preference must be explicit and durable. Merely seeing Chinese in
  // a message does not mean the user wants every future reply in Chinese.
  { label: 'explicitly prefers Chinese replies', patterns: [
    /(?:以后|今后|从现在起|默认|一直|始终|总是).{0,16}(?:用中文|说中文|中文回复|中文回答)/i,
    /(?:from now on|going forward|always|by default).{0,24}(?:reply|respond|answer|speak).{0,12}(?:in )?(?:chinese|mandarin)/i,
  ] },
  { label: 'explicitly prefers English replies', patterns: [
    /(?:以后|今后|从现在起|默认|一直|始终|总是).{0,16}(?:用英文|说英文|英语回复|英文回复|英语回答|英文回答)/i,
    /(?:from now on|going forward|always|by default).{0,24}(?:reply|respond|answer|speak).{0,12}(?:in )?english/i,
  ] },
  { label: 'likes direct architectural analysis before implementation', patterns: [/分析一下|应该怎么做|逻辑|架构|实现一下/i] },
  { label: 'values adaptive and personalized assistance', patterns: [/用户画像|理解用户|更好地为用户服务|不断矫正|第一印象/i] },
]

const NEGATIVE_ROLE_CORRECTIONS = [
  { role: /Software developer|project maintainer/i, patterns: [/我不是.*(程序员|开发|工程师)/, /不是.*(程序员|开发者|工程师)/] },
  { role: /Product|designer/i, patterns: [/我不是.*(设计师|产品)/, /不是.*(设计师|产品经理)/] },
  { role: /Creative media/i, patterns: [/我不是.*(视频|剪辑|创作|媒体)/] },
]

const POSITIVE_ROLE_CORRECTIONS = [
  { label: 'Software developer / project maintainer', patterns: [/我是.*(程序员|开发者|工程师)/, /我做.*(开发|编程|软件)/] },
  { label: 'Product / system designer', patterns: [/我是.*(产品|设计师)/, /我做.*(产品|设计|交互)/] },
  { label: 'AI agent / LLM product builder', patterns: [/我做.*(agent|智能体|大模型|LLM|AI产品)/i, /我是.*(AI产品|智能体|agent)/i] },
]

function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n || 0)))
}

function capHypothesisConfidence(confidence, status = 'hypothesis') {
  if (status === 'user_stated') return Math.max(0.92, clamp01(confidence))
  if (status === 'contradicted_by_user') return Math.min(0.18, clamp01(confidence))
  return Math.min(0.85, clamp01(confidence))
}

function uniq(items) {
  return [...new Set((items || []).map(s => String(s || '').trim()).filter(Boolean))]
}

function compactEvidence(items, limit = 10) {
  return uniq(items).slice(0, limit)
}

function textOf(rows = []) {
  return rows.map(row => [row.content, row.detail, row.title].filter(Boolean).join(' ')).join('\n')
}

function scoreRule(rule, { text, appNames }) {
  const evidence = []
  let keywordHits = 0
  for (const pattern of rule.keywords || []) {
    if (pattern.test(text)) {
      keywordHits += 1
      evidence.push(`conversation/memory matched ${pattern}`)
    }
  }
  let appHits = 0
  for (const pattern of rule.apps || []) {
    const app = appNames.find(name => pattern.test(name))
    if (app) {
      appHits += 1
      evidence.push(`installed app: ${app}`)
    }
  }
  const score = Math.min(1, keywordHits * 0.11 + appHits * 0.13)
  return { score, evidence: compactEvidence(evidence, 5) }
}

function inferLabels(rules, text, limit = 4) {
  return rules
    .map(rule => {
      const hits = (rule.patterns || []).filter(pattern => pattern.test(text)).length
      return hits > 0 ? { label: rule.label, confidence: capHypothesisConfidence(0.45 + hits * 0.15) } : null
    })
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit)
}

function inferProjects(text) {
  const projects = []
  if (/bailongma/i.test(text) || /白龙马/.test(text)) projects.push('Bailongma')
  if (/agent/i.test(text) && /memory|context|prompt/i.test(text)) projects.push('agent memory/context system')
  if (/electron/i.test(text)) projects.push('Electron desktop app')
  return uniq(projects).slice(0, 5)
}

function applyCorrections(roles, text) {
  let next = roles.map(role => ({ ...role }))
  for (const correction of NEGATIVE_ROLE_CORRECTIONS) {
    if (!correction.patterns.some(pattern => pattern.test(text))) continue
    next = next.map(role => correction.role.test(role.label)
      ? {
          ...role,
          confidence: Math.min(role.confidence || 0, 0.18),
          status: 'contradicted_by_user',
          evidence: compactEvidence([...(role.evidence || []), 'user correction contradicted this role'], 6),
        }
      : role)
  }
  for (const correction of POSITIVE_ROLE_CORRECTIONS) {
    if (!correction.patterns.some(pattern => pattern.test(text))) continue
    const existing = next.find(role => role.label === correction.label)
    if (existing) {
      existing.confidence = Math.max(existing.confidence || 0, 0.92)
      existing.status = 'user_stated'
      existing.evidence = compactEvidence([...(existing.evidence || []), 'user explicitly stated this role'], 6)
    } else {
      next.push({
        label: correction.label,
        confidence: 0.92,
        evidence: ['user explicitly stated this role'],
        status: 'user_stated',
      })
    }
  }
  return next.sort((a, b) => b.confidence - a.confidence).slice(0, 5)
}

function mergeWithPrevious(next, previous) {
  if (!previous) return next
  const previousRoles = Array.isArray(previous.roles) ? previous.roles : []
  const byLabel = new Map()
  for (const role of previousRoles) {
    if (role?.label) byLabel.set(role.label, { ...role, confidence: clamp01((role.confidence || 0) * 0.85) })
  }
  for (const role of next.roles) {
    const old = byLabel.get(role.label)
    if (role.status === 'contradicted_by_user') {
      byLabel.set(role.label, {
        ...role,
        confidence: Math.min(role.confidence || 0, 0.18),
        evidence: compactEvidence([...(old?.evidence || []), ...(role.evidence || [])], 6),
      })
      continue
    }
    if (role.status === 'user_stated') {
      byLabel.set(role.label, {
        ...role,
        confidence: Math.max(role.confidence || 0, 0.92),
        evidence: compactEvidence([...(old?.evidence || []), ...(role.evidence || [])], 6),
      })
      continue
    }
    byLabel.set(role.label, {
      ...role,
      confidence: old ? Math.max(role.confidence, old.confidence) : role.confidence,
      evidence: compactEvidence([...(old?.evidence || []), ...(role.evidence || [])], 6),
    })
  }
  return {
    ...next,
    roles: [...byLabel.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 5),
    domains: uniq([...(next.domains || []), ...(previous.domains || [])]).slice(0, 8),
    projects: uniq([...(next.projects || []), ...(previous.projects || [])]).slice(0, 6),
  }
}

export function buildProfileFromSignals({ userId = PRIMARY_USER_ID, apps = [], personMemory = null, memories = [], conversation = [], actionLog = [], previous = null } = {}) {
  const appNames = apps.map(app => String(app.name || app).trim()).filter(Boolean)
  // Communication preferences describe what the user asked for, so infer them
  // only from user-authored conversation rows. Internal memories, assistant
  // replies, and action logs often contain Chinese and must not set language.
  // Rows without a role are treated as user input for backward compatibility
  // with older callers and tests.
  const userConversationText = textOf(conversation.filter(row => !row?.role || row.role === 'user'))
  const combinedText = [
    personMemory?.content,
    personMemory?.detail,
    textOf(memories),
    textOf(conversation),
    textOf(actionLog.map(a => ({ content: `${a.tool || ''} ${a.summary || ''} ${a.detail || ''}` }))),
    appNames.join(' '),
  ].filter(Boolean).join('\n')

  const roles = []
  const domains = []
  const evidence = []
  for (const rule of ROLE_RULES) {
    const { score, evidence: ruleEvidence } = scoreRule(rule, { text: combinedText, appNames })
    if (score < 0.18) continue
    roles.push({
      label: rule.label,
      confidence: capHypothesisConfidence(0.28 + score),
      evidence: ruleEvidence,
      status: 'hypothesis',
    })
    domains.push(...(rule.domains || []))
    evidence.push(...ruleEvidence)
  }

  const expertise = inferLabels(EXPERTISE_RULES, combinedText)
  const communication_style = inferLabels(STYLE_RULES, userConversationText)
  const projects = inferProjects(combinedText)
  const sortedRoles = applyCorrections(roles.sort((a, b) => b.confidence - a.confidence).slice(0, 5), combinedText)
  const topRole = sortedRoles[0]
  const confidence = topRole ? clamp01(topRole.confidence) : 0
  const summary = topRole
    ? `Working impression: the user may be ${topRole.label}, based on local tools and repeated conversation/project signals. Treat this as a fallible hypothesis and update it when the user corrects it.`
    : 'Working impression is still weak. Use only explicit user statements and avoid assuming profession, expertise, or personality.'

  return mergeWithPrevious({
    user_id: userId,
    summary,
    roles: sortedRoles,
    domains: uniq(domains).slice(0, 8),
    expertise,
    projects,
    preferences: [],
    communication_style,
    evidence: compactEvidence(evidence),
    confidence,
    updated_at: new Date().toISOString(),
  }, previous)
}

export function refreshUserProfile(userId = PRIMARY_USER_ID) {
  try {
    const previous = getUserProfile(userId)
    const personMemory = getPersonMemory(userId)
    const memories = getMemoriesByEntity(userId, 30)
    const conversation = getRecentConversation(userId, 30, 24 * 14, { includeAbsorbed: true })
    const actionLog = getRecentActionLogs(30)
    const software = getInstalledSoftwareSnapshot()
    const profile = buildProfileFromSignals({
      userId,
      apps: software.apps || [],
      personMemory,
      memories,
      conversation,
      actionLog,
      previous,
    })
    // A weak role/profile refresh used to return the previous row wholesale.
    // That preserved the legacy false "prefers Chinese conversation" label
    // forever. Preserve unrelated profile fields, but always replace the
    // communication style with the freshly user-only inference.
    if (profile.confidence <= 0 && previous) {
      return upsertUserProfile({
        ...previous,
        communication_style: profile.communication_style,
        updated_at: new Date().toISOString(),
      })
    }
    return upsertUserProfile(profile)
  } catch (err) {
    console.warn('[user-profile] refresh failed:', err?.message || err)
    return getUserProfile(userId)
  }
}
