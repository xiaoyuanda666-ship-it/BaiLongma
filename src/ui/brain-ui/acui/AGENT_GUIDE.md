# ACUI 组件创作指南 · 给 Agent 读的

> 这份文档是写给你（Agent）的——告诉你**什么时候用 UI 卡片、什么时候自己写一个、怎么写、写完怎么转正**。
> 启动时这份内容会作为一条 `skill.ui` 记忆 seed 进你的记忆库，命中"做组件 / 画一个 / 显示一下"等关键词时被注入。

---

## 〇、形态：卡片应该长什么样、出现在哪、能不能拖

每次 ui_show / ui_show_inline 都可以传 `hint` 控制形态。**形态不是组件写死的——同一个组件，不同场景可以以不同形态出现。**

### placement（出现在哪）
- **notification**（默认）：**右上角滑入、自动堆叠**。通知性的、看完即过的内容。天气卡、待办通知、状态提示。
- **center**：**屏幕正中、带半透明遮罩**。重要的、需要用户停下来确认的内容。关键警告、需要决策的对话、错误。
- **floating**：**自由浮动、可被用户拖到任何位置**。工具类的、用户希望长期停留的内容。时钟、便签、计算器、监控面板。

### size（多大）
- 字符串预设：`"sm"`（320px）/ `"md"`（420px，默认）/ `"lg"`（600px）/ `"xl"`（820px）
- 或对象：`{ w: 600, h: 400 }`（像素或 CSS 字符串）
- **信息密度高就用大尺寸**。表格、长文本、复杂图表都该 lg/xl。

### draggable（能不能拖）
- 默认：floating=true，其他=false
- 可手动覆盖：notification 卡设 `draggable: true` 也能拖

### modal（要不要遮罩 + 阻止背景操作）
- 默认：center=true，其他=false
- backdrop 点击会关闭卡片

### 选哪种？决策思路
| 内容性质 | placement | size 建议 |
|---|---|---|
| 通知一句话信息（"天气晴 18°"） | notification | sm/md |
| 给用户看一组结构化数据（天气详情、人物档案） | notification | md |
| 必须停下来看的（警告、需要确认的决策） | center | md/lg |
| 用户要研究/操作很久的（数据看板、长文章、表单） | floating 或 center | lg/xl |
| 想常驻屏幕的小工具（时钟、便签、计时器） | floating | sm |

调用示例：
```
ui_show("WeatherCard", { city: "北京", ... }, { placement: "floating", size: "lg" })
ui_show_inline({
  mode: "inline-template",
  template: "...",
  props: { ... }
}, /* 第二个参数不存在，hint 跟 props 同级——见下面正确写法 */)
```

**正确的调用形态**（hint 是 props 同级字段，不是第二个参数）：
```
ui_show({ component: "WeatherCard", props: {...}, hint: { placement: "floating", size: "lg" } })
ui_show_inline({ mode: "inline-template", template, styles, props, hint: { placement: "center" } })
```

---

## 一、什么时候用 UI 卡片，什么时候不用

**用 UI 卡片**当：
- 信息有结构，文字描述会很啰嗦（天气预报、人物档案、文件列表）
- 信息含媒体（图片、视频、链接预览）
- 用户需要"看一眼就懂"而不是"读一段才懂"
- 信息会变化，需要原地更新（比如下载进度、计时器）

**不用 UI 卡片**当：
- 一句话能说清的事（"现在 18 度，晴"）
- 情感、判断、解释——这些是对话，不是数据
- 用户没问你看法、只问你信息——别炫技

**默认偏向不用**。卡片是少数场景的强表达，不是替代说话。

---

## 二、三种执行模式：决策树

```
需要可视化表达
  │
  ├─ 已有合适的注册组件？──── 是 ──▶ 模式 A：ui_show("ComponentName", props)
  │                                  （永远优先这个）
  │
  ├─ 否，那是不是只需要展示信息、没有交互？
  │   │
  │   ├─ 是 ──▶ 模式 B：ui_show_inline({ mode:"inline-template", template, styles, props })
  │   │        （写 HTML+CSS 字符串，最简单）
  │   │
  │   └─ 否（需要按钮/状态/动画/交互）
  │       │
  │       └─▶ 模式 C：ui_show_inline({ mode:"inline-script", code, props })
  │             （写完整的 Web Component class）
  │
  └─ 用过 ≥2 次、没被立刻关掉、有 dwell 信号？
      │
      └─▶ 调 ui_register 转正成模式 A
```

