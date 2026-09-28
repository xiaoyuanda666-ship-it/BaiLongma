import {
  searchMemories,
  searchMemoriesByKeywords,
  upsertMemoryByMemId,
  memoryExistsByMemId,
  getMemoryByMemId,
  hideMemoryByMemId,
} from '../../db.js'
import { emitEvent } from '../../runtime/events.js'
import { extractKeywords } from '../../memory/keywords.js'

// search_memory：批量按关键词检索记忆。
// 优先走 keywords 数组；为兼容旧调用方，单字符串 keyword 也接受（自动转数组）。
// 输入有 keywords 时返回 JSON 字符串（结构化命中 + matched_by），用于识别器查重。
// 输入只有 keyword 时返回旧版拼接字符串，用于主对话主动检索。
export async function execSearchMemory(args = {}) {
  const { keyword, limit, limit_per_keyword, type_filter } = args

  // XML tool call parser passes array values as JSON strings — parse if needed
  let keywords = args.keywords
  if (typeof keywords === 'string') {
    try { keywords = JSON.parse(keywords) } catch { keywords = [keywords] }
  }

  if (Array.isArray(keywords) && keywords.length > 0) {
    const cleaned = keywords.map(k => String(k || '').trim()).filter(Boolean).slice(0, 8)
    if (cleaned.length === 0) return JSON.stringify({ ok: false, error: 'no valid keywords' })
    const hits = searchMemoriesByKeywords(cleaned, {
      limitPerKeyword: Math.max(1, Math.min(Number(limit_per_keyword || 5), 10)),
      typeFilter: type_filter || null,
    })
    return JSON.stringify({ ok: true, count: hits.length, hits }, null, 2)
  }

  if (keyword) {
    const rows = searchMemories(keyword, Math.max(1, Math.min(Number(limit || 5), 20)))
    if (rows.length === 0) return `未找到包含"${keyword}"的记忆`
    return rows.map(m =>
      `[${m.timestamp.slice(0, 10)}] ${m.event_type}: ${m.content}\n  ${m.detail?.slice(0, 100) ?? ''}`
    ).join('\n\n')
  }

  return '错误：未提供 keywords 或 keyword'
}

// upsert_memory：识别器调用，按 mem_id 批量 upsert。
export async function execUpsertMemory(args = {}, context = {}) {
  let list = null

  if (Array.isArray(args.memories)) {
    list = args.memories
  } else if (typeof args.memories === 'string') {
    // XML tool call parser passes all parameter values as strings — try to parse JSON
    try { const parsed = JSON.parse(args.memories); if (Array.isArray(parsed)) list = parsed } catch {}
  }

  // LLM forgot the memories[] wrapper and put fields at top level — auto-wrap
  if (!list && args.mem_id) {
    list = [args]
  }

  if (!list || list.length === 0) {
    return JSON.stringify({
      ok: false,
      error: 'missing memories[]',
      hint: 'Pass memories as an array: upsert_memory({ memories: [{ mem_id, type, title, content }] })',
    })
  }

  // 守门：自我感知层判定当前 user 输入是"镜像/风格融合"时，阻止把它学成 fact。
  // 这是反射弧，不靠 LLM 自觉。镜像污染最常见的入口就是 fact 类型被错误学习成"用户偏好"。
  // person / knowledge / object 仍允许写入（它们各有主体，污染风险低）。
  const perception = context.selfPerception
  const mirrorActive = perception && (
    perception.mirror?.exact
    || (perception.mirror?.score ?? 0) >= 0.6
    || perception.style?.hit
    || (perception.loop ?? 0) >= 2
  )
  if (mirrorActive) {
    const blocked = list.filter(m => {
      const t = m?.type || (typeof m?.mem_id === 'string' && m.mem_id.startsWith('fact_') ? 'fact' : null)
      return t === 'fact'
    })
    if (blocked.length > 0) {
      const reasonParts = []
      if (perception.mirror?.exact || (perception.mirror?.score ?? 0) >= 0.6) reasonParts.push('对方在复述你的话')
      if (perception.style?.hit) reasonParts.push('对方使用 agent 内独白语气')
      if ((perception.loop ?? 0) >= 2) reasonParts.push(`对话已陷入 ${perception.loop} 轮逐字回环`)
      return JSON.stringify({
        ok: false,
        blocked: true,
        reason: `本轮处于自我边界异常状态（${reasonParts.join('；')}）。fact 类记忆代表"用户的稳定偏好"，而当前 user 消息很可能来自模仿/复述，不应被当作偏好写入长期记忆。`,
        blocked_mem_ids: blocked.map(m => m.mem_id).filter(Boolean),
        hint: '若你确实想保留这次现象本身，请改用 type=knowledge（关于这次交互的观察）而不是 type=fact。',
      })
    }
  }

  const sourceRef = context.sessionRef || context.source_ref || null
  // 同批次：无 parent 的先写，有 parent 的后写，保证父节点 mem_id 已就绪
  const roots = list.filter(m => !m.parent_mem_id)
  const children = list.filter(m => m.parent_mem_id)
  const ordered = [...roots, ...children]

  const results = []
  for (const memory of ordered) {
    try {
      // 只对 fact 兜底：fact 绝大多数是关于用户的稳定事实/偏好；
      // person/object/article/knowledge 有各自主体，不该粘上 sender ID
      const isFact = memory.type === 'fact' || (!memory.type && typeof memory.mem_id === 'string' && memory.mem_id.startsWith('fact_'))
      const entitiesEmpty = !Array.isArray(memory.entities) || memory.entities.length === 0
      // 只对新记忆兜底，避免 UPDATE 覆盖旧 entities
      if (entitiesEmpty && isFact && context.senderId && !memoryExistsByMemId(memory.mem_id)) {
        memory.entities = [context.senderId]
        console.log(`[识别器] entities 兜底注入: mem_id=${memory.mem_id} entities=[${context.senderId}]`)
      }
      const payload = { ...memory, source_ref: memory.source_ref || sourceRef }
      const r = upsertMemoryByMemId(payload)
      results.push({ mem_id: r.mem_id, action: r.updated ? 'updated' : 'inserted', id: r.id })
    } catch (err) {
      results.push({ mem_id: memory.mem_id || null, action: 'error', error: err.message })
    }
  }

  const inserted = results.filter(r => r.action === 'inserted').length
  const updated = results.filter(r => r.action === 'updated').length
  const failed = results.filter(r => r.action === 'error').length
  return JSON.stringify({ ok: failed === 0, inserted, updated, failed, results }, null, 2)
}

