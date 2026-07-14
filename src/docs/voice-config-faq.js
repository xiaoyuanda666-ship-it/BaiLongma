// 语音配置说明文档 & FAQ
// 结构：每个 topic 包含 title、sections（标题+内容）、providers（服务商列表）
// 字段名来源：src/config.js 的 VOICE_CONFIG_KEYS / TTS_CONFIG_KEYS

export const DOC_TOPICS = {
  voice_asr: {
    id: 'voice_asr',
    title: '语音识别（ASR）配置指南',
    subtitle: 'Automatic Speech Recognition',
    icon: '🎤',
    summary: '语音识别将麦克风输入实时转为文字。首选推荐阿里云百炼 Paraformer（https://bailian.console.aliyun.com/）。也支持腾讯云、科大讯飞、火山引擎和本地 Whisper。配置入口：点击左上角 ⚙ → 语音设置。',
    sections: [
      {
        title: '为什么语音识别没有内容？',
        content: `常见原因：
① 未配置 ASR 密钥 — 云端 ASR 需要对应服务商的 API Key
② 麦克风权限未授予 — 请检查浏览器或系统麦克风权限
③ 本地 Whisper 模型未加载完成 — 首次下载 small 模型约 461 MB，需等待
④ 密钥填写错误或账户欠费 — 检查控制台报错信息`,
      },
      {
        title: '模式一：阿里云百炼 Paraformer（首选推荐，延迟低）',
        content: `Jarvis首选 ASR 方案，阿里云百炼实时语音识别，中文效果出色，延迟低。

配置字段（POST /settings/voice）：
■ aliyunApiKey — 阿里云百炼的 API Key（格式：sk-xxxxxxxxxxxxxxxx）

申请步骤：
1. 打开 https://bailian.console.aliyun.com/ 注册/登录
2. 完成阿里云账号实名认证（个人/企业均可）
3. 搜索「Paraformer」或「语音识别」，开通该模型服务（按平台使用规则开通）
4. 前往 API Key 管理页面，创建新的 API Key
5. 复制 API Key，在语音设置中填写 aliyunApiKey 字段

提醒：必须先完成认证 + 开通对应模型，未开通时调用会直接报错。

文档：https://help.aliyun.com/zh/model-studio/developer-reference/paraformer-v2`,
      },
      {
        title: '模式二：腾讯云 ASR',
        content: `腾讯云实时语音识别，支持粤语、英语等多语种。

配置字段（POST /settings/voice）：
■ tencentSecretId — 腾讯云访问密钥 ID
■ tencentSecretKey — 腾讯云访问密钥 Key
■ tencentAppId — 腾讯云 ASR 应用 AppId

申请步骤：
1. 打开 https://console.cloud.tencent.com/ 注册/登录
2. 进入「语音识别」产品，开通实时语音识别
3. 在 https://console.cloud.tencent.com/cam/capi 创建访问密钥
4. 记录 SecretId 和 SecretKey（两个都需要）
5. 在腾讯云 ASR 控制台找到你的 AppId
6. 在语音设置中填写以上三个字段

文档：https://cloud.tencent.com/document/product/1093/48982`,
      },
      {
        title: '模式三：科大讯飞 RTASR',
        content: `科大讯飞实时转写，中文识别老牌服务。

配置字段（POST /settings/voice）：
■ xunfeiAppId — 讯飞开放平台应用 AppID
■ xunfeiApiKey — 应用 API Key
■ xunfeiApiSecret — 应用 API Secret

申请步骤：
1. 打开 https://www.xfyun.cn/ 注册/登录讯飞开放平台
2. 控制台 → 创建应用 → 添加「实时语音转写（RTASR）」服务
3. 在应用详情页找到 AppID、APIKey、APISecret（三个都需要）
4. 在语音设置中填写以上三个字段

文档：https://www.xfyun.cn/doc/asr/rtasr/API.html`,
      },
    ],
    providers: [
      { name: '阿里云百炼 Paraformer（首选）', url: 'https://bailian.console.aliyun.com/', free: false, note: '首选推荐，延迟低，字段：aliyunApiKey（需先认证+开通模型）' },
      { name: '腾讯云 ASR', url: 'https://console.cloud.tencent.com/asr', free: false, note: '多语种，字段：tencentSecretId/Key/AppId' },
      { name: '科大讯飞 RTASR', url: 'https://www.xfyun.cn/', free: false, note: '中文老牌，字段：xunfeiAppId/ApiKey/ApiSecret' },
    ],
  },

  voice_tts: {
    id: 'voice_tts',
    title: '语音合成（TTS）配置指南',
    subtitle: 'Text-to-Speech',
    icon: '🔊',
    summary: '语音合成将文字转为 Agent 语音输出。首选推荐豆包语音合成 2.0（https://console.volcengine.com/speech/new/）。也支持 MiniMax、OpenAI、ElevenLabs、火山引擎。配置入口：点击左上角 ⚙ → 语音设置 → TTS。',
    sections: [
      {
        title: '为什么 Agent 说话没有声音？',
        content: `常见原因：
① 未配置 TTS 密钥 — 需在语音设置中填写对应服务商的 API Key
② 密钥失效或账户欠费 — 检查服务商控制台余额和密钥状态
③ 网络问题 — TTS 请求需要访问外网
④ 未选择 TTS 服务商 — 请在语音设置的「TTS 服务商」下拉框中选择一个`,
      },
      {
        title: '豆包语音合成 2.0（首选推荐）',
        content: `Jarvis首选 TTS 方案，字节跳动豆包语音合成 2.0，中文音色丰富，流式输出，延迟低。

配置字段（POST /settings/tts）：
■ ttsProvider = "doubao"
■ doubaoKey — 豆包语音平台 API Key（推荐，格式：xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）
■ doubaoAccessKey — 火山引擎平台 Access Key（与 doubaoKey 二选一）
■ doubaoAppId — 应用 App ID（可选）
■ doubaoResourceId — 语音资源 ID（可选，留空自动根据音色判断）
■ ttsVoiceId — 音色 ID（可选，默认：zh_female_xiaohe_uranus_bigtts）

常用音色：
→ zh_female_xiaohe_uranus_bigtts（小何 2.0，女声，通用）
→ zh_male_m191_uranus_bigtts（云舟 2.0，男声，通用）
→ zh_female_shuangkuaisisi_uranus_bigtts（爽快思思 2.0，活泼）

申请步骤：
1. 打开 https://console.volcengine.com/speech/new/ 注册/登录火山引擎
2. 完成实名认证后，开通「语音合成 2.0（大模型语音合成）」服务（按平台使用规则操作）
3. 在「API Key 管理」创建 API Key，填写到 doubaoKey
4. 若需指定音色，先在控制台为应用授权对应音色，再把音色 ID 填入 ttsVoiceId

提醒：必须先完成认证 + 开通服务 + 音色授权，否则会报权限/资源错误。

控制台：https://console.volcengine.com/speech/new/
文档：https://www.volcengine.com/docs/6561/1598757`,
      },
      {
        title: 'MiniMax TTS',
        content: `MiniMax 高质量中文 TTS，音色自然，表现力强。

配置方式：
■ MiniMax TTS 使用与 LLM 相同的 API Key
■ 如果当前 LLM 服务商已设置为 MiniMax，TTS 自动使用该密钥，无需额外配置
■ 也可设置环境变量 MINIMAX_API_KEY

在语音设置中：
1. 将「TTS 服务商」选择为「MiniMax」
2. 确保 LLM 已配置 MiniMax 密钥，或设置 MINIMAX_API_KEY 环境变量

常用音色：
→ male-qn-qingse（青涩男声）
→ female-shaonv（少女）
→ presenter_female（女主播）

申请地址：https://platform.minimaxi.com/`,
      },
      {
        title: 'OpenAI TTS',
        content: `OpenAI TTS，英文效果顶级，中文也支持。

配置字段（POST /settings/tts）：
■ ttsProvider = "openai"
■ openaiTtsKey — OpenAI API Key
■ openaiTtsBaseURL — 自定义 Base URL（可选，用于代理/中转）
■ ttsVoiceId — 音色（可选）

常用音色：
→ nova（女声，自然）
→ shimmer（女声，轻柔）
→ alloy（中性）
→ echo / fable / onyx（男声）

申请步骤：
1. 打开 https://platform.openai.com/ 注册/登录
2. API Keys 页面创建新密钥
3. 填写 openaiTtsKey

文档：https://platform.openai.com/docs/guides/text-to-speech`,
      },
      {
        title: 'ElevenLabs TTS',
        content: `ElevenLabs 超自然音色，英文效果顶级。

配置字段（POST /settings/tts）：
■ ttsProvider = "elevenlabs"
■ elevenLabsKey — ElevenLabs API Key
■ ttsVoiceId — 音色 ID（可选，默认使用预设列表）

常用音色：
→ 21m00Tcm4TlvDq8ikWAM（Rachel，女声，自然）
→ pNInz6obpgDQGcFmaJgB（Adam，男声）
→ MF3mGyEYCl7XYWbV9V6O（Elli，女声，年轻）

申请步骤：
1. 打开 https://elevenlabs.io/ 注册/登录
2. Profile Settings → API Keys，创建新密钥
3. 填写 elevenLabsKey

免费版每月 10,000 字符
文档：https://docs.elevenlabs.io/api-reference/text-to-speech`,
      },
      {
        title: '火山引擎 TTS（基础版）',
        content: `火山引擎传统 TTS，区别于豆包方舟（高级版）。

配置字段（POST /settings/tts）：
■ ttsProvider = "volcano"
■ volcanoAppId — 火山引擎应用 AppID
■ volcanoToken — 火山引擎访问 Token
■ ttsVoiceId — 音色 ID（可选）

常用音色：
→ BV001_streaming（通用女声）
→ BV002_streaming（通用男声）
→ zh_female_qingxin（清心，女声）

申请步骤：
1. 打开 https://console.volcengine.com/ 注册/登录
2. 进入「语音技术」→「语音合成」开通服务
3. 在应用管理中创建应用，获取 AppID
4. 在访问控制中获取 Token
5. 填写 volcanoAppId 和 volcanoToken

文档：https://www.volcengine.com/docs/6561/79823`,
      },
    ],
    providers: [
      { name: '豆包语音合成 2.0（首选）', url: 'https://console.volcengine.com/speech/new/', free: false, note: '首选推荐，流式低延迟，字段：doubaoKey（需先认证+开通+音色授权）' },
      { name: 'MiniMax', url: 'https://platform.minimaxi.com/', free: false, note: '复用 LLM 密钥，无需额外配置' },
      { name: 'OpenAI TTS', url: 'https://platform.openai.com/', free: false, note: '英文顶级，字段：openaiTtsKey' },
      { name: 'ElevenLabs', url: 'https://elevenlabs.io/', free: true, note: '超自然音色，字段：elevenLabsKey' },
      { name: '火山引擎 TTS', url: 'https://console.volcengine.com/speech/service/8', free: false, note: '传统版，字段：volcanoAppId + volcanoToken' },
    ],
  },

  voice_config: {
    id: 'voice_config',
    title: '语音功能完整配置指南',
    subtitle: 'Voice Configuration',
    icon: '⚙️',
    summary: 'ASR（语音识别）和 TTS（语音合成）综合配置说明。配置入口：点击左上角 ⚙ → 语音设置。',
    sections: [
      {
        title: '快速开始',
        content: `语音功能分两部分：
■ ASR（语音识别）：麦克风 → 文字，让你可以说话输入
  → 配置接口：POST /settings/voice
■ TTS（语音合成）：文字 → 声音，让 Agent 开口说话
  → 配置接口：POST /settings/tts

两者独立配置，可以只开启其中一个。
配置入口：点击左上角 ⚙ → 语音设置。`,
      },
      {
        title: '推荐配置组合',
        content: `■ Jarvis首选组合（强烈推荐）：
  · 大模型：DeepSeek（官网 deepseek.com）
  · 语音识别：阿里云百炼 Paraformer（https://bailian.console.aliyun.com/，字段 aliyunApiKey）
  · 语音合成：豆包语音合成 2.0（https://console.volcengine.com/speech/new/，字段 doubaoKey）

■ 最佳英文体验：科大讯飞 ASR + OpenAI TTS（openaiTtsKey）或 ElevenLabs（elevenLabsKey）
■ 已用 MiniMax 作为 LLM：阿里云百炼 ASR + MiniMax TTS（自动复用密钥）

提醒：以上语音识别 / 语音合成服务都需要先到官网申请 API Key，并完成实名认证和服务开通后才能使用，请按平台的使用规则操作。`,
      },
      {
        title: '配置后如何测试？',
        content: `TTS 测试：
→ 在聊天框告诉我「帮我测试一下 TTS」，我会播放一段测试语音

ASR 测试：
→ 点击界面上的麦克风按钮 🎤，开始说话
→ 说话停顿后文字会自动填入输入框
→ 如果没有识别结果，检查「为什么语音识别没有内容」那一节

密钥填写后立即生效，无需重启。`,
      },
      {
        title: '完整字段速查表',
        content: `ASR 配置字段（POST /settings/voice）：
→ aliyunApiKey — 阿里云百炼 Paraformer API Key
→ tencentSecretId — 腾讯云 SecretId
→ tencentSecretKey — 腾讯云 SecretKey
→ tencentAppId — 腾讯云 ASR AppId
→ xunfeiAppId — 讯飞 AppID
→ xunfeiApiKey — 讯飞 APIKey
→ xunfeiApiSecret — 讯飞 APISecret
→ volcAsrApiKey / volcAsrAppKey / volcAsrAccessKey / volcAsrResourceId — 火山引擎 ASR（需在火山控制台开通流式语音识别后获取）

切换识别服务商：voiceProvider 字段（aliyun（默认）/ tencent / xunfei / volc / 本地 Whisper）

TTS 配置字段（POST /settings/tts）：
→ ttsProvider — 服务商（doubao/minimax/openai/elevenlabs/volcano）
→ ttsVoiceId — 音色 ID
→ doubaoKey — 豆包方舟 API Key
→ doubaoAccessKey — 火山引擎 Access Key（豆包备用）
→ doubaoAppId — 豆包 App ID（可选）
→ doubaoResourceId — 豆包语音资源 ID（可选，自动判断）
→ openaiTtsKey — OpenAI API Key
→ openaiTtsBaseURL — OpenAI 代理地址（可选）
→ elevenLabsKey — ElevenLabs API Key
→ volcanoAppId — 火山引擎基础版 AppID
→ volcanoToken — 火山引擎基础版 Token`,
      },
      {
        title: '数据隐私',
        content: `■ 本地 Whisper：所有音频在本地处理，完全私密
■ 云端 ASR/TTS：音频数据会发送到对应服务商服务器
■ API Key 仅保存在本地 config.json，不会上传到任何第三方`,
      },
    ],
    providers: [],
  },
}

