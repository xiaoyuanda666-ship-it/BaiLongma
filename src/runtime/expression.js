import { isVoiceChannel, normalizeChannel } from './channel.js'
import { normalizeConversationPartyId } from '../db/utils.js'

// One expression boundary. Model prose never enters this router implicitly.
const SOCIAL_CHANNELS = new Set(['WECHAT', 'DISCORD', 'FEISHU', 'WECOM'])
const failure = (error, reason) => JSON.stringify({ ok: false, delivered: false, message_sent: false, error, reason })

export async function executeExpression(args = {}, context = {}, { deliver, speak }) {
  const { format, content = '', channel = 'AUTO' } = args
  const target_id = normalizeConversationPartyId(args.target_id)
  if (context.silentSignal) return failure('silent_turn', 'This internal signal does not permit expression.')
  if (!target_id) return failure('missing_target_id', 'Expression requires a recipient.')
  if (format !== undefined && !['text', 'voice', 'social'].includes(format)) {
    return failure('invalid_expression_format', 'Choose text, voice, or social.')
  }
  const route = String(channel).toUpperCase()
  const incomingChannel = normalizeChannel(context.currentChannel)
  if (SOCIAL_CHANNELS.has(incomingChannel) && (format === 'voice' || format === 'text' || route === 'TUI')) {
    return failure('external_reply_requires_social', `This turn arrived via ${incomingChannel}. Local chat or computer speakers will not reach the sender. Retry send_message with format="social", channel="${incomingChannel}" and the same intended recipient/content. For remote audio use a supported media attachment, not local speaker output.`)
  }
  const externalPrefix = /^(wechat|discord|feishu|wecom):/i.exec(target_id)?.[1]?.toUpperCase()
  if (externalPrefix && (format === 'text' || format === 'voice' || (format === 'social' && externalPrefix !== route))) {
    return failure('conflicting_expression_recipient', 'Use a canonical local recipient for text/voice, or match the social recipient channel.')
  }
  if (format === 'social' && !SOCIAL_CHANNELS.has(route)) {
    return failure('missing_social_channel', 'Choose an explicit social channel: WECHAT, DISCORD, FEISHU, WECOM.')
  }
  if ((format === 'text' || format === 'voice') && !['AUTO', 'TUI'].includes(route)) {
    return failure('conflicting_expression_channel', 'Local text and speaker output cannot target a social channel.')
  }
  if (format === 'voice') {
    if (args.image_path || args.media_path) return failure('invalid_voice_media', 'Speaker output accepts text only.')
    if (typeof content !== 'string' || !content.trim()) return failure('missing_content', 'Provide text to speak.')
    if (context.currentTargetId && target_id !== normalizeConversationPartyId(context.currentTargetId)) {
      return failure('invalid_speaker_recipient', 'Computer speakers cannot address a different remote recipient.')
    }
    if (context.autonomous && !(context.allowedTargetIds || []).map(normalizeConversationPartyId).includes(target_id)) {
      return failure('unauthorized_recipient', 'Recipient is not in the visible autonomous context.')
    }
    return deliver({ ...args, target_id, content, channel: 'TUI' }, {
      ...context, expressionVoice: false, prepareSpeech: () => speak({ text: content }, context),
    })
  }
  return deliver({ ...args, target_id, channel: format === 'text' ? 'TUI' : channel }, { ...context, expressionVoice: false })
}

// Dedupe retries within one medium, while allowing intentional voice + text.
export function expressionTargetKey(args = {}) {
  return JSON.stringify([normalizeConversationPartyId(args.target_id), args.format || 'legacy', String(args.channel || 'AUTO').toUpperCase()])
}

// A preference for the model's explicit choice, never an automatic transport.
export function expressionGuidance(context = {}) {
  const channel = normalizeChannel(context.currentChannel)
  if (SOCIAL_CHANNELS.has(channel)) {
    return `The current message arrived via ${channel}. Reply using send_message with format="social", channel="${channel}" and the current sender as target_id. Local text/voice output and computer speakers do not reach this sender and are not a delivered reply. This turn's incoming channel takes precedence over voice preferences and earlier local conversations. Even when executing a local action such as playing music, send its result back through ${channel}.`
  }
  if (context.voiceReply === true || isVoiceChannel(context.currentChannel)) {
    return 'This is a local voice conversation. Prefer send_message with format="voice" for an ordinary short answer so the user hears it through the computer speakers. Choose the format explicitly. If the user asks for text, silence, or another channel, honor that instead. Use text for links/code/long details, optionally alongside a short spoken summary. If TTS fails, report the failure briefly in text. Never silently substitute a text-only answer for an ordinary spoken exchange.'
  }
  return 'Choose expression according to the user request and current channel: text for local chat, social for an external channel, voice when audible speech is appropriate or requested.'
}
