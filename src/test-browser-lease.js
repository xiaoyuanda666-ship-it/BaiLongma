import assert from 'node:assert/strict'
import { BrowserLeaseManager } from './runtime/browser-lease.js'

const leaseManager = new BrowserLeaseManager()
const order = []
const first = await leaseManager.acquire({ ownerId: 'background-1', priority: 10 })
order.push(first.ownerId)
const secondPromise = leaseManager.acquire({ ownerId: 'background-2', priority: 10 })
await Promise.resolve()
assert.deepEqual(order, ['background-1'])
assert.equal(leaseManager.snapshot().queued.length, 1)
first.release()
const second = await secondPromise
order.push(second.ownerId)
assert.deepEqual(order, ['background-1', 'background-2'], 'equal-priority browser jobs are FIFO')
second.release()

let yielded = 0
let backgroundLease
backgroundLease = await leaseManager.acquire({
  ownerId: 'background-yieldable',
  priority: 10,
  preemptible: true,
  onYield: () => {
    yielded += 1
    backgroundLease.release('foreground-requested')
  },
})
const foreground = await leaseManager.acquire({ ownerId: 'foreground-user-turn', priority: 100 })
assert.equal(yielded, 1, 'a high-priority user browser turn requests a boundary yield')
assert.equal(foreground.ownerId, 'foreground-user-turn')
foreground.release()

console.log('browser lease tests passed')
