import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, test } from 'node:test'

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-rule-persistence-'))
process.env.BAILONGMA_USER_DIR = userDir
const { paths } = await import('./paths.js')
const {
  deleteRule,
  loadAutomationRules,
  loadContextRules,
  saveAutomationRules,
  saveContextRules,
  updateRule,
  upsertRule,
} = await import('./context/rule-store.js')
const originalRead = fs.readFileSync
const originalWrite = fs.writeFileSync
const originalRename = fs.renameSync
const rule = { id: 'fixture', provider: 'static_text', patterns: ['fixture'], context: 'Fixture context' }
const existing = {
  schemaVersion: 4,
  provider: 'custom',
  temperature: 0,
  security: { fileSandbox: true },
  tts: { doubaoKey: 'fake-existing-secret' },
}

beforeEach(() => {
  fs.writeFileSync(paths.configFile, JSON.stringify(existing))
})
after(() => {
  fs.readFileSync = originalRead
  fs.writeFileSync = originalWrite
  fs.renameSync = originalRename
  fs.rmSync(userDir, { recursive: true, force: true })
})

function assertNoTempFiles() {
  assert.deepEqual(fs.readdirSync(userDir).filter(name => /^config\.json\..*\.tmp$/.test(name)), [])
}

test('context and automation rule edits retain all unrelated configuration', () => {
  upsertRule('context', rule)
  upsertRule('automation', { ...rule, id: 'automation-fixture' })
  updateRule('context', rule.id, { context: 'Updated fixture' })
  assert.equal(loadContextRules({ includeDefaults: false })[0].context, 'Updated fixture')
  assert.equal(loadAutomationRules()[0].id, 'automation-fixture')
  deleteRule('context', rule.id)
  const saved = JSON.parse(fs.readFileSync(paths.configFile, 'utf8'))
  for (const [key, value] of Object.entries(existing)) assert.deepEqual(saved[key], value)
  assert.deepEqual(saved.contextRules, [])
  assert.equal(saved.automationRules.length, 1)
  assertNoTempFiles()
})

test('saving can initialize a missing config file', () => {
  fs.rmSync(paths.configFile)
  saveContextRules([rule])
  assert.equal(loadContextRules({ includeDefaults: false })[0].id, rule.id)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(paths.configFile).mode & 0o777, 0o600)
  }
})

test('rule mutations refuse damaged or non-object configuration without overwriting it', () => {
  for (const text of ['{broken', '[]', 'null', '"invalid"', '42']) {
    fs.writeFileSync(paths.configFile, text)
    for (const mutation of [
      () => saveContextRules([rule]),
      () => saveAutomationRules([rule]),
      () => upsertRule('context', rule),
      () => upsertRule('automation', rule),
      () => updateRule('context', 'ssh_local_resources', { enabled: false }),
      () => deleteRule('automation', rule.id),
    ]) {
      assert.throws(mutation)
      assert.equal(fs.readFileSync(paths.configFile, 'utf8'), text)
    }
    assert.ok(loadContextRules().length > 0, 'read-only context loading still supplies defaults')
    assert.deepEqual(loadAutomationRules(), [])
  }
  assertNoTempFiles()
})

test('read failures cannot turn an existing config or rule list into an empty update', () => {
  saveContextRules([rule])
  const before = fs.readFileSync(paths.configFile)
  let failures = 0
  fs.readFileSync = (file, ...args) => {
    if (String(file) === paths.configFile && failures++ === 0) {
      throw Object.assign(new Error('simulated unreadable configuration'), { code: 'EACCES' })
    }
    return originalRead(file, ...args)
  }
  try {
    assert.throws(() => upsertRule('context', { ...rule, id: 'second-rule' }), /unreadable configuration/)
  } finally {
    fs.readFileSync = originalRead
  }
  assert.deepEqual(fs.readFileSync(paths.configFile), before)
  assertNoTempFiles()
})

test('failed atomic replacement preserves the original config and removes temporary files', () => {
  const before = fs.readFileSync(paths.configFile)
  fs.renameSync = (source, destination) => {
    if (String(destination) === paths.configFile) throw new Error('simulated rename failure')
    return originalRename(source, destination)
  }
  try {
    assert.throws(() => saveAutomationRules([rule]), /simulated rename failure/)
  } finally {
    fs.renameSync = originalRename
  }
  assert.deepEqual(fs.readFileSync(paths.configFile), before)
  assertNoTempFiles()
})

test('partial writes never truncate the main configuration', () => {
  const before = fs.readFileSync(paths.configFile)
  fs.writeFileSync = (file, contents, ...args) => {
    if (String(file).startsWith(`${paths.configFile}.`) && String(file).endsWith('.tmp')) {
      originalWrite(file, String(contents).slice(0, 12), ...args)
      throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' })
    }
    return originalWrite(file, contents, ...args)
  }
  try {
    assert.throws(() => saveContextRules([rule]), /simulated disk full/)
  } finally {
    fs.writeFileSync = originalWrite
  }
  assert.deepEqual(fs.readFileSync(paths.configFile), before)
  assertNoTempFiles()
})
