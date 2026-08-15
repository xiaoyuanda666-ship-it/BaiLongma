import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-db-schema-'))
const resolvedTempRoot = path.resolve(tempRoot)
const resolvedOsTemp = path.resolve(os.tmpdir())

assert.ok(
  resolvedTempRoot.startsWith(`${resolvedOsTemp}${path.sep}`),
  `Refusing to use unsafe temp path: ${resolvedTempRoot}`,
)

process.env.BAILONGMA_USER_DIR = resolvedTempRoot
process.env.BAILONGMA_RESOURCES_DIR = path.resolve('.')

let closeDBForTest = () => {}
try {
  const dbModule = await import(`./db.js?schema-test=${Date.now()}`)
  closeDBForTest = dbModule.closeDBForTest
  const db = dbModule.getDB()
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all().map(row => row.name)

  for (const required of ['conversations', 'memories', 'reminders', 'thread_state', 'information_subscriptions']) {
    assert.ok(tables.includes(required), `missing table: ${required}`)
  }
  const subscriptionColumns = db.prepare('PRAGMA table_info(information_subscriptions)').all().map(row => row.name)
  assert.ok(subscriptionColumns.includes('instruction'), 'information_subscriptions missing instruction column')
  const conversationColumns = db.prepare('PRAGMA table_info(conversations)').all().map(row => row.name)
  assert.ok(conversationColumns.includes('resource_state'), 'conversations missing resource_state column')
  assert.ok(conversationColumns.includes('resource_metadata'), 'conversations missing resource_metadata column')
} finally {
  closeDBForTest()
  fs.rmSync(resolvedTempRoot, { recursive: true, force: true })
}

console.log('db schema module tests passed')
process.exit(process.exitCode || 0)
