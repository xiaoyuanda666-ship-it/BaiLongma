import os from 'os'
import path from 'path'
import { paths } from '../paths.js'

const SANDBOX_ROOT = path.resolve(paths.sandboxDir)
const HOME_DIR = path.resolve(os.homedir())

const LOCAL_SERVICE_RE = /\b(?:python3?\s+-m\s+http\.server|http-server|live-server|(?:npx\s+)?serve(?:\s|$)|vite(?:\s+preview)?|next\s+(?:dev|start)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch))\b|\b(?:node\s+[^\n]*(?:server|app)|flask\s+run|uvicorn|gunicorn|hypercorn|daphne|streamlit\s+run|jupyter|php\s+-S|rails\s+(?:s|server)|hugo\s+server|jekyll\s+serve|docker(?:\s+compose)?\s+up|redis-server|postgres)\b/i
const STATIC_SERVER_RE = /\bpython3?\s+-m\s+http\.server\b|\b(?:http-server|live-server)\b|\b(?:npx\s+)?serve(?:\s|$)/i
const TUNNEL_RE = /\b(?:ngrok|localtunnel|lt\s+--port|cloudflared\s+tunnel|ssh\b[^\n]*\s-R\s*)\b/i
const SENSITIVE_SERVICE_RE = /\b(?:jupyter|--inspect(?:-brk)?|remote-debugging-port|redis-server|postgres|adminer|phpmyadmin|mitmproxy|socks|proxy|ssh\b[^\n]*\s-[LRD])\b/i

const LAN_INTENT_RE = /(?:局域网|同一网络|同一个网络|内网|跨设备|(?:让|给|用|在).{0,12}(?:手机|平板|另一台电脑|其他电脑|其他设备|别的设备).{0,10}(?:访问|打开|连接|测试)|(?:手机|平板|另一台电脑|其他电脑|其他设备|别的设备).{0,10}(?:访问|打开|连接|测试))|\b(?:lan|local\s+network|(?:another|other)\s+(?:device|computer)|(?:phone|tablet).{0,20}(?:access|open|connect|test)|(?:access|open|connect|test).{0,20}(?:phone|tablet))\b/i
const PUBLIC_INTENT_RE = /(?:公网|互联网访问|外网访问|公开链接|公共链接|内网穿透|公网隧道|外部 webhook|任何人.{0,6}访问)|\b(?:public(?:ly)?|internet-accessible|public\s+(?:url|link|tunnel)|ngrok|cloudflare\s+tunnel|localtunnel|reverse\s+tunnel)\b/i
const BROAD_SHARE_INTENT_RE = /(?:(?:共享|暴露|提供|开放|serve|share|expose).{0,18}(?:桌面|desktop|documents|downloads|主目录|home|sandbox|沙箱|整个目录|文件夹|磁盘|根目录))|(?:(?:桌面|desktop|documents|downloads|主目录|home|sandbox|沙箱|整个目录|文件夹|磁盘|根目录).{0,18}(?:共享|暴露|提供|开放|serve|share|expose))/i

function unquote(value = '') {
  const text = String(value || '').trim()
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1)
  }
  return text
}

function optionValue(command, names = []) {
  const joined = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const re = new RegExp(`(?:^|\\s)(?:${joined})(?:=|\\s+)("[^"]*"|'[^']*'|[^\\s;&|]+)`, 'i')
  const match = String(command || '').match(re)
  return match ? unquote(match[1]) : ''
}

function resolveCommandPath(value, cwd) {
  const raw = unquote(value)
  if (!raw) return path.resolve(cwd)
  const expanded = raw
    .replace(/^~(?=$|[\\/])/, HOME_DIR)
    .replace(/^\$(?:HOME|USERPROFILE)(?=$|[\\/])/i, HOME_DIR)
    .replace(/^%(?:USERPROFILE|HOMEPATH)%(?=$|[\\/])/i, HOME_DIR)
  return path.resolve(cwd, expanded)
}

