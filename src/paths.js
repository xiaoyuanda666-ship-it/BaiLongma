// 路径抽象层：打包成 Electron 之后，数据文件要放到 userData 下（可写），
// 而 HTML/静态资源要从应用目录（只读 / asar 内）读。
//
// Electron 主进程启动时会通过环境变量注入这两个路径：
//   BAILONGMA_USER_DIR       - 用户数据目录（可写，存 DB、sandbox、配置）
//   BAILONGMA_RESOURCES_DIR  - 只读资源目录（存 HTML、UI 资源）
//
// 开发模式（直接 node src/index.js）下两者都默认到仓库根目录，行为不变。

import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const USER_DIR = process.env.BAILONGMA_USER_DIR
  ? path.resolve(process.env.BAILONGMA_USER_DIR)
  : REPO_ROOT

const RESOURCES_DIR = process.env.BAILONGMA_RESOURCES_DIR
  ? path.resolve(process.env.BAILONGMA_RESOURCES_DIR)
  : REPO_ROOT

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}

export const paths = {
  userDir: USER_DIR,
  resourcesDir: RESOURCES_DIR,

  dataDir: ensureDir(path.join(USER_DIR, 'data')),
  dbFile: path.join(USER_DIR, 'data', 'jarvis.db'),
  configFile: path.join(USER_DIR, 'config.json'),
  sandboxDir:         ensureDir(path.join(USER_DIR, 'sandbox')),
  sandboxMusicDir:    ensureDir(path.join(USER_DIR, 'sandbox', 'music')),
  sandboxNotesDir:    ensureDir(path.join(USER_DIR, 'sandbox', 'notes')),
  sandboxDownloadsDir:ensureDir(path.join(USER_DIR, 'sandbox', 'downloads')),
  sandboxAudioDir:    ensureDir(path.join(USER_DIR, 'sandbox', 'audio')),
  sandboxArticlesDir: ensureDir(path.join(USER_DIR, 'sandbox', 'articles')),
  sandboxLyricsDir:   ensureDir(path.join(USER_DIR, 'sandbox', 'lyrics')),
  sandboxAppsDir:         ensureDir(path.join(USER_DIR, 'sandbox', 'apps')),
  sandboxInstalledToolsDir: ensureDir(path.join(USER_DIR, 'sandbox', 'installed_tools')),
  musicDir:           ensureDir(path.join(USER_DIR, 'music')),

  indexHtml: path.join(RESOURCES_DIR, 'index.html'),
  dashboardHtml: path.join(RESOURCES_DIR, 'dashboard.html'),
  brainHtml: path.join(RESOURCES_DIR, 'brain.html'),
  brainUiHtml: path.join(RESOURCES_DIR, 'brain-ui.html'),
  websiteHtml: path.join(RESOURCES_DIR, 'website.html'),
  systemPromptHtml: path.join(RESOURCES_DIR, 'systemPrompt.html'),
  activationHtml: path.join(RESOURCES_DIR, 'activation.html'),
  brainUiAssetRoot: path.join(RESOURCES_DIR, 'src', 'ui', 'brain-ui'),
}

// 首次启动时，把仓库里附带的 sandbox 种子文件（readme.txt、world.txt 之类）拷到 userData，
// 让封装后的 Electron 应用也能看到初始的沙盒资源。
export function seedSandboxOnce() {
  const srcDir = path.join(RESOURCES_DIR, 'sandbox')
  const dstDir = paths.sandboxDir
  if (srcDir === dstDir) return
  if (!fs.existsSync(srcDir)) return
  try {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = path.join(srcDir, entry.name)
      const dstPath = path.join(dstDir, entry.name)
      if (fs.existsSync(dstPath)) continue
      if (entry.isDirectory()) {
        fs.cpSync(srcPath, dstPath, { recursive: true })
      } else {
        fs.copyFileSync(srcPath, dstPath)
      }
    }
  } catch (err) {
    console.warn('[paths] 沙盒种子文件拷贝失败:', err.message)
  }
}

