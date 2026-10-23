import { performance } from 'node:perf_hooks'
import { getPerformanceTrace } from './performance-trace.js'

const databases = new WeakSet()
const statements = new WeakSet()

// Parameters and SQL literal values must never reach the performance journal.
// Quoted identifiers are also removed because SQLite accepts double-quoted
// string literals. The fingerprint is diagnostic structure, not executable SQL.
export function fingerprintSQL(sql) {
  return String(sql || '')
    .replace(/--[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|[xX]'(?:''|[^'])*'|'(?:''|[^'])*(?:'|$)|"(?:""|[^"])*(?:"|$)|`(?:``|[^`])*(?:`|$)|\[[^\]]*(?:\]|$)/g,
      value => value.startsWith('--') || value.startsWith('/*') ? ' ' : '?')
    .replace(/\b0x[0-9a-f]+\b|(?:\b\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\b/gi, '?')
    .replace(/[:@$][a-z_][a-z0-9_]*/gi, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600)
}

function record(trace, operation, fingerprint, durationMs, rows = 0) {
  // Diagnostics must not change database success/failure semantics.
  try { trace.recordQuery({ operation, fingerprint: fingerprint(), durationMs, rows }) } catch {}
}

function instrumentStatement(statement, fingerprint) {
  if (statements.has(statement)) return statement
  statements.add(statement)
  for (const operation of ['get', 'all', 'run']) {
    const original = statement[operation]
    if (typeof original !== 'function') continue
    statement[operation] = function (...args) {
      const trace = getPerformanceTrace()
      if (!trace || trace.finished) return original.apply(this, args)
      const started = performance.now()
      let rows = 0
      try {
        const result = original.apply(this, args)
        rows = operation === 'all' ? result.length
          : operation === 'get' ? Number(result !== undefined)
            : Number(result?.changes) || 0
        return result
      } finally {
        record(trace, operation, fingerprint, performance.now() - started, rows)
      }
    }
  }
  const originalIterate = statement.iterate
  if (typeof originalIterate === 'function') {
    statement.iterate = function (...args) {
      const trace = getPerformanceTrace()
      if (!trace || trace.finished) return originalIterate.apply(this, args)
      const started = performance.now()
      let iterator
      try {
        iterator = originalIterate.apply(this, args)
      } catch (error) {
        record(trace, 'iterate', fingerprint, performance.now() - started)
        throw error
      }
      let durationMs = performance.now() - started
      let rows = 0
      let done = false
      const finish = () => {
        if (done) return
        done = true
        record(trace, 'iterate', fingerprint, durationMs, rows)
      }
      const advance = (operation, args) => {
        const at = performance.now()
        let result
        try {
          result = typeof iterator[operation] === 'function'
            ? iterator[operation](...args)
            : { done: true, value: args[0] }
          if (operation === 'next' && !result.done) rows++
          return result
        } finally {
          // Measure SQLite iterator steps, excluding the caller's loop body.
          durationMs += performance.now() - at
          if (!result || result.done || operation !== 'next') finish()
        }
      }
      return {
        next: (...args) => advance('next', args),
        return: (...args) => advance('return', args),
        throw: (...args) => advance('throw', args),
        [Symbol.iterator]() { return this },
      }
    }
  }
  return statement
}

// The composition layer applies this once to the shared connection, covering
// facade and repository imports without making Kernel depend on Runtime.
export function instrumentSQLiteDatabase(db) {
  if (!db || databases.has(db)) return db
  databases.add(db)
  const originalPrepare = db.prepare
  db.prepare = function (...args) {
    let cachedFingerprint
    const fingerprint = () => cachedFingerprint ??= fingerprintSQL(args[0])
    const trace = getPerformanceTrace()
    const started = trace && !trace.finished ? performance.now() : null
    let statement
    try {
      statement = originalPrepare.apply(this, args)
    } finally {
      if (started !== null) record(trace, 'prepare', fingerprint, performance.now() - started)
    }
    return instrumentStatement(statement, fingerprint)
  }
  return db
}
