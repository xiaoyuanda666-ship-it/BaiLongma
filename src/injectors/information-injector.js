// Information Injector
//
// 负责“此刻外部世界和运行环境是什么样”：约束、预取缓存、UI 信号、关键词规则、
// 面板状态、实时能力数据，以及任务执行前补采集的信息。
//
// 信息分两阶段收集：
//   1. runInformationInjector：与主记忆/工具注入并行的轻量信息。
//   2. runRuntimeInformationInjector：格式化记忆与任务知识就绪后，补齐运行时信息。

import {
  getActiveConstraints,
  getValidPrefetchCache,
} from '../db.js'
import {
  readInjectorUISignals,
  commitInjectorUISignals,
} from './information-signals.js'
import { gatherContext, formatExtraContext } from '../context/gatherer.js'
import { buildKeywordRuntimeContext } from '../context/keyword-context.js'
import { buildHotspotPanelStateContext } from '../hotspots.js'
import { buildWorldcupPanelStateContext } from '../worldcup.js'
import { buildPersonCardRuntimeContext, buildPersonCardPanelStateContext } from '../person-cards.js'
import { buildDocRuntimeContext, buildDocPanelStateContext, detectDocTopic } from '../docs.js'
import { runCapabilityPrefeed } from '../capabilities/capability-registry.js'
import { PRIMARY_USER_ID, formatPresenceForPrompt } from '../identity.js'
import { formatTerminalStreamContext } from '../terminal-stream.js'
import { sceneStore } from '../scene/scene-store.js'
import { getAIVideoPanelState } from '../capabilities/tools/media.js'
import { formatBrowserDownloadContext } from '../browser-download-context.js'
import {
  formatPrefetchedItems,
  formatSceneManifest,
  formatAIVideoPanel,
} from '../memory/injector-format.js'
import {
  commitScheduledInformationDeliveries,
  resolveInformationSubscriptions,
} from './information-subscription-engine.js'

export {
  registerInformationProvider,
  listInformationProviders,
} from './information-providers.js'

export async function runInformationInjector({
  message = '',
  userId = PRIMARY_USER_ID,
  isTick = false,
  signal = null,
  nowMs = Date.now(),
} = {}) {
  const { uiSignalIds, uiSignalSummary } = readInjectorUISignals(60_000)
  const subscribedInformation = await resolveInformationSubscriptions({
    message,
    userId,
    isTick,
    signal,
    nowMs,
  })
  return {
    constraints: getActiveConstraints(),
    prefetchedItems: getValidPrefetchCache(),
    uiSignalSummary,
    uiSignalIds,
    subscribedInformation,
    informationContextText: subscribedInformation.contextText,
    informationProviderIds: subscribedInformation.providerIds,
    scheduledSubscriptionIds: subscribedInformation.scheduledSubscriptionIds,
  }
}

export function commitInformationConsumption(information = {}) {
  const ui = commitInjectorUISignals(information.uiSignalIds || [])
  const scheduledSubscriptions = commitScheduledInformationDeliveries(
    information.scheduledSubscriptionIds || [],
  )
  return {
    committed: ui.committed,
    uiSignals: ui.committed,
    scheduledSubscriptions,
  }
}

export function buildSupplementalInformationContext({
  information = {},
  runtimeInformation = {},
  userId = PRIMARY_USER_ID,
} = {}) {
  const components = {
    presence: formatPresenceForPrompt(userId),
    runtime: runtimeInformation.contextText || '',
    terminal: formatTerminalStreamContext(),
    browserDownloads: formatBrowserDownloadContext(),
    prefetch: formatPrefetchedItems(information.prefetchedItems || []),
    uiSignals: information.uiSignalSummary || '',
    subscriptions: information.informationContextText || information.subscribedInformation?.contextText || '',
    scene: formatSceneManifest(sceneStore.manifest()),
    aiVideoPanel: formatAIVideoPanel(getAIVideoPanelState()),
  }
  return {
    components,
    contextText: Object.values(components).filter(Boolean).join('\n\n'),
  }
}

export async function runRuntimeInformationInjector({
  message = '',
  task = null,
  taskKnowledge = '',
  memories = '',
  fastUserPath = false,
  excludedInformationProviders = [],
  signal = null,
} = {}) {
  const text = String(message || '')

  const hotspotStateText = buildHotspotPanelStateContext()
  const worldcupStateText = buildWorldcupPanelStateContext()
  const personCardStateText = buildPersonCardPanelStateContext()
  const personCardContextText = buildPersonCardRuntimeContext(text)
  const detectedDocTopic = detectDocTopic(text)
  const docStateText = buildDocPanelStateContext(detectedDocTopic)
  const docContextText = buildDocRuntimeContext(text)

  const capCtx = { text: text.toLowerCase(), rawText: text }
  const gatherContextPromise = (task && !fastUserPath)
    ? gatherContext({ task, taskKnowledge, memories, message: text, signal })
    : Promise.resolve([])

  const [
    keywordContextText,
    capPrefeed,
    taskExtraContextItemsRaw,
  ] = await Promise.all([
    buildKeywordRuntimeContext(text, { excludedProviders: excludedInformationProviders }),
    runCapabilityPrefeed(capCtx),
    gatherContextPromise,
  ])

  const hotspotContextText = capPrefeed.byId.hotspot || ''
  const worldcupContextText = capPrefeed.byId.worldcup || ''
  const weatherContextText = capPrefeed.byId.weather || ''
  const typhoonContextText = capPrefeed.byId.typhoon || ''
  const macosMusicContextText = capPrefeed.byId['macos-system-music'] || ''
  const capabilityContextText = capPrefeed.text || ''
  const taskExtraContextItems = taskExtraContextItemsRaw || []
  const taskExtraContextText = taskExtraContextItems.length
    ? formatExtraContext(taskExtraContextItems)
    : ''

  const contextParts = [
    keywordContextText,
    hotspotStateText,
    worldcupStateText,
    personCardStateText,
    personCardContextText,
    capabilityContextText,
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
    typhoonContextText,
    macosMusicContextText,
    capabilityContextText,
    capabilityContextEntries: capPrefeed.entries || [],
    detectedDocTopic,
    docStateText,
    docContextText,
    taskExtraContextText,
    taskExtraContextItems,
    contextText: contextParts.join('\n\n'),
  }
}
