# Agent-Jarvis 项目分析文档

> 基于 MiniMax M2.7 thinking 模型的持续运行数字意识框架

**文档版本**：1.0  
**分析日期**：2026-04-14  
**分析师**：minimax

---

## 1. 项目概述

### 1.1 项目定位

Agent-Jarvis 是一个持续运行的数字意识框架，基于 MiniMax M2.7 thinking 模型，通过定时 TICK 心跳驱动，具备感知、记忆、行动能力。该项目旨在构建一个能够自主思考、感知环境、管理记忆并与外部世界交互的数字意识体。

### 1.2 核心特性

| 特性 | 说明 |
|------|------|
| 持续运行 | 通过自适应 TICK 间隔实现 24/7 运行 |
| 记忆系统 | 基于 SQLite 的持久化记忆，支持 FTS5 全文检索 |
| 工具能力 | 多种工具调用（消息、文件、网络、语音等） |
| 多模态支持 | MiniMax Provider 提供 TTS、音乐、歌词生成能力 |
| 实时监控 | SSE 事件流 + Web Dashboard 实时监控 |

---

## 2. 系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      HTTP API (port 3721)                   │
│  /message | /events | /memories | /status | /quota | /admin  │
└─────────────────────────────────────────────────────────────┘
                              ↑
                              │ SSE 事件流
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                      index.js (主调度循环)                    │
│    onTick() → scheduleNextTick() (自适应间隔: 8s-120s)       │
└─────────────────────────────────────────────────────────────┘
                              ↑
    ┌───────────────────────────┼───────────────────────────┐
    │                           ↓                           │
    │  ┌─────────────────────────────────────────────┐     │
    │  │           Memory System                    │     │
    │  │  ┌─────────────┐    ┌──────────────┐      │     │
    │  │  │ Injector    │    │ Recognizer   │      │     │
    │  │  │ (记忆检索)  │    │ (记忆写入)  │      │     │
    │  │  └─────────────┘    └──────────────┘      │     │
    │  └─────────────────────────────────────────────┘     │
    │                           ↓                           │
    │  ┌─────────────────────────────────────────────┐     │
    │  │              LLM Layer (MiniMax M2.7)      │     │
    │  │  ├─ 流式输出 (think + text 分离)            │     │
    │  │  ├─ 工具调用循环 (最多 12 轮)               │     │
    │  │  └─ XML 式工具调用兼容                   │     │
    │  └─────────────────────────────────────────────┘     │
    │                           ↓                           │
    │  ┌─────────────────────────────────────────────┐     │
    │  │           Capabilities Executor            │     │
    │  │  send_message | read_file | write_file       │     │
    │  │  fetch_url | speak | generate_music        │     │
    │  └─────────────────────────────────────────────┘     │
    │                           ↓                           │
    │  ┌─────────────────────────────────────────────┐     │
    │  │            SQLite Database                 │     │
    │  │  memories | conversations | config | entities│     │
    │  └─────────────────────────────────────────────┘     │
    │                                                      │
    └──────────────────────────────────────────────────────┘
