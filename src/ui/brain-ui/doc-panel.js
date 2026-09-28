export const createDocPanel = () => `
<aside class="doc-panel" id="doc-panel" aria-label="白龙马使用说明" aria-hidden="true" inert>
  <header class="dp-header">
    <div class="dp-header-left">
      <span class="dp-icon" id="dp-icon">◈</span>
      <div class="dp-titles">
        <div class="dp-eyebrow">BAILONGMA / HANDBOOK</div>
        <div class="dp-title" id="dp-title">使用说明</div>
        <div class="dp-subtitle" id="dp-subtitle">从这里，开始得心应手</div>
      </div>
    </div>
    <button class="dp-close-btn" id="dp-close-btn" type="button" aria-label="关闭使用说明" title="关闭使用说明（Esc）">×</button>
  </header>
  <nav class="dp-tabs" id="dp-tabs" aria-label="说明主题"></nav>
  <div class="dp-summary" id="dp-summary">正在加载使用说明…</div>
  <div class="dp-body" id="dp-body">
    <nav class="dp-nav" id="dp-nav" aria-label="章节目录"></nav>
    <article class="dp-content" id="dp-content" aria-live="polite"></article>
  </div>
  <div class="dp-providers" id="dp-providers"></div>
  <footer class="dp-footer">
    <span class="dp-footer-note" id="dp-footer-note">使用说明 · 配置请前往程序「设置」</span>
    <span class="dp-footer-ttl" id="dp-footer-ttl">Esc 关闭</span>
  </footer>
</aside>
`;
