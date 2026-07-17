// 把 scene-shell 作为叠加层挂进宿主页(brain-ui),连接 /scene。
// 声明式 Agent-UI 投影层 —— 在 app 主窗口里挂载 scene-shell 叠加层。

import { SceneClient } from './client.js'
import { Shell } from './shell.js'
import { apiWebSocketProtocols, apiWebSocketUrl } from '../brain-ui/api-client.js'

export function bootstrapScene() {
  // 叠加层根容器(#stage,与 styles.css 对应)。已存在则复用。
  let stage = document.getElementById('stage')
  if (!stage) {
    stage = document.createElement('div')
    stage.id = 'stage'
    document.body.appendChild(stage)
  }

  // 注入 scene-shell 样式(经 app 的 /src/ui/scene-shell/ 静态路由伺服)。
  if (!document.getElementById('scene-shell-css')) {
    const link = document.createElement('link')
    link.id = 'scene-shell-css'
    link.rel = 'stylesheet'
    link.href = '/src/ui/scene-shell/styles.css'
    document.head.appendChild(link)
  }

  const wsUrl = apiWebSocketUrl('/scene')

  let client
  const shell = new Shell(stage, {
    // 用户交互上行给 core。shell 只显示与上报,绝不在此做业务决策。
    onIntent: (intent) => { if (client) client.sendIntent(intent) },
  })
  client = new SceneClient(wsUrl, {
    onScene: (scene) => shell.applyScene(scene),
  }, apiWebSocketProtocols())
  client.connect()

  return { shell, client }
}
