import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createFilesystemPort } from './kernel/filesystem.js'
import { createFilesystemTools } from './runtime/filesystem-tools.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'filesystem-layers-')))
try {
  assert.throws(() => createFilesystemPort(), /assertAccess/)
  let permitted = true
  const port = createFilesystemPort({ assertAccess(candidate) {
    assert.equal(permitted, true, 'permission revoked')
    const absolute = path.resolve(candidate)
    assert.ok(absolute.startsWith(root + path.sep) || absolute === root, 'outside root')
    const physical = fs.existsSync(absolute) ? fs.realpathSync(absolute) : fs.realpathSync(path.dirname(absolute))
    assert.ok(physical.startsWith(root + path.sep) || physical === root, 'symlink escaped root')
  } })
  const target = path.join(root, 'document.txt')
  port.atomicWriteUtf8(target, '\uFEFFhello\r\nworld', { failIfExists: true })
  assert.equal(port.readUtf8Strict(target), '\uFEFFhello\r\nworld')
  assert.throws(() => port.atomicWriteUtf8(target, 'lost', { failIfExists: true }), { code: 'EEXIST' })
  assert.deepEqual(fs.readdirSync(root), ['document.txt'], 'atomic failures clean up temporary files')
  let targetChecks = 0
  const revokedDuringModeCheck = createFilesystemPort({ assertAccess(candidate) {
    if (candidate === target && ++targetChecks === 2) throw new Error('mode access denied')
  } })
  assert.throws(() => revokedDuringModeCheck.atomicWriteUtf8(target, 'must not write'), /mode access denied/)
  assert.equal(port.readUtf8Strict(target), '\uFEFFhello\r\nworld')
  assert.deepEqual(fs.readdirSync(root), ['document.txt'])
  const revokedAtCommit = createFilesystemPort({ assertAccess(candidate) {
    if (candidate === target && fs.readdirSync(root).some(name => name.endsWith('.tmp'))) {
      throw new Error('revoked before commit')
    }
  } })
  assert.throws(() => revokedAtCommit.atomicWriteUtf8(target, 'must not commit'), /revoked before commit/)
  assert.equal(port.readUtf8Strict(target), '\uFEFFhello\r\nworld')
  assert.deepEqual(fs.readdirSync(root), ['document.txt'])
  fs.writeFileSync(path.join(root, 'binary'), Buffer.from([0xff, 0xfe]))
  assert.equal(port.readUtf8Strict(path.join(root, 'binary')), null)
  fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'))
  assert.throws(() => port.readdirSync(path.join(root, 'escape')), /symlink escaped/)
  assert.throws(() => port.atomicWriteUtf8(path.join(root, 'escape', 'forbidden.txt'), 'no'), /symlink escaped/)
  permitted = false
  assert.throws(() => port.readFileSync(target, 'utf8'), /permission revoked/)
  assert.throws(() => port.unlinkSync(target), /permission revoked/)
  permitted = true

  const previews = []
  const tools = createFilesystemTools({
    filesystem: port,
    sandboxRoot: root,
    normalizeSandboxPath: value => value,
    resolvePathThroughExistingPrefix: value => value,
    assertInSandbox: () => {}, // Even an unchecked tool adapter cannot bypass the port.
    preview: {
      beginEditFileExecutionPreview: value => previews.push(value),
      finishEditFileExecutionPreview: value => previews.push(value),
      streamWriteFileExecutionPreview: value => previews.push(value),
    },
  })
  await assert.rejects(tools.execReadFile({ path: '../forbidden' }), /outside root/)
  const controller = new AbortController()
  controller.abort('cancelled')
  await assert.rejects(tools.execWriteFile({ path: 'abort.txt', content: 'no' }, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(fs.existsSync(path.join(root, 'abort.txt')), false)
  const metadata = JSON.parse(await tools.execReadFile({ path: 'document.txt', include_metadata: true }))
  const stale = JSON.parse(await tools.execEditFile({ path: 'document.txt', operation: 'append', content: '!', expected_sha256: '0'.repeat(64) }))
  assert.equal(stale.code, 'CONTENT_CHANGED')
  assert.equal(previews.length, 0)
  const edited = JSON.parse(await tools.execEditFile({ path: 'document.txt', old_text: 'hello', new_text: 'goodbye', expected_sha256: metadata.sha256 }))
  assert.equal(edited.ok, true)
  assert.equal(port.readUtf8Strict(target), '\uFEFFgoodbye\r\nworld')
  assert.equal(previews.length, 2)
  console.log('filesystem layer tests passed')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

test('read_file respects both end_line and max_lines', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filesystem-ranges-'))
  try {
    const tools = createFilesystemTools({
      filesystem: createFilesystemPort({ assertAccess() {} }),
      sandboxRoot: root,
      normalizeSandboxPath: value => value,
      resolvePathThroughExistingPrefix: value => value,
      assertInSandbox() {},
      preview: {},
    })
    for (const newline of ['\n', '\r\n', '\r']) {
      fs.writeFileSync(path.join(root, 'lines.txt'), ['one', 'two', 'three', 'four', 'five'].join(newline))
      const read = async range => JSON.parse(await tools.execReadFile({ path: 'lines.txt', ...range }))
      const endLimited = await read({ start_line: 2, end_line: 3, max_lines: 20 })
      assert.equal(endLimited.content, ['two', 'three'].join(newline))
      assert.equal(endLimited.end_line, 3)
      assert.equal(endLimited.truncated, true)
      const countLimited = await read({ start_line: 2, end_line: 5, max_lines: 2 })
      assert.equal(countLimited.content, endLimited.content)
      assert.equal(countLimited.end_line, 3)
      assert.equal((await read({ start_line: 2, end_line: 3, max_lines: 0 })).content, '')
      assert.equal((await read({ end_line: 2 })).content, ['one', 'two'].join(newline))
      assert.equal((await read({ max_lines: 2 })).content, ['one', 'two'].join(newline))
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('atomic replacement preserves existing permissions while new files respect umask', {
  skip: process.platform === 'win32' && 'POSIX permission bits are not supported on Windows',
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filesystem-permissions-'))
  const originalUmask = process.umask()
  try {
    const port = createFilesystemPort({ assertAccess() {} })
    const target = path.join(root, 'existing.sh')
    fs.writeFileSync(target, 'old content')
    fs.chmodSync(target, 0o775)
    process.umask(0o077)
    port.atomicWriteUtf8(target, 'new content')
    assert.equal(fs.readFileSync(target, 'utf8'), 'new content')
    assert.equal(fs.statSync(target).mode & 0o777, 0o775, 'an edit must retain group and other access')

    const created = path.join(root, 'new.txt')
    port.atomicWriteUtf8(created, 'private', { failIfExists: true })
    assert.equal(fs.statSync(created).mode & 0o777, 0o600, 'new files must still respect the process umask')
    assert.deepEqual(fs.readdirSync(root).sort(), ['existing.sh', 'new.txt'])
  } finally {
    process.umask(originalUmask)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
