import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { DEFAULT_REQUEST_BODY_MAX_BYTES, jsonResponse, readJsonBody, readRawBody } from './api/utils.js'

const server = http.createServer(async (req, res) => {
  try {
    const body = await readJsonBody(req, req.url === '/upload' ? { maxBytes: 2 * DEFAULT_REQUEST_BODY_MAX_BYTES } : {})
    jsonResponse(res, 200, { length: body.text?.length || 0 })
  } catch (error) {
    jsonResponse(res, error.statusCode || 400, { error: error.message })
  }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`
try {
  const oversized = JSON.stringify({ text: 'x'.repeat(DEFAULT_REQUEST_BODY_MAX_BYTES) })
  const response = await fetch(base, { method: 'POST', body: oversized })
  assert.equal(response.status, 413, 'declared oversized body receives HTTP 413 rather than connection reset')
  assert.match((await response.json()).error, /maximum 1048576 bytes/)
  const upload = await fetch(`${base}/upload`, { method: 'POST', body: oversized })
  assert.equal(upload.status, 200, 'explicit upload allowance accepts bodies above the default')
  assert.equal((await upload.json()).length, DEFAULT_REQUEST_BODY_MAX_BYTES)
  await new Promise((resolve, reject) => {
    const req = http.request(base, { method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } }, res => {
      res.resume()
      res.on('end', () => {
        try { assert.equal(res.statusCode, 413); resolve() } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.write(Buffer.alloc(DEFAULT_REQUEST_BODY_MAX_BYTES, 120))
    req.end('x')
  })
  for (const size of [DEFAULT_REQUEST_BODY_MAX_BYTES - 1, DEFAULT_REQUEST_BODY_MAX_BYTES]) {
    const stream = new PassThrough()
    const pending = readRawBody(stream)
    stream.end(Buffer.alloc(size))
    assert.equal((await pending).length, size, 'boundary byte counts are accepted')
    assert.equal(stream.listenerCount('data'), 0)
  }
  const aborted = new PassThrough()
  const pending = readRawBody(aborted)
  const rejection = assert.rejects(pending, /request body aborted/)
  aborted.write('partial')
  aborted.emit('aborted')
  aborted.emit('error', new Error('connection reset'))
  aborted.destroy()
  await rejection
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(aborted.listenerCount('data'), 0)
  assert.equal(aborted.listenerCount('error'), 0)
  await assert.rejects(readRawBody(new PassThrough(), { maxBytes: 0 }), /positive safe integer/)
  console.log('PASS request body boundaries, declared/chunked 413, explicit upload limits, aborted cleanup')
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
