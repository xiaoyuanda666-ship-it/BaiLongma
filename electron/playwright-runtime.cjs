const path = require('path')
const fs = require('fs')

const PLAYWRIGHT_BROWSER_RESOURCE_DIR = 'playwright-browsers'
const NODE_RUNTIME_RESOURCE_DIR = 'node-runtime'

function packagedHostPlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return 'win64'
  if (platform === 'darwin' && arch === 'x64') return 'mac15'
  if (platform === 'darwin' && arch === 'arm64') return 'mac15-arm64'
  if (platform === 'linux' && arch === 'x64') return 'ubuntu24.04-x64'
  throw new Error(`Unsupported packaged Playwright target: ${platform}-${arch}`)
}

function configurePackagedPlaywright({
  isPackaged,
  resourcesPath = process.resourcesPath,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
} = {}) {
  if (!isPackaged) return null
  if (!resourcesPath) throw new Error('process.resourcesPath is unavailable in packaged mode')

  env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(resourcesPath, PLAYWRIGHT_BROWSER_RESOURCE_DIR)
  // Keep this contract separate from Playwright's standard cache variable.
  // Developers may point PLAYWRIGHT_BROWSERS_PATH at a shared cache that only
  // contains the headless shell; packaged Bailongma includes full Chromium.
  env.BAILONGMA_BUNDLED_PLAYWRIGHT = '1'
  // Playwright otherwise identifies an x64 Electron process under Rosetta as arm64.
  env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE ||= packagedHostPlatform(platform, arch)
  return env.PLAYWRIGHT_BROWSERS_PATH
}

function bundledBrowserTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  if (platform === 'darwin' && arch === 'x64') return 'mac-x64'
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  throw new Error(`Unsupported bundled browser target: ${platform}-${arch}`)
}

function bundledNodeRuntimeTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  if (platform === 'darwin' && arch === 'x64') return 'mac-x64'
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  throw new Error(`Unsupported bundled Node runtime target: ${platform}-${arch}`)
}

function resolveBundledNodeExecutable({
  isPackaged,
  resourcesPath = process.resourcesPath,
  projectRoot,
  platform = process.platform,
  arch = process.arch,
  existsSync = fs.existsSync,
} = {}) {
  const filename = platform === 'win32' ? 'node.exe' : 'node'
  const root = isPackaged
    ? path.join(resourcesPath, NODE_RUNTIME_RESOURCE_DIR)
    : path.join(projectRoot, 'build', NODE_RUNTIME_RESOURCE_DIR, bundledNodeRuntimeTarget(platform, arch))
  const executable = path.join(root, filename)
  return existsSync(executable) ? executable : null
}

function configureBundledNodeRuntime({
  isPackaged,
  resourcesPath = process.resourcesPath,
  projectRoot,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  existsSync = fs.existsSync,
} = {}) {
  const executable = resolveBundledNodeExecutable({
    isPackaged,
    resourcesPath,
    projectRoot,
    platform,
    arch,
    existsSync,
  })
  if (!executable) return null

  // The backend runs inside Electron and command children inherit this env.
  // Keep the executable contract for MCP, while also making ordinary `node`
  // shell commands resolve against the bundled runtime.
  env.BAILONGMA_NODE_RUNTIME_PATH = executable
  env.BAILONGMA_MCP_NODE_PATH = executable
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path')
    || (platform === 'win32' ? 'Path' : 'PATH')
  const delimiter = platform === 'win32' ? ';' : ':'
  const runtimeDir = path.dirname(executable)
  const entries = String(env[pathKey] || '').split(delimiter).filter(Boolean)
  const normalize = value => platform === 'win32' ? value.toLowerCase() : value
  if (!entries.some(entry => normalize(path.resolve(entry)) === normalize(path.resolve(runtimeDir)))) {
    env[pathKey] = [runtimeDir, ...entries].join(delimiter)
  }
  return executable
}

function bundledBrowserRoot({
  isPackaged,
  resourcesPath = process.resourcesPath,
  projectRoot,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (isPackaged) return path.join(resourcesPath, PLAYWRIGHT_BROWSER_RESOURCE_DIR)
  if (!projectRoot) throw new Error('projectRoot is required in development mode')
  return path.join(projectRoot, 'build', PLAYWRIGHT_BROWSER_RESOURCE_DIR, bundledBrowserTarget(platform, arch))
}

function resolveBundledChromiumExecutable({
  root,
  platform = process.platform,
  arch = process.arch,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
} = {}) {
  if (!root || !existsSync(root)) return null
  let revisions
  try {
    revisions = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
  } catch {
    return null
  }
  const relative = platform === 'darwin'
    ? path.join(`chrome-mac-${arch === 'arm64' ? 'arm64' : 'x64'}`, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
    : platform === 'win32'
      ? path.join('chrome-win64', 'chrome.exe')
      : platform === 'linux' && arch === 'x64'
        ? path.join('chrome-linux64', 'chrome')
        : null
  if (!relative) return null
  for (const revision of revisions) {
    const executable = path.join(root, revision, relative)
    if (existsSync(executable)) return executable
  }
  return null
}

module.exports = {
  NODE_RUNTIME_RESOURCE_DIR,
  PLAYWRIGHT_BROWSER_RESOURCE_DIR,
  bundledBrowserRoot,
  bundledBrowserTarget,
  bundledNodeRuntimeTarget,
  configureBundledNodeRuntime,
  configurePackagedPlaywright,
  packagedHostPlatform,
  resolveBundledChromiumExecutable,
  resolveBundledNodeExecutable,
}
