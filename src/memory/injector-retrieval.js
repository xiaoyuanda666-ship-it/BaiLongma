// 注入器 · 检索/排序/选择层
//
// 从 injector.js 拆出的记忆检索逻辑：消息解析、FTS5 + 向量召回、重要性重排、
// 「少即是强」选择器、时间词轮廓召回、概念追加召回。
// runInjector 是编排者，本文件提供它调用的检索原语。

import { searchMemories, getMemoriesByDateRange } from '../db.js'
import { extractKeywords } from './keywords.js'
import { parseTemporalHints } from './temporal-parser.js'

// 旧导出路径兼容；解析实现只有一个真相源，避免外部渠道 canonicalId 规则再次漂移。
export { parseMessageInput } from './injector/message-input.js'

// 桶内重排：salience >= 4 的提到前面（按 salience 高到低），
// 同 boost 组内 timestamp 距今超过 365 天的下沉到该组末尾，
// 其余维持调用方传入的原顺序（JS Array.prototype.sort 在 ES2019+ 是 stable 的）
function rerankByImportance(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return memories
  const now = Date.now()
  const isStale = (m) => {
    const t = m.timestamp ? new Date(m.timestamp).getTime() : NaN
    if (!Number.isFinite(t)) return false
    return (now - t) / 86400000 > 365
  }
  const boostOf = (m) => {
    const s = Number(m.salience) || 0
    return s >= 4 ? s : 0
  }
  return [...memories].sort((a, b) => {
    const ba = boostOf(a), bb = boostOf(b)
    if (ba !== bb) return bb - ba          // 高 boost 在前
    const sa = isStale(a) ? 1 : 0, sb = isStale(b) ? 1 : 0
    if (sa !== sb) return sa - sb           // 同 boost 内陈旧（>365天）下沉
    return 0                                // 其余维持原顺序（stable sort）
  })
}

// 动态上下文记忆池 ·「少即是强」选择器（取代旧的 rerankByImportance(merged).slice(cap)）
//
// 旧逻辑的病灶：searchRelevantMemories 已按相关度排好序（focus FTS → 向量 → context FTS），
// senderMemories 接在其后；但随后 rerankByImportance 按 salience 把整列重排，会把"重要但跟
// 当前问题无关"的记忆（尤其 senderMemories 这种纯 entity 召回、对当前 query 零相关度的条目）
// 顶到 context 前排 → 掺杂不相关信息 → 上下文焦虑 → 输出质量下降。
//
// 新逻辑：
//   - 保留 candidates 既有的相关度序（不再按 salience 整体重排）。
//   - 只给高 salience 锚（≥4，如硬约束/身份）留一条窄保留道：cap 之外的锚最多救回 anchorLane 条，
//     替换掉 cap 内末尾（相关度最弱）的位置，确保常驻锚不被挤掉，但不喧宾夺主。
//   - ftsFloor：相关度地板（基于 db.searchMemories 带出的 bm25 _ftsScore，越小越相关；
//     丢弃 _ftsScore > ftsFloor 的弱命中，即使 cap 还有空位）。Phase 1 默认 null=关闭——
//     先用现有 recall_audit 回看相关度分布，再于 Phase 2 标定阈值开启。无分的候选（向量/LIKE
//     兜底/entity 召回）一律豁免地板。
export function selectContextMemories(candidates, { cap, anchorLane = 2, ftsFloor = null } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return []
  const floored = ftsFloor == null
    ? candidates
    : candidates.filter(m => !Number.isFinite(m?._ftsScore) || m._ftsScore <= ftsFloor)
  if (floored.length <= cap) return floored
  const inCap = floored.slice(0, cap)
  const overflow = floored.slice(cap)
  const anchors = overflow.filter(m => (Number(m?.salience) || 0) >= 4).slice(0, Math.max(0, anchorLane))
  if (anchors.length === 0) return inCap
  const keep = inCap.slice(0, Math.max(0, cap - anchors.length))
  return [...keep, ...anchors]
}

