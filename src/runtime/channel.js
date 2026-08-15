export const CHANNEL_NORMALIZE = {
  WECHAT_CLAWBOT: 'WECHAT',
  WECHAT_OFFICIAL: 'WECHAT',
  WECHAT: 'WECHAT',
  WECOM: 'WECOM',
  DISCORD: 'DISCORD',
  FEISHU: 'FEISHU',
  TUI: 'TUI',
  API: 'TUI',
  RESOURCE: 'TUI',
  voice: 'TUI',
  VOICE: 'TUI',
  '语音识别': 'TUI',
  '语音对话': 'TUI',
  FocusBanner: 'TUI',
  REMINDER: 'SYSTEM',
  SYSTEM: 'SYSTEM',
  APP_SIGNAL: 'SYSTEM',
}

// LLM 可选的 channel 枚举（send_message 工具用）
export const PUBLIC_CHANNELS = ['WECHAT', 'DISCORD', 'FEISHU', 'WECOM', 'TUI', 'AUTO']

export const VOICE_CHANNELS = new Set(['voice', 'VOICE', '语音识别', '语音对话', 'FocusBanner'])

export function normalizeChannel(channel) {
  if (!channel) return 'TUI'
  if (CHANNEL_NORMALIZE[channel] != null) return CHANNEL_NORMALIZE[channel]
  return String(channel).toUpperCase()
}

export function isVoiceChannel(channel) {
  return VOICE_CHANNELS.has(String(channel || ''))
}

// 共享谓词：判断这条对话记录是不是"系统信号"（非用户/非 jarvis 的真实消息），
// 用于决定是否要把它渲染成 [system signal · ...] 块。
// fallbackChannel：当 row.channel 为空时回退使用的 channel（formatConversationMessage
//   在 row.channel 缺失时会回退到 currentMsg.channel，必须保住这个语义）。
export function isSystemSignalRow(row, fallbackChannel = '') {
  const ch = (row?.channel) || fallbackChannel || ''
  const norm = normalizeChannel(ch)
  return row?.from_id === 'SYSTEM' || norm === 'SYSTEM' || ch === 'APP_SIGNAL' || ch === 'REMINDER'
}
