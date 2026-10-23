# 请求性能诊断

2026-10-21（北京时间）为消息入口、上下文准备、SQLite、模型流和聊天正文显示增加计时。先记录基线，再针对“发送后 2 秒内看到首正文”优化。下文基线保留原始数据；最新优化与验证见后文。未切换模型，也未整体裁剪上下文。

## 实测结论

当前规模下，数据库不是主要瓶颈。最明确的本地延迟来自本地 embedding 冷启动和每轮无条件等待 macOS Music.app 状态。请求上下文较大，历史慢回合还叠加了多轮模型和工具执行。

诊断使用正在安装版本的数据副本与当前工作区代码，SQLite backup 保持快照一致；不会修改正式数据库，不启动调度器/社交连接器，不执行真实工具或向用户发送回复。真实模型请求使用现有 `custom / deepseek-flash / responses` 配置。固定消息为“你好，请只回复‘收到’”，每次只运行一轮模型，输出上限 512 tokens。完整上下文与 44 输入 token 的短对照交替运行，各 3 次。

**这是定位样本，不是服务延迟保证。** 初次样本包含未预热的本地 embedding；应用正常启动已安排后台预热，因此不应把这项冷启动开销计入所有正式请求。探针限制非模型网络，最新这组 `blockedNetworkRequests=0`。短对照与完整上下文的内容、工具、缓存命中都不同，不能把时差解释成上下文长度的单变量因果效应。第一次详细采样还与本地回归测试有短暂并行，CPU/网络波动均可能影响结果。

证据目录：工作区上层 `outputs/request-performance-20261021/`。

- `live-model-detailed.json`：下表的完整阶段数据，采样开始于北京时间 01:22:08。
- `database-history-audit.json`：正式数据库只读查询与历史上下文规模。
- `live-model.json`：前一组探索采样，其中第三次完整上下文被 128 输出 token 上限截断，不能作为首正文样本。
- `prepare-only.json`：最初未完整模拟入站封装的探索样本，不作为完整请求结论。

单位：毫秒。入口从 `pushMessage` 开始，本表不包含浏览器处理、上传、语音识别、语音合成或真实繁忙队列等待。

| 阶段 | 首次调用 | 第二次 | 第三次 |
|---|---:|---:|---:|
| 入站持久化、信息发布到入队 | 8.12 | 1.99 | 2.30 |
| 入队到处理开始（隔离空队列） | 0.33 | 0.02 | 0.04 |
| 处理开始到真正调用 fetch | 1247.13 | 276.53 | 258.70 |
| 其中：记忆注入整体 | 875.71 | 13.94 | 19.45 |
| 其中：embedding 等待（包含在记忆注入内） | 834.87 | 0.08 | 0.07 |
| 其中：Music.app 状态预取 | 295.32 | 245.56 | 224.59 |
| 其中：信息源渲染 | 9.26 | 8.40 | 7.36 |
| 其中：旧回合追踪首次读盘 | 20.01 | 0.04 | 0.05 |
| 入站开始到 fetch | 1255.74 | 278.57 | 261.07 |
| fetch 到 HTTP 响应头 | 413.28 | 334.59 | 315.80 |
| fetch 到首个有效模型增量 | 1285.88 | 1044.68 | 569.07 |
| fetch 到首个正文增量 | 1419.75 | 1130.68 | 884.66 |
| 入站开始到首个有效增量 | 2541.62 | 1323.25 | 830.14 |
| 入站开始到首正文 | 2675.49 | 1409.25 | 1145.73 |
| 数据库累计（分布在上述阶段中） | 11.63 | 11.35 | 15.97 |
| 最慢单次数据库操作 | 0.63 | 1.18 | 0.61 |

各阶段嵌套且有并行，不能逐行求和。记录值相对进程内计时起点，最新版汇总另扣除了 `request.received` 前约 0.03–0.16 ms 的追踪初始化开销。隔离探针在正常模型结束后主动抑制投递，因此完整上下文记录的 `aborted` 是诊断行为，不代表模型请求失败。

完整请求包含 18–20 条消息、5 个工具、约 5.9 万序列化消息字符、约 77 KB HTTP 请求体。服务端返回实际输入用量为 18,997 / 19,049 / 19,122 tokens，缓存命中均为 4,480。首增量为思考，正文稍后出现；本地 `thinking=false` 在当前 `custom` Responses 配置下不会发送 reasoning 控制字段，不能据此假设网关不思考。

