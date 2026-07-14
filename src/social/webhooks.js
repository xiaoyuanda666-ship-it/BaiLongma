import crypto from 'crypto'
import { pushMessage } from '../inbound-message.js'
import { emitEvent } from '../events.js'
import { jsonResponse, readBody, textResponse } from './http.js'
import { escapeXml, parseSimpleXml } from './xml.js'
import { env } from './utils.js'

// 微信消息防重放：5 分钟时间窗口
const WECHAT_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000

export function isSocialWebhookPath(pathname) {
  return pathname.startsWith('/social/')
}

function sha1(values) {
  return crypto.createHash('sha1').update(values.sort().join('')).digest('hex')
}

function verifyWechatSignature(url) {
  const token = env('WECHAT_OFFICIAL_TOKEN')
  if (!token) return false
  const signature = url.searchParams.get('signature') || ''
  const timestamp = url.searchParams.get('timestamp') || ''
  const nonce = url.searchParams.get('nonce') || ''
  if (!signature || !timestamp || !nonce) return false

  // 时间窗口校验：拒绝超过 5 分钟的请求（防重放）
  const tsMs = Number(timestamp) * 1000
  if (Math.abs(Date.now() - tsMs) > WECHAT_TIMESTAMP_TOLERANCE_MS) return false

  return sha1([token, timestamp, nonce]) === signature
}

function enqueueSocialMessage(fromId, content, channel, social = {}) {
  const trimmed = String(content || '').trim()
  if (!trimmed) return
  const queued = pushMessage(fromId, trimmed, channel, { social })
  emitEvent('message_in', {
    from_id: fromId,
    content: trimmed,
    channel,
    timestamp: new Date().toISOString(),
    conversation_id: queued?.conversationId || 0,
  })
}

function feishuVerificationToken(body) {
  return String(body?.header?.token || body?.token || '').trim()
}

// 从飞书消息事件里抽出 { fromId, content, chatId, messageId }，无法定位发件人/正文时 fromId/content 为空串。
// webhook 入站与长连接（feishu-ws.js）入站共用此函数，确保两条链路的 ID 映射、正文解析完全一致、不会漂移。
// 入参 event 等价于 webhook 的 body.event，也等价于 SDK EventDispatcher 回调收到的 data。
export function extractFeishuMessage(event = {}) {
  const message = event.message || {}
  let content = ''
  try {
    const parsed = JSON.parse(message.content || '{}')
    content = parsed.text || parsed.content || ''
  } catch {
    content = message.content || ''
  }
  const openId = event.sender?.sender_id?.open_id || event.sender?.sender_id?.user_id || ''
  const chatId = message.chat_id || ''
  const fromId = openId ? `feishu:open_id:${openId}` : (chatId ? `feishu:chat_id:${chatId}` : '')
  return { fromId, content, chatId, messageId: message.message_id || '' }
}

async function handleFeishu(req, res) {
  // 鉴权前置：未配置 token 时直接拒绝，而不是跳过验证
  const expectedToken = env('FEISHU_VERIFICATION_TOKEN')
  if (!expectedToken) return jsonResponse(res, 503, { ok: false, error: 'FEISHU_VERIFICATION_TOKEN not configured' })

  const raw = await readBody(req)
  let body = null
  try { body = JSON.parse(raw.toString('utf-8') || '{}') } catch {
    return jsonResponse(res, 400, { ok: false, error: 'invalid json' })
  }

  const providedToken = feishuVerificationToken(body)

  // challenge 握手在鉴权之前响应（飞书要求）
  if (body.challenge) {
    if (providedToken !== expectedToken) return jsonResponse(res, 403, { ok: false, error: 'invalid token' })
    return jsonResponse(res, 200, { challenge: body.challenge })
  }

  if (body.encrypt) return jsonResponse(res, 400, { ok: false, error: 'encrypted Feishu events are not enabled in Jarvis yet' })

  if (providedToken !== expectedToken) {
    return jsonResponse(res, 403, { ok: false, error: 'invalid token' })
  }

  const headerType = body.header?.event_type
  const event = body.event || {}
  const message = event.message || {}
  if (headerType === 'im.message.receive_v1' || message.message_id) {
    const { fromId, content, chatId, messageId } = extractFeishuMessage(event)
    if (fromId && content) enqueueSocialMessage(fromId, content, 'FEISHU', { platform: 'feishu', chat_id: chatId, message_id: messageId })
  }

  return jsonResponse(res, 200, { ok: true })
}

async function handleWechatOfficial(req, res, url) {
  // WECHAT_OFFICIAL_TOKEN 未配置时拒绝所有请求
  if (!env('WECHAT_OFFICIAL_TOKEN')) return textResponse(res, 503, 'WECHAT_OFFICIAL_TOKEN not configured')
  if (!verifyWechatSignature(url)) return textResponse(res, 403, 'forbidden')
  if (req.method === 'GET') return textResponse(res, 200, url.searchParams.get('echostr') || '')

  const raw = await readBody(req)
  const msg = parseSimpleXml(raw.toString('utf-8'))
  const fromUser = msg.FromUserName || ''
  const toUser = msg.ToUserName || ''
  const content = msg.Content || `[${msg.MsgType || 'unknown'} message]`
  if (fromUser) enqueueSocialMessage(`wechat:official:${fromUser}`, content, 'WECHAT_OFFICIAL', { platform: 'wechat-official', msg_type: msg.MsgType || null })

  const reply = `<xml><ToUserName><![CDATA[${escapeXml(fromUser)}]]></ToUserName><FromUserName><![CDATA[${escapeXml(toUser)}]]></FromUserName><CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[已收到，我会尽快回复。]]></Content></xml>`
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' })
  res.end(reply)
}

async function handleWeCom(req, res) {
  // 鉴权前置：未配置 token 时拒绝
  const expectedToken = env('WECOM_INCOMING_TOKEN')
  if (!expectedToken) return jsonResponse(res, 503, { ok: false, error: 'WECOM_INCOMING_TOKEN not configured' })

  // 统一只从 Authorization: Bearer <token> 读取
  const providedToken = req.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
  if (providedToken !== expectedToken) {
    return jsonResponse(res, 403, { ok: false, error: 'invalid token' })
  }

  const raw = await readBody(req)
  let body = null
  try { body = JSON.parse(raw.toString('utf-8') || '{}') } catch {
    return jsonResponse(res, 400, { ok: false, error: 'invalid json' })
  }
  const content = body.text?.content || body.content || ''
  const fromId = body.from_id || 'wecom:webhook:default'
  if (content) enqueueSocialMessage(fromId, content, 'WECOM', { platform: 'wecom-webhook' })
  return jsonResponse(res, 200, { ok: true })
}

export async function handleSocialWebhook(req, res, url) {
  try {
    if (url.pathname === '/social/feishu/webhook') return await handleFeishu(req, res)
    if (url.pathname === '/social/wechat/official') return await handleWechatOfficial(req, res, url)
    if (url.pathname === '/social/wecom/webhook') return await handleWeCom(req, res)
    return jsonResponse(res, 404, { ok: false, error: 'unknown social webhook' })
  } catch (error) {
    return jsonResponse(res, 500, { ok: false, error: error.message })
  }
}
