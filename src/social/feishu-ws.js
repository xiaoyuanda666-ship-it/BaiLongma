import { WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk'
import { env } from './utils.js'

const RECONNECT_LOG_INTERVAL_MS = 60_000

export async function startFeishuWSConnector({ pushMessage, emitEvent }) {
  const appId = env('FEISHU_APP_ID')
  const appSecret = env('FEISHU_APP_SECRET')
  if (!appId || !appSecret) return null

  console.log('[feishu-ws] starting long connection connector...')

  const eventDispatcher = new EventDispatcher({
    verificationToken: env('FEISHU_VERIFICATION_TOKEN') || undefined,
    encryptKey: env('FEISHU_ENCRYPT_KEY') || undefined,
})

  eventDispatcher.register({
    'im.message.receive_v1': (data) => {
      try {
        const event = data?.event || data
        const message = event?.message || {}
        const sender = event?.sender || {}

        let content = ''
        try {
          const parsed = JSON.parse(message.content || '{}')
          content = parsed.text || parsed.content || ''
        } catch {
          content = message.content || ''
        }

        const openId = sender?.sender_id?.open_id || sender?.sender_id?.user_id || ''
        const chatId = message.chat_id || ''
        const fromId = openId ? `feishu:open_id:${openId}` : (chatId ? `feishu:chat_id:${chatId}` : '')

        if (fromId && content.trim()) {
          pushMessage(fromId, content.trim(), 'FEISHU', { social: { platform: 'feishu', chat_id: chatId, message_id: message.message_id } })
          emitEvent?.('message_in', { from_id: fromId, content: content.trim(), channel: 'FEISHU', timestamp: new Date().toISOString() })
          console.log(`[feishu-ws] message from ${fromId}: ${content.trim().slice(0, 50)}`)
        }
      } catch (err) {
        console.error('[feishu-ws] error processing message:', err.message)
      }
    },
  })

  let wsClient = null
  let stopped = false

  function createClient() {
    wsClient = new WSClient({
      appId,
      appSecret,
      autoReconnect: true,
      handshakeTimeoutMs: 15000,
      onReady: () => {
        console.log('[feishu-ws] connected')
        emitEvent?.('social_status', { platform: 'feishu-ws', status: 'connected' })
      },
      onError: (err) => {
        console.error('[feishu-ws] connection error:', err.message)
        emitEvent?.('social_status', { platform: 'feishu-ws', status: 'error', error: err.message })
      },
      onReconnecting: () => {
        console.log('[feishu-ws] reconnecting...')
        emitEvent?.('social_status', { platform: 'feishu-ws', status: 'reconnecting' })
      },
      onReconnected: () => {
        console.log('[feishu-ws] reconnected')
        emitEvent?.('social_status', { platform: 'feishu-ws', status: 'reconnected' })
      },
    })

    return wsClient.start({ eventDispatcher })
  }

  await createClient()

  return {
    stop() {
      stopped = true
      if (wsClient) {
        wsClient.close({ force: true })
        wsClient = null
      }
      console.log('[feishu-ws] stopped')
    },
  }
}
