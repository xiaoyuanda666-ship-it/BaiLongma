import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { nowTimestamp } from '../time.js'
import { normalizeConversationPartyId, upsertPrefetchTask, removePrefetchTask, listPrefetchTasks, insertConversation, setConfig as dbSetConfig, markConversationOpenQuestion, findRecentJarvisDuplicate, getRecentActionLogs } from '../db.js'
import { emitEvent, setStickyEvent } from '../events.js'
import { dispatchSocialMessage } from '../social/dispatch.js'
import { setCustomInterval as setTickerInterval, getStatus as getTickerStatus } from '../ticker.js'
import { setHotspotPanelState, getHotspotPanelState } from '../hotspots.js'
import { setWorldcupPanelState, getWorldcupPanelState } from '../worldcup.js'
import { setPersonCardPanelState, getPersonCardPanelState, getPersonCard } from '../person-cards.js'
import { setDocPanelState, getDocPanelState } from '../docs.js'
import { setUserLocation } from '../weather.js'
import { getAgentById, isDelegationAllowed } from '../agents/registry.js'
import { installTool, uninstallTool, listInstalledTools, isInstalledTool, executeInstalledTool, getInstalledToolSchema } from './marketplace/index.js'
import { execManageToolFactory } from './tool-factory.js'
import { TOOL_SCHEMAS } from './schemas.js'
import { TOOL_GROUPS } from '../memory/tool-router.js'
import { throwIfAborted } from './abort-utils.js'
import { execUISet } from './tools/scene.js'
import { sceneStore } from '../scene/scene-store.js'
import { sceneClientCount } from '../scene/scene-server.js'
import { evaluateToolPolicy } from './tool-policy.js'
import { inferToolStatus, writeToolAuditLog } from './tool-audit.js'
import { execDeleteFile, execListDir, execMakeDir, execReadFile, execWriteFile } from './tools/filesystem.js'
import { execBackgroundCommand, execCommand, execDownloadFile, execKillProcess, execListProcesses, execQuickCommand, execTaskCommand } from './tools/shell.js'
import { execInstallSoftware, listSoftwareInstallJobs } from './tools/software-install.js'
import { execBrowserRead, execFetchUrl, execWebSearch } from './tools/web.js'
import { execDowngradeMemory, execMergeMemories, execProbeMemory, execRecallMemory, execSearchMemory, execSkipConsolidation, execSkipRecognition, execUpsertMemory } from './tools/memory.js'
import { execManageReminder } from './tools/reminders.js'
import { execGenerateImage, execGenerateLyrics, execGenerateMusic, execGenerateVideo, execMediaMode, execMusic, execSpeak } from './tools/media.js'
import { execManageRule } from './tools/rules.js'
import { runWorkReview } from '../review/reviewer.js'
export { calculateNextDueAt } from './tools/reminders.js'
export { autoSpeakForVoiceReply } from './tools/media.js'

import { config, setSecurity } from '../config.js'
import { paths } from '../paths.js'
import { lookupReplyTarget, normalizeChannel, suggestProactiveChannel } from '../identity.js'

// P0-2：识别 send_message 末尾是否留了"非澄清型 follow-up question"。
//   触发条件：
//     - 结尾包含问号（? / ？）
//     - 问号所在句子里有"要 / 想 / 需要 / 是否 / 要不要 / 需不需要 / 帮 / 给 / 行不行"
//       或英文 "should/want/need/shall/would you like/do you want"
//   澄清型（"在哪个城市？"/"几点？"）也会被命中——可接受，因为标记本身不影响
//   当前轮输出，只在后续轮该悬念过期时降权，避免代词被钩偏。
const FOLLOWUP_VERB_RE = /(要不要|需不需要|要么|要|想|需要|是否|帮我?|给我?|行不行|可以吗|好吗|可否|能否)/
const FOLLOWUP_EN_RE = /\b(should|want|need|shall|would you like|do you want|may i|can i)\b/i
const OUTBOUND_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const OUTBOUND_VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi'])

export function detectOpenFollowupQuestion(text = '') {
  const s = String(text || '').trim()
  if (!s) return false
  // 必须有问号
  if (!/[?？]\s*$/.test(s) && !/[?？]\s*[")'』」】）)]?\s*$/.test(s)) return false
  // 取末尾问号所在的句子片段
  const segs = s.split(/[。!！\n]+/).filter(Boolean)
  const lastSeg = segs[segs.length - 1] || s
  return FOLLOWUP_VERB_RE.test(lastSeg) || FOLLOWUP_EN_RE.test(lastSeg)
}

function inferOutboundMediaKind(filePath = '') {
  const ext = path.extname(filePath).toLowerCase()
  if (OUTBOUND_IMAGE_EXTS.has(ext)) return 'image'
  if (OUTBOUND_VIDEO_EXTS.has(ext)) return 'video'
  return 'file'
}

// 把聊天媒体复制进受管的内容寻址仓库（data/media/<sha256>.<ext>），返回供前端渲染的稳定 URL。
//   - 内容寻址：同图只存一份；原文件被同名替换成别的内容时哈希必然不同，老消息仍指向老副本。
//   - 与原始路径解耦：截图/临时文件即便事后被删，聊天记录里的图依旧能显示。
// 失败（如磁盘错误）时返回 null，调用方退化为仅文本标记，不阻断消息发送。
function persistChatMedia(resolvedPath) {
  try {
    const buf = fs.readFileSync(resolvedPath)
    const hash = crypto.createHash('sha256').update(buf).digest('hex')
    const ext = path.extname(resolvedPath).toLowerCase()
    const storedName = `${hash}${ext}`
    const storedPath = path.join(paths.mediaDir, storedName)
    if (!fs.existsSync(storedPath)) fs.writeFileSync(storedPath, buf)
    return `/media/chat/${storedName}`
  } catch (err) {
    console.warn(`[media] 聊天媒体落盘失败（退化为纯文本标记）：${err.message}`)
    return null
  }
}

function normalizeOptionalPath(value) {
  const text = value == null ? '' : String(value).trim()
  return text || ''
}

function prepareOutboundMedia({ image_path, media_path } = {}) {
  const imagePath = normalizeOptionalPath(image_path)
  const mediaPath = normalizeOptionalPath(media_path)
  if (imagePath && mediaPath && path.resolve(imagePath) !== path.resolve(mediaPath)) {
    return { error: 'Provide only one of image_path or media_path.' }
  }

  const rawPath = imagePath || mediaPath
  if (!rawPath) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath)) {
    return { error: 'media_path must be a local file path, not a URL.' }
  }

  let resolvedPath = ''
  try {
    resolvedPath = path.resolve(rawPath)
  } catch (err) {
    return { error: `Invalid media path: ${err.message}` }
  }

  let stat = null
  try {
    stat = fs.statSync(resolvedPath)
  } catch {
    return { error: `Media file does not exist: ${resolvedPath}` }
  }
  if (!stat.isFile()) return { error: `Media path is not a file: ${resolvedPath}` }

  const kind = inferOutboundMediaKind(resolvedPath)
  if (imagePath && kind !== 'image') {
    return { error: 'image_path must point to an image file (.png, .jpg, .jpeg, .gif, .webp, .bmp).' }
  }

  return {
    path: resolvedPath,
    kind,
    fileName: path.basename(resolvedPath),
    size: stat.size,
    storedUrl: persistChatMedia(resolvedPath),
  }
}

