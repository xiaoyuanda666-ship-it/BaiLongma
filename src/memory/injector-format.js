// 注入器 · 渲染层
//
// 把检索/采集到的结构化数据渲染成可注入系统提示词的字符串块。
// 纯函数，不依赖 DB / 网络 / state——从 injector.js 拆出，便于单独维护与测试。
// 历史上这些 format* 函数都挤在 injector.js 里，跟检索逻辑耦合不强，是最自然的切口。

function summarizeUISignals(signals = []) {
  if (!signals.length) return ''
  const now = Date.now()
  const lines = signals.map(s => {
    const age = Math.max(0, Math.round((now - s.ts) / 1000))
    let payload = {}
    try { payload = JSON.parse(s.payload || '{}') } catch {}
    const target = s.target ? ` (${s.target})` : ''
    let desc = s.type
    if (s.type === 'card.mounted')        desc = `Card finished mounting${target}`
    else if (s.type === 'card.dismissed') desc = `User dismissed the card${target} (${payload.by || 'unknown'}, dwell ${Math.round((payload.dwell_ms||0)/1000)}s)`
    else if (s.type === 'card.dwell')     desc = `Card dwell ${Math.round((payload.dwell_ms||0)/1000)}s${target}`
    else if (s.type === 'card.action')    desc = `User acted on card: ${payload.action || ''}${target}`
    else if (s.type === 'card.error')     desc = `Card error: ${payload.message || ''}${target}`
    return `- ${age}s ago: ${desc}`
  })
  return `UI behavior from the past minute. This is context only; do not speak proactively just because of it:\n${lines.join('\n')}`
}
export { summarizeUISignals }

// 渲染成 <temporal-recall> 块的字符串（多个区间各自一段）。
// 给 prompt.js / system-prompt-preview.js 用，injector 只负责出 buckets 数据。
export function formatTemporalRecall(buckets) {
  if (!buckets || buckets.length === 0) return ''
  return buckets.map(b => {
    const lines = b.memories.map(m => {
      const timePart = (m.timestamp || '').slice(11, 16) // HH:MM
      const star = (m.salience ?? 3) >= 4 ? '★ ' : ''
      const title = m.title ? m.title.replace(/^专注结论：/, '').trim() : ''
      const topicHint = title ? `[${title}] ` : ''
      const body = (m.content || '').replace(/\s+/g, ' ').trim()
      return `- ${timePart} ${star}${topicHint}${body}`
    }).join('\n')
    return `<temporal-recall date="${b.date}" label="${b.label}">\n${lines}\n</temporal-recall>`
  }).join('\n\n')
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
      const bodyHint = bodyPath ? `\n  ↳ Full text: read_file("${bodyPath}")` : ''
      const salienceMark = memory.salience >= 4 ? ` ★${memory.salience}` : ''
      return `- [${memory.timestamp.slice(0, 10)}${salienceMark}] ${typeLabel}${titlePart}${memory.content}${bodyHint}`
    }).join('\n'))
  }

  if (recallMemories?.length > 0) {
    parts.push('[Recall details]\n' + recallMemories.map(memory => {
      const titlePart = memory.title ? `《${memory.title}》 ` : ''
      const bodyPath = extractBodyPath(memory)
      const bodyHint = bodyPath ? `\n  ↳ Full text: read_file("${bodyPath}")` : ''
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
    return `[${item.source}] (${fetchedTime} already fetched)\n${item.content}`
  }).join('\n\n')
  return body + '\n\nThe data above has already been prefetched. Use it directly and phrase the response naturally; do not reuse the same sentence pattern every time.'
}

// 当前屏幕上的存活 ACUI 卡片列表
export function formatActiveUICards(cards = []) {
  if (!cards?.length) return ''
  const lines = cards.map(c => `  - id="${c.id}"  component=${c.component}`)
  return `[Active UI cards on screen]\n${lines.join('\n')}\nUse ui_hide with the id to close a card; use ui_update to update its content.`
}

// 当前屏幕上的 scene surfaces(新 Agent-UI 架构,SceneStore 的紧凑投影)。
// 只暴露 id/kind/intent/focus —— 让 Agent 知道"屏上有什么",但碰不到像素/data。
// 这是设计方案 §四的闭环回注:背景状态,不是触发器。
export function formatSceneManifest(manifest = []) {
  if (!manifest?.length) return ''
  const lines = manifest.map(s => {
    const flags = []
    if (s.focus) flags.push('focus')
    if (s.intent && s.intent !== 'inform') flags.push(s.intent)
    const tail = flags.length ? `  [${flags.join(', ')}]` : ''
    return `  - id="${s.id}"  kind=${s.kind}${tail}`
  })
  return `[Surfaces currently on screen]\n${lines.join('\n')}\nThis is what you have placed on the interface via ui_set. To update one, call ui_set with the same id; to remove one, ui_set with that id and remove=true. Treat this as context, not a trigger — do not react merely because something is on screen.`
}

// AI 视频生成面板「感知」：把面板开关状态 + 用户正在编辑的提示词草稿贴进上下文。
// state 来自 media.js 的 getAIVideoPanelState()。面板关闭且无草稿时不渲染（零噪声）。
export function formatAIVideoPanel(state) {
  if (!state || (!state.open && !state.prompt)) return ''
  const lines = ['<aivideo-panel>']
  lines.push(state.open ? 'AI video generation panel: currently open.' : 'AI video generation panel: currently closed.')
  const draft = String(state.prompt || '').trim()
  if (draft) {
    lines.push(`The user's current draft in the prompt input box: "${draft}"`)
    lines.push('If the user asks you to "optimize / rewrite the prompt", edit the draft above directly — you can already see it, so do not ask the user again what they wrote.')
    lines.push('By default, only give the rewritten version in the conversation for the user to review; do not auto-overwrite the input box. Only after the user explicitly says to adopt it (e.g. "用这个/就用这个") should you call generate_video(action="set_prompt", prompt="…") to write it back into the input box. The user can also copy-paste it from your reply themselves.')
  } else if (state.open) {
    lines.push('The prompt input box is currently empty.')
  }
  lines.push('</aivideo-panel>')
  return lines.join('\n')
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
