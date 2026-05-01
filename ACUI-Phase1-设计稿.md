# ACUI Phase 1 · 协议设计稿

> Agent Control User Interface · 双柱架构（控制 + 感知）
> 作者：Yuanda + Claude Opus 4.7 · 2026-04-27

---

## 一、设计目标

让 Agent 既能**用 UI 表达**（推送可视化卡片），又能**通过 UI 感知**（看到用户在界面上做了什么）。Phase 1 只做协议层和最小可用样本，跑通端到端，验证模型。

**Phase 1 不做**：Agent 自写组件、复杂动画规范、视频/人物等多组件库、多窗口同步——分别留给 Phase 2/3/4。

---

## 二、双柱架构

```
                ┌─────────────────────────────────┐
                │            Agent (L1/L2)         │
                └──────────┬──────────────┬────────┘
                           │              │
                ┌──────────▼──┐        ┌──▼──────────┐
                │ ui.command  │        │  ui.signal  │
                │  (控制)      │        │   (感知)     │
                └──────────┬──┘        └──┬──────────┘
                           │              │
                           ▼              │
                  ┌────────────────┐      │
                  │   ws  /acui    │      │
                  └────┬───────────┘      │
                       │                  │
              ┌────────▼──────────────────▼──────┐
              │      浏览器/Electron 渲染层      │
              │   ┌──────────────────────────┐   │
              │   │   组件渲染容器           │   │
              │   │  + 信号采集器（语义化）  │   │
              │   └──────────────────────────┘   │
              └──────────────────────────────────┘
```

**核心理念**：控制和感知不可分。Agent 不是"先发号令再观察"，而是**持续观察 + 偶尔表达**，跟钢铁侠里 Jarvis 的设计模式一致——感知是全部，介入是克制。

---

## 三、通信通道：ws

**端点**：`ws://<host>:<port>/acui`，挂在现有 `api.js` 的 http server 上做 upgrade。

**为什么不沿用 SSE**：SSE 单向，UI → Agent 反向只能走 HTTP POST，对高频信号流不合适。`ws` 包已在 `package.json` 依赖里，直接启用。

**鉴权**：跟 dashboard 同源 token（实施前确认现有方案，记入风险清单）。

**心跳**：服务端每 30s 发 `{kind:"ping"}`，客户端回 `{kind:"pong"}`。客户端断连后指数退避重连（1s→2s→4s→8s 上限）。

**消息编码**：JSON 文本帧，全部消息有 `v: 1` 版本号字段。

---

## 四、协议消息格式

### 4.1 Agent → UI · 控制 (`ui.command`)

```json
{
  "v": 1,
  "kind": "ui.command",
  "op": "mount",
  "id": "weather-1714184400-a3f",
  "component": "WeatherCard",
  "props": {
    "city": "北京",
    "temp": 18,
    "condition": "晴",
    "forecast": [{ "day": "明天", "high": 22, "low": 12, "condition": "多云" }]
  },
  "hint": { "enter": "slide-from-right", "exit": "slide-to-right" }
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `op` | `mount` / `update` / `unmount` | mount 新建实例，update 改 props，unmount 触发出场动画后销毁 |
| `id` | 字符串 | 卡片实例 id，由 Agent 生成（建议 `<comp>-<ts>-<rand>`），后续 update/unmount 引用它 |
| `component` | 字符串 | 组件类型名，必须在前端注册表里 |
| `props` | 对象 | 必须符合该组件的 propsSchema，校验失败丢弃并写错误日志 |
| `hint.enter/exit` | 字符串 | 可选，覆盖组件默认动画；Phase 1 仅支持 `slide-from-right` / `slide-to-right` / `fade` |

### 4.2 UI → Agent · 感知 (`ui.signal`)

```json
{
  "v": 1,
  "kind": "ui.signal",
  "type": "card.dismissed",
  "target": "weather-1714184400-a3f",
  "payload": { "by": "close-button", "dwell_ms": 8200 },
  "ts": 1714184408200
}
```

### 4.3 Phase 1 信号类型最小集

| 类型 | 触发时机 | payload |
|---|---|---|
| `card.mounted` | 卡片渲染完成（动画结束） | `{}` |
| `card.dismissed` | 用户主动关闭 | `{ by: "close-button"\|"swipe"\|"esc", dwell_ms }` |
| `card.dwell` | 卡片停留满 N 秒（默认 5/15/30 三档） | `{ dwell_ms }` |
| `card.action` | 卡片内交互（点链接、播放视频等） | `{ action, ...detail }` |
| `user.viewport_change` | 窗口切走/切回 | `{ visible: bool }` |

**绝不发**：`mousemove` / `scroll` / 单字符 `keydown` / 每帧动画。降噪在前端做，原则是"只上报有语义的状态变化"。

---

## 五、前端：组件注册表 + 渲染层

### 5.1 目录结构（新增）

```
src/ui/brain-ui/acui/
├── client.js          # ws 客户端 + 重连
├── registry.js        # 组件注册表
├── renderer.js        # 渲染容器（管理 mount/update/unmount + 动画）
├── signals.js         # 信号采集器（语义聚合 + 节流）
├── animations.css     # slide-from-right / slide-to-right / fade
└── components/
    └── WeatherCard.js # Phase 1 唯一组件，端到端样本
