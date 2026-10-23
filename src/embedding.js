// Embedding module — 向量语义召回的"算 embedding"层。
//
// 设计：记忆向量召回只用本地离线模型（provider 恒为 'local'），不依赖任何云端 API。
// 真正的推理在 src/embedding-local.js（transformers.js + onnxruntime-node 跑 ONNX）。本模块只负责：
//   1. 完全 lazy init：模块加载时不做任何 IO / 推理
//   2. 任何错误都吞掉返回 null，让上层的 FTS5 召回继续工作，绝不影响主流程
//   3. 简易 LRU 缓存（Map 删除最旧项）— 不引入新依赖
//   4. 返回 Buffer（包裹 Float32Array 的字节），方便直接写入 SQLite BLOB
//
// 配置：embedding 块在 config.json 的 "embedding" 键下（仅 model / timeoutMs 有意义），
// 由 src/config.js 的 getEmbeddingCredentials 管理；缺省走本地默认模型，开箱即用零配置。

import crypto from 'crypto'
import { getEmbeddingCredentials } from './config.js'
import { isLocalEmbeddingReady } from './embedding-local.js'

const MAX_CACHE_ENTRIES = 200
const MIN_TEXT_LENGTH = 2
export const REALTIME_EMBEDDING_BUDGET_MS = 120

// LRU 缓存：key = sha256(text + '' + model + isQuery 标记)，value = Buffer
// 用 Map 的插入顺序近似 LRU：每次读到命中就 delete + set，让它移到尾部；
// 写入超限时删 Map.keys().next().value （最旧的 key）
function cacheKey(text, model) {
  return crypto
    .createHash('sha256')
    .update(text + '' + (model || ''))
    .digest('hex')
}

// 是否已配置 embedding。本地模型零配置：只要拿得到 model（默认或 config 指定）即视为已配置。
// 模型未下载完成 / 包未装等运行期失败由 computeEmbedding 内部吞错返回 null，上层走 FTS5 兜底。
export function isEmbeddingConfigured() {
  try {
    const cred = getEmbeddingCredentials()
    return !!(cred && cred.model)
  } catch {
    return false
  }
}

// 向量召回的有效超时（ms）。注入器拿它做硬超时预算。
// 本地离线推理无网络方差但 CPU 慢，默认 1500ms；用户可在 config 的 embedding.timeoutMs 覆盖。
export function getEmbeddingTimeoutMs({ fastUserPath = false } = {}) {
  let timeoutMs = 1500
  try {
    const cred = getEmbeddingCredentials()
    if (cred && Number.isFinite(cred.timeoutMs) && cred.timeoutMs > 0) timeoutMs = cred.timeoutMs
  } catch {}
  return fastUserPath ? Math.min(timeoutMs, REALTIME_EMBEDDING_BUDGET_MS) : timeoutMs
}

// A deadline limits this caller's wait, not shared local inference. A timed-out
// computation can still populate the cache and serve another caller.
export async function waitForEmbedding(embeddingPromise, timeoutMs) {
  let timeout
  try {
    return await Promise.race([
      Promise.resolve(embeddingPromise).then(
        embedding => ({ embedding, timedOut: false }),
        () => ({ embedding: null, timedOut: false }),
      ),
      new Promise(resolve => {
        timeout = setTimeout(() => resolve({ embedding: null, timedOut: true }), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

// Dependencies are explicit so concurrency, deadlines and late cache fills can
// be tested without loading an ONNX model or downloading assets.
export function createEmbeddingComputer({
  getCredentials = getEmbeddingCredentials,
  isReady = isLocalEmbeddingReady,
  computeLocal = async (input, options) => {
    const { computeLocalEmbedding } = await import('./embedding-local.js')
    return computeLocalEmbedding(input, options)
  },
  maxCacheEntries = MAX_CACHE_ENTRIES,
} = {}) {
  const cache = new Map()
  const inFlight = new Map()
  let generation = 0

  async function compute(text, { isQuery = false, readyOnly = false } = {}) {
    const input = typeof text === 'string' ? text : ''
    if (input.length < MIN_TEXT_LENGTH) return null
    let credentials
    try { credentials = getCredentials() } catch { return null }
    if (!credentials?.model) return null
    const key = cacheKey(input, credentials.model + (isQuery ? ':q' : ':p'))
    if (cache.has(key)) {
      const cached = cache.get(key)
      cache.delete(key)
      cache.set(key, cached)
      return cached
    }
    if (inFlight.has(key)) return inFlight.get(key)
    // Realtime callers must not trigger heavy module/model loading on the main
    // event loop. Startup warms the pipeline independently; lexical recall is
    // immediately usable until it is ready.
    if (readyOnly && !isReady(credentials.model)) return null
    const startedGeneration = generation
    const pending = Promise.resolve()
      .then(() => computeLocal(input, { model: credentials.model, isQuery }))
      .then(buffer => {
        if (buffer && generation === startedGeneration) {
          cache.set(key, buffer)
          while (cache.size > Math.max(1, maxCacheEntries)) cache.delete(cache.keys().next().value)
        }
        return buffer || null
      }, () => null)
      .finally(() => {
        if (inFlight.get(key) === pending) inFlight.delete(key)
      })
    inFlight.set(key, pending)
    return pending
  }
  return {
    computeEmbedding: compute,
    clearEmbeddingCache() { cache.clear(); generation++ },
  }
}

// Query/passage mode and model are part of the key. Concurrent identical
// requests share one inference; the successful result is retained in the LRU.
const computer = createEmbeddingComputer()
export const computeEmbedding = computer.computeEmbedding
export const clearEmbeddingCache = computer.clearEmbeddingCache
