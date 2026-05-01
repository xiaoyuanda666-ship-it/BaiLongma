const createGraphStage = () => `
<div class="grid-overlay"></div>
<svg id="graph" aria-label="Longma memory graph"></svg>
`;

const createPrimaryPanel = () => `
<aside id="panel-l1" class="panel">
  <header class="panel-identity">
    <div class="brand-mark"></div>
    <div class="brand-copy">
      <div class="eyebrow">Cognitive Surface</div>
      <div class="brand-title" id="agent-brand-name">Longma AI Agent</div>
    </div>
    <button class="settings-btn" id="settings-btn" title="设置" type="button">⚙</button>
  </header>

  <div class="stream-meta">
    <div>
      <div class="stream-title-text">用户消息处理器</div>
      <!-- <div class="stream-subtitle">user message · react</div> -->
    </div>
    <span class="pill" id="pill-l1">LIVE</span>
  </div>

  <div class="legend" id="legend"></div>

  <div class="stream">
    <div class="stream-inner" id="si-l1"></div>
  </div>

  <div class="panel-actions">
    <button class="reset-view" id="reset-view-btn" type="button">重置节点图</button>

    <section class="physics-control" id="physics-control">
      <button class="physics-toggle" id="physics-toggle" type="button" aria-expanded="false">
        <span class="physics-toggle-label">Graph Tuning</span>
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
  <header class="panel-stats">
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
  </header>

  <section class="update-card" id="update-card">
    <div class="update-copy">
      <div class="update-title">桌面更新</div>
      <div class="update-status" id="update-status">未检查</div>
    </div>
    <button class="update-action" id="check-update-btn" type="button">检查更新</button>
    <button class="update-close" id="update-close-btn" type="button" aria-label="关闭">×</button>
  </section>

  <div class="stream-meta">
    <div>
      <div class="stream-title-text">自主行动机制 · Tick</div>
      <div class="stream-subtitle">心跳 · 思考 · 工具</div>
    </div>
    <span class="pill pill-warm" id="pill-l2">流式传输</span>
  </div>

  <div class="stream">
    <div class="stream-inner" id="si-l2"></div>
  </div>
</aside>
`;

const createConsole = () => `
<section class="console" id="chat-area">
  <div id="chat-history">
    <div id="chat-messages"></div>
  </div>
  <div id="input-row">
    <span class="prompt-mark">▸</span>
    <input id="msg-input" type="text" placeholder="向 Longma 发送消息…" autocomplete="off">
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

    <section class="settings-section">
      <div class="settings-section-label">当前配置</div>
      <div class="settings-config-row">
        <span class="settings-config-type">LLM</span>
        <span class="settings-config-info" id="settings-cfg-llm">—</span>
        <span class="settings-config-dot" id="settings-cfg-llm-dot"></span>
      </div>
      <div class="settings-config-row">
        <span class="settings-config-type">媒体</span>
        <span class="settings-config-info" id="settings-cfg-media">—</span>
        <span class="settings-config-dot" id="settings-cfg-media-dot"></span>
      </div>
    </section>

    <section class="settings-section">
      <div class="settings-section-label" id="settings-llm-section-label">LLM 配置</div>
      <div class="settings-row">
        <label class="settings-label" for="settings-provider-select">提供商</label>
        <select class="settings-select" id="settings-provider-select">
          <option value="deepseek">DeepSeek</option>
          <option value="minimax">MiniMax</option>
        </select>
      </div>
      <div class="settings-row">
        <label class="settings-label" for="settings-model-select">切换模型</label>
        <select class="settings-select" id="settings-model-select"></select>
      </div>
      <div class="settings-row">
        <label class="settings-label" for="settings-llm-key">API Key</label>
        <input class="settings-input" id="settings-llm-key" type="password" placeholder="留空则仅切换模型…" autocomplete="new-password">
      </div>
      <div class="settings-row-action">
        <button class="settings-save-btn" id="settings-save-llm" type="button">保存</button>
        <span class="settings-feedback" id="settings-llm-feedback"></span>
      </div>
    </section>

    <section class="settings-section">
      <div class="settings-section-label">MiniMax 媒体能力</div>
      <div class="settings-row">
        <label class="settings-label" for="settings-minimax-key">API Key</label>
        <input class="settings-input" id="settings-minimax-key" type="password" placeholder="填入 MiniMax API Key…" autocomplete="new-password">
      </div>
      <div class="settings-row-action">
        <button class="settings-save-btn" id="settings-save-minimax" type="button">保存</button>
        <span class="settings-feedback" id="settings-minimax-feedback"></span>
      </div>
    </section>
  </div>
</div>
`;

const createPanelTabs = () => `
<button id="panel-l1-tab" class="panel-tab panel-tab-left" aria-label="切换左面板" title="切换左面板 [ "></button>
<button id="panel-l2-tab" class="panel-tab panel-tab-right" aria-label="切换右面板" title="切换右面板 ] "></button>
`;

export function createBrainUiMarkup() {
  return [
    createGraphStage(),
    createPrimaryPanel(),
    createSecondaryPanel(),
    createConsole(),
    createThemeSwitcher(),
    createTooltip(),
    createSettingsModal(),
    createPanelTabs(),
  ].join("\n\n");
}

export function renderBrainUiApp(root = document.body) {
  root.dataset.theme = "midnight";
  root.innerHTML = createBrainUiMarkup();
}