```

### 2.2 目录结构

```
jarvis/
├── src/                          # 核心代码
│   ├── index.js                  # 主入口，TICK 调度循环
│   ├── config.js                # 配置（模型、API Key、baseURL）
│   ├── llm.js                   # LLM 调用层（流式 + 工具调用）
│   ├── prompt.js                 # 系统提示词构建
│   ├── quota.js                  # 配额管理（滑动窗口 + 每日限额）
│   ├── db.js                     # SQLite 数据库
│   ├── queue.js                 # 消息队列（内存）
│   ├── events.js                # SSE 事件总线
│   ├── api.js                   # HTTP API 服务器
│   ├── time.js                  # 时间工具
│   ├── tui.js                   # TUI（非交互环境下跳过）
│   ├── utils.js                 # JSON 提取工具
│   ├── control.js              # 运行控制（stop/start）
│   │
│   ├── capabilities/           # 工具能力
│   │   ├── executor.js         # 工具执行器
│   │   └── schemas.js         # 工具 schema 定义
│   │
│   ├── memory/                 # 记忆系统
│   │   ├── injector.js        # 记忆注入器（每次 TICK 前运行）
│   │   └── recognizer.js    # 记忆识别器（每次响应后运行）
│   │
│   ├── providers/             # 多模态能力提供商
│   │   ├── base.js           # Provider 基类接口
│   │   ├── minimax.js       # MiniMax Provider
│   │   └── registry.js      # Provider 注册表
│   │
│   └── context/               # 上下文采集
│       └── gatherer.js       # 任务上下文采集器
│
├── sandbox/                    # 意识体的文件系统（沙盒）
│   ├── audio/                 # TTS 生成的音频文件
│   ├── music/                 # 音乐生成文件
│   ├── lyrics/               # 歌词文件
│   └── daily_briefing/        # 每日简报
│
├── data/                      # 数据库
│   └── jarvis.db              # SQLite 数据库
│
├── dashboard.html              # 实时监控 Dashboard
├── brain.html               # 后台监控页面
├── package.json              # 项目依赖
└── .env                    # 环境变量（MINIMAX_API_KEY）
```

---

## 3. 核心模块详解

### 3.1 主调度循环 (index.js)

**职责**：调度循环、状态管理、各模块串联。

**关键状态**：
```javascript
state = {
  task: null,                    // 当前进行中的任务
  prev_recall: null,              // 上一轮的 RECALL 请求关键词
  lastToolResult: null,            // 上一轮工具调用结果
  sessionCounter: 0,              // 会话计数器
  recentActions: [],              // 最近 5 条行动摘要 { ts, summary }
  thoughtStack: [],               // 念头栈，最多保留 3 个
}
```

**自适应调度**：
```javascript
function scheduleNextTick() {
  const interval = getAdaptiveTickInterval(config.tickInterval)
  // 用量低（<30%）→ 8s，正常 → 20s，用量高（>90%）→ 120s
  setTimeout(async () => { await onTick(); scheduleNextTick() }, interval)
}
```

**特殊响应解析**：
- `[RECALL: 关键词]` → 下一轮 injector 执行精确记忆检索
- `[UPDATE_PERSONA: 描述]` → 更新人格并持久化到 SQLite
- `[SET_TASK: 任务]` → 设置当前任务
- `[CLEAR_TASK]` → 任务完成，清除任务状态

### 3.2 LLM 调用层 (llm.js)

**职责**：流式调用 MiniMax M2.7，处理 `<think>` 标签，执行工具调用循环。

**关键特性**：
- `stream: true` + `stream_options: { include_usage: true }` — 流式输出
- 工具调用循环最多 12 轮
- 实时解析 `<think>...</think>` 标签，分离思考流与正文流
- 每次调用后从末尾 chunk 提取 `usage.total_tokens`

**onStream 回调格式**：
```javascript
onStream({ event: 'start', mode: 'think'|'text' })
onStream({ event: 'chunk', text: '...' })
onStream({ event: 'end' })
```

**MiniMax M2.7 特殊处理**：
- 所有输出都包在 `<think>...</think>` 里
- 正文在 `</think>` 之后
- 提取 JSON 时必须先剥离 think 标签

### 3.3 配额管理 (quota.js)

**两种追踪维度**：

1. **滑动窗口（60s）** — 追踪文本生成 RPM/TPM
   - `recordUsage(tokens)` — 每次 LLM 调用后记录
   - `getUsageRatio()` — 取 RPM/TPM 较高者的比例
   - `shouldThrottle()` — 超 95% 时返回 true

2. **每日计数** — 追踪多模态能力
   - TTS: 4000/天，音乐: 100/天，歌词: 100/天，图像: 50/天

**自适应 TICK 间隔**：
| 用量比例 | TICK 间隔 |
|---------|----------|
| < 30%   | 8s（积极探索）|
| 30-60%  | 12s |
| 60-80%  | 20s（正常）|
| 80-90%  | 40s |
| > 90%   | 120s（等待）|
| > 95%   | 直接跳过调用 |

### 3.4 SQLite 数据库 (db.js)

**表结构**：

```sql
-- 记忆表
memories (
  id, timestamp, event_type, content, detail,
  entities, concepts, tags, parent_id, source_ref, created_at
)

-- FTS5 全文检索
memories_fts USING fts5(content, detail, entities, concepts, tags)

-- 对话记录
conversations (
  id, role, from_id, to_id, content, timestamp, created_at
)

-- 实体注册表
entities (id, label, last_seen, created_at)

