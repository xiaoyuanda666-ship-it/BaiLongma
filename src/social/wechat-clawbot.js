import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import {
  WeChatClient,
  MessageType,
  MessageItemType,
  UploadMediaType,
  aesEcbPaddedSize,
  decryptAesEcb,
  encryptAesEcb,
  getMimeFromFilename,
} from 'wechat-ilink-client'
import { getClawbotCredentials, setClawbotCredentials, clearClawbotCredentials } from '../config.js'
import { upsertClawbotToken, getAllClawbotTokens } from '../db.js'
import { markdownImage, mimeFromChatMediaExt, persistChatMediaBuffer } from '../chat-media.js'

let client = null
let currentQrUrl = null   // set during login, cleared after scan
let clawbotStatus = 'idle' // idle | qr_pending | connected | error

const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const MAX_INBOUND_MEDIA_ITEMS = 4
const WECHAT_INBOUND_MEDIA_MAX_BYTES = 100 * 1024 * 1024

function normalizeClawbotPayload(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return {
      text: String(payload.text ?? payload.content ?? '').trim(),
      mediaPath: String(payload.mediaPath ?? payload.media_path ?? '').trim(),
      mediaKind: String(payload.mediaKind ?? payload.media_kind ?? '').trim(),
      fileName: String(payload.fileName ?? payload.file_name ?? '').trim(),
    }
  }
  return { text: String(payload ?? '').trim(), mediaPath: '', mediaKind: '', fileName: '' }
}

function itemType(item) {
  return Number(item?.type || 0)
}

function isClawbotMediaItem(item) {
  return itemType(item) === MessageItemType.IMAGE
    || itemType(item) === MessageItemType.VIDEO
    || itemType(item) === MessageItemType.FILE
    || itemType(item) === MessageItemType.VOICE
}

function mediaRefForItem(item) {
  switch (itemType(item)) {
    case MessageItemType.IMAGE: {
      const media = item?.image_item?.media
      return {
        kind: 'image',
        media,
        aesKeyBase64: item?.image_item?.aeskey
          ? Buffer.from(String(item.image_item.aeskey), 'hex').toString('base64')
          : media?.aes_key,
      }
    }
    case MessageItemType.VIDEO:
      return { kind: 'video', media: item?.video_item?.media, aesKeyBase64: item?.video_item?.media?.aes_key }
    case MessageItemType.FILE:
      return {
        kind: 'file',
        media: item?.file_item?.media,
        aesKeyBase64: item?.file_item?.media?.aes_key,
        fileName: item?.file_item?.file_name,
      }
    case MessageItemType.VOICE:
      return { kind: 'voice', media: item?.voice_item?.media, aesKeyBase64: item?.voice_item?.media?.aes_key }
    default:
      return null
  }
}

function hasDownloadableMedia(item) {
  const ref = mediaRefForItem(item)
  return !!(ref?.media?.encrypt_query_param || ref?.media?.full_url)
}

function cleanFileName(value = '') {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const base = path.basename(raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')).trim()
  return base.slice(0, 180)
}

function extFromUrl(raw = '') {
  const text = String(raw || '').trim()
  if (!text) return ''
  try {
    const ext = path.extname(new URL(text).pathname).toLowerCase()
    return ext && ext.length <= 12 ? ext : ''
  } catch {
    const ext = path.extname(text.split('?')[0]).toLowerCase()
    return ext && ext.length <= 12 ? ext : ''
  }
}

function sniffExt(buffer, kind = '') {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '')
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return '.jpg'
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a')) return '.gif'
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF') return '.pdf'
  if (buf.length >= 2 && buf.subarray(0, 2).toString('ascii') === 'PK') return '.zip'
  if (buf.length >= 12) {
    if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
    if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return '.mp4'
  }
  if (kind === 'video') return '.mp4'
  if (kind === 'voice') return '.silk'
  if (kind === 'image') return '.jpg'
  return '.bin'
}

function defaultExtForVoice(item) {
  switch (Number(item?.voice_item?.encode_type || 0)) {
    case 5: return '.amr'
    case 7: return '.mp3'
    case 8: return '.ogg'
    case 6:
    default:
      return '.silk'
  }
}