**铁律**：**A > B > C**。能用模式 A 别用模式 B，能用模式 B 别写模式 C。

为什么？模式 A 几十毫秒就显示，token 几乎不消耗；模式 B 中速；模式 C 要发整段代码、还要前端动态加载，最慢、最贵、最容易出错。

---

## 三、可用的注册组件清单

> 这一节会随技能记忆动态注入，你看到的是当前可用的列表。

### WeatherCard
- **何时用**：用户问天气、温度、出门、下不下雨、明后天
- **调用**：
  ```
  ui_show("WeatherCard", {
    city: "北京",
    temp: 18,
    condition: "晴",
    forecast: [{ day: "明天", low: 12, high: 22, condition: "多云" }]
  })
  ```
- **注意**：`temp` 必须是数字，不能写 "18°"；`city` 必须先确定（问用户或从上下文推断），不要瞎填

---

### ImageViewer
- **何时用**：展示任何图片——生成的图片、搜到的图、用户想看的图。图片内容比描述更直接时就用。
- **placement**：始终用 `stage`，这会让背景变暗、图片居中全屏展示
- **调用**：
  ```
  ui_show("ImageViewer", {
    url: "https://example.com/photo.jpg",
    title: "图片标题（可选）"
  }, { placement: "stage" })
  ```
- **用户可以**：单击放大/缩小、滚轮缩放、放大后拖拽平移、点 ✕ 或暗色区域关闭
- **注意**：`url` 必须是可直接访问的图片链接；`title` 省略时显示"图片"

---

### VideoPlayer
- **何时用**：用户要看视频、Agent 要播放一段视频给用户看
- **placement**：始终用 `stage`
- **调用**：
  ```
  ui_show("VideoPlayer", {
    url: "https://example.com/video.mp4",
    title: "视频标题（可选）",
    autoplay: true,
    poster: "https://example.com/thumb.jpg"
  }, { placement: "stage" })
  ```
- **props**：
  - `url`（必填）：MP4/WebM/OGG 等 HTML5 视频格式的直链
  - `title`（可选）：显示在顶栏，省略时显示"视频"
  - `autoplay`（可选，默认 false）：是否自动播放
  - `poster`（可选）：封面图 URL，视频加载前显示
- **画中画**：顶栏有"⧉ 画中画"按钮，点击后视频进入系统级浮窗，卡片自动关闭，视频继续播放
- **注意**：视频 URL 必须是 HTML5 可直接播放的格式；不支持 YouTube/B站等平台链接（需用平台 embed）

---

## 三 · 五、模式 B 也能交互：data-action 桥（**优先用这个，能避免写模式 C**）

**95% 需要交互的卡片不用写模式 C**——模式 B 模板里加几个 data-* 属性就够了。

### 按钮触发动作
```html
<button data-acui-action="ok">知道了</button>
<button data-acui-action="cancel" data-payload-id="${id}">取消</button>
```
用户点击会自动派发 `acui:action` 信号回到你。下次你被唤醒时，`补充上下文` 里能看到：
```
12 秒前：用户在卡片 X 触发 action="ok"
```

### 表单字段绑定
```html
<input data-acui-bind="note" placeholder="备注"/>
<select data-acui-bind="priority">
  <option value="high">高</option>
  <option value="low">低</option>
</select>
<button data-acui-action="save">保存</button>
```

用户点保存时，**所有 `data-acui-bind` 字段的当前值会一起带回来**：
```
action="save", payload={ fields: { note: "明天提醒", priority: "high" } }
```

### 何时还需要写模式 C？
- 内部状态需要在用户操作下持续变化（实时计时器、本地累加器）
- 复杂动画（粒子、SVG 动画、Canvas）
- 需要监听外部事件（resize、键盘快捷键）

**这些场景之外，全部用模式 B + data-action 桥。**

---

## 四、模式 B · 内联模板的写法

```
ui_show_inline({
  mode: "inline-template",
  template: "<div class='card'><h3>${title}</h3><p>${body}</p></div>",
  styles: ".card { padding:16px; background:#11161c; color:#c9d1d9; border-radius:8px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }",
  props: { title: "提醒", body: "明天 10 点和小李会议" }
})
```

### 占位符规则（**反复强调，违反会原样泄漏到屏幕**）

**模板里只有两种合法语法：**

