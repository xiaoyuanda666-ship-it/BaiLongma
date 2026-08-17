// Regression coverage for atomic whole-file writes and safe partial edits.
// Run: node src/test-filesystem-edit.js

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-file-edit-'))
process.env.BAILONGMA_USER_DIR = tempRoot
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()

const { config } = await import('./config.js')
const { execEditFile, execReadFile, execWriteFile } = await import('./capabilities/tools/filesystem.js')
const { SANDBOX_ROOT } = await import('./capabilities/sandbox.js')
const { executeTool } = await import('./capabilities/executor.js')
const { closeDBForTest } = await import('./db.js')
config.security.fileSandbox = false

const parse = value => JSON.parse(String(value))
const target = path.join(tempRoot, 'workspace', 'sample.txt')

try {
  const created = parse(await execWriteFile({
    path: target,
    content: 'alpha\r\nbeta\r\ngamma\r\nbeta\r\n',
    if_exists: 'error',
  }))
  assert.equal(created.ok, true)
  assert.equal(created.created, true)
  assert.match(created.sha256, /^[a-f0-9]{64}$/)

  const createCollision = parse(await execWriteFile({
    path: target,
    content: 'must not land',
    if_exists: 'error',
  }))
  assert.equal(createCollision.code, 'FILE_EXISTS')
  assert.equal(fs.readFileSync(target, 'utf8'), 'alpha\r\nbeta\r\ngamma\r\nbeta\r\n')

  const defaultCollision = parse(await execWriteFile({
    path: target,
    content: 'must not land by default',
  }))
  assert.equal(defaultCollision.code, 'FILE_EXISTS')
  assert.equal(fs.readFileSync(target, 'utf8'), 'alpha\r\nbeta\r\ngamma\r\nbeta\r\n',
    'omitting if_exists must never overwrite an existing file')

  const replaceTarget = path.join(tempRoot, 'workspace', 'deliberate-replacement.txt')
  fs.writeFileSync(replaceTarget, 'old whole file', 'utf8')
  const explicitReplacement = parse(await execWriteFile({
    path: replaceTarget,
    content: 'new whole file',
    if_exists: 'overwrite',
  }))
  assert.equal(explicitReplacement.ok, true)
  assert.equal(explicitReplacement.created, false)
  assert.equal(fs.readFileSync(replaceTarget, 'utf8'), 'new whole file')

  const metadata = parse(await execReadFile({ path: target, include_metadata: true }))
  assert.equal(metadata.content, 'alpha\r\nbeta\r\ngamma\r\nbeta\r\n')
  assert.equal(metadata.sha256, created.sha256)

  const ambiguous = parse(await execEditFile({
    path: target,
    operation: 'replace',
    old_text: 'beta',
    new_text: 'BETA',
  }))
  assert.equal(ambiguous.code, 'AMBIGUOUS_MATCH')
  assert.equal(ambiguous.matches, 2)
  assert.equal(fs.readFileSync(target, 'utf8'), metadata.content)

  const exact = parse(await execEditFile({
    path: target,
    operation: 'replace',
    old_text: 'beta\r\ngamma',
    new_text: 'BETA\r\nGAMMA',
    expected_sha256: metadata.sha256,
  }))
  assert.equal(exact.ok, true)
  assert.equal(exact.replacements, 1)
  assert.equal(exact.verified, true)
  assert.equal(fs.readFileSync(target, 'utf8'), 'alpha\r\nBETA\r\nGAMMA\r\nbeta\r\n')

  const beforeLineEdit = parse(await execReadFile({ path: target, include_metadata: true }))
  const lineEdit = parse(await execEditFile({
    path: target,
    operation: 'replace_lines',
    start_line: 2,
    end_line: 3,
    content: 'second\r\nthird',
    expected_sha256: beforeLineEdit.sha256,
  }))
  assert.equal(lineEdit.ok, true)
  assert.deepEqual([lineEdit.start_line, lineEdit.end_line], [2, 3])
  assert.equal(fs.readFileSync(target, 'utf8'), 'alpha\r\nsecond\r\nthird\r\nbeta\r\n')

  const staleMetadata = parse(await execReadFile({ path: target, include_metadata: true }))
  fs.writeFileSync(target, 'changed elsewhere\r\n', 'utf8')
  const staleEdit = parse(await execEditFile({
    path: target,
    operation: 'replace_lines',
    start_line: 1,
    content: 'stale replacement',
    expected_sha256: staleMetadata.sha256,
  }))
  assert.equal(staleEdit.code, 'CONTENT_CHANGED')
  assert.equal(fs.readFileSync(target, 'utf8'), 'changed elsewhere\r\n')

  const appended = parse(await executeTool('edit_file', {
    path: target,
    operation: 'append',
    content: 'tail',
  }, { source: 'filesystem-edit-test' }))
  assert.equal(appended.changed, true)
  const prepended = parse(await execEditFile({
    path: target,
    operation: 'prepend',
    content: 'head\r\n',
  }))
  assert.equal(prepended.changed, true)
  assert.equal(fs.readFileSync(target, 'utf8'), 'head\r\nchanged elsewhere\r\ntail')

  const binaryTarget = path.join(tempRoot, 'workspace', 'binary.dat')
  const binaryBytes = Buffer.from([0xff, 0xfe, 0x00, 0x80])
  fs.writeFileSync(binaryTarget, binaryBytes)
  const binaryEdit = parse(await execEditFile({
    path: binaryTarget,
    operation: 'append',
    content: 'unsafe',
  }))
  assert.equal(binaryEdit.code, 'INVALID_UTF8')
  assert.deepEqual(fs.readFileSync(binaryTarget), binaryBytes)

  const realTarget = path.join(tempRoot, 'workspace', 'real-target.txt')
  const symlinkTarget = path.join(tempRoot, 'workspace', 'linked-target.txt')
  fs.writeFileSync(realTarget, 'before link edit', 'utf8')
  fs.symlinkSync(realTarget, symlinkTarget)
  const symlinkEdit = parse(await execEditFile({
    path: symlinkTarget,
    operation: 'replace',
    old_text: 'before',
    new_text: 'after',
  }))
  assert.equal(symlinkEdit.ok, true)
  assert.equal(fs.lstatSync(symlinkTarget).isSymbolicLink(), true, 'atomic edit preserves the requested symlink')
  assert.equal(fs.readFileSync(realTarget, 'utf8'), 'after link edit')

  const externalDir = path.join(tempRoot, 'outside-sandbox')
  const sandboxLink = path.join(SANDBOX_ROOT, 'outside-link')
  fs.mkdirSync(externalDir, { recursive: true })
  fs.mkdirSync(SANDBOX_ROOT, { recursive: true })
  fs.symlinkSync(externalDir, sandboxLink)
  config.security.fileSandbox = true
  await assert.rejects(
    execWriteFile({ path: 'outside-link/escape.txt', content: 'must not escape' }),
    /访问被拒绝/,
  )
  assert.equal(fs.existsSync(path.join(externalDir, 'escape.txt')), false)
  config.security.fileSandbox = false

  const leftovers = fs.readdirSync(path.dirname(target)).filter(name => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], 'atomic writes clean up sibling temporary files')

  console.log('test-filesystem-edit ok')
} finally {
  closeDBForTest()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