// 相关记忆搜索：双输入函数（focus + context） + 向量召回兜底
// focusText 是当前消息+任务+hint，享受优先权；contextText 是对话历史，作为补充
// 两路独立抽关键词、独立检索，focus 命中的记忆在前；contextText 的关键词排除已出现在 focus 关键词集合里的词
// focusText 为空时直接返回空数组，不用 contextText 兜底
// 注意：函数 async 是为了等向量召回；未配置 embedding 时整体行为退化为旧的 FTS5-only 同步路径
export async function searchRelevantMemories({
  focusText,
  contextText = '',
  focusLimit = 12,
  contextLimit = 8,
  focusKeywords = 8,
  contextKeywords = 10,
  perKeyword = 3,
}) {
  if (!focusText) return []

  const focusKws = extractKeywords(focusText, focusKeywords)
  if (focusKws.length === 0) return []

  const seen = new Set()
  const focusHits = []

  for (const keyword of focusKws) {
    const hits = searchMemories(keyword, perKeyword)
    for (const memory of hits) {
      if (!seen.has(memory.id)) {
        seen.add(memory.id)
        focusHits.push(memory)
      }
    }
    if (focusHits.length >= focusLimit) break
  }

  const focusHitsCapped = focusHits.slice(0, focusLimit)
  // 重置 seen，但先把 focus 命中放进去，避免 context 重复
  const seenAll = new Set(focusHitsCapped.map(m => m.id))
  const contextHits = []

  if (contextText && contextLimit > 0) {
    const focusKwSet = new Set(focusKws)
    const contextKwsRaw = extractKeywords(contextText, contextKeywords)
    const contextKws = contextKwsRaw.filter(kw => !focusKwSet.has(kw))
    const ctxPerKeyword = Math.max(1, perKeyword - 1)

    for (const keyword of contextKws) {
      const hits = searchMemories(keyword, ctxPerKeyword)
      for (const memory of hits) {
        if (!seenAll.has(memory.id)) {
          seenAll.add(memory.id)
          contextHits.push(memory)
        }
      }
      if (contextHits.length >= contextLimit) break
    }
  }

  const contextHitsCapped = contextHits.slice(0, contextLimit)

  // 向量召回兜底：focusText 算 embedding，找 FTS5 没召回到的 top-N 语义相似记忆，
  // 追加到 focus 桶末尾。失败/超时/未配置时静默跳过，行为完全等同 FTS5-only。
  // 注：硬超时挡在主 LLM 调用之前，慢一点都会被用户感知为"卡顿"。
  //     远程 provider 800ms（网络方差）；local 离线推理无网络方差但 CPU 慢，放宽到 ~1500ms，
  //     由 getEmbeddingTimeoutMs() 按 provider 返回。focusText 是 query，传 isQuery:true。
  let vecAppended = []
  try {
    const { computeEmbedding, isEmbeddingConfigured, getEmbeddingTimeoutMs } = await import('../embedding.js')
    if (isEmbeddingConfigured() && focusText) {
      const timeoutMs = getEmbeddingTimeoutMs()
      const queryEmb = await Promise.race([
        computeEmbedding(focusText, { isQuery: true }),
        new Promise(resolve => setTimeout(() => resolve(null), timeoutMs)),
      ])
      if (queryEmb) {
        const { searchByEmbedding } = await import('../db.js')
        const vecHits = searchByEmbedding(queryEmb, Math.min(focusLimit, 10))
        // 只追加未被 FTS5 命中过的（避免重复），且 _vecScore > 0.5 过滤掉明显无关的
        const existingIds = new Set([...focusHitsCapped, ...contextHitsCapped].map(m => m.id))
        vecAppended = vecHits.filter(m => !existingIds.has(m.id) && m._vecScore > 0.5)
      }
    }
  } catch {
    // 静默：embedding 模块导入失败、API 异常等都不影响 FTS5 兜底结果
  }

  const focusHitsRanked   = rerankByImportance(focusHitsCapped)
  const contextHitsRanked = rerankByImportance(contextHitsCapped)
  const vecRanked         = rerankByImportance(vecAppended)
  // 顺序：focus FTS5 → 向量补充 → context FTS5
  return [...focusHitsRanked, ...vecRanked, ...contextHitsRanked].slice(0, focusLimit + contextLimit)
}

export function deduplicateMemories(arrays) {
  const seen = new Set()
  const result = []
  for (const memory of arrays.flat()) {
    if (!memory || seen.has(memory.id)) continue
    seen.add(memory.id)
    result.push(memory)
  }
  return result
}

// 时间词触发的自动注入：把用户消息里的"昨天/前天/今天"映射成日期窗口，
// 在该窗口内拉 focus_conclusion（每帧 pop 时压成的 1-2 句话结论），
// 形成"听见昨天就立马想起几件事"的轮廓注入。
//
// 设计点：
//   - 上限 5 条 / 区间，按 salience desc + 时间正序排列
//   - 只在有 senderId 的用户消息上触发（TICK / agent 自言自语不触发）
//   - 召回为空就返回 null，整个 <temporal-recall> 块不出现
//   - 不注入对话原文，只注入压缩后的结论，控制注入量在 600 token 以内
//   - 多个时间词共存（"昨天和前天的事"）时，各自取 5 条然后合并去重
export function gatherTemporalRecall(messageBody) {
  if (!messageBody) return null
  const hints = parseTemporalHints(messageBody)
  if (hints.length === 0) return null

  const buckets = []
  const seenIds = new Set()
  for (const hint of hints) {
    const memories = getMemoriesByDateRange(hint.from, hint.to, {
      types: ['focus_conclusion'],
      limit: 5,
      orderBy: 'COALESCE(salience, 3) DESC, timestamp ASC',
    })
    // 去重：同一条记忆若被两个区间命中（理论上日期窗口不重叠不会发生），只算一次
    const filtered = memories.filter(m => {
      if (seenIds.has(m.id)) return false
      seenIds.add(m.id)
      return true
    })
    if (filtered.length === 0) continue
    buckets.push({
      label: hint.label,
      date: hint.from.slice(0, 10), // YYYY-MM-DD
      memories: filtered,
    })
  }
  if (buckets.length === 0) return null
  return buckets
}

// 根据涌现概念追加搜索记忆，排除已召回的记忆 ID
// concepts: string[]  - 概念列表（来自 concept-extractor.js 的输出）
// excludeIds: Set<number|string>  - 已召回记忆的 id 集合（避免重复）
// limit: number  - 最多返回多少条，默认 10
// returns: Memory[]  - 新增记忆对象数组（与 runInjector 返回的 memories 结构相同）
export function searchAdditionalMemories(concepts, excludeIds, limit = 10) {
  const seen = new Set()
  const results = []

  for (const concept of concepts) {
    const hits = searchMemories(concept, 3)
    for (const memory of hits) {
      if (excludeIds.has(memory.id)) continue
      if (seen.has(memory.id)) continue
      seen.add(memory.id)
      results.push(memory)
      if (results.length >= limit) return results
    }
  }

  return results
}
