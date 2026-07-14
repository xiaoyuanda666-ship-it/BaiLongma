// Jarvis自知识文档 —— 解释自身的代码机制、架构与界面设计。
// 工具清单一节由 auto-catalog.js 从 capabilities/schemas/ 自动生成，杜绝随版本漂移。

import { buildToolCatalogText } from './auto-catalog.js'
import { getAppVersion } from '../version.js'
import { listCapabilities } from '../capabilities/capability-registry.js'

// 在模块加载时生成一次工具清单文本（纯数据派生，无副作用）。
const TOOL_CATALOG_TEXT = buildToolCatalogText()

// 能力清单文本（派生自 capability-registry.js，杜绝漂移）。能力 = 工作流上下文 + 配套工具 +
// 运行时数据预喂，由情境触发打包注入；新增能力自动出现在这里，无需手改本文档。
const CAPABILITY_LIST_TEXT = listCapabilities()
  .map(c => `  - ${c.label}（${c.id}）：${c.summary}\n      工具：${c.tools.length ? c.tools.join('、') : '随上下文加载'}`)
  .join('\n')

// 当前应用版本（从 package.json 派生，升级自动跟上，不手写）。
const APP_VERSION = getAppVersion()

export const SELF_KNOWLEDGE_TOPICS = {
  self_architecture: {
    id: 'self_architecture',
    title: 'Jarvis架构与运行机制',
    subtitle: 'How BaiLongma Works',
    icon: '⚙',
    summary: `Jarvis（BaiLongma）是一套 Electron + Node.js 的"持续意识"框架，当前版本 ${APP_VERSION}。它不是被动等待提问的聊天机器人，而是一个持续运行、自主感知、带长期记忆的 Agent。以下是当前版本的完整机制说明。`,
    sections: [
      {
        title: '整体架构',
        content: `Jarvis由三层构成：

■ Electron 壳（electron/main.cjs）
  - 启动桌面窗口、系统托盘、自动更新、Focus Banner 子窗口
  - 以子进程方式拉起 Node.js 后端（src/index.js），通过 IPC + preload.cjs 与渲染进程通信

■ Node.js 后端（src/index.js）
  - 真正的"意识循环"在这里跑：消息队列、心跳、LLM 调用、记忆、工具执行
  - 同时是 HTTP/WebSocket 服务器（src/api.js），默认监听 localhost 端口
  - 可脱离 Electron 单独以后端模式运行

■ Brain UI 前端（src/ui/brain-ui/）
  - 运行在 Electron 渲染进程，通过 WebSocket + REST 与后端实时通信
  - 详见"Jarvis界面设计"文档主题（ui_design）

数据落在 SQLite（src/db.js）与 data/ 目录；运行配置在 config.json + 若干独立配置文件。`,
      },
      {
        title: '意识循环：L1 / L2 两种入口',
        content: `Jarvis不是"两个人格"，而是同一个 AI 的两种触发入口，共享同等的上下文质量（记忆、人物卡、思维、UI 状态）：

■ L1（用户消息触发）
  - 用户发消息时激活，本轮通常要回应
  - 本地/语音渠道可走纯文本直接回复；社交渠道必须用 send_message 投递

■ L2（TICK 心跳触发）
  - 系统定时心跳，代表"时间流逝"，无强制回复
  - AI 自行判断是否需要主动出声；"保持沉默"是合法终点

驱动这套循环的模块：
  - ticker.js —— 心跳节奏器，间隔可由 set_tick_interval 工具动态调整
  - queue.js —— 消息队列，统一排队用户消息 / TICK / 社交消息，保证顺序与优先级
  - control.js —— 循环控制，保证同一时刻只有一个处理任务在跑`,
      },
      {
        title: 'LLM 调用与提示词组装',
        content: `■ llm.js
  - 封装 OpenAI 兼容 API（DeepSeek、MiniMax、Qwen、Moonshot、Zhipu、OpenAI、小米 MiMo、自定义端点）
  - 支持流式输出、工具调用（tool_calls）、<think> 推理块
  - 工具循环：模型出 tool_call → executor 执行 → 结果回灌 → 继续，直到收尾
  - 内置耗时工具的进度兜底（执行慢工具前替模型先应一声）、投递权威判定（delivered 为唯一权威）

■ prompt.js —— 系统提示词组装（buildSystemPrompt）
  - 固定行为规则（最高优先级）+ 关系姿态（Jarvis/Tony 同构）+ 回复规则
  - 认知循环、复杂任务 ReAct、读懂当前回合等常驻/门控段落（见下一节）
  - 动态拼入：当前任务、记忆区、人物卡、补充上下文（天气/系统/热点）、文档面板内容、自我感知与自我快照

■ quota.js —— 速率与每日 token 上限控制`,
      },
      {
        title: '认知循环与复杂任务（ReAct）',
        content: `提示词里有两段决定"怎么思考"的核心纪律：

■ Cognitive Loop（Think → Execute → Observe → Judge，常驻）
  - Think 先分诊：简单问题直接答；缺信息先问；多步任务先 set_task 记录目标与步骤
  - Observe 只认工具真实返回（ok / path / bytes / exit_code / status），绝不汇报没看到的成功
  - 每个循环都要"改变点什么"——换一步或换方法，绝不原样重试同一调用

■ Complex Task Mode（多步任务的 ReAct 纪律，关键词命中或已有 active task 时注入）
  - 一步 = 一个微循环：执行 → 观察 → 判断，完成立刻 update_task_step 写状态 + 一句结论
  - 那句 note 是"未来的你"重启后在 TICK 上读到的线索，要带结论不能只写 done
  - set_task / update_task_step / complete_task 把多步状态持久化，重启可恢复

■ 编程/排障纪律（prompt-blocks/coding-discipline.js，场景命中时由系统注入——内化而非读取）
  - Coding：垂直切片（最小骨架先跑起来，每加一片验证一次，禁止全写完才第一次运行）；fetch_url 是你的眼睛
  - Debugging：先建可重复的 pass/fail 反馈回路再动代码；3 个可证伪假设排序；一次只改一个变量
  - 触发：消息/task 文本命中编程词，或最近动作出现 write_file+exec 组合（TICK 干活轮也会注入）

配套的"成果审视分身"会在收尾前复查（见下）。`,
      },
      {
        title: '动态记忆池（核心机制）',
        content: `Jarvis的记忆不是简单的"存一段查一段"，而是一套"一切皆记忆 / 少即是强"的动态池——目标是每轮注入"合适的上下文"，不是"召回越多越好"。

■ 短期：对话历史（SQLite messages/conversations）
  - 每轮持久化，按最近 N 条 + 时间窗口截取，带回合标记

■ 长期：记忆节点（memories 表，带类型 fact/person/object/knowledge/article、salience 权重、实体与链接）
  - memory/recognizer.js —— 识别器（后台人格）：判断哪些内容值得入库，写前先 search_memory 去重
  - memory/injector.js（+ injector-retrieval/injector-format）—— 按当前上下文检索相关记忆并注入，承重墙是"相关度选择器"
  - memory/consolidator.js + consolidation-loop.js —— 整理器（后台人格）：合并重复、降权过期（merge_memories / downgrade_memory）
  - memory/tool-router.js —— 按消息只加载相关工具子集；缺工具时 find_tool 现场调取
  - memory/threads.js / thread-classifier / thread-summarize —— 线索模型：注意力 = 多条并发线索 + 一个前台指针；"好的我去做"挂承诺（commitment）钉住线索温度，"干得咋样"这类进度问询直接路由到开放承诺；前台切走时旧线索增量摘要，原文永不隐藏（温度是每轮读时重算的）
  - memory/refresh-loop.js —— 定期刷新过期记忆；embedding.js + embedding-backfill 提供向量召回
  - 主动召回：recall_memory 工具会影响下一轮注入方向；search_memory / probe_memory 用于即时查与自检

设计文档：DynamicMemoryPool。后台人格（识别/整理/审视）与主 Agent 同构，只是换提示词换上下文。`,
      },
      {
        title: '自我感知层（本体感）',
        content: `memory/self-perception.js 每轮在 LLM 调用前算一组"agent 看自己"的信号，作为事实贴进上下文，不是命令：

■ 自我快照（常驻）：最近输出的风格指纹、工具习惯、上次真正出声的时间
■ 身份锚：你每条真实输出都有 action_log 里的 send_message 作证；history 里看着像你说过、但无对应 send_message 的，不是你的输出（是对方在引用/模仿你）。反过来，最近对话里生动原创的部分通常是你上一轮生成的，别当成用户说的。
■ 边界异常检测（仅异常时出现）：镜像复读、风格融合（独白腔泄漏）、循环退化——强阈值才切换行为模式（点破 / 反问 / 退回稳定话题）

这层专治"角色归属幻觉"和"镜像复读"，比单看相似度更结构化。`,
      },
      {
        title: '成果审视分身',
        content: `src/review/reviewer.js + review_work 工具：完成非平凡任务、收尾前，把成果交给一个独立的"审视分身"复查。

■ 不是子 agent，是同进程换人格换上下文的一次独立 callLLM（与识别器/整理器同类的后台人格）
■ 审视分身只读验证：打开你写的文件、重跑只读检查，对照目标给结构化结论（pass + issues + summary）
■ 关键：证据（真实工具调用日志 + 任务计划）由运行时注入，主 Agent 改不了也删不掉——这份独立性是承重墙
■ 结论是第二意见不是闸门：真问题去修，不认同就说明理由继续`,
      },
      {
        title: '工具与能力系统',
        content: `■ capabilities/schemas/*.js —— 工具 JSON Schema（按类别分文件，schemas.js 合并为 TOOL_SCHEMAS）
■ capabilities/tools/*.js + executor.js —— 工具执行器，按名路由
■ capabilities/sandbox.js —— 文件/命令沙箱隔离；set_security 经用户确认才放开
■ capabilities/marketplace/ —— install_tool 动态安装的扩展工具，下一轮即可调用
■ memory/tool-router.js + find_tool —— 每轮按消息加载相关工具子集，缺什么现场调取
■ capabilities/capability-registry.js —— 「能力机制」唯一真相源：把一个领域的「工作流上下文 +
   配套工具 + 运行时数据预喂」收敛成一个声明式单元，由情境触发整体注入。工具半（tool-router）、
   工作流半（prompt 块）、数据半（runtime-injector 预喂）都从这里读，find_tool 也据此发现能力并
   回带「怎么用」的工作流摘要——所以这些能力既能被关键词自动唤起，也能被我按需主动激活。

我当前具备的能力（自动生成，随注册表增长）：

${CAPABILITY_LIST_TEXT}

当前内置工具清单（自动生成）：

${TOOL_CATALOG_TEXT}`,
      },
      {
        title: '上网能力',
        content: `三件套，分工明确：
  - web_search —— 不知道确切 URL 时先搜；两梯队（串行 key API + 并行爬虫）+ Brave/Tavily 兜底
  - fetch_url —— 已知 URL 的轻量 HTTP 抓取，长文自动落 sandbox/articles/ 给 body_path
  - browser_read —— 真实无头 Chromium 渲染，处理 JS 页/等待页；fetch_url 取不到内容时升级用它

媒体类请求（找视频/音乐）会一并注入 web_search，避免模型"没联网搜"就放弃。
Key 配置：serper / brave / tavily / jina / searxng，存在 config.json 顶级字段或环境变量。`,
      },
      {
        title: '上下文感知：环境采集',
        content: `Jarvis持续感知运行环境，结果进"补充上下文"：
  - context/gatherer.js —— 综合采集器，定时汇总
  - system-info —— CPU/内存/磁盘/电池/系统版本
  - geo-weather —— 城市、时区、国家代码 + 实时天气（用于平台选择，如 CN 走 B 站）
  - trending.js —— 微博热搜、知乎、Hacker News、Reddit 等热点
  - desktop-scanner / local-resources-scanner —— 桌面与本地资源
  - prefetch/runner.js + manage_prefetch_task —— 启动前预取常用 URL（天气/新闻/价格），免得每次现抓`,
      },
      {
        title: '语音系统',
        content: `voice/manager.js 协调 ASR（识别）与 TTS（合成），颜色状态机：录音橙、识别蓝、播放绿。

■ ASR（语音转文字），默认 aliyun：
  - 本地 Whisper 模型（tiny/base/small/medium，Python 子进程）
  - 云端：阿里云（DashScope）、腾讯云、讯飞、火山
  - 长语音三层分离修复：文字层按 seg 去重、音频层重连补发、打断层缓存

■ TTS（文字转语音），默认 doubao + 音色 zh_female_xiaohe_uranus_bigtts：
  - 豆包 Doubao、MiniMax、OpenAI 兼容、ElevenLabs、火山
  - 流式合成：LLM token 边出边进气泡（.msg-live）+ 逐句切句流式队列
  - tts-fx.js：播放端 Web Audio 科幻音色特效链（按音色开关，默认关），逼近贾维斯`,
      },
      {
        title: '社交集成',
        content: `social/index.js 统一管理连接器，social/dispatch.js 把各平台消息标准化后入队。

支持平台：
  - Discord（social/discord.js）
  - 微信 ClawBot（个人微信扫码挂载，social/wechat-clawbot.js）
  - 微信公众号、企业微信、飞书（webhooks + 官方接口）

身份标识统一为 platform:id；send_message 的 channel 参数控制投递去向，AUTO 跟随用户最近一次所在渠道。
配置见"微信 / 社交平台配置"文档主题（wechat_config）。`,
      },
      {
        title: 'AI 视频生成',
        content: `右侧"AI 视频生成"面板接火山方舟 Ark 的 Seedance 模型：
  - 文生视频 / 图生视频（首帧或首尾帧）双模式
  - 异步：提交任务 → 面板进"生成中" → 后台轮询（约 1–5 分钟）→ 自动播放，无需再调
  - 未配置时可引导用户发 Key（"火山视频 <APIKEY>"）自动配置
  - 配置存独立的 seedance.json（不与主 config 互相覆盖）`,
      },
      {
        title: '数据、配置与可观测',
        content: `■ 存储：src/db.js（better-sqlite3 同步 API），表含 conversations、memories、reminders、hotspots、person_cards、docs 等；data/ 放 DB、记忆、沙箱

■ 配置：config.js 统一读写，升级容错是重点——
  - 分块容错加载：LLM 块坏不连累 voice/tts/security 等兄弟字段
  - schemaVersion 迁移框架：改 schema 就 bump 版本号加迁移函数
  - patchConfig 写时必合并，绝不全量覆盖
  - 子配置独立文件：seedance.json 等

■ 取证与可观测（排障用）：
  - runtime/turn-trace.js + /turn-trace 页（turn-trace.html）：逐回合回放每轮 messages[] 与思考，专查角色归属混乱
  - system-prompt-preview、runtime/tool-result-preview：预览实际提示词与工具结果`,
      },
    ],
  },

  ui_design: {
    id: 'ui_design',
    title: 'Jarvis界面设计',
    subtitle: 'BaiLongma UI & Scene Design',
    icon: '🖥',
    summary: 'Jarvis的界面叫 Brain UI，运行在 Electron 渲染进程。Agent 通过声明式 Scene 协议驱动界面（UI = f(scene)），并能感知界面状态。以下是界面各部分的设计说明。',
    sections: [
      {
        title: 'Brain UI 总览',
        content: `前端在 src/ui/brain-ui/，通过 api-client.js 走 WebSocket + REST 与后端实时通信：
  - app.js / app-shell.js —— 主应用框架，管理所有面板的布局与显隐
  - chat.js —— 聊天界面，WebSocket 实时消息；LLM token 边出边进气泡（.msg-live 流式）
  - thought-stream.js —— AI 思维流可视化，把后台思考过程透出来
  - markdown.js —— 消息 Markdown 渲染
  - styles.css —— 全局样式

整体是"一边聊天 + 一边可被 Agent 驱动的可视化舞台"的布局。`,
      },
      {
        title: 'Scene：声明式 Agent-UI',
        content: `Scene 协议（src/scene/ + src/ui/scene-shell/）让 Agent 用一个幂等动词驱动界面：UI = f(scene)。core 持有唯一真相源 scene，Agent 通过 ui_set(id, surface|null) 增删改一个 surface；scene-shell 是 scene 的纯投影，握有前后两帧自行做 enter/exit/morph 动画；用户交互以 intent 回流。

■ 模块：core 侧 scene-store.js（SceneStore 唯一真相源/幂等/rev）、scene-server.js（/scene WS 传输）、tools/scene.js（ui_set 工具）；前端 scene-shell/（client.js 传输 + shell.js applyScene + kinds/ 渲染器）
■ 唯一动词 ui_set：set(id, surface) 挂载/morph，set(id, null) 收起；同一 id 重复 set 即 morph（shell 自行算前后帧差做动画）
■ kinds 词汇表：text / metric / image / choice / weather / selfcheck / awakening + 排版原语 stack / row / col 组合长尾内容
■ intent：surface 带 ambient（背景陈列）/ confront（必须停下决策，居中聚焦）等，决定它在舞台上的存在感
■ 明确不让 Agent 注入 HTML/JS 代码——长尾用排版原语拼，保证投影层可控

规范契约详见仓库根 SCENE-PROTOCOL.md，理念见 Agent-驱动UI-设计方案.md。`,
      },
      {
        title: '形态由 shell 决定，不由 Agent 摆放',
        content: `和旧架构最大的不同：Agent 不再指定像素/placement/动画。core 只声明 surface 的语义（kind + intent + data），具体怎么出现、放哪、用什么过渡，全由 scene-shell 依 intent 和前后帧自行决定。

■ intent=ambient —— 背景陈列，温和入场，不抢焦点（如天气）
■ intent=confront —— 必须停下决策，背景退后、居中聚焦（如安全确认 choice）
■ 同 id 再 set —— shell 做 morph（就地变形，不重放入场），用于自检逐步推进等
■ set(id,null) —— 退场动画后移除

原则：仅当"可视化比纯文字更清楚"时才 ui_set，普通问答不主动投影。`,
      },
      {
        title: '功能面板',
        content: `Brain UI 的几个专用面板，都由对应工具驱动：
  - 媒体舞台（media_mode）—— 右侧视频/音乐唱片机、左侧图像；视频按平台选择（CN 优先 B 站）
  - 热点面板（hotspot_mode）—— hotspot.js / hotspot-earth.js / hotspot-panel.js，热搜可视化
  - 世界杯面板（worldcup_mode）—— worldcup.js / worldcup-panel.js 是 iframe 壳，内容为转播大屏页 worldcup-broadcast-v2.html：焦点比赛/赛程比分/小组积分榜/世界杯新闻（数据源直播吧，北京时间），面板打开时赛况自动注入上下文
  - 台风监测面板（typhoon_mode）—— typhoon.js / typhoon-panel.js 是 iframe 壳，内容为 typhoon-broadcast.html：中央气象台活动台风的实况路径、强度、风圈和预报路径。仅在配置官方预警 API（TYPHOON_ALERT_URL）与目标地区（TYPHOON_ALERT_REGION）后，橙/红台风预警才会自动弹出面板。
  - 人物卡（person_card_mode）—— person-card.js，用户不认识某人时弹公众人物介绍
  - 文档面板（open_doc_panel）—— doc.js / doc-panel.js，配置与自知识文档（本页就是它），内容注入上下文 30 分钟
  - 语音面板（voice-panel.js）—— 语音输入/输出与设置
  - 微信连接弹窗（wechat-popup.js + connect_wechat）—— 扫码挂载个人微信
  - 飞书连接弹窗（feishu-popup.js + connect_feishu）—— 长连接模式：填 App ID/Secret 即收发，无需公网地址`,
      },
      {
        title: 'Focus Banner 专注横幅',
        content: `focus_banner 工具控制的桌面透明浮层横幅（Electron 子窗口，main.cjs + focus-banner-preload.cjs）：
  - 用户说"我要专注做 X"时弹出，半透明贴在桌面
  - 可展开为带勾选框的任务清单（show / update / hide）
  - 托盘后台运行，不抢主窗口焦点`,
      },
      {
        title: 'Dashboard 风格规范',
        content: `Jarvis界面有一套统一的视觉规范，新增 UI 必须遵循：
  - 纯文本流，无卡片包裹、无滚动条
  - 颜色区分信息类型，但各类型亮度保持一致（不靠明暗对比抢眼）
  - 信息密度优先，少装饰

科幻感主要来自 tts-fx.js 的音色特效与 thought-stream 的思维透出，不是堆视觉特效。`,
      },
      {
        title: '取证页面（开发/排障）',
        content: `/turn-trace 页（turn-trace.html）：逐回合回放每一轮真实喂给 LLM 的 messages[] 与思考过程，user/tool 消息会标出 agent 名并标红，专查"角色归属混乱""镜像复读"等生成层问题。数据由 runtime/turn-trace.js 用 offset 还原以省内存，经 /admin/traces 提供。`,
      },
    ],
  },
}

