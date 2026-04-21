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
  sandboxDir: ensureDir(path.join(USER_DIR, 'sandbox')),

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
