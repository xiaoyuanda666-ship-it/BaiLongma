import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-search-db-secrets-'))
process.env.BAILONGMA_USER_DIR = root
const { paths } = await import('./paths.js')
const legacy = await import('./capabilities/secret-store.js')
const secrets = await import('./search/secret-store.js')
const { getDB, closeDBForTest } = await import('./db/connection.js')
const ref = 'search:yuanbao:apiKey'
try {
  legacy.setSecret(ref, 'legacy-search-secret')
  legacy.setSecret('mcp:unrelated', 'keep-this-secret')
  const originalRecord = JSON.parse(fs.readFileSync(paths.apiCapabilitySecretsFile)).secrets[ref]
  assert.equal(secrets.hasSecret(ref), true)
  assert.equal(secrets.getSecret(ref), 'legacy-search-secret')
  assert.deepEqual(JSON.parse(getDB().prepare('SELECT record_json FROM search_service_secrets WHERE ref = ?').get(ref).record_json), originalRecord)
  assert.equal(legacy.hasSecret(ref), false)
  assert.equal(legacy.getSecret('mcp:unrelated'), 'keep-this-secret')
  const snapshot = () => JSON.stringify(getDB().prepare('SELECT * FROM search_service_secrets ORDER BY ref').all())
  assert.equal(snapshot().includes('legacy-search-secret'), false)
  assert.throws(() => secrets.updateSecrets([{ ref, value: 'bad-commit' }], () => { throw new Error('disk full') }), /disk full/)
  assert.equal(secrets.getSecret(ref), 'legacy-search-secret')
  secrets.updateSecrets([{ ref, value: 'replacement' }])
  closeDBForTest()
  assert.equal(secrets.getSecret(ref), 'replacement', 'persist across reopening the database')

  // Interrupted cleanup must keep durable ciphertext and be safe to retry.
  legacy.setSecret(ref, 'stale-copy')
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (to === paths.apiCapabilitySecretsFile) throw new Error('cleanup failed')
    return rename(from, to)
  }
  try { assert.throws(() => secrets.updateSecrets([{ ref, value: '' }]), /cleanup failed/) }
  finally { fs.renameSync = rename }
  assert.equal(secrets.getSecret(ref), 'replacement', 'the DB wins over stale file copies')
  assert.equal(legacy.hasSecret(ref), false)

  // Losing the fallback encryption key must never replace it silently.
  const master = fs.readFileSync(paths.apiCapabilitySecretKeyFile)
  fs.unlinkSync(paths.apiCapabilitySecretKeyFile)
  const before = snapshot()
  assert.throws(() => secrets.updateSecrets([{ ref, value: 'new' }]), /ENOENT/)
  assert.equal(fs.existsSync(paths.apiCapabilitySecretKeyFile), false)
  assert.equal(snapshot(), before)
  assert.equal(secrets.hasSecret(ref), true, 'status does not decrypt')
  fs.writeFileSync(paths.apiCapabilitySecretKeyFile, master, { mode: 0o600 })
  assert.equal(secrets.getSecret(ref), 'replacement')
  secrets.updateSecrets([{ ref, value: '' }])
  closeDBForTest()
  assert.equal(secrets.hasSecret(ref), false, 'deleted keys do not resurrect on restart')
  assert.equal(legacy.getSecret('mcp:unrelated'), 'keep-this-secret')
  console.log('PASS encrypted database secrets, migration, restart, rollback, cleanup retry, key loss and deletion')
} finally {
  closeDBForTest()
  fs.rmSync(root, { recursive: true, force: true })
}