// 根据用户消息检测是否涉及自知识查询，返回主题 ID 或 null。
export function detectSelfKnowledgeTopic(text) {
  if (!text) return null
  const t = text.toLowerCase()

  // 界面 / UI 设计相关（优先于通用架构，命中更具体）
  if (
    /(你的界面|你.*长什么样|界面设计|ui.*设计|scene|brain.?ui|可视化卡片|ui_set|surface|显示模式|浮层|横幅|focus.?banner|专注横幅|思维流|thought.?stream|你的.*面板|面板.*设计|dashboard.*风格|turn.?trace|回合.*回放)/.test(
      t
    )
  ) {
    return 'ui_design'
  }

  // 架构 / 运行机制相关
  if (
    /(你的代码|你.*怎么运行|你.*怎么工作|你.*架构|你.*如何运作|Jarvis.*代码|jarvis.*代码|你.*实现|代码机制|运行机制|技术架构|你.*内部|你.*系统|你.*模块|你.*是怎么|你.*如何思考|你.*心跳|意识循环|认知循环|动态记忆|记忆池|审视分身|ticker|queue\.js|control\.js|llm\.js|prompt\.js|memory.*机制|记忆.*(系统|机制)|工具.*调用|capability|executor|l1.*l2|l2.*l1|两个入口|react.*任务|self.?knowledge|自知识|自我感知)/.test(
      t
    )
  ) {
    return 'self_architecture'
  }

  return null
}