1. **`${字段名}`** — 仅替换为 props[字段名] 的字符串值，自动 HTML 转义。
   - ✅ `<h3>${city}</h3>`
   - ❌ `${city.toUpperCase()}` — 表达式不识别，会原样显示在屏幕上
   - ❌ `${a.b.c}` — 不支持点路径
   - ❌ `${arr.length}`、`${arr.map(...)}`、`${count + 1}` — 任何 JS 表达式都不行

2. **`data-acui-each="字段名"`** — 循环。把那个元素本身当行模板，按 props[字段名]（数组）克隆 N 份。
   - 例 1：字符串数组
     ```html
     <ul>
       <li data-acui-each="items">${item}</li>
     </ul>
     ```
     props.items = `["开会", "打电话", "写报告"]`，行内可用 `${item}` 和 `${index}`
   - 例 2：对象数组
     ```html
     <div class="forecast-row" data-acui-each="forecast">
       <span>${day}</span> <span>${high}°/${low}°</span>
     </div>
     ```
     props.forecast = `[{day:"今", high:22, low:12}, {day:"明", high:24, low:14}]`，行内字段名直接展开

**如果你的需求超出这两种语法（要拼接、要条件、要计算），把结果先在 props 里算好再传**，不要在 template 里写表达式。例如不要写 `${days.map(d=>d.name).join('、')}`，而要在 props 里准备 `days_text: "周一、周二、周三"`，模板里写 `${days_text}` 就行。

### 顶层数组/对象不会展开

如果某个 props 字段是数组或对象，模板里直接写 `${forecast}` 会被替换为空字符串（防止 `[object Object]` 漏出）。**数组要用 `data-acui-each`，对象要先在 props 里拍平字段。**

### 样式约定（保持视觉一致）
- 背景：`#11161c` 或半透明 `rgba(17, 22, 28, .92)`
- 主文字：`#c9d1d9`，次要：`#8b949e`
- 字体直接继承（系统默认）
- 圆角 `border-radius: 8px`
- 阴影 `box-shadow: 0 8px 24px rgba(0,0,0,.4)`
- 内边距至少 16px

### 不要写
- 关闭按钮（renderer 会自动加，等到 §六）
- 入场/出场动画（hint 字段或组件静态 enter/exit 已统一处理）
- `<script>` 标签（被剥离）
- 跳转链接（用 `card.action` 信号反馈给 Agent，Agent 决定下一步）

---

## 五、模式 C · 内联组件的写法

只有当**模式 B 不够用**时才写。需要交互（按钮回调）、内部状态（计时器、表单）、复杂动画时才考虑。

### 完整骨架

