import { requestJson } from './http.js'
import { parseSocialTarget } from './targets.js'

let feishuTenantToken = null
let feishuTokenExpiresAt = 0
let wechatAccessToken = null
let wechatAccessTokenExpiresAt = 0

function env(name) {
  return String(globalThis.process?.env?.[name] || '').trim()
}

async function sendDiscord({ channelId }, content) {
  const token = env('DISCORD_BOT_TOKEN')
  if (!token) return { ok: false, skipped: true, reason: 'DISCORD_BOT_TOKEN not configured' }
  const res = await requestJson(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}` },
    body: { content },
  })
  if (!res.ok) throw new Error(`Discord send failed HTTP ${res.status}: ${res.text}`)
  return { ok: true, platform: 'discord', id: res.data?.id || null }
}

async function getFeishuTenantToken() {
  const appId = env('FEISHU_APP_ID')
  const appSecret = env('FEISHU_APP_SECRET')
  if (!appId || !appSecret) throw new Error('FEISHU_APP_ID/FEISHU_APP_SECRET not configured')
  if (feishuTenantToken && Date.now() < feishuTokenExpiresAt) return feishuTenantToken
  const res = await requestJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    body: { app_id: appId, app_secret: appSecret },
  })
  if (!res.ok || res.data?.code !== 0) throw new Error(`Feishu token failed: ${res.text}`)
  feishuTenantToken = res.data.tenant_access_token
  feishuTokenExpiresAt = Date.now() + Math.max(60, Number(res.data.expire || 7200) - 120) * 1000
  return feishuTenantToken
}

async function sendFeishu({ receiveIdType, receiveId }, content) {
  const token = await getFeishuTenantToken()
  const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`
  const res = await requestJson(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: {
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text: content }),
    },
  })
  if (!res.ok || res.data?.code !== 0) throw new Error(`Feishu send failed: ${res.text}`)
  return { ok: true, platform: 'feishu', messageId: res.data?.data?.message_id || null }
}

async function getWechatAccessToken() {
  const appId = env('WECHAT_OFFICIAL_APP_ID')
  const secret = env('WECHAT_OFFICIAL_APP_SECRET')
  if (!appId || !secret) throw new Error('WECHAT_OFFICIAL_APP_ID/WECHAT_OFFICIAL_APP_SECRET not configured')
  if (wechatAccessToken && Date.now() < wechatAccessTokenExpiresAt) return wechatAccessToken
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`
  const res = await requestJson(url)
  if (!res.ok || !res.data?.access_token) throw new Error(`WeChat token failed: ${res.text}`)
  wechatAccessToken = res.data.access_token
  wechatAccessTokenExpiresAt = Date.now() + Math.max(60, Number(res.data.expires_in || 7200) - 120) * 1000
  return wechatAccessToken
}

async function sendWechatOfficial({ openId }, content) {
  const token = await getWechatAccessToken()
  const res = await requestJson(`https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    body: {
      touser: openId,
      msgtype: 'text',
      text: { content },
    },
  })
  if (!res.ok || (res.data?.errcode && res.data.errcode !== 0)) throw new Error(`WeChat send failed: ${res.text}`)
  return { ok: true, platform: 'wechat-official' }
}

async function sendWeComWebhook(target, content) {
  const key = target.key || env('WECOM_BOT_KEY')
  if (!key) return { ok: false, skipped: true, reason: 'WECOM_BOT_KEY not configured' }
  const res = await requestJson(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    body: { msgtype: 'text', text: { content } },
  })
  if (!res.ok || (res.data?.errcode && res.data.errcode !== 0)) throw new Error(`WeCom webhook send failed: ${res.text}`)
  return { ok: true, platform: 'wecom-webhook' }
}

export async function dispatchSocialMessage(targetId, content) {
  const target = parseSocialTarget(targetId)
  if (!target) return null
  switch (target.platform) {
    case 'discord':
      return await sendDiscord(target, content)
    case 'feishu':
      return await sendFeishu(target, content)
    case 'wechat-official':
      return await sendWechatOfficial(target, content)
    case 'wecom-webhook':
      return await sendWeComWebhook(target, content)
    default:
      return null
  }
}