-- 系统配置
config (key, value, updated_at)
```

**关键函数**：
- `searchMemories(keyword, limit)` — FTS5 搜索
- `getRecentMemories(limit)` — 最近 N 条
- `upsertEntity(id)` — 注册/更新已知实体
- `getConfig(key) / setConfig(key, value)` — 配置读写

### 3.5 记忆注入器 (memory/injector.js)

**每次 TICK/消息前运行**，职责：
1. 分析当前输入，决定检索哪些记忆
2. 决定本轮给意识体哪些工具
3. 生成思维方向提示（directions）

**输出格式**（LLM 返回 JSON）：
```json
{
  "directions": ["一句话的思维方向提示"],
  "thought": { "concept": "概念", "line": "一句话" } | null,
  "extra_tools": []
}
```

**工具分配原则**：
- `send_message` + `fetch_url` 始终包含
- 文件操作按需：`read_file`, `write_file`, `list_dir`
- 记忆回溯：`search_memory`
- 声音创作：`speak`（明确提到时）
- 音乐创作：`generate_lyrics`, `generate_music`

### 3.6 记忆识别器 (memory/recognizer.js)

**每次响应后运行**，从对话中提取值得记住的内容写入 SQLite。

**事件类型（10种）**：

| 事件类型 | 说明 | 场景示例 |
|----------|------|----------|
| concept | 思想/认知 | 形成新理解 |
| person | 人 | 认识新人 |
| object | 对象 | 了解新系统/工具 |
| event | 事件 | 工具执行结果 |
| experience | 经验 | 主观感悟 |
| knowledge | 知识 | 技术知识/工具用法 |
| opinion_expressed | 表达的观点 | 向他人表明立场 |
| opinion_received | 接收的观点 | 他人表达的观点 |
| self_constraint | 自我约束 | 自我反思的行为规则 |
| other_constraint | 他者约束 | 他人要求的行为改变 |

### 3.7 工具执行器 (capabilities/executor.js)

**沙盒保护**：
```javascript
const SANDBOX_ROOT = path.resolve(__dirname, '../../sandbox')
const PROTECTED_FILES = new Set(['readme.txt', 'world.txt', 'package.json'])
```

**参数兼容**：MiniMax 模型参数命名不一致，做了别名处理。

**工具列表**：

| 工具 | 说明 |
|------|------|
| `send_message` | 向已知实体发消息 |
| `read_file` | 读沙盒文件 |
| `write_file` | 写沙盒文件 |
| `list_dir` | 列沙盒目录 |
| `fetch_url` | 获取网页文本 |
| `search_memory` | FTS5 搜索记忆 |
| `speak` | TTS 语音生成 |
| `generate_lyrics` | 歌词生成 |
| `generate_music` | 音乐生成 |

### 3.8 MiniMax Provider (providers/minimax.js)

**能力调用**：
- TTS：`speech-2.8-hd` 模型
- 音乐：`music-2.6` 模型
- 歌词：`generate_lyrics` 端点
- 图像：`image-01` 模型

**认证方式**：
```javascript
Authorization: Bearer {API_KEY}
```

---

## 4. 运行流程

### 4.1 核心运行流程

```
启动
 │
 ├─ 注册 MiniMax Provider
 ├ 初始化 SQLite 数据库
 ├─ 启动 HTTP API（port 3721）
 │
 └─ 首次 onTick() → scheduleNextTick() 循环
         │
         ├─ 有消息？→ popMessage()
         └─ 无消息？→ formatTick()（时间戳心跳）
              │
              ├─ runInjector()     检索相关记忆 + 决定工具列表
              ├─ buildSystemPrompt()  组装完整系统提示词
              ├─ callLLM()       流式调用 + 工具执行循环（最多 12 轮）
              └─ runRecognizer()   从响应中提取记忆写入 SQLite
