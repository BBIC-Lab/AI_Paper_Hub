# 本地 PDF 解析

<div id="dpr-local-pdf-reader" class="dpr-local-pdf-page">
  <section id="dpr-local-pdf-dropzone" class="dpr-local-pdf-dropzone">
    <input id="dpr-local-pdf-input" class="dpr-local-pdf-input" type="file" accept="application/pdf,.pdf" multiple />
    <div class="dpr-local-pdf-drop-main">
      <div class="dpr-local-pdf-drop-title">本地 PDF</div>
      <div class="dpr-local-pdf-drop-subtitle">一次选择或拖入多篇论文 PDF</div>
      <div class="dpr-local-pdf-actions">
        <button id="dpr-local-pdf-choose" class="dpr-local-pdf-primary" type="button">批量选择 PDF</button>
        <button id="dpr-local-pdf-clear" class="dpr-local-pdf-secondary" type="button">清空</button>
      </div>
    </div>
  </section>

  <div id="dpr-local-pdf-status" class="dpr-local-pdf-status" aria-live="polite"></div>

  <section class="dpr-local-pdf-result">
    <div class="dpr-local-pdf-import-head">
      <h2>已导入论文</h2>
      <p id="dpr-local-pdf-meta" class="dpr-local-pdf-meta"></p>
    </div>
    <div id="dpr-local-pdf-list" class="dpr-local-pdf-list"></div>
    <div class="dpr-local-pdf-result-actions">
      <button id="dpr-local-pdf-deep-read" class="dpr-local-pdf-primary" type="button">批量后台精读生成</button>
    </div>
    <div id="dpr-local-pdf-workflow" class="dpr-local-pdf-workflow" hidden></div>
  </section>
</div>
