import WebSocket from 'ws'
import { requestJson } from './http.js'

function env(name) {
  return String(globalThis.process?.env?.[name] || '').trim()
}

export async function startDiscordConnector({ pushMessage, emitEvent }) {
  const token = env('DISCORD_BOT_TOKEN')
  if (!token) return null

  const gatewayRes = await requestJson('https://discord.com/api/v10/gateway/bot', {
    headers: { Authorization: `Bot ${token}` },
  })
  if (!gatewayRes.ok || !gatewayRes.data?.url) throw new Error(`Discord gateway lookup failed: ${gatewayRes.text}`)

  const ws = new WebSocket(`${gatewayRes.data.url}/?v=10&encoding=json`)
  let heartbeatTimer = null
  let seq = null

  function send(payload) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }

  ws.on('message', raw => {
    let msg = null
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (msg.s != null) seq = msg.s

    if (msg.op === 10) {
      const interval = msg.d?.heartbeat_interval || 45000
      heartbeatTimer = setInterval(() => send({ op: 1, d: seq }), interval)
      heartbeatTimer.unref?.()
      send({
        op: 2,
        d: {
          token,
          intents: 512 | 4096 | 32768,
          properties: { os: 'windows', browser: 'bailongma', device: 'bailongma' },
        },
      })
      return
    }

    if (msg.t === 'READY') {
      emitEvent?.('social_status', { platform: 'discord', status: 'ready', user: msg.d?.user?.username })
      return
    }

    if (msg.t !== 'MESSAGE_CREATE') return
    const event = msg.d || {}
    if (!event.content || event.author?.bot) return
    const fromId = `discord:${event.channel_id}:${event.author?.id || 'unknown'}`
    pushMessage(fromId, event.content, 'DISCORD', {
      social: { platform: 'discord', channel_id: event.channel_id, author_id: event.author?.id || null },
    })
    emitEvent?.('message_in', { from_id: fromId, content: event.content, channel: 'DISCORD', timestamp: new Date().toISOString() })
  })

  ws.on('close', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    emitEvent?.('social_status', { platform: 'discord', status: 'closed' })
  })
  ws.on('error', error => {
    emitEvent?.('social_status', { platform: 'discord', status: 'error', error: error.message })
  })

  return {
    platform: 'discord',
    stop() {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      try { ws.close() } catch {}
    },
  }
}