// skip_recognition：识别器明确表示无内容要存
export async function execSkipRecognition({ reason } = {}) {
  return JSON.stringify({ ok: true, skipped: true, reason: reason || '' })
}

// merge_memories：整合器合并多条语义重复记忆。
// keep 被 PATCH 更新；drops 不再硬删除，改为软隐藏（visibility=0, merged_into=keep_mem_id）。
// 软隐藏的记忆 search/get* 不会再返回，但行、FTS5 索引、embedding 完整保留。
// 第 3 步专注帧机制可凭 mem_id 复活；merged_into 字段也保证可追溯合并去向。
export async function execMergeMemories(args = {}, context = {}) {
  const { keep_mem_id, drop_mem_ids, merged_content, merged_salience, reason } = args
  if (!keep_mem_id || !Array.isArray(drop_mem_ids) || drop_mem_ids.length === 0 || !merged_content) {
    return JSON.stringify({ ok: false, error: 'missing keep_mem_id / drop_mem_ids[] / merged_content' })
  }

  const keep = getMemoryByMemId(keep_mem_id)
  if (!keep) return JSON.stringify({ ok: false, error: `keep_mem_id not found: ${keep_mem_id}` })

  let mergedEntities = []
  try { mergedEntities = JSON.parse(keep.entities || '[]') } catch {}
  let maxSalience = keep.salience || 3
  const drops = []
  for (const dmid of drop_mem_ids) {
    if (dmid === keep_mem_id) continue
    const d = getMemoryByMemId(dmid)
    if (!d) continue
    drops.push(d)
    try {
      const de = JSON.parse(d.entities || '[]')
      mergedEntities = [...mergedEntities, ...de]
    } catch {}
    if ((d.salience || 3) > maxSalience) maxSalience = d.salience || 3
  }
  mergedEntities = [...new Set(mergedEntities)]

  const finalSalience = merged_salience !== undefined ? merged_salience : maxSalience

  upsertMemoryByMemId({
    mem_id: keep_mem_id,
    content: merged_content,
    entities: mergedEntities,
    salience: finalSalience,
  })

  const hiddenAt = new Date().toISOString()
  const hidden = []
  for (const d of drops) {
    if (hideMemoryByMemId(d.mem_id, { mergedInto: keep_mem_id, hiddenAt })) {
      hidden.push(d.mem_id)
    }
  }

  console.log(`[整合器] merge: keep=${keep_mem_id} hidden=[${hidden.join(',')}] merged_into=${keep_mem_id} salience=${finalSalience} reason="${reason || ''}"`)
  emitEvent('memory_consolidated', {
    action: 'merge',
    keep_mem_id,
    hidden,
    // 'dropped' 字段保留作为向后兼容（旧 UI / 日志消费者仍期望此键），
    // 但语义已从"已删除"变为"已软隐藏"——读者请以 'hidden' 为准。
    dropped: hidden,
    merged_into: keep_mem_id,
    salience: finalSalience,
    reason: reason || '',
  })

  return JSON.stringify({ ok: true, action: 'merge', keep_mem_id, hidden, dropped: hidden, merged_into: keep_mem_id, salience: finalSalience })
}

