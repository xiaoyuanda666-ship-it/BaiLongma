import { createHotspotPanel } from './hotspot-panel.js';
import { createWorldcupPanel } from './worldcup-panel.js';
import { createTyphoonPanel } from './typhoon-panel.js';
import { createPersonCardPanel } from './person-card-panel.js';
import { createDocPanel } from './doc-panel.js';

const createAppTitlebar = () => `
<header class="app-titlebar" aria-label="Window drag area"></header>
`;

const createGraphStage = () => `
<div class="grid-overlay"></div>
<svg id="graph" aria-label="Longma 记忆节点图"></svg>
`;

const createPrimaryPanel = () => `
<aside id="panel-l1" class="panel">
  <header class="panel-identity">
    <div class="brand-mark"></div>
    <div class="brand-copy">
      <div class="eyebrow">认知界面</div>
      <div class="brand-title" id="agent-brand-name">Longma AI Agent</div>
    </div>
    <button class="voice-btn" id="voice-btn" title="麦克风 开/关" type="button">🎤</button>
    <button class="video-btn" id="video-btn" title="视频模式 (V)" type="button" hidden>⊞</button>
    <button class="music-btn" id="music-btn" title="音乐模式 (M)" type="button" hidden>♪</button>
    <button class="settings-btn" id="settings-btn" title="设置" type="button">⚙</button>
  </header>

  <div class="stream-meta">
    <div>
      <div class="stream-title-text">用户消息处理器</div>
      <!-- <div class="stream-subtitle">user message · react</div> -->
    </div>
    <span class="pill" id="pill-l1">实时</span>
  </div>

  <!-- AI 当前正在做什么：纯派生展示，从 tool_call 事件流自动归类，AI 不需要做任何额外动作。
       北极星：通信问题靠界面侧派生可视化解决，不逼 AI 学人开口。 -->
  <div class="ai-activity" id="ai-activity">
    <span class="ai-activity-dot" id="ai-activity-dot"></span>
    <span class="ai-activity-label" id="ai-activity-label">空闲</span>
    <span class="ai-activity-detail" id="ai-activity-detail"></span>
  </div>

  ${createVoicePanel()}

  <div class="legend" id="legend"></div>

  <div class="stream">
    <div class="stream-inner" id="si-l1"></div>
  </div>

  <div class="panel-actions">
    <button class="reset-view" id="reset-view-btn" type="button">重置节点图</button>

    <section class="physics-control" id="physics-control">
      <button class="physics-toggle" id="physics-toggle" type="button" aria-expanded="false">
        <span class="physics-toggle-label">图谱调节</span>
        <span class="physics-toggle-icon">▾</span>
      </button>
      <div class="physics-panel" id="physics-panel">
        <div class="physics-panel-inner">
          <div class="physics-field">
            <div class="physics-field-head">
              <label class="physics-field-label" for="gravity-slider">引力</label>
              <span class="physics-field-value" id="gravity-value">1.00x</span>
            </div>
            <input class="physics-slider" id="gravity-slider" type="range" min="0" max="5" step="0.02" value="2">
          </div>
          <div class="physics-field">
            <div class="physics-field-head">
              <label class="physics-field-label" for="repulsion-slider">斥力</label>
              <span class="physics-field-value" id="repulsion-value">1.00x</span>
            </div>
            <input class="physics-slider" id="repulsion-slider" type="range" min="0" max="5" step="0.02" value="2">
          </div>
          <div class="physics-field">
            <div class="physics-field-head">
              <label class="physics-field-label" for="node-size-slider">节点大小</label>
              <span class="physics-field-value" id="node-size-value">1.00x</span>
            </div>
            <input class="physics-slider" id="node-size-slider" type="range" min="0" max="5" step="0.02" value="2">
          </div>
        </div>
      </div>
    </section>
  </div>
</aside>
`;

const createSecondaryPanel = () => `
<aside id="panel-l2" class="panel">
  <!-- 专注帧 UI 已隐藏（后端 focus stack 仍在工作，给 LLM 注入上下文）。
       要恢复观察面板时把对应 HTML 还原即可——app.js 渲染逻辑保留着，靠 getElementById 返回 null 自动 no-op。 -->

  <div class="l2-dashboard">
    <section class="l2-module heartbeat-monitor" aria-labelledby="heartbeat-monitor-title">
      <header class="panel-stats heartbeat-stats">
        <div class="stat">
          <span class="stat-label">状态</span>
          <div class="stat-value live" id="conn-state"><span class="live-dot"></span>Token流</div>
        </div>
        <div class="stat">
          <span class="stat-label">节点</span>
          <div class="stat-value" id="node-count">0</div>
        </div>
        <div class="stat">
          <span class="stat-label">连线</span>
          <div class="stat-value" id="link-count">0</div>
        </div>
        <div class="stat">
          <span class="stat-label">tok/s</span>
          <div class="stat-value" id="tok-rate">—</div>
        </div>
        <div class="stat" id="mem-recall-stat" title="近 1 小时记忆召回次数 / 平均拉取条数。点击查看明细">
          <span class="stat-label">召回/h</span>
          <div class="stat-value" id="mem-recall-rate">—</div>
        </div>
        <div class="stat" id="mem-extract-stat" title="近 1 小时记忆抽取次数 / 平均写入条数。点击查看明细">
          <span class="stat-label">抽取/h</span>
          <div class="stat-value" id="mem-extract-rate">—</div>
        </div>
      </header>
      <div class="l2-module-head">
        <div>
          <div class="l2-module-kicker">HEARTBEAT</div>
          <h2 class="l2-module-title" id="heartbeat-monitor-title">意识心跳</h2>
        </div>
        <span class="heartbeat-state" id="heartbeat-state" data-state="waiting">
          <span class="heartbeat-state-dot"></span>
          <span id="heartbeat-state-label">等待连接</span>
        </span>
      </div>
      <div class="heartbeat-chart" id="heartbeat-chart" role="img" aria-label="意识心跳实时波形">
        <svg viewBox="0 0 320 72" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="heartbeat-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--warm)" stop-opacity="0.24"></stop>
              <stop offset="100%" stop-color="var(--warm)" stop-opacity="0"></stop>
            </linearGradient>
          </defs>
          <path class="heartbeat-gridline" d="M0 36 H320"></path>
          <path class="heartbeat-area" id="heartbeat-area"></path>
          <path class="heartbeat-wave" id="heartbeat-wave"></path>
        </svg>
        <span class="heartbeat-sweep" aria-hidden="true"></span>
      </div>
      <div class="heartbeat-facts">
        <span><b id="heartbeat-count">0</b> 次心跳</span>
        <span id="heartbeat-last">等待首次 Tick</span>
      </div>
    </section>

    <section class="l2-module action-log-module" aria-labelledby="action-log-title">
      <div class="l2-module-head compact">
        <div>
          <div class="l2-module-kicker">ACTION LOG</div>
          <h2 class="l2-module-title" id="action-log-title">行动日志</h2>
        </div>
      </div>
      <div class="action-log" id="action-log" aria-live="polite">
        <div class="action-log-empty" id="action-log-empty">Agent 最近执行的文件、命令和工具动作会显示在这里</div>
      </div>
    </section>

    <section class="l2-module cognition-module" aria-labelledby="cognition-title">
      <div class="l2-module-head compact cognition-head">
        <div>
          <div class="l2-module-kicker">LIVE COGNITION</div>
          <h2 class="l2-module-title" id="cognition-title">思考与工具</h2>
        </div>
        <div class="cognition-state-group">
          <span class="l3-state" id="l3-state" data-state="idle">L3 待命</span>
          <span class="cognition-state" id="cognition-state" data-state="idle">空闲</span>
        </div>
      </div>
      <div class="stream cognition-stream">
        <div class="stream-inner" id="si-l2">
          <div class="cognition-empty" id="cognition-empty">心跳触发后，这里会实时显示思考与工具调用</div>
        </div>
      </div>
    </section>
  </div>
</aside>
`;

