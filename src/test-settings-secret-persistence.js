import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Import only the storage modules, with all paths redirected before loading.
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bailongma-settings-secrets-'))
process.env.BAILONGMA_USER_DIR = userDir
const { paths } = await import('./paths.js')
const { getSecret, setSecret, deleteSecret } = await import('./capabilities/secret-store.js')
const { getMcpServersConfig, getRuntimeMcpServers, setMcpServersConfig } = await import('./mcp/config.js')
const { getMapServiceSettings, setMapServiceSettings, getMapRuntimeConfig, getAmapSecurityCode } = await import('./map-service.js')

const secretFile = paths.apiCapabilitySecretsFile
const mcpFile = paths.mcpServersFile
const keyRef = 'map-service:amap:js-key'
const codeRef = 'map-service:amap:security-code'
const server = (id, env) => ({ id, command: 'test-command', env })
const read = file => fs.readFileSync(file, 'utf8')

function fault(method, fail, action) {
  const original = fs[method]
  fs[method] = function (...args) {
    if (fail(...args)) throw Object.assign(new Error(`Injected ${method} failure`), { code: 'EACCES' })
    return original.apply(this, args)
  }
  try { action() } finally { fs[method] = original }
}

function countSecretWrites(action) {
  const original = fs.renameSync
  let writes = 0
  fs.renameSync = function (from, to) {
    if (to === secretFile) writes += 1
    return original.call(this, from, to)
  }
  try { action() } finally { fs.renameSync = original }
  return writes
}

