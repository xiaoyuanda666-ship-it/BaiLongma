import { extractFeishuMessage } from './webhooks.js'
import { env } from './utils.js'

// 飞书长连接（WebSocket）入站连接器。
//
// 为什么用长连接而不是 webhook：Jarvis是装在用户机器上的桌面应用，没有公网 IP/域名，
// webhook 回调地址在桌面端根本配不出来（要靠内网穿透，产品上不可行）。长连接由 SDK
// 维持一条到飞书服务器的 WebSocket 通道主动收事件，只需 App ID/Secret，能访问公网即可。
// 心跳、断线重连、事件解密都在 SDK 内部完成，所以这个连接器很薄。
//
// 职责边界：本连接器只负责「收」。出站发消息仍走 dispatch.js 的 sendFeishu（HTTP 调
// im/v1/messages），与长连接无关、无需改动。
//
// 依赖策略：@larksuiteoapi/node-sdk 是可选重依赖，用动态 import。未安装时只让飞书连接器
// 优雅降级（返回 null + 一条清晰日志），不连累其它 social 连接器或整个启动流程。

// 飞书（中国）默认；Lark（国际）或自建代理域名可用 FEISHU_DOMAIN 覆盖。
const FEISHU_DOMAINS = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
}

function resolveDomain() {
  const raw = env('FEISHU_DOMAIN').toLowerCase()
  if (!raw) return FEISHU_DOMAINS.feishu
  if (FEISHU_DOMAINS[raw]) return FEISHU_DOMAINS[raw]
  if (/^https?:\/\//.test(raw)) return raw // 允许直接传完整 URL
  return FEISHU_DOMAINS.feishu
}

// 模块级连接状态，供配置弹窗的 GET /social/feishu/status 查询。
// idle（未配置/未启动）| connecting（已发起、等握手）| connected（onReady）|
// reconnecting（断线重连中）| error（鉴权/握手失败或依赖缺失）。
// 注意：startFeishuConnector 的乐观早返回不代表已连上——真正的连上以 onReady 为准，
// 所以这里不在 start() 后就标 connected，避免凭据错误时弹窗误显示「已连接」。
let feishuStatus = 'idle'
function setFeishuStatus(status, emitEvent, extra = {}) {
  feishuStatus = status
  emitEvent?.('social_status', { platform: 'feishu', status, ...extra })
}
export function getFeishuStatus() {
  return feishuStatus
}

// 给 Agent 看的实时飞书连接状态块（index.js 按「飞书」关键词注入到补充上下文）。
// 没有这个，Agent 无法得知后端是否已连上，只能瞎猜，会反复对用户说「还没连上」。
export function getFeishuStatusBlock() {
  const configured = !!(env('FEISHU_APP_ID') && env('FEISHU_APP_SECRET'))
  const lines = ['## 飞书连接状态（实时，权威）', `- 长连接状态：${feishuStatus}`, `- 凭据已配置：${configured ? '是' : '否'}`]
  if (feishuStatus === 'connected') {
    lines.push('- 含义：长连接已就绪，机器人在线，可收发消息。这就是「已连上」，不要再说没连上。')
    lines.push('- 验证方法：让用户在飞书里给机器人发一条消息，会从 FEISHU 渠道进来；机器人无法主动给「从未联系过它」的用户发消息（拿不到 open_id），必须用户先发。')
  } else if (feishuStatus === 'connecting' || feishuStatus === 'reconnecting') {
    lines.push('- 含义：正在建立长连接，请用户稍等几秒再看。')
  } else if (feishuStatus === 'error') {
    lines.push('- 含义：连接失败。让用户检查 App ID/Secret 是否正确，以及飞书后台「事件订阅」是否选了「使用长连接接收事件」并订阅 im.message.receive_v1（不要开加密推送）。')
  } else {
    lines.push('- 含义：未连接。让用户在弹窗填 App ID/Secret 后点连接（调 connect_feishu 打开弹窗）。')
  }
  return lines.join('\n')
}

export async function startFeishuConnector({ pushMessage, emitEvent } = {}) {
  const appId = env('FEISHU_APP_ID')
  const appSecret = env('FEISHU_APP_SECRET')
  // 未配置凭据时静默跳过（与 discord/clawbot 连接器一致），不报错。
  if (!appId || !appSecret) { feishuStatus = 'idle'; return null }

  let mod = null
  try {
    mod = await import('@larksuiteoapi/node-sdk')
  } catch {
    console.warn('[Feishu] 长连接需要依赖 @larksuiteoapi/node-sdk，请先安装：npm install @larksuiteoapi/node-sdk')
    setFeishuStatus('error', emitEvent, { error: 'missing dependency @larksuiteoapi/node-sdk' })
    return null
  }
  // ESM/CJS 互操作：SDK 是 CJS 包，导出可能整体挂在 default 上。
  const Lark = mod.WSClient ? mod : (mod.default || mod)
  if (!Lark?.WSClient || !Lark?.EventDispatcher) {
    console.warn('[Feishu] @larksuiteoapi/node-sdk 缺少 WSClient/EventDispatcher，请升级到 1.24.0+')
    setFeishuStatus('error', emitEvent, { error: 'SDK too old, need >=1.24.0' })
    return null
  }

  const domain = resolveDomain()
  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    domain,
    // 默认只打 warn 及以上，避免长连接 info 日志刷屏；SDK 的 LoggerLevel 枚举不在时退回数值 2。
    loggerLevel: Lark.LoggerLevel?.warn ?? 2,
    // SDK 生命周期回调驱动真实状态：握手成功才 connected，鉴权/握手失败回 error，
    // 凭据错时弹窗能立刻看到「连接失败」而不是假「已连接」。
    onReady: () => { console.log('[Feishu] 长连接已就绪'); setFeishuStatus('connected', emitEvent, { appId }) },
    onError: (err) => { console.error(`[Feishu] 长连接错误: ${err?.message || err}`); setFeishuStatus('error', emitEvent, { error: String(err?.message || err) }) },
    onReconnecting: () => { console.warn('[Feishu] 长连接重连中…'); setFeishuStatus('reconnecting', emitEvent) },
    onReconnected: () => { console.log('[Feishu] 长连接已重连'); setFeishuStatus('connected', emitEvent, { appId }) },
  })

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    // SDK 已按 header.event_type 路由并把事件解包，data 等价于 webhook 的 body.event。
    'im.message.receive_v1': async (data) => {
      const { fromId, content } = extractFeishuMessage(data)
      const trimmed = String(content || '').trim()
      if (!fromId || !trimmed) {
        console.warn('[Feishu] 收到事件但无法解析出发件人或正文（已忽略）')
        return
      }
      console.log(`[Feishu] 收到入站消息 from=${fromId} len=${trimmed.length}`)
      // 复用与 webhook 入站完全相同的入队语义（channel='FEISHU' + social 元数据），
      // 让长连接来的消息和 webhook 来的消息在下游不可区分。
      const queued = pushMessage(fromId, trimmed, 'FEISHU', {
        social: {
          platform: 'feishu',
          chat_id: data?.message?.chat_id || '',
          message_id: data?.message?.message_id || '',
        },
      })
      emitEvent?.('message_in', { from_id: fromId, content: trimmed, channel: 'FEISHU', timestamp: new Date().toISOString(), conversation_id: queued?.conversationId || 0 })
    },
  })

  // WSClient.start 内部维持 WebSocket 并自动断线重连，正常不会 reject；
  // 包一层 try 防构造期/鉴权期同步抛错（如 appId 明显非法）。
  // 标 connecting，真正的 connected/error 由上面的 onReady/onError 回调翻转。
  try {
    wsClient.start({ eventDispatcher })
    console.log(`[Feishu] 长连接启动中（appId: ${appId}，domain: ${domain}）`)
    setFeishuStatus('connecting', emitEvent, { appId })
  } catch (err) {
    console.error(`[Feishu] 长连接启动失败: ${err.message}`)
    setFeishuStatus('error', emitEvent, { error: err.message })
    return null
  }

  return {
    platform: 'feishu',
    stop() {
      // 必须真正断开旧连接：飞书长连接是 cluster 模式，同 app 多条连接时消息只随机投给其中一条，
      // 热重启（改 App ID/Secret）若留着旧连接，会和新连接抢消息导致投递飘忽。
      // SDK 的断开方法叫 close()（非 stop），对未启动/已关闭的 client 调用也安全。
      try { wsClient?.close?.() } catch {}
      try { wsClient?.stop?.() } catch {} // 兜底：防 SDK 后续版本改名
      feishuStatus = 'idle'
    },
  }
}