const createConsole = () => `
<section class="console" id="chat-area">
  <div class="compact-voice-strip" id="compact-voice-strip" aria-live="polite">
    <span class="compact-voice-indicator" aria-hidden="true"></span>
    <span class="compact-voice-label">语音识别</span>
    <span class="compact-voice-transcript" id="compact-voice-transcript">按住空格键开始说话</span>
  </div>
  <div id="chat-history">
    <div id="chat-messages"></div>
  </div>
  <div id="paste-attachments" class="paste-attachments" hidden></div>
  <div id="input-row">
    <div id="slash-menu" class="slash-menu" role="listbox" aria-label="命令" hidden></div>
    <span class="prompt-mark">▸</span>
    <textarea id="msg-input" rows="1" placeholder="向 Longma 发送消息…（输入 / 调出命令，Shift+Enter 换行）" autocomplete="off"></textarea>
    <button id="send-btn" type="button">发送</button>
  </div>
</section>
`;

const createThemeSwitcher = () => `
<div class="theme-switcher" id="theme-switcher">
  <div class="theme-dot active" data-t="midnight" title="Midnight Steel"></div>
  <div class="theme-dot" data-t="phosphor" title="Phosphor CRT"></div>
  <div class="theme-dot" data-t="violet" title="Violet Lab"></div>
  <div class="theme-dot" data-t="rose" title="Rose Dusk"></div>
  <div class="theme-dot" data-t="arctic" title="Arctic"></div>
  <div class="theme-dot" data-t="sand" title="Warm Sand"></div>
</div>
`;

const createTooltip = () => `
<div id="tip"></div>
`;

