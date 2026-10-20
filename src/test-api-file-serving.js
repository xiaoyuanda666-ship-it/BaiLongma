import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import test from 'node:test'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-api-file-serving-'))
process.env.BAILONGMA_USER_DIR = path.join(tmp, 'user')
process.env.BAILONGMA_RESOURCES_DIR = path.join(tmp, 'resources')

test('API file routes keep byte ranges and filesystem boundaries intact', async t => {
  let server
  try {
    const { handleMediaRoutes } = await import('./api/routes/media.js')
    const { handleStaticRoutes } = await import('./api/routes/static.js')
    const { paths } = await import('./paths.js')
    const bytes = '0123456789'
    const routes = [
      ['/media/music/', paths.musicDir],
      ['/media/video/', path.join(paths.sandboxDir, 'videos')],
      ['/media/chat/', paths.mediaDir],
      ['/audio/', paths.sandboxAudioDir],
      ['/src/ui/brain-ui/', paths.brainUiAssetRoot],
      ['/src/ui/scene-shell/', path.join(paths.resourcesDir, 'src', 'ui', 'scene-shell')],
    ]
    for (const [, root] of routes) {
      fs.mkdirSync(root, { recursive: true })
      fs.writeFileSync(path.join(root, 'sample.mp3'), bytes)
      fs.writeFileSync(path.join(root, 'empty.mp3'), '')
    }
    fs.writeFileSync(path.join(paths.sandboxChatUploadsDir, 'upload.txt'), bytes)
    const outside = path.join(tmp, 'private.txt')
    fs.writeFileSync(outside, 'outside the served directory')
    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        if (await handleMediaRoutes(req, res, url)) return
        if (await handleStaticRoutes(req, res, url)) return
        res.writeHead(404).end()
      } catch (error) {
        if (!res.headersSent) res.writeHead(500).end(error.message)
        else res.destroy(error)
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = `http://127.0.0.1:${server.address().port}`
    const request = async (route, range) => {
      const response = await fetch(`${base}${route}`, {
        headers: range ? { Range: range } : {},
        signal: AbortSignal.timeout(3000),
      })
      return { status: response.status, headers: response.headers, body: await response.text() }
    }

    await t.test('ordinary files and staged chat uploads remain accessible', async () => {
      for (const [route] of routes) {
        const result = await request(`${route}sample.mp3`)
        assert.equal(result.status, 200, route)
        assert.equal(result.body, bytes, route)
        assert.equal((await request(`${route}missing.mp3`)).status, 404, route)
      }
      assert.equal((await request('/media/chat/upload.txt')).body, bytes)
    })

    await t.test('music, video, and static assets support valid single byte ranges', async () => {
      for (const route of ['/media/music/', '/media/video/', '/src/ui/brain-ui/', '/src/ui/scene-shell/']) {
        for (const [range, expected, contentRange] of [
          ['bytes=2-5', '2345', 'bytes 2-5/10'],
          ['bytes=7-', '789', 'bytes 7-9/10'],
          ['bytes=-3', '789', 'bytes 7-9/10'],
          ['bytes=-20', bytes, 'bytes 0-9/10'],
          ['bytes=7-99', '789', 'bytes 7-9/10'],
        ]) {
          const result = await request(`${route}sample.mp3`, range)
          assert.equal(result.status, 206, `${route} ${range}`)
          assert.equal(result.body, expected, `${route} ${range}`)
          assert.equal(result.headers.get('content-range'), contentRange)
          assert.equal(result.headers.get('content-length'), String(expected.length))
        }
      }
    })

    await t.test('unsatisfiable ranges return 416 and malformed or multiple ranges are ignored', async () => {
      for (const route of ['/media/music/', '/media/video/', '/src/ui/brain-ui/', '/src/ui/scene-shell/']) {
        for (const range of ['bytes=10-', 'bytes=8-3', 'bytes=-0', 'bytes=9007199254740992-']) {
          const result = await request(`${route}sample.mp3`, range)
          assert.equal(result.status, 416, `${route} ${range}`)
          assert.equal(result.headers.get('content-range'), 'bytes */10')
          assert.equal(result.body, '')
        }
        assert.equal((await request(`${route}empty.mp3`, 'bytes=0-')).status, 416)
        for (const range of ['bytes=-', 'bytes=oops', 'bytes=0-1,4-5', 'items=0-2']) {
          const result = await request(`${route}sample.mp3`, range)
          assert.equal(result.status, 200, `${route} ${range}`)
          assert.equal(result.body, bytes)
          assert.equal(result.headers.get('content-range'), null)
        }
      }
    })

    await t.test('links may point within a served root but cannot expose outside files', async t => {
      for (const [route, root] of routes) {
        try {
          fs.symlinkSync(path.join(root, 'sample.mp3'), path.join(root, 'inside.mp3'))
        } catch (error) {
          if (process.platform === 'win32' && error.code === 'EPERM') {
            t.skip('Creating symbolic links requires Windows Developer Mode or administrator privileges')
            return
          }
          throw error
        }
        fs.symlinkSync(outside, path.join(root, 'outside.mp3'))
        assert.equal((await request(`${route}inside.mp3`)).body, bytes, route)
        const result = await request(`${route}outside.mp3`)
        assert.equal(result.status, 403, route)
        assert.equal(result.body.includes('outside the served directory'), false, route)
      }
      fs.symlinkSync(outside, path.join(paths.sandboxChatUploadsDir, 'outside-upload.txt'))
      assert.equal((await request('/media/chat/outside-upload.txt')).status, 403)
      fs.symlinkSync(tmp, path.join(paths.brainUiAssetRoot, 'outside-dir'), 'dir')
      assert.equal((await request('/src/ui/brain-ui/outside-dir/private.txt')).status, 403)
      fs.writeFileSync(path.join(paths.brainUiAssetRoot, 'module-source.txt'), 'export const value = 1')
      fs.symlinkSync(path.join(paths.brainUiAssetRoot, 'module-source.txt'), path.join(paths.brainUiAssetRoot, 'module.js'))
      for (const range of [undefined, 'bytes=0-5']) {
        const result = await request('/src/ui/brain-ui/module.js', range)
        assert.equal(result.headers.get('content-type'), 'text/javascript; charset=utf-8')
        assert.equal(result.body, range ? 'export' : 'export const value = 1')
      }
    })

    await t.test('read stream failures close the request without an uncaught exception', async () => {
      const originalCreateReadStream = fs.createReadStream
      try {
        fs.createReadStream = () => new Readable({
          read() { this.destroy(new Error('fixture read failed')) },
        })
        for (const route of ['/media/music/', '/src/ui/brain-ui/']) {
          await assert.rejects(request(`${route}sample.mp3`), { name: 'TypeError' })
        }
      } finally {
        fs.createReadStream = originalCreateReadStream
      }
      assert.equal((await request('/media/music/sample.mp3')).body, bytes)
    })
  } finally {
    if (server) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
