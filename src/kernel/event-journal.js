// Transport-neutral, bounded event storage. No Agent policy or UI dependencies.
export function createEventJournal({ limit = 600, ttlMs = 5 * 60 * 1000, now = Date.now } = {}) {
  const recent = []
  const sticky = new Map()
  const listeners = new Set()
  let nextId = 1
  function prune() {
    while (recent.length > limit || (recent[0] && now() - recent[0].createdAt > ttlMs)) recent.shift()
  }
  return {
    publish(type, data, ts = new Date(now()).toISOString()) {
      const id = nextId++
      const event = Object.freeze({ id, payload: JSON.stringify({ type, data, ts, event_id: id }), createdAt: now() })
      recent.push(event)
      prune()
      for (const listener of listeners) {
        try { listener(event) } catch { listeners.delete(listener) }
      }
      return event
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    since(lastEventId) {
      prune()
      return recent.filter(event => event.id > (Number(lastEventId) || 0))
    },
    latestId: () => recent.at(-1)?.id || 0,
    oldestId: () => recent[0]?.id || 0,
    setSticky(type, data) { sticky.set(type, { data, ts: new Date(now()).toISOString() }) },
    clearSticky(type) { sticky.delete(type) },
    stickySnapshot: () => [...sticky].map(([type, { data, ts }]) => ({ type, data, ts })),
  }
}
