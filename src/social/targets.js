export function parseSocialTarget(targetId = '') {
  const raw = String(targetId || '').trim()
  if (raw.startsWith('discord:')) {
    const [, channelId, userId = ''] = raw.split(':')
    return channelId ? { platform: 'discord', channelId, userId, raw } : null
  }
  if (raw.startsWith('feishu:')) {
    const [, receiveIdType, ...rest] = raw.split(':')
    const receiveId = rest.join(':')
    return receiveIdType && receiveId ? { platform: 'feishu', receiveIdType, receiveId, raw } : null
  }
  if (raw.startsWith('wechat:official:')) {
    return { platform: 'wechat-official', openId: raw.slice('wechat:official:'.length), raw }
  }
  if (raw.startsWith('wecom:webhook:')) {
    return { platform: 'wecom-webhook', key: raw.slice('wecom:webhook:'.length), raw }
  }
  return null
}