function inferInboundMediaExt({ downloaded, item, fileName }) {
  const byName = path.extname(fileName || '').toLowerCase()
  if (byName) return byName
  if (itemType(item) === MessageItemType.VOICE) return defaultExtForVoice(item)
  const byUrl = extFromUrl(item?.image_item?.url)
    || extFromUrl(item?.image_item?.media?.full_url)
    || extFromUrl(item?.video_item?.media?.full_url)
    || extFromUrl(item?.file_item?.media?.full_url)
    || extFromUrl(item?.voice_item?.media?.full_url)
  if (byUrl) return byUrl
  return sniffExt(downloaded?.data, downloaded?.kind)
}

function defaultInboundFileName(kind, ext) {
  const suffix = ext || '.bin'
  if (kind === 'image') return `wechat-image${suffix}`
  if (kind === 'video') return `wechat-video${suffix}`
  if (kind === 'voice') return `wechat-voice${suffix}`
  return `wechat-file${suffix}`
}

export function storeClawbotDownloadedMedia(downloaded, item = {}) {
  const data = Buffer.isBuffer(downloaded?.data) ? downloaded.data : Buffer.from(downloaded?.data || '')
  if (!data.length) throw new Error('downloaded media is empty')
  if (data.length > WECHAT_INBOUND_MEDIA_MAX_BYTES) {
    throw new Error(`downloaded media is larger than ${Math.round(WECHAT_INBOUND_MEDIA_MAX_BYTES / 1024 / 1024)}MB`)
  }
  const ref = mediaRefForItem(item)
  const kind = String(downloaded?.kind || ref?.kind || 'file')
  const originalName = cleanFileName(downloaded?.fileName || ref?.fileName || '')
  const ext = inferInboundMediaExt({ downloaded, item, fileName: originalName })
  const fileName = originalName || defaultInboundFileName(kind, ext)
  const stored = persistChatMediaBuffer(data, {
    ext,
    mime: mimeFromChatMediaExt(ext),
    originalFilename: fileName,
  })
  return {
    kind,
    path: stored.path,
    url: stored.url,
    fileName,
    storedName: stored.filename,
    mime: stored.mime,
    size: stored.size,
  }
}

