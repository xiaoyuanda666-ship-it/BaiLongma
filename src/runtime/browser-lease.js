function abortError(reason = 'browser lease acquisition aborted') {
  const error = new Error(String(reason || 'browser lease acquisition aborted'))
  error.name = 'AbortError'
  return error
}

export class BrowserLeaseManager {
  constructor() {
    this.holder = null
    this.queue = []
    this.sequence = 0
  }

  snapshot() {
    return {
      holder: this.holder ? {
        ownerId: this.holder.ownerId,
        priority: this.holder.priority,
        preemptible: this.holder.preemptible,
        yieldRequested: this.holder.yieldRequested,
      } : null,
      queued: this.queue.map(request => ({
        ownerId: request.ownerId,
        priority: request.priority,
        preemptible: request.preemptible,
      })),
    }
  }

  acquire({
    ownerId,
    priority = 0,
    preemptible = false,
    onYield = null,
    signal = null,
  } = {}) {
    const normalizedOwnerId = String(ownerId || '').trim()
    if (!normalizedOwnerId) return Promise.reject(new TypeError('browser lease ownerId is required'))
    if (signal?.aborted) return Promise.reject(abortError(signal.reason))

    return new Promise((resolve, reject) => {
      const request = {
        ownerId: normalizedOwnerId,
        priority: Number(priority) || 0,
        preemptible: preemptible === true,
        onYield: typeof onYield === 'function' ? onYield : null,
        signal,
        resolve,
        reject,
        sequence: ++this.sequence,
        abortHandler: null,
      }
      request.abortHandler = () => {
        const index = this.queue.indexOf(request)
        if (index >= 0) this.queue.splice(index, 1)
        reject(abortError(signal?.reason))
      }
      signal?.addEventListener?.('abort', request.abortHandler, { once: true })
      this.queue.push(request)
      this.queue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence)
      this.maybeRequestYield(request)
      this.dispatch()
    })
  }

  maybeRequestYield(incoming) {
    const holder = this.holder
    if (!holder || !holder.preemptible || holder.yieldRequested) return
    if (incoming.priority <= holder.priority) return
    holder.yieldRequested = true
    queueMicrotask(() => {
      if (this.holder !== holder || holder.released) return
      try { holder.onYield?.({ requestedBy: incoming.ownerId, priority: incoming.priority }) }
      catch (error) { console.warn('[browser-lease] yield callback failed:', error?.message || error) }
    })
  }

  dispatch() {
    if (this.holder) return
    while (this.queue.length > 0) {
      const request = this.queue.shift()
      request.signal?.removeEventListener?.('abort', request.abortHandler)
      if (request.signal?.aborted) {
        request.reject(abortError(request.signal.reason))
        continue
      }
      const lease = {
        ownerId: request.ownerId,
        priority: request.priority,
        preemptible: request.preemptible,
        onYield: request.onYield,
        yieldRequested: false,
        released: false,
        releaseReason: '',
        release: reason => {
          if (lease.released) return false
          lease.released = true
          lease.releaseReason = String(reason || '')
          if (this.holder === lease) this.holder = null
          this.dispatch()
          return true
        },
        assertActive: () => {
          if (lease.released || this.holder !== lease) throw abortError(lease.releaseReason || 'browser lease is no longer active')
          return true
        },
      }
      this.holder = lease
      request.resolve(lease)
      return
    }
  }

  releaseOwner(ownerId, reason = '') {
    const normalized = String(ownerId || '')
    if (this.holder?.ownerId === normalized) return this.holder.release(reason)
    return false
  }
}

export const browserLeaseManager = new BrowserLeaseManager()
