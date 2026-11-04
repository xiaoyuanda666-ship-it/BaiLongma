const SOCIAL_LABELS = {
  WECHAT: 'WeChat', WECHAT_CLAWBOT: 'WeChat', WECHAT_OFFICIAL: 'WeChat',
  WECOM: 'WeCom', DISCORD: 'Discord', FEISHU: 'Feishu',
};

// The persisted format is authoritative; channel fallback supports legacy input
// records. Unrecorded historical assistant output must not be guessed as text.
export function messageModalityLabel({ role, channel = '', messageFormat = '', source = 'event' } = {}) {
  const ch = String(channel).toUpperCase();
  if (messageFormat === 'voice') return role === 'user' ? '语音对话' : '语音回复';
  if (messageFormat === 'text') return role === 'user' ? '文字消息' : '文字回复';
  if (messageFormat === 'social') return SOCIAL_LABELS[ch] || channel || '社交消息';
  if (['VOICE', '语音识别', '语音对话', 'FOCUSBANNER'].includes(ch)) return role === 'user' ? '语音对话' : '语音回复';
  if (SOCIAL_LABELS[ch]) return SOCIAL_LABELS[ch];
  if (role === 'jarvis' && source === 'history') return '';
  return role === 'user' ? '文字消息' : '文字回复';
}
