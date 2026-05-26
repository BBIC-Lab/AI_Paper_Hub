# 本地 PDF 解析

<div id="dpr-local-pdf-reader" class="dpr-local-pdf-page">
  <section id="dpr-local-pdf-dropzone" class="dpr-local-pdf-dropzone">
    <input id="dpr-local-pdf-input" class="dpr-local-pdf-input" type="file" accept="application/pdf,.pdf" />
    <div class="dpr-local-pdf-drop-main">
      <div class="dpr-local-pdf-drop-title">本地 PDF</div>
      <div class="dpr-local-pdf-drop-subtitle">选择或拖入论文文件</div>
      <div class="dpr-local-pdf-actions">
        <button id="dpr-local-pdf-choose" class="dpr-local-pdf-primary" type="button">选择 PDF</button>
        <button id="dpr-local-pdf-clear" class="dpr-local-pdf-secondary" type="button">清空</button>
      </div>
    </div>
  </section>

  <div id="dpr-local-pdf-status" class="dpr-local-pdf-status" aria-live="polite"></div>

  <section class="dpr-local-pdf-result">
    <div id="dpr-local-pdf-metrics" class="dpr-local-pdf-metrics"></div>
    <h2 id="dpr-local-pdf-title" class="dpr-local-pdf-title"></h2>
    <p id="dpr-local-pdf-meta" class="dpr-local-pdf-meta"></p>
    <div class="dpr-local-pdf-result-actions">
      <button id="dpr-local-pdf-deep-read" class="dpr-local-pdf-primary" type="button">后台精读生成</button>
    </div>
    <div id="dpr-local-pdf-workflow" class="dpr-local-pdf-workflow" hidden></div>

    <div class="dpr-local-pdf-output-grid">
      <section class="dpr-local-pdf-panel">
        <div class="dpr-local-pdf-panel-head">
          <h3>摘要</h3>
        </div>
        <div id="dpr-local-pdf-abstract" class="dpr-local-pdf-abstract"></div>
      </section>

      <section class="dpr-local-pdf-panel">
        <div class="dpr-local-pdf-panel-head">
          <h3>论文详细总结（自动生成）</h3>
        </div>
        <div id="dpr-local-pdf-deep-summary" class="dpr-local-pdf-deep-summary"></div>
      </section>
    </div>
  </section>
</div>
