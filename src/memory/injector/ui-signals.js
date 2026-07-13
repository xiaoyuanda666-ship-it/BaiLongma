import {
  getUnconsumedUISignals,
  markUISignalsConsumed,
} from '../../db.js'
import { getActiveUICards } from '../../events.js'
import { summarizeUISignals } from '../injector-format.js'
import { logWarn } from '../../runtime/error-logger.js'

export function consumeInjectorUISignals(maxAgeMs = 60_000) {
  let uiSignals = []
  let uiSignalSummary = ''
  let activeUICards = []

  try {
    uiSignals = getUnconsumedUISignals(maxAgeMs)
    uiSignalSummary = summarizeUISignals(uiSignals)
  } catch (err) {
    logWarn(err, {
      scope: 'memory.injector',
      operation: 'read_ui_signals',
      metadata: { maxAgeMs },
    })
  }

  if (uiSignals.length) {
    try {
      markUISignalsConsumed(uiSignals.map(s => s.id))
    } catch (err) {
      logWarn(err, {
        scope: 'memory.injector',
        operation: 'mark_ui_signals_consumed',
        metadata: { signalCount: uiSignals.length },
      })
    }
  }

  try {
    activeUICards = getActiveUICards()
  } catch (err) {
    logWarn(err, {
      scope: 'memory.injector',
      operation: 'read_active_ui_cards',
    })
  }

  return {
    uiSignals,
    uiSignalSummary,
    activeUICards,
  }
}