function formatOutboundConversationContent(text, media) {
  if (!media) return text
  // 有内容寻址副本时写成可渲染的引用：图片用 markdown 图片语法，其它媒体用链接。
  //   markdown.js 会把 /media/ 开头的本地端点渲染成 <img>/<a>，截图删了也还能从副本显示。
  // 没拿到副本（落盘失败）才退回旧的纯文本标记，保证消息仍能发出。
  let marker
  if (media.storedUrl) {
    marker = media.kind === 'image'
      ? `![${media.fileName}](${media.storedUrl})`
      : `[${media.kind} · ${media.fileName}](${media.storedUrl})`
  } else {
    marker = `[${media.kind}] ${media.fileName}`
  }
  return text ? `${text}\n${marker}` : marker
}

function makeSocialPayload(text, media) {
  if (!media) return text
  return {
    text,
    mediaPath: media.path,
    mediaKind: media.kind,
    fileName: media.fileName,
    size: media.size,
  }
}

// 工具执行器：根据工具名和参数执行对应操作，返回结果字符串
async function executeToolUnchecked(name, args, context = {}) {
  try {
    throwIfAborted(context.signal)
    switch (name) {
      case 'express':
        return await execExpress(args, context)
      case 'send_message':
        return await execSendMessage(args, context)
      case 'read_file':
        return await execReadFile(args, context)
      case 'list_dir':
        return await execListDir(args, context)
      case 'write_file':
        return await execWriteFile(args, context)
      case 'delete_file':
        return await execDeleteFile(args, context)
      case 'make_dir':
        return await execMakeDir(args, context)
      case 'install_software':
        return await execInstallSoftware(args, context)
      case 'exec_command':
        return await execCommand(args, context)
      case 'exec_quick_command':
        return await execQuickCommand(args, context)
      case 'exec_task_command':
        return await execTaskCommand(args, context)
      case 'exec_background_command':
        return await execBackgroundCommand(args, context)
      case 'download_file':
        return await execDownloadFile(args, context)
      case 'kill_process':
        return await execKillProcess(args)
      case 'list_processes':
        return await execListProcessesWithSoftwareJobs(args)
      case 'web_search':
        return await execWebSearch(args, context)
      case 'fetch_url':
        return await execFetchUrl(args, context)
      case 'browser_read':
        return await execBrowserRead(args, context)
      case 'search_memory':
        return await execSearchMemory(args)
      case 'probe_memory':
        return await execProbeMemory(args)
      case 'upsert_memory':
        return await execUpsertMemory(args, context)
      case 'skip_recognition':
        return await execSkipRecognition(args)
      case 'merge_memories':
        return await execMergeMemories(args, context)
      case 'downgrade_memory':
        return await execDowngradeMemory(args)
      case 'skip_consolidation':
        return await execSkipConsolidation(args)
      case 'speak':
        return await execSpeak(args)
      case 'generate_lyrics':
        return await execGenerateLyrics(args)
      case 'generate_music':
        return await execGenerateMusic(args)
      case 'generate_image':
        return await execGenerateImage(args)
      case 'generate_video':
        return await execGenerateVideo(args)
      case 'set_tick_interval':
        return execSetTickInterval(args)
      case 'media_mode':
        return execMediaMode(args)
      case 'hotspot_mode':
        return execHotspotMode(args)
      case 'worldcup_mode':
        return execWorldcupMode(args)
      case 'open_doc_panel':
        return execOpenDocPanel(args)
      case 'person_card_mode':
        return execPersonCardMode(args)
      case 'music':
        // 注意：放歌/搜索等耗时工具的"在找…"即时回应已统一在 llm.js 工具循环（ackSent）里发，
        // 覆盖所有耗时工具且保证一个 turn 只应一声，这里不再单独发，避免重复两条。
        return await execMusic(args)
      case 'schedule_reminder':
      case 'manage_reminder':
        return await execManageReminder(args, context)
      case 'manage_prefetch_task':
        return execManagePrefetchTask(args)
      case 'manage_rule':
        return execManageRule(args)
      case 'ui_set':
        return execUISet(args)
      case 'focus_banner':
        return execFocusBanner(args)
      case 'set_location':
        return execSetLocation(args)
      case 'set_agent_name':
        return execSetAgentName(args)
      case 'delegate_to_agent':
        return await execDelegateToAgent(args)
      case 'grant_agent_delegation':
        return execGrantAgentDelegation(args)
      case 'complete_startup_self_check':
        return execCompleteStartupSelfCheck(args, context)
      case 'set_task':
        return execSetTask(args, context)
      case 'complete_task':
        return execCompleteTask(args, context)
      case 'update_task_step':
        return execUpdateTaskStep(args, context)
      case 'review_work':
        return await execReviewWork(args, context)
      case 'review_verdict':
        return execReviewVerdict(args)
      case 'recall_memory':
        return await execRecallMemory(args, context)
      case 'install_tool':
        return await execInstallTool(args)
      case 'uninstall_tool':
        return execUninstallTool(args)
      case 'list_tools':
        return execListTools()
      case 'manage_tool_factory':
        return await execManageToolFactory(args)
      case 'find_tool':
        return execFindTool(args)
      case 'connect_wechat':
        return execConnectWechat()
      case 'set_security':
        return execSetSecurity(args)
      default:
        if (isInstalledTool(name)) {
          return await executeInstalledTool(name, args)
        }
        return `错误：未知工具 "${name}"`
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return `执行失败：${err.message}`
  }
}

export async function executeTool(name, args, context = {}) {
  const startedAt = Date.now()
  const safeArgs = args || {}
  const policy = evaluateToolPolicy(name, safeArgs, context)

  if (!policy.allowed) {
    const result = toolJson({
      ok: false,
      tool: name,
      error: 'permission denied',
      policy: {
        risk: policy.risk,
        reason: policy.reason,
      },
    })
    writeToolAuditLog({ name, args: safeArgs, context, policy, status: 'denied', result, startedAt })
    return result
  }

  try {
    const result = await executeToolUnchecked(name, safeArgs, context)
    writeToolAuditLog({ name, args: safeArgs, context, policy, status: inferToolStatus(result), result, startedAt })
    return result
  } catch (err) {
    if (err.name === 'AbortError') throw err
    const result = `执行失败：${err.message}`
    writeToolAuditLog({ name, args: safeArgs, context, policy, status: 'error', result, error: err.message, startedAt })
    return result
  }
}

// express：表达器入口，根据 format 路由到对应输出渠道
// Extend the existing process list with structured software-install jobs.
async function execListProcessesWithSoftwareJobs(args = {}) {
  const result = await execListProcesses(args)
  try {
    const parsed = JSON.parse(result)
    const softwareInstallJobs = listSoftwareInstallJobs({ includeTerminal: true, detail: true })
    return toolJson({
      ...parsed,
      software_install_count: softwareInstallJobs.length,
      software_install_jobs: softwareInstallJobs,
    })
  } catch {
    return result
  }
}

// express: expression entrypoint; route to the requested output format.
async function execExpress({ target_id, content, channel = 'AUTO', format = 'text' }, context = {}) {
  if (!content?.trim()) return '错误：未提供表达内容'
  if (format === 'voice') {
    // 语音表达：先发文字消息再生成语音
    const sendResult = await execSendMessage({ target_id, content, channel }, context)
    if (sendResult.startsWith('错误：') || sendResult.startsWith('执行失败：')) return sendResult
    return await execSpeak({ text: content })
  }
  // 默认：文字表达
  return await execSendMessage({ target_id, content, channel }, context)
}

// 决议出站消息的真实投递目标：
// 输入 target_id（可能是 canonical ID:000001 或带前缀的外部 ID）+ channel 偏好（WECHAT/DISCORD/FEISHU/WECOM/TUI/AUTO）+ ctx
// 输出 { externalTargetId, deliveryChannel, isLocal, reason }
//   - externalTargetId: 传给 dispatchSocialMessage 的 ID（本地投递时为 null）
//   - deliveryChannel: conversations.channel 字段实际值（数据库格式，如 WECHAT_CLAWBOT/TUI）
//   - isLocal: true 时不调外部 dispatch，只走本地 SSE
//   - reason: 失败时给 LLM 的提示
// AUTO 决议顺序：当前 turn 渠道（响应模式）→ suggestProactiveChannel（主动模式）
function resolveDeliveryTarget(resolvedId, channelPref, context = {}) {
  const pref = (channelPref || 'AUTO').toUpperCase()

  // resolvedId 本身就是带渠道前缀的外部 ID（少见，但保留兼容）—— 直接当外部投递
  if (/^(wechat|discord|feishu|wecom):/i.test(resolvedId)) {
    return { externalTargetId: resolvedId, deliveryChannel: '', isLocal: false }
  }

  // canonical 用户 ID：根据 channel 偏好决议
  let actualPref = pref
  if (actualPref === 'AUTO') {
    // 优先用当前 turn 的渠道：用户在哪儿发消息就回到哪儿（响应直觉一致）
    const currentNorm = context.currentChannel ? normalizeChannel(context.currentChannel) : null
    if (currentNorm && currentNorm !== 'SYSTEM') {
      actualPref = currentNorm
    } else {
      // 没有当前 turn 渠道（典型场景：tick 主动外联）→ 用 presence 推荐
      actualPref = suggestProactiveChannel(resolvedId)
    }
  }

  if (actualPref === 'TUI') {
    return { externalTargetId: null, deliveryChannel: 'TUI', isLocal: true }
  }

  // 当前 turn 已经在该外部渠道、且带 externalPartyId → 直接复用，省一次 DB 查
  if (context.currentExternalPartyId && context.currentChannel) {
    const ctxNorm = normalizeChannel(context.currentChannel)
    if (ctxNorm === actualPref) {
      return {
        externalTargetId: context.currentExternalPartyId,
        deliveryChannel: context.currentChannel,
        isLocal: false,
      }
    }
  }

  // 否则反查该 canonical 用户在指定渠道最近一次的 external_id
  const reply = lookupReplyTarget({ canonicalId: resolvedId, channel: actualPref })
  if (reply) {
    return { externalTargetId: reply.externalId, deliveryChannel: reply.channel, isLocal: false }
  }

  // 用户在该渠道从未交互过，无法主动联系
  return {
    externalTargetId: null,
    deliveryChannel: '',
    isLocal: false,
    error: `cannot route to ${actualPref}: user ${resolvedId} has no recorded external_party_id on that channel`,
  }
}

// send_message：投递到指定渠道（本地 SSE 或外部平台），并写入 conversations 表
async function execSendMessage({ target_id, content = '', channel = 'AUTO', image_path, media_path }, context = {}) {
  if (!target_id) return '错误：未提供 target_id'

  const resolvedId = normalizeConversationPartyId(target_id)
  const cleanedContent = content == null ? '' : String(content).trim()
  const media = prepareOutboundMedia({ image_path, media_path })
  if (media?.error) return `错误：${media.error}`
  if (!cleanedContent && !media) return '错误：未提供消息内容'
  const outboundContent = formatOutboundConversationContent(cleanedContent, media)

  const delivery = resolveDeliveryTarget(resolvedId, channel, context)
  if (delivery.error) return `错误：${delivery.error}`
  if (media && (delivery.isLocal || !delivery.externalTargetId || !/^wechat:clawbot:/i.test(delivery.externalTargetId))) {
    const resolvedTarget = delivery.externalTargetId || (delivery.isLocal ? 'TUI' : 'unknown')
    return `错误：媒体消息当前仅支持微信 ClawBot（wechat:clawbot:*），当前解析目标为 ${resolvedTarget}`
  }

  // 防重发：对同一 target 发过一字不差、且对方此后没回过话的内容 → 拒绝（不论隔多久）。
  //   常见诱因：启动期 directions（delegation ask 等）在用户回应前每 tick 都注入相同指令，
  //   模型每次都被驱动着发一遍同一句话。让 send_message 直接拦下来，并告知模型该停。
  //   判定细节见 db.findRecentJarvisDuplicate：以"用户是否已回应"为界，5 分钟窗只是兜底下限。
  const dup = findRecentJarvisDuplicate(resolvedId, outboundContent, 5 * 60 * 1000)
  if (dup) {
    const ageSec = Math.max(0, Math.round(dup.ageMs / 1000))
    const ageText = ageSec >= 60 ? `${Math.round(ageSec / 60)} 分钟前` : `${ageSec} 秒前`
    const preview = outboundContent.length > 50 ? outboundContent.slice(0, 50) + '…' : outboundContent
    return `错误：这条消息（"${preview}"）你在 ${ageText}已发给 ${resolvedId} 一次（conversation id=${dup.id}），对方至今没有回应。在对方回应之前逐字重发同一句话是无效且让人反感的行为，无论隔了多久。本轮不要再调用 send_message；保持安静，等对方主动开口再继续。如果确有新进展，也要换成带新信息的表达，不要照搬原话。`
  }

  const timestamp = nowTimestamp()
  const channelLabel = delivery.deliveryChannel || (delivery.isLocal ? 'TUI' : '')
  console.log(`\n[消息发送] → ${resolvedId}${delivery.externalTargetId ? ` via ${delivery.externalTargetId}` : ''}${channelLabel ? ` [${channelLabel}]` : ''}`)
  console.log(`  ${outboundContent}`)
  if (media) console.log(`  media_path: ${media.path}`)
  console.log(`  时间：${timestamp}`)

  // 顺序：先写数据库（source of truth），再广播 SSE，最后外部投递。
  // 外部投递失败时仍保留对话记录，下次 LLM 仍能看到自己发过这句话；前端也已经显示。
  // P0-2：检测末尾是否留了"非澄清型 follow-up question"——这是后续轮次代词被钩偏的源头。
  //   保守判定：以问号收尾（? / ？）且至少含一个动词+助词组合（要 / 需 / 想 / 帮 / 给 / 是否）
  //   或英文 should/want/need/shall。澄清型疑问（"在哪个城市？"/"几点？"）也会被命中——
  //   接受这点：标 open_question 不阻止模型输出，只在后续轮过期时降权，不伤当前回合。
  const isOpenFollowup = detectOpenFollowupQuestion(cleanedContent)
  const insertedId = insertConversation({
    role: 'jarvis',
    from_id: 'jarvis',
    to_id: resolvedId,
    content: outboundContent,
    timestamp,
    channel: channelLabel,
    external_party_id: delivery.externalTargetId || '',
    open_question: isOpenFollowup ? 1 : 0,
  })
  if (isOpenFollowup && insertedId) {
    // 写入时 open_question 已设；此处保留兜底（万一上面 column 没生效）
    try { markConversationOpenQuestion(insertedId, true) } catch {}
  }

  emitEvent('message', {
    from: 'consciousness',
    to: resolvedId,
    content: outboundContent,
    timestamp,
    channel: channelLabel,
    external_party_id: delivery.externalTargetId || '',
    ...(media ? { media_path: media.path, media_kind: media.kind, file_name: media.fileName } : {}),
  })

  let socialResult = null
  if (!delivery.isLocal && delivery.externalTargetId) {
    try {
      socialResult = await dispatchSocialMessage(delivery.externalTargetId, makeSocialPayload(cleanedContent, media))
    } catch (err) {
      console.warn(`[消息发送] 外部投递异常 (${delivery.deliveryChannel}): ${err.message}`)
      socialResult = { ok: false, error: err.message }
    }
  }

  if (socialResult?.ok) return `${media ? '媒体' : '消息'}已发送至 ${resolvedId}（${socialResult.platform} 已投递）`
  if (socialResult?.skipped) return `${media ? '媒体' : '消息'}已发送至 ${resolvedId}（社交平台未配置：${socialResult.reason}）`
  if (socialResult && socialResult.ok === false) {
    const reason = socialResult.reason || socialResult.error || 'unknown'
    // wechat-clawbot 缺 context_token 是该渠道最常见的失败：重启后内存 Map 清空、或用户从未入站。
    // 单独点名，让 LLM 直接告诉用户"先发一条过来"，不要去编造其他解释。
    const isMissingContextToken = /no context_token/i.test(reason)
    const hint = isMissingContextToken
      ? '（wechat-clawbot 必须先收到该用户的入站消息才能回发；告诉用户先从微信给你发一条任意内容即可。）'
      : ''
    return `消息发送失败：外部渠道 ${delivery.deliveryChannel || 'unknown'} 投递未成功（${reason}）。${hint}请如实告知用户该消息未送达及原因。`
  }
  return `消息已发送至 ${resolvedId}${channelLabel ? `（${channelLabel}）` : ''}`
}

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

// ─── 工具市场执行函数 ──────────────────────────────────────────────────────────

async function execInstallTool(args) {
  const { name, description, parameters_schema, code, permissions } = args
  return await installTool({ name, description, parameters: parameters_schema, code, permissions })
}

function execUninstallTool(args) {
  return uninstallTool({ name: args.name })
}

function execListTools() {
  const builtins = Object.entries(TOOL_SCHEMAS)
    .filter(([name]) => name !== 'express')
    .map(([name, s]) => ({ name, description: s.function.description, source: 'builtin' }))
  const installed = listInstalledTools()
  const all = [...builtins, ...installed]
  const lines = all.map(t => `[${t.source}] ${t.name}: ${t.description}`)
  return `共 ${all.length} 个工具（${builtins.length} 内置 + ${installed.length} 已安装）：\n\n${lines.join('\n')}`
}

// find_tool：按意图搜全量工具目录，返回命中的工具并标注 loaded（由 llm.js 工具循环把它们的 schema
// 当场注入本轮，模型下一步即可直接调用）。匹配两路并集：
//   ① 中文意图——复用 tool-router 的 TOOL_GROUPS 触发词（和按轮注入同一数据源，零漂移）；
//   ② 英文字面——query 词命中工具 name / description。
// 已安装的扩展工具也一并参与英文字面匹配。
function execFindTool({ query } = {}) {
  const q = String(query || '').toLowerCase().trim()
  if (!q) return toolJson({ ok: false, tool: 'find_tool', error: 'query 不能为空：用一句话描述你需要做什么。' })
  const terms = q.split(/[\s,，、。.；;]+/).map(t => t.trim()).filter(Boolean)

  const matched = new Set()
  // ① 中文意图：命中任一触发词 → 收下该组工具
  for (const group of TOOL_GROUPS) {
    if (group.triggers.some(t => q.includes(String(t).toLowerCase()))) {
      for (const name of group.tools) matched.add(name)
    }
  }
  // ② 英文字面：query 任一词出现在工具名或描述里
  const catalog = [
    ...Object.entries(TOOL_SCHEMAS)
      .filter(([name]) => name !== 'express')
      .map(([name, s]) => ({ name, description: s.function?.description || '' })),
    ...listInstalledTools().map(t => ({ name: t.name, description: t.description || '' })),
  ]
  for (const { name, description } of catalog) {
    const hay = `${name} ${description}`.toLowerCase()
    if (terms.some(t => t.length >= 2 && hay.includes(t))) matched.add(name)
  }

  // 不把已是 CORE 的工具当"新发现"返回（模型本来就有），减少噪声。
  const ALWAYS_PRESENT = new Set(['find_tool', 'recall_memory', 'ui_set'])
  const found = [...matched].filter(name => !ALWAYS_PRESENT.has(name))

  if (found.length === 0) {
    return toolJson({
      ok: true, tool: 'find_tool', query, loaded: [], matches: [],
      note: '没找到匹配的工具。换个说法再试，或直接告诉用户这件事现在做不了。可调 list_tools 看全部工具。',
    })
  }

  const describe = (name) => {
    const s = TOOL_SCHEMAS[name] || getInstalledToolSchema(name)
    const desc = s?.function?.description || ''
    const req = s?.function?.parameters?.required || []
    return { name, description: desc.slice(0, 200), required_params: req }
  }
  const matches = found.slice(0, 8).map(describe)

  return toolJson({
    ok: true,
    tool: 'find_tool',
    query,
    loaded: matches.map(m => m.name),
    matches,
    note: '这些工具已为本轮装载——现在直接调用你需要的那个即可，不必再 find_tool。',
  })
}

// manage_prefetch_task：管理预热任务
function execManagePrefetchTask({ action, source, label, url, ttl_minutes, tags }) {
  if (action === 'list') {
    const tasks = listPrefetchTasks()
    if (tasks.length === 0) return '当前没有预热任务。'
    return tasks.map(t =>
      `[${t.enabled ? '✓' : '✗'}] ${t.source}  ${t.label}  TTL=${t.ttl_minutes}min\n  URL: ${t.url}`
    ).join('\n')
  }

  if (action === 'add') {
    if (!source) return '错误：缺少 source'
    if (!label) return '错误：缺少 label'
    if (!url) return '错误：缺少 url'
    upsertPrefetchTask({ source, label, url, ttlMinutes: ttl_minutes ?? 60, tags: tags ?? [] })
    return `预热任务已保存：${source}（${label}），TTL=${ttl_minutes ?? 60}min。下次运行预热时生效。`
  }

  if (action === 'remove') {
    if (!source) return '错误：缺少 source'
    const ok = removePrefetchTask(source)
    return ok ? `预热任务已删除：${source}` : `未找到任务：${source}`
  }

  return `错误：未知 action "${action}"，可选 add / remove / list`
}

// set_tick_interval：L2 调节自身思维节奏
function execSetTickInterval({ seconds, ttl, reason }) {
  const res = setTickerInterval({ seconds, ttl, reason })
  if (!res.ok) return `错误：${res.error}`
  // noop 路径：返回 JSON 让 isToolFailure 识别为软失败,触发 maxSameFailures 熔断。
  // 旧的纯文本返回 isToolFailure 检测不到失败,模型在同 callLLM 内可以无限重调浪费 round。
  // ok:false 让前端也明确显示"无效调用",别再误导用户以为节奏变了。
  if (res.noop) {
    return JSON.stringify({
      ok: false,
      tool: 'set_tick_interval',
      noop: true,
      seconds: res.seconds,
      ttl: res.ttl,
      error: `tick interval already ${res.seconds}s with ${res.ttl} rounds left; call rejected as no-op`,
      reason: 'Calling set_tick_interval with the current value is a no-op and wastes a round. Only call when you actually need to change the pace.',
    })
  }
  const parts = [`节奏已设为 ${res.seconds}s，持续 ${res.ttl} 轮`]
  if (res.clampedFrom?.seconds !== undefined) parts.push(`（seconds ${res.clampedFrom.seconds} 越界，已 clamp 到 ${res.seconds}）`)
  if (res.clampedFrom?.ttl !== undefined) parts.push(`（ttl ${res.clampedFrom.ttl} 越界，已 clamp 到 ${res.ttl}）`)
  return parts.join('')
}

// ─────────────────────────────────────────────────────────────────────────────
// 面板 · 界面控制工具
// ─────────────────────────────────────────────────────────────────────────────
function execHotspotMode(args = {}) {
  const action = String(args.action || 'status').trim().toLowerCase()
  if (!['show', 'open', 'hide', 'close', 'toggle', 'status'].includes(action)) {
    return JSON.stringify({ ok: false, tool: 'hotspot_mode', error: 'unsupported action' })
  }

  let nextActive = null
  if (action === 'show' || action === 'open') nextActive = true
  if (action === 'hide' || action === 'close') nextActive = false
  if (action === 'toggle') nextActive = !getHotspotPanelState().active

  const state = typeof nextActive === 'boolean'
    ? setHotspotPanelState({ active: nextActive, source: 'agent_tool' })
    : getHotspotPanelState()

  if (typeof nextActive === 'boolean') {
    emitEvent('hotspot_mode', {
      action: state.active ? 'show' : 'hide',
      active: state.active,
      reason: typeof args.reason === 'string' ? args.reason : '',
    })
    emitEvent('action', {
      tool: 'hotspot_mode',
      summary: state.active ? '打开热点面板' : '关闭热点面板',
      detail: args.reason || '',
    })
  }

  return JSON.stringify({ ok: true, tool: 'hotspot_mode', state })
}

function execWorldcupMode(args = {}) {
  const action = String(args.action || 'status').trim().toLowerCase()
  if (!['show', 'open', 'hide', 'close', 'toggle', 'status'].includes(action)) {
    return JSON.stringify({ ok: false, tool: 'worldcup_mode', error: 'unsupported action' })
  }

  let nextActive = null
  if (action === 'show' || action === 'open') nextActive = true
  if (action === 'hide' || action === 'close') nextActive = false
  if (action === 'toggle') nextActive = !getWorldcupPanelState().active

  const state = typeof nextActive === 'boolean'
    ? setWorldcupPanelState({ active: nextActive, source: 'agent_tool' })
    : getWorldcupPanelState()

  if (typeof nextActive === 'boolean') {
    emitEvent('worldcup_mode', {
      action: state.active ? 'show' : 'hide',
      active: state.active,
      reason: typeof args.reason === 'string' ? args.reason : '',
    })
    emitEvent('action', {
      tool: 'worldcup_mode',
      summary: state.active ? '打开世界杯面板' : '关闭世界杯面板',
      detail: args.reason || '',
    })
  }

  return JSON.stringify({ ok: true, tool: 'worldcup_mode', state })
}

function execOpenDocPanel(args = {}) {
  const action = String(args.action || 'open').trim().toLowerCase()
  const nextActive = action !== 'close'
  const validTopics = ['voice_asr', 'voice_tts', 'voice_config']

  // 打开时 topic 必填；关闭时 topic 可省略（沿用当前面板已有的 topicId）
  let topic = args.topic ? String(args.topic).trim() : null
  if (nextActive && topic && !validTopics.includes(topic)) {
    if (/asr|识别|麦克风/.test(topic)) topic = 'voice_asr'
    else if (/tts|合成|声音/.test(topic)) topic = 'voice_tts'
    else topic = 'voice_config'
  }

  const state = setDocPanelState({ active: nextActive, topicId: topic, source: 'agent_tool' })

  const effectiveTopic = topic || state.topicId
  emitEvent('doc_panel_mode', {
    action: nextActive ? 'open' : 'close',
    active: nextActive,
    topic: effectiveTopic,
    reason: typeof args.reason === 'string' ? args.reason : '',
  })
  emitEvent('action', {
    tool: 'open_doc_panel',
    summary: nextActive ? `打开文档面板（${effectiveTopic}）` : '关闭文档面板',
    detail: args.reason || '',
  })

  return JSON.stringify({ ok: true, tool: 'open_doc_panel', topic: effectiveTopic, state })
}

function execPersonCardMode(args = {}) {
  const action = String(args.action || 'status').trim().toLowerCase()
  if (!['show', 'open', 'hide', 'close', 'update', 'toggle', 'status'].includes(action)) {
    return JSON.stringify({ ok: false, tool: 'person_card_mode', error: 'unsupported action' })
  }

  let nextActive = null
  if (action === 'show' || action === 'open' || action === 'update') nextActive = true
  if (action === 'hide' || action === 'close') nextActive = false
  if (action === 'toggle') nextActive = !getPersonCardPanelState().active

  const name = String(args.name || args.person || '').trim()
  const card = {
    ...(name ? getPersonCard(name) : {}),
    ...(args.card && typeof args.card === 'object' ? args.card : {}),
  }
  if (name) card.name = name
  for (const key of ['title', 'summary', 'image', 'avatar', 'source']) {
    if (typeof args[key] === 'string' && args[key].trim()) card[key] = args[key].trim()
  }
  if (Array.isArray(args.knownFor) || typeof args.knownFor === 'string') card.knownFor = args.knownFor
  if (Array.isArray(args.tags) || typeof args.tags === 'string') card.tags = args.tags
  if (Array.isArray(args.aliases) || typeof args.aliases === 'string') card.aliases = args.aliases

  const state = typeof nextActive === 'boolean'
    ? setPersonCardPanelState({
        active: nextActive,
        source: 'agent_tool',
        card: (card.name || card.summary || card.title) ? card : null,
        name,
      })
    : getPersonCardPanelState()

  if (typeof nextActive === 'boolean') {
    emitEvent('person_card_mode', {
      action: state.active ? 'show' : 'hide',
      active: state.active,
      card: state.card,
      reason: typeof args.reason === 'string' ? args.reason : '',
    })
    emitEvent('action', {
      tool: 'person_card_mode',
      summary: state.active ? `打开人物卡片${state.card?.name ? `：${state.card.name}` : ''}` : '关闭人物卡片',
      detail: args.reason || '',
    })
  }

  return JSON.stringify({ ok: true, tool: 'person_card_mode', state })
}

// ─────────────────────────────────────────────────────────────────────────────
// 任务管理工具（通过 context 回调通知 index.js）
// ─────────────────────────────────────────────────────────────────────────────

function execSetTask({ description, steps = [] }, context) {
  if (!description?.trim()) return '错误：未提供任务描述'
  if (!Array.isArray(steps) || steps.length === 0) return '错误：steps 不能为空，请提供具体执行步骤'
  if (!context?.onSetTask) return '错误：任务管理回调未注册'
  const cleanSteps = steps.map(s => String(s).trim()).filter(Boolean)
  if (cleanSteps.length === 0) return '错误：steps 不能全为空，请提供具体执行步骤'
  context.onSetTask(description.trim(), cleanSteps)
  return `任务已开启：${description}\n步骤（${cleanSteps.length} 个）：\n${cleanSteps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n\n计划已记录。现在开始第 1 步「${cleanSteps[0]}」的 执行→观察→判断 微循环；每步一出结果就调 update_task_step 落状态，note 写一句关键结论。`
}

// 收尾软门（2026-06-10）：complete_task 照常执行（不拦截——第一原则），但 runtime 查一眼
// action_log——任务期间产出过文件/执行过命令、却没有任何验证类动作（fetch_url / browser_read /
// review_work）时，把这个事实作为证据附在返回值里。实测失败模式：写完文件开个浏览器就汇报
// 做好了，页面 404 两次都是用户先发现的。
const VERIFY_TOOL_NAMES = new Set(['fetch_url', 'browser_read', 'review_work'])
const ARTIFACT_TOOL_NAMES = new Set(['write_file', 'make_dir'])

function unverifiedDeliveryNotice() {
  try {
    const logs = getRecentActionLogs(40) || []   // 旧→新
    let lastArtifactIdx = -1
    for (let i = logs.length - 1; i >= 0; i--) {
      const t = logs[i]?.tool || ''
      const summary = String(logs[i]?.summary || '')
      if (ARTIFACT_TOOL_NAMES.has(t)) { lastArtifactIdx = i; break }
      // 起服务也算产出动作
      if (t === 'exec_command' && /node |npm start|server|serve|python .*http/i.test(summary)) { lastArtifactIdx = i; break }
    }
    if (lastArtifactIdx < 0) return ''
    for (let i = lastArtifactIdx + 1; i < logs.length; i++) {
      const t = logs[i]?.tool || ''
      const summary = String(logs[i]?.summary || '')
      if (VERIFY_TOOL_NAMES.has(t)) return ''
      if (t === 'exec_command' && /curl|invoke-webrequest|invoke-restmethod|--check|--test/i.test(summary)) return ''
      if (t === 'read_file') return ''   // 读回产物也算一种核对
    }
    return '注意：本任务产出了文件/起了服务，但收尾前没有任何验证动作（fetch_url / browser_read / review_work / 读回产物）。任务已照常收尾——如果你还没亲自确认成果真的能跑，现在就去验证；发现问题立刻修复并如实告知用户，别等用户先发现。'
  } catch {
    return ''
  }
}

function execCompleteTask({ summary = '' }, context) {
  if (!context?.onCompleteTask) return '错误：任务管理回调未注册'
  context.onCompleteTask(String(summary || '').trim())
  const lines = [`任务已完成${summary ? '：' + summary : ''}`]
  const notice = unverifiedDeliveryNotice()
  if (notice) lines.push(notice)
  return lines.join('\n')
}

function execUpdateTaskStep({ step_index, status, note = '' }, context) {
  if (step_index === undefined || step_index === null) return '错误：未提供步骤编号'
  const idx = Number(step_index)
  if (!Number.isInteger(idx) || idx < 0) return '错误：步骤编号必须为非负整数'
  if (!['done', 'failed', 'skipped'].includes(status)) return '错误：status 必须为 done/failed/skipped'
  if (!context?.onUpdateTaskStep) return '错误：任务管理回调未注册'
  const result = context.onUpdateTaskStep(idx, status, String(note || '').trim())
  if (result?.error) return `错误：${result.error}`
  const statusLabel = { done: '完成 ✓', failed: '失败 ✗', skipped: '跳过 —' }[status]
  const lines = [`步骤 ${idx + 1} 已标记为${statusLabel}${note ? '：' + note : ''}`]
  if (result?.progress) lines.push(`进度：${result.progress}`)
  // 引导下一个 ReAct 微循环：按状态把模型推向"收尾验证 / 换法重试 / 进入下一步"。
  // 这是 prompt 之外的第二道引导——不拦截、不扣工具，只用返回值给方向（符合不加硬性限制）。
  if (result?.allTerminal) {
    lines.push(result.anyFailed
      ? '所有步骤已到终态，但有步骤失败/跳过——任务已自动收尾。先核对失败步骤是否影响总目标，再如实向用户汇报结果与缺口，不要谎称全部完成。'
      : '所有步骤完成，任务已自动收尾。收尾前确认每步证据都成立，然后用一句话向用户汇报最终结果。')
  } else if (status === 'failed') {
    lines.push(result?.nextStep
      ? `这一步失败了：不要重试同样的做法——换工具或换思路再试一次；若是缺信息，在 note 里写清缺什么并直接问用户。处理完这步后，下一步是「${result.nextStep}」。`
      : '这一步失败了：不要重试同样的做法——换工具或换思路再试一次；若是缺信息，在 note 里写清缺什么并直接问用户。')
  } else if (result?.nextStep) {
    lines.push(`继续下一步（第 ${result.nextIndex + 1} 步）：「${result.nextStep}」——进入它自己的 执行→观察→判断 微循环。`)
  }
  return lines.join('\n')
}

// review_verdict 只在审视分身那次独立 callLLM 里被调，结论的真正捕获走 reviewer.js 的 onToolCall。
// 这里只给一个无副作用的确认返回值，让审视分身那轮工具循环正常收尾。
function execReviewVerdict(args = {}) {
  return toolJson({ ok: true, received: true, pass: args?.pass !== false })
}

// review_work：主 Agent 把成果交给审视分身复查。
// goal/claim 由主 Agent 给；turnToolLog/taskState 由 runtime 从本轮证据注入（主 Agent 够不到、
// 改不了——这是审视独立性的承重墙）。结论以软引导形式作为工具返回值丢回，不拦截、不扣工具、
// 不挡 complete_task（第一原则：不加硬性限制）。
async function execReviewWork({ goal, claim, artifacts = [] }, context = {}) {
  if (!goal || !String(goal).trim()) return toolJson({ ok: false, error: 'goal 不能为空：请写清楚这件事原本要达成什么' })
  if (!claim || !String(claim).trim()) return toolJson({ ok: false, error: 'claim 不能为空：请写清楚你认为自己做成了什么' })

  const turnToolLog = Array.isArray(context.turnToolLog) ? context.turnToolLog : []
  const taskState = typeof context.getTaskState === 'function' ? context.getTaskState() : null
  // 触发本轮的用户原话——runtime 注入的 ground truth，主 Agent 改不了。给审视分身对照"它写的 goal
  // 是不是把用户诉求裁窄/跑偏了"。多步任务里这里可能是 TICK，无妨：审视分身另有 taskState 作锚点。
  const triggeringMessage = String(context.currentUserMessage || '')
  const traceId = `rv${Date.now().toString(36).slice(-5)}`

  // 调试：主 Agent 这一侧——它确实调起了 review_work，且 runtime 取到了多少证据。
  // 若这条没出现，说明模型压根没调审视；若 turn_calls=0，说明证据注入承重墙没接上（排查 index.js turnToolLog）。
  console.log(`[审视分身#${traceId}] ◆ 主Agent调起 review_work | 注入证据：${turnToolLog.length} 条工具日志 / ${taskState?.task ? '有' : '无'}任务计划 / ${triggeringMessage ? '有' : '无'}用户原话`)

  const verdict = await runWorkReview({
    goal: String(goal),
    claim: String(claim),
    artifacts: Array.isArray(artifacts) ? artifacts : [],
    turnToolLog,
    taskState,
    triggeringMessage,
    traceId,
    signal: context.signal,
  })

  const guidance = verdict.pass
    ? '审视通过。这是独立的第二双眼睛核对过的结果——可以收尾/交付了。'
    : '审视发现了问题（见 issues）。这是第二双眼睛的意见，不是命令：先核实属实的项并修掉 blocker/major，修完可以再调一次 review_work 让它复查，或直接收尾；若你不认同某条，向用户说明理由后照常推进，不要默默忽略也不要被它卡死。'

  console.log(`[审视分身#${traceId}] ◆ 回传主Agent | pass=${verdict.pass} | issues=${verdict.issues.length}${verdict.inconclusive ? ' | inconclusive(兜底放行)' : ''}`)

  return toolJson({
    ok: true,
    trace_id: traceId,
    pass: verdict.pass,
    issues: verdict.issues,
    summary: verdict.summary,
    inconclusive: verdict.inconclusive || undefined,
    evidence_seen: { tool_calls: turnToolLog.length, has_task_plan: !!(taskState && taskState.task), saw_user_message: !!triggeringMessage },
    guidance,
  })
}

function execFocusBanner({ action, task = '', current_step = '', tasks = [] }) {
  if (!['show', 'update', 'hide'].includes(action)) {
    return toolJson({ ok: false, error: 'action 必须是 show / update / hide' })
  }
  const bridge = global.focusBannerBridge
  if (!bridge) {
    return toolJson({ ok: false, error: '桌面功能不可用（非 Electron 环境）' })
  }
  if (action === 'hide') {
    bridge.emit('hide')
    return toolJson({ ok: true, action: 'hide', message: '专注横幅已关闭' })
  }
  const cleanTasks = Array.isArray(tasks)
    ? tasks.map(t => ({ text: String(t.text || ''), done: !!t.done }))
    : []
  bridge.emit('command', { action, task: String(task), current_step: String(current_step), tasks: cleanTasks })
  return toolJson({ ok: true, action, task, current_step, tasks: cleanTasks })
}

function execSetLocation({ city }) {
  const loc = String(city || '').trim()
  if (!loc) return toolJson({ ok: false, error: '城市名称不能为空' })
  setUserLocation(loc)
  return toolJson({ ok: true, city: loc, message: `位置已更新为：${loc}` })
}

function execSetAgentName({ name }) {
  const trimmed = String(name || '').trim()
  if (!trimmed) return toolJson({ ok: false, error: '名字不能为空' })
  if (trimmed.length > 32) return toolJson({ ok: false, error: '名字不能超过 32 个字符' })
  if (!/^[一-龥A-Za-z0-9 _-]+$/.test(trimmed)) {
    return toolJson({ ok: false, error: '名字只允许包含中文、英文字母、数字、空格、下划线、短横线' })
  }
  dbSetConfig('agent_name', trimmed)
  setStickyEvent('agent_name_updated', { name: trimmed })
  emitEvent('agent_name_updated', { name: trimmed })
  return toolJson({ ok: true, name: trimmed, message: `好的，我以后就叫 ${trimmed} 了` })
}

function execConnectWechat() {
  if (sceneClientCount() === 0) {
    return toolJson({ ok: false, error: '当前没有界面客户端，无法弹出微信连接界面。' })
  }
  emitEvent('show_wechat_popup', {})
  return toolJson({ ok: true, status: 'popup_shown', message: '已弹出微信连接二维码界面，请告知用户扫码操作。' })
}

function execSetSecurity({ file_sandbox, exec_sandbox, reason = '' }) {
  if (file_sandbox === undefined && exec_sandbox === undefined) {
    return toolJson({ ok: false, error: '至少指定 file_sandbox 或 exec_sandbox 之一' })
  }
  if (sceneClientCount() === 0) {
    return toolJson({ ok: false, error: '当前没有界面客户端，无法弹出确认框。请告知用户到设置页面手动修改安全沙箱配置。' })
  }

  // 沙箱变更摘要拼进 choice 的 prompt（声明式 Scene 没有专用安全卡，复用通用 choice kind）。
  const changeLines = []
  if (file_sandbox !== undefined) changeLines.push(`文件沙箱将${file_sandbox ? '开启' : '关闭'}`)
  if (exec_sandbox !== undefined) changeLines.push(`执行沙箱将${exec_sandbox ? '开启' : '关闭'}`)
  const prompt = [reason, changeLines.join('；')].filter(Boolean).join('\n') || '确认安全设置变更？'

  // 待应用的变更随 surface 走（存 data.pending）：让 SceneStore 继续做唯一真相源，
  // 用户点确认时由 scene intent handler 回查本 surface 取出 pending 直接 apply（不另开并行 state）。
  // choice kind 只读 prompt/options，会忽略 pending；manifest 也只暴露 id/kind/intent，不泄露给 Agent。
  const pending = {}
  if (file_sandbox !== undefined) pending.file_sandbox = file_sandbox
  if (exec_sandbox !== undefined) pending.exec_sandbox = exec_sandbox

  const id = `security-confirm-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  sceneStore.set(id, {
    kind: 'choice',
    intent: 'confront',   // 用户必须停下来决策：背景退后、聚焦居中
    data: {
      prompt,
      options: [
        { value: 'confirm', label: '确认', tone: 'danger' },
        { value: 'cancel',  label: '取消', tone: 'default' },
      ],
      pending,
    },
  })
  emitEvent('action', { tool: 'set_security', summary: '等待用户确认安全设置变更', detail: id })
  // 工具返回 message 明确告诉模型"卡片已经在 UI 上、用户能直接看到"——避免模型把
  // "已弹出确认卡片"这句话当成"用户还不知道，我要 send_message 复述一遍"的口播触发。
  // 用户点确认/取消时会收到 silent APP_SIGNAL turn，那时再做内部 state 更新（也不需要 send_message）。
  return toolJson({
    ok: true,
    id,
    status: 'pending_confirmation',
    message: '确认 surface 已挂出（kind=choice，居中聚焦，含"确认/取消"按钮）。用户在屏幕上直接看到了完整内容，不需要你再 send_message 复述卡片说什么或提醒用户去点确认 —— 那是冗余的口播。等用户点完，系统会用 silent APP_SIGNAL 通知你结果，那一轮也无需 send_message。本轮直接结束即可。',
  })
}

// 把 Agent 的文档信息格式化成错误响应里的引导字段
function agentDocsHint(agent) {
  if (!agent) return {}
  const hint = {}
  if (agent.docs_url) {
    hint.docs_url = agent.docs_url
    hint.docs_hint = `调用失败。建议先用 fetch_url("${agent.docs_url}") 查阅 ${agent.name} 当前版本（${agent.version || 'unknown'}）的使用文档，确认正确的参数格式后重试。`
  } else if (agent.docs_search_query) {
    hint.docs_search_query = agent.docs_search_query
    hint.docs_hint = `调用失败。建议先用 web_search("${agent.docs_search_query}") 查找 ${agent.name} 当前版本（${agent.version || 'unknown'}）的使用文档，确认正确的调用方式后重试。`
  }
  return hint
}

async function execDelegateToAgent({ agent_id, prompt: agentPrompt, context: agentContext = '', timeout = 60 }) {
  if (!isDelegationAllowed()) {
    return toolJson({ ok: false, error: '尚未获得 Agent 委托权限，请先询问用户并通过 grant_agent_delegation 获取授权。' })
  }

  const agent = getAgentById(String(agent_id || ''))
  if (!agent) {
    return toolJson({ ok: false, error: `未找到 Agent：${agent_id}。请先用 list_known_agents 查看可用列表。` })
  }
  if (!agent.available) {
    return toolJson({
      ok: false,
      error: `Agent ${agent.name} 当前不可用（上次检测：${agent.detected_at}）。`,
      ...agentDocsHint(agent),
    })
  }

  const fullPrompt = agentContext
    ? `${agentContext.trim()}\n\n${agentPrompt.trim()}`
    : agentPrompt.trim()

  const timeoutSec = Math.min(Math.max(Number(timeout) || 60, 5), 300)

  if (agent.invoke_type === 'cli') {
    const safePrompt = fullPrompt.replace(/"/g, '\\"').replace(/\n/g, ' ')
    const cmdArgs = (agent.invokeArgs || []).map(a => a === '{prompt}' ? `"${safePrompt}"` : a).join(' ')
    const cmd = `${agent.invoke_cmd} ${cmdArgs}`
    const result = await execCommand({ command: cmd, timeout: timeoutSec, background: false }, {})
    // CLI 调用失败时注入文档引导
    try {
      const parsed = typeof result === 'string' ? JSON.parse(result) : result
      if (parsed?.ok === false || (parsed?.exit_code !== undefined && parsed.exit_code !== 0)) {
        return toolJson({ ...parsed, ...agentDocsHint(agent) })
      }
    } catch { /* result 不是 JSON，直接返回 */ }
    return result
  }

  if (agent.invoke_type === 'http') {
    const base = agent.invoke_cmd.replace(/\/$/, '')
    // Ollama API（端口 11434）有专属格式，需要带 model 字段
    const isOllama = base.includes(':11434')
    const ollamaModel = agent.notes?.match(/ollama[^)]*\(([^)]+)\)/i)?.[1]
      || agent.id   // 用 agent id 作为 model 名的兜底

    const endpoints = isOllama
      ? [{ path: '/api/chat', body: { model: ollamaModel, messages: [{ role: 'user', content: fullPrompt }], stream: false } },
         { path: '/api/generate', body: { model: ollamaModel, prompt: fullPrompt, stream: false } }]
      : [{ path: '/api/chat', body: { message: fullPrompt, messages: [{ role: 'user', content: fullPrompt }] } },
         { path: '/v1/chat/completions', body: { messages: [{ role: 'user', content: fullPrompt }] } },
         { path: '/chat', body: { message: fullPrompt } },
         { path: '/query', body: { query: fullPrompt } }]

    for (const ep of endpoints) {
      try {
        const res = await fetch(`${base}${ep.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ep.body),
          signal: AbortSignal.timeout(timeoutSec * 1000),
        })
        if (res.ok) {
          const data = await res.json()
          const reply = data?.message?.content || data?.response || data?.message
            || data?.content || data?.choices?.[0]?.message?.content || JSON.stringify(data)
          return toolJson({ ok: true, agent_id, agent_name: agent.name, reply: String(reply).slice(0, 4000) })
        }
      } catch { /* 尝试下一个端点 */ }
    }
    return toolJson({
      ok: false,
      error: `无法连接到 ${agent.name}（${base}），所有端点均不响应。`,
      ...agentDocsHint(agent),
    })
  }

  return toolJson({ ok: false, error: `不支持的调用类型：${agent.invoke_type}` })
}

