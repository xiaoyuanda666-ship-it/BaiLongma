import fs from 'fs'
import path from 'path'
import { getDB } from '../../db.js'
import { emitEvent as defaultEmitEvent } from '../../events.js'
import { paths } from '../../paths.js'
import { startLoop as defaultStartLoop, stopLoop as defaultStopLoop } from '../../control.js'
import { clearTraces, getTrace, getTraces, getTraceStatus } from '../../runtime/turn-trace.js'
import { jsonResponse } from '../utils.js'

function contextFunction(context, name, fallback) {
  const source = context || {}
  return typeof source[name] === 'function' ? source[name].bind(source) : fallback
}

function getAdminContext(context = {}) {
  const source = context || {}
  return {
    emitEvent: contextFunction(source, 'emitEvent', defaultEmitEvent),
    getDB: contextFunction(source, 'getDB', getDB),
    sandboxPath: source.sandboxPath || paths.sandboxDir,
    startLoop: contextFunction(source, 'startLoop', defaultStartLoop),
    stopLoop: contextFunction(source, 'stopLoop', defaultStopLoop),
    restartApp: contextFunction(source, 'restartApp'),
    exitProcess: contextFunction(source, 'exitProcess'),
    restartDelayMs: source.restartDelayMs ?? 500,
  }
}

function clearSandboxFiles(sandboxPath) {
  const keep = new Set(['readme.txt', 'world.txt'])

  function clearDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        clearDir(full)
        try { fs.rmdirSync(full) } catch (_) {}
      } else if (!keep.has(entry.name.toLowerCase())) {
        fs.unlinkSync(full)
      }
    }
  }

  try { clearDir(sandboxPath) } catch (_) {}
}

export async function handleAdminRoutes(req, res, url, context = {}) {
  const admin = getAdminContext(context)

  if (req.method === 'GET' && url.pathname === '/admin/traces') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '80'), 80)
    jsonResponse(res, 200, { ok: true, status: getTraceStatus(), traces: getTraces(limit) })
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/admin/traces/')) {
    const id = decodeURIComponent(url.pathname.slice('/admin/traces/'.length))
    const trace = getTrace(id)
    if (!trace) {
      jsonResponse(res, 404, { ok: false, error: 'trace not found' })
      return true
    }
    jsonResponse(res, 200, { ok: true, trace })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/admin/traces-clear') {
    jsonResponse(res, 200, clearTraces())
    return true
  }

  if (req.method === 'POST' && url.pathname === '/admin/stop') {
    admin.stopLoop()
    admin.emitEvent('admin', { action: 'stop', running: false })
    jsonResponse(res, 200, { ok: true, running: false })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/admin/start') {
    admin.startLoop()
    admin.emitEvent('admin', { action: 'start', running: true })
    jsonResponse(res, 200, { ok: true, running: true })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/admin/restart') {
    jsonResponse(res, 200, { ok: true, message: 'Restarting...' })
    setTimeout(() => {
      const restart = admin.restartApp || globalThis.jarvisAppControl?.restart
      if (typeof restart === 'function') {
        restart()
        return
      }
      const exitProcess = admin.exitProcess || process.exit.bind(process)
      exitProcess(0)
    }, admin.restartDelayMs)
    return true
  }

  if (req.method === 'POST' && url.pathname === '/admin/reset-memories') {
    const db = admin.getDB()
    db.prepare('DELETE FROM memories').run()
    db.prepare('DELETE FROM conversations').run()
    db.prepare("DELETE FROM config WHERE key != 'birth_time'").run()
    db.prepare('DELETE FROM entities').run()
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
    admin.emitEvent('admin', { action: 'reset-memories' })
    jsonResponse(res, 200, { ok: true })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/admin/reset-files') {
    clearSandboxFiles(admin.sandboxPath)
    admin.emitEvent('admin', { action: 'reset-files' })
    jsonResponse(res, 200, { ok: true })
    return true
  }

  return false
}
