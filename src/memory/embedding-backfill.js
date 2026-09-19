// Embedding backfill — 一次性回填存量记忆的 embedding。
//
// 背景：
//   recognizer.js 已经在写入新记忆时 fire-and-forget 算 embedding，
//   但存量记忆全是 embedding=NULL。本模块提供一个显式触发的回填流程，
//   由 UI / REST 端点显式驱动（不自动绑定到启动）。
//
// 设计要点：
//   1. 模块级 state 单例，防并发（同时只跑一份）
//   2. 所有依赖（db / embedding）都用动态 import，模块加载不做任何 IO
//   3. 单条失败不拖垮整批（try/catch 吞错并计 failed++）
//   4. 节流：每条之间 setTimeout，避免打爆 embedding API
//   5. 支持 cancel：通过 state.abortRequested 或外部 AbortSignal
//   6. finally 中重置 running，保证状态干净

const state = {
  running: false,
  total: 0,
  processed: 0,
  failed: 0,
  startedAt: null,
  finishedAt: null,
  lastError: null,
  abortRequested: false,
}

export function getBackfillStatus() {
  // 返回 spread 副本，避免外部直接改 state
  return { ...state }
}

export function cancelBackfill() {
  state.abortRequested = true
}

// force=true：全量重算所有可见记忆的 embedding（用于切换嵌入模型后，把旧维度向量刷成新维度）。
// force=false（默认）：只补 embedding IS NULL 的存量记忆。
export async function runBackfill({ batchSize = 20, throttleMs = 100, force = false, signal, onProgress } = {}) {
  // 防并发：已在跑就直接返回
  if (state.running) {
    return { skipped: true, reason: 'already running' }
  }

  // 配置自检：未配置 embedding 直接跳过
  let isEmbeddingConfigured
  try {
    ({ isEmbeddingConfigured } = await import('../embedding.js'))
  } catch (err) {
    return { error: `import embedding module failed: ${err.message}` }
  }
  if (!isEmbeddingConfigured()) {
    return { skipped: true, reason: 'embedding not configured' }
  }

  // 标记 running 并重置统计
  state.running = true
  state.total = 0
  state.processed = 0
  state.failed = 0
  state.startedAt = Date.now()
  state.finishedAt = null
  state.lastError = null
  state.abortRequested = false

  try {
    const { computeEmbedding } = await import('../embedding.js')
    const { getDB, updateMemoryEmbedding } = await import('../db.js')
    // 当前嵌入模型名，落到 embedding_model 列，便于排查 / 后续判断哪些行需重算
    let currentModel = null
    try {
      const { getEmbeddingCredentials } = await import('../config.js')
      currentModel = getEmbeddingCredentials()?.model || null
    } catch {}

    let rows
    try {
      const db = getDB()
      // 不给已软隐藏（visibility=0）的记忆补 embedding：节省算力，
      // 隐藏意味着这条不再参与召回，连 embedding 都不必算。
      // force：重算全部可见记忆（含已有 embedding 的，用于切模型后刷新维度）；否则只补 NULL。
      const nullClause = force ? '' : 'embedding IS NULL AND '
      rows = db.prepare(
        `SELECT id, mem_id, title, content FROM memories WHERE ${nullClause}content IS NOT NULL AND TRIM(content) != '' AND visibility = 1`
      ).all()
    } catch (err) {
      state.lastError = err.message
      return { error: `db prepare/query failed: ${err.message}` }
    }

    state.total = rows.length

    for (const m of rows) {
      if (signal?.aborted || state.abortRequested) break

      const text = [m.title, m.content].filter(Boolean).join(' ')
      let emb = null
      try {
        emb = await computeEmbedding(text)
      } catch (err) {
        // computeEmbedding 内部已吞错返回 null，这里是双保险
        state.lastError = err.message
        state.failed++
        // 继续下一条
        try { onProgress?.({ done: state.processed + state.failed, total: state.total, currentMemId: m.mem_id }) } catch {}
        if (throttleMs > 0) await new Promise(r => setTimeout(r, throttleMs))
        continue
      }

      if (emb) {
        try {
          updateMemoryEmbedding(m.mem_id, emb, currentModel)
          state.processed++
        } catch (err) {
          state.lastError = err.message
          state.failed++
        }
      } else {
        // API 失败/未配置/文本太短 → emb 为 null
        state.failed++
      }

      try { onProgress?.({ done: state.processed + state.failed, total: state.total, currentMemId: m.mem_id }) } catch {}

      if (throttleMs > 0) await new Promise(r => setTimeout(r, throttleMs))
    }

    return {
      processed: state.processed,
      failed: state.failed,
      total: state.total,
      aborted: state.abortRequested || !!signal?.aborted,
    }
  } catch (err) {
    state.lastError = err.message
    return { error: err.message }
  } finally {
    state.running = false
    state.finishedAt = Date.now()
  }
}
