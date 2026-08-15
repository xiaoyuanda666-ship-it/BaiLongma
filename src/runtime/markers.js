// 文本协议标记的单一真相源（single source of truth）。
//
// 模型输出文本里夹带 4 种运行时协议标记，运行时用正则提取并执行 / 剥离：
//   [RECALL: ...]          → 主动召回请求
//   [SET_TASK: ...]        → 设置当前任务
//   [CLEAR_TASK]           → 清空当前任务
//   [UPDATE_PERSONA: ...]  → 更新人格
//
// 本模块只负责「解析」与「剥离」，不做任何副作用（setConfig / insertMemory /
// emitEvent / state 写入等业务逻辑仍留在调用方原地）。
//
// ⚠ 正则一字不差地从原散落点搬来，保证行为完全等价：
//   - parseMarkers 用的是 index.js / test-runner.js 里「提取捕获值」的正则
//     （非 global、RECALL 用 .+? 单行匹配）。
//   - stripMarkers 用的是 llm.js stripProtocolMarkersForDelivery 里「剥离」的正则
//     （global、RECALL 用 .+? 单行匹配，其余用 [\s\S]+? 跨行匹配）。

// ── 解析用正则（提取捕获值，非 global）──────────────────────────────
// 与原 index.js 1202/1212/1221/1228 及 test-runner.js 57/63 完全一致。
const RECALL_PARSE = /\[RECALL:\s*(.+?)\]/
const SET_TASK_PARSE = /\[SET_TASK:\s*([\s\S]+?)\]/
const CLEAR_TASK_PARSE = /\[CLEAR_TASK\]/
const UPDATE_PERSONA_PARSE = /\[UPDATE_PERSONA:\s*([\s\S]+?)\]/

// ── 剥离用正则（global，用于从正文中删除）────────────────────────────
// 与原 llm.js stripProtocolMarkersForDelivery 378-382 完全一致。
const THINK_STRIP = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi
const RECALL_STRIP = /\[RECALL:\s*.+?\]/g
const SET_TASK_STRIP = /\[SET_TASK:\s*[\s\S]+?\]/g
const CLEAR_TASK_STRIP = /\[CLEAR_TASK\]/g
const UPDATE_PERSONA_STRIP = /\[UPDATE_PERSONA:\s*[\s\S]+?\]/g

const HIGH_CONFIDENCE_INTERNAL_LINE_RE = [
  /^(?:用户|user).*?(?:刚从|切到|切回|话题|意图|可能|上下文|语音输入|问)/i,
  /^(?:结合上下文|考虑到|最(?:可能|自然)的(?:意图|理解)|话题(?:切回|切到|切换)|当前(?:最可能|应该是在问))/,
  /^the user\b.*\b(probably|likely|intent|context|topic|asked|switched)\b/i,
  /^(?:given|considering)\b.*\b(context|conversation|history|user)\b/i,
]

const LOW_CONFIDENCE_INTERNAL_LINE_RE = [
  /^让我(?:想想|查|看|确认|检查)/,
  /^我(?:先|需要|来)(?:想想|查|看|确认|检查)/,
  /^I\s+(?:need to|should|will|can)\s+(?:check|look|think|figure|inspect)\b/i,
]

const INTERNAL_PREFIX_RE = /^(?:用户|user|结合上下文|考虑到|最可能|最自然|话题|当前|让我|我先|我需要|我来|the user|given|considering|i need|i should|i will|i can)/i

function classifyLooseInternalLine(line) {
  const s = String(line || '').trim()
  if (!s) return 'blank'
  if (s.includes('<invoke') || s.includes('</invoke>')) return 'none'
  if (s.length > 240) return 'none'
  if (HIGH_CONFIDENCE_INTERNAL_LINE_RE.some(re => re.test(s))) return 'high'
  if (LOW_CONFIDENCE_INTERNAL_LINE_RE.some(re => re.test(s))) return 'low'
  return 'none'
}

function startsLikeLooseInternalPrelude(text) {
  const s = String(text || '').trimStart()
  return !!s && INTERNAL_PREFIX_RE.test(s)
}

export function stripLooseThinkingPrelude(text) {
  const s = String(text || '').replace(/^\uFEFF/, '')
  const lines = s.split(/\r?\n/)
  let i = 0
  let dropped = false
  let sawHighConfidence = false

  while (i < lines.length) {
    const kind = classifyLooseInternalLine(lines[i])
    if (kind === 'blank') {
      if (dropped || i === 0) {
        i++
        continue
      }
      break
    }
    if (kind === 'high') {
      dropped = true
      sawHighConfidence = true
      i++
      continue
    }
    if (kind === 'low' && sawHighConfidence) {
      dropped = true
      i++
      continue
    }
    break
  }

  return (dropped ? lines.slice(i).join('\n') : s).trim()
}

