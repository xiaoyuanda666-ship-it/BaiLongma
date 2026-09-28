import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-api-body-limits-'))
process.env.BAILONGMA_USER_DIR = tmp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
process.env.BAILONGMA_HOST = '127.0.0.1'
let server
let closeDBForTest
try {
  const { startAPI } = await import('./api.js')
  ;({ closeDBForTest } = await import('./db.js'))
  server = startAPI(0)
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  for (const [route, limit] of [
    ['/settings/agent-name', 1024 * 1024],
    ['/message', 30 * 1024 * 1024],
    ['/message/resources', Math.ceil(40 * 1024 * 1024 * 1.45)],
    ['/aivideo/generate', 30 * 1024 * 1024],
    ['/knowledge/documents', 12 * 1024 * 1024],
  ]) {
    await new Promise((resolve, reject) => {
      const request = http.request(`${base}${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(limit + 1) },
      }, response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => {
          request.destroy()
          try {
            assert.equal(response.statusCode, 413, `${route}: ${body}`)
            resolve()
          } catch (error) { reject(error) }
        })
      })
      request.on('error', reject)
      request.flushHeaders()
    })
  }
  const image = Buffer.alloc(1024 * 1024, 120)
  const response = await fetch(`${base}/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'image limit regression', image: `data:image/png;base64,${image.toString('base64')}` }),
  })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.attachments.length, 1)
  assert.equal(result.attachments[0].size, image.length)
  assert.deepEqual(fs.readFileSync(result.attachments[0].path), image)
  console.log('PASS real API 413 statuses and chat base64 image above default body limit')
} finally {
  if (server) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}
process.exit(process.exitCode || 0)