// 启动期安全护栏：把历史上误落在「安装目录」里的 Agent 工作文件迁回 sandbox。
//
// 背景：旧版本在 execSandbox=false 时，exec_command 的默认 cwd 退回 process.cwd()，
// 打包后从快捷方式启动时它就是 exe 所在的安装目录。Agent 在那里建的工作目录
// （如 spiders/）会在下次 NSIS 覆盖安装时随 $INSTDIR 一起被清空，造成用户文件丢失。
// shell.js 的 cwd 解析已修，但升级到新版之前留在安装目录里的旧文件仍有风险，
// 这里在启动时把它们一次性迁到 sandbox（更新动不到的 userData 下）。
//
// 仅打包模式生效；开发模式（USER_DIR===RESOURCES_DIR===仓库根）下跳过。
// 返回被迁移的目录名列表，供上层决定是否给用户弹告警。
const APP_OWNED_ENTRIES = new Set([
  // electron-builder 在安装目录里铺设的程序文件/目录，绝不能碰
  'resources', 'locales', 'swiftshader',
])

function isInstallDirSafeToScan(installDir) {
  if (!installDir) return false
  // 安装目录里必须能看到 electron 程序自身的标志物，才认定它确实是安装目录，
  // 避免在异常环境下错把无关目录当安装目录去搬文件。
  try {
    const names = fs.readdirSync(installDir)
    return names.includes('resources') &&
      names.some(n => n.toLowerCase().endsWith('.exe'))
  } catch {
    return false
  }
}

export function rescueDataFromInstallDir() {
  const rescued = []
  // 仅打包模式处理。打包后代码运行在 <install>\resources\app.asar 内，REPO_ROOT
  // （由 __dirname 推出）必然包含 "app.asar"；两种开发模式（node src/index.js 与
  // electron .，代码都在真实仓库目录里）都不含，直接跳过，避免误扫 electron dist。
  // 注意：不能用 RESOURCES_DIR===REPO_ROOT 判断——打包后 app.getAppPath() 也指向
  // 同一个 app.asar，两者恒等，那样写会把打包模式也误判成开发模式而永不执行。
  if (!REPO_ROOT.includes('app.asar')) return rescued

  let installDir
  try {
    // exe 所在目录就是安装目录（process.execPath = <install>\Bailongma.exe）
    installDir = path.dirname(process.execPath)
  } catch {
    return rescued
  }

  // sandbox 必须在安装目录之外，否则迁过去等于没迁
  if (isPathInside(installDir, paths.sandboxDir)) {
    console.warn('[paths] 警告：sandbox 目录位于安装目录内，更新时会被清空，请检查 BAILONGMA_USER_DIR 配置')
    return rescued
  }
  if (!isInstallDirSafeToScan(installDir)) return rescued

  let entries
  try {
    entries = fs.readdirSync(installDir, { withFileTypes: true })
  } catch {
    return rescued
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue            // 只搬目录，程序文件（dll/pak/exe）一律不动
    if (APP_OWNED_ENTRIES.has(entry.name)) continue
    if (entry.name.startsWith('.')) continue

    const srcPath = path.join(installDir, entry.name)
    let dstPath = path.join(paths.sandboxDir, entry.name)
    // 目标已存在则换个带时间戳的名字，绝不覆盖既有 sandbox 内容
    if (fs.existsSync(dstPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      dstPath = path.join(paths.sandboxDir, `${entry.name}_rescued_${stamp}`)
    }

    try {
      // 先复制，确认目标落地后再删源——任何一步出错都保留源文件，宁可不迁不可误删
      fs.cpSync(srcPath, dstPath, { recursive: true })
      if (fs.existsSync(dstPath)) {
        fs.rmSync(srcPath, { recursive: true, force: true })
        rescued.push(entry.name)
        console.warn(`[paths] 已把安装目录里的工作文件迁回 sandbox：${srcPath} → ${dstPath}`)
      }
    } catch (err) {
      console.warn(`[paths] 迁移 ${srcPath} 失败（已保留原文件）：${err.message}`)
    }
  }
  return rescued
}

// 判断 candidate 是否在 parentDir 之内（含相等）。函数声明会被提升，故上方可先用后定义。
function isPathInside(parentDir, candidatePath) {
  const rel = path.relative(path.resolve(parentDir), path.resolve(candidatePath))
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

// 首次启动时，把仓库附带的种子音乐文件拷到 musicDir，
// 确保自检时 music scan 能扫到至少一首曲目而无需 yt-dlp 下载。
export function seedMusicOnce() {
  const srcDir = path.join(RESOURCES_DIR, 'music')
  const dstDir = paths.musicDir
  if (srcDir === dstDir) return
  if (!fs.existsSync(srcDir)) return
  try {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const dstPath = path.join(dstDir, entry.name)
      if (fs.existsSync(dstPath)) continue
      fs.copyFileSync(path.join(srcDir, entry.name), dstPath)
    }
  } catch (err) {
    console.warn('[paths] 音乐种子文件拷贝失败:', err.message)
  }
}
