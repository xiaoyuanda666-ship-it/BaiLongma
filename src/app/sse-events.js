// HTTP serialization and client lifetimes belong to the App adapter.
export function createSSEEvents(journal) {
  const clients = new Map()
  const write = (res, event) => res.write(`id: ${event.id}\ndata: ${event.payload}\n\n`)
  function removeSSEClient(res) {
    clients.get(res)?.()
    clients.delete(res)
  }
  return {
    addSSEClient(res) {
      if (clients.has(res)) return
      clients.set(res, journal.subscribe(event => {
        try { write(res, event) } catch { removeSSEClient(res) }
      }))
    },
    removeSSEClient,
    flushStickyEvents(res) {
      for (const event of journal.stickySnapshot()) {
        try { res.write(`data: ${JSON.stringify(event)}\n\n`) } catch {}
      }
    },
    flushEventsSince(res, lastEventId = 0) {
      const normalized = Number(lastEventId) || 0
      if (normalized <= 0) return { replayed: 0, oldestEventId: journal.oldestId() }
      let replayed = 0
      for (const event of journal.since(normalized)) {
        try { write(res, event); replayed++ } catch { break }
      }
      return { replayed, oldestEventId: journal.oldestId(), latestEventId: journal.latestId() }
    },
    getLatestEventId: journal.latestId,
  }
}
