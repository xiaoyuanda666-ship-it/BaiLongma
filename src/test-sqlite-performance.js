import assert from 'node:assert/strict'
import { instrumentSQLiteDatabase, fingerprintSQL } from './runtime/sqlite-performance.js'
import { createPerformanceTrace, runWithPerformanceTrace, measurePerformance } from './runtime/performance-trace.js'

const failure = new Error('database operation failed')
const db = {
  prepare(sql) {
    if (sql === 'invalid') throw failure
    return {
      bind() { return this },
      get(value) { if (value === 'fail') throw failure; return value ? { value } : undefined },
      all() { return [{ value: 1 }, { value: 2 }] },
      run() { return { changes: 3, lastInsertRowid: 5 } },
      *iterate() { yield { value: 1 }; yield { value: 2 } },
    }
  },
}

assert.equal(instrumentSQLiteDatabase(db), db)
const prepare = db.prepare
instrumentSQLiteDatabase(db)
assert.equal(db.prepare, prepare, 'connection must not be wrapped twice')
const cached = db.prepare("SELECT * FROM records WHERE secret = 'never log this'")
assert.equal(cached.bind(), cached, 'statement chaining preserves identity')

const trace = createPerformanceTrace({ channel: 'test' })
runWithPerformanceTrace(trace, () => measurePerformance('database-test', () => {
  const statement = db.prepare("SELECT * FROM records WHERE n = 42 AND private = 'sensitive''literal'")
  assert.deepEqual(statement.all('secret parameter'), [{ value: 1 }, { value: 2 }])
  assert.deepEqual(statement.run(), { changes: 3, lastInsertRowid: 5 })
  assert.equal(statement.get(), undefined)
  assert.deepEqual(cached.get('bound secret'), { value: 'bound secret' })
  assert.throws(() => statement.get('fail'), error => error === failure)
  assert.throws(() => db.prepare('invalid'), error => error === failure)
  assert.deepEqual([...statement.iterate()], [{ value: 1 }, { value: 2 }])
  for (const row of statement.iterate()) { assert.equal(row.value, 1); break }
}))
const snapshot = trace.snapshot()
assert.equal(snapshot.summary.databaseOperations, 9)
assert(snapshot.queries.every(query => query.stage === 'database-test'))
assert.equal(snapshot.queries.filter(q => q.operation === 'iterate').reduce((sum, q) => sum + q.rows, 0), 3)
assert.equal(snapshot.queries.find(q => q.operation === 'all').rows, 2)
assert.equal(snapshot.queries.find(q => q.operation === 'run').rows, 3)
assert(!JSON.stringify(snapshot).includes('secret parameter'))
assert(!JSON.stringify(snapshot).includes('sensitive'))
assert(!JSON.stringify(snapshot).includes('never log'))
assert(!JSON.stringify(snapshot).includes('bound secret'))
assert.equal(fingerprintSQL(`SELECT 'foo', "bar", x'CAFE', 42, 1.2e-3, 0xCAFE, .25, @private -- hidden\nFROM data /* hidden */ WHERE id = ?`),
  'SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM data WHERE id = ?')
assert.equal(fingerprintSQL("SELECT 'unterminated secret"), 'SELECT ?')
assert.equal(fingerprintSQL('SELECT /* unterminated secret'), 'SELECT')

// Statement operations outside a traced request remain invisible.
const before = trace.snapshot().summary.databaseOperations
cached.get('outside')
assert.equal(trace.snapshot().summary.databaseOperations, before)
console.log('SQLite performance instrumentation passed')