```

### 5.2 技术选型：原生 Web Components

每个组件 = 一个继承 `HTMLElement` 的 class + `customElements.define()`。零依赖、零编译，
Shadow DOM 天然样式隔离。文件即组件：`acui/components/weather-card.js` 一个文件定义一个组件。

```js
export class WeatherCard extends HTMLElement {
  static componentName = 'WeatherCard'
  static tagName = 'acui-weather-card'
  static propsSchema = {
    city:      { type: 'string', required: true },
    temp:      { type: 'number', required: true },
    condition: { type: 'string', required: true },
    forecast:  { type: 'array',  required: false }
  }
  static enter = 'slide-from-right'
  static exit  = 'slide-to-right'
  static maxConcurrent = 1

  constructor() { super(); this.attachShadow({ mode: 'open' }) }

  set props(v) { this._props = v; this._render() }
  get props()  { return this._props }

  connectedCallback() {
    this.classList.add('acui-enter')
    requestAnimationFrame(() => this.classList.add('acui-enter-active'))
  }

  _render() {
    const { city, temp, condition, forecast = [] } = this._props
    this.shadowRoot.innerHTML = `
      <style>${WeatherCard._styles}</style>
      <div class="card">
        <button class="close" aria-label="关闭">×</button>
        <header>${escapeHtml(city)}</header>
        <div class="now">${temp}° · ${escapeHtml(condition)}</div>
        <ul>${forecast.map(f => `<li>${escapeHtml(f.day)} ${f.low}°–${f.high}°</li>`).join('')}</ul>
      </div>`
    this.shadowRoot.querySelector('.close').addEventListener('click',
      () => this.dispatchEvent(new CustomEvent('acui:dismiss',
        { bubbles: true, composed: true, detail: { by: 'close-button' } })))
  }

