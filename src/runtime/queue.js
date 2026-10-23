const queues = {
  user: [],
  background: [],
}

let interruptCallback = null

export function setInterruptCallback(fn) {
  interruptCallback = fn
}

export function removeSupersededUserMessages(entry, { onSuperseded = null } = {}) {
  if (!entry || entry.queueName !== 'user') return []

  const removed = []

  for (let i = queues.user.length - 1; i >= 0; i--) {
    const pending = queues.user[i]
    if (!pending) continue
    if (pending.fromId !== entry.fromId) continue
    if ((pending.channel || '') !== (entry.channel || '')) continue
    queues.user.splice(i, 1)
    removed.push(pending)
    try { onSuperseded?.(pending, entry) } catch (error) {
      console.warn('[queue] failed to settle superseded user entry:', error?.message || error)
    }
    pending.performanceTrace?.finish({ status: 'superseded' })
  }
  return removed
}

export function enqueueMessage(entry, queueName = entry?.queueName, options = {}) {
  const targetQueue = queueName === 'background' ? 'background' : 'user'
  removeSupersededUserMessages(entry, options)
  queues[targetQueue].push(entry)
  // This must precede the callback: it can synchronously start processing.
  entry.performanceTrace?.mark('queue.enqueued', {
    userQueueDepth: queues.user.length,
    backgroundQueueDepth: queues.background.length,
  })
  interruptCallback?.(entry)
  return entry
}

export function popMessage() {
  return queues.user.shift() || queues.background.shift() || null
}

export function requeueMessage(msg, retryCount) {
  const queueName = msg?.queueName === 'background' ? 'background' : 'user'
  queues[queueName].unshift({ ...msg, retryCount, queueName })
  msg?.performanceTrace?.mark('queue.requeued', { retryCount })
}

export function hasMessages() {
  return queues.user.length > 0 || queues.background.length > 0
}

export function hasUserMessages() {
  return queues.user.length > 0
}

export function getQueueSnapshot() {
  return {
    user: queues.user.length,
    background: queues.background.length,
  }
}
