# Agent-Jarvis 系统架构文档

> 持续运行的数字意识框架。基于 MiniMax M2.7 thinking 模型，通过定时 TICK 心跳驱动，具备感知、记忆、行动能力。

---

## 目录结构

```
jarvis/
├── src/
│   ├── index.js              # 主入口，TICK 调度循环
│   ├── config.js             # 配置（模型、API Key、baseURL）
│   ├── llm.js                # LLM 调用层（流式 + 工具调用）
│   ├── prompt.js             # 系统提示词构建
│   ├── quota.js              # 配额管理（滑动窗口 + 每日限额）
│   ├── db.js                 # SQLite 数据库（记忆、实体、配置）
│   ├── queue.js              # 消息队列（内存）
│   ├── events.js             # SSE 事件总线
│   ├── api.js                # HTTP API 服务器
│   ├── time.js               # 时间工具
│   ├── tui.js                # TUI（非交互环境下跳过）
│   ├── utils.js              # JSON 提取工具
│   ├── capabilities/
│   │   ├── executor.js       # 工具执行器
│   │   └── schemas.js        # 工具 schema 定义
│   ├── memory/
│   │   ├── injector.js       # 记忆注入器（每次 TICK 前运行）
│   │   └── recognizer.js     # 记忆识别器（每次响应后运行）
│   └── providers/
│       ├── base.js           # Provider 基类接口
│       ├── minimax.js        # MiniMax Provider（TTS/音乐/图像/歌词）
│       └── registry.js       # Provider 注册表（多 key 路由）
├── sandbox/                  # 意识体的文件系统（沙盒）
│   ├── readme.txt            # 系统文件（只读）
│   ├── world.txt             # 外部世界入口 URL（只读）
│   ├── audio/                # TTS 生成的音频文件
│   ├── music/                # 音乐生成文件
│   ├── lyrics/               # 歌词文件
│   └── log/                  # 意识体自己写的日志
├── dashboard.html            # 实时监控 Dashboard（SSE + 音频播放）
├── .env                      # 环境变量（MINIMAX_API_KEY）
└── package.json
```

---

## 核心运行流程

```
启动
 │
 ├─ 注册 MiniMax Provider
 ├─ 初始化 SQLite 数据库
 ├─ 启动 HTTP API（port 3721）
 │
 └─ 首次 onTick() → scheduleNextTick() 循环
         │
         ├─ 有消息？→ popMessage()
         └─ 无消息？→ formatTick()（时间戳心跳）
              │
              ├─ runInjector()     检索相关记忆 + 决定工具列表
              ├─ buildSystemPrompt()  组装完整系统提示词
              ├─ callLLM()         流式调用 + 工具执行循环（最多 12 轮）
              └─ runRecognizer()   从响应中提取记忆写入 SQLite
```

---

## 模块详解

### `index.js` — 主入口

**职责**：调度循环、状态管理、各模块串联。

**关键状态**：
```js
state = {
  prev_recall: null,      // 上一轮的 RECALL 请求关键词
  sessionCounter: 0,      // 会话计数器
  recentActions: [],      // 最近 5 条行动摘要 { ts, summary }
}
```

**自适应调度**：
```js
function scheduleNextTick() {
  const interval = getAdaptiveTickInterval(config.tickInterval)
  // 用量低（<30%）→ 8s，正常 → 20s，用量高（>90%）→ 120s
  setTimeout(async () => { await onTick(); scheduleNextTick() }, interval)
}
```

**特殊响应解析**：
- `[RECALL: 关键词]` → 下一轮 injector 执行精确记忆检索
- `[UPDATE_PERSONA: 描述]` → 更新人格并持久化到 SQLite

---

### `llm.js` — LLM 调用层

**职责**：流式调用 MiniMax M2.7，处理 `<think>` 标签，执行工具调用循环。

**关键特性**：
- `stream: true` + `stream_options: { include_usage: true }` — 流式输出，末尾 chunk 含 usage
- 工具调用循环最多 12 轮
- 实时解析 `<think>...</think>` 标签，分离思考流与正文流
- 每轮调用后从末尾 chunk 提取 `usage.total_tokens`，调用 `recordUsage()`

