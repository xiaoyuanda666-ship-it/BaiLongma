import { getDesktopBlock } from '../desktop-scanner.js'
import { getGeoWeatherBlock } from '../geo-weather.js'
import { getInstalledSoftwareBlock } from '../installed-software-scanner.js'
import { isSoftwareInstallRequest } from '../software-install-intent.js'
import { getFeishuStatusBlock } from '../social/feishu-ws.js'
import { getSystemInfoBlock } from '../system-info.js'

// One compatibility implementation is shared by the legacy prompt builder and
// the new environment snapshot source. Keeping matching here prevents the two
// paths from drifting while source activation remains shadow-only.
export function buildSystemEnvironmentContext(message = '') {
  const text = String(typeof message === 'string' ? message : message?.content || '').toLowerCase()
  const blocks = []
  if (/系统信息|操作系统|电脑|主机名|内存|运行内存|hostname|时区|用户名|\bos\b|\bcpu\b|\bram\b|\bip\b|\bip地址\b|locale/.test(text)) {
    blocks.push(getSystemInfoBlock())
  }
  if (/桌面|快捷方式|桌面文件|桌面应用|已安装|浏览器|启动程序/.test(text)) {
    blocks.push(getDesktopBlock())
  }
  if (isSoftwareInstallRequest(text) || /软件|应用|程序|客户端|工具|装了什么|用了什么|代理|科学上网|翻墙|\bvpn\b|\bproxy\b|clash|mihomo|v2ray|xray|sing-?box|shadowrocket|shadowsocks|wireguard|tailscale|zerotier|openvpn/.test(text)) {
    blocks.push(getInstalledSoftwareBlock())
  }
  if (/位置|在哪个城市/.test(text)) blocks.push(getGeoWeatherBlock())
  if (/飞书|feishu|lark/.test(text)) blocks.push(getFeishuStatusBlock())
  return blocks.filter(Boolean).join('\n\n')
}
