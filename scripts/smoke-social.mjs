import http from 'http'
import crypto from 'crypto'
import { startAPI } from '../src/api.js'
import { popMessage } from '../src/queue.js'

const port = 39000 + Math.floor(Math.random() * 1000)
process.env.WECHAT_OFFICIAL_TOKEN = 'smoke-token'

const server = startAPI(port)
const base = `http://127.0.0.1:${port}`

function postJson(path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function wechatSignature(timestamp, nonce) {
  return crypto.createHash('sha1').update(['smoke-token', timestamp, nonce].sort().join('')).digest('hex')
}

try {
  const challenge = await postJson('/social/feishu/webhook', { challenge: 'ok-challenge' }).then(r => r.json())
  if (challenge.challenge !== 'ok-challenge') throw new Error('Feishu challenge failed')

  await postJson('/social/feishu/webhook', {
    header: { event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: 'ou_smoke' } },
      message: { chat_id: 'oc_smoke', message_id: 'om_smoke', content: JSON.stringify({ text: 'hello feishu' }) },
    },
  })
  const feishuMsg = popMessage()
  if (feishuMsg?.fromId !== 'feishu:open_id:ou_smoke' || feishuMsg?.content !== 'hello feishu') throw new Error('Feishu message enqueue failed')

  const ts = '12345'
  const nonce = 'abc'
  const sig = wechatSignature(ts, nonce)
  const echo = await fetch(`${base}/social/wechat/official?signature=${sig}&timestamp=${ts}&nonce=${nonce}&echostr=echo-ok`).then(r => r.text())
  if (echo !== 'echo-ok') throw new Error('WeChat verification failed')

  await fetch(`${base}/social/wechat/official?signature=${sig}&timestamp=${ts}&nonce=${nonce}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: '<xml><ToUserName><![CDATA[to]]></ToUserName><FromUserName><![CDATA[from_openid]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hello wechat]]></Content></xml>',
  })
  const wechatMsg = popMessage()
  if (wechatMsg?.fromId !== 'wechat:official:from_openid' || wechatMsg?.content !== 'hello wechat') throw new Error('WeChat message enqueue failed')

  await postJson('/social/wecom/webhook', { from_id: 'wecom:webhook:default', content: 'hello wecom' })
  const wecomMsg = popMessage()
  if (wecomMsg?.fromId !== 'wecom:webhook:default' || wecomMsg?.content !== 'hello wecom') throw new Error('WeCom message enqueue failed')

  console.log('[PASS] social smoke')
} finally {
  await new Promise(resolve => server.close(resolve))
}

