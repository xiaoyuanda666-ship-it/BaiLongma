// Focus Stack —— 动态上下文记忆池架构第 3b 步（多帧栈 + 回归判断）
//
// 设计原则（来自 DynamicMemoryPool.md 3.1 ~ 3.5）：
//   - 「专注」是连续判断的副产品，不是事件触发的开关。
//   - 当焦点在某个话题上稳定一段时间 = 自然形成一帧；漂移 = 自然不再被选中 = 等于自动 pop。
//   - 用户和 Agent 都不主动声明「进入专注」。
//   - 子主题切换：push 新帧到栈顶；回到旧主题：pop 到对应帧（多帧 pop）。
//   - pop 出来的帧会进入压缩回填流水线（focus-compress.js），把那段时间的对话和工具调用压成
//     一句话结论，挂回到下一帧的 conclusions 列表，并沉淀到长期记忆。
//
// 不在本模块的职责：
//   - 持久化（栈是内存状态，不写 db）。
//   - 主动操作 memory visibility（剔除残留噪声）—— 第 3 步暂不做。
//   - LLM 调用（压缩回填在 focus-compress.js 里发起，本模块只产出 poppedFrames）。
//
// 注意：直接从 keywords.js 拿 extractKeywords，绕开 injector.js（避免拉起 SQLite）
// 这样 focus.js 可以在纯 Node 环境下被单元测试，不需要 better-sqlite3 native binding。
import { extractKeywords } from './keywords.js'
// v1 LLM 语义仲裁。仅在 v0 判 pushed/returned 时叫起来。
// 失败/超时返回 null → 回退 v0 结果。
import { classifyFocusEvent } from './focus-classifier.js'

// 焦点失活阈值：lastSeenTick 超过这么多 tick 没被命中就 pop 栈顶。
export const FOCUS_FRAME_STALE_TICKS = 20

// 栈深上限。push 第 N+1 帧时，shift 出栈底那帧（也触发压缩回填）。
export const MAX_FOCUS_DEPTH = 4

// 单帧 conclusions 数量上限（滚动丢最旧）。
export const FRAME_CONCLUSIONS_LIMIT = 5

// 关键词最低门槛：少于这个数说明消息太空泛，不参与焦点判断。
const MIN_KEYWORDS_FOR_FRAME = 3   // 严格大于 2 → 至少 3 个

// 单帧 topic 关键词数量上限。
const TOPIC_KEYWORDS_LIMIT = 3

// 抽取关键词时给到 extractKeywords 的预算（适度宽一点便于做交集）。
const KEYWORD_EXTRACT_BUDGET = 8

// 太短的消息直接跳过焦点判断（裸字符长度，含格式头）。
const MIN_MESSAGE_LENGTH = 4

// 短回应（关键词不足但 body 长度 ≥ 此值）视为对栈顶的承诺/确认，保留栈顶不丢。
const SHORT_RESPONSE_KEEP_THRESHOLD = 10

// 明显的一次性叶子查询：不该开启/切换专注帧。
// 只在生产 async 路径启用，避免测试/同步仲裁场景失去覆盖；同步路径仍交给 LLM 判 leaf。
const ONE_OFF_LEAF_RE = /天气|气温|温度|下雨|下雪|空气质量|AQI|几点|几号|星期几|汇率|股价|热搜|新闻|在吗|早上好|晚上好|谢谢|收到/i
const SUSTAINED_FOCUS_RE = /分析|优化|修复|实现|修改|设计|写|做|排查|调试|构建|部署|项目|代码|文件|机制|方案|测试|review|debug|fix|implement|build/i

function isLikelyOneOffLeaf(body) {
  const text = String(body || '').trim()
  if (!text) return false
  if (SUSTAINED_FOCUS_RE.test(text)) return false
  if (/^(hello|hi|hey|在吗|早上好|晚上好|谢谢|收到)$/i.test(text)) return true
  return text.length <= 40 && ONE_OFF_LEAF_RE.test(text)
}

// 判断当前输入是不是 TICK。复用 injector 的同源识别。
function isTickMessage(message) {
  return typeof message === 'string' && /^TICK\s/i.test(message.trim())
}