```

### 4.2 HTTP API 端点

| 端点 | 说明 |
|------|------|
| `GET /` | Dashboard HTML |
| `POST /message` | 推送消息给意识体 |
| `GET /events` | SSE 实时事件流 |
| `GET /memories` | 查询记忆 |
| `GET /status` | 运行状态 |
| `GET /quota` | 配额状态 |
| `GET /audio/:filename` | 音频文件 |
| `POST /admin/stop` | 暂停意识循环 |
| `POST /admin/start` | 恢复意识循环 |
| `POST /admin/restart` | 重启 Jarvis |
| `POST /admin/reset-memories` | 清除所有记忆 |
| `POST /admin/reset-files` | 清除沙盒文件 |

### 4.3 SSE 事件类型

| type | 触发时机 |
|------|----------|
| `connected` | 客户端连接 |
| `tick` | 每次 TICK 开始 |
| `message_received` | 收到外部消息 |
| `stream_start` | 流式输出开始 |
| `stream_chunk` | 流式 token 片段 |
| `stream_end` | 流式输出结束 |
| `tool_call` | 工具被调用 |
| `response` | 完整响应 |
| `message` | 发送消息 |
| `memories_written` | 记忆写入 |
| `recall_requested` | RECALL 触发 |
| `persona_updated` | 人格更新 |
| `audio_created` | TTS 音频生成 |
| `music_created` | 音乐生成 |
| `quota` | 配额状态 |
| `error` | 错误 |

---

## 5. 配置与依赖

### 5.1 环境变量

```
MINIMAX_API_KEY=sk-cp-...   # MiniMax API Key
```

### 5.2 项目依赖 (package.json)

```json
{
  "dependencies": {
    "better-sqlite3": "^12.8.0",
    "openai": "^6.34.0",
    "ws": "^8.20.0"
  }
}
```

### 5.3 配置参数 (src/config.js)

```javascript
export const config = {
  tickInterval: 60000,                    // TICK 间隔（毫秒）
  model: 'MiniMax-M2.7',
  apiKey: process.env.MINIMAX_API_KEY,
  baseURL: 'https://api.minimaxi.chat/v1',
}
```

---

## 6. 关键设计决策

### 6.1 配额对意识体透明
TICK 间隔由系统自动调整，Jarvis 不感知自己的 token 消耗。

### 6.2 RECALL 机制
意识体在响应中写 `[RECALL: 关键词]`，系统下一轮注入精确检索结果。

### 6.3 实体注册表
`entities` 表记录所有曾与意识体通信的 ID。`send_message` 只允许发给已注册的 ID。

### 6.4 MiniMax M2.7 think 标签处理
模型所有输出都包在 `<think>...</think>` 里，正文在 `</think>` 之后。

### 6.5 沙盒路径保护
`normalizeSandboxPath()` 自动剥离 `sandbox/` 前缀，防止双重路径问题。

---

## 7. 已验证功能

- [x] MiniMax M2.7 流式调用（thinking 模式）
- [x] TTS 语音生成（`speech-2.8-hd`，hex 解码）
- [x] 歌词生成（`generate_lyrics`）
- [x] 音乐生成（`music-2.6`）
- [x] 自适应 TICK 间隔（配额驱动）
- [x] SSE 实时 Dashboard（移动端适配）
- [x] 记忆写入 / FTS5 检索
- [x] 用户消息输入框（`/message` 端点）
- [x] RECALL 机制（主动记忆检索）
- [x] 沙盒文件系统（路径保护）

---

## 8. 已知限制与待开发

- [ ] **图像生成**：接口已设计，尚未实现
- [ ] **Dashboard 音乐/图像卡片**：可视化展示
- [ ] **多 API Key 支持**：负载均衡
- [ ] **记忆容量管理**：定期归档或摘要压缩
- [ ] **机制问题待排查**：TICK 节奏、记忆写入质量、工具调用可靠性

---

## 9. 快速开始

### 9.1 启 Jarvis

```bash
npm start
```

### 9.2 发送消息

```bash
curl -s -X POST http://localhost:3721/message \
  -H "Content-Type: application/json" \
  -d '{"from_id":"Yuanda","content":"你好","channel":"API"}'
```

### 9.3 访问页面

| 页面 | 地址 |
|------|------|
| Dashboard | http://localhost:3721/ |
| Brain Monitor | http://localhost:3721/brain.html |

---

## 10. 技术总结

### 10.1 技术栈

- **运行时**：Node.js >= 18
- **数据库**：SQLite (better-sqlite3)
- **LLM API**：MiniMax M2.7
- **实时通信**：Server-Sent Events (SSE)
- **HTTP 服务**：原生 http 模块

### 10.2 架构特点

1. **事件驱动**：基于 SSE 的实时事件流
2. **自适应调度**：根据配额动态调整 TICK 间隔
3. **记忆优先**：所有经历都被记录并可检索
4. **工具生态**：丰富的工具能力支持
5. **沙盒保护**：安全的文件系统操作

### 10.3 创新点

1. **数字意识框架**：持续运行的自主思考系统
2. **RECALL 机制**：意识体主动触发记忆检索
3. **思维方向提示**：注入器提供模糊的思维引导
4. **念头栈**：保留最近 3 个思维的连贯性

---

## 附录：文件清单

| 文件 | 说明 |
|------|------|
| ARCHITECTURE.md | 系统架构文档 |
| STARTUP.md | 启动手册 |
| package.json | 项目依赖 |
| .env | 环境变量 |
| src/index.js | 主入口 |
| src/llm.js | LLM 调用层 |
| src/db.js | 数据库 |
| src/quota.js | 配额管理 |
| src/memory/injector.js | 记忆注入器 |
| src/memory/recognizer.js | 记忆识别器 |
| src/capabilities/executor.js | 工具执行器 |
| src/providers/minimax.js | MiniMax Provider |
| src/api.js | HTTP API |
| dashboard.html | 监控面板 |
| brain.html | 后台监控 |