export const createKnowledgePanel = () => `
<section class="knowledge-cortex-panel" id="knowledge-cortex-panel" aria-hidden="true" aria-label="知识脑区">
  <header class="kc-header">
    <div class="kc-title-group">
      <div class="kc-kicker"><span></span> KNOWLEDGE BASE</div>
      <h1>知识脑区</h1>
      <p id="kc-status">加载你的资料与可追溯证据</p>
    </div>
    <button class="kc-close" id="kc-close" type="button" title="关闭知识脑区" aria-label="关闭知识脑区">×</button>
  </header>
  <div class="kc-layout">
    <aside class="kc-sidebar">
      <div class="kc-pane-title"><span class="kc-pane-glyph">01</span> 知识区域 <b id="kc-region-count">0</b></div>
      <div class="kc-region-list" id="kc-region-list"></div>
    </aside>
    <main class="kc-main">
      <form class="kc-search" id="kc-search-form">
        <input id="kc-search-input" type="search" placeholder="在当前知识区域中检索文档与证据" autocomplete="off" />
        <button type="submit">检索</button>
      </form>
      <div class="kc-columns">
        <section class="kc-results-pane">
          <div class="kc-pane-title"><span class="kc-pane-glyph">02</span> 检索结果 <b id="kc-result-count">0</b></div>
          <div class="kc-result-list" id="kc-result-list"><div class="kc-empty">输入问题，查看可引用的证据片段。</div></div>
        </section>
        <section class="kc-documents-pane">
          <div class="kc-pane-title"><span class="kc-pane-glyph">03</span> 区域文档 <b id="kc-document-count">0</b></div>
          <div class="kc-document-list" id="kc-document-list"></div>
        </section>
      </div>
    </main>
    <aside class="kc-detail-pane">
      <div class="kc-pane-title"><span class="kc-pane-glyph">04</span> 文档详情</div>
      <div id="kc-detail" class="kc-detail"><div class="kc-empty">选择一份文档或检索结果以查看来源和版本。</div></div>
    </aside>
  </div>
</section>
`
