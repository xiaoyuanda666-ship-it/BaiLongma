import { gatherContext, formatExtraContext } from './gatherer.js'
import { buildKeywordRuntimeContext } from './keyword-context.js'
// 注：hotspot/worldcup/weather 的「数据预喂」(buildXxxRuntimeContext) 已迁入能力注册表的
//   prefeed，经 runCapabilityPrefeed 统一驱动。这里仍保留两个「面板开关态」上下文
//   (buildXxxPanelStateContext)——它们是面板状态而非能力数据，未迁。
import { buildHotspotPanelStateContext } from '../hotspots.js'
import { buildWorldcupPanelStateContext } from '../worldcup.js'
import { buildPersonCardRuntimeContext, buildPersonCardPanelStateContext } from '../person-cards.js'
import { buildDocRuntimeContext, buildDocPanelStateContext, detectDocTopic } from '../docs.js'
import { runCapabilityPrefeed } from '../capabilities/capability-registry.js'

export async function runRuntimeInjector({
  message = '',
  task = null,
  taskKnowledge = '',
  memories = '',
  fastUserPath = false,
  signal = null,
} = {}) {
  const text = String(message || '')

  // 同步派生（无 await，无 IO，直接算）—— 放最前面让后面的 await 期间这些已就绪
  const hotspotStateText = buildHotspotPanelStateContext()
  const worldcupStateText = buildWorldcupPanelStateContext()
  const personCardStateText = buildPersonCardPanelStateContext()
  const personCardContextText = buildPersonCardRuntimeContext(text)
  const detectedDocTopic = detectDocTopic(text)
  const docStateText = buildDocPanelStateContext(detectedDocTopic)
  const docContextText = buildDocRuntimeContext(text)

  // Wave 1 优化：异步 await 全部并发跑。
  //   原实现多个 await 串行 = 累加耗时；改 Promise.all 后 = max(各自耗时)。
  //   runCapabilityPrefeed 并发跑各能力的 prefeed（hotspot/worldcup/weather 数据预喂，
  //     各自 self-gate：非相关消息瞬返空；weather 命中才触发一次实际抓取）。
  //   gatherContext 仍然只在 task && !fastUserPath 时跑（Wave 3 会换启发式）。
  const capCtx = { text: text.toLowerCase(), rawText: text }
  const gatherContextPromise = (task && !fastUserPath)
    ? gatherContext({ task, taskKnowledge, memories, message: text, signal })
    : Promise.resolve([])

  const [
    keywordContextText,
    capPrefeed,
    taskExtraContextItemsRaw,
  ] = await Promise.all([
    buildKeywordRuntimeContext(text),
    runCapabilityPrefeed(capCtx),
    gatherContextPromise,
  ])

  // 能力预喂结果按 id 取出，保持原 contextText 顺序与返回字段形状。
  const hotspotContextText = capPrefeed.byId.hotspot || ''
  const worldcupContextText = capPrefeed.byId.worldcup || ''
  const weatherContextText = capPrefeed.byId.weather || ''
  const macosMusicContextText = capPrefeed.byId['macos-system-music'] || ''

  const taskExtraContextItems = taskExtraContextItemsRaw || []
  const taskExtraContextText = taskExtraContextItems.length
    ? formatExtraContext(taskExtraContextItems)
    : ''

  const contextParts = [
    keywordContextText,
    hotspotStateText,
    hotspotContextText,
    worldcupStateText,
    worldcupContextText,
    personCardStateText,
    personCardContextText,
    weatherContextText,
    macosMusicContextText,
    docStateText,
    docContextText,
    taskExtraContextText,
  ].filter(Boolean)

  return {
    keywordContextText,
    hotspotStateText,
    hotspotContextText,
    worldcupStateText,
    worldcupContextText,
    personCardStateText,
    personCardContextText,
    weatherContextText,
    macosMusicContextText,
    detectedDocTopic,
    docStateText,
    docContextText,
    taskExtraContextText,
    taskExtraContextItems,
    contextText: contextParts.join('\n\n'),
  }
}
