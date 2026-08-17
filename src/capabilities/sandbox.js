import fs from 'fs'
import path from 'path'
import { config } from '../config.js'
import { paths } from '../paths.js'

export const SANDBOX_ROOT = path.resolve(paths.sandboxDir)

export function isPathInside(parentDir, candidatePath) {
  const parent = path.resolve(parentDir)
  const candidate = path.resolve(candidatePath)
  const relative = path.relative(parent, candidate)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

// Resolve symlinks/junctions in the nearest existing prefix while retaining a
// not-yet-created suffix. Besides protecting the sandbox boundary, callers that
// atomically replace a file can use the returned target without destroying a
// final path that happens to be a symlink.
export function resolvePathThroughExistingPrefix(candidatePath) {
  const absolute = path.resolve(candidatePath)
  let probe = absolute
  const missingSuffix = []

  while (true) {
    let exists = false
    try {
      fs.lstatSync(probe)
      exists = true
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
    if (exists) {
      const realPrefix = fs.realpathSync(probe)
      return path.resolve(realPrefix, ...missingSuffix)
    }

    const parent = path.dirname(probe)
    if (parent === probe) return absolute
    missingSuffix.unshift(path.basename(probe))
    probe = parent
  }
}

export function assertInSandbox(resolvedPath) {
  if (config.security?.fileSandbox === false) return
  const physicalRoot = resolvePathThroughExistingPrefix(SANDBOX_ROOT)
  const physicalCandidate = resolvePathThroughExistingPrefix(resolvedPath)
  if (physicalCandidate !== physicalRoot && !isPathInside(physicalRoot, physicalCandidate)) {
    throw new Error(`访问被拒绝：文件操作只允许在 sandbox 目录内（${SANDBOX_ROOT}）`)
  }
}

export function normalizeSandboxPath(filePath) {
  if (path.isAbsolute(filePath)) {
    const rel = path.relative(SANDBOX_ROOT, filePath)
    if (!rel.startsWith('..')) return rel || '.'
  }
  return filePath
    .replace(/^sandbox[\\/]/i, '')
    .replace(/^\.[\\/]/, '')
}
