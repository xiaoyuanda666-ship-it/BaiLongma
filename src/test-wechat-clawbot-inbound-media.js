import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-wechat-media-'))
process.env.JARVIS_USER_DIR = tmp
process.env.JARVIS_RESOURCES_DIR = process.cwd()

let closeDBForTest = null

try {
  const {
    buildClawbotInboundContent,
    handleClawbotInboundMessage,
    pickClawbotInboundMediaItems,
    storeClawbotDownloadedMedia,
  } = await import('./social/wechat-clawbot.js')
  ;({ closeDBForTest } = await import('./db.js'))

  const pdf = Buffer.from('%PDF-1.4\n% test pdf\n')
  const fileAttachment = storeClawbotDownloadedMedia(
    { data: pdf, kind: 'file', fileName: 'report.pdf' },
    { type: 4, file_item: { file_name: 'report.pdf' } },
  )
  assert.equal(fileAttachment.kind, 'file')
  assert.equal(fileAttachment.fileName, 'report.pdf')
  assert.equal(fileAttachment.mime, 'application/pdf')
  assert.equal(path.extname(fileAttachment.path), '.pdf')
  assert(fs.existsSync(fileAttachment.path), 'downloaded file is persisted')

  const fileContent = buildClawbotInboundContent('请看这个', [fileAttachment])
  assert.match(fileContent, /用户从微信发来文件/)
  assert.match(fileContent, /report\.pdf/)
  assert.match(fileContent, /本地路径：/)

  const picked = pickClawbotInboundMediaItems({
    item_list: [
      { type: 4, file_item: { media: { full_url: 'https://cdn.example/file' }, file_name: 'a.pdf' } },
      { type: 2, image_item: { media: { full_url: 'https://cdn.example/image' } } },
    ],
  })
  assert.equal(picked[0].type, 2, 'image is prioritized before file')

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  let pushed = null
  let event = null
  const result = await handleClawbotInboundMessage({
    message_type: 1,
    from_user_id: 'wx-user-1',
    context_token: 'ctx-token',
    item_list: [
      { type: 2, image_item: { media: { encrypt_query_param: 'encrypted-param' } } },
    ],
  }, {
    pushMessage(fromId, content, channel, meta) {
      pushed = { fromId, content, channel, meta }
      return { conversationId: 42 }
    },
    emitEvent(type, payload) {
      event = { type, payload }
    },
    downloadMediaItem: async () => ({ data: png, kind: 'image' }),
  })

  assert(result, 'pure media message is handled')
  assert.match(result.content, /!\[wechat-image\.png\]\(\/media\/chat\//)
  assert.equal(pushed.fromId, 'wechat:clawbot:wx-user-1')
  assert.equal(pushed.channel, 'WECHAT_CLAWBOT')
  assert.equal(pushed.meta.attachments[0].kind, 'image')
  assert.equal(event.type, 'message_in')
  assert.equal(event.payload.attachments[0].kind, 'image')

  console.log('PASS wechat-clawbot inbound media is persisted and queued')
} finally {
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}

process.exit(process.exitCode || 0)