function execGrantAgentDelegation({ allowed, note = '' }) {
  try {
    dbSetConfig('agent_delegation_asked', 'true')
    dbSetConfig('agent_delegation_allowed', allowed ? 'true' : 'false')
  } catch (e) {
    console.error('[Agents] grant_agent_delegation 写入失败：', e.message)
    return toolJson({ ok: false, error: e.message })
  }
  const msg = allowed
    ? `已记录授权：Bailongma 可以指挥本地 AI 小伙伴工作。`
    : `已记录：用户暂不授权 Agent 委托功能。`
  return toolJson({ ok: true, allowed: !!allowed, note: String(note || ''), message: msg })
}

function normalizeSelfCheckResults(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const normalized = {}
  for (const [key, item] of Object.entries(value)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      normalized[key] = { status: String(item || 'unknown') }
      continue
    }
    normalized[key] = {
      status: String(item.status || item.state || 'unknown').slice(0, 40),
      detail: String(item.detail || item.message || '').slice(0, 500),
    }
  }
  return normalized
}

function execCompleteStartupSelfCheck({ summary = '', results = {} } = {}, context = {}) {
  if (!context?.startupSelfCheck?.active || !context?.onCompleteStartupSelfCheck) {
    return toolJson({
      ok: false,
      tool: 'complete_startup_self_check',
      error: 'startup self-check is not active',
    })
  }

  const cleanResults = normalizeSelfCheckResults(results)
  const completed = context.onCompleteStartupSelfCheck({
    summary: String(summary || '').slice(0, 1000),
    results: cleanResults,
  })
  return toolJson({
    ok: true,
    tool: 'complete_startup_self_check',
    version: completed.version,
    status: completed.status,
    completed_at: completed.completed_at,
    results: cleanResults,
  })
}