短对照首增量为 880 / 549 / 709 ms。完整请求中位数为 1,045 ms，短对照中位数为 709 ms；完整请求有一次比同轮短对照更快，因此暂不声称上下文解释了全部模型等待。

正式数据库仅 56 条记忆、84 条对话、24 条 embedding、0 个 knowledge chunks。六类只读查询各跑 101 次，热查询中位数均不足 0.1 ms。完整请求虽然有 238–262 次数据库操作（含 prepare），总量只有约 11–16 ms。目前没有秒级慢查询证据。

历史五次前台语音回合（2026-10-20 21:32–21:35）总耗时 6.778 / 8.035 / 10.179 / 42.996 / 25.946 秒，分别执行 2 / 3 / 3 / 4 / 7 轮模型。首轮上下文约 4.2 万–6 万字符，不含工具 schema；信息源 system 占 2.2 万–3.3 万字符，其中相关记忆、策略记忆、用户画像占比较大。旧记录没有逐轮首 token 计时，不能用这些总时长反推 TTFT，也不能将剩余时间全部算作模型生成。

## 请求路径与指标含义

1. 前端 `send()`：本地 UI/附件准备、JSON 序列化、发起 POST。
2. `/message`：读包、媒体处理、资源查询、保存消息、发布 Information Core 事件与租约。
3. 队列：入队、等待当前回合结束/抢占、开始 `runTurn`。
4. 上下文：工具选择 → 记忆与轻量信息并行 → 运行时/知识/天气并行 → 信息源渲染 → 组装消息；非快速路径还可能调用辅助 LLM 刷新记忆。
5. `callLLM`：工具 schema、回合追踪、协议转换、SDK JSON 序列化、进入实际 fetch。
6. 网络与模型：响应头 → 首 SSE 事件 → 首个有效思考/文本/工具增量 → 首正文 → 流结束。
7. 如有工具，执行工具、追加结果、进入下一轮；最终投递和清理。

`dispatch` 是进入真实 fetch 的时刻，不是“请求体全部上传完成”。fetch 没有提供后一个边界。`first_event` 可能只是 `response.created` 或 role，不能算首 token；`first_delta` 指协议层首个有效增量（可能含多个 token），分别记录 reasoning/text/tool/commentary。

`prepareMs` 为处理开始到**主回复模型**首次 dispatch，包含可能的辅助模型准备；辅助模型事件标为 `auxiliary`，不冒充主回复首 token。`dispatchToFirstDeltaMs` 从实际成功产出增量的 fetch attempt 开始；`firstDispatchToFirstDeltaMs` 从最初 dispatch 开始，保留 SDK/应用重试的代价。每轮、每次应用重试及 SDK 内部重试都有单独序号。

前端只传自身单调时钟测出的准备/序列化时长。浏览器与服务器时钟不会互减，POST 接收确认也不会冒充模型首 token。`delivery.first_text` 是首个通过过滤、允许进入本地聊天气泡的非空正文广播；`receivedToFirstTextBroadcastMs` 包含正文过滤等待，`firstTextToBroadcastMs` 用来区分模型和应用缓冲。

主窗口浏览器另外用自身 `performance.now()` 记录 `sendToFirstTextReceivedMs`、`sendToFirstTextDomMs` 和 `sendToFirstTextFrameOpportunityMs`。后者经过两次 animation frame 并检查元素可见性，代表绘制机会，不能视为硬件显示已完成的证明。思考、过程说明、空占位均不算首正文；通过 `client_message_id`、`request_id`、`turn_id` 关联，即使 SSE 比 POST 确认先到也能记录。主窗口语音从 `chat.send()` 起计，不包括语音识别；独立 FocusBanner 窗口只有本地准备和服务器计时，不能跨渲染进程直接相减时钟。

## 查看与复现

运行包含本次修改的源码后端或新构建后，打开原有 `/turn-trace` 页面，选择一个新回合即可查看“请求耗时”、阶段和 SQL 指纹。旧回合不可补算，缺失显示 `—`。