const createSettingsModal = () => `
<div class="settings-overlay" id="settings-overlay" hidden>
  <div class="settings-modal" role="dialog" aria-modal="true" aria-label="设置">
    <div class="settings-header">
      <span class="settings-title">设置</span>
      <button class="settings-close" id="settings-close" type="button" aria-label="关闭">×</button>
    </div>
    <div class="settings-body">

      <!-- 侧栏导航 -->
      <nav class="settings-nav">
        <button class="settings-nav-item active" data-tab="appearance" type="button">外观</button>
        <button class="settings-nav-item" data-tab="llm" type="button">LLM 模型</button>
        <button class="settings-nav-item" data-tab="media" type="button">媒体能力</button>
        <button class="settings-nav-item" data-tab="social" type="button">社交媒体</button>
        <button class="settings-nav-item" data-tab="voice" type="button">语音对话</button>
        <button class="settings-nav-item" data-tab="web-search" type="button">上网搜索</button>
        <button class="settings-nav-item" data-tab="security" type="button">安全沙箱</button>
        <button class="settings-nav-item" data-tab="advanced" type="button">高级功能</button>
        <button class="settings-nav-item" data-tab="update" type="button">更新</button>
      </nav>

      <!-- 内容区 -->
      <div class="settings-content">

        <!-- ── 外观 tab ── -->
        <div class="settings-tab active" data-tab="appearance">
          <div class="settings-section">
            <div class="settings-section-label">主题</div>
            ${createThemeSwitcher()}
          </div>
          <div class="settings-section">
            <div class="settings-section-label">AI 名字</div>
            <div class="settings-row">
              <label class="settings-label" for="settings-agent-name">显示名</label>
              <input class="settings-input" id="settings-agent-name" type="text" maxlength="32" autocomplete="off" spellcheck="false" placeholder="小白龙">
            </div>
            <div class="settings-row-action">
              <button class="settings-save-btn" id="settings-save-agent-name" type="button">保存</button>
              <span class="settings-feedback" id="settings-agent-name-feedback"></span>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">记忆节点图</div>
            <p class="settings-hint">开启后在背景显示记忆节点力导向图，会占用额外 CPU/GPU 资源，低配设备建议关闭。修改后需刷新页面生效。</p>
            <div class="settings-row">
              <label class="settings-label" for="settings-memory-graph-toggle">显示记忆节点图</label>
              <input id="settings-memory-graph-toggle" type="checkbox" style="width:auto;flex:none;">
              <span class="settings-feedback" id="settings-memory-graph-feedback" style="margin-left:8px;"></span>
            </div>
          </div>
        </div>

        <!-- ── LLM 模型 tab ── -->
        <div class="settings-tab" data-tab="llm">
          <div class="settings-section">
            <div class="settings-section-label">当前状态</div>
            <div class="settings-config-row">
              <span class="settings-config-type">LLM</span>
              <span class="settings-config-info" id="settings-cfg-llm">—</span>
              <span class="settings-config-dot" id="settings-cfg-llm-dot"></span>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">切换配置</div>
            <div class="settings-row">
              <label class="settings-label" for="settings-provider-select">提供商</label>
              <select class="settings-select" id="settings-provider-select">
                <option value="auto">自动识别</option>
                <option value="deepseek">DeepSeek</option>
                <option value="minimax">MiniMax</option>
                <option value="mimo">小米 MiMo</option>
                <option value="custom">自定义端点（本地/其他）</option>
              </select>
            </div>
            <div class="settings-row" id="settings-model-row">
              <label class="settings-label" for="settings-model-select">模型</label>
              <select class="settings-select" id="settings-model-select"></select>
            </div>
            <div class="settings-row" id="settings-official-custom-model-row" style="display:none;">
              <label class="settings-label" for="settings-official-custom-model">自定义模型名</label>
              <input class="settings-input" id="settings-official-custom-model" type="text" placeholder="如 kimi-k2.8, gpt-5.2, glm-6" autocomplete="off" spellcheck="false">
            </div>
            <!-- 自定义端点字段（选择"自定义端点"时显示） -->
            <div id="settings-custom-llm-section" style="display:none;">
              <div class="settings-row">
                <label class="settings-label" for="settings-custom-baseurl">Base URL</label>
                <input class="settings-input" id="settings-custom-baseurl" type="text" placeholder="如 http://localhost:11434/v1">
              </div>
              <div class="settings-row">
                <label class="settings-label" for="settings-custom-model">模型名称</label>
                <input class="settings-input" id="settings-custom-model" type="text" placeholder="如 llama3.2, qwen2.5, mistral">
              </div>
            </div>
            <div class="settings-row">
              <label class="settings-label" for="settings-llm-key">API Key</label>
              <div class="settings-secret-wrap">
                <input class="settings-input" id="settings-llm-key" type="password" placeholder="已保存的 Key 会在这里显示" autocomplete="new-password">
                <button class="settings-secret-toggle" id="settings-llm-key-toggle" type="button" aria-label="显示 API Key" title="显示/隐藏 API Key">👁</button>
              </div>
            </div>
            <div class="settings-row-action">
              <button class="settings-save-btn" id="settings-save-llm" type="button">保存</button>
              <span class="settings-feedback" id="settings-llm-feedback"></span>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">模型温度</div>
            <p class="settings-hint">控制回复的随机性。0 = 确定性最高，1 = 正常创意，1.5 = 更随机。推荐 0.3–0.7。</p>
            <div class="settings-row">
              <label class="settings-label" for="settings-temperature">Temperature</label>
              <input type="range" id="settings-temperature" min="0" max="1.5" step="0.05" value="0.5" style="flex:1;cursor:pointer;">
              <span id="settings-temperature-val" style="min-width:2.8em;text-align:right;color:var(--ink2);font-size:13px;">0.50</span>
            </div>
            <div class="settings-row-action">
              <button class="settings-save-btn" id="settings-save-temperature" type="button">保存</button>
              <span class="settings-feedback" id="settings-temperature-feedback"></span>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">思考模式</div>
            <p class="settings-hint">默认关闭：直接作答，响应更快、更省 token。开启后模型会先推理再回答，复杂任务更可靠（具体想多深由模型自己决定），但响应更慢。遇到难题想要更高质量时再开启。</p>
            <div class="settings-row">
              <label class="settings-label" for="settings-thinking">启用思考模式</label>
              <label class="settings-toggle">
                <input type="checkbox" id="settings-thinking">
                <span class="settings-toggle-track"></span>
              </label>
              <span class="settings-feedback" id="settings-thinking-feedback"></span>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">上下文消息条数</div>
            <p class="settings-hint">分别控制普通对话和 Tick 对话每轮注入的最近消息数量。范围 1–40 条，默认均为 10 条，修改后下一轮生效。</p>
            <div class="settings-row">
              <label class="settings-label" for="settings-conversation-context-limit">普通对话</label>
              <input class="settings-range" type="range" id="settings-conversation-context-limit" min="1" max="40" step="1" value="10">
              <span class="settings-range-value" id="settings-conversation-context-limit-val">10 条</span>
            </div>
            <div class="settings-row">
              <label class="settings-label" for="settings-tick-context-limit">Tick 对话</label>
              <input class="settings-range" type="range" id="settings-tick-context-limit" min="1" max="40" step="1" value="10">
              <span class="settings-range-value" id="settings-tick-context-limit-val">10 条</span>
            </div>
            <div class="settings-row-action">
              <button class="settings-save-btn" id="settings-save-context-window" type="button">保存</button>
              <span class="settings-feedback" id="settings-context-window-feedback"></span>
            </div>
          </div>
        </div>

        <!-- ── 媒体能力 tab ── -->
        <div class="settings-tab" data-tab="media">
          <div class="settings-section">
            <div class="settings-section-label">当前状态</div>
            <div class="settings-config-row">
              <span class="settings-config-type">媒体</span>
              <span class="settings-config-info" id="settings-cfg-media">—</span>
              <span class="settings-config-dot" id="settings-cfg-media-dot"></span>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">MiniMax API Key</div>
            <div class="settings-row">
              <label class="settings-label" for="settings-minimax-key">API Key</label>
              <input class="settings-input" id="settings-minimax-key" type="password" placeholder="填入 MiniMax API Key…" autocomplete="new-password">
            </div>
            <div class="settings-row-action">
              <button class="settings-save-btn" id="settings-save-minimax" type="button">保存</button>
              <span class="settings-feedback" id="settings-minimax-feedback"></span>
            </div>
          </div>
        </div>

        <!-- ── 社交媒体 tab ── -->
        <div class="settings-tab" data-tab="social">
          <div class="settings-section">
            <div class="settings-section-label">Discord</div>
            <div class="settings-platform-status" id="social-status-discord"></div>
            <div class="settings-row">
              <label class="settings-label" for="social-discord-token">Bot Token</label>
              <input class="settings-input" id="social-discord-token" type="password" placeholder="留空保持原值不变…" autocomplete="new-password">
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">飞书</div>
            <div class="settings-platform-status" id="social-status-feishu"></div>
            <div class="settings-row">
              <label class="settings-label" for="social-feishu-appid">App ID</label>
              <input class="settings-input" id="social-feishu-appid" type="password" placeholder="留空保持原值…" autocomplete="new-password">
            </div>
            <div class="settings-row">
              <label class="settings-label" for="social-feishu-secret">App Secret</label>
              <input class="settings-input" id="social-feishu-secret" type="password" placeholder="留空保持原值…" autocomplete="new-password">
            </div>
            <div class="settings-row">
              <label class="settings-label" for="social-feishu-token">Verify Token</label>
              <input class="settings-input" id="social-feishu-token" type="password" placeholder="留空保持原值…" autocomplete="new-password">
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">微信公众号</div>
            <div class="settings-platform-status" id="social-status-wechat"></div>
            <div class="settings-row">
              <label class="settings-label" for="social-wechat-appid">App ID</label>
              <input class="settings-input" id="social-wechat-appid" type="password" placeholder="留空保持原值…" autocomplete="new-password">
            </div>
            <div class="settings-row">
              <label class="settings-label" for="social-wechat-secret">App Secret</label>
              <input class="settings-input" id="social-wechat-secret" type="password" placeholder="留空保持原值…" autocomplete="new-password">
            </div>
            <div class="settings-row">
              <label class="settings-label" for="social-wechat-token">Token</label>
              <input class="settings-input" id="social-wechat-token" type="password" placeholder="留空保持原值…" autocomplete="new-password">
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">企业微信</div>
            <div class="settings-platform-status" id="social-status-wecom"></div>
            <div class="settings-row">
              <label class="settings-label" for="social-wecom-botkey">Bot Key</label>
              <input class="settings-input" id="social-wecom-botkey" type="password" placeholder="留空保持原值…" autocomplete="new-password">
            </div>
            <div class="settings-row">
              <label class="settings-label" for="social-wecom-token">Incoming Token</label>
              <input class="settings-input" id="social-wecom-token" type="password" placeholder="留空保持原值…" autocomplete="new-password">
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">微信 ClawBot（个人微信）</div>
            <div class="settings-platform-status" id="social-status-clawbot">○ 未连接</div>
            <p class="settings-hint">点击「连接微信」后会生成二维码，用微信扫码即可绑定个人账号。凭证保存在本地，重启后无需重新扫码。</p>
            <div class="settings-row" style="gap:8px;flex-wrap:wrap;">
              <button class="settings-save-btn" id="clawbot-connect-btn" type="button" style="width:auto;padding:0 16px;">连接微信</button>
              <button class="settings-save-btn" id="clawbot-logout-btn" type="button" style="width:auto;padding:0 16px;background:var(--danger,#c0392b);">断开</button>
            </div>
            <div id="clawbot-qr-area" style="display:none;margin-top:12px;text-align:center;">
              <p class="settings-hint" style="margin-bottom:8px;">用微信扫描下方二维码：</p>
              <img id="clawbot-qr-img" src="" alt="微信二维码" style="width:200px;height:200px;border:1px solid var(--border);border-radius:4px;">
              <p class="settings-hint" style="margin-top:6px;font-size:11px;" id="clawbot-qr-hint">等待扫码…</p>
            </div>
            <span class="settings-feedback" id="clawbot-feedback"></span>
          </div>
          <div class="settings-section settings-section-action">
            <button class="settings-save-btn" id="settings-save-social" type="button">保存所有</button>
            <span class="settings-feedback" id="settings-social-feedback"></span>
          </div>
        </div>

        <!-- ── 语音 tab ── -->
        <div class="settings-tab" data-tab="voice">
          <div class="settings-section">
            <div class="settings-section-label">语音识别配置</div>
            <div class="settings-row">
              <label class="settings-label" for="voice-auto-key">粘贴 Key 自动识别厂商</label>
              <input class="settings-input" type="password" id="voice-auto-key" placeholder="阿里云 / 腾讯云 / 讯飞 / 火山豆包 ASR Key">
              <span id="voice-auto-detect" style="color:var(--cool);font-size:12px;min-width:86px;text-align:right;"></span>
            </div>
            <div class="settings-row">
              <label class="settings-label" for="voice-provider-select">服务商</label>
              <select class="settings-select" id="voice-provider-select">
                <option value="local">本机识别（macOS）</option>
                <option value="aliyun">阿里云百炼（推荐）</option>
                <option value="volcengine">火山引擎豆包 ASR</option>
                <option value="tencent">腾讯云 ASR</option>
                <option value="xunfei">科大讯飞 RTASR</option>
              </select>
            </div>
            <div id="voice-cred-aliyun">
              <div class="settings-row">
                <label class="settings-label" for="voice-aliyun-key">阿里云 API Key</label>
                <input class="settings-input" type="password" id="voice-aliyun-key" placeholder="留空则不修改">
              </div>
            </div>
            <div id="voice-cred-tencent" style="display:none;">
              <div class="settings-row">
                <label class="settings-label" for="voice-tencent-sid">SecretId</label>
                <input class="settings-input" type="password" id="voice-tencent-sid" placeholder="留空则不修改">
              </div>
              <div class="settings-row">
                <label class="settings-label" for="voice-tencent-skey">SecretKey</label>
                <input class="settings-input" type="password" id="voice-tencent-skey" placeholder="留空则不修改">
              </div>
              <div class="settings-row">
                <label class="settings-label" for="voice-tencent-appid">AppId</label>
                <input class="settings-input" type="text" id="voice-tencent-appid" placeholder="腾讯云 AppId">
              </div>
            </div>
            <div id="voice-cred-volcengine" style="display:none;">
              <div class="settings-row">
                <label class="settings-label" for="voice-volc-apikey">API Key</label>
                <div class="settings-secret-wrap">
                  <input class="settings-input" type="password" id="voice-volc-apikey" placeholder="输入后自动保存" autocomplete="new-password">
                  <button class="settings-secret-toggle" id="voice-volc-apikey-toggle" type="button" aria-label="显示 API Key" title="显示/隐藏 API Key">👁</button>
                </div>
              </div>
            </div>
            <div id="voice-cred-xunfei" style="display:none;">
              <div class="settings-row">
                <label class="settings-label" for="voice-xunfei-appid">AppId</label>
                <input class="settings-input" type="text" id="voice-xunfei-appid" placeholder="讯飞 AppId">
              </div>
              <div class="settings-row">
                <label class="settings-label" for="voice-xunfei-apikey">ApiKey</label>
                <input class="settings-input" type="password" id="voice-xunfei-apikey" placeholder="留空则不修改">
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="settings-section-label">语音识别灵敏度</div>
            <p class="settings-hint">调节麦克风触发阈值。越低越灵敏，越高越需要大声说话。默认 0.008。</p>
            <div class="settings-row">
              <label class="settings-label" for="settings-voice-threshold">触发阈值</label>
              <input type="range" id="settings-voice-threshold" min="0.002" max="0.04" step="0.001" value="0.008" style="flex:1;cursor:pointer;">
              <span id="settings-voice-threshold-val" style="min-width:3.5em;text-align:right;color:var(--ink2);font-size:13px;">0.008</span>
            </div>
          </div>

          <div class="settings-section" id="settings-tts-section">
            <div class="settings-section-label">语音合成（TTS）</div>
            <p class="settings-hint">用语音发消息时，Agent 回复会自动转为语音播放。首选推荐豆包语音合成 2.0（https://console.volcengine.com/speech/new/），也支持 MiniMax、OpenAI、ElevenLabs、火山引擎。</p>
            <div class="settings-row">
              <label class="settings-label" for="tts-provider-select">服务商</label>
              <select class="settings-select" id="tts-provider-select">
                <option value="doubao">豆包（方舟，流式，中文最自然）</option>
                <option value="openai">OpenAI TTS（流式，$0.015/千字）</option>
                <option value="elevenlabs">ElevenLabs（流式，高质量）</option>
                <option value="volcano">火山引擎（中文，有免费额度）</option>
                <option value="minimax">MiniMax（已有配置）</option>
              </select>
            </div>
            <div class="settings-row">
              <label class="settings-label" for="tts-voice-select">声音</label>
              <select class="settings-select" id="tts-voice-select"></select>
            </div>
            <div class="settings-row">
              <label class="settings-label" for="tts-streaming-toggle">流式合成</label>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--ink2);">
                <input type="checkbox" id="tts-streaming-toggle" />
                边合成边播放，回复更快出声（默认开）
              </label>
            </div>
            <div class="settings-row">
              <label class="settings-label" for="tts-fx-toggle">机器人音效</label>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--ink2);">
                <input type="checkbox" id="tts-fx-toggle" />
                给当前声音叠加混响 / 机械质感（默认关）
              </label>
            </div>
            <div id="tts-fx-lock" style="display:none;flex-direction:column;align-items:stretch;gap:6px;padding:8px 0 4px;">
              <p class="settings-hint" style="margin:0;color:#e0a64d;">机器人音效需要付费，这是维持这个项目动力，请联系作者索要密码</p>
              <div style="display:flex;gap:8px;align-items:center;">
                <input class="settings-input" type="text" id="tts-fx-pw" placeholder="输入密码解锁" style="flex:1;">
                <button class="settings-save-btn" id="tts-fx-unlock" type="button" style="padding:4px 14px;font-size:12px;">解锁</button>
              </div>
              <span id="tts-fx-unlock-msg" style="font-size:11px;color:var(--ink2);"></span>
            </div>
            <div id="tts-fx-sliders" style="display:none;flex-direction:column;gap:7px;padding:8px 0 4px;">
              <div class="tts-fx-srow"><label for="tts-fx-wet">混响</label><input type="range" id="tts-fx-wet" min="0" max="2" step="0.01"><span id="tts-fx-wet-val"></span></div>
              <div class="tts-fx-srow"><label for="tts-fx-reverbSeconds">混响长度</label><input type="range" id="tts-fx-reverbSeconds" min="0.2" max="3.5" step="0.1"><span id="tts-fx-reverbSeconds-val"></span></div>
              <div class="tts-fx-srow"><label for="tts-fx-driveMix">失真 / 重量</label><input type="range" id="tts-fx-driveMix" min="0" max="2" step="0.01"><span id="tts-fx-driveMix-val"></span></div>
              <div class="tts-fx-srow"><label for="tts-fx-metallic">金属感</label><input type="range" id="tts-fx-metallic" min="0" max="2" step="0.01"><span id="tts-fx-metallic-val"></span></div>
              <div class="tts-fx-srow"><label for="tts-fx-ring">机器人感</label><input type="range" id="tts-fx-ring" min="0" max="2" step="0.01"><span id="tts-fx-ring-val"></span></div>
              <div class="tts-fx-srow"><label for="tts-fx-chorus">合成厚度</label><input type="range" id="tts-fx-chorus" min="0" max="2" step="0.01"><span id="tts-fx-chorus-val"></span></div>
              <div class="tts-fx-srow"><label for="tts-fx-metallicFeedback">金属共振</label><input type="range" id="tts-fx-metallicFeedback" min="0" max="0.92" step="0.01"><span id="tts-fx-metallicFeedback-val"></span></div>
              <div class="tts-fx-srow"><label for="tts-fx-metallicDelayMs">金属音调</label><input type="range" id="tts-fx-metallicDelayMs" min="2" max="20" step="0.5"><span id="tts-fx-metallicDelayMs-val"></span></div>
              <div class="tts-fx-srow"><label for="tts-fx-ringHz">机器人音调</label><input type="range" id="tts-fx-ringHz" min="30" max="600" step="5"><span id="tts-fx-ringHz-val"></span></div>
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span class="settings-hint" style="margin:0;">拖动即时生效，下次播放 / 试听可听到</span>
                <button class="settings-save-btn" id="tts-fx-reset" type="button" style="padding:3px 10px;font-size:12px;">恢复默认</button>
              </div>
            </div>

            <div id="tts-creds-doubao" style="display:none;">
              <div class="settings-row">
                <label class="settings-label" for="tts-doubao-key">API Key</label>
                <div class="settings-secret-wrap">
                  <input class="settings-input" type="password" id="tts-doubao-key" placeholder="已保存的 Key 会在这里显示" autocomplete="new-password">
                  <button class="settings-secret-toggle" id="tts-doubao-key-toggle" type="button" aria-label="显示 API Key" title="显示/隐藏 API Key">👁</button>
                </div>
              </div>
              <div class="settings-row">
                <label class="settings-label" for="tts-doubao-resource">Resource ID</label>
                <input class="settings-input" type="text" id="tts-doubao-resource" placeholder="自动匹配，或填 seed-tts-2.0 / seed-tts-1.0">
              </div>
              <div class="tts-fx-srow" style="margin-bottom:8px;">
                <label for="tts-doubao-rate">语速</label>
                <input type="range" id="tts-doubao-rate" min="-50" max="100" step="5">
                <span id="tts-doubao-rate-val"></span>
              </div>
              <p class="settings-hint">在<a href="https://console.volcengine.com/speech/new/" target="_blank" style="color:var(--cool)">豆包语音合成控制台</a>获取 API Key。2.0 音色使用 seed-tts-2.0；1.0/moon/BV 音色使用 seed-tts-1.0 或控制台对应资源。</p>
            </div>

            <div id="tts-creds-minimax" style="display:none;">
              <div class="settings-row">
                <label class="settings-label" for="tts-minimax-key">MiniMax API Key</label>
                <input class="settings-input" type="password" id="tts-minimax-key" placeholder="留空则不修改（可与 LLM 共用）">
              </div>
              <p class="settings-hint">可用声音：male-qn-qingse · male-qn-jingying · female-shaonv · female-yujie · presenter_female 等。</p>
            </div>

            <div id="tts-creds-openai">
              <div class="settings-row">
                <label class="settings-label" for="tts-openai-key">OpenAI API Key</label>
                <input class="settings-input" type="password" id="tts-openai-key" placeholder="留空则不修改（可与 LLM 共用）">
              </div>
              <div class="settings-row">
                <label class="settings-label" for="tts-openai-baseurl">Base URL（选填）</label>
                <input class="settings-input" type="text" id="tts-openai-baseurl" placeholder="自定义端点，如 https://api.deepseek.com">
              </div>
              <p class="settings-hint">可用声音：nova · shimmer · alloy · echo · fable · onyx</p>
            </div>

            <div id="tts-creds-elevenlabs" style="display:none;">
              <div class="settings-row">
                <label class="settings-label" for="tts-elevenlabs-key">ElevenLabs API Key</label>
                <input class="settings-input" type="password" id="tts-elevenlabs-key" placeholder="留空则不修改">
              </div>
              <p class="settings-hint">免费套餐每月 10,000 字符。声音 ID 在 ElevenLabs 控制台获取。</p>
            </div>

            <div id="tts-creds-volcano" style="display:none;">
              <div class="settings-row">
                <label class="settings-label" for="tts-volcano-appid">AppId</label>
                <input class="settings-input" type="text" id="tts-volcano-appid" placeholder="火山引擎 TTS AppId">
              </div>
              <div class="settings-row">
                <label class="settings-label" for="tts-volcano-token">Access Token</label>
                <input class="settings-input" type="password" id="tts-volcano-token" placeholder="留空则不修改">
              </div>
              <p class="settings-hint">可用声音：BV001_streaming（通用女声）· BV002_streaming（通用男声）等，在火山引擎控制台查看全部。</p>
            </div>

            <div class="settings-row" style="margin-top:8px;">
              <button class="settings-save-btn" id="tts-test-btn" type="button" style="padding:4px 12px;font-size:12px;">试听</button>
              <span id="tts-test-status" style="color:var(--ink2);font-size:12px;margin-left:8px;"></span>
            </div>
          </div>

          <div class="settings-section">
            <div class="settings-section-label">设备设置</div>
            <div class="settings-row">
              <label class="settings-label" for="voice-lang-select">识别语言</label>
              <select class="settings-select" id="voice-lang-select">
                <option value="zh-CN">中文（普通话）</option>
                <option value="en-US">English (US)</option>
              </select>
            </div>
            <div class="settings-row">
              <label class="settings-label" for="voice-mic-select">麦克风</label>
              <select class="settings-select" id="voice-mic-select">
                <option value="">系统默认麦克风</option>
              </select>
              <button class="settings-save-btn" id="voice-refresh-mics" type="button" style="padding:0 10px;">刷新</button>
            </div>
            <p class="settings-hint" id="voice-mic-status" style="margin-top:-2px;">更换麦克风后，重新开启语音对话生效。</p>
            <div class="settings-row">
              <label class="settings-label" for="voice-output-select">输出设备</label>
              <select class="settings-select" id="voice-output-select">
                <option value="">自动（跟随系统，避开虚拟设备）</option>
              </select>
              <button class="settings-save-btn" id="voice-refresh-outputs" type="button" style="padding:0 10px;">刷新</button>
            </div>
            <p class="settings-hint" id="voice-output-status" style="margin-top:-2px;">语音从这里发声。默认自动选择；拔耳机会自动切回扬声器，不会被串流/虚拟声卡占用。</p>
            <div class="settings-row">
              <label class="settings-label" for="voice-auto-send">识别后自动发送</label>
              <input id="voice-auto-send" type="checkbox" checked style="width:auto;flex:none;">
            </div>
            <div class="settings-row">
              <label class="settings-label" for="voice-auto-mic">启动时自动开启麦克风</label>
              <input id="voice-auto-mic" type="checkbox" style="width:auto;flex:none;">
            </div>
          </div>

          <div class="settings-section settings-section-action">
            <button class="settings-save-btn" id="settings-save-voice" type="button">保存</button>
            <span class="settings-feedback" id="settings-voice-feedback"></span>
          </div>
        </div>

        <!-- ── 上网搜索 tab ── -->
        <div class="settings-tab" data-tab="web-search">
          <div class="settings-section">
            <div class="settings-section-label">搜索引擎</div>
            <p class="settings-hint">Agent 调用 web_search 时分两梯队：第一梯队（带 key 的 API：Serper → Brave → Tavily → SearXNG）按优先级尝试；都没结果时，第二梯队（Bing / Jina / DuckDuckGo，无需配置）并行兜底。配任意一个 key 都能显著提升质量和稳定性，多配几个可避免单一额度用尽时搜索失败。</p>

            <div class="settings-row">
              <label class="settings-label" for="websearch-serper-key">Serper API Key</label>
              <input class="settings-input" type="password" id="websearch-serper-key" placeholder="留空则不修改">
            </div>
            <p class="settings-hint">在 <a href="https://serper.dev" target="_blank" style="color:var(--cool)">serper.dev</a> 注册后获取（每月 2500 次免费）。Google SERP JSON 接口，最稳定。</p>

            <div class="settings-row">
              <label class="settings-label" for="websearch-brave-key">Brave API Key</label>
              <input class="settings-input" type="password" id="websearch-brave-key" placeholder="留空则不修改">
            </div>
            <p class="settings-hint">在 <a href="https://brave.com/search/api" target="_blank" style="color:var(--cool)">brave.com/search/api</a> 获取（每月 2000 次免费）。独立索引，Serper 的可靠兜底。</p>

            <div class="settings-row">
              <label class="settings-label" for="websearch-tavily-key">Tavily API Key</label>
              <input class="settings-input" type="password" id="websearch-tavily-key" placeholder="留空则不修改">
            </div>
            <p class="settings-hint">在 <a href="https://tavily.com" target="_blank" style="color:var(--cool)">tavily.com</a> 获取（每月 1000 次免费）。面向 LLM 的搜索接口。</p>

            <div class="settings-row">
              <label class="settings-label" for="websearch-jina-key">Jina API Key</label>
              <input class="settings-input" type="password" id="websearch-jina-key" placeholder="留空则不修改">
            </div>
            <p class="settings-hint">在 <a href="https://jina.ai" target="_blank" style="color:var(--cool)">jina.ai</a> 获取（有免费额度）。s.jina.ai 搜索接口，第二梯队兜底之一。</p>

            <div class="settings-row">
              <label class="settings-label" for="websearch-searxng-url">SearXNG URL</label>
              <input class="settings-input" type="text" id="websearch-searxng-url" placeholder="https://your-searxng-instance.com">
            </div>
            <p class="settings-hint">选填。自托管 SearXNG 实例地址（去隐私的元搜索引擎）。要带 http:// 或 https://。</p>
          </div>

          <div class="settings-section">
            <div class="settings-section-label">当前状态</div>
            <div class="settings-config-row">
              <span class="settings-config-type">Serper</span>
              <span class="settings-config-info" id="websearch-status-serper">—</span>
            </div>
            <div class="settings-config-row">
              <span class="settings-config-type">Brave</span>
              <span class="settings-config-info" id="websearch-status-brave">—</span>
            </div>
            <div class="settings-config-row">
              <span class="settings-config-type">Tavily</span>
              <span class="settings-config-info" id="websearch-status-tavily">—</span>
            </div>
            <div class="settings-config-row">
              <span class="settings-config-type">Jina</span>
              <span class="settings-config-info" id="websearch-status-jina">—</span>
            </div>
            <div class="settings-config-row">
              <span class="settings-config-type">SearXNG</span>
              <span class="settings-config-info" id="websearch-status-searxng">—</span>
            </div>
          </div>

          <div class="settings-section settings-section-action">
            <button class="settings-save-btn" id="settings-save-web-search" type="button">保存</button>
            <span class="settings-feedback" id="settings-web-search-feedback"></span>
          </div>
        </div>

        <!-- ── 安全沙箱 tab ── -->
        <div class="settings-tab" data-tab="security">
          <div class="settings-section">
            <div class="settings-section-label">文件沙箱</div>
            <p class="settings-hint">开启后文件读写只允许在 sandbox/ 目录内。关闭后 Agent 可操作系统任意位置的文件，请谨慎使用。</p>
            <div class="settings-row">
              <label class="settings-label" for="security-file-sandbox">启用文件沙箱</label>
              <label class="settings-toggle">
                <input type="checkbox" id="security-file-sandbox" checked>
                <span class="settings-toggle-track"></span>
              </label>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">命令执行沙箱</div>
            <p class="settings-hint">开启后 exec_command 工作目录锁定在 sandbox/，且禁止使用绝对路径和父目录引用。关闭后命令可访问系统任意目录。</p>
            <div class="settings-row">
              <label class="settings-label" for="security-exec-sandbox">启用执行沙箱</label>
              <label class="settings-toggle">
                <input type="checkbox" id="security-exec-sandbox" checked>
                <span class="settings-toggle-track"></span>
              </label>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">局域网访问</div>
            <p class="settings-hint">允许同一局域网内的设备访问本机白龙马 API，用于多台白龙马互相通信。开启或关闭后需要重启应用生效。</p>
            <div class="settings-row">
              <label class="settings-label" for="security-lan-access">允许局域网访问</label>
              <label class="settings-toggle">
                <input type="checkbox" id="security-lan-access">
                <span class="settings-toggle-track"></span>
              </label>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">工具黑名单</div>
            <p class="settings-hint">勾选后该工具将被拒绝执行，对话中 Agent 调用时会收到"已被安全策略禁用"错误。</p>
            <div class="settings-row"><label class="settings-label"><input type="checkbox" class="security-blocked-tool" value="exec_command"> exec_command &nbsp;<span style="color:var(--ink2);font-size:12px;">（执行 shell 命令）</span></label></div>
            <div class="settings-row"><label class="settings-label"><input type="checkbox" class="security-blocked-tool" value="web_read"> web_read &nbsp;<span style="color:var(--ink2);font-size:12px;">（HTTP / Playwright 网页读取）</span></label></div>
            <div class="settings-row"><label class="settings-label"><input type="checkbox" class="security-blocked-tool" value="web_search"> web_search &nbsp;<span style="color:var(--ink2);font-size:12px;">（网页搜索）</span></label></div>
            <div class="settings-row"><label class="settings-label"><input type="checkbox" class="security-blocked-tool" value="ui_set"> ui_set &nbsp;<span style="color:var(--ink2);font-size:12px;">（投影声明式界面 surface）</span></label></div>
          </div>
          <div class="settings-section settings-section-action">
            <button class="settings-save-btn" id="settings-save-security" type="button">保存</button>
            <button class="settings-save-btn hidden" id="settings-restart-security" type="button" style="width:auto;padding:0 14px;">立即重启</button>
            <span class="settings-feedback" id="settings-security-feedback"></span>
          </div>
        </div>

        <!-- ── 高级功能 tab ── -->
        <div class="settings-tab" data-tab="advanced">
          <div class="settings-section">
            <div class="settings-section-label">心跳</div>
            <p class="settings-hint">控制小白龙是否按固定节奏自主思考。关闭后不会再自动触发 L2 心跳，但用户消息和定时提醒仍会正常处理。</p>
            <div class="settings-row">
              <label class="settings-label" for="settings-heartbeat-enabled">启用心跳</label>
              <label class="settings-toggle">
                <input type="checkbox" id="settings-heartbeat-enabled">
                <span class="settings-toggle-track"></span>
              </label>
            </div>
            <div class="settings-row">
              <label class="settings-label" for="settings-heartbeat-interval">默认间隔</label>
              <input class="settings-input" id="settings-heartbeat-interval" type="number" min="1" max="1440" step="1" inputmode="numeric" value="20">
              <span class="settings-value">分钟</span>
            </div>
            <p class="settings-hint">可设置 1–1440 分钟，默认 20 分钟。任务、初次觉醒以及 Agent 临时调整的节奏可能使用更短间隔。</p>
            <div class="settings-row-action">
              <button class="settings-save-btn" id="settings-save-heartbeat" type="button">保存心跳设置</button>
              <span class="settings-feedback" id="settings-heartbeat-feedback"></span>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">地图服务</div>
            <p class="settings-hint">为台风监测、位置、行程等功能提供统一真实地图。凭证仅保存在本机加密存储中，不会写入项目源码或返回安全密钥明文。</p>
            <div class="settings-config-row">
              <span class="settings-config-type">状态</span>
              <span class="settings-config-info" id="settings-map-status">正在检查…</span>
              <span class="settings-config-dot" id="settings-map-status-dot"></span>
            </div>
            <div class="settings-row">
              <label class="settings-label" for="settings-map-provider">地图服务商</label>
              <select class="settings-select" id="settings-map-provider">
                <option value="amap">高德地图 JS API 2.0</option>
              </select>
            </div>
            <div class="settings-row">
              <label class="settings-label" for="settings-amap-key">Web 端 Key</label>
              <input class="settings-input" id="settings-amap-key" type="password" placeholder="留空保持现有 Key 不变" autocomplete="new-password" spellcheck="false">
            </div>
            <div class="settings-row">
              <label class="settings-label" for="settings-amap-security">安全密钥</label>
              <input class="settings-input" id="settings-amap-security" type="password" placeholder="securityJsCode，留空保持不变" autocomplete="new-password" spellcheck="false">
            </div>
            <p class="settings-hint">请在高德开放平台创建“Web端（JS API）”Key。安全密钥只在本地代理请求中使用，地图页面无法读取其明文。</p>
            <div class="settings-row-action" style="gap:8px;flex-wrap:wrap;">
              <button class="settings-save-btn" id="settings-save-map" type="button">保存地图配置</button>
              <button class="settings-save-btn" id="settings-clear-map" type="button" style="width:auto;padding:0 14px;background:transparent;border:1px solid var(--line);color:var(--ink2);">清除</button>
              <a href="https://console.amap.com/dev/key/app" target="_blank" rel="noreferrer" class="settings-map-link">申请高德 Key ↗</a>
              <span class="settings-feedback" id="settings-map-feedback"></span>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">共用范围</div>
            <p class="settings-hint">配置一次后，台风监测、天气灾害、位置卡片和后续地图页面都会通过统一 MapService 使用同一地图服务。</p>
          </div>
        </div>

        <!-- ── 更新 tab ── -->
        <div class="settings-tab" data-tab="update">
          <div class="settings-section">
            <div class="settings-section-label">版本信息</div>
            <div class="settings-config-row">
              <span class="settings-config-type">当前版本</span>
              <span class="settings-config-info" id="settings-current-version">—</span>
            </div>
            <div class="settings-config-row">
              <span class="settings-config-type">状态</span>
              <span class="settings-config-info" id="settings-update-status">未检查</span>
            </div>
            <div class="settings-row-action" style="margin-top:12px;gap:8px;flex-wrap:wrap;">
              <button class="settings-save-btn" id="settings-check-update-btn" type="button" style="width:auto;padding:0 14px;">检查更新</button>
              <button class="settings-save-btn hidden" id="settings-download-update-btn" type="button" style="width:auto;padding:0 14px;">立即下载</button>
              <button class="settings-save-btn hidden" id="settings-install-update-btn" type="button" style="width:auto;padding:0 14px;">立即重启安装</button>
              <button class="settings-save-btn hidden" id="settings-ignore-update-btn" type="button" style="width:auto;padding:0 14px;background:transparent;border:1px solid var(--line);color:var(--ink2);">忽略此版本</button>
              <span class="settings-feedback" id="settings-update-feedback"></span>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-section-label">通知偏好</div>
            <div class="settings-row">
              <label class="settings-label" for="settings-suppress-updates">不再提醒更新</label>
              <label class="settings-toggle">
                <input type="checkbox" id="settings-suppress-updates">
                <span class="settings-toggle-track"></span>
              </label>
            </div>
            <p class="settings-hint">开启后发现新版本时不会弹出提示卡片，仍可在此处手动检查。</p>
          </div>
          <div class="settings-section" id="settings-ignored-section" style="display:none;">
            <div class="settings-section-label">已忽略的版本</div>
            <div class="settings-row">
              <span class="settings-config-info" id="settings-ignored-version-val">—</span>
              <button class="settings-save-btn" id="settings-clear-ignored-btn" type="button" style="width:auto;padding:0 12px;margin-left:auto;">清除忽略</button>
            </div>
          </div>
        </div>

      </div><!-- /settings-content -->
    </div><!-- /settings-body -->
  </div>
</div>
`;