// 根据用户消息内容检测应该弹出哪个主题
export function detectDocTopic(text) {
  if (!text) return null
  const t = text.toLowerCase()

  // TTS 相关：Agent 没声音、文字转语音
  if (/没有?声音|没声音|tts|文字.{0,5}(语音|声音)|(语音|声音)合成|听不到你|你.*说话|longma.*说话|agent.*说话|朗读|doubao.*key|doubaokey|minimax.*tts|openai.*tts|elevenlabs|volcanotoken|doubao.*tts/.test(t)) {
    return 'voice_tts'
  }

  // ASR 相关：麦克风输入不被识别
  if (/识别不到|没有?内容|没有?文字|(语音|声音)识别|配置.*(识别|听|麦克风)|听不到我|我说话|麦克风|mic\b|asr|paraformer|讯飞|腾讯.*(语音|声音)|aliyun.*key|xunfei|tencent.*asr/.test(t)) {
    return 'voice_asr'
  }

  // 通用语音配置
  if (/(语音|声音).*(配置|设置|怎么|如何|开启)|(配置|设置).*(语音|声音)|(语音|声音).*key|key.*(语音|声音)|语音功能/.test(t)) {
    return 'voice_config'
  }

  return null
}

// 将文档内容格式化为上下文注入字符串
export function formatDocAsContext(topicId) {
  const doc = DOC_TOPICS[topicId]
  if (!doc) return ''

  const lines = [
    `## 参考文档：${doc.title}`,
    doc.summary,
    '',
  ]

  for (const section of doc.sections) {
    lines.push(`### ${section.title}`)
    lines.push(section.content)
    lines.push('')
  }

  if (doc.providers.length > 0) {
    lines.push('### 服务商一览')
    for (const p of doc.providers) {
      lines.push(`- **${p.name}**${p.free ? '（有免费额度）' : ''}：${p.note} — ${p.url}`)
    }
  }

  return lines.join('\n')
}