// 从消息里拨开 [ID:xxx] 时间戳 [渠道] 这层壳，拿到消息正文。
// 仅供 focus 用——若解析失败，回退到整条消息。
function stripMessageEnvelope(message) {
  if (!message) return ''
  if (isTickMessage(message)) return ''
  const m = message.match(/^\[[^\]]+\]\s*[\d\-T:+]+\s*\[[^\]]*\]\s*(.*)$/s)
  return m ? m[1].trim() : message.trim()
}

// 工厂：新建一帧。startedAt 走 ISO 时间戳，给压缩回填按时间拉对话用。
function makeFrame(topic, tickCounter) {
  return {
    topic,
    startedAtTick: tickCounter,
    lastSeenTick: tickCounter,
    hitCount: 1,
    startedAt: new Date().toISOString(),
    conclusions: [],
  }
}

// 取栈顶（数组最后一个），栈空返回 null。
function topOf(stack) {
  return stack && stack.length > 0 ? stack[stack.length - 1] : null
}

// 判断关键词与某帧 topic 是否有交集（≥1 命中）。
function frameOverlap(frame, kws) {
  if (!frame || !Array.isArray(frame.topic) || frame.topic.length === 0) return 0
  const set = new Set(frame.topic)
  let n = 0
  for (const k of kws) {
    if (set.has(k)) n++
  }
  return n
}

// async 模式专用：v0 在没拿到 LLM 结果之前直接按 pushed 或 returned 落地栈，
// 返回 { event, poppedFrames }（跟 updateFocusFrame 同款返回结构）。
// 提取出来是为了 async 路径在 fire LLM 之前就能 return 给上层。
function applyV0Pushed_or_Returned({ state, v0Event, v0Topic, v0ReturnedIndex, tickCounter }) {
  if (v0Event === 'returned') {
    const popped = state.focusStack.splice(v0ReturnedIndex + 1)
    const newTop = state.focusStack[v0ReturnedIndex]
    newTop.lastSeenTick = tickCounter
    newTop.hitCount += 1
    return { event: 'returned', poppedFrames: popped }
  }
  // pushed
  state.focusStack.push(makeFrame(v0Topic, tickCounter))
  const popped = []
  while (state.focusStack.length > MAX_FOCUS_DEPTH) {
    const shifted = state.focusStack.shift()
    if (shifted) popped.push(shifted)
  }
  return { event: 'pushed', poppedFrames: popped }
}

// 确保 state.focusStack 存在；向后兼容：如果旧 state.focusFrame 残留也清掉。
function ensureStack(state) {
  if (!Array.isArray(state.focusStack)) {
    state.focusStack = []
  }
  // 把旧的 focusFrame 引用清掉，避免两套状态不一致
  if ('focusFrame' in state) {
    delete state.focusFrame
  }
}

/**
 * 更新 focus stack。直接 mutate state.focusStack。
 *
 * 第 5b 步起变成 async：v0 判 pushed/returned 时同步等 LLM 仲裁（800ms 硬超时）。
 * v0 判 created/kept/cleared/noop 走纯 ngram 启发式，零网络延迟。
 *
 * 第 6a 步：新增 classifierMode='async' —— v0 先同步建帧，LLM 仲裁 fire-and-forget
 * 在后台跑，拿到 refined topic 后回调 onClassifierRefined 让上层把改动 mutate 进帧 + 保存。
 * 这样实时用户消息也能享受 LLM 语义化 topic，且零延迟。
 *
 * @param {object} state          — 进程级 state 对象（必须可写）
 * @param {string} message        — 当前 process 拿到的裸消息字符串
 * @param {object} ctx
 * @param {boolean} ctx.isTick    — 当前是不是 TICK 心跳
 * @param {number}  ctx.tickCounter — 当前 tickCounter（用作帧的时间轴）
 * @param {boolean} [ctx.classifierEnabled=true] — 是否启用 v1 LLM 仲裁
 * @param {'sync'|'async'} [ctx.classifierMode='sync'] — sync = 阻塞等仲裁；async = fire-and-forget 后台仲裁
 * @param {function} [ctx.onClassifierRefined] — async 模式下 LLM 返回后的回调：
 *   ({ frameRef, llmResult, v0Event }) => void。frameRef 是栈里的帧对象引用（已被 v0 创建/选中）。
 *   上层可在这里把 refined topic 写进 frameRef.topic 并触发持久化。
 * @param {AbortSignal} [ctx.signal] — 上层 abort 信号
 * @param {function} [ctx.classifierFn] — 注入用 stub（测试用）；默认走 classifyFocusEvent
 * @returns {Promise<{
 *   event: 'created' | 'kept' | 'pushed' | 'returned' | 'cleared' | 'noop',
 *   poppedFrames: object[]
 * }>}
 *
 * 事件语义：
 *   - created  ：栈空，新建第一帧
 *   - kept     ：命中栈顶 topic，保持栈顶（更新 lastSeenTick / hitCount）
 *   - pushed   ：与栈中所有帧都无交集，push 新帧（子主题深化）
 *   - returned ：与栈中某个非栈顶帧有交集，pop 到那一帧（回归主线）
 *   - cleared  ：栈顶 idle 超过 FOCUS_FRAME_STALE_TICKS，pop 栈顶
 *   - noop     ：栈无变化（TICK 心跳、空消息、关键词太少、LLM 改判 leaf 等）
 *
 * poppedFrames：本次操作中被 pop / shift 出栈的帧（栈底先出，栈顶后出），
 *   传给上层做压缩回填。stale clear 也算进去。
 */
