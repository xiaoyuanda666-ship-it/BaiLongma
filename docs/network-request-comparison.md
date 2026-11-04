> 历史记录：文中 Playwright MCP 实现和对应采集、打包脚本已移除；当前网页入口见 [browserskill-backend.md](browserskill-backend.md)。

# Safari 人工访问与白龙马 Electron/Playwright 网络请求对比审计

审计日期：2026-07-26

## 执行摘要

本次在同一台 Mac、同一网络、相邻时间内，对 `https://www.baidu.com/` 做了两次只读首页访问：用户在 Safari 26.5.2 中人工输入地址；白龙马通过真实 Electron `WebContentsView` 和当前 Playwright MCP 的 `browser_navigate` 打开同一地址。Safari 记录 71 个请求，白龙马记录 79 个请求。

结论如下：

1. 白龙马最强、成本最低的可识别信号是请求 UA 直接包含 `Electron/33.4.11`。服务端只需字符串匹配即可识别 Electron，无需高级风控。
2. 白龙马页面环境快照中的 `navigator.webdriver` 为 `true`。Safari HAR 不包含该 JS 属性，因而本次不能把它写成两侧实测差异；但网页脚本能够直接读取白龙马的该值，它仍是极高风险信号。
3. 初始白龙马样本有 76/79 个请求包含 `Cache-Control: no-cache` 和 `Pragma: no-cache`。将 embedded 页的私网防护从 Playwright `page.route('**/*')` 迁移到 Electron 原生 `session.webRequest` 后，同一流程仍为 79 个请求，但上述两个字段都从 76 降到 0。因此可以确认它们是 Playwright 路由层造成的采集路径副作用，现已消除；SSRF、重定向与 WebSocket 私网防护仍保留。
4. 两侧绝大多数百度业务端点相同。白龙马没有独有的验证码、挑战、设备注册或明显风险控制端点；Safari 独有一个 `ps_fp.htm` 指纹样式端点，但单次样本不足以判断其用途或自动化含义。
5. Safari/WebKit 与 Electron/Chromium 是不同浏览器引擎。`sec-ch-ua`、伪首部、协议字段暴露、资源分类等大量差异首先是引擎差异，不能直接归因于 Playwright 或 CDP。
6. 本轮只有“打开首页”，没有搜索、点击或输入，所以不能检验默认中心点击、无按下延迟、`fill()` 整段输入、逐键事件或首次交互时间。也不能把本轮百度结果直接外推为小红书违规警告的原因。

## 采集条件

| 条件 | Safari 人工访问 | 白龙马 Electron/Playwright |
| --- | --- | --- |
| 时间 | 2026-07-26 18:47（Asia/Shanghai） | 初始 18:48；原生守卫控制组 19:23（Asia/Shanghai） |
| 页面 | `https://www.baidu.com/` | `https://www.baidu.com/` |
| 动作 | 用户人工在地址栏输入并回车，等待约 10 秒 | MCP `browser_navigate`，等待 10 秒 |
| 浏览器 | Safari 26.5.2 / WebKit 605.1.15 | Electron 33.4.11 / Chromium 130.0.6723.191 / Playwright MCP 0.0.78 |
| 会话 | 用户日常 Safari 会话，可能有既有 Cookie/缓存 | 临时干净 `persist:bailongma-browser` 分区 |
| 采集 | Safari Web Inspector Network 导出 HAR | Electron DevTools Protocol Network 域，只读观察 |
| HTTPS 代理 | 无 | 无 |
| 请求拦截 | 未配置 | 诊断记录器不拦截；产品私网安全守卫使用 Electron `session.webRequest` 只做允许/取消决策 |
| 请求数 | 71（GET 67 / POST 4） | 79（GET 74 / POST 5） |

原始 Safari HAR 位于用户下载目录，不纳入版本库。白龙马原始记录与脱敏对比产物位于 `data/network-audits/`。比较工具丢弃请求/响应正文，并对 URL 查询值、动态路径、Cookie、Authorization、Set-Cookie、Token、签名、账号标识候选值及远端地址做脱敏或聚合。

