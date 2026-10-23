import assert from 'node:assert/strict'
import { createEmbeddingComputer, getEmbeddingTimeoutMs, REALTIME_EMBEDDING_BUDGET_MS, waitForEmbedding } from './embedding.js'

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let calls = 0
let model = 'test-model'
const work = deferred()
const computer = createEmbeddingComputer({
  getCredentials: () => ({ model }),
  isReady: () => false,
  computeLocal: () => { calls++; return work.promise },
})
assert.equal(await computer.computeEmbedding('cold realtime', { isQuery: true, readyOnly: true }), null)
assert.equal(calls, 0, 'realtime cold path must not trigger model/module loading')
const first = computer.computeEmbedding('same query', { isQuery: true })
const second = computer.computeEmbedding('same query', { isQuery: true, readyOnly: true })
await Promise.resolve()
assert.equal(calls, 1, 'identical in-flight requests share inference')
const deadline = await waitForEmbedding(first, 5)
assert.deepEqual(deadline, { embedding: null, timedOut: true }, 'cold inference must not block the realtime caller')
const vector = Buffer.from([1, 2, 3, 4])
work.resolve(vector)
assert.equal(await first, vector)
assert.equal(await second, vector)
assert.equal(await computer.computeEmbedding('same query', { isQuery: true }), vector)
assert.equal(await computer.computeEmbedding('same query', { isQuery: true, readyOnly: true }), vector)
assert.equal(calls, 1, 'late result populates the cache after realtime timeout')
await computer.computeEmbedding('same query', { isQuery: false })
assert.equal(calls, 2, 'passage and query vectors have distinct cache keys')
model = 'another-model'
await computer.computeEmbedding('same query', { isQuery: true })
assert.equal(calls, 3, 'different models never share cached vectors')
computer.clearEmbeddingCache()
await computer.computeEmbedding('same query', { isQuery: true })
assert.equal(calls, 4)

let retries = 0
const retryComputer = createEmbeddingComputer({
  getCredentials: () => ({ model: 'retry' }),
  computeLocal: () => { if (++retries === 1) throw new Error('unavailable'); return vector },
})
assert.equal(await retryComputer.computeEmbedding('retry query'), null)
assert.equal(await retryComputer.computeEmbedding('retry query'), vector)
assert.equal(retries, 2, 'failed inference must clear the shared in-flight promise')
assert.equal(await retryComputer.computeEmbedding('x'), null)
assert.equal(retries, 2, 'short input does not invoke inference')
assert.deepEqual(await waitForEmbedding(Promise.reject(new Error('failed')), 100), { embedding: null, timedOut: false })
const readyComputer = createEmbeddingComputer({
  getCredentials: () => ({ model: 'warm' }),
  isReady: () => true,
  computeLocal: () => vector,
})
assert.equal(await readyComputer.computeEmbedding('warm realtime', { readyOnly: true }), vector)

const slowBackground = deferred()
const backgroundWait = waitForEmbedding(slowBackground.promise, 1000)
slowBackground.resolve(vector)
assert.deepEqual(await backgroundWait, { embedding: vector, timedOut: false })
assert(getEmbeddingTimeoutMs({ fastUserPath: true }) <= REALTIME_EMBEDDING_BUDGET_MS)
assert.equal(getEmbeddingTimeoutMs({ fastUserPath: true }), Math.min(getEmbeddingTimeoutMs(), 120))
console.log('Embedding deadlines, late cache fill, in-flight dedupe and retry passed')
