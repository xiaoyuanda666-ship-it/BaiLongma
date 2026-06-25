// Shared intent detector for installing desktop software.
// Keep this separate so tool injection and per-turn directions do not drift.

export const SOFTWARE_INSTALL_TRIGGERS = [
  '安装软件', '安装应用', '安装程序', '安装客户端', '装软件', '装应用', '装程序', '装客户端',
  '下载安装包', '下载软件', '软件下载', '软件安装包', '安装包', '官方安装包',
  '安装微信', '装微信', '下载微信', '微信安装包',
  '安装qq', '装qq', '下载qq', 'qq安装包',
  '安装剪映', '装剪映', '下载剪映', '剪映安装包', 'capcut',
  '安装浏览器', '装浏览器', '下载浏览器',
  'install app', 'install software', 'install program', 'install client',
  'download installer', 'download setup', 'software installer', 'setup.exe', '.msi', '.exe',
]

const INSTALL_VERB_RE = /安装|装一下|装个|装一个|装上|下载并安装|帮我装|给我装|\binstall\b|\bsetup\b/i

const SOFTWARE_NOUN_RE = /软件|应用|程序|客户端|安装包|installer|setup\.exe|\.msi|\.exe|\bapp\b|\bapplication\b|\bprogram\b|\bclient\b/i

const COMMON_DESKTOP_APP_RE = /\b(?:qq|tim|wechat|weixin|chrome|edge|firefox|vscode|code|git|node(?:\.js)?|python|docker|steam|discord|slack|zoom|notion|obs|vlc|potplayer|wps|office|7-?zip|winrar)\b|微信|腾讯qq|qq音乐|剪映|飞书|钉钉|企业微信|浏览器|输入法/i

const WINGET_PACKAGE_ID_RE = /\b[a-z0-9][a-z0-9_.-]+\.[a-z0-9][a-z0-9_.-]+\b/i

export function isSoftwareInstallRequest(text = '') {
  const raw = String(text || '')
  const lower = raw.toLowerCase()

  if (SOFTWARE_INSTALL_TRIGGERS.some(trigger => lower.includes(trigger.toLowerCase()))) return true
  if (!INSTALL_VERB_RE.test(raw)) return false

  return SOFTWARE_NOUN_RE.test(raw)
    || COMMON_DESKTOP_APP_RE.test(raw)
    || WINGET_PACKAGE_ID_RE.test(raw)
}