try {
  // A fresh MCP save that fails after writing secrets must leave no store.
  fault('renameSync', (_from, to) => to === mcpFile, () => {
    assert.throws(() => setMcpServersConfig({ servers: [server('new_server', { TOKEN: 'new-token' })] }), /Injected/)
  })
  assert.equal(fs.existsSync(secretFile), false)
  assert.equal(fs.existsSync(mcpFile), false)

  setMcpServersConfig({ servers: [server('existing', { TOKEN: 'old-token', SECOND: 'old-second' })] })
  setMapServiceSettings({ jsKey: 'old-map-key', securityCode: 'old-map-code' })
  const originalSecrets = read(secretFile)
  const originalMcp = read(mcpFile)

  // Replacing a server adds new credentials and removes the old ones. Roll
  // both operations back when the companion server file cannot be committed.
  fault('renameSync', (_from, to) => to === mcpFile, () => {
    assert.throws(() => setMcpServersConfig({
      servers: [server('replacement', { TOKEN: 'replacement-token' })],
    }), /Injected/)
  })
  assert.equal(read(secretFile), originalSecrets)
  assert.equal(read(mcpFile), originalMcp)
  assert.equal(getRuntimeMcpServers()[0].env.TOKEN, 'old-token')
  assert.equal(getSecret('mcp:replacement:env:TOKEN'), '')
  assert.equal(getSecret(keyRef), 'old-map-key')

  fault('renameSync', (_from, to) => to === secretFile, () => {
    assert.throws(() => setMcpServersConfig({
      servers: [server('existing', { TOKEN: 'changed-token', SECOND: '' })],
    }), /Injected/)
  })
  assert.equal(read(secretFile), originalSecrets)
  assert.equal(read(mcpFile), originalMcp)

  assert.throws(() => setMcpServersConfig({
    servers: [server('existing', { TOKEN: 'changed-token' }), server('INVALID ID', {})],
  }), /server id/)
  assert.equal(read(secretFile), originalSecrets)

  // Masked values preserve existing secrets; omitted values are unchanged.
  setMcpServersConfig({ servers: [server('existing', { TOKEN: '[configured]' })] })
  assert.equal(getRuntimeMcpServers()[0].env.TOKEN, 'old-token')
  assert.equal(getRuntimeMcpServers()[0].env.SECOND, 'old-second')
  assert.equal(read(secretFile), originalSecrets)
  assert.equal(countSecretWrites(() => setMcpServersConfig({
    servers: [server('existing', { TOKEN: 'changed-token', SECOND: '' }), server('second', { TOKEN: 'second-token' })],
  })), 1)
  assert.deepEqual(getRuntimeMcpServers()[0].env, { TOKEN: 'changed-token' })
  assert.equal(getMcpServersConfig().servers[1].env.TOKEN, '[configured]')
  assert.equal(getSecret('mcp:existing:env:SECOND'), '')
  assert.equal(countSecretWrites(() => setMcpServersConfig({ servers: [] })), 1)
  assert.equal(getSecret('mcp:existing:env:TOKEN'), '')
  assert.equal(getSecret('mcp:second:env:TOKEN'), '')
  assert.equal(getSecret(codeRef), 'old-map-code')

  // Encryption of the second map field must finish before either is saved.
  const mapBefore = read(secretFile)
  const originalCipher = crypto.createCipheriv
  let encrypted = 0
  crypto.createCipheriv = function (...args) {
    encrypted += 1
    if (encrypted === 2) throw new Error('Injected second encryption failure')
    return originalCipher.apply(this, args)
  }
  try {
    assert.throws(() => setMapServiceSettings({ jsKey: 'new-map-key', securityCode: 'new-map-code' }), /second encryption/)
  } finally {
    crypto.createCipheriv = originalCipher
  }
  assert.equal(read(secretFile), mapBefore)
  fault('renameSync', (_from, to) => to === secretFile, () => {
    assert.throws(() => setMapServiceSettings({ clear: true }), /Injected/)
  })
  assert.equal(read(secretFile), mapBefore)
  assert.equal(countSecretWrites(() => setMapServiceSettings({ jsKey: 'new-map-key', securityCode: 'new-map-code' })), 1)
  assert.equal(getMapRuntimeConfig().jsKey, 'new-map-key')
  assert.equal(getAmapSecurityCode(), 'new-map-code')
  assert.equal(countSecretWrites(() => setMapServiceSettings({ clear: true })), 1)
  assert.equal(getMapServiceSettings().configured, false)
  assert.equal(getSecret(keyRef), '')
  assert.equal(getSecret(codeRef), '')

  // Broken or temporarily unreadable files must never become an empty store.
  setSecret(keyRef, 'preserved-map-key')
  setMcpServersConfig({ servers: [server('existing', { TOKEN: 'preserved-token' })] })
  const goodSecrets = read(secretFile)
  const goodMcp = read(mcpFile)
  for (const contents of ['{ damaged', '{"version":999,"secrets":{}}', '{"version":1,"secrets":[]}']) {
    fs.writeFileSync(secretFile, contents)
    assert.throws(() => setSecret(codeRef, 'new-code'))
    assert.throws(() => deleteSecret(keyRef))
    assert.throws(() => setMcpServersConfig({ servers: [server('existing', { TOKEN: '[configured]' })] }))
    assert.equal(read(secretFile), contents)
    assert.equal(read(mcpFile), goodMcp)
  }
  fs.writeFileSync(secretFile, goodSecrets)
  for (const contents of ['{ damaged', '{"version":999,"servers":[]}']) {
    fs.writeFileSync(mcpFile, contents)
    assert.throws(() => setMcpServersConfig({ servers: [] }))
    assert.equal(read(mcpFile), contents)
    assert.equal(read(secretFile), goodSecrets)
  }
  fs.writeFileSync(mcpFile, goodMcp)
  fault('readFileSync', file => file === secretFile, () => {
    assert.throws(() => setMapServiceSettings({ clear: true }), /Injected/)
  })
  fault('readFileSync', file => file === mcpFile, () => {
    assert.throws(() => setMcpServersConfig({ servers: [] }), /Injected/)
  })
  assert.equal(read(secretFile), goodSecrets)
  assert.equal(read(mcpFile), goodMcp)

  // Never replace an invalid/missing master key while old credentials exist.
  const goodKey = read(paths.apiCapabilitySecretKeyFile)
  fs.writeFileSync(paths.apiCapabilitySecretKeyFile, 'invalid-key')
  assert.throws(() => setSecret(codeRef, 'new-code'), /invalid format/)
  assert.equal(read(paths.apiCapabilitySecretKeyFile), 'invalid-key')
  assert.equal(read(secretFile), goodSecrets)
  fs.rmSync(paths.apiCapabilitySecretKeyFile)
  assert.equal(getSecret(keyRef), '')
  assert.equal(fs.existsSync(paths.apiCapabilitySecretKeyFile), false)
  assert.throws(() => setSecret(codeRef, 'new-code'), /key is missing/)
  assert.equal(fs.existsSync(paths.apiCapabilitySecretKeyFile), false)
  assert.equal(read(secretFile), goodSecrets)
  fs.writeFileSync(paths.apiCapabilitySecretKeyFile, goodKey)
  assert.equal(getSecret(keyRef), 'preserved-map-key')
  assert.equal(getRuntimeMcpServers()[0].env.TOKEN, 'preserved-token')

  console.log('PASS: MCP and map settings commit atomically, roll back failed saves, and preserve unreadable stores')
} finally {
  fs.rmSync(userDir, { recursive: true, force: true })
}