const createVoicePanel = () => `
<div class="voice-panel" id="voice-panel">
  <div class="voice-canvas-card">
    <canvas id="voice-canvas" width="160" height="160"></canvas>
  </div>
  <div class="voice-transcript" id="voice-transcript"></div>
</div>
`;

const createVideoPanel = () => `
<div class="video-panel" id="video-panel">
  <div class="media-stage-head">
    <div class="media-stage-title" id="video-title">视频</div>
    <button class="video-exit-btn" id="video-exit-btn" type="button" title="关闭视频">x</button>
  </div>
  <div class="video-surface" id="video-surface">
    <div class="video-backdrop" id="video-backdrop"></div>
    <video id="video-feed" playsinline controls></video>
    <iframe id="video-frame" title="视频播放器" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen hidden></iframe>
    <div class="video-empty" id="video-empty">无视频源</div>
  </div>
</div>
`;

const createAIVideoPanel = () => `
<div class="aivideo-panel" id="aivideo-panel">
  <div class="media-stage-head">
    <div class="media-stage-title">AI 视频生成</div>
    <div class="aivideo-head-spacer"></div>
    <button class="aivideo-new-btn" id="aivideo-new-btn" type="button" title="清空输入">+ 新视频</button>
    <button class="aivideo-exit-btn" id="aivideo-exit-btn" type="button" title="关闭 (Esc)">×</button>
  </div>

  <!-- 区1 生成栏 -->
  <div class="aivideo-queue-wrap">
    <div class="aivideo-queue-cap">生成栏 · QUEUE</div>
    <div class="aivideo-queue" id="aivideo-queue"></div>
  </div>

  <!-- 区2 播放区 -->
  <div class="aivideo-player">
    <div class="aivideo-stage is-empty" id="aivideo-stage">
      <video id="aivideo-feed" class="aivideo-feed" playsinline controls hidden></video>
      <button class="aivideo-dl" id="aivideo-dl" type="button" hidden>↓ 下载</button>
      <div class="aivideo-stage-empty" id="aivideo-stage-empty">
        <svg class="aivideo-empty-icon" viewBox="0 0 48 48" fill="none" aria-hidden="true">
          <rect x="6" y="9" width="36" height="30" rx="4" stroke="currentColor" stroke-width="2"/>
          <circle cx="16.5" cy="19" r="3.5" stroke="currentColor" stroke-width="2"/>
          <path d="M9 33l9-9 7 7 6-5 8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div class="aivideo-empty-text">暂无资源</div>
        <div class="aivideo-empty-sub">在下方输入提示词或加图，点“生成”</div>
      </div>
    </div>
    <div class="aivideo-player-meta" id="aivideo-player-meta"></div>
  </div>

  <!-- 区3 输入区 -->
  <div class="aivideo-composer">
    <div class="aivideo-dropzone" id="aivideo-dropzone"></div>
    <div class="aivideo-modebar">
      <span class="aivideo-modetag" id="aivideo-modetag">文生视频</span>
      <span class="aivideo-modehint" id="aivideo-modehint">不加图 = 文生视频 · 1 张 = 图生视频 · 2 张 = 首尾帧</span>
    </div>
    <textarea id="aivideo-prompt-input" class="aivideo-prompt-input" rows="1"
      placeholder="描述你想要的画面、动作、镜头运动、光线、风格…（Ctrl+Enter 生成）"></textarea>
    <div class="aivideo-controls">
      <select id="aivideo-ratio" title="画面比例">
        <option value="adaptive">适配图片</option>
        <option value="16:9" selected>16:9</option><option value="9:16">9:16</option><option value="1:1">1:1</option>
        <option value="4:3">4:3</option><option value="3:4">3:4</option><option value="21:9">21:9</option>
      </select>
      <select id="aivideo-resolution" title="分辨率">
        <option value="480p">480p</option><option value="720p" selected>720p</option><option value="1080p">1080p</option>
      </select>
      <select id="aivideo-duration" title="时长（秒）">
        <option value="5" selected>5s</option><option value="10">10s</option><option value="15">15s</option>
      </select>
      <button type="button" class="aivideo-submit" id="aivideo-submit">生成</button>
    </div>
    <div class="aivideo-compose-err" id="aivideo-compose-err" hidden></div>
  </div>

  <input type="file" id="aivideo-file-input" accept="image/*" hidden>
</div>
`;