export async function updateFocusFrame(state, message, {
  isTick = false,
  tickCounter = 0,
  classifierEnabled = true,
  classifierMode = 'sync',
  onClassifierRefined,
  signal,
  classifierFn,
} = {}) {
  if (!state) return { event: 'noop', poppedFrames: [] }
  ensureStack(state)

  // TICK：叶子心跳不该影响焦点。但可以触发 stale 清理。
  if (isTick) {
    return maybeClearStale(state, tickCounter)
  }

  // 太短 / 空消息：不动
  const body = stripMessageEnvelope(message)
  if (!body || body.length < MIN_MESSAGE_LENGTH) {
    return maybeClearStale(state, tickCounter)
  }

  if (classifierEnabled && classifierMode === 'async' && isLikelyOneOffLeaf(body)) {
    return { event: 'noop', poppedFrames: [] }
  }

  // 抽关键词
  const kws = extractKeywords(body, KEYWORD_EXTRACT_BUDGET)
  // 关键词太少（≤2）= 太空泛，原则上不动
  if (kws.length < MIN_KEYWORDS_FOR_FRAME) {
    const top = topOf(state.focusStack)
    // 短回应带语境（>=阈值）通常是对栈顶的承诺/确认，不应丢栈
    if (top && body.length >= SHORT_RESPONSE_KEEP_THRESHOLD) {
      top.lastSeenTick = tickCounter
      top.hitCount += 1
      return { event: 'kept', poppedFrames: [] }
    }
    return maybeClearStale(state, tickCounter)
  }

  // 栈空 → 创建第一帧（v0 直接采用，不调 LLM）
  if (state.focusStack.length === 0) {
    state.focusStack.push(makeFrame(kws.slice(0, TOPIC_KEYWORDS_LIMIT), tickCounter))
    return { event: 'created', poppedFrames: [] }
  }

  // 已有帧：先看栈顶（v0 判 kept，直接采用，不调 LLM）
  const top = topOf(state.focusStack)
  if (frameOverlap(top, kws) >= 1) {
    top.lastSeenTick = tickCounter
    top.hitCount += 1
    return { event: 'kept', poppedFrames: [] }
  }

  // —— 到这里 v0 要么判 returned，要么判 pushed —— //
  // 这两种情况会改变栈结构，叫起 v1 LLM 仲裁 + 重写 topic。

  // v0 启发式找回归帧（returned 候选）
  let v0ReturnedIndex = -1
  for (let i = state.focusStack.length - 2; i >= 0; i--) {
    if (frameOverlap(state.focusStack[i], kws) >= 1) {
      v0ReturnedIndex = i
      break
    }
  }

  const v0Event = v0ReturnedIndex >= 0 ? 'returned' : 'pushed'
  const v0Topic = kws.slice(0, TOPIC_KEYWORDS_LIMIT)

  // ===== async 模式：v0 立刻建帧 + LLM 后台仲裁 + 拿到结果后 patch 帧 topic =====
  // 这条路径专为 fastUserPath 实时聊天用：零延迟，下一轮 buildContextBlock 看到 refined topic。
  if (classifierEnabled && classifierMode === 'async') {
    const priorTopRef = topOf(state.focusStack)
    const result = applyV0Pushed_or_Returned({
      state,
      v0Event,
      v0Topic,
      v0ReturnedIndex,
      tickCounter,
    })
    // 拿到 v0 刚创建/复用的栈顶帧引用 —— LLM 回来后 patch 它的 topic
    const frameRef = topOf(state.focusStack)
    // fire-and-forget LLM 仲裁
    const fn = classifierFn || classifyFocusEvent
    // 给 LLM 看仲裁前的栈快照（深拷贝 topic 数组，避免后续 mutate 污染）
    const stackSnapshot = state.focusStack.map(f => ({
      topic: Array.isArray(f.topic) ? [...f.topic] : [],
      conclusions: Array.isArray(f.conclusions) ? f.conclusions.slice(-1) : [],
    }))
    ;(async () => {
      let llm = null
      try {
        llm = await fn({
          newMessage: body,
          v0Event,
          v0Topic,
          currentStack: stackSnapshot,
          signal,
        })
      } catch (e) {
        console.log(`[focus-classifier] async LLM 抛错: ${e?.message || 'unknown'} → 保留 v0 topic`)
        llm = null
      }
      if (!llm) return
      // 帧可能已经被后续轮次 pop 出栈了 —— 检查引用是否还在
      const stillInStack = (state.focusStack || []).indexOf(frameRef) >= 0
      if (!stillInStack) {
        console.log('[focus-classifier] async LLM 返回但帧已出栈 → 丢弃 refined topic')
        return
      }

      // 简单误 push 可以安全回滚：没有挤出旧帧、刚 push 的帧仍是栈顶。
      // returned / overflow 涉及 poppedFrames 与压缩回填，暂不事后重排结构。
      const canUndoSimplePush =
        v0Event === 'pushed' &&
        result.poppedFrames.length === 0 &&
        topOf(state.focusStack) === frameRef
      if (canUndoSimplePush && llm.action === 'leaf') {
        state.focusStack.pop()
        console.log('[focus-classifier] async rollback pushed→leaf: removed one-off focus frame')
        if (typeof onClassifierRefined === 'function') {
          try {
            onClassifierRefined({ frameRef, llmResult: llm, v0Event, correction: 'removed_leaf_frame' })
          } catch (e) {
            console.log(`[focus-classifier] onClassifierRefined 回调抛错: ${e?.message || 'unknown'}`)
          }
        }
        return
      }
      if (canUndoSimplePush && llm.action === 'kept' && priorTopRef && state.focusStack.includes(priorTopRef)) {
        state.focusStack.pop()
        priorTopRef.lastSeenTick = tickCounter
        priorTopRef.hitCount += 1
        console.log('[focus-classifier] async rollback pushed→kept: restored previous top frame')
        if (typeof onClassifierRefined === 'function') {
          try {
            onClassifierRefined({ frameRef: priorTopRef, llmResult: llm, v0Event, correction: 'restored_kept_frame' })
          } catch (e) {
            console.log(`[focus-classifier] onClassifierRefined 回调抛错: ${e?.message || 'unknown'}`)
          }
        }
        return
      }

      // 只在 LLM 给的 action 跟 v0 结构动作一致时才回填 topic。
      // 除上方「简单 pushed→leaf/kept」安全回滚外，其余结构改判不事后重排，避免和压缩回填竞态。
      if (llm.action !== v0Event) {
        console.log(`[focus-classifier] async LLM 改判 ${v0Event}→${llm.action}，async 模式不改栈结构，但仍回填 topic 以反映语义`)
      }
      if (Array.isArray(llm.topic) && llm.topic.length > 0) {
        const oldTopic = Array.isArray(frameRef.topic) ? frameRef.topic.join(',') : ''
        frameRef.topic = llm.topic.slice(0, TOPIC_KEYWORDS_LIMIT)
        console.log(`[focus-classifier] async patch frame.topic: [${oldTopic}] → [${frameRef.topic.join(',')}]`)
        if (typeof onClassifierRefined === 'function') {
          try {
            onClassifierRefined({ frameRef, llmResult: llm, v0Event })
          } catch (e) {
            console.log(`[focus-classifier] onClassifierRefined 回调抛错: ${e?.message || 'unknown'}`)
          }
        }
      }
    })().catch(() => {})

    return result
  }

  // ===== sync 模式：阻塞等 LLM 仲裁（800ms 超时）。失败/超时/抛错都回退 v0。 =====
  let llmResult = null
  if (classifierEnabled) {
    const fn = classifierFn || classifyFocusEvent
    try {
      llmResult = await fn({
        newMessage: body,
        v0Event,
        v0Topic,
        currentStack: state.focusStack,
        signal,
      })
    } catch {
      llmResult = null
    }
  }

  // 解析 LLM 结果并决定最终动作
  const finalAction = llmResult?.action || v0Event
  const finalTopic = (Array.isArray(llmResult?.topic) && llmResult.topic.length > 0)
    ? llmResult.topic
    : v0Topic

  if (finalAction === 'kept') {
    // LLM 改判为 kept → 跟栈顶深化（即便 v0 没认出来）
    top.lastSeenTick = tickCounter
    top.hitCount += 1
    return { event: 'kept', poppedFrames: [] }
  }

  if (finalAction === 'leaf') {
    // LLM 判这是一次性短问 → 不动栈，返回 noop
    return { event: 'noop', poppedFrames: [] }
  }

  if (finalAction === 'returned') {
    // 决定 pop 到哪一层：优先用 LLM 给的深度，否则用 v0
    let depth = v0ReturnedIndex
    if (llmResult && llmResult.returnsToDepth >= 0 && llmResult.returnsToDepth < state.focusStack.length) {
      depth = llmResult.returnsToDepth
    }
    if (depth < 0 || depth >= state.focusStack.length - 1) {
      // 没有有效深度 → 退化为 pushed
      const newFrame = makeFrame(finalTopic, tickCounter)
      state.focusStack.push(newFrame)
      const popped = []
      while (state.focusStack.length > MAX_FOCUS_DEPTH) {
        const shifted = state.focusStack.shift()
        if (shifted) popped.push(shifted)
      }
      return { event: 'pushed', poppedFrames: popped }
    }
    const popped = state.focusStack.splice(depth + 1)
    const newTop = state.focusStack[depth]
    newTop.lastSeenTick = tickCounter
    newTop.hitCount += 1
    // LLM 若给了新 topic 且与原 topic 重合，可以扩展旧帧 topic —— 但为了稳健起见
    // 这里不改旧帧 topic（保留旧帧的语义身份），只更新命中计数和时间戳。
    return { event: 'returned', poppedFrames: popped }
  }

  // finalAction === 'pushed'（默认）
  const newFrame = makeFrame(finalTopic, tickCounter)
  state.focusStack.push(newFrame)

  // 栈深超限 → shift 栈底
  const poppedFrames = []
  while (state.focusStack.length > MAX_FOCUS_DEPTH) {
    const shifted = state.focusStack.shift()
    if (shifted) poppedFrames.push(shifted)
  }
  return { event: 'pushed', poppedFrames }
}

