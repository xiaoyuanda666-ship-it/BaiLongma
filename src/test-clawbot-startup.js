import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-clawbot-startup-'))
process.env.BAILONGMA_USER_DIR = tmp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()

let closeDBForTest = null
try {
  const { getClawbotQR, logoutClawbot, startClawbotConnector } = await import('./social/wechat-clawbot.js')
  ;({ closeDBForTest } = await import('./db.js'))

  logoutClawbot()
  const events = []
  const connector = startClawbotConnector({
    pushMessage() {},
    emitEvent: (name, payload) => events.push({ name, payload }),
  })

  assert.equal(getClawbotQR().status, 'idle', 'app startup must not begin an unsolicited QR login')
  assert.equal(getClawbotQR().qr_url, null)
  assert(events.some(event => event.payload?.reason === 'not_configured'))
  connector.stop()
  console.log('PASS ClawBot waits for an explicit connect request')
} finally {
  try { closeDBForTest?.() } catch {}
  fs.rmSync(tmp, { recursive: true, force: true })
}
