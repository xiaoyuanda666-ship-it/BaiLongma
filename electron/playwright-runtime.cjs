const path = require('path')

const PLAYWRIGHT_BROWSER_RESOURCE_DIR = 'playwright-browsers'

function packagedHostPlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return 'win64'
  if (platform === 'darwin' && arch === 'x64') return 'mac15'
  if (platform === 'darwin' && arch === 'arm64') return 'mac15-arm64'
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

module.exports = {
  PLAYWRIGHT_BROWSER_RESOURCE_DIR,
  configurePackagedPlaywright,
  packagedHostPlatform,
}
