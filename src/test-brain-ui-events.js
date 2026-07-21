import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-brain-ui-history-'))
process.env.BAILONGMA_USER_DIR = tmp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()

let closeDBForTest = null

try {
  const db = await import('./db.js')
  const { emitEvent } = await import('./events.js')
  closeDBForTest = db.closeDBForTest

  emitEvent('tick', {})
  emitEvent('tool_call', {
    name: 'web_search',
    args: { query: '持久化测试', api_key: 'sk-abcdefghijklmnopqrstuvwxyz' },
    result: '{"ok":true}',
    ok: true,
  })
  emitEvent('response', {})
  emitEvent('message_received', { input: '读取文件' })
  emitEvent('tool_call', {
    name: 'read_file',
    args: { path: 'src/example.js' },
    result: 'example',
    ok: true,
  })
  emitEvent('response', {})
  emitEvent('scheduled_task', {
    run_id: 11,
    reminder_id: 7,
    target_id: 'ID:000001',
    task: '提醒用户喝水',
  })
  emitEvent('tool_call', {
    name: 'send_message',
    args: { target_id: 'ID:000001', content: '该喝水了' },
    result: '{"ok":true}',
    ok: true,
  })
  emitEvent('scheduled_task_completed', { run_id: 11, reminder_id: 7 })
  emitEvent('response', {})

  const first = db.getBrainUiEventHistory({ path: 'l2', limit: 20 })
  assert.equal(first.heartbeatCount, 1)
  assert.deepEqual(first.events.map(event => event.type), ['tick', 'tool_call', 'response'])
  assert.equal(first.events[1].data.args.query, '持久化测试')
  assert.equal(first.events[1].data.args.api_key, '[redacted]')
  const all = db.getBrainUiEventHistory({ path: 'all', limit: 20 })
  assert.equal(all.events.length, 10)
  assert.deepEqual(all.events.slice(3, 6).map(event => event.type), ['message_received', 'tool_call', 'response'])
  assert.equal(all.events[3].path, 'l1')
  assert.equal(all.events[4].data.name, 'read_file')
  const l3 = db.getBrainUiEventHistory({ path: 'l3', limit: 20 })
  assert.deepEqual(l3.events.map(event => event.type), ['scheduled_task', 'tool_call', 'scheduled_task_completed', 'response'])
  assert(l3.events.every(event => event.path === 'l3'))
  assert.equal(l3.events[0].data.task, '提醒用户喝水')

  db.closeDBForTest()
  const reopened = db.getBrainUiEventHistory({ path: 'l2', limit: 20 })
  assert.equal(reopened.heartbeatCount, 1)
  assert.equal(reopened.events.length, 3)
  console.log('PASS: Brain UI events persist across L1/L2/L3 without SSE clients, survive database reopen, and redact sensitive fields')
} finally {
  try { closeDBForTest?.() } catch {}
  fs.rmSync(tmp, { recursive: true, force: true })
}
