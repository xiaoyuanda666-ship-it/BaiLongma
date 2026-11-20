import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-minimax-images-'))
process.env.BAILONGMA_USER_DIR = tempDir
const { execGenerateImage } = await import('./capabilities/tools/media/generation.js')
const { mediaSchemas } = await import('./capabilities/schemas/media.js')
const { MinimaxProvider } = await import('./providers/minimax.js')
const { registerProvider } = await import('./providers/registry.js')
const { getDailyUsage } = await import('./quota.js')
const { closeDBForTest } = await import('./db.js')

const originalDispatcher = getGlobalDispatcher()
const mock = new MockAgent()
mock.disableNetConnect()
let generationRequests = 0
setGlobalDispatcher({
  dispatch(options, handler) {
    if (options.path === '/v1/images/generations') {
      generationRequests++
      assert.ok(options.headersTimeout >= 600_000)
      assert.ok(options.bodyTimeout >= 600_000)
      assert.equal(options.idempotent, false)
      assert.equal(options.maxRedirections, 0)
    }
    return mock.dispatch(options, handler)
  },
})
registerProvider(new MinimaxProvider({ apiKey: 'fixture' }))

try {
  const prompt = 'A red apple'
  const url = 'https://example.com/image.jpg'
  const model = 'MiniMax-H3-Image'
  const highspeed = 'MiniMax-H3-Image-Highspeed'
  assert.deepEqual(mediaSchemas.generate_image.function.parameters.properties.model.enum,
    ['image-01', model, highspeed])

  delete process.env.MINIMAX_IMAGE_REGION
  const china = mock.get('https://api.minimax.cn')
  const global = mock.get('https://api.minimax.io')
  function h3(pool, selectedModel, count = 1) {
    return pool.intercept({
      method: 'POST', path: '/v1/images/generations', headers: { authorization: 'Bearer fixture' },
      body: body => {
        assert.deepEqual(JSON.parse(body), { prompt, model: selectedModel, aspect_ratio: '1:1', n: count, response_format: 'url' })
        return true
      },
    })
  }

  h3(china, model, 2).reply(200, {
    data: [{ url }, { error: { code: '1027', message: 'Image withheld' } }],
    usage: { generated_images: 1 },
  })
  const partial = await execGenerateImage({ prompt, model, n: 2 })
  assert.ok(partial.includes(url))
  assert.ok(partial.includes('Image withheld'))
  assert.equal(getDailyUsage('image'), 1)

  process.env.MINIMAX_IMAGE_REGION = 'global'
  h3(global, highspeed).reply(200, { data: [{ url }] })
  assert.ok((await execGenerateImage({ prompt, model: highspeed })).includes(url))
  h3(global, model).reply(422, {
    type: 'error', error: { type: 'unprocessable_entity_error', message: 'No image generated' },
    data: [{ error: { code: '1027', message: 'Image withheld' } }],
  })
  await assert.rejects(execGenerateImage({ prompt, model }), /HTTP 422.*No image generated/)
  assert.equal(getDailyUsage('image'), 2)
  assert.equal(generationRequests, 3)

  setGlobalDispatcher(mock)
  mock.get('https://api.minimaxi.com').intercept({
    path: '/v1/image_generation', method: 'POST',
    body: body => JSON.parse(body).model === 'image-01',
  }).reply(200, { data: { image_urls: [url] } })
  assert.ok((await execGenerateImage({ prompt })).includes(url))
  assert.equal(getDailyUsage('image'), 3)
  mock.assertNoPendingInterceptors()
  console.log('MiniMax image tool tests passed')
} finally {
  setGlobalDispatcher(originalDispatcher)
  await mock.close()
  closeDBForTest()
  fs.rmSync(tempDir, { recursive: true, force: true })
}
