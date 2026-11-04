import fs from 'node:fs'
import { getDB } from '../db/connection.js'
import { paths } from '../paths.js'
import { encryptSecret, decryptSecret, updateSecrets as updateLegacySecrets } from '../capabilities/secret-store.js'

const validRef = ref => /^search:[a-z][a-z0-9_-]{0,63}:apiKey$/.test(ref)

// Copy ciphertext before removing the old entries. A crash between these steps
// leaves a recoverable duplicate; the database always wins on the next attempt.
export function migrateSearchSecrets() {
  let legacy
  try { legacy = JSON.parse(fs.readFileSync(paths.apiCapabilitySecretsFile, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (legacy?.version !== 1 || !legacy.secrets || typeof legacy.secrets !== 'object' || Array.isArray(legacy.secrets)) {
    throw new Error('Saved secrets have an unsupported or invalid format')
  }
  const entries = Object.entries(legacy.secrets).filter(([ref]) => validRef(ref))
  if (!entries.length) return
  const db = getDB()
  db.transaction(() => {
    const insert = db.prepare('INSERT OR IGNORE INTO search_service_secrets (ref, record_json, updated_at) VALUES (?, ?, ?)')
    for (const [ref, record] of entries) {
      if (!record || typeof record.value !== 'string' || !record.value) throw new Error('Invalid legacy search credential')
      const encrypted = record.scheme === 'plain' ? encryptSecret(record.value) : record
      if (!['electron-safe-storage', 'aes-256-gcm'].includes(encrypted.scheme)) throw new Error('Unsupported search credential encryption')
      insert.run(ref, JSON.stringify(encrypted), record.updatedAt || new Date().toISOString())
    }
  })()
  // Refuse subsequent writes until cleanup succeeds, so a deleted credential
  // can never be resurrected from an old file on restart.
  updateLegacySecrets(entries.map(([ref]) => ({ ref, value: '' })))
}

function database() {
  migrateSearchSecrets()
  return getDB()
}

export function getSecret(ref) {
  if (!validRef(ref)) return ''
  const row = database().prepare('SELECT record_json FROM search_service_secrets WHERE ref = ?').get(ref)
  return row ? decryptSecret(JSON.parse(row.record_json)) : ''
}

export function hasSecret(ref) {
  if (!validRef(ref)) return false
  // Status reads never decrypt or prompt for macOS Keychain access.
  return !!database().prepare('SELECT 1 FROM search_service_secrets WHERE ref = ?').get(ref)
}

export function updateSecrets(updates, commit) {
  if (!Array.isArray(updates)) throw new Error('secret updates must be an array')
  if (commit !== undefined && typeof commit !== 'function') throw new Error('commit must be a function')
  const normalized = updates.map(({ ref, value }) => {
    if (!validRef(ref)) throw new Error('Invalid search credential reference')
    return { ref, value: String(value || '') }
  })
  const db = database()
  // Do not silently generate a new encryption key over existing ciphertext.
  if (normalized.some(item => item.value) && db.prepare("SELECT 1 FROM search_service_secrets WHERE json_extract(record_json, '$.scheme') = 'aes-256-gcm' LIMIT 1").get()) {
    const key = fs.readFileSync(paths.apiCapabilitySecretKeyFile, 'utf8').trim()
    if (Buffer.from(key, 'base64').length < 32) throw new Error('Saved secret encryption key is invalid')
  }
  const encrypted = normalized.map(item => ({ ...item, record: item.value ? encryptSecret(item.value) : null }))
  return db.transaction(() => {
    let changed = 0
    for (const { ref, record } of encrypted) {
      if (record) {
        changed += db.prepare(`INSERT INTO search_service_secrets (ref, record_json, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(ref) DO UPDATE SET record_json = excluded.record_json, updated_at = excluded.updated_at`)
          .run(ref, JSON.stringify(record), new Date().toISOString()).changes
      } else changed += db.prepare('DELETE FROM search_service_secrets WHERE ref = ?').run(ref).changes
    }
    commit?.()
    return changed
  })()
}