## 对仓库已知情况的代码核验

- `electron/main.cjs` 确实全局设置 `remote-debugging-address=127.0.0.1` 与 `remote-debugging-port=0`。
- 原有 `F12` 操作的是主窗口 `window.webContents`，不是嵌入网页。现新增的 `Shift+F12` 才打开嵌入页自己的 detached DevTools；`Cmd/Ctrl+Shift+F12` 切换嵌入页网络记录。
- 小红书等外部网页由 `electron/browser-embed-host.cjs` 创建的独立 `WebContentsView` 承载，使用独立持久分区和受限 webPreferences。
- `src/mcp/embedded-playwright-connection.js` 通过 CDP Target ID 枚举并匹配精确页面，只把该 `WebContentsView` 暴露给 MCP。
- 当前 `@playwright/mcp` 实现中，`browser_click` 未提供位置和 delay 时直接调用 locator `click()`，即使用 Playwright 默认点击点与时序；`browser_type` 在 `slowly` 未开启时直接调用 `fill()`，开启时才调用 `pressSequentially()`。
- embedded 页面现由 `electron/browser-embed-host.cjs` 在独立 session 上安装原生请求守卫；只有原生守卫未确认时，`src/mcp/playwright-page-guard.cjs` 才回退到 `page.route('**/*')`，避免安全降级。

## 可确认事实

- Safari UA：`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15`。
- 白龙马 UA：`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36`。
- Safari 没有发送 Chromium Client Hints；白龙马发送 `sec-ch-ua: "Not?A_Brand";v="99", "Chromium";v="130"`、`sec-ch-ua-mobile: ?0`、`sec-ch-ua-platform: "macOS"`。
- Safari `Accept-Language` 为 `zh-CN,zh-Hans;q=0.9`；白龙马为 `zh-CN`。
- Safari 有 14 个请求包含 Cookie 请求头；原生守卫后的白龙马为 20 个。Safari HAR 不含被阻止 Cookie 和分区键详情；白龙马观察到 27 个被阻止的关联 Cookie、75 个响应分区键、0 个分区请求 Cookie。两侧会话状态不同，不能用数量直接判定自动化。
- Safari 有一个 `304`；白龙马没有 `304`，且记录器报告 0 个磁盘缓存命中。该差异与日常会话对临时干净分区的条件不同一致。
- 白龙马记录到 HTTP/2 56 个、HTTP/1.1 20 个；Safari HAR 只有 17/71 个请求带可用协议字段。字段覆盖不同，不能据此断言传输栈差异。
- 白龙马没有 WebSocket 事件。Safari HAR 也未呈现 WebSocket 会话。
- 两侧 `hasUserGesture` 都不可用；不能从本次记录判断用户手势差异。

## 请求差异表

| 比较项 | Safari 人工访问 | 白龙马 | 判断 |
| --- | --- | --- | --- |
| 请求数 | 71 | 79 | 低；资源、缓存和会话噪声可解释 |
| UA | Safari/WebKit 26.5.2 | Chromium 130 + `Electron/33.4.11` | 极高；Electron 明文可直接匹配 |
| Client Hints | 无 `sec-ch-ua*` | 75 个请求含 `sec-ch-ua` | 高可区分，主要是 WebKit/Chromium 引擎差异 |
| Accept-Language | `zh-CN,zh-Hans;q=0.9` | `zh-CN` | 高；可稳定分组，但不单独证明自动化 |
| 缓存控制 | 4 个 `max-age=0`，无 `Pragma` | 修复前 76 个 `no-cache` + `Pragma`；修复后均为 0 | 已确认并修复 Playwright route 污染，不再是当前网络差异 |
| Origin | 4 个请求，值均为百度首页 | 36 个请求，值均为百度首页 | 中；存在性范围不同，值本身一致 |
| Referer | 16 个请求，百度首页 | 77 个请求，主要为百度首页 | 中；HAR/CDP 与引擎字段暴露存在差异 |
| `sec-fetch-*` | site/mode/dest 可见，无 `sec-fetch-user` | 同类 site/mode/dest，导航含 `sec-fetch-user: ?1` | 中；主要是 WebKit/Chromium差异 |
| 请求头字段集合 | 独有 `if-modified-since`、`x-requested-with` | 独有 Chromium 伪首部、CH、`pragma`、`range` 等 | 中；混合了引擎与缓存条件差异 |
| Cookie | 14 个请求存在 | 20 个请求存在 | 低；会话不一致，不能直接比较数量 |
| 缓存/SW | 1 个 304；HAR 无完整缓存/SW字段 | 0 个 disk/SW/prefetch 命中 | 低；采集能力和会话状态不同 |
| 协议/TLS | HTTP/1.1 14、HTTP/2 3，其余未知；无 TLS 详情 | h2 56、HTTP/1.1 20；TLS 1.2 18、TLS 1.3 58 | 不可直接比较，主要是 HAR 字段缺失 |
| 归一化后的请求窗口 | 0–1114 ms | 0–3119 ms | 低；页面执行与采集格式不同 |
| 业务端点 | 独有 `GET .../ps_fp.htm` | 无独有业务端点 | 中；名称像指纹接口，但用途与触发原因未证实 |
| 风控/挑战 | 未见明确挑战端点 | 未见明确挑战端点 | 低；仅限百度首页单次样本 |

