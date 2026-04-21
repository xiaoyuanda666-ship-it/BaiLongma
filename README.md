![图片](https://github.com/xiaoyuanda666-ship-it/BaiLongma/blob/main/images/AGI128k.jpg)
# Bailongma

一个持续运行的“数字意识”实验框架。

Bailongma 不是传统的一问一答式聊天程序，它会以 `TICK` 驱动的方式持续运行，在有外部消息时优先响应，在空闲时依据记忆、任务和上下文继续思考。项目内置了记忆系统、上下文注入、Web 面板、SSE 事件流，以及用于观察“意识流”的监控页面。

<video controls style="width:100%; height:auto;">
  <source src="https://github.com/xiaoyuanda666-ship-it/BaiLongma/blob/main/images/demo.mp4" type="video/mp4">
</video>

## Features

- 持续运行的主循环，而不是单次调用式对话
- 双层思考流程：`Layer1` 快速响应，`Layer2` 深度处理
- 自动记忆写入与按需记忆注入
- SQLite 持久化：记忆、对话、配置、实体都会落库
- 内置 HTTP API、Dashboard、Brain Monitor、Brain UI
- 支持 `MiniMax`、`DeepSeek`、`OpenAI` 三种 LLM Provider
- 在所有的测试中，MiniMax 表现最佳。
- 支持任务持续化，重启后可恢复进行中的任务

## Project Structure

```text
D:\claude\Bailongma\
├─ src/                 核心运行逻辑
│  ├─ memory/           记忆识别器、注入器
│  ├─ context/          任务上下文采集
│  ├─ providers/        LLM Provider 实现
│  └─ api.js            HTTP API
├─ scripts/             辅助脚本
├─ sandbox/             运行时文件沙盒
├─ data/                SQLite 数据目录
├─ brain-ui.html        脑图形界面
├─ package.json
└─ README.md
```

## Requirements

- Node.js 18+
- Windows PowerShell 或其他可运行 Node.js 的终端环境
- 至少配置一个可用的 LLM API Key

## Quick Start

### 1. 安装依赖

```bash
cd ./Bailongma/
npm install
```

### 2. 配置 `.env`

项目通过 `node --env-file=.env` 启动，所以请在项目根目录准备 `.env` 文件。

最小配置示例：

```env
LLM_PROVIDER=minimax
MINIMAX_API_KEY=your_minimax_key
```

也可以切换成其他 Provider：

```env
# 可选值：minimax / deepseek / openai
LLM_PROVIDER=openai
OPENAI_API_KEY=your_openai_key
```

```env
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=your_deepseek_key
```

当前源码中的默认选择是：

- `minimax` -> `MiniMax-M2.7`
- `deepseek` -> `deepseek-reasoner`
- `openai` -> `gpt-5.4`

### 3. 启动项目

```bash
cd ./Bailongma/
npm start
```

开发模式：

```bash
cd ./Bailongma/
npm run dev
```

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

### 为什么要用 `npm start`

不要直接运行：

```bash
node src/index.js
```

推荐始终使用：

```bash
npm start
```

因为 `package.json` 里已经通过 `--env-file=.env` 注入环境变量，直接执行 `node src/index.js` 时，通常会因为缺少 API Key 导致启动失败。

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

请确认：

- `.env` 在 `./Bailongma/` 下
- `LLM_PROVIDER` 与对应的 Key 匹配
- 你是通过 `npm start` 或 `npm run dev` 启动，而不是直接执行 `node ./Bailongma/src/index.js`

### 中文显示异常

如果在 Windows 终端里看到中文乱码，通常是终端编码或代码页问题，并不一定表示文件本身损坏。`README.md` 建议保持为 UTF-8 编码，GitHub 页面上会正常显示。

## License

本项目使用 [MIT License](./LICENSE)。