function formatBytes(size = 0) {
  const n = Number(size || 0)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function mediaLabel(kind = '') {
  if (kind === 'image') return '图片'
  if (kind === 'video') return '视频'
  if (kind === 'voice') return '语音'
  return '文件'
}

function formatInboundAttachmentForAgent(att) {
  if (att.kind === 'image') {
    return markdownImage(att.url, att.fileName || 'wechat image')
  }
  const label = mediaLabel(att.kind)
  const linkedName = att.url ? `[微信${label}：${att.fileName || att.storedName}](${att.url})` : `微信${label}：${att.fileName || att.storedName}`
  return [
    `用户从微信发来${label}：${linkedName}`,
    `本地路径：${att.path}`,
    `MIME：${att.mime || 'application/octet-stream'}，大小：${formatBytes(att.size)}`,
  ].join('\n')
}

export function buildClawbotInboundContent(text = '', attachments = [], notices = []) {
  const parts = []
  for (const att of attachments || []) parts.push(formatInboundAttachmentForAgent(att))
  for (const notice of notices || []) {
    const clean = String(notice || '').trim()
    if (clean) parts.push(clean)
  }
  const cleanText = String(text || '').trim()
  if (cleanText) parts.push(cleanText)
  return parts.join('\n\n').trim()
}

function parseCdnAesKey(aesKeyBase64 = '') {
  const decoded = Buffer.from(String(aesKeyBase64 || ''), 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(`aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`)
}

async function fetchCdnMediaBytes(media, cdnBaseUrl) {
  const fullUrl = String(media?.full_url || '').trim()
  const encryptedQueryParam = String(media?.encrypt_query_param || '').trim()
  if (!fullUrl && !encryptedQueryParam) return null
  const base = String(cdnBaseUrl || DEFAULT_CDN_BASE_URL).replace(/\/$/, '')
  const url = fullUrl || `${base}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`CDN download failed ${res.status}: ${body.slice(0, 200)}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

async function downloadClawbotMediaItemFallback(item, cdnBaseUrl) {
  const ref = mediaRefForItem(item)
  if (!ref?.media) return null
  const encrypted = await fetchCdnMediaBytes(ref.media, cdnBaseUrl)
  if (!encrypted) return null
  const data = ref.aesKeyBase64
    ? decryptAesEcb(encrypted, parseCdnAesKey(ref.aesKeyBase64))
    : encrypted
  return { data, kind: ref.kind, fileName: ref.fileName }
}

export async function downloadClawbotMediaItem(item, downloaderClient = client) {
  let primaryError = null
  if (typeof downloaderClient?.downloadMedia === 'function') {
    try {
      const downloaded = await downloaderClient.downloadMedia(item)
      if (downloaded?.data) return downloaded
    } catch (err) {
      primaryError = err
    }
  }
  try {
    const fallback = await downloadClawbotMediaItemFallback(item, downloaderClient?.api?.cdnBaseUrl || client?.api?.cdnBaseUrl)
    if (fallback?.data) return fallback
  } catch (err) {
    if (!primaryError) primaryError = err
  }
  if (primaryError) throw primaryError
  return null
}

export function pickClawbotInboundMediaItems(msg) {
  const items = Array.isArray(msg?.item_list) ? msg.item_list : []
  const priority = new Map([
    [MessageItemType.IMAGE, 1],
    [MessageItemType.VIDEO, 2],
    [MessageItemType.FILE, 3],
    [MessageItemType.VOICE, 4],
  ])
  const main = items
    .filter(item => isClawbotMediaItem(item)
      && hasDownloadableMedia(item)
      && !(itemType(item) === MessageItemType.VOICE && item?.voice_item?.text))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (priority.get(itemType(a.item)) || 99) - (priority.get(itemType(b.item)) || 99) || a.index - b.index)
    .map(entry => entry.item)

  if (main.length) return main.slice(0, MAX_INBOUND_MEDIA_ITEMS)

  const refMedia = items.find(item =>
    itemType(item) === MessageItemType.TEXT
    && item?.ref_msg?.message_item
    && isClawbotMediaItem(item.ref_msg.message_item)
    && hasDownloadableMedia(item.ref_msg.message_item)
  )?.ref_msg?.message_item

  return refMedia ? [refMedia] : []
}

async function collectClawbotInboundMedia(msg, { downloadMediaItem = downloadClawbotMediaItem } = {}) {
  const attachments = []
  const notices = []
  for (const item of pickClawbotInboundMediaItems(msg)) {
    const label = mediaLabel(mediaRefForItem(item)?.kind)
    try {
      const downloaded = await downloadMediaItem(item)
      if (!downloaded?.data) {
        notices.push(`用户从微信发来${label}，但系统没有拿到可下载内容。`)
        continue
      }
      attachments.push(storeClawbotDownloadedMedia(downloaded, item))
    } catch (err) {
      const message = err?.message || String(err)
      console.warn(`[ClawBot] inbound ${label} download failed: ${message}`)
      notices.push(`用户从微信发来${label}，但下载或解密失败：${message}`)
    }
  }
  return { attachments, notices }
}

function extractClawbotText(msg) {
  const text = WeChatClient.extractText?.(msg)
  return String(text ?? extractText(msg) ?? '').trim()
}

export async function handleClawbotInboundMessage(msg, {
  pushMessage,
  emitEvent,
  downloadMediaItem = downloadClawbotMediaItem,
} = {}) {
  if (!msg) return null
  if (msg.message_type != null && Number(msg.message_type) !== MessageType.USER) return null

  if (msg?.context_token && msg?.from_user_id) {
    try { upsertClawbotToken(msg.from_user_id, msg.context_token) } catch {}
  }

  const userId = String(msg.from_user_id || '').trim()
  if (!userId) return null

  const text = extractClawbotText(msg)
  const { attachments, notices } = await collectClawbotInboundMedia(msg, { downloadMediaItem })
  const content = buildClawbotInboundContent(text, attachments, notices)
  if (!content) return null

  const fromId = `wechat:clawbot:${userId}`
  const meta = {
    social: { platform: 'wechat-clawbot', user_id: userId },
  }
  if (attachments.length) meta.attachments = attachments
  const queued = pushMessage?.(fromId, content, 'WECHAT_CLAWBOT', meta)
  emitEvent?.('message_in', {
    from_id: fromId,
    content,
    channel: 'WECHAT_CLAWBOT',
    timestamp: new Date().toISOString(),
    conversation_id: queued?.conversationId || 0,
    attachments,
  })
  return { fromId, content, attachments, queued }
}

function inferUploadMediaType(filePath) {
  const mime = getMimeFromFilename(filePath)
  if (mime.startsWith('image/')) return { mediaType: UploadMediaType.IMAGE, kind: 'image' }
  if (mime.startsWith('video/')) return { mediaType: UploadMediaType.VIDEO, kind: 'video' }
  return { mediaType: UploadMediaType.FILE, kind: 'file' }
}

function pickUploadUrl(uploadUrlResp, filekey, cdnBaseUrl) {
  const directUrl = uploadUrlResp?.upload_full_url
    || uploadUrlResp?.full_upload_url
    || uploadUrlResp?.upload_url
  if (directUrl) return String(directUrl)

  const uploadParam = uploadUrlResp?.upload_param
    || uploadUrlResp?.uploadParam
    || uploadUrlResp?.encrypted_query_param
  if (!uploadParam) return ''

  const url = new URL('/c2c/upload', cdnBaseUrl || 'https://novac2c.cdn.weixin.qq.com')
  url.searchParams.set('encrypted_query_param', String(uploadParam))
  url.searchParams.set('filekey', filekey)
  const taskId = uploadUrlResp?.taskid || uploadUrlResp?.task_id
  if (taskId) url.searchParams.set('taskid', String(taskId))
  return url.toString()
}

async function uploadEncryptedBuffer(uploadUrl, plaintext, aeskey) {
  const ciphertext = encryptAesEcb(plaintext, aeskey)
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      })
      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get('x-error-message') || await res.text()
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`)
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get('x-error-message') || `status ${res.status}`
        throw new Error(`CDN upload server error: ${errMsg}`)
      }
      const downloadParam = res.headers.get('x-encrypted-param') || ''
      if (!downloadParam) throw new Error('CDN upload response missing x-encrypted-param header')
      return downloadParam
    } catch (err) {
      lastError = err
      if (err?.message?.includes('client error')) throw err
      if (attempt >= 3) break
    }
  }
  throw lastError || new Error('CDN upload failed after 3 attempts')
}

async function uploadMediaViaClawbotApi(userId, filePath) {
  const plaintext = await fs.readFile(filePath)
  const rawsize = plaintext.length
  const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex')
  const filesize = aesEcbPaddedSize(rawsize)
  const filekey = crypto.randomBytes(16).toString('hex')
  const aeskey = crypto.randomBytes(16)
  const { mediaType, kind } = inferUploadMediaType(filePath)

  const uploadUrlResp = await client.api.getUploadUrl({
    filekey,
    media_type: mediaType,
    to_user_id: userId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString('hex'),
  })
  const ret = uploadUrlResp?.ret ?? uploadUrlResp?.code ?? uploadUrlResp?.errcode
  if (ret != null && ret !== 0) {
    const errMsg = uploadUrlResp?.err_msg || uploadUrlResp?.errmsg || uploadUrlResp?.message || uploadUrlResp?.msg || ''
    throw new Error(`getUploadUrl rejected: ret=${ret} ${errMsg}`.trim())
  }

  const uploadUrl = pickUploadUrl(uploadUrlResp, filekey, client.api?.cdnBaseUrl)
  if (!uploadUrl) throw new Error(`getUploadUrl returned no upload URL: ${JSON.stringify(uploadUrlResp)}`)

  const downloadParam = await uploadEncryptedBuffer(uploadUrl, plaintext, aeskey)
  return {
    kind,
    uploaded: {
      filekey,
      downloadEncryptedQueryParam: downloadParam,
      aeskey: aeskey.toString('hex'),
      fileSize: rawsize,
      fileSizeCiphertext: filesize,
    },
  }
}

async function sendClawbotMedia(userId, message) {
  const contextToken = client.contextTokens instanceof Map ? client.contextTokens.get(userId) : ''
  if (!contextToken) throw new Error(`No context_token for user ${userId}. Receive a message from them first.`)
  const { kind, uploaded } = await uploadMediaViaClawbotApi(userId, message.mediaPath)
  const caption = message.text || undefined
  if (kind === 'image') {
    await client.sendUploadedImage(userId, uploaded, caption, contextToken)
  } else if (kind === 'video') {
    await client.sendUploadedVideo(userId, uploaded, caption, contextToken)
  } else {
    await client.sendUploadedFile(userId, message.fileName || path.basename(message.mediaPath), uploaded, caption, contextToken)
  }
  return kind
}

// Called by dispatch.js to send replies back to WeChat
export async function sendClawbotMessage(userId, payload) {
  const message = normalizeClawbotPayload(payload)
  if (!message.text && !message.mediaPath) {
    return { ok: false, reason: 'empty wechat-clawbot message' }
  }
  if (!client || clawbotStatus !== 'connected') {
    return { ok: false, reason: 'wechat-clawbot not connected' }
  }
  try {
    if (message.mediaPath) {
      const kind = await sendClawbotMedia(userId, message)
      return { ok: true, platform: 'wechat-clawbot', kind }
    }
    await client.sendText(userId, message.text)
    return { ok: true, platform: 'wechat-clawbot', kind: 'text' }
  } catch (err) {
    const action = message.mediaPath ? 'sendMedia' : 'sendText'
    console.error(`[ClawBot] ${action} failed: ${err.message}`)
    return { ok: false, error: err.message }
  }
}

// Called by api.js for GET /social/wechat-clawbot/qr
export function getClawbotQR() {
  return { status: clawbotStatus, qr_url: currentQrUrl }
}

// Called by api.js for POST /social/wechat-clawbot/logout
export function logoutClawbot() {
  clearClawbotCredentials()
  clawbotStatus = 'idle'
  currentQrUrl = null
  try { client?.stop?.() } catch {}
  client = null
}

export function startClawbotConnector({ pushMessage, emitEvent, allowQrLogin = false } = {}) {
  const saved = getClawbotCredentials()

  // Starting the whole app must not silently launch a short-lived QR session.
  // With no saved credentials, wait until the user explicitly presses Connect;
  // restartConnector passes allowQrLogin=true for that path.
  if (!saved && !allowQrLogin) {
    client = null
    currentQrUrl = null
    clawbotStatus = 'idle'
    console.log('[ClawBot] 未配置凭证，等待用户主动连接')
    emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'idle', reason: 'not_configured' })
    return {
      platform: 'wechat-clawbot',
      stop() {
        clawbotStatus = 'idle'
        currentQrUrl = null
      },
    }
  }

  client = new WeChatClient(saved ? {
    accountId: saved.accountId,
    token: saved.botToken,
    baseUrl: saved.baseUrl,
  } : {})

  // Monkey-patch client.api.apiFetch：库内部 sendMessage 只 await apiFetch、丢掉响应文本，
  // 而 apiFetch 仅在 HTTP !res.ok 时抛错——HTTP 200 + body 里 {"ret": -1} 这种业务失败被完全吞掉，
  // 导致 sendText 报"成功"但消息没投递。这里拦响应：sendmessage 端点解析 JSON，
  // 发现非零 ret/code 时显式抛错，让上层 sendClawbotMessage 的 catch 拿到真实失败原因。
  try {
    const rawApiFetch = client.api?.apiFetch?.bind(client.api)
    if (typeof rawApiFetch === 'function') {
      client.api.apiFetch = async (params) => {
        const rawText = await rawApiFetch(params)
        if (params?.endpoint === 'ilink/bot/sendmessage') {
          let body = null
          try { body = JSON.parse(rawText) } catch {}
          if (body && typeof body === 'object') {
            const ret = body.ret ?? body.code ?? body.errcode
            if (ret != null && ret !== 0) {
              const errMsg = body.err_msg || body.errmsg || body.message || body.msg || ''
              console.error(`[ClawBot] sendMessage 服务端拒绝 ret=${ret} ${errMsg} raw=${rawText.slice(0, 500)}`)
              throw new Error(`iLink sendmessage rejected: ret=${ret} ${errMsg}`)
            }
          }
        }
        return rawText
      }
      console.log('[ClawBot] sendMessage 响应校验已启用')
    } else {
      console.warn('[ClawBot] client.api.apiFetch 不可访问，跳过响应校验（库实现可能已变化）')
    }
  } catch (err) {
    console.warn(`[ClawBot] 安装响应校验失败（不致命，继续启动）: ${err.message}`)
  }

  // 启动时把上次落盘的 context_token 回填到内存 Map：
  // ilink 库 sendText 用的是 this.contextTokens.get(to)，重启后这个 Map 是空的；
  // 不回填则只能等用户先发一条新消息才能回复。token 可能服务端已过期，所以
  // sendText 仍可能失败，executor 已有兜底提示，这里只是尽量恢复。
  // contextTokens 在 .d.ts 里是 private 但运行时是普通 class field —— 加 guard 防作者哪天换成 # 真私有。
  try {
    if (client.contextTokens instanceof Map) {
      const rows = getAllClawbotTokens()
      if (rows.length) {
        for (const row of rows) {
          client.contextTokens.set(row.from_user_id, row.context_token)
        }
        console.log(`[ClawBot] 已从持久化恢复 ${rows.length} 条 context_token`)
      }
    } else {
      console.warn('[ClawBot] client.contextTokens 不可访问（库实现可能已变化），跳过 token 恢复')
    }
  } catch (err) {
    console.warn(`[ClawBot] 恢复 context_token 失败（不致命，继续启动）: ${err.message}`)
  }

  client.on('message', (msg) => {
    // Download/decrypt inbound media before placing the message on the agent queue.
    void handleClawbotInboundMessage(msg, { pushMessage, emitEvent }).catch(err => {
      console.error(`[ClawBot] inbound message handling failed: ${err?.message || err}`)
      emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'error', error: err?.message || String(err) })
    })
  })

  client.on('error', (err) => {
    console.error(`[ClawBot] 错误: ${err.message}`)
    emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'error', error: err.message })
  })

  client.on('sessionExpired', () => {
    console.warn('[ClawBot] 会话已过期，请重新扫码登录')
    clearClawbotCredentials()
    clawbotStatus = 'idle'
    emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'session_expired' })
  })

  if (!saved) {
    // 首次登录：发起扫码流程
    clawbotStatus = 'qr_pending'
    console.log('[ClawBot] 未找到已保存凭证，开始扫码登录...')
    emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'qr_pending' })

    client.login({
      onQRCode(url) {
        currentQrUrl = url
        clawbotStatus = 'qr_ready'
        console.log(`[ClawBot] 二维码已就绪，请在设置面板扫码`)
        emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'qr_ready', qr_url: url })
      },
    }).then(result => {
      currentQrUrl = null
      // wechat-ilink-client 的 login() 在超时/取消等情况下不会 reject，
      // 而是 resolve 一个 { connected: false, message } —— 必须显式检查 connected 字段，
      // 否则会误把超时当成扫码成功，UI 卡在虚假的"已连接"
      if (!result?.connected || !result?.accountId || !result?.botToken) {
        clawbotStatus = 'idle'
        const reason = result?.message || '未知原因'
        console.warn(`[ClawBot] 扫码登录未完成: ${reason}`)
        emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'idle', reason })
        return
      }
      clawbotStatus = 'connected'
      setClawbotCredentials({
        accountId: result.accountId,
        botToken: result.botToken,
        baseUrl: result.baseUrl,
      })
      console.log(`[ClawBot] 扫码登录成功，已保存凭证`)
      emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'connected', accountId: result.accountId })
      client.start().catch(err => console.error(`[ClawBot] start 失败: ${err.message}`))
    }).catch(err => {
      clawbotStatus = 'error'
      console.error(`[ClawBot] 扫码登录失败: ${err.message}`)
      emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'error', error: err.message })
    })
  } else {
    // 凭证已存，直接启动
    clawbotStatus = 'connected'
    console.log(`[ClawBot] 使用已保存凭证启动（accountId: ${saved.accountId}）`)
    emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'connected', accountId: saved.accountId })
    client.start().catch(err => {
      // start 失败说明凭证已失效或后端连不上 —— 必须同步把内存状态打回去，
      // 否则 popup 查询时仍会拿到 'connected'，UI 显示"已连接"但实际啥都不通
      clawbotStatus = 'error'
      console.error(`[ClawBot] start 失败: ${err.message}`)
      emitEvent?.('social_status', { platform: 'wechat-clawbot', status: 'error', error: err.message })
    })
  }

  return {
    platform: 'wechat-clawbot',
    stop() {
      clawbotStatus = 'idle'
      try { client?.stop?.() } catch {}
    },
  }
}

// 从消息结构中提取文本（兼容 extractText 未导出的情况）
function extractText(msg) {
  if (!msg) return ''
  const items = msg.item_list || msg.itemList || []
  for (const item of items) {
    if (item.type === 1 || item.type === 'text') {
      return item.text_item?.text || item.textItem?.text || ''
    }
  }
  return ''
}