请求头“顺序”来自 Safari HAR 数组或 CDP 对象枚举，并不是 HTTP/2/HTTP/3 在线线序。本报告不把它当作已确认的网络指纹。Safari HAR 还缺少完整 Initiator、`hasUserGesture`、分区 Cookie、连接复用和 TLS 字段，相关空值不视为 Safari 未发送或未使用。

## 风险信号（极高到低）

| 等级 | 证据性质 | 信号 |
| --- | --- | --- |
| 极高 | 事实 | 白龙马网络 UA 明文包含 `Electron/33.4.11`，服务端可用单条低成本规则识别。 |
| 极高 | 事实 + 基线缺口 | 白龙马 JS 环境 `navigator.webdriver=true`；Safari HAR 不含此字段，但站点脚本可直接读取白龙马值。 |
| 高 | 事实 | UA、Chromium 版本、Client Hints 与 Safari/WebKit 完全不同，能被稳定分组；其中大部分是引擎差异。 |
| 高 | 事实 | `Accept-Language` 和 `navigator.languages` 组合不同，可与 UA/CH 一起形成低成本复合规则。 |
| 中 | 事实 + 推断 | 白龙马 `focus=true`、内容区 1280×840；Safari HAR 不含等价快照。可见性/窗口特征可能被客户端遥测，但本轮没有上传正文证据。 |
| 中 | 事实 + 推断 | Safari 出现 `ps_fp.htm` 与 `fp` 查询字段；名称暗示指纹流程，但不能从名称证明风险识别目的。 |
| 中 | 代码事实，未在本轮触发 | 默认 `browser_type` 使用 `fill()`，默认 click 无 delay。搜索/输入场景中可能缺少逐键事件或出现规则化时序，本轮没有输入证据。 |
| 低 | 事实 | 请求数量、缓存、304、协议计数和 Cookie 数量有差异，但受会话、引擎与 HAR/CDP 字段覆盖影响。 |
| 低 | 已整改 | Playwright route 曾给 76 个请求增加 `no-cache/Pragma`；原生守卫控制组已降为 0。 |
| 低 | 未发现 | 没有看到白龙马独有的验证码、挑战、设备注册或明确风控端点，也没有直接的 `Playwright`/`CDP` 请求头。 |

多个差异组合后，`Electron` UA + `navigator.webdriver=true` + 语言/Client Hints 不一致，仍足以让平台用低成本规则把白龙马请求群与 Safari 人工访问分开。已消除的 `no-cache/Pragma` 不再计入当前组合。这里确认的是“可区分性”，不是“百度或小红书已经采用了这条规则”。

## 事实与推断边界

事实包括：两份记录中的请求、头字段、状态、时间、端点集合；白龙马页面快照；仓库中 CDP、Target、route、click 与 type 的实现路径；以及同一白龙马流程迁移守卫前后 `no-cache/Pragma` 从 76/76 变为 0/0 的控制结果。

