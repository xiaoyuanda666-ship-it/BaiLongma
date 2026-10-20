import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { paths } from '../paths.js'

const STORE_VERSION = 1
const SAFE_STORAGE_SCHEME = 'electron-safe-storage'
const FALLBACK_SCHEME = 'aes-256-gcm'
const PLAIN_SCHEME = 'plain'
const require = createRequire(import.meta.url)

function nowIso() {
  return new Date().toISOString()
}

function readJsonFile(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function writeJsonFile(file, value) {
  writeFileAtomically(file, JSON.stringify(value, null, 2))
}

function writeFileAtomically(file, contents) {
  const tmp = `${file}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(tmp, contents, { encoding: 'utf-8', mode: 0o600 })
    try { fs.chmodSync(tmp, 0o600) } catch {}
    fs.renameSync(tmp, file)
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch {}
  }
}

function readStoreForUpdate() {
  let original
  try {
    original = fs.readFileSync(paths.apiCapabilitySecretsFile)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { original: null, store: { version: STORE_VERSION, secrets: {} } }
  }
  const store = JSON.parse(original.toString('utf-8'))
  if (store?.version !== STORE_VERSION || !store.secrets
    || typeof store.secrets !== 'object' || Array.isArray(store.secrets)) {
    throw new Error('Saved secrets have an unsupported or invalid format')
  }
  return { original, store }
}

function readStore() {
  const parsed = readJsonFile(paths.apiCapabilitySecretsFile, null)
  if (parsed && parsed.version === STORE_VERSION && parsed.secrets && typeof parsed.secrets === 'object') {
    return migratePlainSecrets(parsed)
  }
  return { version: STORE_VERSION, secrets: {} }
}

function migratePlainSecrets(store, { persist = true } = {}) {
  let changed = false
  const secrets = store?.secrets && typeof store.secrets === 'object' ? store.secrets : {}
  for (const [key, record] of Object.entries(secrets)) {
    if (!record || record.scheme !== PLAIN_SCHEME) continue
    const value = String(record.value || '')
    if (!value) continue
    secrets[key] = {
      ...encryptSecret(value),
      updatedAt: nowIso(),
    }
    changed = true
  }
  if (changed && persist) writeStore(store)
  return store
}

function writeStore(store) {
  writeJsonFile(paths.apiCapabilitySecretsFile, {
    version: STORE_VERSION,
    secrets: store?.secrets && typeof store.secrets === 'object' ? store.secrets : {},
  })
}

function getSafeStorage() {
  if (!process.versions?.electron) return null
  try {
    const safeStorage = require('electron')?.safeStorage
    if (safeStorage?.isEncryptionAvailable?.()) return safeStorage
  } catch {}
  return null
}

function approveSafeStorageAccess(purpose = 'saved-secrets') {
  const request = globalThis.bailongmaRequestSafeStorageAccessSync
  if (typeof request !== 'function') return true
  try { return request(purpose) === true } catch { return false }
}

function readFallbackMasterKey({ create = true } = {}) {
  try {
    const raw = fs.readFileSync(paths.apiCapabilitySecretKeyFile, 'utf-8').trim()
    const key = Buffer.from(raw, 'base64')
    if (key.length >= 32) return key.subarray(0, 32)
    throw new Error('Saved secret encryption key has an invalid format')
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error
  }
  const { store } = readStoreForUpdate()
  if (Object.values(store.secrets).some(record => record?.scheme === FALLBACK_SCHEME)) {
    throw new Error('Saved secret encryption key is missing; existing credentials must be recovered before saving')
  }

  const key = crypto.randomBytes(32)
  fs.mkdirSync(path.dirname(paths.apiCapabilitySecretKeyFile), { recursive: true })
  fs.writeFileSync(paths.apiCapabilitySecretKeyFile, key.toString('base64'), { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
  try { fs.chmodSync(paths.apiCapabilitySecretKeyFile, 0o600) } catch {}
  return key
}

function encryptSecret(value) {
  const text = String(value || '')
  const safeStorage = getSafeStorage()
  if (safeStorage && approveSafeStorageAccess('saved-secrets')) {
    return {
      scheme: SAFE_STORAGE_SCHEME,
      value: safeStorage.encryptString(text).toString('base64'),
    }
  }

  const key = readFallbackMasterKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(FALLBACK_SCHEME, key, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf-8'), cipher.final()])
  return {
    scheme: FALLBACK_SCHEME,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    value: encrypted.toString('base64'),
  }
}

function decryptSecret(record) {
  if (!record || typeof record !== 'object') return ''
  try {
    if (record.scheme === SAFE_STORAGE_SCHEME) {
      if (!approveSafeStorageAccess('saved-secrets')) return ''
      const safeStorage = getSafeStorage()
      if (!safeStorage) return ''
      return safeStorage.decryptString(Buffer.from(String(record.value || ''), 'base64'))
    }
    if (record.scheme === FALLBACK_SCHEME) {
      const key = readFallbackMasterKey({ create: false })
      const decipher = crypto.createDecipheriv(FALLBACK_SCHEME, key, Buffer.from(String(record.iv || ''), 'base64'))
      decipher.setAuthTag(Buffer.from(String(record.tag || ''), 'base64'))
      return Buffer.concat([
        decipher.update(Buffer.from(String(record.value || ''), 'base64')),
        decipher.final(),
      ]).toString('utf-8')
    }
    if (record.scheme === PLAIN_SCHEME) return String(record.value || '')
  } catch {}
  return ''
}

export function setSecret(ref, value) {
  const key = String(ref || '').trim()
  const secret = String(value || '')
  if (!key) throw new Error('secret ref required')
  if (!secret) {
    deleteSecret(key)
    return false
  }
  updateSecrets([{ ref: key, value: secret }])
  return true
}

// Apply a complete settings update in one atomic secret-file replacement.
// The optional synchronous commit writes its companion configuration file; if
// that fails, restore the original encrypted bytes without decrypting anything.
export function updateSecrets(updates, commit) {
  if (!Array.isArray(updates)) throw new Error('secret updates must be an array')
  if (commit !== undefined && typeof commit !== 'function') throw new Error('commit must be a function')
  const normalized = updates.map(({ ref, value }) => {
    const key = String(ref || '').trim()
    if (!key) throw new Error('secret ref required')
    return { key, value: String(value || '') }
  })
  if (!normalized.length) {
    commit?.()
    return 0
  }

  const { original, store } = readStoreForUpdate()
  let changed = 0
  for (const { key, value } of normalized) {
    if (value) {
      store.secrets[key] = { ...encryptSecret(value), updatedAt: nowIso() }
      changed += 1
    } else if (Object.prototype.hasOwnProperty.call(store.secrets, key)) {
      delete store.secrets[key]
      changed += 1
    }
  }
  if (changed) {
    migratePlainSecrets(store, { persist: false })
    writeStore(store)
  }
  try {
    commit?.()
  } catch (error) {
    if (changed) {
      try {
        if (original === null) fs.rmSync(paths.apiCapabilitySecretsFile, { force: true })
        else writeFileAtomically(paths.apiCapabilitySecretsFile, original)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError],
          `Configuration save failed and saved secrets could not be restored: ${error.message}; ${rollbackError.message}`)
      }
    }
    throw error
  }
  return changed
}

export function getSecret(ref) {
  const key = String(ref || '').trim()
  if (!key) return ''
  return decryptSecret(readStore().secrets[key])
}

export function hasSecret(ref, { strict = false } = {}) {
  const key = String(ref || '').trim()
  if (!key) return false
  const store = strict
    ? readStoreForUpdate().store
    : readJsonFile(paths.apiCapabilitySecretsFile, null)
  const record = store?.version === STORE_VERSION && store?.secrets?.[key]
  // Configuration/status checks must not decrypt a value: they run during
  // startup and must never trigger a macOS Keychain password prompt.
  return Boolean(record && typeof record === 'object' && String(record.value || ''))
}

export function deleteSecret(ref) {
  const key = String(ref || '').trim()
  if (!key) return false
  return updateSecrets([{ ref: key, value: '' }]) > 0
}

export const __internal = {
  FALLBACK_SCHEME,
  PLAIN_SCHEME,
  SAFE_STORAGE_SCHEME,
  decryptSecret,
  encryptSecret,
}
