import {
  getUnconsumedUISignals,
  markUISignalsConsumed,
} from '../db.js'
import { summarizeUISignals } from '../memory/injector-format.js'
import { logWarn } from '../runtime/error-logger.js'

// 读取和确认分成两步：只有本轮上下文真正送进模型后才确认消费，避免注入链中途失败时
// 把 UI 信号永久吞掉。
export function readInjectorUISignals(maxAgeMs = 60_000) {
  let uiSignals = []
  let uiSignalSummary = ''

  try {
    uiSignals = getUnconsumedUISignals(maxAgeMs)
    uiSignalSummary = summarizeUISignals(uiSignals)
  } catch (err) {
    logWarn(err, {
      scope: 'information.injector',
      operation: 'read_ui_signals',
      metadata: { maxAgeMs },
    })
  }

  return {
    uiSignals,
    uiSignalIds: uiSignals.map(signal => signal.id).filter(id => id !== null && id !== undefined),
    uiSignalSummary,
  }
}

export function commitInjectorUISignals(ids = []) {
  const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).filter(id => id !== null && id !== undefined))]
  if (uniqueIds.length === 0) return { committed: 0 }
  try {
    markUISignalsConsumed(uniqueIds)
    return { committed: uniqueIds.length }
  } catch (err) {
    logWarn(err, {
      scope: 'information.injector',
      operation: 'commit_ui_signals',
      metadata: { signalCount: uniqueIds.length },
    })
    return { committed: 0 }
  }
}
