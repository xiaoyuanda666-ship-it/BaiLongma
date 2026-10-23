import OpenAI from 'openai'
import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'

function requestBodyBytes(body) {
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8')
  if (ArrayBuffer.isView(body)) return body.byteLength
  if (body instanceof ArrayBuffer) return body.byteLength
  return undefined
}

// Own SDK resources without exposing clients to the agent policy layer. Connection
// settings are supplied by the caller; the kernel never reads application config.
export function createModelTransport({
  createClient = options => new OpenAI(options),
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => performance.now(),
} = {}) {
  let client = null
  let activeConnection = null
  // A shared SDK client may have concurrent foreground/background requests.
  // Never store the active observer on the client or send it in HTTP headers.
  const requestTiming = new AsyncLocalStorage()
  const observedFetch = async (...args) => {
    const timing = requestTiming.getStore()
    if (!timing) return fetchImpl(...args)
    const requestBytes = requestBodyBytes(args[1]?.body)
    timing.attempt += 1
    timing.dispatchedAt = now()
    timing.emit('dispatch', { ...(requestBytes === undefined ? {} : { requestBytes }) })
    try {
      const response = await fetchImpl(...args)
      timing.emit('headers', { status: response.status })
      return response
    } catch (error) {
      timing.emit('error', { phase: 'fetch', aborted: args[1]?.signal?.aborted === true })
      throw error
    }
  }

  return Object.freeze({
    async openStream({ connection, protocol, params, signal, onTiming }) {
      const startedAt = now()
      if (protocol !== 'responses' && protocol !== 'chat-completions') {
        throw new Error(`Unsupported model transport protocol: ${protocol}`)
      }
      const { provider, baseURL, apiKey } = connection
      if (!client || !activeConnection
        || activeConnection.provider !== provider
        || activeConnection.baseURL !== baseURL
        || activeConnection.apiKey !== apiKey) {
        const nextClient = createClient({ apiKey, baseURL, fetch: observedFetch })
        client = nextClient
        activeConnection = { provider, baseURL, apiKey }
      }
      const createStream = () => protocol === 'responses'
        ? client.responses.create(params, { signal })
        : client.chat.completions.create(params, { signal })
      if (typeof onTiming !== 'function') return requestTiming.run(null, createStream)

      const timing = {
        attempt: 0,
        dispatchedAt: null,
        emit(event, fields = {}) {
          // Timing must never break a request, even if an observer is async.
          try {
            const current = now()
            const result = onTiming({
              event,
              elapsedMs: Math.max(0, current - startedAt),
              attempt: timing.attempt,
              ...(timing.dispatchedAt === null ? {} : {
                attemptElapsedMs: Math.max(0, current - timing.dispatchedAt),
              }),
              ...fields,
            })
            result?.catch?.(() => {})
          } catch {}
        },
      }
      let stream
      try {
        // The SDK creates and retries its HTTP request inside this context.
        // Each custom-fetch call is a real dispatch, after SDK serialization;
        // retry backoff remains visible between attempts without changing it.
        stream = await requestTiming.run(timing, createStream)
      } catch (error) {
        timing.emit('error', {
          phase: 'open',
          aborted: signal?.aborted === true,
          ...(Number.isFinite(error?.status) ? { status: error.status } : {}),
        })
        throw error
      }
      // SDK events are already parsed SSE messages: comments/keepalives do not
      // count. Semantic first text/reasoning/tool deltas are measured by Runtime.
      // Do not clone/tee/read the response body ahead of its consumer.
      return {
        controller: stream.controller,
        async *[Symbol.asyncIterator]() {
          let first = true
          let completed = false
          try {
            for await (const event of stream) {
              if (first) {
                first = false
                timing.emit('first_event')
              }
              yield event
            }
            completed = true
          } catch (error) {
            timing.emit('error', { phase: 'stream', aborted: signal?.aborted === true })
            throw error
          } finally {
            timing.emit('end', {
              completed,
              aborted: signal?.aborted === true || stream.controller?.signal?.aborted === true,
            })
          }
        },
      }
    },
  })
}
