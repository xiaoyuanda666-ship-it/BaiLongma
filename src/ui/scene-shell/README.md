# scene-shell — 电影级投影 UI shell

`UI = f(scene)` 的渲染端实现。它是 SceneStore(唯一真相源)的**纯投影**:
只读 scene、写 DOM、把用户 `intent` 上行。无业务逻辑、无 fetch、不执行任何远端代码。
协议见仓库根 `SCENE-PROTOCOL.md`,理念见《Agent-驱动UI-设计方案.md》。这是Jarvis唯一的声明式 Agent-UI 通道。

## 文件结构

```
src/ui/scene-shell/
├── client.js        WebSocket 传输:握手 / scene / scene.patch / 间隙检测 + resync / 指数退避重连 / sendIntent
├── shell.js         applyScene —— 纯投影器:按 id diff,调度 enter / exit / morph,intent 驱动落位
├── styles.css       全部呈现与动画(配色 / 缓动 / 三段动画 / intent 分区)—— 改皮只动这层
├── kinds/
│   ├── index.js     kind 注册表 + 未知 kind 降级
│   ├── dom.js       共享 DOM 小工具(el / setText 交叉淡化)
│   ├── text.js      text   { title?, body, footnote? }
│   ├── metric.js    metric { label, value, unit?, trend? }
│   ├── image.js     image  { url, title?, alt? }      上行 dismiss
│   ├── choice.js    choice { prompt, options[] }      上行 select { value }
│   ├── weather.js   weather{ city, temp, condition, forecast? }
│   └── layout.js    stack / row / col 排版原语(递归渲染子 surface)
├── index.html       live 测试页:连 ws://127.0.0.1:3721/scene
└── demo.html        离线演示:脚本化 scene 序列直喂 applyScene(无 server)
```

## 跑离线演示(无需 server)

用任意静态服务器伺服本目录(ES module 需经 http,不能 file://),浏览器打开 `demo.html`:

```powershell
# 在仓库根执行其一:
npx serve src/ui/scene-shell        # 然后访问 http://localhost:3000/demo.html
python -m http.server 8000 -d src/ui/scene-shell   # 访问 http://localhost:8000/demo.html
```

面板里用 ◀ ▶ 逐帧,或「自动播放」。序列覆盖:enter(②④)、morph(③⑤,含容器内子级 morph)、
exit(⑦⑧)、choice → intent(⑥,点选项后看浏览器 console 的 `[intent]` 日志)。

## 跑 live 测试(连运行中的 app)

1. 启动 BaiLongma(scene server 监听 `ws://127.0.0.1:3721/scene`)。
2. 同样用静态服务器伺服本目录,浏览器打开 `index.html`。
3. 右下角状态点变绿即握手成功;Agent 侧 `ui.set` 的变更会实时投影。choice 点击经 `sendIntent` 上行。

## 设计要点

- **同 id = 同元素**:跨帧按 `id` 配对,新增 enter、消失 exit、留存且 data 变则 `morph(el, prev, next)`
  原地过渡,转场是"一个元素在动"而非淡出+淡入。
- **intent 驱动戏剧强度**(shell 自定):`ambient` 角落、低饱和、收缩;`inform` 常规;
  `confront` 居中放大、压暗背景。core 永不下发像素 / 位置 / 尺寸 / 动画名。
- **patch 在 client 内合并**成完整 scene 再下发,上层始终面对全量快照,投影逻辑无需关心补丁粒度。
- **鲁棒性**:间隙检测(`base !== rev` → resync)、断线指数退避重连、未知 `v` / `type` / `kind` 一律忽略或降级,不崩溃。