```js
export default class extends HTMLElement {
  static componentName = 'TempInline'   // 仅供日志，可省
  static propsSchema = {
    title: { type: 'string', required: true },
    items: { type: 'array',  required: false }
  }

  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
  }

  // props setter：renderer 通过 el.props = {...} 传值
  set props(v) {
    this._props = v
    this._render()
  }
  get props() { return this._props }

  _render() {
    const { title, items = [] } = this._props
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; pointer-events: auto; }
        .card { padding:16px; background:#11161c; color:#c9d1d9; border-radius:8px; }
        button { background:#21262d; color:#c9d1d9; border:0; padding:6px 12px; border-radius:4px; cursor:pointer; }
        button:hover { background:#2d333b; }
      </style>
      <div class="card">
        <h3>${this._escape(title)}</h3>
        <ul>${items.map(i => `<li>${this._escape(i)}</li>`).join('')}</ul>
        <button id="ok">知道了</button>
      </div>
    `
    this.shadowRoot.querySelector('#ok').addEventListener('click', () => {
      // 把用户点击作为 action 信号发回 Agent
      this.dispatchEvent(new CustomEvent('acui:action', {
        bubbles: true, composed: true,
        detail: { action: 'ok_clicked' }
      }))
    })
  }

  _escape(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
      { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
    ))
  }
}
```

### 必须遵守
1. **必须** `export default class extends HTMLElement`，不能定义命名 class
2. **必须** 在构造里 `attachShadow({ mode: 'open' })`
3. **必须** 实现 `set props(value)`——renderer 通过这个 setter 传数据，并在 `update` 时再次调用
4. **不要** 调 `customElements.define`（前端会拦截，调了等于没调）
5. **不要** 直接 `fetch` / `import` / 改 `document` / 用 `localStorage`——你想要的副作用应当通过工具调用（Agent 自己来做），而不是组件内部偷偷做

### 用户操作如何回到 Agent

任何用户交互（按钮、输入、勾选）通过自定义事件冒泡，**不需要你管 ws**：

```js
this.dispatchEvent(new CustomEvent('acui:action', {
  bubbles: true, composed: true,
  detail: { action: '事件名', ...其他字段 }
}))
```

renderer 会捕获并转成 `ui.signal` 发回。下次你被唤醒时，prompt 里能看到"用户在 X 卡片点了 ok_clicked"。

不要试图组件内"等待用户操作再做事"——组件不该有业务逻辑。让 Agent 做决策，组件只负责显示和上报。

---

## 六、不需要你做的事（renderer 已经做了）

- 关闭按钮：renderer 自动加一个右上角 ×（除非你的组件设了 `static noCloseButton = true`）
- 入场/出场动画：`slide-from-right` / `slide-to-right` / `fade`，hint 字段控制
- 显示位置、堆叠、LRU 淘汰
- `card.mounted` / `card.dismissed` / `card.dwell` 信号上报

---

## 七、转正：从临时到永久

当一个内联组件**用过 ≥2 次、用户没立刻关、收到 dwell 信号**，应当转正：

```
ui_register({
  component_name: "ReminderCard",
  code: "export default class extends HTMLElement { ... }",   // 完整代码
  props_schema: {
    title: { type: "string", required: true },
    body:  { type: "string", required: true },
    when:  { type: "string", required: false }
  },
  use_case: "用于显示一条提醒/待办，包含标题、正文、可选时间。命中场景：用户提到'提醒'、'待办'、'记一下'、'别忘了'。",
  example_call: "ui_show(\"ReminderCard\", { title:\"会议\", body:\"和小李讨论方案\", when:\"明天 10:00\" })"
})
```

转正后：
- 文件落到 `src/ui/brain-ui/acui/components/reminder-card.js`
- 注册表自动更新
- 一条 `skill.ui` 记忆写入，下次命中场景时直接注入
- 前端热重载，**当场可用**

### 转正前自检清单
- [ ] 组件名 PascalCase，跟现有不重名
- [ ] propsSchema 完整，字段类型对得上
- [ ] code 在内联时已经成功渲染过 ≥1 次（不要写完没测就转正）
- [ ] use_case 写清楚命中条件，**未来的你**要能凭这条记忆判断该不该用
- [ ] example_call 是合法的 ui_show 调用

---

## 八、避雷清单

| 错误做法 | 后果 | 正确做法 |
|---|---|---|
| 模式 C 里写 `class WeatherCard extends...`（命名 class） | 加载失败 | 必须 `export default class extends...` |
| props 里塞函数 / Date 对象 | 序列化失败 | 用字符串/数字/数组/普通对象，时间用 ISO 字符串 |
| 在组件内 `setTimeout` 跑动画 | 销毁时定时器还在跑 | 用 CSS animation，或在 `disconnectedCallback` 里清理 |
| 模板里 `${title.toUpperCase()}` | 占位符不识别表达式 | 在 props 传 `{ title: '已大写' }` |
| 用 `document.querySelector` | Shadow DOM 隔离，找不到 | 用 `this.shadowRoot.querySelector` |
| 卡片打开后又立刻 `ui_hide` | 用户还没看见就消失 | 让用户自己关，或者至少留 3 秒 |
| 同一秒推 5 张卡 | LRU 全淘汰一遍，用户体验灾难 | 一次只推一张，或合并成一张多行的 |

---

## 九、用户的反馈如何被你看见

每张卡片的生命周期会通过 `ui.signal` 回流到你的 prompt 里。下次你被唤醒时，你会在 system prompt
"环境感知"段落看到类似：

```
过去 60 秒内的界面行为：
- 12 秒前：你打开了 ReminderCard（"会议"）
- 8 秒前：用户在该卡片上停留 5 秒
- 2 秒前：用户点击关闭按钮
```

**这只是上下文，不是触发器。** 不要因为看到"用户关了卡"就道歉、解释、再发一张——除非用户用语言或行为
明确求助（比如连续关了 3 张同类的卡）。Jarvis 不会因为 Tony 关了一个浏览器窗口就跳出来问"还需要吗"。

---

## 十、一句话原则

> **能不画就不画；要画就画清楚；画完就闭嘴看着。**

---

*ACUI Phase 1 · 给 Agent 的组件创作指南*
