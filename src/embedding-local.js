// 本地嵌入引擎 — provider === 'local' 时的离线推理后端。
//
// 设计目标（与 src/embedding.js 的契约一致）：
//   1. 完全 lazy：模块加载不做任何 IO / 下载。首次 computeLocalEmbedding 才建 pipeline。
//   2. 单例：pipeline 只建一次，缓存为模块级 Promise，并发首调共享同一份。
//   3. 全吞错：加载失败 / 下载失败 / 推理异常一律返回 null，让上层走 FTS5 兜底。
//      失败时把单例 Promise 置回 null，让下次调用有机会重试（如临时离线后恢复）。
//   4. 返回 Buffer（包裹 Float32Array 字节），与远程分支一致，可直接写 SQLite BLOB。
//
// 技术栈：@huggingface/transformers（transformers.js v3）+ onnxruntime-node CPU 后端。
//        onnxruntime-node 发预编译二进制（N-API，ABI 稳定），无需 @electron/rebuild，
//        但其原生 .node/.dll 必须进 package.json 的 asarUnpack 才能在打包后被加载。
// 模型：Xenova/bge-large-zh-v1.5（1024 维，q8 量化 ~330MB），首次运行下载到 paths.modelsDir，
//      之后命中本地缓存离线可用。
//
// bge 非对称检索：query 需加指令前缀，passage（入库文本）不加。pooling 用 CLS（bge 官方推荐），
//                 不是 mean——这点用 mean 会明显掉点。

import { paths } from './paths.js'

// bge 中文检索指令前缀：只加在 query 上（isQuery=true），passage 不加。
const BGE_QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'

// 单例：feature-extraction pipeline 的 Promise。null 表示尚未初始化或上次失败需重试。
let _pipelinePromise = null
// 记录已初始化的模型名，model 变了（用户切到别的 local 模型）就重建。
let _loadedModel = null
let _readyModel = null

export function isLocalEmbeddingReady(model) {
  return !!model && _readyModel === model
}

// 懒加载并缓存 pipeline。任何失败抛出，由调用方 catch 后置 null 重试。
async function getPipeline(model) {
  if (_pipelinePromise && _loadedModel === model) return _pipelinePromise

  _loadedModel = model
  _readyModel = null
  const pending = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers')
    // 模型缓存目录指到 userData/data/models（可写），首次下载落这里，之后离线命中。
    env.allowRemoteModels = true          // 首次需联网下载；命中本地缓存后无网也能用
    env.cacheDir = paths.modelsDir
    // 下载源：默认 huggingface.co 在中国大陆通常不可达，改用 hf-mirror.com 镜像。
    // 可用环境变量 HF_ENDPOINT 覆盖（标准 HF 镜像配置方式）。remoteHost 必须以 / 结尾，
    // 因为 transformers.js 用 remoteHost + remotePathTemplate 直接字符串拼接 URL。
    const hfHost = process.env.HF_ENDPOINT || 'https://hf-mirror.com'
    env.remoteHost = hfHost.endsWith('/') ? hfHost : hfHost + '/'
    // 后端：transformers.js 的 Node 构建只支持 'cpu'(onnxruntime-node) / 'dml'，没有 'wasm'
    //（wasm 仅浏览器构建）。用 'cpu' 走 onnxruntime-node 原生推理；它发预编译二进制(N-API,
    // ABI 稳定)，无需 @electron/rebuild，但原生 .node/.dll 必须进 asarUnpack 才能被 dlopen。
    return pipeline('feature-extraction', model, { dtype: 'q8', device: 'cpu' })
  })()
  _pipelinePromise = pending
  pending.then(() => {
    if (_pipelinePromise === pending) _readyModel = model
  }, () => {})

  // 失败时清空单例，让下次调用重试（不要把 rejected 的 Promise 永久缓存）
  pending.catch(() => {
    // A failed load for an old model must not discard a newer model's pipeline.
    if (_pipelinePromise === pending) {
      _pipelinePromise = null
      _loadedModel = null
      _readyModel = null
    }
  })

  return pending
}

// 把 Float32Array 转成 Buffer（共享底层 ArrayBuffer，不复制）
function f32ToBuffer(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

// 主接口：本地算 embedding。
// - model：HF 仓库 id（如 'Xenova/bge-large-zh-v1.5'）
// - isQuery：true 时给 bge 加检索指令前缀（仅 bge 系模型）
// 返回 Buffer 或 null（任何失败）。
export async function computeLocalEmbedding(text, { model, isQuery = false } = {}) {
  const input = typeof text === 'string' ? text.trim() : ''
  if (!input || !model) return null

  try {
    const extractor = await getPipeline(model)
    // 仅 bge 系模型套用中文检索指令前缀；其他本地模型不加，避免污染语义。
    const prepared = isQuery && /bge/i.test(model) ? BGE_QUERY_PREFIX + input : input
    // bge 官方用 CLS pooling + L2 normalize。
    const output = await extractor(prepared, { pooling: 'cls', normalize: true })
    const data = output?.data
    if (!data || data.length === 0) return null
    // output.data 已是 Float32Array；复制一份独立 buffer，避免底层张量被复用/释放影响。
    const f32 = data instanceof Float32Array ? new Float32Array(data) : Float32Array.from(data)
    return f32ToBuffer(f32)
  } catch {
    // 加载 / 下载 / 推理任何异常：静默返回 null，让上层走 FTS5 兜底。
    return null
  }
}

// 后台预热：模型冷启动（含首次 330MB 下载）很慢，会撞穿注入器的向量召回超时。
// 启动期 fire-and-forget 调一次，把 pipeline 提前建好，之后召回都在超时预算内。
// 返回 true=预热成功，false=失败（不抛错）。
export async function warmupLocalEmbedding(model) {
  if (!model) return false
  const buf = await computeLocalEmbedding('预热', { model, isQuery: false })
  return !!buf
}
