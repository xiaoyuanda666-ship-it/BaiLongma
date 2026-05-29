export const createDocPanel = () => `
<div class="doc-panel" id="doc-panel">

  <!-- 顶部标题栏 -->
  <div class="dp-header">
    <div class="dp-header-left">
      <span class="dp-icon" id="dp-icon"><blm-icon name="settings"></blm-icon></span>
      <div class="dp-titles">
        <div class="dp-title" id="dp-title">配置说明</div>
        <div class="dp-subtitle" id="dp-subtitle">语音配置指南</div>
      </div>
    </div>
    <div class="dp-header-right">
      <div class="dp-tabs" id="dp-tabs">
        <button class="dp-tab" data-topic="model_config" type="button"><blm-icon name="cpu"></blm-icon> 模型</button>
        <button class="dp-tab" data-topic="voice_asr" type="button"><blm-icon name="mic"></blm-icon> 语音识别</button>
        <button class="dp-tab" data-topic="voice_tts" type="button"><blm-icon name="volume"></blm-icon> 语音合成</button>
        <button class="dp-tab" data-topic="voice_config" type="button"><blm-icon name="settings"></blm-icon> 语音配置</button>
        <button class="dp-tab" data-topic="wechat_config" type="button"><blm-icon name="message-circle"></blm-icon> 微信</button>
      </div>
      <button class="dp-close-btn" id="dp-close-btn" type="button" title="关闭文档面板">×</button>
    </div>
  </div>

  <!-- 摘要栏 -->
  <div class="dp-summary" id="dp-summary">正在加载文档...</div>

  <!-- 主体内容区 -->
  <div class="dp-body" id="dp-body">

    <!-- 左：章节导航 -->
    <div class="dp-nav" id="dp-nav">
      <!-- JS 动态填充 -->
    </div>

    <!-- 右：内容详情 -->
    <div class="dp-content" id="dp-content">
      <!-- JS 动态填充 -->
    </div>

  </div>

  <!-- 底部：服务商快速链接 -->
  <div class="dp-providers" id="dp-providers">
    <!-- JS 动态填充 -->
  </div>

  <!-- 内联配置区 -->
  <div class="dp-config" id="dp-config"></div>

  <!-- 底部状态栏 -->
  <div class="dp-footer">
    <span class="dp-footer-note" id="dp-footer-note">● 文档已注入上下文 · 可直接告诉 Agent 你遇到的问题</span>
    <span class="dp-footer-ttl" id="dp-footer-ttl">上下文有效期 30 分钟</span>
  </div>

</div>
`;
