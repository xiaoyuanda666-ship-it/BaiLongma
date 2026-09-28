import path from 'node:path'
import { browserSkillOptions, saveBrowserSkillSettings } from '../../mcp/browser-backend.js'
import { getBrowserSkillStatus, browserTasks, controlBrowserTask } from '../../mcp/browserskill-client.js'
import { jsonResponse, readJsonBody } from '../utils.js'

export async function handleBrowserPreviewRoutes(req, res, url, { requireLocalOrToken } = {}) {
  if (!url.pathname.startsWith('/browser-backend') && !url.pathname.startsWith('/browser-surface') && url.pathname !== '/browser-preview') return false
  if (!requireLocalOrToken) { jsonResponse(res, 403, { ok: false }); return true }
  if (!requireLocalOrToken(req, res, url)) return true
  res.setHeader('Cache-Control', 'no-store')
  try {
    let result
    if (req.method === 'GET' && url.pathname === '/browser-backend/status') {
      result = { backend: 'browserskill', browserskill: await getBrowserSkillStatus(), tasks: browserTasks(),
        environment_override: !!(process.env.BAILONGMA_BSK_PATH || process.env.BAILONGMA_BSK_BROWSER) }
    } else if (req.method === 'POST' && url.pathname === '/browser-backend/settings') {
      if (browserTasks().length) throw new Error('请先关闭白龙马的所有浏览器任务，再更改路径或配置')
      if (process.env.BAILONGMA_BSK_PATH || process.env.BAILONGMA_BSK_BROWSER) throw new Error('环境变量已锁定配置，请在启动配置中修改')
      const body = await readJsonBody(req, { maxBytes: 8192 })
      const binary = String(body.binary || '').trim()
      const browser = String(body.browser || '').trim()
      if (binary && !path.isAbsolute(binary)) throw new Error('CLI 路径必须是绝对路径')
      const options = { ...browserSkillOptions(), ...(binary ? { binary } : {}), browser }
      const status = await getBrowserSkillStatus({ options })
      if (browser && !status.browsers?.some(b => b.instance_id === browser)) throw new Error('请选择当前连接列表中的 Chrome 实例 ID')
      // Save a CLI path even when the extension is disconnected so onboarding can progress.
      if (browserTasks().length) throw new Error('已有浏览器任务开始，请关闭任务后再保存配置')
      saveBrowserSkillSettings({ binary, browser })
      result = { ok: true }
    } else if (req.method === 'POST' && url.pathname === '/browser-backend/task') {
      const body = await readJsonBody(req, { maxBytes: 8192 })
      result = await controlBrowserTask(body.session_id, body.action)
    } else {
      jsonResponse(res, 410, { ok: false, error: '内嵌网页与截图显示接口已移除。请使用真实 Chrome。' }); return true
    }
    jsonResponse(res, 200, result)
  } catch (error) { jsonResponse(res, 409, { ok: false, code: error.code || 'BSK_CONFIG_ERROR', error: error.message }) }
  return true
}