const createMusicPanel = () => `
<div class="music-panel" id="music-panel">
  <div class="media-stage-head">
    <div class="media-stage-title" id="music-panel-title">音乐</div>
    <button class="music-exit-btn" id="music-exit-btn" type="button" title="退出音乐模式">×</button>
  </div>
  <div class="music-stage">
    <div class="music-turntable">
      <div class="music-vinyl" id="music-vinyl">
        <div class="music-groove music-groove-1"></div>
        <div class="music-groove music-groove-2"></div>
        <div class="music-groove music-groove-3"></div>
        <div class="music-groove music-groove-4"></div>
        <div class="music-cover" id="music-cover">
          <div class="music-cover-title" id="music-cover-title">♪</div>
          <div class="music-cover-artist" id="music-cover-artist"></div>
        </div>
        <div class="music-spindle"></div>
      </div>
      <div class="music-tonearm-group" id="music-tonearm-group">
        <div class="music-tonearm-pivot"></div>
        <div class="music-arm-shaft"></div>
        <div class="music-headshell">
          <div class="music-stylus"></div>
        </div>
      </div>
    </div>
    <div class="music-lyrics-pane" id="music-lyrics-pane">
      <div class="music-lyrics-scroll" id="music-lyrics-scroll"></div>
      <div class="music-no-lyrics" id="music-no-lyrics" hidden>— 无歌词 —</div>
    </div>
  </div>
  <div class="music-footer">
    <div class="music-meta">
      <div class="music-meta-title" id="music-meta-title">—</div>
      <div class="music-meta-artist" id="music-meta-artist">—</div>
    </div>
    <div class="music-progress-row">
      <span class="music-time" id="music-time-cur">0:00</span>
      <input class="music-seek" id="music-seek" type="range" min="0" max="100" step="0.1" value="0">
      <span class="music-time" id="music-time-total">0:00</span>
    </div>
    <div class="music-controls-row">
      <button class="music-ctrl" id="music-prev" type="button" title="上一首">⏮</button>
      <button class="music-ctrl music-ctrl-play" id="music-play" type="button" title="播放/暂停">▶</button>
      <button class="music-ctrl" id="music-next" type="button" title="下一首">⏭</button>
      <input class="music-vol" id="music-vol" type="range" min="0" max="1" step="0.01" value="0.8" title="音量">
    </div>
  </div>
  <audio id="music-audio" preload="auto"></audio>
</div>
`;

