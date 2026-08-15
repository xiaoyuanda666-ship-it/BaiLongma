// Local Service Safety —— 本地开发服务的最小暴露规则。
//
// 这不是“遇到 server 就拦”的安全壳。开发服务器、预览站、API 和 watcher 都是
// 正常编程动作；本段只把模型的默认选择校准到项目目录 + loopback，并区分本机、
// 局域网与公网三种真实意图。明确的 LAN / public 请求仍可正常完成。

export const LOCAL_SERVICE_SAFETY_BLOCK = `## Local Service Safety
When you start an HTTP/WebSocket development server, preview server, API, file server, debugger, proxy, tunnel, or other listening background process:
1. **Normal local development stays easy.** For a page or app the user wants opened on this computer, use a dedicated project directory inside the BaiLongma sandbox and bind to 127.0.0.1 or ::1. "Open it in my browser" means local access; it does not imply LAN or public sharing.
2. **Serve the project, not its surroundings.** A static server may expose only the current task's project/output directory. Never use Desktop, Documents, Downloads, the home directory, the sandbox root, a drive root, or the filesystem root as a convenient serving directory. Move/copy the required artifact into its own sandbox subdirectory instead. A normal existing source repository or project directory is fine when the user asked you to work there.
3. **Match exposure to the current request.** Bind to a LAN interface or 0.0.0.0 only when the user currently asks another device or the local network to connect. Start a public tunnel or public listener only when the user explicitly asks for public/Internet access. Do not infer either from a request to open a browser.
4. **Use proportionate care.** Ordinary loopback dev servers do not need extra authentication. Database/admin UIs, debuggers, notebooks, remote shells, proxies, and file-sharing services are more sensitive: keep them loopback-only by default and never expose them more broadly by accident.
5. **Keep the run observable.** Start long-running services with run_command action="start", mode="background"; retain the run_id, inspect startup output, and verify the actual URL before reporting success. A service started this way belongs to the current BaiLongma runtime; cancel it when the temporary preview is no longer useful. Do not turn a temporary preview into a startup daemon.`

const SERVICE_TEXT_RE = /(?:启动|运行|搭建|开启|打开|写|做|开发|测试|预览).{0,24}(?:服务|服务器|网页|网站|页面|接口|api|后台|端口|本地站点|开发环境)|(?:服务|服务器|网页|网站|接口|api).{0,20}(?:启动|运行|监听|端口|预览|测试)|(?:localhost|127\.0\.0\.1|0\.0\.0\.0|局域网|公网|内网穿透|端口转发|隧道)|\b(?:dev\s+server|preview\s+server|local\s+server|http\s+server|websocket|listen(?:ing)?|serve|tunnel|ngrok|cloudflared|uvicorn|gunicorn|flask|vite|next\s+dev|npm\s+run\s+(?:dev|start|serve))\b/i

const RECENT_SERVICE_ACTION_RE = /(?:run_command|exec_command)\([^\n]*(?:server|serve|listen|http\.server|npm\s+run\s+(?:dev|start|serve)|vite|next|flask|uvicorn|ngrok|cloudflared)/i

export function shouldInjectLocalServiceSafety({
  userMessage = '',
  taskText = '',
  recentActionsText = '',
  coding = false,
} = {}) {
  if (coding) return true
  if (SERVICE_TEXT_RE.test(String(userMessage || ''))) return true
  if (SERVICE_TEXT_RE.test(String(taskText || ''))) return true
  return RECENT_SERVICE_ACTION_RE.test(String(recentActionsText || ''))
}

export const __internal = { SERVICE_TEXT_RE, RECENT_SERVICE_ACTION_RE }
