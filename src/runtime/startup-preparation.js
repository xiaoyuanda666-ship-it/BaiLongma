import { seedSandboxOnce, seedMusicOnce, rescueDataFromInstallDir } from '../paths.js'
import { collectSystemInfo, getDesktopPath } from '../system-info.js'
import { collectDesktopInfo } from '../desktop-scanner.js'
import { collectInstalledSoftware } from '../installed-software-scanner.js'
import { collectLocalResources } from '../local-resources-scanner.js'
import { collectGeoWeather, getCountryCode } from '../geo-weather.js'
import { collectTrending } from '../trending.js'
import { collectAgents } from '../agents/registry.js'
import { loadInstalledTools } from '../capabilities/marketplace/index.js'
import { startMcpClients } from '../mcp/client-manager.js'
import { refreshSkills } from '../skills/registry.js'
import { withStartupTimeout } from './startup-timeout.js'
import { setStickyEvent } from './events.js'

export async function prepareAgentRuntime({ reportStartupProgress = () => {} } = {}) {
  // Start local embedding warmup before network environment/MCP preparation.
  // Loading is shared with retrieval and never delays application readiness.
  ;(async () => {
    try {
      const { getEmbeddingCredentials } = await import('../config.js')
      const cred = getEmbeddingCredentials()
      if (cred?.provider === 'local' && cred.model) {
        const { warmupLocalEmbedding } = await import('../embedding-local.js')
        await warmupLocalEmbedding(cred.model)
      }
    } catch {}
  })().catch(() => {})

  // On first launch, copy sandbox seed files from the resource directory to the user data directory (Electron install)
  reportStartupProgress('resources', 'running', '复制沙箱与音乐资源', '正在准备工作区')
  seedSandboxOnce()
  seedMusicOnce()

  // 安全护栏：把历史上误落在安装目录里的工作文件迁回 sandbox（避免下次更新随安装目录被清空）。
  // 迁移发生后用粘性事件告警，前端连上即可看到提示。
  try {
    const rescuedDirs = rescueDataFromInstallDir()
    if (rescuedDirs.length > 0) {
      setStickyEvent('install_dir_rescue', {
        level: 'warning',
        dirs: rescuedDirs,
        message: `检测到 ${rescuedDirs.length} 个工作目录原先存放在程序安装目录里（更新时会被清空），已自动迁移到 sandbox：${rescuedDirs.join('、')}`,
      })
    }
  } catch (err) {
    console.warn('[startup] 安装目录数据迁移检查失败:', err?.message || err)
  }
  reportStartupProgress('resources', 'done', '工作区已准备', '工作区已准备')

  // Collect host system environment info (full scan + persist on first run, then refresh dynamic fields).
  // Must complete before the main loop starts so buildSystemPrompt can inject the env block.
  reportStartupProgress('environment', 'running', '系统、桌面、软件与本地资源', '正在扫描本机环境')
  await collectSystemInfo()

  // Scan the user's desktop (shortcuts cached by mtime, regular files scanned every time)
  collectDesktopInfo(getDesktopPath())

  // Scan installed software once so software/app/proxy questions can use local evidence.
  collectInstalledSoftware()

  // Scan the user's local resources (ssh hosts, keys, known_hosts, git identity)
  // for the "Self-Sufficient Execution" prompt — so the agent already knows what
  // the user has before being asked "上服务器看看".
  collectLocalResources()
  reportStartupProgress('environment', 'done', '本机环境已扫描', '本机环境已扫描')

  // Collect geo-location + live weather (refresh on IP change or after 7 days; weather refreshed every time)
  reportStartupProgress('geo', 'running', '读取缓存或请求实时天气', '正在刷新天气位置')
  const cachedCountryCode = getCountryCode()
  const geoResult = await withStartupTimeout(collectGeoWeather(), 15000, '[startup] geo-weather')
  reportStartupProgress('geo', 'done', geoResult ? '天气位置已刷新' : '天气刷新超时，已沿用缓存', geoResult ? '天气位置已刷新' : '天气刷新超时，已沿用缓存')

  // Collect trending topics (CN → Weibo+Zhihu, others → HN+Reddit; 1h cache)
  reportStartupProgress('trending', 'running', '加载今日热点源', '正在采集热点')
  await withStartupTimeout(collectTrending(geoResult?.location?.country_code || getCountryCode() || cachedCountryCode), 12000, '[startup] trending')
  reportStartupProgress('trending', 'done', '热点采集完成', '热点采集完成')

  // Scan locally installed AI agents (Claude Code, Codex, Hermes, OpenClaw, etc.) and persist to known_agents table
  reportStartupProgress('agents', 'running', 'Claude Code / Codex / Hermes', '正在扫描本地 Agent')
  await withStartupTimeout(collectAgents(), 15000, '[startup] agents')
  reportStartupProgress('agents', 'done', '本地 Agent 扫描完成', '本地 Agent 扫描完成')

  // Load persisted installed tools
  reportStartupProgress('tools', 'running', '恢复已安装能力', '正在加载工具槽')
  await withStartupTimeout(loadInstalledTools(), 12000, '[startup] installed-tools')
  reportStartupProgress('tools', 'done', '工具槽已加载', '工具槽已加载')

  // Connect enabled local MCP stdio servers and cache their tool catalogs. MCP is
  // optional: one broken external server must never block the Bailongma API/agent.
  reportStartupProgress('mcp', 'running', '连接已启用的 MCP Server', '正在加载 MCP 工具')
  await withStartupTimeout(startMcpClients(), 30000, '[startup] mcp-clients')
  reportStartupProgress('mcp', 'done', 'MCP 工具已加载', 'MCP 工具已加载')

  // Load Agent Skills metadata. Full SKILL.md bodies are injected only when a turn matches.
  reportStartupProgress('skills', 'running', '技能目录、SQLite、线程状态', '正在加载技能和记忆')
  const startupSkills = refreshSkills()
  console.log(`[skills] Loaded ${startupSkills.length} Agent Skill(s)`)

  return { startupSkills, geoResult }
}
