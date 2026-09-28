import { createEventHistory } from './event-history.js'

// Runtime accepts a journal port and repository operation, never HTTP responses.
export function createRuntimeEventService({ journal, insertBrainUiEvent }) {
  const persist = createEventHistory({ insertBrainUiEvent })
  return {
    emitEvent(type, data) {
      const ts = new Date().toISOString()
      persist(type, data, ts)
      journal.publish(type, data, ts)
    },
    setStickyEvent: journal.setSticky,
    clearStickyEvent: journal.clearSticky,
  }
}