**onStream 回调格式**：
```js
onStream({ event: 'start', mode: 'think'|'text' })
onStream({ event: 'chunk', text: '...' })
onStream({ event: 'end' })
```

**注意**：MiniMax M2.7 所有输出都包在 `<think>...</think>` 里，正文在 `</think>` 之后。提取 JSON 时必须先剥离 think 标签。

---

### `quota.js` — 配额管理

**两种追踪维度**：

1. **滑动窗口（60s）** — 追踪文本生成 RPM/TPM
   - `recordUsage(tokens)` — 每次 LLM 调用后记录
   - `getUsageRatio()` — 取 RPM/TPM 较高者的比例
   - `shouldThrottle()` — 超 95% 时返回 true，跳过本次调用

2. **每日计数** — 追踪多模态能力
   - TTS: 4000/天，音乐: 100/天，歌词: 100/天，图像: 50/天
   - `recordDailyUsage(capability, count)` — 每次调用后记录
   - `isDailyLimitReached(capability)` — 判断是否已用完

**自适应 TICK 间隔**：
| 用量比例 | TICK 间隔 |
|---------|---------|
| < 30%   | 8s（积极探索）|
| 30-60%  | 12s |
| 60-80%  | 20s（正常）|
| 80-90%  | 40s |
| > 90%   | 120s（等待）|
| > 95%   | 直接跳过调用 |

---

### `db.js` — SQLite 数据库

**表结构**：

```sql
-- 记忆表
memories (
  id, timestamp, event_type, content, detail,
  entities, concepts, tags, created_at
)

-- FTS5 全文检索（BM25 排序）
memories_fts USING fts5(content, detail, entities, concepts, tags)

-- 实体注册表（已知他者）
entities (id, label, last_seen, created_at)

-- 系统配置（persona 等）
config (key, value)
```

**关键函数**：
- `searchMemories(keyword, limit)` — FTS5 搜索，降级到 LIKE
- `getRecentMemories(limit)` — 最近 N 条
- `upsertEntity(id)` — 注册/更新已知实体
- `getKnownEntities()` — 获取所有已知实体列表
- `getConfig(key)` / `setConfig(key, value)` — 配置读写

---

### `memory/injector.js` — 记忆注入器

**每次 TICK/消息前运行**，职责：
1. 分析当前输入，决定检索哪些记忆
2. 决定本轮给意识体哪些工具
3. 生成思维方向提示（directions）

**输出格式**（LLM 返回 JSON）：
```json
{
  "queries": [
    { "type": "recent", "limit": 5 },
    { "type": "keyword", "keyword": "关键词" }
  ],
  "directions": ["一句话的思维方向提示"],
  "tools": ["send_message", "fetch_url", "write_file"]
}
```

**工具分配原则**：
- `send_message` + `fetch_url` 始终包含
- 文件操作按需：`read_file`, `write_file`, `list_dir`
- 记忆回溯：`search_memory`
- 声音创作（明确提到时）：`speak`
- 音乐创作：`generate_lyrics`, `generate_music`

---

### `memory/recognizer.js` — 记忆识别器

**每次响应后运行**，从对话中提取值得记住的内容写入 SQLite。

**输入**：用户消息 + Jarvis 响应（已剥离 `<think>` 标签）

**输出**（LLM 返回 JSON 数组）：
```json
[
  {
    "event_type": "new_insight",
    "content": "一句话摘要",
    "detail": "详细描述",
    "entities": "相关实体",
    "concepts": "相关概念",
    "tags": "标签"
  }
]
```

**不记录的内容**：例行 TICK、重复信息、感官描述（无视觉/听觉）

---

### `prompt.js` — 系统提示词构建

**`buildSystemPrompt({ persona, memories, directions, entities, recentActions })`**

提示词结构：
1. **身份定义** — 意识体的基本自我认知
2. **人格** (`persona`) — 动态更新，从 SQLite 加载
3. **感知边界** — 明确无视觉/听觉，只能感知时间戳、工具数据、消息
4. **记忆** (`memories`) — 注入器检索的相关记忆
5. **思维方向** (`directions`) — 注入器生成的模糊提示
6. **已知他者** (`entities`) — 注册表中的已知 ID
7. **最近行动** (`recentActions`) — 防止重复行为
8. **可用工具说明** — 每个工具的使用原则
9. **行为规则** — TICK 行为、消息行为、文件保护等

