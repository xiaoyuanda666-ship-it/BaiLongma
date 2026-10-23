import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createJsonlJournal } from './kernel/jsonl-journal.js'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blm-jsonl-journal-'))
try {
  const filename = path.join(directory, 'bounded.jsonl')
  const maxBytes = 180
  const journal = createJsonlJournal({ filename, maxBytes })
  assert.deepEqual(await journal.readTail(), [])
  for (let index = 0; index < 8; index++) {
    const value = { id: index, marker: '中'.repeat(12) }
    journal.append(value)
    await journal.flush()
    assert.ok((await fs.stat(filename)).size <= maxBytes, 'UTF-8 bytes, not JS string length, bound persisted size')
    assert.deepEqual((await journal.readTail())[0], value,
      'rotation with default retention must keep the just-appended record')
  }

  const retained = []
  for (let index = 8; index < 18; index++) {
    const value = { id: index, marker: '中'.repeat(12) }
    retained.push(value)
    journal.append(value, () => retained)
    await journal.flush()
    const tail = await journal.readTail()
    assert.ok((await fs.stat(filename)).size <= maxBytes, 'retention cannot rewrite an oversized journal')
    assert.equal(tail[0].id, index)
    assert.equal(new Set(tail.map(item => item.id)).size, tail.length, 'retention containing current value must not duplicate it')
    assert.deepEqual(tail.map(item => item.id), tail.map(item => item.id).sort((a, b) => b - a))
    assert.ok((await journal.readTail(1)).length <= 1)
  }

  const sequential = createJsonlJournal({ filename: path.join(directory, 'sequential.jsonl'), maxBytes: 20_000 })
  for (let id = 0; id < 30; id++) sequential.append({ id })
  await sequential.flush()
  assert.deepEqual((await sequential.readTail(30)).map(value => value.id), Array.from({ length: 30 }, (_, index) => 29 - index),
    'overlapping async writes preserve append order')

  await fs.appendFile(filename, 'not-json\n{"partial":')
  const recovered = await journal.readTail()
  assert.ok(recovered.length > 0, 'malformed/partial trailing lines do not hide valid records')
  assert.equal(recovered[0].id, 17)
  const inaccessible = createJsonlJournal({ filename: path.join(directory, 'missing', 'no-directory.jsonl') })
  inaccessible.append({ id: 'failure' })
  await inaccessible.flush()
  assert.deepEqual(await inaccessible.readTail(), [], 'diagnostic storage failures remain fail-open')
  console.log('PASS bounded JSONL rotation, UTF-8 size, retained/current dedup, write ordering and storage failure')
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}