推断包括：`ps_fp.htm` 是风险指纹；平台把任一差异用于封禁；本轮差异解释了小红书既有警告。`no-cache/Pragma` 的 route 归因已有控制实验支持，不再列为推断。其余结论仍需要平台侧日志，不能靠接口名称或单次抓包下结论。

由于工具主动丢弃请求/响应正文，本报告无法判断网页是否把 `navigator.webdriver`、鼠标/键盘/input、visibility、focus 或窗口尺寸写入遥测 Payload。此限制是有意的隐私保护，不应通过保存完整敏感正文来绕过。

## 采集工具自身造成的污染

- Safari Web Inspector 可能影响焦点和 viewport；本次没有开启 Ignore Cache，但 Safari HAR 显示日常会话缓存状态与白龙马临时分区不同。
- Safari HAR 和 Electron CDP JSON 的字段覆盖不同，导致资源类型、协议、TLS、Cookie 分区、Initiator 与用户手势不能完全对齐。
- 白龙马记录器只启用 Network/Runtime 只读事件，不启用 Fetch，不拦截、修改、伪造或重放请求；开始和结束各读取一次页面环境。
- 白龙马原先为私网安全安装的 Playwright route 会改变缓存行为；该污染已通过 Electron 原生守卫消除。无原生守卫的独立 Playwright备用路径仍保留 route，避免安全降级。
- 主程序的 `remote-debugging-port=0` 与 Playwright 附加均可能影响 `navigator.webdriver`。此前 Chrome for Testing 基线也用 port 0，导致 `webdriver=true`，该轮结果已作废。采集脚本现改用固定临时回环端口，控制检查确认同一 Chrome 二进制回到 `webdriver=false`。
- Safari 与 Chromium 版本和引擎不匹配，是本轮最大的归因混杂因素。这份对比适合回答“用户日常 Safari 与白龙马是否可区分”，不适合单独回答“纯 Electron、Playwright、CDP 各自贡献多少”。

## 合规整改建议

1. 不做 webdriver 隐藏、UA 伪装、随机鼠标轨迹、验证码处理或请求重放；这些不是本审计建议。
2. 生产环境若非必须，不应长期全局开启随机 CDP 端口。把远程调试收敛为明确的诊断/MCP 生命周期，并继续只绑定回环地址。
3. 保持当前 Electron 原生请求守卫及其 SSRF、重定向、WebSocket 回归测试；不要为追求请求一致性删除私网防护。
4. 对输入类只读流程，在语义需要真实键盘事件时显式使用现有 `slowly`/`pressSequentially` 能力；不要用随机延迟冒充人工，也不要用于账号写操作。
5. 将系统语言、Electron session locale 与产品语言配置保持一致，避免 `Accept-Language`、`navigator.language(s)` 互相矛盾；这是兼容性整改，不是伪装。
6. 对小红书只做页面打开、搜索结果查看等经授权只读复测。登录、验证码和任何账号动作必须由用户完成；禁止自动发布、评论、点赞、关注、私信或上传。
7. 若要继续分离根因，下一轮依次做：同版本普通 Chromium人工访问；Electron 无 Playwright；Electron + CDP + 原生守卫。每组至少三轮、交替顺序、相同窗口和临时会话。

## 仍缺少的证据

- 同一 Chromium 130 版本下的人工基线，因此不能分离 WebKit/Chromium与 Electron 差异。
- 人工逐键输入、白龙马 `fill()`、白龙马 `slowly=true` 三组同关键词搜索记录，因此没有输入遥测证据。
- 小红书授权账号的只读同条件样本及平台侧风险日志，因此不能判断既有违规警告的具体触发规则。
- Safari 的页面环境快照。HAR 本身不含 `navigator.webdriver`、focus、visibility、viewport 与完整 Cookie/TLS 元数据。

脱敏明细报告：`data/network-audits/safari-baidu-network-comparison-after-native-guard.md`
脱敏机器可读结果：`data/network-audits/safari-baidu-network-comparison-after-native-guard.json`