function samePath(a, b) {
  return path.resolve(a) === path.resolve(b)
}

function broadRootLabel(candidate) {
  const resolved = path.resolve(candidate)
  const parsed = path.parse(resolved)
  if (samePath(resolved, parsed.root)) return 'filesystem root'
  if (samePath(resolved, HOME_DIR)) return 'home directory'
  const known = [
    ['Desktop', path.join(HOME_DIR, 'Desktop')],
    ['Documents', path.join(HOME_DIR, 'Documents')],
    ['Downloads', path.join(HOME_DIR, 'Downloads')],
    ['BaiLongma sandbox root', SANDBOX_ROOT],
  ]
  return known.find(([, dir]) => samePath(resolved, dir))?.[0] || ''
}

function classifyHost(value = '') {
  const host = unquote(value).replace(/^\[|\]$/g, '').trim().toLowerCase()
  if (!host) return 'unknown'
  if (['127.0.0.1', 'localhost', '::1'].includes(host)) return 'loopback'
  if (['0.0.0.0', '::', '*'].includes(host)) return 'all_interfaces'
  return 'network'
}

function hostFromEndpoint(value = '') {
  const endpoint = unquote(value).trim()
  const bracketed = endpoint.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketed) return bracketed[1]
  if ((endpoint.match(/:/g) || []).length > 1) return endpoint
  return endpoint.replace(/:\d+$/, '')
}

function extractHost(command) {
  const text = String(command || '')
  const optionHost = optionValue(text, ['--host', '--hostname', '--bind', '-b', '-H', '-a'])
  if (optionHost) return hostFromEndpoint(optionHost)
  if (/(?:^|\s)--host(?=\s*(?:$|[;&|]))/i.test(text)) return '0.0.0.0'
  const php = text.match(/\bphp\s+-S\s+([^\s:]+)(?::\d+)?/i)
  if (php) return php[1]
  if (/\bpython3?\s+-m\s+http\.server\b/i.test(text)) return '0.0.0.0'
  if (/\bhttp-server\b/i.test(text)) return '0.0.0.0'
  return ''
}

