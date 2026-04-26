![图片](https://github.com/xiaoyuanda666-ship-it/BaiLongma/blob/main/images/AGI128k.jpg)
# Bailongma

一个持续运行的“数字意识”实验框架。

Bailongma 不是传统的一问一答式聊天程序，它会以 `TICK` 驱动的方式持续运行，在有外部消息时优先响应，在空闲时依据记忆、任务和上下文继续思考。项目内置了记忆系统、上下文注入、Web 面板、SSE 事件流，以及用于观察“意识流”的监控页面。

<img src="https://github.com/xiaoyuanda666-ship-it/BaiLongma/blob/main/images/demo.gif" style="width:100%; max-width:1080px;" />

## Features

- 持续运行的主循环，而不是单次调用式对话
- 双层思考流程：`Layer1` 快速响应，`Layer2` 深度处理
- 记忆识别器通过工具调用写入：先批量 `search_memory` 查重，再 `upsert_memory` 按 `mem_id` 去重（命中则 PATCH 更新，未命中则新建），无内容时显式 `skip_recognition`
- 长网页自动落盘：`fetch_url` / `browser_read` 抓到 ≥2000 字的正文时，自动写入 `sandbox/articles/{YYYY-MM}/`，记忆里只存标题 + 摘要 + `body_path`，主对话按需 `read_file` 打开正文
- 按需记忆注入：注入器对 `article` 类记忆会附带 `read_file("...")` 提示
- SQLite 持久化：记忆、对话、配置、实体都会落库
- 内置 HTTP API、Dashboard、Brain Monitor、Brain UI
- 支持 `MiniMax`、`DeepSeek`、`OpenAI` 三种 LLM Provider
- 在所有的测试中，MiniMax 表现最佳。
- 支持任务持续化，重启后可恢复进行中的任务

## Project Structure

```text
D:\claude\Bailongma\
├─ src/                 核心运行逻辑
│  ├─ memory/           记忆识别器（tool calling）、注入器
│  ├─ context/          任务上下文采集
│  ├─ providers/        LLM Provider 实现
│  └─ api.js            HTTP API
├─ scripts/             辅助脚本
├─ sandbox/             运行时文件沙盒
│  └─ articles/         抓取工具自动落盘的长文（按月份分目录）
├─ data/                SQLite 数据目录
├─ brain-ui.html        脑图形界面
├─ package.json
└─ README.md
```

## Requirements

- Node.js 18+
- Windows PowerShell 或其他可运行 Node.js 的终端环境
- 至少一个可用的 LLM API Key（MiniMax / DeepSeek / OpenAI 任选）

## 普通用户：下载安装包

从 [Releases](https://github.com/xiaoyuanda666-ship-it/BaiLongma/releases) 下载 `Bailongma Setup x.x.x.exe`，双击安装。安装完成后：

1. 从开始菜单或桌面图标启动 **Bailongma**
2. 首次打开自动进入激活页，粘贴一个 LLM API Key（默认推荐 MiniMax），点激活
3. 激活通过后自动进入主界面 `brain-ui`，开始思考

激活信息会保存在 `%APPDATA%\Bailongma\config.json`，记忆和沙盒也都存在同一目录下，升级或重装不会丢。

应用启动时会自动向 GitHub Releases 检查新版本，有更新会在后台下载，下次重启生效。

## 开发者：从源码运行

### 1. 安装依赖

```bash
cd ./BaiLongma/
npm install
```

### 2. （可选）配置 `.env`

源码模式下仍然支持通过 `.env` 注入 key（和旧流程完全一致）；如果不写 `.env`，启动后浏览器打开 `http://127.0.0.1:3721/activation` 填 key 也能激活。

最小配置示例：

```env
LLM_PROVIDER=minimax
MINIMAX_API_KEY=your_minimax_key
```

可选值：`minimax` / `deepseek` / `openai`。

当前源码中各 Provider 的默认模型：

- `minimax` -> `MiniMax-M2.7`
- `deepseek` -> `deepseek-reasoner`
- `openai` -> `gpt-5.4`

### 3. 启动

```bash
# Electron 桌面版（推荐，体验与安装包一致）
npm start

# 纯命令行后端（老流程）
npm run start:backend

# 开发模式（文件改动自动重启）
npm run dev
```

### 4. 打包 & 发布

```bash
# 仅打 Windows NSIS 安装包到 dist/
npm run build

# 打包并发布到 GitHub Releases（需要环境变量 GH_TOKEN）
npm run publish
```

> 打包前要确保 `electron-builder install-app-deps` 能顺利跑完（重建 `better-sqlite3` 给 Electron ABI）。如果被 "resource busy" 挡住，说明有正在运行的 Bailongma/Jarvis 占着 `.node` 文件，先把它停掉即可。

启动后会自动：

- 初始化数据库
- 恢复进行中的任务
- 启动 HTTP API
- 启动终端 TUI
- 开始调度 `TICK`

## Web Interfaces

启动后可访问：

| 页面 | 地址 | 用途 |
| --- | --- | --- |
| Brain UI | `http://127.0.0.1:3721/brain-ui` | 查看更完整的脑内状态与可视化信息 |

## API

### 发送消息
一般在Brain UI 中发送消息

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:3721/message' `
  -Method POST `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes('{"from_id":"Yuanda","content":"你好","channel":"API"}'))
```

也可以使用项目内置脚本：

```bash
python scripts/send.py "你好 Bailongma"
python scripts/send.py "继续刚才的任务" --from ID:Claude
```

### 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/message` | 发送消息给系统 |
| `GET` | `/events` | SSE 实时事件流 |
| `GET` | `/status` | 查看运行状态与记忆数 |
| `GET` | `/quota` | 查看配额占用情况 |
| `GET` | `/memories?limit=20` | 查询最近记忆 |
| `GET` | `/memories?limit=20&search=关键词` | 搜索记忆 |
| `GET` | `/conversations?limit=60` | 查询最近对话 |
| `PATCH` | `/memories/:id` | 修改记忆的 `content` / `detail` |
| `DELETE` | `/memories/:id` | 删除指定记忆 |
| `GET` | `/audio/:filename` | 访问生成的音频文件 |

### 管理接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/admin/stop` | 暂停意识循环 |
| `POST` | `/admin/start` | 恢复意识循环 |
| `POST` | `/admin/restart` | 重启进程 |
| `POST` | `/admin/reset-memories` | 清空记忆、对话、实体和大部分配置 |
| `POST` | `/admin/reset-files` | 清空 `sandbox/` 中的用户文件 |

## Runtime Notes

### 为什么要用 `npm start` / `npm run start:backend`

- `npm start` —— 启动 Electron 桌面版（会自己拉起后端 + 打开激活页/主界面）
- `npm run start:backend` —— 只启动 Node 后端（用 `--env-file=.env` 注入环境变量）

直接 `node src/index.js` 也能跑（无 key 会进入激活等待态，打开 `http://127.0.0.1:3721/activation` 填入 key 即可）。

### 调度逻辑

系统会根据状态动态调整下一次 `TICK`：

- 有待处理消息时立即执行
- 限流状态下延长间隔
- 任务活跃时缩短轮询周期
- 空闲时回到默认间隔

### 持久化内容

系统运行时会把以下内容存入 SQLite：

- 记忆
- 对话
- 实体
- 配置
- 当前任务

因此即使进程重启，Bailongma 也可以恢复部分上下文。

## Helper Scripts

`./Bailongma/scripts/` 目录中包含一些实用脚本：

| 脚本 | 作用 |
| --- | --- |
| `scripts/send.py` | 发送消息、查询状态、查看记忆 |
| `scripts/reset.js` | 清空数据库与沙盒，并重新植入种子记忆 |
| `scripts/seed-memories.js` | 写入系统初始记忆 |
| `scripts/migrate-identity-memories.js` | 迁移身份相关记忆 |
| `scripts/listen_for_claude.py` | 与外部工作流联动的监听脚本 |

## Reset

如果你想把系统重置到较干净的状态，可以运行：

```bash
cd ./Bailongma
node --env-file=.env ./Bailongma/scripts/reset.js
```

这个脚本会：

- 清空数据库中的记忆、对话和动作日志
- 重建 `./Bailongma/sandbox/`
- 恢复种子文件
- 重新写入种子记忆

## Troubleshooting

### 端口被占用

如果启动时报 `EADDRINUSE`，说明 `3721` 端口已被占用：

```powershell
netstat -ano | findstr :3721
taskkill /F /PID <PID>
```

### 启动时报缺少 API Key

新版不会因为缺少 key 直接崩溃了，而是进入激活等待状态。打开 `http://127.0.0.1:3721/activation`（或桌面版自动弹出的激活页）填入 key 即可。如果想走回老的环境变量方式：

- `.env` 在 `./BaiLongma/` 下
- `LLM_PROVIDER` 与对应的 Key 匹配
- 通过 `npm run start:backend` 启动（它会 `--env-file=.env`）

### 想清除激活、换 key 怎么办

删掉 `%APPDATA%\Bailongma\config.json`（Windows）/ `~/Library/Application Support/Bailongma/config.json`（Mac）/ `~/.config/Bailongma/config.json`（Linux）。源码模式下这个文件在项目根目录，同名删除即可。下次启动会重新进入激活页。

### 中文显示异常

如果在 Windows 终端里看到中文乱码，通常是终端编码或代码页问题，并不一定表示文件本身损坏。`README.md` 建议保持为 UTF-8 编码，GitHub 页面上会正常显示。

## License

本项目使用 [MIT License](./LICENSE)。
