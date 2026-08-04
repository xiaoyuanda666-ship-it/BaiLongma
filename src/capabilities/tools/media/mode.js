import { emitEvent } from '../../../events.js'
import { getCountryCode } from '../../../geo-weather.js'

export function execMediaMode(args = {}) {
  const mode = String(args.mode || args.kind || '').trim()
  const action = String(args.action || 'show').trim()
  const modes = process.platform === 'darwin'
    ? ['video', 'camera', 'image']
    : ['video', 'camera', 'image', 'music']
  if (!modes.includes(mode)) {
    return JSON.stringify({
      ok: false,
      tool: 'media_mode',
      error: process.platform === 'darwin'
        ? 'mode must be video, camera, or image on macOS; use system_music for Music.app'
        : 'mode must be video, camera, image, or music',
    })
  }
  if (!['show', 'hide', 'close', 'play', 'pause', 'seek', 'set_volume', 'update'].includes(action)) {
    return JSON.stringify({ ok: false, tool: 'media_mode', error: 'unsupported action' })
  }

  // 视频平台预检：CN 网络下 YouTube 视频经常无法 iframe 嵌入播放（embeddable=false / 地区限制），
  // 这是"视频无法播放/此视频不能观看"的主因。CN 用户传 YouTube 链接时挡回，引导改用 B 站 BV 重播
  // （B 站稿件几乎都可嵌入、国内也快）。country 未知时按 CN 保守处理。摄像头模式不拦。
  if (mode === 'video' && action === 'show' && args.camera !== true) {
    const u = String(args.url || args.src || '')
    if (/youtube\.com|youtu\.be/i.test(u)) {
      const cc = getCountryCode()
      if (cc === 'CN' || cc === null) {
        emitEvent('action', { tool: 'media_mode', summary: 'YouTube 链接已挡回（CN→改用 B 站）', detail: u.slice(0, 60) })
        return JSON.stringify({
          ok: false, tool: 'media_mode', error: 'youtube_not_embeddable_cn',
          guide: '当前网络在中国大陆，YouTube 视频经常无法嵌入播放（用户会看到"此视频不能观看"）。不要用 YouTube 链接。请改用白龙马专用 Google Chrome 在 Bilibili 上搜同一主题的视频，拿到形如 https://www.bilibili.com/video/BVxxxxxxxxxx 的链接后，再用 media_mode(mode="video") 重新播放。优先选官方/高播放量的稿件，确认是可正常播放的完整视频而不是合集/直播回放。',
        })
      }
    }
  }

  const payload = {
    mode,
    action,
    url: typeof args.url === 'string' ? args.url : undefined,
    src: typeof args.src === 'string' ? args.src : undefined,
    title: typeof args.title === 'string' ? args.title : undefined,
    artist: typeof args.artist === 'string' ? args.artist : undefined,
    lrc: typeof args.lrc === 'string' ? args.lrc : undefined,
    cover: typeof args.cover === 'string' ? args.cover : undefined,
    alt: typeof args.alt === 'string' ? args.alt : undefined,
    autoplay: typeof args.autoplay === 'boolean' ? args.autoplay : (mode === 'music' ? true : undefined),
    muted: typeof args.muted === 'boolean' ? args.muted : undefined,
    camera: mode === 'camera' || args.camera === true,
  }

  if (Number.isFinite(Number(args.volume))) {
    payload.volume = Math.max(0, Math.min(1, Number(args.volume)))
  }
  if (Number.isFinite(Number(args.currentTime ?? args.time ?? args.seek))) {
    payload.currentTime = Math.max(0, Number(args.currentTime ?? args.time ?? args.seek))
  }

  emitEvent('media_mode', payload)
  emitEvent('action', { tool: 'media_mode', summary: `${mode}:${action}`, detail: payload.title || payload.url || '' })
  return JSON.stringify({ ok: true, tool: 'media_mode', ...payload })
}