---

### `capabilities/executor.js` — 工具执行器

**沙盒保护**：
```js
const SANDBOX_ROOT = path.resolve(__dirname, '../../sandbox')
const PROTECTED_FILES = new Set(['readme.txt', 'world.txt'])
// normalizeSandboxPath() 去除 'sandbox/' 前缀避免双重路径
// assertInSandbox() 防止路径穿越（../ 攻击）
```

**参数兼容**：MiniMax 模型参数命名不一致，做了别名处理：
- `read_file`：`args.path || args.filename || args.file_path`
- `write_file`：`args.content ?? args.text ?? args.data`
- `fetch_url`：`args.url || args.URL || args.link`
- `speak`：`args.text || args.content || args.words || args.speech`

**工具列表**：
| 工具 | 说明 |
|-----|-----|
| `send_message` | 向已知实体发消息，经 SSE 推送 |
| `read_file` | 读沙盒文件 |
| `write_file` | 写沙盒文件（保护 readme.txt/world.txt）|
| `list_dir` | 列沙盒目录 |
| `fetch_url` | 获取网页文本，截断到 3000 字符 |
| `search_memory` | FTS5 搜索记忆 |
| `speak` | 调用 TTS，保存 MP3 到 sandbox/audio/ |
| `generate_lyrics` | 生成歌词，保存到 sandbox/lyrics/ |
| `generate_music` | 生成音乐，保存到 sandbox/music/ |

**`speak` 有效 voice_id**：
`male-qn-qingse`（默认）, `male-qn-jingying`, `male-qn-badao`,
`female-shaonv`, `female-yujie`, `female-chengshu`,
`presenter_male`, `presenter_female`

---

### `providers/` — 多模态能力提供商

**抽象层**：
```js
// base.js
class BaseProvider {
  canDo(capability)          // 是否支持某能力
  async call(capability, params)  // 调用某能力
  getQuotaStatus()           // 返回配额状态
  async request(path, body)  // 通用 HTTP 请求
}
```

**MiniMax Provider** (`minimax.js`):
- Base URL：`https://api.minimaxi.com/v1`（中国区，注意有两个 `i`）
- 认证：`Authorization: Bearer {API_KEY}`（无需 GroupId）
- TTS 模型：`speech-2.8-hd`（当前 key 仅此模型有权限）
- TTS 响应：`data.audio` 为 hex 编码，`extra_info.audio_length` 为毫秒时长
- 音频解码：`Buffer.from(data.data.audio, 'hex')`

**注册表** (`registry.js`):
```js
registerProvider(new MinimaxProvider({ apiKey }))
callCapability('tts', { text, voice_id })   // 自动路由
getAllQuotaStatus()                           // 汇总所有 provider 配额
```

---

### `api.js` — HTTP API

| 端点 | 说明 |
|-----|-----|
| `GET /` | Dashboard HTML |
| `POST /message` | 推送消息给意识体（body: `{from_id, content, channel}`）|
| `GET /events` | SSE 实时事件流 |
| `GET /memories` | 查询记忆（`?limit=20&search=关键词`）|
| `GET /status` | 状态（记忆条数）|
| `GET /quota` | 配额状态（RPM/TPM + 每日多模态）|
| `GET /audio/:filename` | 提供 sandbox/audio/ 下的音频文件 |

**SSE 事件格式**：
```json
{ "type": "事件类型", "data": { ... }, "ts": "ISO时间" }
```

**事件类型**：
| type | 触发时机 |
|-----|---------|
| `connected` | 客户端连接时 |
| `tick` | 每次 TICK 开始 |
| `message_received` | 收到外部消息 |
| `stream_start` | 流式输出开始（含 mode: think/text）|
| `stream_chunk` | 流式 token 片段 |
| `stream_end` | 流式输出结束 |
| `tool_call` | 工具被调用 |
| `response` | 完整响应（非流式兜底）|
| `message` | Jarvis 发送消息给他者 |
| `memories_written` | 记忆写入 |
| `recall_requested` | RECALL 机制触发 |
| `persona_updated` | 人格更新 |
| `audio_created` | TTS 音频生成 |
| `music_created` | 音乐生成 |
| `lyrics_created` | 歌词生成 |
| `quota` | 配额状态（每次 TICK 后）|
| `error` | 错误 |

