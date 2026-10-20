import fs from 'fs'
import path from 'path'
import { paths } from '../paths.js'
import { getSecret, hasSecret, updateSecrets } from '../capabilities/secret-store.js'

const STORE_VERSION = 1
const MASKED_SECRET = '[configured]'
const SERVER_ID_RE = /^[a-z][a-z0-9_-]{0,39}$/
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED_SERVER_IDS = new Set(['builtin_chrome_devtools', 'builtin_playwright', 'builtin_playwright_reader'])

function readStore({ strict = false } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.mcpServersFile, 'utf-8'))
    if (parsed?.version === STORE_VERSION && Array.isArray(parsed.servers)) return parsed
    if (strict) throw new Error('Saved MCP servers have an unsupported or invalid format')
  } catch (error) {
    if (strict && error.code !== 'ENOENT') throw error
  }
  return { version: STORE_VERSION, servers: [] }
}

function writeStore(store) {
  const tmp = `${paths.mcpServersFile}.tmp`
  fs.mkdirSync(path.dirname(paths.mcpServersFile), { recursive: true })
  try {
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 })
    try { fs.chmodSync(tmp, 0o600) } catch {}
    fs.renameSync(tmp, paths.mcpServersFile)
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch {}
  }
}

function normalizeStringArray(value, label, { max = 128 } = {}) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`${label}[${index}] must be a string`)
    if (item.length > 4096) throw new Error(`${label}[${index}] is too long`)
    return item
  }).slice(0, max)
}

function normalizeEnv(value = {}) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('env must be an object')
  const out = {}
  for (const [name, raw] of Object.entries(value)) {
    if (!ENV_NAME_RE.test(name)) throw new Error(`invalid environment variable name: "${name}"`)
    if (typeof raw !== 'string') throw new Error(`env.${name} must be a string`)
    if (raw.length > 16_384) throw new Error(`env.${name} is too long`)
    out[name] = raw
  }
  return out
}

function normalizeStoredServer(raw = {}) {
  const id = String(raw.id || '').trim().toLowerCase()
  if (!SERVER_ID_RE.test(id)) {
    throw new Error('server id must start with a lowercase letter and contain only lowercase letters, numbers, _ or - (max 40)')
  }
  if (RESERVED_SERVER_IDS.has(id)) {
    throw new Error(`server id "${id}" is reserved for a built-in MCP server`)
  }
  const transport = String(raw.transport || 'stdio').trim().toLowerCase()
  if (transport !== 'stdio') throw new Error(`MCP MVP only supports stdio transport (server "${id}")`)
  const command = String(raw.command || '').trim()
  if (!command) throw new Error(`command is required for MCP server "${id}"`)
  if (command.length > 4096) throw new Error(`command is too long for MCP server "${id}"`)
  const cwd = String(raw.cwd || '').trim()
  if (cwd.length > 4096) throw new Error(`cwd is too long for MCP server "${id}"`)
  const timeoutMs = Number(raw.timeoutMs ?? 60_000)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error(`timeoutMs for MCP server "${id}" must be an integer between 1000 and 300000`)
  }
  const envKeys = normalizeStringArray(raw.envKeys, 'envKeys', { max: 64 })
  for (const name of envKeys) {
    if (!ENV_NAME_RE.test(name)) throw new Error(`invalid environment variable name: "${name}"`)
  }
  return {
    id,
    name: String(raw.name || id).trim().slice(0, 120) || id,
    enabled: raw.enabled !== false,
    transport,
    command,
    args: normalizeStringArray(raw.args, 'args'),
    cwd,
    envKeys: [...new Set(envKeys)],
    allowedTools: [...new Set(normalizeStringArray(raw.allowedTools, 'allowedTools'))],
    allowAutonomousReadOnly: raw.allowAutonomousReadOnly === true,
    timeoutMs,
  }
}

function secretRef(serverId, envName) {
  return `mcp:${serverId}:env:${envName}`
}

function publicServer(server) {
  return {
    ...server,
    env: Object.fromEntries((server.envKeys || []).map(name => [
      name,
      hasSecret(secretRef(server.id, name)) ? MASKED_SECRET : '',
    ])),
  }
}

export function getMcpServersConfig() {
  const servers = []
  for (const raw of readStore().servers) {
    try { servers.push(publicServer(normalizeStoredServer(raw))) } catch {}
  }
  return { version: STORE_VERSION, servers }
}

export function getRuntimeMcpServers() {
  const servers = []
  for (const raw of readStore().servers) {
    try {
      const server = normalizeStoredServer(raw)
      const env = {}
      for (const name of server.envKeys) {
        const value = getSecret(secretRef(server.id, name))
        if (value) env[name] = value
      }
      servers.push({ ...server, env })
    } catch {}
  }
  return servers
}

export function setMcpServersConfig(input = {}) {
  const incoming = Array.isArray(input) ? input : input.servers
  if (!Array.isArray(incoming)) throw new Error('servers must be an array')
  if (incoming.length > 32) throw new Error('at most 32 MCP servers may be configured')

  const previous = new Map(readStore({ strict: true }).servers.map(raw => {
    try {
      const server = normalizeStoredServer(raw)
      return [server.id, server]
    } catch {
      return [String(raw?.id || ''), null]
    }
  }))
  const seen = new Set()
  // Validate the complete update before mutating the encrypted secret store.
  // A bad second server must not partially change the first server's secrets.
  const normalizedInputs = incoming.map(raw => {
    const env = normalizeEnv(raw?.env)
    const id = String(raw?.id || '').trim().toLowerCase()
    const prior = previous.get(id)
    const requestedEnvKeys = new Set([
      ...(Array.isArray(raw?.envKeys) ? raw.envKeys : []),
      ...(prior?.envKeys || []),
      ...Object.keys(env),
    ])
    const server = normalizeStoredServer({ ...raw, envKeys: [...requestedEnvKeys] })
    if (seen.has(server.id)) throw new Error(`duplicate MCP server id: "${server.id}"`)
    seen.add(server.id)
    return { env, prior, server }
  })

  const secretUpdates = []
  const servers = normalizedInputs.map(({ env, server }) => {
    const retainedEnvKeys = []
    for (const name of server.envKeys) {
      const value = env[name]
      const ref = secretRef(server.id, name)
      if (value && value !== MASKED_SECRET) {
        secretUpdates.push({ ref, value })
        retainedEnvKeys.push(name)
      } else if (value === '' && Object.prototype.hasOwnProperty.call(env, name)) {
        secretUpdates.push({ ref, value: '' })
      } else if (hasSecret(ref, { strict: true })) {
        retainedEnvKeys.push(name)
      }
    }
    return { ...server, envKeys: retainedEnvKeys }
  })

  for (const prior of previous.values()) {
    if (!prior || seen.has(prior.id)) continue
    for (const name of prior.envKeys || []) secretUpdates.push({ ref: secretRef(prior.id, name), value: '' })
  }

  updateSecrets(secretUpdates, () => writeStore({ version: STORE_VERSION, servers }))
  return getMcpServersConfig()
}

export const __internal = {
  MASKED_SECRET,
  RESERVED_SERVER_IDS,
  normalizeStoredServer,
  secretRef,
}