// downgrade_memory：整合器降低记忆的 salience（不删，保留信号）
export async function execDowngradeMemory(args = {}) {
  const { mem_id, new_salience, reason } = args
  if (!mem_id || new_salience === undefined) {
    return JSON.stringify({ ok: false, error: 'missing mem_id or new_salience' })
  }
  const before = getMemoryByMemId(mem_id)
  if (!before) return JSON.stringify({ ok: false, error: `mem_id not found: ${mem_id}` })
  upsertMemoryByMemId({ mem_id, salience: new_salience })
  console.log(`[整合器] downgrade: ${mem_id} ${before.salience || 3} → ${new_salience} reason="${reason || ''}"`)
  emitEvent('memory_consolidated', {
    action: 'downgrade',
    mem_id,
    before: before.salience || 3,
    after: new_salience,
    reason: reason || '',
  })
  return JSON.stringify({ ok: true, action: 'downgrade', mem_id, before: before.salience || 3, after: new_salience })
}

// skip_consolidation：整合器显式表示本批无需操作
export async function execSkipConsolidation({ reason } = {}) {
  return JSON.stringify({ ok: true, skipped: true, reason: reason || '' })
}

// probe_memory：诊断工具——"如果现在问 X，记忆库会拉到什么？"
// 与 search_memory / recall_memory 的区别：
//   - 无副作用：不设 state.prev_recall，不影响下一轮注入
//   - 输出更详细：双路命中（直接 FTS + 多关键词 FTS）+ 元信息（event_type / salience / mem_id）
//   - 用途：自检"召回是否健康"；用户问"你能想起 X 吗"时主动确认
// 当探测结果为空，提示"如果用户认为你应该记得，可能是召回漏或抽取漏"。
export async function execProbeMemory(args = {}) {
  const query = String(args.query || '').trim()
  if (!query) return JSON.stringify({ ok: false, error: 'missing query' })

  const directHits = searchMemories(query, 8)

  let keywordHits = []
  try {
    const kws = extractKeywords(query).slice(0, 6)
    if (kws.length > 0) {
      keywordHits = searchMemoriesByKeywords(kws, { limitPerKeyword: 3 })
    }
  } catch {}

  const seen = new Set()
  const merged = []
  for (const m of [...directHits, ...keywordHits]) {
    const key = m.mem_id || m.id
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({
      id: m.id,
      mem_id: m.mem_id || null,
      event_type: m.event_type || m.type || null,
      title: m.title || '',
      content: (m.content || '').slice(0, 200),
      salience: m.salience || null,
      timestamp: m.timestamp || m.created_at || null,
      matched_by: m.matched_by || null,
    })
  }

  return JSON.stringify({
    ok: true,
    query,
    total: merged.length,
    direct_count: directHits.length,
    keyword_count: keywordHits.length,
    hits: merged.slice(0, 10),
    hint: merged.length === 0
      ? '召回为空。可能原因：① 该信息从未被抽取（抽取漏）② 抽取了但 embedding/FTS 没命中此 query（召回漏）。可对照 conversations 表 + recall_audit 表交叉验证。'
      : null,
  }, null, 2)
}

export async function execRecallMemory({ query }, context) {
  if (!query?.trim()) return '错误：未提供查询内容'
  if (context?.onRecall) context.onRecall(query.trim())
  const rows = searchMemories(query.trim(), 8)
  if (rows.length === 0) return `记忆库中未找到与"${query}"相关的内容，已标记下轮持续关注此主题。`
  const results = rows.map(m =>
    `[${m.timestamp.slice(0, 10)}] ${m.event_type || m.type || ''}: ${m.content}\n  ${(m.detail || '').slice(0, 100)}`
  ).join('\n\n')
  return `已找到 ${rows.length} 条相关记忆（下轮将持续注入此主题）：\n\n${results}`
}
