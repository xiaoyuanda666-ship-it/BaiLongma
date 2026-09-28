import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// System mechanisms only. The caller must supply the authority for every path.
// Revalidate each operation so retaining a port does not retain stale permission.
export function createFilesystemPort({ assertAccess } = {}) {
  if (typeof assertAccess !== 'function') throw new TypeError('assertAccess is required')
  const checked = (filePath) => { assertAccess(filePath); return filePath }

  function readUtf8Strict(filePath) {
    const buffer = fs.readFileSync(checked(filePath))
    try {
      // Validate without using TextDecoder's output so an existing UTF-8 BOM is
      // retained by Buffer.toString and survives a local edit unchanged.
      new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      return null
    }
    return buffer.toString('utf8')
  }

  function existingFileMode(filePath) {
    checked(filePath)
    try {
      return fs.statSync(filePath).mode & 0o777
    } catch {
      return 0o666
    }
  }

  // Write through a sibling temporary file so readers never observe a half-written
  // document. For create-only writes, link(2) provides an atomic "fail if exists"
  // boundary instead of doing a racy existsSync + rename pair.
  function atomicWriteUtf8(filePath, content, { failIfExists = false } = {}) {
    checked(filePath)
    const body = String(content)
    const tempPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    )
    let fd = null
    try {
      checked(tempPath)
      fd = fs.openSync(tempPath, 'wx', existingFileMode(filePath))
      fs.writeFileSync(fd, body, 'utf8')
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = null

      checked(filePath)
      if (failIfExists) {
        fs.linkSync(tempPath, filePath)
      } else {
        fs.renameSync(tempPath, filePath)
      }
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd) } catch {}
      }
      try { fs.unlinkSync(tempPath) } catch {}
    }
  }

  return Object.freeze({
    readUtf8Strict,
    atomicWriteUtf8,
    readFileSync: (filePath, encoding) => fs.readFileSync(checked(filePath), encoding),
    existsSync: (filePath) => fs.existsSync(checked(filePath)),
    statSync: (filePath) => fs.statSync(checked(filePath)),
    readdirSync: (filePath, options) => fs.readdirSync(checked(filePath), options),
    mkdirSync: (filePath, options) => fs.mkdirSync(checked(filePath), options),
    rmSync: (filePath, options) => fs.rmSync(checked(filePath), options),
    unlinkSync: (filePath) => fs.unlinkSync(checked(filePath)),
  })
}
