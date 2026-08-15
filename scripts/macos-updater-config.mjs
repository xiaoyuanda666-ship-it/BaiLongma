import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

export const MAC_UPDATE_PROVIDER = 'generic'
export const MAC_UPDATE_CHANNEL = 'latest'
export const MAC_UPDATER_CACHE_DIR = 'bailongma-updater'
export const MAC_UPDATE_BASE_URL = 'https://updates.bailongma.ai/stable/mac'

const SUPPORTED_ARCHS = new Set(['x64', 'arm64'])

function assertArch(arch) {
  if (!SUPPORTED_ARCHS.has(arch)) throw new Error(`Unsupported macOS updater architecture: ${arch}`)
}

export function expectedMacUpdaterUrl(arch) {
  assertArch(arch)
  return `${MAC_UPDATE_BASE_URL}/${arch}`
}

function firstPublishConfig(publish) {
  const config = Array.isArray(publish) ? publish[0] : publish
  if (!config || typeof config !== 'object') throw new Error('macOS publish configuration is missing')
  return config
}

export function createMacUpdaterConfig({ arch, publish, updaterCacheDirName = MAC_UPDATER_CACHE_DIR }) {
  assertArch(arch)
  const source = firstPublishConfig(publish)
  const url = typeof source.url === 'string'
    ? source.url.replaceAll('${os}', 'mac').replaceAll('${arch}', arch)
    : source.url
  const config = {
    provider: source.provider,
    url,
    channel: source.channel,
    updaterCacheDirName,
  }
  assertMacUpdaterConfig(config, arch, `${arch} generated app-update.yml`)
  return config
}

export function parseMacUpdaterConfig(contents, label = 'app-update.yml') {
  let config
  try {
    config = yaml.load(String(contents || ''))
  } catch (error) {
    throw new Error(`${label} is not valid YAML: ${error.message}`)
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${label} does not contain an updater configuration`)
  }
  return config
}

export function assertMacUpdaterConfig(configOrContents, arch, label = 'app-update.yml') {
  assertArch(arch)
  const config = typeof configOrContents === 'string' || Buffer.isBuffer(configOrContents)
    ? parseMacUpdaterConfig(configOrContents, label)
    : configOrContents
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${label} does not contain an updater configuration`)
  }
  const expected = {
    provider: MAC_UPDATE_PROVIDER,
    url: expectedMacUpdaterUrl(arch),
    channel: MAC_UPDATE_CHANNEL,
    updaterCacheDirName: MAC_UPDATER_CACHE_DIR,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (config[key] !== value) {
      throw new Error(`${label} has ${key}=${JSON.stringify(config[key])}; expected ${JSON.stringify(value)} for ${arch}`)
    }
  }
  const otherArch = arch === 'x64' ? 'arm64' : 'x64'
  if (String(config.url).includes(`/mac/${otherArch}`)) {
    throw new Error(`${label} for ${arch} references the ${otherArch} update path`)
  }
  return config
}

export function serializeMacUpdaterConfig(config) {
  return yaml.dump(config, { lineWidth: -1, noRefs: true, sortKeys: false })
}

export function updaterConfigPathForApp(appPath) {
  return path.join(appPath, 'Contents', 'Resources', 'app-update.yml')
}

export function writeMacUpdaterConfig({ appPath, arch, publish, updaterCacheDirName }) {
  const config = createMacUpdaterConfig({ arch, publish, updaterCacheDirName })
  const configPath = updaterConfigPathForApp(appPath)
  const resourcesPath = path.dirname(configPath)
  if (!fs.statSync(resourcesPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Packaged app Resources directory is missing: ${resourcesPath}`)
  }
  fs.writeFileSync(configPath, serializeMacUpdaterConfig(config), { mode: 0o644 })
  assertMacUpdaterConfig(fs.readFileSync(configPath), arch, configPath)
  return configPath
}

export function assertMacUpdaterConfigFile(configPath, arch, label = configPath) {
  if (!fs.statSync(configPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${label} is missing: ${configPath}`)
  }
  return assertMacUpdaterConfig(fs.readFileSync(configPath), arch, label)
}
