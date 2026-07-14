// 模型配置 & 微信/社交平台配置文档
// 模型总览一节由 auto-catalog.js 从 config.js 的 PROVIDER_CONFIG 自动生成，杜绝随版本漂移。

import { buildModelCatalogText } from './auto-catalog.js'

// 模块加载时生成一次模型清单文本（纯数据派生，无副作用）。
const MODEL_CATALOG_TEXT = buildModelCatalogText()

export const CONFIG_TOPICS = {
  model_config: {
    id: 'model_config',
    title: '模型配置指南',
    subtitle: 'LLM Provider Configuration',
    icon: '🤖',
    summary: '配置 AI 大模型服务商及 API Key。首选推荐 DeepSeek（官网 deepseek.com）。同时支持 MiniMax、通义千问、Moonshot、智谱、OpenAI、小米 MiMo 及自定义端点。',
    sections: [
      {
        title: '支持的服务商总览',
        content: `当前支持以下 LLM 服务商：

${MODEL_CATALOG_TEXT}

MiniMax 一个 Key 同时供 LLM 与 TTS 两用。`,
      },
      {
        title: 'DeepSeek 配置（首选推荐）',
        content: `Jarvis首选大模型，国产高性能、性价比出色、中文效果好。

■ 官网：https://deepseek.com
■ 字段：apiKey（格式：sk-xxxxxxxx）
■ 默认模型：deepseek-v4-pro

申请步骤：
1. 打开官网 https://deepseek.com 注册/登录
2. 进入开放平台 https://platform.deepseek.com/ →「API Keys」→ 创建新 Key
3. 复制 Key，在模型设置中填写
4. 注意：需先完成实名认证并开通 API 服务，按平台使用规则充值/领取额度

文档：https://platform.deepseek.com/api-docs`,
      },
      {
        title: 'MiniMax 配置',
        content: `MiniMax 同时提供 LLM 和 TTS 语音合成，一个 Key 两用。

■ 字段：apiKey（格式：eyJhbGc...）
■ 默认模型：MiniMax-M2.7

申请步骤：
1. 打开 https://platform.minimaxi.com/ 注册/登录
2. 进入「接口密钥」→ 创建新 Key
3. 复制 Key，在模型设置中填写（TTS 会自动复用）

文档：https://platform.minimaxi.com/document/guides/introduction`,
      },
      {
        title: '通义千问（Qwen）配置',
        content: `阿里云通义千问，与语音识别同平台（阿里云百炼），可共用账号。

■ 字段：apiKey（格式：sk-xxxxxxxx，百炼平台的 API Key）
■ 默认模型：qwen-turbo

申请步骤：
1. 打开 https://bailian.console.aliyun.com/ 注册/登录
2. 进入「API-KEY」管理 → 创建新 Key
3. 复制 Key，在模型设置中填写

文档：https://help.aliyun.com/zh/model-studio/`,
      },
      {
        title: 'Moonshot / 智谱 / OpenAI 配置',
        content: `■ Moonshot（月之暗面 Kimi）
→ 申请：https://platform.moonshot.cn/
→ 字段：apiKey（格式：sk-xxxxxxxx）
→ 默认模型：moonshot-v1-8k

■ 智谱 AI（GLM）
→ 申请：https://open.bigmodel.cn/
→ 字段：apiKey
→ 默认模型：glm-5.1

■ OpenAI
→ 申请：https://platform.openai.com/api-keys
→ 字段：apiKey（格式：sk-...）
→ 默认模型：gpt-4o-mini`,
      },
      {
        title: '小米 MiMo 配置',
        content: `小米 MiMo 大模型平台，OpenAI 兼容接口。

■ 官网：https://platform.xiaomimimo.com
■ 字段：apiKey（在 MiMo 控制台「API Keys」生成）
■ 默认模型：mimo-v2.5-pro（极速版 MiMo-V2.5-Pro-UltraSpeed 可在模型列表中手动选用，非默认）
■ 降级策略：默认模型不可用时自动尝试其它 MiMo 模型
■ Base URL：https://api.xiaomimimo.com/v1（系统已内置）

申请步骤：
1. 打开 https://platform.xiaomimimo.com 注册/登录
2. 进入「API Keys」→ 创建新 Key
3. 复制 Key，在模型设置中填写（或直接发给 Agent 自动配置）

文档：https://platform.xiaomimimo.com/docs/zh-CN/welcome`,
      },
      {
        title: '自定义端点配置',
        content: `兼容 OpenAI 格式的任意服务（本地 Ollama、中转代理等）。

配置字段：
■ baseURL — 服务地址（如 http://localhost:11434/v1）
■ model — 模型名称（如 llama3.2）
■ apiKey — 认证 Key（无认证填 none 即可）

常见用途：
→ 本地 Ollama：baseURL = http://localhost:11434/v1，apiKey = none
→ OpenAI 代理：baseURL = https://your-proxy.com/v1，apiKey = sk-xxx`,
      },
    ],
    providers: [
      { name: 'DeepSeek（首选）', url: 'https://deepseek.com', free: false, note: '官网 deepseek.com，API 平台 platform.deepseek.com，deepseek-v4-flash/pro' },
      { name: 'MiniMax', url: 'https://platform.minimaxi.com/', free: false, note: 'MiniMax-M2.7，兼顾 TTS' },
      { name: '通义千问', url: 'https://bailian.console.aliyun.com/', free: false, note: 'qwen-turbo/plus' },
      { name: 'Moonshot', url: 'https://platform.moonshot.cn/', free: false, note: 'moonshot-v1-8k/32k' },
      { name: '智谱 AI', url: 'https://open.bigmodel.cn/', free: false, note: 'glm-5.1（默认）、glm-5-turbo、glm-5' },
      { name: '小米 MiMo', url: 'https://platform.xiaomimimo.com/', free: false, note: 'mimo-v2.5-pro（默认，失败自动降级）、mimo-v2.5、MiMo-V2.5-Pro-UltraSpeed（极速版，可选）' },
    ],
  },

  wechat_config: {
    id: 'wechat_config',
    title: '微信 / 社交平台配置',
    subtitle: 'WeChat & Social Platform Setup',
    icon: '💬',
    summary: '接入微信公众号、企业微信机器人、微信 ClawBot、飞书机器人或 Discord Bot，让 Agent 在社交平台上响应消息。',
    sections: [
      {
        title: '平台总览',
        content: `目前支持以下社交平台（配置入口：⚙ → 社交平台设置）：

■ 微信公众号（官方消息接口）— APP_ID + APP_SECRET + TOKEN
■ 企业微信机器人（Webhook）— BOT_KEY
■ 微信 ClawBot（扫码挂载个人微信）— accountId + botToken
■ 飞书机器人（Webhook）— APP_ID + APP_SECRET + VERIFICATION_TOKEN
■ Discord Bot — BOT_TOKEN

配置完成后 Agent 即可在对应平台收发消息。`,
      },
      {
        title: '微信公众号配置',
        content: `接入微信公众号，Agent 能回复公众号粉丝消息。

配置字段：
■ WECHAT_OFFICIAL_APP_ID — 公众号 AppID
■ WECHAT_OFFICIAL_APP_SECRET — 公众号 AppSecret
■ WECHAT_OFFICIAL_TOKEN — 消息校验 Token（自定义字符串）

申请步骤：
1. 打开 https://mp.weixin.qq.com/ 登录公众平台
2. 设置与开发 → 基本配置 → 获取 AppID 和 AppSecret
3. 设置与开发 → 基本配置 → 服务器配置，填写回调 URL 和 Token
4. 回调 URL 格式：http://你的IP:端口/social/wechat-official

文档：https://developers.weixin.qq.com/doc/offiaccount/`,
      },
      {
        title: '企业微信机器人',
        content: `企业微信群机器人，Agent 可发消息到群聊。

配置字段：
■ WECOM_BOT_KEY — 机器人 Webhook Key
■ WECOM_INCOMING_TOKEN — 接收消息 Token（可选）

申请步骤：
1. 在企业微信群里，右键 → 添加群机器人 → 新建机器人
2. 复制机器人的 Webhook 地址中的 key= 后的部分
3. 在社交平台设置中填写 WECOM_BOT_KEY

文档：https://developer.work.weixin.qq.com/document/path/91770`,
      },
      {
        title: '微信 ClawBot（个人微信）',
        content: `通过 ClawBot 挂载个人微信号，Agent 可与微信好友/群聊互动。

配置字段（扫码后自动写入，无需手动填写）：
■ accountId — ClawBot 账号 ID
■ botToken — 机器人访问 Token
■ baseUrl — ClawBot 服务地址

使用方法：
1. 在聊天界面点击「连接微信」按钮
2. 用手机微信扫描二维码登录
3. 登录成功后自动配置，无需手动填写

注意：个人微信号存在被限制的风险，建议使用小号。`,
      },
      {
        title: '飞书 / Discord 配置',
        content: `■ 飞书机器人（推荐长连接模式）
→ 配置字段：FEISHU_APP_ID + FEISHU_APP_SECRET
→ 申请：https://open.feishu.cn/ → 创建应用 → 添加「机器人」能力 → 权限里加 im:message
→ 长连接模式无需公网回调地址：填好 App ID/Secret 即自动建立 WebSocket 收发消息
→ 事件订阅里选「使用长连接接收事件」，订阅 im.message.receive_v1，不要开启加密推送
→ 国际版 Lark 改用 FEISHU_DOMAIN=lark
（旧的 webhook 模式仍兼容：配 FEISHU_VERIFICATION_TOKEN + 回调 URL http://你的IP:端口/social/feishu/webhook，但桌面端无公网地址，建议用长连接）

■ Discord Bot
→ 配置字段：DISCORD_BOT_TOKEN
→ 申请：https://discord.com/developers/applications → 创建 Application → Bot → 复制 Token
→ 需要开启 Message Content Intent 权限`,
      },
    ],
    providers: [
      { name: '微信公众平台', url: 'https://mp.weixin.qq.com/', free: false, note: '公众号接口' },
      { name: '企业微信', url: 'https://work.weixin.qq.com/', free: true, note: '群机器人 Webhook' },
      { name: '飞书开放平台', url: 'https://open.feishu.cn/', free: true, note: '飞书机器人' },
      { name: 'Discord 开发者', url: 'https://discord.com/developers/applications', free: true, note: 'Discord Bot' },
    ],
  },
}