/**
 * 只解析、不做副作用。提取 4 种标记的捕获值。
 * @param {string} text 模型原始输出文本
 * @returns {{ recall: string|null, setTask: string|null, clearTask: boolean, updatePersona: string|null }}
 *   recall / setTask / updatePersona：命中则为「未经 trim 的原始捕获子串」（保持与原 match[1] 一致，
 *   trim 由调用方按原逻辑自行决定）；未命中为 null。
 *   clearTask：命中为 true，否则 false。
 */
export function parseMarkers(text) {
  const s = String(text || '')
  const recallMatch = s.match(RECALL_PARSE)
  const setTaskMatch = s.match(SET_TASK_PARSE)
  const personaMatch = s.match(UPDATE_PERSONA_PARSE)
  return {
    recall: recallMatch ? recallMatch[1] : null,
    setTask: setTaskMatch ? setTaskMatch[1] : null,
    clearTask: CLEAR_TASK_PARSE.test(s),
    updatePersona: personaMatch ? personaMatch[1] : null,
  }
}

/**
 * 剥掉 <think>/<thinking> 块（可选）和全部 4 个协议标记后返回正文。
 * 与原 llm.js stripProtocolMarkersForDelivery 行为完全一致（含末尾 .trim()）。
 * @param {string} text
 * @param {{ stripThink?: boolean }} [opts] stripThink 默认 true
 * @returns {string}
 */
export function stripMarkers(text, { stripThink = true } = {}) {
  let s = String(text || '')
  if (stripThink) s = s.replace(THINK_STRIP, '')
  return s
    .replace(RECALL_STRIP, '')
    .replace(SET_TASK_STRIP, '')
    .replace(CLEAR_TASK_STRIP, '')
    .replace(UPDATE_PERSONA_STRIP, '')
    .trim()
}

export function dedupeAdjacentReplyText(text = '') {
  const value = String(text || '')
  // Repeated source/code lines can be meaningful; leave fenced artifacts byte
  // for byte. This guard targets ordinary natural-language final replies only.
  if (value.includes('```')) return value

  const lines = value.split(/\r?\n/)
  const dedupedLines = []
  let previousLine = ''
  for (const line of lines) {
    const normalized = line.trim().replace(/\s+/g, ' ')
    if (normalized && normalized === previousLine) continue
    dedupedLines.push(line)
    previousLine = normalized
  }

  const joined = dedupedLines.join('\n')
  const units = joined.match(/[^。！？!?\n]+[。！？!?]+|\n+|[^。！？!?\n]+$/g)
  if (!units) return joined
  const out = []
  let previousSentence = ''
  for (const unit of units) {
    if (/^\n+$/.test(unit)) {
      out.push(unit)
      previousSentence = ''
      continue
    }
    const normalized = unit.trim().replace(/\s+/g, ' ')
    if (normalized && normalized === previousSentence) continue
    out.push(unit)
    previousSentence = normalized
  }
  return out.join('')
}

export function sanitizeAssistantReplyForDelivery(text) {
  return dedupeAdjacentReplyText(stripLooseThinkingPrelude(stripMarkers(text)))
}

export function createAssistantReplyStreamSanitizer() {
  let buffer = ''
  let passthrough = false

  const drainBuffer = (force = false) => {
    if (!buffer) return ''
    if (passthrough) {
      const out = buffer
      buffer = ''
      return out
    }

    const newlineMatch = buffer.match(/\r?\n/)
    if (!newlineMatch && !force) {
      if (startsLikeLooseInternalPrelude(buffer) && buffer.length < 800) return ''
      passthrough = true
      const out = buffer
      buffer = ''
      return out
    }

    const sanitized = sanitizeAssistantReplyForDelivery(buffer)
    if (!force && !sanitized && startsLikeLooseInternalPrelude(buffer) && buffer.length < 1600) {
      return ''
    }

    buffer = ''
    passthrough = true
    return sanitized
  }

  return {
    push(text) {
      if (!text) return ''
      buffer += String(text)
      return drainBuffer(false)
    },
    flush() {
      return drainBuffer(true)
    },
  }
}
