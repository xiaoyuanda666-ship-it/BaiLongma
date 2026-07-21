import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const STORE_VERSION = 2
const PROFILE_ID_PATTERN = /^bpp_[a-f0-9]{40}$/

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code !== 'ESRCH'
  }
}

function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')) } catch { return null }
}

function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  fs.renameSync(temporary, filename)
}

function removeTree(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}

function scopeValue(context = {}) {
  for (const candidate of [context.browserProfileScope, context.taskId, context.currentTargetId]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  // Direct manager consumers (tests, packaged smoke, local integrations) do
  // not have an Agent turn context. They still get an isolated, explicit
  // namespace rather than being mixed into a hidden "default" profile.
  return 'local-direct-consumer'
}

export function browserProfileIdentity({ root, profile, url, context = {} }) {
  const parsed = new URL(url)
  const origin = parsed.origin
  const scopeDigest = digest(scopeValue(context))
  const id = `bpp_${digest(`${STORE_VERSION}\0${scopeDigest}\0${origin}\0${profile}`).slice(0, 40)}`
  const profileRoot = path.join(root, 'v2', 'profiles', id)
  return {
    id,
    name: profile,
    origin,
    scopeDigest,
    profileRoot,
    dataPath: path.join(profileRoot, 'data'),
    metadataPath: path.join(profileRoot, 'profile.json'),
    lockPath: path.join(root, 'v2', 'locks', `${id}.lock`),
  }
}

export class BrowserProfileStore {
  constructor({
    root, now = Date.now, pid = process.pid, processAlive = processIsAlive,
    lockRecoveryMs = 30_000, removeTreeAsync = target => fs.promises.rm(target, { recursive: true, force: true }),
    renameAsync = (source, destination) => fs.promises.rename(source, destination),
  }) {
    this.root = path.resolve(root)
    this.now = now
    this.pid = pid
    this.processAlive = processAlive
    this.lockRecoveryMs = Math.max(1_000, Number(lockRecoveryMs) || 30_000)
    this.removeTreeAsync = removeTreeAsync
    this.renameAsync = renameAsync
    this.profilesRoot = path.join(this.root, 'v2', 'profiles')
    this.locksRoot = path.join(this.root, 'v2', 'locks')
    this.trashRoot = path.join(this.root, 'v2', 'trash')
    this.heldLocks = new Map()
    for (const directory of [this.profilesRoot, this.locksRoot, this.trashRoot]) {
      fs.mkdirSync(directory, { recursive: true })
    }
    this.#recoverInterruptedDeletes()
  }

  identity(profile, url, context) {
    return browserProfileIdentity({ root: this.root, profile, url, context })
  }

  prepare(identity) {
    fs.mkdirSync(identity.dataPath, { recursive: true })
    const current = readJson(identity.metadataPath)
    if (!current && fs.existsSync(identity.metadataPath)) {
      throw new Error(`Persistent browser profile metadata is unreadable: ${identity.id}`)
    }
    if (current && (current.id !== identity.id || current.origin !== identity.origin || current.name !== identity.name || current.scope_digest !== identity.scopeDigest)) {
      throw new Error(`Persistent browser profile metadata does not match ${identity.id}`)
    }
    if (!current) {
      writeJsonAtomic(identity.metadataPath, {
        version: STORE_VERSION,
        id: identity.id,
        name: identity.name,
        origin: identity.origin,
        scope_digest: identity.scopeDigest,
        created_at: new Date(this.now()).toISOString(),
      })
    }
    return identity.dataPath
  }

  list(context = {}) {
    const expectedScope = digest(scopeValue(context))
    const profiles = []
    let entries = []
    try { entries = fs.readdirSync(this.profilesRoot, { withFileTypes: true }) } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROFILE_ID_PATTERN.test(entry.name)) continue
      const metadata = readJson(path.join(this.profilesRoot, entry.name, 'profile.json'))
      if (!metadata || metadata.scope_digest !== expectedScope || metadata.id !== entry.name) continue
      profiles.push({
        profile_id: metadata.id,
        profile: String(metadata.name || ''),
        site: String(metadata.origin || ''),
        in_use: this.#isLocked(metadata.id),
      })
    }
    profiles.sort((a, b) => a.site.localeCompare(b.site) || a.profile.localeCompare(b.profile))
    return profiles
  }

  acquire(identity) {
    if (this.heldLocks.has(identity.id)) {
      const err = new Error(`Persistent browser profile is already in use: ${identity.name} (${identity.origin})`)
      err.code = 'PROFILE_IN_USE'
      throw err
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.mkdirSync(identity.lockPath)
        const lock = {
          profileId: identity.id,
          path: identity.lockPath,
          token: crypto.randomBytes(18).toString('hex'),
        }
        fs.writeFileSync(path.join(identity.lockPath, 'owner.json'), `${JSON.stringify({
          version: STORE_VERSION,
          pid: this.pid,
          token: lock.token,
          acquired_at_ms: this.now(),
        })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        this.heldLocks.set(identity.id, lock)
        return lock
      } catch (err) {
        if (err?.code !== 'EEXIST') {
          // mkdir may have succeeded while owner creation failed. Only remove a
          // lock directory that has no owner; never disturb a proven owner.
          if (!readJson(path.join(identity.lockPath, 'owner.json'))) {
            try { removeTree(identity.lockPath) } catch {}
          }
          throw err
        }
        if (!this.#recoverStaleLock(identity.lockPath)) {
          const inUse = new Error(`Persistent browser profile is already in use: ${identity.name} (${identity.origin})`)
          inUse.code = 'PROFILE_IN_USE'
          throw inUse
        }
      }
    }
    const err = new Error(`Could not acquire persistent browser profile: ${identity.name}`)
    err.code = 'PROFILE_LOCK_FAILED'
    throw err
  }

  release(lock) {
    if (!lock) return
    const held = this.heldLocks.get(lock.profileId)
    if (!held || held.token !== lock.token) return
    const owner = readJson(path.join(lock.path, 'owner.json'))
    if (owner?.token === lock.token && owner?.pid === this.pid) {
      try { removeTree(lock.path) } catch {}
    }
    this.heldLocks.delete(lock.profileId)
  }

  async clear(identity) {
    if (!fs.existsSync(identity.profileRoot)) return false
    const trash = path.join(this.trashRoot, `${identity.id}-${this.now()}-${crypto.randomBytes(6).toString('hex')}`)
    await this.#retryWindowsFs(() => this.renameAsync(identity.profileRoot, trash))
    await this.#removeTreeEventually(trash)
    return true
  }

  #recoverStaleLock(lockPath) {
    const ownerPath = path.join(lockPath, 'owner.json')
    const owner = readJson(ownerPath)
    if (owner && Number.isSafeInteger(owner.pid)) {
      if (this.processAlive(owner.pid)) return false
    } else {
      let age = 0
      try { age = this.now() - fs.statSync(lockPath).mtimeMs } catch { return true }
      // A creator can be between atomic mkdir and owner.json. Only malformed
      // ownerless locks older than the grace window are crash debris.
      if (age < this.lockRecoveryMs) return false
    }
    try {
      removeTree(lockPath)
      return true
    } catch {
      return false
    }
  }

  #isLocked(profileId) {
    const lockPath = path.join(this.locksRoot, `${profileId}.lock`)
    if (!fs.existsSync(lockPath)) return false
    return !this.#recoverStaleLock(lockPath)
  }

  #recoverInterruptedDeletes() {
    let entries = []
    try { entries = fs.readdirSync(this.trashRoot, { withFileTypes: true }) } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try { removeTree(path.join(this.trashRoot, entry.name)) } catch {}
    }
  }

  async #removeTreeEventually(target) {
    return this.#retryWindowsFs(() => this.removeTreeAsync(target))
  }

  async #retryWindowsFs(operation) {
    let lastError
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { return await operation() } catch (err) {
        lastError = err
        if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err?.code)) throw err
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    throw lastError
  }
}