// 帧失活：太久没被命中就 pop 栈顶。栈非空时连锁 pop 栈顶（一次只 pop 一个，多 tick 多次 pop）。
function maybeClearStale(state, tickCounter) {
  ensureStack(state)
  const top = topOf(state.focusStack)
  if (!top) return { event: 'noop', poppedFrames: [] }
  const idle = tickCounter - top.lastSeenTick
  if (idle > FOCUS_FRAME_STALE_TICKS) {
    state.focusStack.pop()
    return { event: 'cleared', poppedFrames: [top] }
  }
  return { event: 'noop', poppedFrames: [] }
}

// 把 focusFrame 翻译成「人话」age 描述，供 <focus> 段用
export function describeFocusFrameAge(focusFrame, tickCounter = 0) {
  if (!focusFrame) return ''
  const since = Math.max(0, tickCounter - focusFrame.startedAtTick)
  const idle = Math.max(0, tickCounter - focusFrame.lastSeenTick)
  if (focusFrame.hitCount <= 1) {
    return 'just started focusing on this'
  }
  if (idle === 0) {
    return `${since} rounds since first seen, last seen this round`
  }
  return `${since} rounds since first seen, last seen ${idle} rounds ago`
}

// 便捷读取：取当前栈顶帧（向后兼容旧调用点）
export function getFocusFrame(state) {
  if (!state) return null
  return topOf(state.focusStack)
}
