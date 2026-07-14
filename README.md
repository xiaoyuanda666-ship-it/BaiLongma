![Jarvis](https://github.com/richardiitse/BaiLongma/blob/main/images/AGI128k.jpg)

# Jarvis

Jarvis 是一个持续运行的桌面 AI Agent 项目。它不是一次问答结束就退出的聊天程序，而是由主循环驱动：有用户消息时优先处理，空闲时按节奏继续整理记忆、检查任务、刷新上下文，并把状态实时推送到 Brain UI。

项目由 Electron 桌面壳、本地 HTTP 服务、LLM 调用层、记忆系统、工具执行器、语音系统、社交连接器和 Brain UI 组成。它的目标是让一个本地 Agent 既能聊天，也能记住、行动、观察自己的运行状态，并通过工具完成文件、网页、媒体、提醒、任务和系统级操作。

## 主要能力

- 持续运行的主循环：处理用户消息、后台消息、提醒、任务续跑和空闲心跳。
- 记忆系统：基于本地 SQLite 持久化对话、记忆、行动日志、提醒、预取缓存、媒体历史和线程状态，并支持全文检索、语义补充、去重与合并。
- 动态上下文注入：每轮对话前自动选择相关记忆、最近对话、用户画像、工具结果、UI 信号、预取内容和运行状态。
- 多模型接入：通过 OpenAI 兼容接口连接 DeepSeek、MiniMax、OpenAI、Qwen、Moonshot、Zhipu、MiMo 以及自定义服务。
- 工具系统：按需注入工具，支持通信、文件系统、Shell、网页读取、搜索、媒体生成、记忆管理、UI 卡片、任务、提醒、本地 Agent 委托和系统操作。
- Brain UI：提供聊天、思考流、记忆图、焦点线程、热点面板、文档面板、人物卡片、语音控制、设置页和 ACUI 卡片渲染。
- 语音能力：支持云端语音识别和多种 TTS 服务，可在 UI 中配置语音输入、语音输出和声音参数。
- 社交连接器：支持 Discord 与微信桥接，外部消息进入同一个主循环，回复按渠道路由返回。
- 本地资源感知：启动时收集系统信息、桌面信息、已安装软件、本地 Agent、SSH 与 Git 资源、地理天气和热点内容。
- 桌面集成：Electron 窗口、托盘、自动更新状态、日志落盘、单实例运行和焦点横幅。

## 项目结构

```text
electron/              Electron 主进程、预加载脚本和桌面窗口控制
src/index.js           Agent 主循环、调度、任务状态和启动流程
src/api.js             本地 HTTP 服务、SSE、WebSocket、设置和管理接口
src/llm.js             LLM 流式调用、工具调用执行和重试保护
src/config.js          Provider、模型、语音、社交、搜索和安全配置
src/db.js              SQLite 数据表、索引和持久化读写
src/memory/            记忆识别、注入、线程、焦点、召回和整理
src/context/           运行时上下文、规则、关键词和片段选择
src/capabilities/      工具 schema、执行器、沙箱和工具市场
src/social/            社交平台连接器和消息路由
src/voice/             云端 ASR、TTS 服务和语音相关逻辑
src/ui/brain-ui/       Brain UI 前端、ACUI 组件和可视化面板
scripts/               构建、探测、修复、冒烟测试和辅助脚本
sandbox/               Agent 工作区与生成内容存放区
data/                  本地运行数据，打包时不会带入安装包
```

## 运行方式

先安装依赖：

```bash
npm install
```

启动桌面应用：

```bash
npm start
```

只启动本地后端：

```bash
npm run start:backend
```

开发时自动重启后端：

```bash
npm run dev
```

需要局域网访问时，可以使用仓库里已有的启动脚本：

```bash
npm run start:lan
npm run start:backend:lan
```

## 配置

首次启动后会进入激活页，填写任意已支持 Provider 的 API Key 即可。也可以通过 `.env` 提供环境变量：

```env
LLM_PROVIDER=minimax
MINIMAX_API_KEY=your_key
```

常用配置可以在 Brain UI 的设置页中完成：

- 模型 Provider、模型、温度和 API Key。
- 语音识别、TTS Provider、音色和凭证。
- 社交平台连接参数。
- 嵌入、网页搜索和安全开关。
- Agent 名称、UI 行为和媒体相关偏好。

配置会持久化到本地数据目录。敏感设置接口默认只允许本机访问；需要远程访问时应结合环境变量开启局域网访问或设置 API Token。

## Web 入口

本地服务默认监听：

```text
http://127.0.0.1:3721
```

常用页面：

| 页面 | 地址 | 用途 |
| --- | --- | --- |
| Brain UI | `/brain-ui` | 主界面、聊天、状态、设置和可视化 |
| 激活页 | `/activation` | 首次配置 API Key |
| 运行状态 | `/status` | 查看循环、任务和记忆概览 |
| 配额状态 | `/quota` | 查看当前请求与限流状态 |
| Turn Trace | `/turn-trace` | 查看回合级运行轨迹 |

如果 Electron 启动时默认端口被占用，主进程会自动寻找可用端口并加载对应地址。

## 常用 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/message` | 发送一条用户消息到主循环 |
| `GET` | `/events` | 订阅 SSE 事件流 |
| `GET` | `/status` | 获取运行状态 |
| `GET` | `/quota` | 获取配额与限流信息 |
| `GET` | `/memories` | 查询记忆 |
| `PATCH` | `/memories/:id` | 更新记忆 |
| `DELETE` | `/memories/:id` | 删除记忆 |
| `GET` | `/conversations` | 查询最近对话 |
| `GET` | `/settings` | 获取设置摘要 |
| `POST` | `/activate` | 写入 Provider 配置并激活 |
| `POST` | `/settings/model` | 切换模型 |
| `POST` | `/settings/temperature` | 调整温度 |
| `GET` | `/settings/voice` | 获取语音识别设置 |
| `POST` | `/settings/voice` | 保存语音识别设置 |
| `GET` | `/settings/tts` | 获取 TTS 设置 |
| `POST` | `/settings/tts` | 保存 TTS 设置 |
| `POST` | `/tts/stream` | 流式生成语音 |
| `GET` | `/social/wechat-clawbot/qr` | 获取微信桥接二维码状态 |
| `POST` | `/social/wechat-clawbot/logout` | 退出微信桥接 |
| `POST` | `/admin/stop` | 暂停主循环 |
| `POST` | `/admin/start` | 恢复主循环 |
| `POST` | `/admin/restart` | 重启应用进程 |
| `POST` | `/admin/reset-memories` | 清空记忆和对话 |
| `POST` | `/admin/reset-files` | 清空沙箱文件 |

部分接口还用于 Brain UI 内部面板，例如热点、文档、人物卡片、媒体历史、AI 视频面板、ACUI 和云端语音识别。

## 数据与持久化

Jarvis 的长期状态主要保存在本地 SQLite 数据库中，包括：

- 对话记录、参与者身份和用户画像。
- 记忆节点、记忆关系、全文检索索引和可见性状态。
- 行动日志、工具结果摘要和回合轨迹。
- 提醒、预取任务、预取缓存和 UI 信号。
- 媒体历史、音乐库和 AI 视频记录。
- 焦点线程、承诺状态和旧焦点栈迁移结果。
- 微信桥接凭证与各类本地配置。

`sandbox/` 用作 Agent 的工作区，适合放置生成文件、临时项目、下载内容和媒体产物。`data/` 是运行数据目录，打包时会被排除。

## 工具系统

工具 schema 按能力拆分在 `src/capabilities/schemas/` 下，运行时由 `src/capabilities/schemas.js` 汇总。主循环会根据当前消息、任务状态、最近行动日志、UI 信号和可用 Provider 能力选择本轮要暴露给模型的工具，避免每轮都注入完整工具集。

内置工具覆盖这些方向：

- 给用户或外部渠道发送消息。
- 读取、列目录、写入和删除文件。
- 执行 Shell 命令和管理长运行进程。
- 搜索网页、抓取网页、读取浏览器内容。
- 搜索、召回、写入、合并和降权记忆。
- 管理提醒和预取任务。
- 展示、更新和关闭 ACUI 卡片。
- 生成语音、控制媒体面板、管理音乐和生成视频。
- 委托本地 Agent 执行子任务。
- 复核已完成工作。

工具市场允许安装自定义工具。安装后的工具会持久化在沙箱相关目录中，并在后续回合按需加入可用工具列表。

## Brain UI

Brain UI 是项目的主要操作界面，前端位于 `src/ui/brain-ui/`。它负责展示：

- 多渠道聊天和实时思考流。
- 记忆图、焦点线程和当前任务状态。
- 热点信息、文档知识、人物卡片和系统提示预览。
- 语音面板、TTS 效果、微信二维码弹窗和设置页。
- ACUI 卡片，如天气、自检、唤醒、图片、视频和安全确认。

前端通过 HTTP、SSE 和 WebSocket 与后端通信。Electron 预加载脚本会额外提供桌面端能力，例如窗口缩放、更新状态和外链打开。

## 测试与维护脚本

常用脚本：

```bash
npm run smoke:tools
npm run smoke:brain-ui
npm run smoke:social
npm run test:rule-context
npm run test:complex-task
npm run test:relevance
npm run test:section-gate
npm run test:agent-skills
npm run test:config-upgrade
```

记忆修复和配置探测：

```bash
npm run repair:memories:dry
npm run repair:memories
npm run probe:config-upgrade
```

打包 Windows 安装包：

```bash
npm run build
```

发布到 GitHub Releases：

```bash
npm run publish
```

## 安全与访问控制

- 默认只允许本机访问本地服务。
- 敏感路径包括激活、设置、管理和记忆修改接口。
- 可以通过环境变量显式允许局域网访问。
- 可以通过 API Token 让远程请求携带凭证访问。
- 文件与工具能力经过执行器统一路由，部分危险操作会进入确认或策略流程。
- Electron 桌面端启用上下文隔离，前端通过预加载桥接访问必要能力。

## License

[MIT License](./LICENSE)