  static _styles = `:host{display:block;pointer-events:auto} .card{...}`
}
customElements.define(WeatherCard.tagName, WeatherCard)
```

注册表 (`registry.js`) 只是导入清单：

```js
import { WeatherCard } from './components/weather-card.js'
// 导入即注册（文件底部 customElements.define 已执行）
export const COMPONENTS = { WeatherCard }
```

**关键约束**：
- props 走 JS property 而不是 attribute（attribute 只能存字符串）
- 用户操作通过 `dispatchEvent('acui:dismiss' / 'acui:action')` 冒泡到 renderer，组件本身不知道 ws 存在 ——
  这样组件能脱离后端单独打开 `<name>.demo.html` 测试
- 标签名约定 `acui-<kebab-case>`，避免与 brain-ui 已有元素冲突

### 5.2.1 后端 props 校验镜像

工具调用要在后端校验 props，需要一份 schema 镜像：`src/capabilities/ui-components.json`。
通过脚本 `scripts/sync-acui-schema.mjs` 扫描 `acui/components/*.js` 的 `propsSchema` 静态字段
自动生成。提交 PR 时镜像必须与组件文件一起更新（CI 校验）。Phase 1 先手写一份。

### 5.3 渲染容器规则

- 卡片层是独立的 DOM 容器，覆盖在 brain-ui 之上但不阻塞它（`pointer-events: none`，仅卡片自身可交互）
- 同时显示卡片数 ≤ 3，超出按 LRU 淘汰最早的（淘汰也发 `card.dismissed`，by=`lru`）
- 任何 unmount 必须先跑出场动画（默认 240ms），动画结束才销毁 DOM
- `update` 操作触发组件内部 diff 重渲染，**不重放入场动画**

### 5.4 信号采集器（语义聚合）

- `card.dwell` 只在 5/15/30 秒三个时间点上报一次，不每秒报
- `viewport_change` 节流 1s：连续切换只上报最终状态
- 采集器内部维护每张卡片的 `mountedAt`，dismissed 时算出 `dwell_ms` 一起带上
- `user.idle`：Phase 1 不做（留给 Phase 2，需要全局键鼠监听）

---

## 六、后端：capabilities 工具族

### 6.1 新增工具 schema (`src/capabilities/schemas.js`)

```js
ui_show: {
  type: 'function',
  function: {
    name: 'ui_show',
    description: '在用户界面上推送一张可视化卡片。仅当 UI 表达比纯文字更简洁、更直观时使用。当前可用组件见技能记忆 skill.ui 类条目。',
    parameters: {
      type: 'object',
      properties: {
        component: { type: 'string', description: '组件类型名，必须在注册表内' },
        props: { type: 'object', description: '组件参数，需符合该组件的 propsSchema' },
        hint: { type: 'object', description: '可选，{ enter, exit }' }
      },
      required: ['component', 'props']
    }
  }
},

ui_update: {
  type: 'function',
  function: {
    name: 'ui_update',
    description: '更新已显示卡片的内容（不会重放入场动画）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        props: { type: 'object' }
      },
      required: ['id', 'props']
    }
  }
},

ui_hide: {
  type: 'function',
  function: {
    name: 'ui_hide',
    description: '关闭一张卡片（会跑出场动画）。一般情况下让用户自己关，仅在卡片信息已失效或被新卡片替代时主动调用。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  }
},

ui_show_inline: {
  type: 'function',
  function: {
    name: 'ui_show_inline',
    description: '当现有组件无法满足表达需求时，临场写一个组件并立刻显示。两种模式：inline-template（仅 HTML/CSS，安全简单）、inline-script（完整 Web Component class，有交互）。验证可用后可调 ui_register 转正。优先选 inline-template，inline-script 仅在需要交互或复杂状态时使用。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['inline-template', 'inline-script'] },
        template: { type: 'string', description: 'mode=inline-template 时必填，HTML 字符串，用 ${propName} 占位（仅字段名直插，自动 HTML 转义）' },
        styles: { type: 'string', description: 'mode=inline-template 时可选，CSS 字符串，作用域在 Shadow DOM 内' },
        code: { type: 'string', description: 'mode=inline-script 时必填，须以 export default class extends HTMLElement 开头' },
        props: { type: 'object' },
        hint: { type: 'object' }
      },
      required: ['mode', 'props']
    }
  }
},

ui_register: {
  type: 'function',
  function: {
    name: 'ui_register',
    description: '把一个已经验证可用的内联组件转为永久组件：写文件、更新注册表、写一条 skill.ui 技能记忆。一般在内联组件成功使用过 2 次以上、用户没有立刻关闭、有 dwell 信号时调用。',
    parameters: {
      type: 'object',
      properties: {
        component_name: { type: 'string', description: 'PascalCase，未占用' },
        code: { type: 'string', description: '完整 Web Component class 代码，包含 propsSchema/tagName/enter/exit 静态字段' },
        props_schema: { type: 'object', description: '与 code 内静态 propsSchema 一致的对象，用于后端校验镜像' },
        use_case: { type: 'string', description: '什么时候该用这个组件——会写入 skill.ui 记忆作为命中条件' },
        example_call: { type: 'string', description: '一个调用示例（ui_show 形式）' }
      },
      required: ['component_name', 'code', 'props_schema', 'use_case', 'example_call']
    }
  }
}
```

### 6.2 执行器实现 (`src/capabilities/executor.js`)

`executeUIShow / Update / Hide`：
1. 校验 `component` 在 `ui-components.json` 镜像内
2. 校验 `props` 符合 schema（缺必填、类型错都拒绝）
3. 生成实例 id（show 时，格式 `<comp>-<ts>-<rand6>`）
4. 通过 `emitUICommand(payload)` 发到所有 `/acui` ws 客户端
5. 写一条 `action_logs` 记录
6. 返回 `{ ok: true, id }` 或 `{ ok: false, error }` 给 LLM

`executeUIShowInline`：
1. mode=inline-template：仅做基础校验（template 非空、props 是对象），生成 id，通过 `emitUICommand` 发出
2. mode=inline-script：除上述外，**在后端做一次 quick syntax check**（用 `new Function(code)` 包一层 try/catch；不真正执行），失败直接拒绝
3. 写 action_logs 时把 code/template 完整存档（便于事后转正、复盘）

`executeUIRegister`：
1. 校验 `component_name`：PascalCase、未在注册表占用、未与系统保留名冲突
2. 把 `code` 写入 `src/ui/brain-ui/acui/components/<kebab-name>.js`
3. 在 `registry.js` 顶部追加 `import { <Name> } from './components/<kebab-name>.js'`，并把 `<Name>` 加入 `COMPONENTS` 导出
4. 把 `props_schema` 写入 `src/capabilities/ui-components.json`
5. 写一条记忆：`tags=skill.ui`，content 由 `use_case` + `example_call` 拼成
6. 通过 ws 推 `{ kind: "acui:reload" }`，前端清空注册表缓存并重新 import
7. 返回 `{ ok: true, component_name }` 给 LLM

### 6.3 events.js 扩展

```js
// 新增：专门发到 /acui ws 客户端，不进 SSE
const acuiClients = new Set()
export function addACUIClient(ws) { acuiClients.add(ws) }
export function removeACUIClient(ws) { acuiClients.delete(ws) }
export function emitUICommand(payload) {
  const msg = JSON.stringify({ v: 1, kind: 'ui.command', ...payload })
  for (const ws of acuiClients) {
    try { ws.send(msg) } catch { acuiClients.delete(ws) }
  }
}
```

---

## 七、动态组件 · 现写现用

ACUI 不只支持调用预注册组件，也支持 Agent **临场写一个组件就用**。三种执行模式：

| 模式 | 用法 | 适用场景 | 风险 |
|---|---|---|---|
| A · 注册组件 | `ui_show("WeatherCard", props)` | 高频、稳定的组件（天气、视频、人物） | 无 |
| B · 内联模板 | `ui_show_inline({ mode:"inline-template", template, styles, props })` | 一次性信息卡，跟现有组件都不像但又不值得做永久 | 低（无 JS） |
| C · 内联组件 | `ui_show_inline({ mode:"inline-script", code, props })` | 需要交互/内部状态/动画的临时组件 | 中（有 JS 执行） |

**优先级**：A > B > C。Agent 在 prompt 里被明确教育"能用 B 就别用 C，能用 A 就别用 B"。

### 7.1 模式 B：内联模板

```json
{
  "op": "mount",
  "mode": "inline-template",
  "id": "scratch-1714184400-x9k",
  "template": "<div class='card'><h3>${title}</h3><p>${body}</p></div>",
  "styles": ".card { padding:16px; background:#11161c; color:#c9d1d9; border-radius:8px; }",
  "props": { "title": "提醒", "body": "明天 10 点会议" }
}
```

前端处理：
1. 创建匿名 `HTMLElement` 子类，attachShadow
2. `${propName}` 占位符——**只识别字段名**，不是 JS 表达式（用正则 `/\$\{(\w+)\}/g` 匹配）
3. 替换时对所有值跑 `escapeHtml()`（防注入），`<style>` 块直接拼接（在 Shadow DOM 内不会逃逸）
4. tagName 用 `acui-inline-tpl-<hash(template)>` 复用 customElements 注册（同模板第二次显示秒级渲染）

### 7.2 模式 C：内联组件

```json
{
  "op": "mount",
  "mode": "inline-script",
  "id": "scratch-1714184400-y2p",
  "code": "export default class extends HTMLElement { constructor(){super();this.attachShadow({mode:'open'})} set props(v){this._p=v;this.shadowRoot.innerHTML=`...`} }",
  "props": { ... }
}
```

前端动态加载（约 20 行）：

```js
async function mountInlineScript({ id, code, props }) {
  const blob = new Blob([code], { type: 'text/javascript' })
  const url  = URL.createObjectURL(blob)
  try {
    const mod = await import(url)                    // 动态 ES module
    const Cls = mod.default
    if (!(Cls?.prototype instanceof HTMLElement)) throw new Error('not_html_element')
    const tag = `acui-inline-${id}`
    if (!customElements.get(tag)) customElements.define(tag, Cls)
    const el = document.createElement(tag)
    el.id = id; el.props = props
    host.appendChild(el)
    instances.set(id, { el, component: '__inline__', code, mountedAt: Date.now() })
  } catch (e) {
    emitSignal('card.error', id, { phase: 'load', message: String(e) })
  } finally {
    URL.revokeObjectURL(url)
  }
}
```

**约束**：
- 必须是 `export default class extends HTMLElement` 形式
- 加载/渲染时的任何异常被 renderer 捕获，发 `card.error` 信号回 Agent，让它知道写错了
- tagName 强制 `acui-inline-` 前缀，无法覆盖已注册组件
- 在 Electron 内运行，CSP 必须允许 `script-src 'self' blob:`

### 7.3 转正：从内联到注册

模式 B/C 的卡片如果用着不错（用户没立刻关、有 dwell 信号、被使用了 ≥2 次），Agent 应当主动调
`ui_register` 把它持久化。这样 Agent 的视觉表达能力随时间增长，每个会写的组件都成为以后的工具。

转正后下次同类需求直接走模式 A，**响应快、token 省、稳定可靠**——这就是 ACUI 设想里
"组件写入技能记忆免去 skill 查询"的落地形式。

### 7.4 安全边界

ACUI 跑在用户自己的 Electron 进程里，与 Agent 同信任级——理论上 Agent 在 Node.js 里能做的事更多，
所以前端内联代码不是新增风险面。但仍设几道护栏：

- 内联代码在 Shadow DOM 内，不能直接读写 brain-ui 主文档
- CSP 限制：`script-src 'self' blob:`，禁止外网脚本
- 内联代码不能调 `customElements.define`（前端用 Proxy 拦截 `window.customElements`，让内联看到的是 no-op）
- 写文件（`ui_register`）只能写到 `src/ui/brain-ui/acui/components/` 内，文件名严格 kebab-case 校验

---

## 八、感知流持久化

### 7.1 新增表 `ui_signals` (`src/db.js`)

```sql
CREATE TABLE IF NOT EXISTS ui_signals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT    NOT NULL,
  target      TEXT,
  payload     TEXT    NOT NULL DEFAULT '{}',
  ts          INTEGER NOT NULL,
  consumed    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ui_signals_unconsumed ON ui_signals(consumed, ts);
```

### 7.2 写入路径

ws 端点收到 `ui.signal` 帧 → 解析校验 → 写表 → emit SSE 事件 `ui_signal`（让 dashboard 也能可视化用户行为流，方便调试）。

### 7.3 注入器消费规则 (`src/memory/injector.js`)

每次 `process()` 进入注入流程时：
1. 拉 `consumed = 0` 且 `ts >= now - 60s` 的所有信号
2. 按时间序聚合成自然语言摘要：
   ```
   过去 60 秒内的界面行为：
   - 12 秒前：你打开了 WeatherCard（北京）
   - 4 秒前：用户关闭了它（点击关闭按钮，停留 8 秒）
   ```
3. 拼到 system prompt 的"环境感知"段落
4. 把这批信号 `consumed = 1`

**关键约束**：环境感知段落明确告诉模型 *"这只是上下文，不要主动开口"*——避免变成监工。

### 7.4 衰减

`ts < now - 5min` 的信号永远不再注入（即使没 consumed 也跳过）。陈旧行为对当前推理无用。

---

## 八、技能记忆（Phase 1 简化版）

### 8.1 存储

走现有 `memories` 表，新增 `tags` 字段值 `skill.ui`（如表无 tags 字段则在 content 头部加 `[skill.ui]` 标记，后续 ACI Phase 1 上向量检索时再规范化）。

### 8.2 模板格式

```
[技能·UI] 推送天气卡片
适用场景：用户提到天气、温度、出门、是否下雨、明天后天的天气。
组件：WeatherCard
调用：ui_show("WeatherCard", { city, temp, condition, forecast })
关闭：默认让用户自己关；如果用户问了别的城市，用 ui_update 改 props 而不是开新卡。
注意：city 必须先确定（问用户或从上下文推断），温度数值不要瞎填，要先调 fetch_url 查 wttr.in。
```

### 8.3 注入器命中规则

Phase 1 用关键词命中（"天气" / "温度" / "下雨" / "weather"）。命中即把整条记忆塞进 prompt。等 ACI Phase 1（向量检索）落地后切换到语义命中。

### 8.4 种子记忆

Phase 1 启动时 seed 两条 `skill.ui` 记忆：

1. **WeatherCard 用法**（具体组件指引，如 §8.2 模板）
2. **组件创作指南**（来源 `src/ui/brain-ui/acui/AGENT_GUIDE.md`）——内容即整份指南，命中关键词
   "做组件 / 写一个组件 / 画一个 / 自己写 / inline / 做卡片 / 没有这个组件"等。

第二条是 Phase 1 让 Agent **学会自己写组件**的关键——不是靠 system prompt 永久占位置，
而是按需注入：只有当 Agent 当下的任务确实需要新组件，这份指南才会出现在它上下文里。

后续 Agent 通过 `ui_register` 转正一个组件时，执行器会自动写入第三、四、五条……
组件库随时间增长，技能记忆同步增长。

`AGENT_GUIDE.md` 是**单一事实来源**：人类编辑这一份文件，启动时由 `ensureSkillMemories()`
做内容比对，如果文件 hash 变了就更新对应记忆条目。

---

## 九、系统提示词加成 (`src/prompt.js`)

在 `buildSystemPrompt` 里新增一段：

```
## ACUI · 视觉表达通道

你有一组可视化卡片可以推送到用户的界面上。把它当作语言表达的补充手段——
当 UI 比文字更简洁、更直观时才用，能用一句话说清的事情就别开卡片。

调用方法见技能记忆中标记为 skill.ui 的条目。可用工具：ui_show / ui_update / ui_hide。

## 环境感知

你会在 system prompt 里看到"过去 N 秒内的界面行为"——用户开了什么、关了什么、
停留了多久。这是给你的上下文，**不是触发器**：除非用户用语言或行为明确求助
（比如连续关了 3 张你推的卡），否则不要因为感知到操作就主动开口。
```

---

## 十、Phase 1 实施清单

按依赖顺序：

| # | 改动点 | 文件 |
|---|---|---|
| 1 | 新增 `ui_signals` 表 + 读写函数 | `src/db.js` |
| 2 | events.js 加 acuiClients + emitUICommand | `src/events.js` |
| 3 | api.js 加 `/acui` ws 端点（升级、鉴权、消息分发） | `src/api.js` |
| 4 | capabilities/schemas.js 加 5 个工具：`ui_show` / `ui_update` / `ui_hide` / `ui_show_inline` / `ui_register` | `src/capabilities/schemas.js` |
| 5 | capabilities/executor.js 实现 5 个工具（含模式 B/C 渲染指令构造、模式 C 语法预检、`ui_register` 写文件 + 改 registry + seed memory） | `src/capabilities/executor.js` |
| 6 | 后端组件 propsSchema 镜像（手写一份 WeatherCard，后续脚本同步） | `src/capabilities/ui-components.json` |
| 7 | 注入器加感知摘要逻辑 + 技能记忆命中（`skill.ui` tag） | `src/memory/injector.js` |
| 8 | prompt.js 加 ACUI 段落 | `src/prompt.js` |
| 9 | 前端 acui/ 目录骨架（client/registry/renderer/signals/animations） | `src/ui/brain-ui/acui/*` |
| 10 | WeatherCard 组件（Web Component） | `src/ui/brain-ui/acui/components/weather-card.js` |
| 11 | renderer 的内联模板 / 内联组件渲染路径（mode B/C） | `src/ui/brain-ui/acui/renderer.js` |
| 12 | 动画 CSS（slide-from-right / slide-to-right / fade） | `src/ui/brain-ui/acui/animations.css` |
| 13 | **Agent 写组件指南**（已就绪） | `src/ui/brain-ui/acui/AGENT_GUIDE.md` |
| 14 | 启动时 `ensureSkillMemories()` 同步 seed 记忆（hash 比对 AGENT_GUIDE.md + WeatherCard 用法） | `src/memory/seed-skills.js` |
| 15 | 端到端测试脚本（覆盖模式 A 和模式 B 各一次） | `src/test-acui.js` |

**验收标准**：
1. **模式 A 验收**：用户说"今天天气怎么样"→ Agent 调 `fetch_url` 拿天气 → 调 `ui_show("WeatherCard", ...)` → 卡片从右滑入 → 用户点 ✕ → `card.dismissed` 信号回流 → 60 秒内再说话时模型 prompt 里能看到"用户刚关闭了天气卡"。
2. **模式 B 验收**：用户说"做个卡片显示一下今天的待办：开会、打电话、写报告"→ Agent 因为没有 TodoCard 组件，调 `ui_show_inline({ mode:"inline-template", template:"...", styles:"...", props:{ items:[...] } })` → 卡片正确渲染 → 用户停留 5 秒 → `card.dwell` 信号回流。
3. **转正路径**（人工触发）：让 Agent 把上面的 inline TodoCard 调 `ui_register` 写成永久组件 → 文件落盘 → registry 自动重载 → 下次再问"今天待办"直接走模式 A。

---

## 十一、风险与未决问题

1. **ws 鉴权**：dashboard 当前是怎么鉴权的（cookie / session / 无）？实施前需要先确认，避免 ACUI 通道成为认证缺口。（注：用户表示鉴权放后面做，先用裸 ws + 本地 only 限制起步）
2. **窗口归属**：卡片是覆盖在 brain-ui 之上，还是开独立 BrowserWindow？建议沿用同一窗口（独立 DOM 层），减少 IPC 复杂度。
3. **卡片打架**：当 maxConcurrent 上限触发 LRU 淘汰时，被淘汰卡片的状态（比如视频播放进度）会丢——Phase 1 不处理，记入 Phase 2。
4. **关键词命中是临时方案**：Phase 1 用关键词只是过渡，向量检索做完后必须替换；否则技能记忆多了会误命中。
5. **感知摘要会膨胀 prompt**：超过 60 秒滚动窗口必须严格执行，且摘要需要压缩（每条不超过一行）。
6. **离线时的 ui_show**：ws 没客户端连着时，工具调用应该返回 `{ ok: false, error: 'no_client' }` 还是排队？建议返回失败让 Agent 改用文字——避免静默丢失。
7. **内联组件 CSP**：Electron 默认 CSP 是否允许 `blob:` 协议加载脚本？需要在 `electron/main.cjs` 显式放行 `script-src 'self' blob:`。如不允许，模式 C 必须降级为：把代码先写到 sandbox 文件再 import 文件 URL（更慢，但避开 CSP）。
8. **`ui_register` 改文件即热重载**：动态修改 `registry.js` 然后 import？ES module 会缓存。前端要用 cache-buster（`import('./registry.js?t=' + Date.now())`）才能真正重载。需在 renderer 实现细节里确认。

---

## 十二、与 ACI 的关系

ACI 让 Agent **想得更快**（提前注入信息），ACUI 让 Agent **说得更多**（用视觉表达）。两条主线在记忆系统层会合：

- ACI 的"语义记忆预判" → 命中**事实记忆**（用户是谁、之前说过什么）
- ACUI 的"技能记忆注入" → 命中**操作记忆**（怎么调 WeatherCard）

ACI Phase 1（向量检索）虽然没落地，但 Phase 1 不强依赖它——关键词命中够 3-5 个组件用。等 ACI Phase 1 完成，技能记忆的命中精度自然提升，无需重写 ACUI。

---

## 十三、一句话

> **让 Agent 像 Jarvis 一样：默默看着，必要时画给你看。**

*Yuanda + Claude Opus 4.7 · BaiLongma Project · 2026-04-27*