const createImagePanel = () => `
<div class="image-panel" id="image-panel">
  <div class="media-stage-head">
    <div class="media-stage-title" id="image-title">图片</div>
    <button class="image-exit-btn" id="image-exit-btn" type="button" title="关闭图片">x</button>
  </div>
  <div class="image-surface" id="image-surface">
    <img id="image-display" alt="" />
    <div class="image-empty" id="image-empty">无图片源</div>
  </div>
</div>
`;

const createPanelTabs = () => `
<button id="panel-l1-tab" class="panel-tab panel-tab-left" aria-label="切换左面板" title="切换左面板 [ "></button>
<button id="panel-l2-tab" class="panel-tab panel-tab-right" aria-label="切换右面板" title="切换右面板 ] "></button>
`;

export function createBrainUiMarkup() {
  const viewportMarkup = [
    createGraphStage(),
    createPrimaryPanel(),
    createSecondaryPanel(),
    createConsole(),
    createTooltip(),
    createSettingsModal(),
    createVideoPanel(),
    createAIVideoPanel(),
    createMusicPanel(),
    createImagePanel(),
    createHotspotPanel(),
    createWorldcupPanel(),
    createTyphoonPanel(),
    createPersonCardPanel(),
    createDocPanel(),
  ].join("\n\n");

  return `${createAppTitlebar()}\n\n<main class="app-viewport">${viewportMarkup}</main>`;
}

export function renderBrainUiApp(root = document.body) {
  root.dataset.theme = "midnight";
  root.innerHTML = createBrainUiMarkup();
}