- `GET /admin/performance?limit=80`：最近性能记录，沿用现有 API 访问控制。
- 用户数据目录 `data/request-performance.jsonl`：异步落盘、有界保留；不含正文、API key、工具参数或 SQL 绑定参数。
- 控制台 `[performance]`：回合摘要；浏览器 `[performance-client]`：本地准备和 POST 确认；`[performance-visible]`：首正文 DOM/帧机会。
- `BAILONGMA_PERFORMANCE_TRACE=0`：关闭性能日志和落盘，保留进程内测量，供隔离探针使用。

在仓库根目录运行（macOS，使用项目的 Electron SQLite ABI）：

```sh
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/probe-request-performance.mjs \
  --source-dir "$HOME/Library/Application Support/Bailongma" \
  --output /tmp/request-performance.json --runs 3
```

加 `--live-model` 会使用现有模型配置发起真实、有用量的模型请求；不加则只测本地准备。`--max-output-tokens 512` 可控制诊断输出预算。`--http` 经真实消息路由和 SSE 测本机 HTTP 发送到首正文；`--varied` 使用五条不同的无副作用消息，避免只命中同一问题的向量缓存；`--warm-embedding` 预热本地模型；`--no-control` 跳过短上下文对照。最多支持 20 次。应在无并行负载时重复采样，避免将单次值当作稳定 P95。

```sh
python3 scripts/audit-performance-data.py --help
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test \
  src/test-request-performance.js src/test-request-performance-ingress.js \
  src/test-sqlite-performance.js src/test-model-transport.js
node scripts/check-agent-layers.mjs
```

SQLite 埋点覆盖 prepare/get/all/run/iterate；初始化 schema、exec/pragma、事务 BEGIN/COMMIT 不细分计数，仍计入外层阶段。迭代只计 SQLite 的 next/return 时间，不把调用方循环逻辑当查询耗时。SQL 按累计耗时展示最多 20 组；全局最大单次值独立保留。

## 2 秒首正文优化

已实施：

1. 非音乐消息不再等待 Music.app 查询。音乐问询/控制仍读取新状态，并发读取合并，动作后验证，旧查询不能覆盖动作后的新状态。
2. embedding 在启动准备开始时后台预热。实时消息不触发冷模型加载，冷时保留 FTS、人物与策略召回；温模型最多等待 120 ms，超时计算继续缓存。同模型/同文本/同 query 模式合并并发推理。后台召回保留原预算（默认 1,500 ms）。
3. 部分正常正文以“当前 / 我需要 / I will”等开头，原先会被暂存到流结束。现在完整句子通过原有过滤后可先输出；内部前言和未完成前缀仍受保护，不按定时器强行输出。
4. 自定义 Responses 网关的思考能力必须显式声明。原本 `thinking=false` 没有传控制字段，模型仍产生隐藏思考。已用当前网关的隔离真实请求验证 `reasoning.effort=none` 生效，再接入设置；未知网关继续默认省略该字段。

中间验证（同一个配置与数据快照，5 条不同普通消息，完整上下文，每次一轮模型，512 输出 token 上限）：

| 条件 | 准备到 dispatch | 本机 HTTP 发送到首正文 SSE | 小于 2 秒 |
|---|---:|---:|---:|
| 原基线（固定消息，入口不含 HTTP） | 259–1,247 ms | 1,146–2,675 ms（服务端接收到首正文） | 2/3 |
| Music/冷 embedding 优化 | 29–82 ms | 1,233 / 1,545 / 1,816 / 1,876 / 1,443 ms | 5/5 |
| 同上，embedding 已预热 | 58–121 ms | 1,439 / 1,916 / 2,443 / 3,303 / 1,044 ms | 3/5 |
| 预热 + 网关关闭思考实验 | 63–125 ms | 1,775 / 1,384 / 814 / 1,431 / 1,243 ms | 5/5 |

这几组按顺序采样，输入和网关缓存不同，不能把差值全归因于单个变量。预热组的慢样本，模型先输出 194 / 354 个思考 token 后才给正文；关闭思考实验五次 `reasoningTokens=0`。上述优化后首正文到服务器广播约 0.5–1.3 ms。未整体减少上下文，仍约 1.7 万–1.9 万输入 token；数据库仍仅约 9–16 ms。预热两组拦截的网络均为 6 次脱离前台 trace 的后台分类请求，前台没有被阻断的网络请求。冷组旧探针只记录总拦截 6 次，未按 trace 分类。

证据：`optimized-cold-http.json`、`optimized-warm-http.json`、`reasoning-capability-http.json`。实验开关 `--probe-reasoning-none` 只修改隔离探针的出站 JSON，不修改正式配置；该实验的请求字节统计在注入额外字段之前记录。

