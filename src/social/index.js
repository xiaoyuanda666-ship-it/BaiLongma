import { startDiscordConnector } from './discord.js'

const running = []

export async function startSocialConnectors({ pushMessage, emitEvent } = {}) {
  const starters = [
    () => startDiscordConnector({ pushMessage, emitEvent }),
  ]

  for (const start of starters) {
    try {
      const connector = await start()
      if (connector) running.push(connector)
    } catch (error) {
      console.warn(`[social] connector failed: ${error.message}`)
      emitEvent?.('social_status', { status: 'error', error: error.message })
    }
  }

  return running
}