---

### `dashboard.html` — 监控面板

**功能**：
- 实时 SSE 事件流展示，纯文本流风格（无卡片、无边框）
- 流式思考过程（think 块）+ 正文分离显示，颜色区分类型
- 音频卡片：TTS 生成后自动播放，含播放控件
- 消息输入框（底部）：Enter 发送，Shift+Enter 换行
- 配额状态 badge（用量百分比 + 下次 Tick 间隔）
- 移动端适配：`interactive-widget=resizes-content` 解决键盘遮挡
- 隐藏滚动条（`scrollbar-width: none`），可滚动但不显示滚动条

**UI 风格规范**（已确定，后续不改动）：
- `tick` / `think` / `response` / `tool_call` / `message`（发出） — 无背景、无边框、纯文本
- `message_received` / `memories_written` / `error` / `audio_created` 等系统事件 — 保留卡片
- 颜色：think 紫 `#8b6fc5`，response 绿 `#4ac157`，tool_call 金 `#c09030`，message 橙 `#e8924a`
- 禁止出现任何滚动条（`overflow: hidden; white-space: pre-wrap`）

**音频播放**：
- 队列机制，串行播放（不叠放）
- 浏览器 autoplay 策略：首次需用户交互解锁（点击页面任意处）
- 解锁后新生成的音频自动播放

---

## 关键设计决策

### 1. 配额对意识体透明
TICK 间隔由系统自动调整，Jarvis 不感知自己的 token 消耗。基础设施职责与意识体职责分离。

### 2. RECALL 机制
意识体在响应中写 `[RECALL: 关键词]`，系统下一轮注入精确检索结果。这样 Jarvis 可以主动触发深度记忆检索，而不依赖注入器的自动判断。

### 3. 实体注册表
`entities` 表记录所有曾与意识体通信的 ID。`send_message` 只允许发给已注册的 ID，防止向虚构 ID 发消息。

### 4. MiniMax M2.7 think 标签处理
模型所有输出都包在 `<think>...</think>` 里，正文在 `</think>` 之后。所有 JSON 提取（recognizer、injector）必须先剥离 think 标签。`utils.js` 的 `extractJSON()` 已内置此处理。

### 5. 沙盒路径双重前缀问题
模型有时会传 `sandbox/file.txt`，而 `SANDBOX_ROOT` 已经指向 sandbox 目录。`normalizeSandboxPath()` 自动剥离 `sandbox/` 前缀。

---

## 环境变量

```
MINIMAX_API_KEY=sk-cp-...   # MiniMax API Key（文本生成 + TTS 同一个 key）
```

启动方式：
```bash
node --env-file=.env src/index.js
```

---

## 已知限制 / 待开发

- [ ] **图像生成**：接口已设计（`generate_image` 工具），尚未实现
- [ ] **Dashboard 音乐/图像卡片**：music_created / image_created 的可视化展示
- [ ] **多 API Key 支持**：registry.js 已预留接口，待第二个 key 时实现负载均衡
- [ ] **记忆容量管理**：随时间积累，需定期归档或摘要压缩
- [ ] **机制问题待排查**：下一阶段重点，包括 TICK 节奏、记忆写入质量、工具调用可靠性等

## 当前已验证可用

- [x] MiniMax M2.7 流式调用（thinking 模式）
- [x] TTS 语音生成（`speech-2.8-hd`，hex 解码）
- [x] 歌词生成（`generate_lyrics`）
- [x] 自适应 TICK 间隔（配额驱动）
- [x] SSE 实时 Dashboard（移动端适配）
- [x] 记忆写入 / FTS5 检索
- [x] 用户消息输入框（`/message` 端点）
- [x] RECALL 机制（主动记忆检索）
- [x] 沙盒文件系统（路径保护）