function extractStaticRoot(command, cwd) {
  const text = String(command || '')
  if (/\bpython3?\s+-m\s+http\.server\b/i.test(text)) {
    const directory = optionValue(text, ['--directory', '-d'])
    return resolveCommandPath(directory, cwd)
  }
  if (/\blive-server\b/i.test(text)) {
    const positional = text.match(/\blive-server\b\s+("[^"]*"|'[^']*'|[^\s;&|]+)/i)?.[1] || ''
    const root = optionValue(text, ['--root']) || (!positional.startsWith('-') ? positional : '')
    return resolveCommandPath(root, cwd)
  }
  // http-server accepts the served path as its first positional argument, but
  // parsing arbitrary npx/package-runner syntax here would create false blocks.
  // Its cwd is still a reliable conservative default; explicit -r/--root is read.
  if (/\bhttp-server\b/i.test(text)) {
    const positional = text.match(/\bhttp-server\b\s+("[^"]*"|'[^']*'|[^\s;&|]+)/i)?.[1] || ''
    const root = optionValue(text, ['--root', '-r']) || (!positional.startsWith('-') ? positional : '')
    return resolveCommandPath(root, cwd)
  }
  if (/\b(?:npx\s+)?serve(?:\s|$)/i.test(text)) {
    const tail = text.match(/\bserve\b\s+([^;&|]+)/i)?.[1] || ''
    const tokens = tail.match(/"[^"]*"|'[^']*'|[^\s]+/g) || []
    let positional = ''
    for (let i = 0; i < tokens.length; i++) {
      const token = unquote(tokens[i])
      if (['-l', '--listen', '-p', '--port'].includes(token)) { i++; continue }
      if (['-s', '--single', '-C', '--cors', '-n', '--no-clipboard'].includes(token)) continue
      if (!token.startsWith('-')) { positional = token; break }
    }
    const root = optionValue(text, ['--root']) || positional
    return resolveCommandPath(root, cwd)
  }
  return ''
}

export function analyzeLocalServiceCommand(command, {
  cwd = SANDBOX_ROOT,
  currentUserMessage = '',
} = {}) {
  const text = String(command || '').trim()
  const userText = String(currentUserMessage || '')
  const isTunnel = TUNNEL_RE.test(text)
  const isService = isTunnel || LOCAL_SERVICE_RE.test(text)
  if (!isService) return { is_service: false, blocked: false }

  const host = extractHost(text)
  const bind = classifyHost(host)
  const staticRoot = STATIC_SERVER_RE.test(text) ? extractStaticRoot(text, cwd) : ''
  const broadRoot = staticRoot ? broadRootLabel(staticRoot) : ''
  const lanAuthorized = LAN_INTENT_RE.test(userText) || PUBLIC_INTENT_RE.test(userText)
  const publicAuthorized = PUBLIC_INTENT_RE.test(userText)
  const broadShareAuthorized = BROAD_SHARE_INTENT_RE.test(userText)
  const warnings = []

  let blocked = false
  let code = ''
  let reason = ''
  let hint = ''

  if (isTunnel && !publicAuthorized) {
    blocked = true
    code = 'PUBLIC_SERVICE_NOT_REQUESTED'
    reason = 'the command would create a public tunnel, but the current user request does not ask for public Internet access'
    hint = 'Keep the service on 127.0.0.1. Start a tunnel only after the user explicitly asks for a public URL or Internet access.'
  } else if ((bind === 'all_interfaces' || bind === 'network') && !lanAuthorized) {
    blocked = true
    code = 'NETWORK_SERVICE_NOT_REQUESTED'
    reason = `the service would listen on ${host || 'a non-loopback interface'}, but the current request only supports local access`
    hint = /\bpython3?\s+-m\s+http\.server\b/i.test(text)
      ? 'Bind the preview explicitly with --bind 127.0.0.1 and run it from a dedicated sandbox project directory.'
      : 'Bind the development service to 127.0.0.1/localhost. Use LAN exposure only when the user asks another device to connect.'
  } else if (broadRoot && !broadShareAuthorized) {
    blocked = true
    code = 'SERVICE_ROOT_TOO_BROAD'
    reason = `the static server would expose the ${broadRoot}, including files unrelated to the current task`
    hint = 'Create a dedicated project subdirectory inside the BaiLongma sandbox, place only this task\'s site files there, and serve that directory.'
  }

  if (!blocked && (bind === 'all_interfaces' || bind === 'network')) {
    warnings.push(`network exposure authorized by the current request; listening host is ${host}`)
  }
  if (!blocked && broadRoot) {
    warnings.push(`broad static root explicitly requested by the user: ${broadRoot}`)
  }
  if (!blocked && SENSITIVE_SERVICE_RE.test(text) && bind !== 'loopback' && bind !== 'unknown') {
    warnings.push('this is a sensitive service exposed beyond loopback; verify its authentication and intended audience')
  }

  return {
    is_service: true,
    kind: isTunnel ? 'public_tunnel' : (staticRoot ? 'static_server' : (SENSITIVE_SERVICE_RE.test(text) ? 'sensitive_service' : 'development_server')),
    exposure: isTunnel ? 'public' : (bind === 'loopback' ? 'local' : ((bind === 'all_interfaces' || bind === 'network') ? 'network' : 'unknown')),
    bind_host: host || null,
    served_root: staticRoot || null,
    blocked,
    code: code || null,
    reason: reason || null,
    hint: hint || null,
    warnings,
  }
}

export const __internal = {
  extractHost,
  extractStaticRoot,
  broadRootLabel,
  classifyHost,
  hostFromEndpoint,
  LAN_INTENT_RE,
  PUBLIC_INTENT_RE,
}