最终验证使用保存后的真实配置 `reasoningControl=effort`、`thinking=false`，**没有使用请求注入实验开关**。2026-10-21 北京时间 01:52:38 开始，经真实 Chromium、生产 `chat.send()` / Markdown 气泡、真实 `/message` / SSE 路由和真实模型连续运行 10 次（五种问题各两次）。本地向量模型预热成功，十次向量均可用；后五次命中查询缓存。数据来自正式数据库副本；工具和对外投递受抑制。浏览器使用隔离的最小页面承载生产聊天组件，并非已安装应用的完整场景 UI 或硬件屏幕测试。

| 最终指标 | 最小 | 中位数 | 最大 |
|---|---:|---:|---:|
| 处理开始 → 模型 fetch | 16.74 ms | 41.76 ms | 176.90 ms |
| 服务端接收 → 模型 fetch | 20.34 ms | 45.89 ms | 187.45 ms |
| 模型 fetch → 首正文 | 654.73 ms | 1,095.11 ms | 1,312.59 ms |
| 浏览器发送 → 首正文 DOM | 679.00 ms | 1,157.60 ms | 1,443.00 ms |
| 浏览器发送 → 后续可见帧机会 | 709.90 ms | 1,186.30 ms | 1,469.40 ms |
| 数据库累计 | 6.78 ms | 8.88 ms | 15.58 ms |

首正文 DOM 和帧机会均为 **10/10 小于 2 秒**，页面/SSE 错误均为 0；每次实际输入仍为 16,709–19,049 tokens，`reasoningTokens=0`。首次前端准备约 30 ms，后续约 0.2–1 ms。正文进入 DOM 在客户端接收后 0–0.7 ms，应用转发/渲染未显示额外秒级等待。12 次被拦截的网络均来自脱离前台 trace 的后台分类；前台未阻断网络。证据文件 `optimized-final-browser.json`，保留全部失败/缺失指标，未筛选慢样本。

复现最终浏览器路径（需要已有 Playwright Chromium）：

```sh
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/probe-request-performance.mjs \
  --source-dir "$HOME/Library/Application Support/Bailongma" \
  --output /tmp/request-performance-browser.json \
  --live-model --browser --varied --no-control --warm-embedding --runs 10
```

自定义网关能力在“设置 → 模型”选择 `reasoning.effort`，且关闭“思考”；只有验证支持的网关才启用。更换 URL 或模型时默认重置为不发送，连接验证失败不覆盖原配置。当前用户的 `llm/custom.json` 已通过该保存流程启用，原文件保存在同目录 `custom.before-latency-20261021.json.bak`（权限 0600），密钥与端点未写入报告。该字段由本次源码读取；旧安装包不会自动获得实现。

2 秒是普通聊天的性能目标，并非远端 SLA。繁忙队列、网关抖动、服务端限流重试、明确请求的实时天气/设备采集，以及先执行工具才能给出可靠答案的任务，都可能超过 2 秒。未用固定“收到”占位冒充模型首字，也未通过展示隐藏思考来满足指标。到期设备订阅仍可能触发较慢采集，应在真实追踪中继续关注。

## 后续观察

1. 观察实时向量超时率和召回质量；冷启动跳过向量是明确的延迟/召回取舍，FTS 不能完全替代语义召回。
2. 为相关记忆、active policies、legacy components、用户画像设置预算与去重前验证召回质量。信息源默认上限仍为 64,000 字符。
3. 利用新埋点判断多轮耗时究竟在模型等待、工具执行还是额外催答；五次历史慢回合包含多轮，不能只优化第一轮。
4. 收集更长时间的真实样本后再决定数据库索引/查询改造；当前测量不支持优先做数据库优化。

验证：最终组合回归 41 项通过，另通过 embedding deadline/召回、Music 状态、分块正文过滤、客户端关联/Chromium、网关配置/切换/回滚、设置 UI、协议、国际化与架构边界检查。没有将真实模型的时延断言写进离线单元测试。

本次未替换或重启 `/Applications/Bailongma.app`。当前正在运行的已安装版本不会自动获得源码埋点或优化，需要运行包含本次代码的新构建。当前网关的能力配置已保存且有原文件备份；其他网关默认不启用未经验证的参数。
