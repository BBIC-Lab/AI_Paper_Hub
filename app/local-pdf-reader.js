(function () {
  const ROOT_ID = 'dpr-local-pdf-reader';
  const LOCAL_DEEP_STORAGE_KEY = 'dpr_local_pdf_deep_entries_v1';
  const LOCAL_DEEP_SELECTED_KEY = 'dpr_local_pdf_selected_entry_v1';
  const LOCAL_DEEP_SIDEBAR_COLLAPSED_KEY = 'dpr_local_pdf_sidebar_collapsed_v1';
  const LOCAL_DEEP_MAX_ENTRIES = 30;
  const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
  const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const PDF_PREVIEW_PAGE_LIMIT = 3;
  const DEEP_READ_TEXT_CHAR_LIMIT = 120000;
  const LOCAL_PDF_WORKFLOW_ID = 'local-pdf-deep-read.yml';
  const LOCAL_PDF_UPLOAD_DIR = 'docs/assets/local_pdfs/uploads';
  const GITHUB_UPLOAD_MAX_BYTES = 80 * 1024 * 1024;
  const DEEP_READ_SYSTEM_PROMPT =
    '你是一名资深学术论文分析助手，请使用中文、以 Markdown 形式，'
    + '对给定论文做结构化、深入、客观的总结。';
  const DEEP_READ_USER_PROMPT = [
    '请基于下面提供的论文内容，生成一段详细的中文总结，要求按照如下要点依次展开：',
    '1. 论文的核心问题与整体含义（研究动机和背景）。',
    '2. 论文提出的方法论：核心思想、关键技术细节、公式或算法流程（用文字说明即可）。',
    '3. 实验设计：使用了哪些数据集 / 场景，它的 benchmark 是什么，对比了哪些方法。',
    '4. 资源与算力：如果文中有提到，请总结使用了多少算力（GPU 型号、数量、训练时长等）。若未明确说明，也请指出这一点。',
    '5. 实验数量与充分性：大概做了多少组实验（如不同数据集、消融实验等），这些实验是否充分、是否客观、公平。',
    '6. 论文的主要结论与发现。',
    '7. 优点：方法或实验设计上有哪些亮点。',
    '8. 不足与局限：包括实验覆盖、偏差风险、应用限制等。',
    '',
    '请用分层标题和项目符号（Markdown 格式）组织上述内容，语言尽量简洁但信息要尽量完整。',
    '若需要写数学符号或公式，请使用 Markdown 数学格式：行内公式用 $...$，块级公式用 $$...$$，不要输出裸括号形式如 (T) 或 (D_K)。多条公式请分别包裹为独立数学片段；中文说明、中文标点不要放进 $...$ 或 $$...$$ 内，例如写作 $a=b$，最终损失为 $L$。',
    '要求：最后单独输出一行“（完）”作为结束标记。',
  ].join('\n');
  let pdfJsPromise = null;
  let lastResult = null;
  let lastFile = null;
  let importQueue = [];
  let importBatchToken = 0;
  let importParsePromise = Promise.resolve();

  const byId = (id) => document.getElementById(id);

  const normalizeText = (value) =>
    String(value || '')
      .replace(/\u0000/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  const formatBytes = (bytes) => {
    const n = Number(bytes || 0);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = n;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
  };

  const parsePdfDate = (value) => {
    const text = String(value || '').trim();
    const match = text.match(/^D:(\d{4})(\d{2})?(\d{2})?/);
    if (!match) return text;
    const y = match[1];
    const m = match[2] || '01';
    const d = match[3] || '01';
    return `${y}-${m}-${d}`;
  };

  const cleanLine = (line) =>
    String(line || '')
      .replace(/\s+/g, ' ')
      .trim();

  const guessTitle = (metadataTitle, text, fallbackName) => {
    const metaTitle = cleanLine(metadataTitle);
    if (metaTitle && !/^untitled$/i.test(metaTitle)) return metaTitle;
    const lines = String(text || '')
      .split(/\n+/)
      .map(cleanLine)
      .filter(Boolean);
    const candidate = lines.find((line) => {
      if (line.length < 8 || line.length > 220) return false;
      if (/^(abstract|keywords|introduction|references)$/i.test(line)) return false;
      if (/^arxiv:/i.test(line)) return false;
      if (/@/.test(line) && line.length < 80) return false;
      return /[A-Za-z]{3,}/.test(line);
    });
    if (candidate) return candidate;
    return String(fallbackName || 'local-paper.pdf').replace(/\.pdf$/i, '');
  };

  const extractAbstract = (text) => {
    const source = normalizeText(text);
    if (!source) return '';
    const match = source.match(/\babstract\b[\s:.\-]*([\s\S]{80,2600})/i);
    if (!match) return '';
    let body = match[1] || '';
    const markers = [
      /\n\s*(?:1\.?\s+)?introduction\b/i,
      /\n\s*keywords?\b/i,
      /\n\s*index terms?\b/i,
      /\n\s*(?:2\.?\s+)?related work\b/i,
    ];
    let end = body.length;
    markers.forEach((re) => {
      const marker = body.search(re);
      if (marker >= 0) end = Math.min(end, marker);
    });
    body = cleanLine(body.slice(0, end));
    if (body.length > 1800) {
      body = `${body.slice(0, 1800).replace(/\s+\S*$/, '')}...`;
    }
    return body;
  };

  const extractKeywords = (text) => {
    const match = String(text || '').match(/\b(?:keywords|index terms)\b[\s:.\-]*([^\n]{8,360})/i);
    if (!match) return '';
    return cleanLine(match[1]).replace(/\s*;\s*/g, ', ');
  };

  const textContentToLines = (items) => {
    const lines = [];
    let current = [];
    let lastY = null;
    (items || []).forEach((item) => {
      const str = cleanLine(item && item.str);
      if (!str) return;
      const transform = item && item.transform;
      const y = Array.isArray(transform) ? Number(transform[5]) : NaN;
      if (Number.isFinite(y) && lastY !== null && Math.abs(y - lastY) > 4 && current.length) {
        lines.push(current.join(' '));
        current = [];
      }
      current.push(str);
      if (Number.isFinite(y)) lastY = y;
    });
    if (current.length) lines.push(current.join(' '));
    return lines.join('\n');
  };

  const renderPdfPagePreviewFigure = async (pdf, pageNum, index) => {
    if (!pdf || typeof document === 'undefined' || !document.createElement) return null;
    try {
      const page = await pdf.getPage(pageNum);
      const baseViewport = page.getViewport({ scale: 1 });
      const maxWidth = 420;
      const scale = Math.max(Math.min(maxWidth / Math.max(baseViewport.width || 1, 1), 1.1), 0.35);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext && canvas.getContext('2d');
      if (!context) return null;
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      return {
        url: canvas.toDataURL('image/jpeg', 0.58),
        caption: `PDF page ${pageNum} preview generated locally.`,
        page: pageNum,
        index,
        width: canvas.width,
        height: canvas.height,
      };
    } catch {
      return null;
    }
  };

  const renderPdfPreviewFigures = async (pdf) => {
    const limit = Math.min(Number(pdf && pdf.numPages) || 0, PDF_PREVIEW_PAGE_LIMIT);
    const figures = [];
    for (let pageNum = 1; pageNum <= limit; pageNum += 1) {
      const figure = await renderPdfPagePreviewFigure(pdf, pageNum, figures.length + 1);
      if (figure && figure.url) figures.push(figure);
    }
    return figures;
  };

  const loadPdfJs = () => {
    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return Promise.resolve(window.pdfjsLib);
    }
    if (pdfJsPromise) return pdfJsPromise;
    pdfJsPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = PDFJS_URL;
      script.async = true;
      script.onload = () => {
        if (!window.pdfjsLib) {
          reject(new Error('PDF.js load failed'));
          return;
        }
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        resolve(window.pdfjsLib);
      };
      script.onerror = () => reject(new Error('PDF.js load failed'));
      document.head.appendChild(script);
    });
    return pdfJsPromise;
  };

  const setStatus = (message, tone) => {
    const el = byId('dpr-local-pdf-status');
    if (!el) return;
    el.textContent = message || '';
    el.dataset.tone = tone || '';
  };

  const escapeHtml = (value) =>
    String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const setWorkflowInfo = (html) => {
    const el = byId('dpr-local-pdf-workflow');
    if (!el) return;
    el.innerHTML = html || '';
    el.hidden = !html;
  };

  const isPdfFile = (file) => {
    if (!file) return false;
    const name = String(file.name || '');
    const type = String(file.type || '');
    return /\.pdf$/i.test(name) && (!type || type === 'application/pdf');
  };

  const normalizePdfFiles = (files) => Array.from(files || []).filter(isPdfFile);

  const makeImportItemId = (file) =>
    `pdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${
      String((file && file.name) || 'paper').replace(/[^\w.-]+/g, '-').slice(0, 48)
    }`;

  const buildImportQueueItem = (file, id) => ({
    id: cleanLine(id || makeImportItemId(file)),
    file,
    fileName: cleanLine(file && file.name) || 'local-paper.pdf',
    fileSizeText: formatBytes(file && file.size),
    status: 'queued',
    error: '',
    editingTitle: false,
    result: null,
  });

  const appendImportQueueItems = (items, files) => {
    const next = Array.isArray(items) ? items.slice() : [];
    normalizePdfFiles(files).forEach((file) => {
      next.push(buildImportQueueItem(file));
    });
    return next;
  };

  const applyTitleToResult = (result, title) => {
    const cleanTitle = cleanLine(title);
    if (result && cleanTitle) result.title = cleanTitle;
    return result;
  };

  const updateImportQueueItemTitle = (items, id, title) => {
    const cleanTitle = cleanLine(title);
    if (!cleanTitle) return Array.isArray(items) ? items : [];
    return (Array.isArray(items) ? items : []).map((item) => {
      if (!item || item.id !== id) return item;
      const result = item.result ? { ...item.result, title: cleanTitle } : null;
      return {
        ...item,
        result,
        titleOverride: cleanTitle,
        editingTitle: false,
      };
    });
  };

  const deleteImportQueueItem = (items, id) =>
    (Array.isArray(items) ? items : []).filter((item) => item && item.id !== id);

  const getImportItemTitle = (item) =>
    cleanLine(
      (item && item.titleOverride)
        || (item && item.result && item.result.title)
        || (item && item.fileName)
        || '本地论文',
    );

  const getLocalStorage = () => {
    try {
      return window.localStorage || null;
    } catch {
      return null;
    }
  };

  const parseJsonArray = (value) => {
    try {
      const parsed = JSON.parse(String(value || '[]'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const loadLocalDeepEntries = () => {
    const storage = getLocalStorage();
    if (!storage) return [];
    return parseJsonArray(storage.getItem(LOCAL_DEEP_STORAGE_KEY))
      .filter((entry) => entry && entry.id && entry.deepSummary)
      .slice(0, LOCAL_DEEP_MAX_ENTRIES);
  };

  const saveLocalDeepEntries = (entries) => {
    const storage = getLocalStorage();
    if (!storage) return;
    const safeEntries = Array.isArray(entries) ? entries.slice(0, LOCAL_DEEP_MAX_ENTRIES) : [];
    try {
      storage.setItem(LOCAL_DEEP_STORAGE_KEY, JSON.stringify(safeEntries));
    } catch {
      setStatus('精读总结已生成，但浏览器本地存储空间不足，无法加入侧栏。', 'error');
    }
  };

  const getSelectedLocalDeepEntryId = () => {
    const storage = getLocalStorage();
    if (!storage) return '';
    return cleanLine(storage.getItem(LOCAL_DEEP_SELECTED_KEY));
  };

  const setSelectedLocalDeepEntryId = (id) => {
    const storage = getLocalStorage();
    if (!storage) return;
    if (id) {
      storage.setItem(LOCAL_DEEP_SELECTED_KEY, id);
    } else {
      storage.removeItem(LOCAL_DEEP_SELECTED_KEY);
    }
  };

  const getLocalSidebarCollapsed = () => {
    const storage = getLocalStorage();
    if (!storage) return false;
    return storage.getItem(LOCAL_DEEP_SIDEBAR_COLLAPSED_KEY) === '1';
  };

  const setLocalSidebarCollapsed = (collapsed) => {
    const storage = getLocalStorage();
    if (!storage) return;
    storage.setItem(LOCAL_DEEP_SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  };

  const makeLocalDeepEntryId = () =>
    `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const buildStoredDeepEntry = (result, id, generatedAt) => {
    const source = result || {};
    return {
      id: cleanLine(id || source.localEntryId || makeLocalDeepEntryId()),
      title: cleanLine(source.title || source.fileName || '本地论文'),
      fileName: cleanLine(source.fileName || ''),
      pageCount: Number(source.pageCount || 0),
      fileSizeText: cleanLine(source.fileSizeText || ''),
      author: cleanLine(source.author || ''),
      createdAt: cleanLine(source.createdAt || ''),
      keywords: cleanLine(source.keywords || ''),
      abstract: cleanLine(source.abstract || ''),
      tldr: cleanLine(source.tldr || source.abstract || ''),
      motivation: cleanLine(source.motivation || ''),
      method: cleanLine(source.method || ''),
      result: cleanLine(source.result || ''),
      conclusion: cleanLine(source.conclusion || ''),
      figurePreviews: Array.isArray(source.figurePreviews)
        ? source.figurePreviews
          .filter((item) => item && item.url)
          .slice(0, PDF_PREVIEW_PAGE_LIMIT)
          .map((item, index) => ({
            url: String(item.url || '').trim(),
            caption: cleanLine(item.caption || `PDF page ${Number(item.page || index + 1)} preview generated locally.`),
            page: Number(item.page || index + 1),
            index: Number(item.index || index + 1),
            width: Number(item.width || 0),
            height: Number(item.height || 0),
          }))
        : [],
      figureDataUrl: String(source.figureDataUrl || '').trim(),
      figureWidth: Number(source.figureWidth || 0),
      figureHeight: Number(source.figureHeight || 0),
      charCount: Number(source.charCount || 0),
      wordCount: Number(source.wordCount || 0),
      deepSummary: String(source.deepSummary || '').trim(),
      generatedAt: cleanLine(generatedAt || new Date().toISOString()),
    };
  };

  const formatEntryTime = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const stripSidebarIcon = (value) =>
    String(value || '')
      .replace(/^(?:[\s\uFE0F\u200D]*(?:[\u2600-\u27BF]|[\u{1F300}-\u{1FAFF}])\uFE0F?\s*)+/u, '')
      .trim();

  const buildLocalDeepHash = (id) => `#/local-pdf/deep/${encodeURIComponent(cleanLine(id))}`;

  const getLocalDeepEntryIdFromHash = () => {
    const hash = String(window.location && window.location.hash || '');
    const match = hash.match(/^#\/local-pdf\/deep\/([^/?#]+)/i);
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  };

  const findLocalPdfSidebarLi = () => {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav) return null;
    const links = Array.from(nav.querySelectorAll('a'));
    const link = links.find((a) => {
      const href = String(a.getAttribute('href') || a.getAttribute('data-dpr-hash') || '');
      const label = stripSidebarIcon(a.dataset.dprRawLabel || a.textContent || '');
      return href.includes('#/local-pdf') || label === '本地 PDF 解析';
    });
    return link && link.closest ? link.closest('li') : null;
  };

  const entryToResult = (entry) => ({
    localEntryId: entry.id,
    fileName: entry.fileName || entry.title || 'local-paper.pdf',
    fileSizeText: entry.fileSizeText || '-',
    pageCount: entry.pageCount || '-',
    title: entry.title || entry.fileName || '本地论文',
    author: entry.author || '',
    createdAt: entry.createdAt || '',
    keywords: entry.keywords || '',
    abstract: entry.abstract || '',
    text: '',
    charCount: entry.charCount || 0,
    wordCount: entry.wordCount || 0,
    deepSummary: entry.deepSummary || '',
    tldr: entry.tldr || '',
    motivation: entry.motivation || '',
    method: entry.method || '',
    result: entry.result || '',
    conclusion: entry.conclusion || '',
    figurePreviews: Array.isArray(entry.figurePreviews) ? entry.figurePreviews : [],
    figureDataUrl: entry.figureDataUrl || '',
    figureWidth: entry.figureWidth || 0,
    figureHeight: entry.figureHeight || 0,
  });

  const loadStoredEntryIntoPage = (id) => {
    const root = byId(ROOT_ID);
    if (!root || !id) return false;
    const entry = loadLocalDeepEntries().find((item) => item.id === id);
    if (!entry) return false;
    lastResult = entryToResult(entry);
    renderResult(lastResult);
    setStatus(`已从侧栏加载本地精读：${entry.title || entry.fileName || '本地论文'}`, 'success');
    return true;
  };

  const selectLocalDeepEntry = (id) => {
    if (!id) return;
    setSelectedLocalDeepEntryId(id);
    const targetHash = buildLocalDeepHash(id);
    if (String(window.location && window.location.hash || '') !== targetHash) {
      window.location.hash = targetHash;
    }
    setTimeout(() => loadStoredEntryIntoPage(id), 80);
    setTimeout(() => loadStoredEntryIntoPage(id), 280);
  };

  const buildSidebarEntryLink = (entry, activeId) => {
    const a = document.createElement('a');
    a.href = buildLocalDeepHash(entry.id);
    a.className = 'dpr-local-pdf-sidebar-entry';
    if (entry.id === activeId) a.classList.add('active');
    a.dataset.localPdfEntryId = entry.id;

    const title = document.createElement('span');
    title.className = 'dpr-local-pdf-sidebar-entry-title';
    title.textContent = entry.title || entry.fileName || '本地论文';
    const meta = document.createElement('span');
    meta.className = 'dpr-local-pdf-sidebar-entry-meta';
    meta.textContent = formatEntryTime(entry.generatedAt) || '本地生成';
    a.appendChild(title);
    a.appendChild(meta);

    a.addEventListener('click', (event) => {
      setSelectedLocalDeepEntryId(entry.id);
    });
    return a;
  };

  const renderLocalDeepSidebar = () => {
    // 后端生成的本地 PDF 条目已经写入 _sidebar.md，交给 Docsify 统一折叠渲染。
  };

  const upsertLocalDeepEntry = (result) => {
    if (!result || !result.deepSummary) return null;
    const entry = buildStoredDeepEntry(result);
    const entries = loadLocalDeepEntries().filter((item) => item.id !== entry.id);
    entries.unshift(entry);
    saveLocalDeepEntries(entries);
    result.localEntryId = entry.id;
    setSelectedLocalDeepEntryId(entry.id);
    renderLocalDeepSidebar();
    return entry;
  };

  const yamlQuote = (value) =>
    JSON.stringify(String(value || '').replace(/\r\n/g, '\n').replace(/\n/g, '\\n'));

  const stripMarkdownForGlance = (value) =>
    cleanLine(
      String(value || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/\$\$[\s\S]*?\$\$/g, ' ')
        .replace(/\$([^$]+)\$/g, '$1')
        .replace(/^[\s>*-]+/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[[^\]]+\]\([^)]+\)/g, ''),
    );

  const firstReadableSentence = (value, maxLen = 180) => {
    const text = stripMarkdownForGlance(value);
    if (!text) return '';
    const parts = text.split(/(?<=[。.!?！？])\s+/).filter(Boolean);
    const picked = parts[0] || text;
    return picked.length > maxLen ? `${picked.slice(0, maxLen).replace(/\s+\S*$/, '')}...` : picked;
  };

  const extractSummarySection = (summary, keywords) => {
    const keys = Array.isArray(keywords) ? keywords : [keywords];
    const lines = String(summary || '').replace(/\r\n/g, '\n').split('\n');
    let start = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const heading = lines[i].match(/^\s*#{1,6}\s*(.*)$/);
      if (!heading) continue;
      const label = stripMarkdownForGlance(heading[1]);
      if (keys.some((key) => label.includes(key))) {
        start = i + 1;
        break;
      }
    }
    if (start < 0) return '';
    const out = [];
    for (let i = start; i < lines.length; i += 1) {
      if (/^\s*#{1,6}\s+/.test(lines[i])) break;
      out.push(lines[i]);
    }
    return out.join('\n').trim();
  };

  const deriveGlanceFields = (result, summary) => ({
    tldr: firstReadableSentence((result && result.abstract) || summary, 220),
    motivation: firstReadableSentence(
      extractSummarySection(summary, ['核心问题', '研究动机', '背景']) || (result && result.abstract),
    ),
    method: firstReadableSentence(extractSummarySection(summary, ['方法论', '方法', '核心思想'])),
    result: firstReadableSentence(extractSummarySection(summary, ['实验设计', '主要结论', '发现', '结果'])),
    conclusion: firstReadableSentence(extractSummarySection(summary, ['主要结论', '结论', '发现'])),
  });

  const buildLocalDeepRouteMarkdown = (entry) => {
    if (!entry) return '';
    const title = cleanLine(entry.title || entry.fileName || '本地论文');
    const date = cleanLine(entry.createdAt || formatEntryTime(entry.generatedAt).slice(0, 10));
    const authors = cleanLine(entry.author || 'Local PDF');
    const tldr = cleanLine(entry.abstract || '本地 PDF 生成的精读总结。');
    const tags = ['paper:本地PDF', 'query:local-pdf'];
    const glance = deriveGlanceFields(entry, entry.deepSummary || '');
    const previewFigures = Array.isArray(entry.figurePreviews) && entry.figurePreviews.length
      ? entry.figurePreviews
      : entry.figureDataUrl
        ? [{
            url: entry.figureDataUrl,
            caption: `Local PDF first-page preview: ${title}`,
            page: 1,
            index: 1,
            width: entry.figureWidth || 0,
            height: entry.figureHeight || 0,
          }]
        : [];
    const figures = previewFigures
      .filter((figure) => figure && figure.url)
      .slice(0, PDF_PREVIEW_PAGE_LIMIT)
      .map((figure, index) => ({
        url: figure.url,
        caption: figure.caption || `Local PDF page ${figure.page || index + 1} preview: ${title}`,
        page: Number(figure.page || index + 1),
        index: index + 1,
        width: Number(figure.width || 0),
        height: Number(figure.height || 0),
      }));
    const frontMatter = [
      '---',
      `title: ${yamlQuote(title)}`,
      `authors: ${yamlQuote(authors)}`,
      `date: ${yamlQuote(date || 'Unknown')}`,
      'source: local-pdf',
      `tags: [${tags.map(yamlQuote).join(', ')}]`,
      'score: local',
      `evidence: ${yamlQuote('本地 PDF 上传后生成的精读总结')}`,
      `tldr: ${yamlQuote(entry.tldr || glance.tldr || tldr)}`,
      entry.motivation || glance.motivation ? `motivation: ${yamlQuote(entry.motivation || glance.motivation)}` : '',
      entry.method || glance.method ? `method: ${yamlQuote(entry.method || glance.method)}` : '',
      entry.result || glance.result ? `result: ${yamlQuote(entry.result || glance.result)}` : '',
      entry.conclusion || glance.conclusion ? `conclusion: ${yamlQuote(entry.conclusion || glance.conclusion)}` : '',
      figures.length ? `figures_json: ${yamlQuote(JSON.stringify(figures))}` : '',
      '---',
    ].filter(Boolean).join('\n');
    const body = [
      '',
      '## 摘要',
      '',
      entry.abstract || '未检测到摘要段落。',
      '',
      '---',
      '',
      '## 论文详细总结（自动生成）',
      '',
      entry.deepSummary || '',
    ].join('\n');
    return `${frontMatter}\n${body}`.trim();
  };

  const resolveRouteMarkdown = () => {
    const id = getLocalDeepEntryIdFromHash();
    if (!id) return '';
    setSelectedLocalDeepEntryId(id);
    const entry = loadLocalDeepEntries().find((item) => item.id === id);
    if (!entry) {
      return [
        '# 本地精读未找到',
        '',
        '这条本地精读记录可能已经被清理，或保存在另一台浏览器中。',
        '',
        '[返回本地 PDF 解析](#/local-pdf)',
      ].join('\n');
    }
    return buildLocalDeepRouteMarkdown(entry);
  };

  const getLLMUtils = () => window.DPRLLMConfigUtils || {};

  const resolveSummaryLLM = () => {
    const mode = String(window.DPR_ACCESS_MODE || '').toLowerCase();
    if (mode === 'guest' || mode === 'locked') {
      throw new Error('请先解锁密钥，再生成精读总结。');
    }
    const secret = window.decoded_secret_private || {};
    const utils = getLLMUtils();
    if (typeof utils.resolveSummaryLLM === 'function') {
      const llm = utils.resolveSummaryLLM(secret);
      if (llm && llm.baseUrl && llm.apiKey && llm.model) return llm;
    }
    const summarized = secret && typeof secret === 'object' ? secret.summarizedLLM || {} : {};
    const baseUrl = cleanLine(summarized.baseUrl);
    const apiKey = cleanLine(summarized.apiKey);
    const model = cleanLine(summarized.model);
    if (baseUrl && apiKey && model) return { baseUrl, apiKey, model };
    throw new Error('未检测到可用的摘要 LLM 配置。');
  };

  const buildChatEndpoint = (baseUrl) => {
    const utils = getLLMUtils();
    if (typeof utils.buildChatCompletionsEndpoint === 'function') {
      return utils.buildChatCompletionsEndpoint(baseUrl);
    }
    const raw = cleanLine(baseUrl).replace(/\/+$/g, '');
    if (!raw) return '';
    if (/\/chat\/completions$/i.test(raw)) return raw;
    if (/\/v\d+$/i.test(raw)) return `${raw}/chat/completions`;
    return `${raw}/v1/chat/completions`;
  };

  const truncateForLLM = (text, limit = DEEP_READ_TEXT_CHAR_LIMIT) => {
    const source = normalizeText(text);
    const max = Math.max(Number(limit) || 0, 10000);
    if (source.length <= max) {
      return {
        text: source,
        truncated: false,
        originalLength: source.length,
      };
    }
    const head = Math.floor(max * 0.72);
    const tail = max - head;
    return {
      text: `${source.slice(0, head)}\n\n[...中间内容因浏览器直连模型上下文限制已省略...]\n\n${source.slice(-tail)}`,
      truncated: true,
      originalLength: source.length,
    };
  };

  const buildDeepReadMarkdown = (result) => {
    if (!result) return '';
    return [
      `# ${result.title || result.fileName}`,
      '',
      `**File**: ${result.fileName}`,
      `**Pages**: ${result.pageCount}`,
      result.author ? `**Authors**: ${result.author}` : '',
      result.createdAt ? `**Date**: ${result.createdAt}` : '',
      result.abstract ? `**Abstract**: ${result.abstract}` : '',
    ].filter(Boolean).join('\n');
  };

  const buildDeepReadMessages = (result) => {
    const preparedText = truncateForLLM(result && result.text);
    const textHeader = preparedText.truncated
      ? `### 论文 PDF 提取文本 ###\n以下文本来自浏览器端 PDF 抽取。原始字符数约 ${preparedText.originalLength}，本次发送了前后 ${preparedText.text.length} 字符。\n\n`
      : '### 论文 PDF 提取文本 ###\n';
    return [
      {
        role: 'system',
        content: DEEP_READ_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: `${textHeader}${preparedText.text}`,
      },
      {
        role: 'user',
        content: `### 论文 Markdown 元数据 ###\n${buildDeepReadMarkdown(result)}`,
      },
      {
        role: 'user',
        content: DEEP_READ_USER_PROMPT,
      },
    ];
  };

  const normalizeContentPart = (part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    if (part.type === 'text' && typeof part.value === 'string') return part.value;
    return '';
  };

  const extractChatResponseText = (data) => {
    if (!data || typeof data !== 'object') return '';
    const choice = Array.isArray(data.choices) ? data.choices[0] || {} : {};
    const message = choice.message || {};
    const content = message.content ?? choice.text ?? '';
    if (Array.isArray(content)) {
      return content.map(normalizeContentPart).join('\n').trim();
    }
    if (typeof content === 'string') return content.trim();
    return normalizeContentPart(content).trim();
  };

  const requestChatCompletion = async (llm, messages, maxTokens) => {
    const endpoint = buildChatEndpoint(llm && llm.baseUrl);
    if (!endpoint) throw new Error('摘要 LLM 配置缺少 baseUrl。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    const payload = {
      model: cleanLine(llm.model),
      messages,
      temperature: 0.3,
      max_tokens: maxTokens,
    };
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${llm.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify(payload),
      });
      const text = await resp.text();
      if (!resp.ok) {
        throw new Error(`精读总结请求失败：HTTP ${resp.status}${text ? ` - ${text.slice(0, 180)}` : ''}`);
      }
      const data = text ? JSON.parse(text) : null;
      return extractChatResponseText(data);
    } finally {
      clearTimeout(timer);
    }
  };

  const resolveOptionalSummaryLLM = () => {
    try {
      const llm = resolveSummaryLLM();
      return llm && llm.apiKey && llm.baseUrl && llm.model ? llm : null;
    } catch {
      return null;
    }
  };

  const getGithubTokenForActions = () => {
    try {
      const secret = window.decoded_secret_private || {};
      if (secret.github && secret.github.token) {
        return cleanLine(secret.github.token);
      }
    } catch {
      // ignore
    }
    try {
      const tokenModule = window.SubscriptionsGithubToken || {};
      if (typeof tokenModule.loadGithubToken === 'function') {
        const data = tokenModule.loadGithubToken();
        if (data && data.token) return cleanLine(data.token);
      }
    } catch {
      // ignore
    }
    try {
      const raw = window.localStorage ? window.localStorage.getItem('github_token_data') : '';
      if (!raw) return '';
      const data = JSON.parse(raw);
      return cleanLine(data && data.token);
    } catch {
      return '';
    }
  };

  const ghApiFetch = (token, url, init) =>
    fetch(url, {
      ...(init || {}),
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        ...(init && init.headers ? init.headers : {}),
      },
    });

  const parseGitHubError = async (resp) => {
    const text = await resp.text().catch(() => '');
    try {
      const data = text ? JSON.parse(text) : null;
      if (data && data.message) return data.message;
    } catch {
      // ignore
    }
    return text || `${resp.status} ${resp.statusText}`;
  };

  const encodeGitHubPath = (path) =>
    String(path || '')
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');

  const readRepoFromConfig = async () => {
    const candidates = ['config.yaml', 'docs/config.yaml', '../config.yaml', '/config.yaml'];
    for (const url of candidates) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) continue;
        const text = await res.text();
        const ownerMatch = text.match(/^\s*owner:\s*['"]?([^'"\n#]*)/m);
        const repoMatch = text.match(/^\s*repo:\s*['"]?([^'"\n#]*)/m);
        const owner = cleanLine(ownerMatch && ownerMatch[1]);
        const repo = cleanLine(repoMatch && repoMatch[1]);
        if (owner || repo) return { owner, repo };
      } catch {
        // ignore
      }
    }
    return { owner: '', repo: '' };
  };

  const resolveRepoContextForActions = async (token) => {
    const currentUrl = String(window.location && window.location.href || '');
    const pagesMatch = currentUrl.match(/https?:\/\/([^.]+)\.github\.io\/([^/#?]+)/i);
    let owner = pagesMatch ? cleanLine(pagesMatch[1]) : '';
    let repo = pagesMatch ? cleanLine(pagesMatch[2]) : '';

    if (!repo) {
      const cfg = await readRepoFromConfig();
      owner = owner || cfg.owner;
      repo = repo || cfg.repo;
    }

    if (!owner) {
      const userRes = await ghApiFetch(token, 'https://api.github.com/user');
      if (!userRes.ok) {
        throw new Error(`GitHub Token 验证失败：${await parseGitHubError(userRes)}`);
      }
      const user = await userRes.json().catch(() => null);
      owner = cleanLine(user && user.login);
    }
    if (!repo) repo = 'AI_Daily_Paper_Reader';
    if (!owner || !repo) throw new Error('无法确定要写入的 GitHub 仓库。');

    const repoRes = await ghApiFetch(token, `https://api.github.com/repos/${owner}/${repo}`);
    if (!repoRes.ok) {
      throw new Error(`无法访问仓库 ${owner}/${repo}：${await parseGitHubError(repoRes)}`);
    }
    const repoData = await repoRes.json().catch(() => null);
    if (repoData && repoData.permissions && !repoData.permissions.push) {
      throw new Error(`当前 GitHub Token 没有仓库 ${owner}/${repo} 的写入权限。`);
    }
    return {
      owner,
      repo,
      defaultBranch: cleanLine(repoData && repoData.default_branch) || 'main',
    };
  };

  const sanitizePdfFileName = (name) => {
    const raw = String(name || 'local-paper.pdf').replace(/\.pdf$/i, '');
    const normalized = raw.normalize ? raw.normalize('NFKD') : raw;
    const safe = normalized
      .replace(/[^\w.-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-_.]+|[-_.]+$/g, '')
      .toLowerCase();
    return `${safe || 'local-paper'}.pdf`;
  };

  const buildUploadPath = (fileName, now = new Date()) => {
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
      '-',
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds()),
      '-',
      Math.random().toString(36).slice(2, 8),
    ].join('');
    return `${LOCAL_PDF_UPLOAD_DIR}/${stamp}-${sanitizePdfFileName(fileName)}`;
  };

  const buildUploadBatchId = (now = new Date()) => {
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
      '-',
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds()),
      '-',
      Math.random().toString(36).slice(2, 8),
    ].join('');
    return `batch-${stamp}`;
  };

  const buildBatchUploadPath = (batchId, index, fileName) => {
    const safeBatch = String(batchId || buildUploadBatchId()).replace(/[^\w.-]+/g, '-');
    const order = String(Number(index || 0) + 1).padStart(3, '0');
    return `${LOCAL_PDF_UPLOAD_DIR}/${safeBatch}/${order}-${sanitizePdfFileName(fileName)}`;
  };

  const buildBatchManifestPath = (batchId) => {
    const safeBatch = String(batchId || buildUploadBatchId()).replace(/[^\w.-]+/g, '-');
    return `${LOCAL_PDF_UPLOAD_DIR}/${safeBatch}/manifest.json`;
  };

  const buildLocalPdfBatchManifest = (entries, createdAt = new Date()) => ({
    version: 1,
    created_at: createdAt.toISOString(),
    items: (Array.isArray(entries) ? entries : []).map((entry, index) => ({
      client_id: cleanLine(entry && entry.clientId),
      upload_path: cleanLine(entry && entry.uploadPath),
      original_filename: cleanLine(entry && entry.fileName) || 'local-paper.pdf',
      title_override: cleanLine(entry && entry.titleOverride),
      order: index + 1,
    })),
  });

  const arrayBufferToBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer || []);
    const chunkSize = 0x8000;
    const chunks = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      chunks.push(String.fromCharCode.apply(null, chunk));
    }
    return btoa(chunks.join(''));
  };

  const fileToBase64 = async (file) => arrayBufferToBase64(await file.arrayBuffer());

  const utf8ToBase64 = (value) => {
    const text = String(value || '');
    if (typeof TextEncoder !== 'undefined') {
      return arrayBufferToBase64(new TextEncoder().encode(text).buffer);
    }
    return btoa(unescape(encodeURIComponent(text)));
  };

  const uploadPdfToGithub = async ({ token, owner, repo, branch, file, uploadPath }) => {
    const content = await fileToBase64(file);
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeGitHubPath(uploadPath)}`;
    const resp = await ghApiFetch(token, url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `[chore] upload local PDF for deep read: ${file.name || 'local-paper.pdf'}`,
        content,
        branch,
      }),
    });
    if (!resp.ok) {
      throw new Error(`上传 PDF 到 GitHub 失败：${await parseGitHubError(resp)}`);
    }
    return resp.json().catch(() => null);
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const getGithubBranchHead = async ({ token, owner, repo, branch }) => {
    const refPath = encodeGitHubPath(`heads/${branch}`);
    const resp = await ghApiFetch(token, `https://api.github.com/repos/${owner}/${repo}/git/ref/${refPath}`);
    if (!resp.ok) {
      throw new Error(`读取 GitHub 分支失败：${await parseGitHubError(resp)}`);
    }
    const data = await resp.json().catch(() => null);
    const sha = data && data.object && data.object.sha;
    if (!sha) throw new Error('GitHub 分支引用缺少 commit sha。');
    return sha;
  };

  const getGithubCommitTreeSha = async ({ token, owner, repo, sha }) => {
    const resp = await ghApiFetch(token, `https://api.github.com/repos/${owner}/${repo}/git/commits/${encodeURIComponent(sha)}`);
    if (!resp.ok) {
      throw new Error(`读取 GitHub commit 失败：${await parseGitHubError(resp)}`);
    }
    const data = await resp.json().catch(() => null);
    const treeSha = data && data.tree && data.tree.sha;
    if (!treeSha) throw new Error('GitHub commit 缺少 tree sha。');
    return treeSha;
  };

  const createGithubBlob = async ({ token, owner, repo, contentBase64 }) => {
    const resp = await ghApiFetch(token, `https://api.github.com/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: contentBase64, encoding: 'base64' }),
    });
    if (!resp.ok) {
      throw new Error(`创建 GitHub blob 失败：${await parseGitHubError(resp)}`);
    }
    const data = await resp.json().catch(() => null);
    if (!data || !data.sha) throw new Error('GitHub blob 响应缺少 sha。');
    return data.sha;
  };

  const createGithubTree = async ({ token, owner, repo, baseTreeSha, entries }) => {
    const resp = await ghApiFetch(token, `https://api.github.com/repos/${owner}/${repo}/git/trees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: entries.map((entry) => ({
          path: entry.path,
          mode: '100644',
          type: 'blob',
          sha: entry.sha,
        })),
      }),
    });
    if (!resp.ok) {
      throw new Error(`创建 GitHub tree 失败：${await parseGitHubError(resp)}`);
    }
    const data = await resp.json().catch(() => null);
    if (!data || !data.sha) throw new Error('GitHub tree 响应缺少 sha。');
    return data.sha;
  };

  const createGithubCommit = async ({ token, owner, repo, message, treeSha, parentSha }) => {
    const resp = await ghApiFetch(token, `https://api.github.com/repos/${owner}/${repo}/git/commits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        tree: treeSha,
        parents: [parentSha],
      }),
    });
    if (!resp.ok) {
      throw new Error(`创建 GitHub commit 失败：${await parseGitHubError(resp)}`);
    }
    const data = await resp.json().catch(() => null);
    if (!data || !data.sha) throw new Error('GitHub commit 响应缺少 sha。');
    return data.sha;
  };

  const updateGithubBranchHead = async ({ token, owner, repo, branch, sha }) => {
    const refPath = encodeGitHubPath(`heads/${branch}`);
    return ghApiFetch(token, `https://api.github.com/repos/${owner}/${repo}/git/refs/${refPath}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha, force: false }),
    });
  };

  const uploadFilesToGithubCommit = async ({ token, owner, repo, branch, files, message }) => {
    const blobEntries = [];
    for (const file of files) {
      const contentBase64 = file.contentBase64 || (file.file ? await fileToBase64(file.file) : '');
      if (!contentBase64) throw new Error(`待上传文件为空：${file.path}`);
      const sha = await createGithubBlob({ token, owner, repo, contentBase64 });
      blobEntries.push({ path: file.path, sha });
    }

    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const headSha = await getGithubBranchHead({ token, owner, repo, branch });
      const baseTreeSha = await getGithubCommitTreeSha({ token, owner, repo, sha: headSha });
      const treeSha = await createGithubTree({
        token,
        owner,
        repo,
        baseTreeSha,
        entries: blobEntries,
      });
      const commitSha = await createGithubCommit({
        token,
        owner,
        repo,
        message,
        treeSha,
        parentSha: headSha,
      });
      const updateResp = await updateGithubBranchHead({ token, owner, repo, branch, sha: commitSha });
      if (updateResp.ok) return { sha: commitSha };
      lastError = await parseGitHubError(updateResp);
      if (updateResp.status !== 409 && updateResp.status !== 422) {
        throw new Error(`更新 GitHub 分支失败：${lastError}`);
      }
      await sleep(1200 * attempt);
    }
    throw new Error(`更新 GitHub 分支失败，请重试：${lastError}`);
  };

  const dispatchLocalPdfWorkflow = async ({
    token,
    owner,
    repo,
    branch,
    uploadPath,
    manifestPath,
    fileName,
    titleOverride,
  }) => {
    const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(
      LOCAL_PDF_WORKFLOW_ID,
    )}/dispatches`;
    const resp = await ghApiFetch(token, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: branch,
        inputs: {
          upload_path: uploadPath || '',
          manifest_path: manifestPath || '',
          original_filename: fileName || 'local-paper.pdf',
          title_override: cleanLine(titleOverride),
          cleanup_upload: 'true',
        },
      }),
    });
    if (!resp.ok) {
      const detail = await parseGitHubError(resp);
      if (resp.status === 404) {
        throw new Error(`未找到 ${LOCAL_PDF_WORKFLOW_ID}，请先把包含该 workflow 的代码推送到远程仓库并启用 Actions。`);
      }
      throw new Error(`触发 GitHub Actions 失败：${detail}`);
    }
  };

  const waitForLocalPdfWorkflowRun = async ({ token, owner, repo, branch, createdAt }) => {
    const workflowPath = encodeURIComponent(LOCAL_PDF_WORKFLOW_ID);
    const sinceMs = createdAt.getTime() - 15000;
    for (let i = 0; i < 18; i += 1) {
      const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowPath}/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=10`;
      const resp = await ghApiFetch(token, url);
      if (resp.ok) {
        const data = await resp.json().catch(() => null);
        const runs = Array.isArray(data && data.workflow_runs) ? data.workflow_runs : [];
        const found = runs.find((run) => {
          const t = new Date(run && run.created_at);
          return !Number.isNaN(t.getTime()) && t.getTime() >= sinceMs;
        });
        if (found) return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    return null;
  };

  const renderWorkflowStarted = ({ owner, repo, run }) => {
    const workflowUrl = `https://github.com/${owner}/${repo}/actions/workflows/${encodeURIComponent(LOCAL_PDF_WORKFLOW_ID)}`;
    const runUrl = run && run.html_url ? run.html_url : workflowUrl;
    const runLabel = run && run.run_number ? `#${run.run_number}` : 'Actions';
    setWorkflowInfo(
      [
        '<div class="dpr-local-pdf-workflow-card">',
        `<span>后台精读已提交：${escapeHtml(runLabel)}</span>`,
        `<a href="${escapeHtml(runUrl)}" target="_blank" rel="noopener">查看运行</a>`,
        '</div>',
      ].join(''),
    );
  };

  const requestActionsDeepRead = async (file, titleOverride, options = {}) => {
    if (!file) {
      throw new Error('请先选择 PDF 文件，再运行后台精读。');
    }
    if (Number(file.size || 0) > GITHUB_UPLOAD_MAX_BYTES) {
      throw new Error(`PDF 超过 ${formatBytes(GITHUB_UPLOAD_MAX_BYTES)}，请压缩后再提交。`);
    }
    const token = getGithubTokenForActions();
    if (!token) {
      throw new Error('未检测到 GitHub Token。请先在首页完成 GitHub Token 配置，并确保具备 repo 与 workflow 权限。');
    }

    setWorkflowInfo('');
    setStatus('正在确认 GitHub 仓库权限...', 'loading');
    const repoContext = await resolveRepoContextForActions(token);
    const uploadPath = buildUploadPath(file.name || 'local-paper.pdf');
    setStatus(`正在上传 PDF 到 ${repoContext.owner}/${repoContext.repo}...`, 'loading');
    await uploadPdfToGithub({
      token,
      owner: repoContext.owner,
      repo: repoContext.repo,
      branch: repoContext.defaultBranch,
      file,
      uploadPath,
    });

    setStatus('PDF 已上传，正在触发 GitHub Actions 后台精读...', 'loading');
    const createdAt = new Date();
    await dispatchLocalPdfWorkflow({
      token,
      owner: repoContext.owner,
      repo: repoContext.repo,
      branch: repoContext.defaultBranch,
      uploadPath,
      fileName: file.name || 'local-paper.pdf',
      titleOverride,
    });
    const run = await waitForLocalPdfWorkflowRun({
      token,
      owner: repoContext.owner,
      repo: repoContext.repo,
      branch: repoContext.defaultBranch,
      createdAt,
    });
    if (options.showWorkflow !== false) {
      renderWorkflowStarted({ owner: repoContext.owner, repo: repoContext.repo, run });
    }
    setStatus('后台精读已开始。运行成功后刷新页面，左侧本地 PDF 精读区会出现新条目。', 'success');
    return { ok: true, uploadPath, run };
  };

  const requestActionsBatchDeepRead = async (items) => {
    const candidates = (Array.isArray(items) ? items : []).filter(
      (item) => item && item.file && typeof item.file.arrayBuffer === 'function',
    );
    if (!candidates.length) {
      throw new Error('没有可提交的 PDF。');
    }
    candidates.forEach((item) => {
      if (Number(item.file && item.file.size || 0) > GITHUB_UPLOAD_MAX_BYTES) {
        throw new Error(`${item.fileName || 'PDF'} 超过 ${formatBytes(GITHUB_UPLOAD_MAX_BYTES)}，请压缩后再提交。`);
      }
    });
    const token = getGithubTokenForActions();
    if (!token) {
      throw new Error('未检测到 GitHub Token。请先在首页完成 GitHub Token 配置，并确保具备 repo 与 workflow 权限。');
    }

    setWorkflowInfo('');
    setStatus('正在确认 GitHub 仓库权限...', 'loading');
    const repoContext = await resolveRepoContextForActions(token);
    const batchId = buildUploadBatchId();
    const uploadEntries = candidates.map((item, index) => {
      const fileName = item.fileName || (item.file && item.file.name) || 'local-paper.pdf';
      return {
        item,
        clientId: item.id,
        file: item.file,
        fileName,
        titleOverride: getImportItemTitle(item),
        uploadPath: buildBatchUploadPath(batchId, index, fileName),
      };
    });
    const manifestPath = buildBatchManifestPath(batchId);
    const manifest = buildLocalPdfBatchManifest(uploadEntries);
    const files = uploadEntries.map((entry) => ({
      path: entry.uploadPath,
      file: entry.file,
    }));
    files.push({
      path: manifestPath,
      contentBase64: utf8ToBase64(JSON.stringify(manifest, null, 2)),
    });

    setStatus(`正在一次性上传 ${candidates.length} 篇 PDF 批次到 ${repoContext.owner}/${repoContext.repo}...`, 'loading');
    await uploadFilesToGithubCommit({
      token,
      owner: repoContext.owner,
      repo: repoContext.repo,
      branch: repoContext.defaultBranch,
      files,
      message: `[chore] upload local PDF batch for deep read: ${batchId}`,
    });

    setStatus('PDF 批次已上传，正在触发一次 GitHub Actions 后台精读...', 'loading');
    const createdAt = new Date();
    await dispatchLocalPdfWorkflow({
      token,
      owner: repoContext.owner,
      repo: repoContext.repo,
      branch: repoContext.defaultBranch,
      manifestPath,
    });
    const run = await waitForLocalPdfWorkflowRun({
      token,
      owner: repoContext.owner,
      repo: repoContext.repo,
      branch: repoContext.defaultBranch,
      createdAt,
    });
    return {
      ok: true,
      batchId,
      manifestPath,
      run,
      items: uploadEntries.map((entry) => ({
        client_id: entry.clientId,
        upload_path: entry.uploadPath,
      })),
    };
  };

  const isGitHubPages = () => /\.github\.io$/i.test(String(window.location && window.location.hostname || ''));

  let localBackendHealthPromise = null;
  const isLocalBackendAvailable = async () => {
    if (isGitHubPages()) return false;
    if (localBackendHealthPromise) return localBackendHealthPromise;
    localBackendHealthPromise = (async () => {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 2500) : null;
      try {
        const resp = await fetch('/api/local-pdf/health', {
          cache: 'no-store',
          signal: controller ? controller.signal : undefined,
        });
        if (!resp.ok) return false;
        const data = await resp.json().catch(() => null);
        return !!(data && data.ok);
      } catch {
        return false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return localBackendHealthPromise;
  };

  const requestDeepRead = async (file, titleOverride, options = {}) => {
    if (await isLocalBackendAvailable()) {
      return requestBackendDeepRead(file, titleOverride, options);
    }
    return requestActionsDeepRead(file, titleOverride, options);
  };

  const requestBackendDeepRead = async (file, titleOverride, options = {}) => {
    if (!file) {
      throw new Error('请先选择 PDF 文件，再运行后端精读。');
    }
    setStatus('正在上传 PDF 到后端精读流程...', 'loading');
    const form = new FormData();
    form.append('pdf', file, file.name || 'local-paper.pdf');
    const cleanTitleOverride = cleanLine(titleOverride);
    if (cleanTitleOverride) form.append('title_override', cleanTitleOverride);
    const llm = resolveOptionalSummaryLLM();
    if (llm) {
      form.append('llm_config', JSON.stringify({
        apiKey: llm.apiKey,
        baseUrl: llm.baseUrl,
        model: llm.model,
      }));
    }
    const resp = await fetch('/api/local-pdf/deep', {
      method: 'POST',
      body: form,
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.ok === false) {
      const message = data && data.error ? data.error : `后端精读请求失败：HTTP ${resp.status}`;
      throw new Error(message);
    }
    setStatus('后端精读完成，正在打开生成页面...', 'success');
    renderLocalDeepSidebar();
    if (data.route && options.navigate !== false) {
      window.location.hash = data.route;
      window.setTimeout(() => {
        window.location.reload();
      }, 80);
    }
    return data;
  };

  const requestBackendBatchDeepRead = async (items) => {
    const candidates = (Array.isArray(items) ? items : []).filter(
      (item) => item && item.file && typeof item.file.arrayBuffer === 'function',
    );
    if (!candidates.length) {
      throw new Error('没有可提交到本地后端的 PDF。');
    }
    setStatus(`正在提交 ${candidates.length} 篇 PDF 到本地后端批量精读...`, 'loading');
    const form = new FormData();
    const meta = candidates.map((item) => ({
      client_id: item.id,
      original_filename: item.fileName || (item.file && item.file.name) || 'local-paper.pdf',
      title_override: getImportItemTitle(item),
    }));
    candidates.forEach((item) => {
      form.append('pdf', item.file, item.fileName || (item.file && item.file.name) || 'local-paper.pdf');
    });
    form.append('items', JSON.stringify(meta));
    const llm = resolveOptionalSummaryLLM();
    if (llm) {
      form.append('llm_config', JSON.stringify({
        apiKey: llm.apiKey,
        baseUrl: llm.baseUrl,
        model: llm.model,
      }));
    }
    const resp = await fetch('/api/local-pdf/deep-batch', {
      method: 'POST',
      body: form,
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) {
      const message = data && data.error ? data.error : `本地后端批量精读请求失败：HTTP ${resp.status}`;
      throw new Error(message);
    }
    renderLocalDeepSidebar();
    return data;
  };

  const renderMarkdownResult = (el, source) => {
    if (!el) return;
    const text = String(source || '').trim();
    if (!text) {
      el.innerHTML = '';
      return;
    }
    const markdown = window.DPRMarkdown || {};
    if (typeof markdown.renderMarkdownWithTables === 'function') {
      el.innerHTML = markdown.renderMarkdownWithTables(text);
    } else {
      el.textContent = text;
    }
    if (typeof markdown.restoreMarkdownMathPlaceholdersInEl === 'function') {
      markdown.restoreMarkdownMathPlaceholdersInEl(el);
    }
    if (typeof markdown.renderMathInEl === 'function') {
      markdown.renderMathInEl(el);
    }
  };

  const buildMarkdown = (result) => {
    if (!result) return '';
    const lines = [
      `# ${result.title || result.fileName}`,
      '',
      `- 文件：${result.fileName}`,
      `- 页数：${result.pageCount}`,
      `- 字符数：${result.charCount}`,
      `- 词数：${result.wordCount}`,
    ];
    if (result.author) lines.push(`- 作者：${result.author}`);
    if (result.createdAt) lines.push(`- PDF 日期：${result.createdAt}`);
    if (result.keywords) lines.push(`- 关键词：${result.keywords}`);
    if (result.abstract) {
      lines.push('', '## 摘要', result.abstract);
    }
    if (result.deepSummary) {
      lines.push('', '## 论文详细总结（自动生成）', result.deepSummary);
    }
    if (result.text) {
      lines.push('', '## 正文摘录', result.text.slice(0, 6000));
    }
    return lines.join('\n');
  };

  const copyText = async (text) => {
    const value = String(text || '');
    if (!value) return false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  };

  const downloadText = (name, text) => {
    const blob = new Blob([String(text || '')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const importStatusLabel = (status) => ({
    queued: '待解析',
    parsing: '解析中',
    ready: '已解析',
    generating: '生成中',
    generated: '已生成',
    submitted: '已提交',
    error: '生成失败',
    'parse-error': '解析失败',
  }[status] || '待解析');

  const canGenerateImportItem = (item) =>
    !!(
      item
      && item.file
      && typeof item.file.arrayBuffer === 'function'
      && item.result
      && ['ready', 'error'].includes(item.status)
    );

  const renderImportQueue = () => {
    const root = byId(ROOT_ID);
    const list = byId('dpr-local-pdf-list');
    const meta = byId('dpr-local-pdf-meta');
    const deepReadBtn = byId('dpr-local-pdf-deep-read');
    if (root) root.classList.toggle('has-result', importQueue.length > 0);
    if (meta) {
      const readyCount = importQueue.filter((item) => item.status === 'ready').length;
      const busyCount = importQueue.filter((item) => ['queued', 'parsing', 'generating'].includes(item.status)).length;
      meta.textContent = importQueue.length
        ? `已导入 ${importQueue.length} 篇 PDF，${readyCount} 篇可生成${busyCount ? `，${busyCount} 篇处理中` : ''}。`
        : '支持一次选择或拖入多篇 PDF，解析后可修改标题或删除不想生成的文献。';
    }
    if (deepReadBtn) {
      const eligibleCount = importQueue.filter(canGenerateImportItem).length;
      deepReadBtn.textContent = eligibleCount > 1 ? `批量后台精读生成（${eligibleCount} 篇）` : '后台精读生成';
      deepReadBtn.disabled = eligibleCount < 1
        || importQueue.some((item) => ['queued', 'parsing', 'generating'].includes(item.status));
    }
    if (!list) return;
    if (!importQueue.length) {
      list.innerHTML = '';
      return;
    }
    list.innerHTML = importQueue.map((item, index) => {
      const result = item.result || {};
      const title = getImportItemTitle(item);
      const status = item.status || 'queued';
      const statusClass = status.replace(/[^\w-]/g, '');
      const metrics = [
        result.pageCount ? `页数：${escapeHtml(result.pageCount)}` : '',
        result.charCount ? `字符数：${escapeHtml(result.charCount)}` : '',
        result.wordCount ? `词数：${escapeHtml(result.wordCount)}` : '',
        item.fileSizeText ? `大小：${escapeHtml(item.fileSizeText)}` : '',
      ].filter(Boolean).join(' · ');
      const metaParts = [
        escapeHtml(item.fileName),
        result.author ? `作者：${escapeHtml(result.author)}` : '',
        result.createdAt ? `PDF 日期：${escapeHtml(result.createdAt)}` : '',
        result.keywords ? `关键词：${escapeHtml(result.keywords)}` : '',
      ].filter(Boolean).join(' · ');
      const titleControl = item.editingTitle
        ? [
            '<div class="dpr-local-pdf-title-edit">',
            `<input class="dpr-local-pdf-title-input" data-local-pdf-title-input value="${escapeHtml(title)}" aria-label="修改论文标题" />`,
            `<button class="dpr-local-pdf-secondary" type="button" data-local-pdf-action="save-title" data-local-pdf-id="${escapeHtml(item.id)}">保存</button>`,
            `<button class="dpr-local-pdf-secondary" type="button" data-local-pdf-action="cancel-title" data-local-pdf-id="${escapeHtml(item.id)}">取消</button>`,
            '</div>',
          ].join('')
        : [
            `<h3>${escapeHtml(title)}</h3>`,
            `<button class="dpr-local-pdf-secondary" type="button" data-local-pdf-action="edit-title" data-local-pdf-id="${escapeHtml(item.id)}" ${item.result ? '' : 'disabled'}>修改标题</button>`,
          ].join('');
      const routeLink = item.generatedRoute
        ? `<a href="${escapeHtml(item.generatedRoute)}">打开生成页面</a>`
        : '';
      const runLink = item.workflowRunUrl
        ? `<a href="${escapeHtml(item.workflowRunUrl)}" target="_blank" rel="noopener">查看 Actions</a>`
        : '';
      return [
        `<article class="dpr-local-pdf-item is-${escapeHtml(statusClass)}" data-local-pdf-item-id="${escapeHtml(item.id)}">`,
        '<div class="dpr-local-pdf-item-main">',
        '<div class="dpr-local-pdf-item-title-row">',
        `<span class="dpr-local-pdf-item-index">${index + 1}</span>`,
        titleControl,
        `<button class="dpr-local-pdf-secondary dpr-local-pdf-danger" type="button" data-local-pdf-action="delete" data-local-pdf-id="${escapeHtml(item.id)}" ${status === 'generating' ? 'disabled' : ''}>删除</button>`,
        '</div>',
        `<div class="dpr-local-pdf-item-meta">${metaParts || '未检测到 PDF 元数据'}</div>`,
        metrics ? `<div class="dpr-local-pdf-item-metrics">${metrics}</div>` : '',
        result.abstract ? `<p class="dpr-local-pdf-item-abstract">${escapeHtml(result.abstract)}</p>` : '',
        item.error ? `<div class="dpr-local-pdf-item-error">${escapeHtml(item.error)}</div>` : '',
        routeLink || runLink ? `<div class="dpr-local-pdf-item-links">${routeLink}${runLink}</div>` : '',
        '</div>',
        `<span class="dpr-local-pdf-item-status">${escapeHtml(importStatusLabel(status))}</span>`,
        '</article>',
      ].filter(Boolean).join('');
    }).join('');
  };

  const renderResult = (result) => {
    if (!result) return;
    const file = lastFile || {
      name: result.fileName || 'local-paper.pdf',
      size: 0,
      type: 'application/pdf',
    };
    const item = buildImportQueueItem(file, result.localEntryId || makeImportItemId(file));
    item.result = result;
    item.fileName = result.fileName || item.fileName;
    item.fileSizeText = result.fileSizeText || item.fileSizeText;
    item.status = result.deepSummary ? 'generated' : 'ready';
    importQueue = [item];
    renderImportQueue();
  };

  const clearResult = () => {
    importBatchToken += 1;
    importParsePromise = Promise.resolve();
    importQueue = [];
    lastResult = null;
    lastFile = null;
    renderImportQueue();
    setWorkflowInfo('');
    setStatus('', '');
  };

  const generateDeepReadSummary = async (result) => {
    if (!result || !result.text) {
      throw new Error('请先解析 PDF，再生成精读总结。');
    }
    const llm = resolveSummaryLLM();
    setStatus(`正在调用摘要模型 ${llm.model} 生成精读总结...`, 'loading');
    const messages = buildDeepReadMessages(result);
    let summary = (await requestChatCompletion(llm, messages, 4096) || '').trim();
    if (summary && !summary.includes('（完）')) {
      setStatus('精读总结可能被截断，正在续写...', 'loading');
      const cont = (await requestChatCompletion(llm, [
        {
          role: 'system',
          content: DEEP_READ_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: '你上一次的总结可能被截断了，请从中断处继续补全，不要重复已输出内容。',
        },
        {
          role: 'user',
          content: `上一次输出如下：\n\n${summary}\n\n请继续补全，最后以一行“（完）”结束。`,
        },
      ], 2048) || '').trim();
      summary = `${summary}\n\n${cont}`.trim();
    }
    if (!summary) {
      throw new Error('摘要模型返回为空。');
    }
    result.deepSummary = summary;
    Object.assign(result, deriveGlanceFields(result, summary));
    lastResult = result;
    renderResult(result);
    upsertLocalDeepEntry(result);
    setStatus('精读总结完成，已加入侧栏精读区。', 'success');
    return summary;
  };

  const parsePdfFile = async (file, options = {}) => {
    if (!isPdfFile(file)) {
      throw new Error('请选择 PDF 文件。');
    }
    const shouldRender = options.render !== false;
    const statusPrefix = cleanLine(options.statusPrefix);
    const reportStatus = (message, tone) => setStatus(statusPrefix ? `${statusPrefix}：${message}` : message, tone);
    reportStatus('载入 PDF.js...', 'loading');
    const pdfjsLib = await loadPdfJs();
    reportStatus('读取文件...', 'loading');
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    reportStatus('生成本地页面预览...', 'loading');
    const previewFigures = await renderPdfPreviewFigures(pdf);
    const metadata = await pdf.getMetadata().catch(() => ({}));
    const info = metadata && metadata.info ? metadata.info : {};
    const pages = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
      reportStatus(`解析第 ${pageNum}/${pdf.numPages} 页...`, 'loading');
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      pages.push(textContentToLines(content.items || []));
    }
    const text = normalizeText(pages.join('\n\n'));
    const title = guessTitle(info.Title, text, file.name);
    const result = {
      fileName: file.name,
      fileSizeText: formatBytes(file.size),
      pageCount: pdf.numPages,
      title,
      author: cleanLine(info.Author),
      createdAt: parsePdfDate(info.CreationDate || info.ModDate),
      keywords: extractKeywords(text),
      abstract: extractAbstract(text),
      text,
      charCount: text.length,
      wordCount: (text.match(/[A-Za-z0-9]+|[\u4e00-\u9fff]/g) || []).length,
    };
    if (previewFigures.length) {
      result.figurePreviews = previewFigures;
      result.figureDataUrl = previewFigures[0].url;
      result.figureWidth = previewFigures[0].width;
      result.figureHeight = previewFigures[0].height;
    }
    if (shouldRender) {
      lastFile = file;
      lastResult = result;
      renderResult(result);
      reportStatus('解析完成。', 'success');
    }
    return result;
  };

  const parseImportItems = async (itemIds, token) => {
    const ids = Array.isArray(itemIds) ? itemIds : [];
    let parsed = 0;
    let failed = 0;
    for (let index = 0; index < ids.length; index += 1) {
      if (token !== importBatchToken) return { parsed, failed, cancelled: true };
      const itemId = ids[index];
      const current = importQueue.find((candidate) => candidate.id === itemId);
      if (!current) continue;
      current.status = 'parsing';
      current.error = '';
      renderImportQueue();
      try {
        const result = await parsePdfFile(current.file, {
          render: false,
          statusPrefix: `${index + 1}/${ids.length} ${current.fileName}`,
        });
        if (token !== importBatchToken) return { parsed, failed, cancelled: true };
        const target = importQueue.find((candidate) => candidate.id === itemId);
        if (!target) continue;
        target.result = applyTitleToResult(result, target.titleOverride);
        target.fileName = result.fileName || target.fileName;
        target.fileSizeText = result.fileSizeText || target.fileSizeText;
        target.status = 'ready';
        target.error = '';
        lastFile = target.file;
        lastResult = target.result;
        parsed += 1;
      } catch (error) {
        const target = importQueue.find((candidate) => candidate.id === itemId);
        if (target) {
          target.status = 'parse-error';
          target.error = error && error.message ? error.message : '解析失败。';
          failed += 1;
        }
      }
      renderImportQueue();
    }
    return { parsed, failed, cancelled: false };
  };

  const handleFiles = (files) => {
    const pdfFiles = normalizePdfFiles(files);
    if (!pdfFiles.length) {
      setStatus('请选择 PDF 文件。', 'error');
      return importParsePromise;
    }
    const token = importBatchToken;
    setSelectedLocalDeepEntryId('');
    setWorkflowInfo('');
    const beforeCount = importQueue.length;
    importQueue = appendImportQueueItems(importQueue, pdfFiles);
    const newItems = importQueue.slice(beforeCount);
    const newItemIds = newItems.map((item) => item.id);
    renderImportQueue();
    setStatus(
      beforeCount
        ? `已追加 ${newItems.length} 个 PDF，将按导入顺序排队解析。`
        : `已导入 ${newItems.length} 个 PDF，开始逐篇解析...`,
      'loading',
    );
    importParsePromise = importParsePromise
      .catch(() => null)
      .then(async () => {
        if (token !== importBatchToken) return null;
        const outcome = await parseImportItems(newItemIds, token);
        if (!outcome || outcome.cancelled || token !== importBatchToken) return outcome;
        const totalReady = importQueue.filter((item) => item.status === 'ready').length;
        const totalFailed = importQueue.filter((item) => item.status === 'parse-error').length;
        setStatus(
          outcome.failed
            ? `本次追加解析完成：${outcome.parsed} 篇成功，${outcome.failed} 篇失败。当前队列 ${totalReady} 篇可生成，${totalFailed} 篇失败。`
            : `本次解析完成：新增 ${outcome.parsed} 篇，当前队列 ${totalReady} 篇 PDF 可批量生成精读。`,
          outcome.failed ? 'error' : 'success',
        );
        return outcome;
      });
    return importParsePromise;
  };

  const beginTitleEdit = (id) => {
    importQueue = importQueue.map((item) => (
      item && item.id === id
        ? { ...item, editingTitle: true }
        : { ...item, editingTitle: false }
    ));
    renderImportQueue();
    const safeId = window.CSS && typeof window.CSS.escape === 'function'
      ? window.CSS.escape(id)
      : id.replace(/["\\]/g, '\\$&');
    const row = document.querySelector(`[data-local-pdf-item-id="${safeId}"]`);
    const input = row && row.querySelector('[data-local-pdf-title-input]');
    if (input && input.focus) {
      input.focus();
      input.select();
    }
  };

  const saveTitleEdit = (id, title) => {
    const cleanTitle = cleanLine(title);
    if (!cleanTitle) {
      setStatus('标题不能为空。', 'error');
      return;
    }
    importQueue = updateImportQueueItemTitle(importQueue, id, cleanTitle);
    const item = importQueue.find((candidate) => candidate.id === id);
    if (item && item.result) lastResult = item.result;
    renderImportQueue();
    setStatus('标题已更新，后台生成将使用修改后的标题。', 'success');
  };

  const cancelTitleEdit = (id) => {
    importQueue = importQueue.map((item) => (
      item && item.id === id ? { ...item, editingTitle: false } : item
    ));
    renderImportQueue();
  };

  const removeImportItem = (id) => {
    const item = importQueue.find((candidate) => candidate.id === id);
    importQueue = deleteImportQueueItem(importQueue, id);
    if (!importQueue.length) {
      lastFile = null;
      lastResult = null;
    } else {
      const latestReady = [...importQueue].reverse().find((candidate) => candidate.result);
      lastFile = latestReady ? latestReady.file : null;
      lastResult = latestReady ? latestReady.result : null;
    }
    renderImportQueue();
    setStatus(`已删除${item && item.fileName ? `「${item.fileName}」` : '该 PDF'}，不会生成这篇文献。`, 'success');
  };

  const handleImportListClick = (event) => {
    const button = event.target && event.target.closest
      ? event.target.closest('[data-local-pdf-action]')
      : null;
    if (!button) return;
    const id = cleanLine(button.dataset.localPdfId);
    if (!id) return;
    const action = button.dataset.localPdfAction;
    if (action === 'edit-title') {
      beginTitleEdit(id);
      return;
    }
    if (action === 'cancel-title') {
      cancelTitleEdit(id);
      return;
    }
    if (action === 'save-title') {
      const row = button.closest('[data-local-pdf-item-id]');
      const input = row && row.querySelector('[data-local-pdf-title-input]');
      saveTitleEdit(id, input ? input.value : '');
      return;
    }
    if (action === 'delete') {
      removeImportItem(id);
    }
  };

  const handleImportListKeydown = (event) => {
    if (!event || event.key !== 'Enter') return;
    const input = event.target && event.target.matches && event.target.matches('[data-local-pdf-title-input]')
      ? event.target
      : null;
    if (!input) return;
    const row = input.closest('[data-local-pdf-item-id]');
    const id = row ? cleanLine(row.dataset.localPdfItemId) : '';
    if (id) {
      event.preventDefault();
      saveTitleEdit(id, input.value);
    }
  };

  const renderBatchWorkflowResults = (outcomes) => {
    const safeOutcomes = Array.isArray(outcomes) ? outcomes : [];
    if (!safeOutcomes.length) {
      setWorkflowInfo('');
      return;
    }
    const rows = safeOutcomes.map(({ item, data, error }) => {
      const label = escapeHtml(getImportItemTitle(item));
      if (error) {
        return `<li><strong>${label}</strong><span>生成失败：${escapeHtml(error)}</span></li>`;
      }
      if (data && data.route) {
        return `<li><strong>${label}</strong><a href="${escapeHtml(data.route)}">打开生成页面</a></li>`;
      }
      const run = data && data.run;
      const runUrl = run && run.html_url;
      const runLabel = run && run.run_number ? `Actions #${run.run_number}` : 'Actions';
      if (runUrl) {
        return `<li><strong>${label}</strong><a href="${escapeHtml(runUrl)}" target="_blank" rel="noopener">查看 ${escapeHtml(runLabel)}</a></li>`;
      }
      return `<li><strong>${label}</strong><span>已提交后台任务</span></li>`;
    }).join('');
    setWorkflowInfo(
      [
        '<div class="dpr-local-pdf-workflow-card dpr-local-pdf-workflow-card-stack">',
        '<span>批量后台精读已处理，生成后的条目可从左侧本地 PDF 精读区打开。</span>',
        `<ul class="dpr-local-pdf-workflow-list">${rows}</ul>`,
        '</div>',
      ].join(''),
    );
  };

  const requestBatchDeepRead = async () => {
    const candidates = importQueue.filter(canGenerateImportItem);
    if (!candidates.length) {
      setStatus('没有可生成的 PDF，请先导入并完成解析。', 'error');
      return [];
    }

    setWorkflowInfo('');
    candidates.forEach((candidate) => {
      const item = importQueue.find((current) => current.id === candidate.id);
      if (item) {
        item.status = 'generating';
        item.error = '';
      }
    });
    renderImportQueue();

    const applyOutcome = (item, data, error) => {
      const current = importQueue.find((entry) => entry.id === item.id) || item;
      if (error) {
        current.status = 'error';
        current.error = error;
        return { item: current, error };
      }
      current.error = '';
      current.status = data && data.route ? 'generated' : 'submitted';
      current.generatedRoute = data && data.route ? data.route : '';
      current.workflowRunUrl = data && data.run && data.run.html_url ? data.run.html_url : '';
      return { item: current, data };
    };

    try {
      const useLocalBackend = await isLocalBackendAvailable();
      let outcomes = [];
      if (useLocalBackend) {
        const data = await requestBackendBatchDeepRead(candidates);
        const results = Array.isArray(data && data.results) ? data.results : [];
        outcomes = candidates.map((item, index) => {
          const result = results.find((entry) => entry && entry.client_id === item.id)
            || results.find((entry) => entry && entry.index === index);
          if (!result) return applyOutcome(item, null, '本地后端未返回该 PDF 的生成结果。');
          if (result.ok === false) return applyOutcome(item, result, result.error || '本地后端生成失败。');
          return applyOutcome(item, result, null);
        });
      } else {
        const data = await requestActionsBatchDeepRead(candidates);
        outcomes = candidates.map((item) => applyOutcome(item, { ...data, route: '', run: data.run }, null));
      }
      renderImportQueue();
      renderBatchWorkflowResults(outcomes);
      const failed = outcomes.filter((outcome) => outcome.error).length;
      setStatus(
        failed
          ? `批量后台精读已处理：${outcomes.length - failed} 篇成功/已提交，${failed} 篇失败。`
          : `批量后台精读已一次性提交：${outcomes.length} 篇。`,
        failed ? 'error' : 'success',
      );
      return outcomes;
    } catch (error) {
      const message = error && error.message ? error.message : '批量后台精读提交失败。';
      const outcomes = candidates.map((item) => applyOutcome(item, null, message));
      renderImportQueue();
      renderBatchWorkflowResults(outcomes);
      setStatus(message, 'error');
      return outcomes;
    }
  };

  const bindEvents = (root) => {
    if (!root || root.dataset.bound === '1') return;
    root.dataset.bound = '1';
    const input = byId('dpr-local-pdf-input');
    const dropzone = byId('dpr-local-pdf-dropzone');
    const choose = byId('dpr-local-pdf-choose');
    const clear = byId('dpr-local-pdf-clear');
    const copyTextBtn = byId('dpr-local-pdf-copy-text');
    const copyMarkdownBtn = byId('dpr-local-pdf-copy-markdown');
    const deepReadBtn = byId('dpr-local-pdf-deep-read');
    const copyDeepBtn = byId('dpr-local-pdf-copy-deep');
    const downloadBtn = byId('dpr-local-pdf-download-text');
    const list = byId('dpr-local-pdf-list');

    if (choose && input) choose.addEventListener('click', () => input.click());
    if (input) {
      input.addEventListener('change', () => {
        const files = input.files ? Array.from(input.files) : [];
        input.value = '';
        handleFiles(files);
      });
    }
    if (clear) {
      clear.addEventListener('click', () => {
        if (input) input.value = '';
        lastFile = null;
        setSelectedLocalDeepEntryId('');
        clearResult();
      });
    }
    if (copyTextBtn) {
      copyTextBtn.addEventListener('click', () => {
        copyText(lastResult && lastResult.text).then((ok) => {
          setStatus(ok ? '正文已复制。' : '复制失败。', ok ? 'success' : 'error');
        });
      });
    }
    if (copyMarkdownBtn) {
      copyMarkdownBtn.addEventListener('click', () => {
        copyText(buildMarkdown(lastResult)).then((ok) => {
          setStatus(ok ? 'Markdown 已复制。' : '复制失败。', ok ? 'success' : 'error');
        });
      });
    }
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => {
        if (!lastResult) return;
        const base = lastResult.fileName.replace(/\.pdf$/i, '') || 'local-paper';
        downloadText(`${base}.txt`, lastResult.text);
      });
    }
    if (deepReadBtn) {
      deepReadBtn.addEventListener('click', () => {
        deepReadBtn.disabled = true;
        requestBatchDeepRead()
          .catch((error) => {
            setStatus(error && error.message ? error.message : '后台精读生成失败。', 'error');
          })
          .finally(() => {
            deepReadBtn.disabled = false;
          });
      });
    }
    if (list) {
      list.addEventListener('click', handleImportListClick);
      list.addEventListener('keydown', handleImportListKeydown);
    }
    if (copyDeepBtn) {
      copyDeepBtn.addEventListener('click', () => {
        copyText(lastResult && lastResult.deepSummary).then((ok) => {
          setStatus(ok ? '精读总结已复制。' : '复制失败。', ok ? 'success' : 'error');
        });
      });
    }
    if (dropzone) {
      ['dragenter', 'dragover'].forEach((name) => {
        dropzone.addEventListener(name, (event) => {
          event.preventDefault();
          dropzone.classList.add('is-dragover');
        });
      });
      ['dragleave', 'drop'].forEach((name) => {
        dropzone.addEventListener(name, (event) => {
          event.preventDefault();
          dropzone.classList.remove('is-dragover');
        });
      });
      dropzone.addEventListener('drop', (event) => {
        const files = event.dataTransfer && event.dataTransfer.files
          ? event.dataTransfer.files
          : [];
        handleFiles(files);
      });
    }
  };

  const init = () => {
    renderLocalDeepSidebar();
    const root = byId(ROOT_ID);
    if (!root) return;
    bindEvents(root);
    const selectedId = getSelectedLocalDeepEntryId();
    if (selectedId && (!lastResult || lastResult.localEntryId !== selectedId)) {
      loadStoredEntryIntoPage(selectedId);
    }
  };

  if (typeof window !== 'undefined') {
    window.DPRLocalPdfReader = {
      init,
      parsePdfFile,
      resolveRouteMarkdown,
      helpers: {
        normalizeText,
        formatBytes,
        parsePdfDate,
        guessTitle,
        extractAbstract,
        extractKeywords,
        buildMarkdown,
        buildDeepReadMarkdown,
        buildDeepReadMessages,
        buildStoredDeepEntry,
        buildLocalDeepRouteMarkdown,
        deriveGlanceFields,
        extractChatResponseText,
        truncateForLLM,
        sanitizePdfFileName,
        buildUploadPath,
        buildUploadBatchId,
        buildBatchUploadPath,
        buildBatchManifestPath,
        buildLocalPdfBatchManifest,
        encodeGitHubPath,
        arrayBufferToBase64,
        isPdfFile,
        normalizePdfFiles,
        buildImportQueueItem,
        appendImportQueueItems,
        applyTitleToResult,
        updateImportQueueItemTitle,
        deleteImportQueueItem,
        getImportItemTitle,
      },
    };

    window.$docsify = window.$docsify || {};
    window.$docsify.alias = Object.assign({}, window.$docsify.alias || {}, {
      '/local-pdf/deep/.+': '/local-pdf.md',
    });
    window.$docsify.plugins = [].concat(window.$docsify.plugins || [], function (hook) {
      hook.doneEach(init);
    });
  }
})();
