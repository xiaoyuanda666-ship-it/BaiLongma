/**
 * scan-local-env.mjs
 *
 * 在独立子进程中执行本地环境扫描（桌面 / 已装软件 / 本地资源），
 * 把结果写入缓存文件。主进程（src/index.js）以 fire-and-forget 方式 spawn 本脚本，
 * 自身不阻塞，从而保证 startAPI 立即启动、激活页可打开。
 *
 * 之所以放到子进程：原实现是主进程内同步调用 collectDesktopInfo / collectInstalledSoftware /
 * collectLocalResources，在 macOS 上某些目录（iCloud 桌面、外接盘等）的 readdirSync 可能
 * 同步阻塞事件循环，导致整个后端卡死在 startAPI 之前。子进程阻塞不影响主进程。
 */

// 注意：collectSystemInfo() 已在主进程(src/index.js)执行——它必须把结果留在内存里供
// buildSystemPrompt 注入环境块，且会落盘 data/system-info.json。为避免重复扫描与写竞争，
// 本子进程不重跑 collectSystemInfo。
//
// 桌面路径不能在本进程里用 getDesktopPath() 获取：getDesktopPath() 读的是 system-info.js 的
// 模块级 _cached，而 _cached 只有在「同一进程」跑过 collectSystemInfo() 才会被填充。本 worker
// 是独立子进程、没跑 collectSystemInfo()，_cached 恒为 null → getDesktopPath() 会返回 null、
// 桌面扫描被跳过。因此改由主进程把桌面路径通过环境变量 BAILONGMA_DESKTOP_PATH 传进来。
import { collectDesktopInfo } from '../src/desktop-scanner.js'
import { collectInstalledSoftware } from '../src/installed-software-scanner.js'
import { collectLocalResources } from '../src/local-resources-scanner.js'

const desktopPath = process.env.BAILONGMA_DESKTOP_PATH || null

try {
  collectDesktopInfo(desktopPath)
  collectInstalledSoftware()
  collectLocalResources()
  console.log('[scan-local-env] 本地环境扫描完成')
  // 显式退出：在打包 Electron 模式下，worker 作为 electron 实例运行，扫描完成后事件循环
  // 不会因"无窗口"自动结束（app 仍存活），必须主动退出，否则会留下游离的 electron 进程。
  // 开发/后端(node)模式下扫描完也会自然退出，这里调用 process.exit 同样安全。
  process.exit(0)
} catch (e) {
  console.error('[scan-local-env] 本地环境扫描失败(已忽略):', e?.message || e)
  process.exit(1)
}
