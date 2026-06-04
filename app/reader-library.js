// Personal reader database page rendered inside Docsify.
window.DPRReaderLibrary = (function () {
  const PAGE_SIZE = 10;
  const FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'source:local-pdf', label: '本地' },
    { key: 'favorite', label: '收藏' },
    { key: 'marker:good', label: 'Core' },
    { key: 'marker:blue', label: 'Novel' },
    { key: 'marker:orange', label: 'Useful' },
    { key: 'marker:bad', label: 'Skim' },
    { key: 'dislike', label: '不喜欢' },
  ];

  const state = {
    filter: 'all',
    query: '',
    queryInput: '',
    page: 1,
    catalogFingerprint: '',
    catalogPaperIds: new Set(),
    catalogReady: false,
    unsubscribe: null,
  };

  const escapeHtml = (value) =>
    String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const cssToken = (value) =>
    normalizeText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'other';
  const normalizePaperId = (value) =>
    normalizeText(value).replace(/^#\//, '').replace(/\.md$/i, '').replace(/\/$/, '');

  const getStore = () =>
    window.DPRReaderStateStore && typeof window.DPRReaderStateStore.listPapers === 'function'
      ? window.DPRReaderStateStore
      : null;

  const markerClass = (marker) => (marker ? ` marker-${escapeHtml(marker)}` : '');

  const routeIdFromHref = (href) => {
    const text = String(href || '').trim();
    const match = text.match(/#\/([^?#]+)/);
    if (!match) return '';
    try {
      return normalizePaperId(decodeURIComponent(match[1]));
    } catch {
      return normalizePaperId(match[1]);
    }
  };

  const routeForPaperId = (paperId) => {
    const id = normalizePaperId(paperId);
    return id ? `#/${id}` : '#/';
  };

  const isReaderPaperRouteId = (paperId) => {
    const id = normalizePaperId(paperId).toLowerCase();
    if (!id) return false;
    if (id === 'readme' || id === 'reader-library' || id === 'local-pdf') return false;
    if (/(?:^|\/)readme$/i.test(id)) return false;
    if (/^(?:tutorial|reports|config|settings)(?:\/|$)/i.test(id)) return false;
    if (/^ai_daily_paper_reader(?:_private)?(?:\/|$)/i.test(id)) return false;
    if (/^local-pdf\/\d{8}\/[^/]+$/i.test(id)) return true;
    return /^\d{6}\/\d{2}\/[^/]+$/i.test(id);
  };

  const isExcludedRouteId = (paperId) => {
    return !isReaderPaperRouteId(paperId);
  };

  const inferReaderPaperDate = (paperId) => {
    const id = normalizePaperId(paperId);
    let match = id.match(/^(\d{6})\/(\d{2})(?:\/|$)/);
    if (match) {
      return `${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[2]}`;
    }
    match = id.match(/^local-pdf\/(\d{8})(?:\/|$)/i) || id.match(/^(\d{8})-\d{8}(?:\/|$)/);
    if (match) {
      const raw = match[1];
      return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    }
    return '';
  };

  const normalizeDate = (value, paperId) => {
    const text = normalizeText(value);
    const compact = text.match(/(\d{4})(\d{2})(\d{2})/);
    if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
    const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    return inferReaderPaperDate(paperId);
  };

  const normalizeReaderSection = (value) => {
    const text = normalizeText(value).toLowerCase();
    if (['deep', 'deep_dive', 'deep-dive', '精读', '精读区'].includes(text)) return 'deep';
    if (['quick', 'quick_skim', 'quick-skim', 'skim', '速读', '速读区'].includes(text)) return 'quick';
    return '';
  };

  const readerSectionLabel = (value) => {
    const section = normalizeReaderSection(value);
    if (section === 'deep') return '精读';
    if (section === 'quick') return '速读';
    return '';
  };

  const parseSidebarPayload = (anchor) => {
    const raw = anchor && anchor.getAttribute ? anchor.getAttribute('data-sidebar-item') || '' : '';
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  const normalizeTags = (tags) =>
    (Array.isArray(tags)
      ? tags
      : typeof tags === 'string'
        ? tags.split(/[,\u3001]/)
        : [])
      .map((item) => {
        if (typeof item === 'string') {
          const text = normalizeText(item);
          if (!text) return null;
          const match = text.match(/^([^:]+):(.+)$/);
          return match
            ? { kind: normalizeText(match[1]).toLowerCase() || 'other', label: normalizeText(match[2]) }
            : { kind: 'other', label: text };
        }
        if (!item || typeof item !== 'object') return null;
        const label = normalizeText(item.label || item.name || item.value);
        if (!label) return null;
        return {
          kind: normalizeText(item.kind || item.type || 'other').toLowerCase() || 'other',
          label,
        };
      })
      .filter(Boolean);

  const cleanTopicLabel = (value) => {
    let label = normalizeText(value)
      .replace(/<[^>]+>/g, ' ')
      .replace(/^[\s:：;；,，、.!?！？"()[\]{}-]+/, '')
      .replace(/[\s:：;；,，、.!?！？"()[\]{}-]+$/, '');
    label = normalizeText(label);
    if (!label) return '';
    const lower = label.toLowerCase();
    if (/^(query|search|score)\s*[:：]/i.test(label)) return '';
    if (lower === 'ai4nd' || lower === 'composite' || /:composite$/i.test(label)) return '';
    const hasCjk = /[\u4e00-\u9fff]/.test(label);
    const words = label.split(/\s+/).filter(Boolean);
    if (hasCjk && label.length > 12) return '';
    if (!hasCjk && (words.length > 5 || label.length > 42)) return '';
    return label.length >= 2 ? label : '';
  };

  const normalizeTopicTags = (tags) =>
    (Array.isArray(tags)
      ? tags
      : typeof tags === 'string'
        ? tags.split(/[,;|、，；]+/)
        : [])
      .map((item) => {
        if (typeof item === 'string') {
          const label = cleanTopicLabel(item);
          return label ? { kind: 'topic', label } : null;
        }
        if (!item || typeof item !== 'object') return null;
        const kind = normalizeText(item.kind || item.type || 'topic').toLowerCase() || 'topic';
        const label = cleanTopicLabel(item.label || item.name || item.value);
        return label ? { kind, label } : null;
      })
      .filter(Boolean);

  const paperTagLabels = (paper) =>
    [...(paper && paper.topic_tags ? paper.topic_tags : []), ...(paper && paper.tags ? paper.tags : [])]
      .map((tag) => normalizeText(tag && tag.label))
      .filter(Boolean);

  const isLocalPdfPaper = (paper) => {
    const id = normalizePaperId(paper && paper.paperId).toLowerCase();
    if (id.startsWith('local-pdf/')) return true;
    if (normalizeText(paper && paper.source).toLowerCase() === 'local-pdf') return true;
    return paperTagLabels(paper).some((label) => label.toLowerCase() === '本地pdf');
  };

  const tagsFromSidebarDom = (anchor) => {
    if (!anchor || !anchor.querySelectorAll) return [];
    return Array.from(anchor.querySelectorAll('.dpr-sidebar-tag'))
      .map((node) => {
        if (node.classList && node.classList.contains('dpr-sidebar-tag-score')) return null;
        const label = normalizeText(node.textContent);
        if (!label) return null;
        let kind = 'other';
        if (node.classList && node.classList.contains('dpr-sidebar-tag-keyword')) kind = 'keyword';
        if (node.classList && node.classList.contains('dpr-sidebar-tag-query')) kind = 'query';
        if (node.classList && node.classList.contains('dpr-sidebar-tag-paper')) kind = 'paper';
        return { kind, label };
      })
      .filter(Boolean);
  };

  const scoreFromSidebarDom = (anchor) => {
    if (!anchor || !anchor.querySelector) return '';
    const scoreNode = anchor.querySelector('.dpr-sidebar-tag-score .dpr-stars');
    const title = normalizeText(scoreNode && scoreNode.getAttribute && scoreNode.getAttribute('title'));
    const match = title.match(/([0-9]+(?:\.[0-9]+)?)/);
    return match ? match[1] : '';
  };

  const paperMetaFromSidebarAnchor = (anchor) => {
    if (!anchor || !anchor.getAttribute) return null;
    const paperId = routeIdFromHref(anchor.getAttribute('href') || '');
    if (isExcludedRouteId(paperId)) return null;
    const payload = parseSidebarPayload(anchor);
    const titleNode = anchor.querySelector && anchor.querySelector('.dpr-sidebar-title');
    const title = normalizeText(
      payload.title || payload.title_en || (titleNode && titleNode.textContent) || anchor.textContent || paperId,
    );
    if (!title) return null;
    const route = routeForPaperId(paperId);
    const lastSegment = paperId.split('/').filter(Boolean).slice(-1)[0] || '';
    const isLocalPdf = /^local-pdf\//i.test(paperId);
    const fallbackLink = !isLocalPdf && lastSegment ? `https://arxiv.org/abs/${lastSegment}` : route;
    return {
      paperId,
      route,
      date: normalizeDate(payload.date || payload.published || payload.publication_date, paperId),
      title,
      title_zh: normalizeText(payload.title_zh || payload.titleZh),
      link: normalizeText(payload.link || payload.url || fallbackLink),
      pdf: normalizeText(payload.pdf || payload.pdf_url),
      score: normalizeText(payload.score || scoreFromSidebarDom(anchor)),
      source: normalizeText(payload.source || (isLocalPdf ? 'local-pdf' : '')),
      reader_section: normalizeReaderSection(payload.reader_section || payload.readerSection),
      evidence: normalizeText(payload.evidence),
      topic_tags: normalizeTopicTags(payload.topic_tags || payload.topicTags),
      tags: normalizeTags(payload.tags && payload.tags.length ? payload.tags : tagsFromSidebarDom(anchor)),
    };
  };

  const collectSidebarCatalog = () => {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav) return [];
    const seen = new Set();
    return Array.from(nav.querySelectorAll('a.dpr-sidebar-item-link[href*="#/"]'))
      .map(paperMetaFromSidebarAnchor)
      .filter((paper) => {
        if (!paper || !paper.paperId || seen.has(paper.paperId)) return false;
        seen.add(paper.paperId);
        return true;
      });
  };

  const updateCatalogState = (papers) => {
    state.catalogPaperIds = new Set(
      (Array.isArray(papers) ? papers : [])
        .map((paper) => normalizePaperId(paper && paper.paperId))
        .filter(Boolean),
    );
    state.catalogReady = true;
  };

  const catalogFingerprint = (papers) =>
    papers
      .map((paper) =>
        [
          paper.paperId,
          paper.date,
          paper.title,
          paper.title_zh,
          paper.score,
          paper.reader_section,
          paper.evidence,
          (paper.topic_tags || []).map((tag) => `${tag.kind}:${tag.label}`).join('|'),
          (paper.tags || []).map((tag) => `${tag.kind}:${tag.label}`).join('|'),
        ].join('\u0001'),
      )
      .join('\u0002');

  const syncSidebarCatalog = (store, options = {}) => {
    if (!store) return;
    if (!document.querySelector('.sidebar-nav')) return;
    const catalog = collectSidebarCatalog();
    updateCatalogState(catalog);
    if (!catalog.length) return;
    const fingerprint = catalogFingerprint(catalog);
    if (!options.force && fingerprint === state.catalogFingerprint) return;
    state.catalogFingerprint = fingerprint;
    if (typeof store.upsertPaperCatalog === 'function') {
      store.upsertPaperCatalog(catalog, { dirty: false });
      return;
    }
    catalog.forEach((paper) => {
      if (typeof store.upsertPaperMeta === 'function') store.upsertPaperMeta(paper.paperId, paper, { dirty: false });
    });
  };

  const formatScore = (score) => {
    const text = normalizeText(score);
    if (!text || text === '-') return '';
    const match = text.match(/[-+]?\d+(?:\.\d+)?/);
    if (!match) return text;
    const label = text.replace(match[0], '').trim();
    const value = Number.parseFloat(match[0]);
    const scoreText = Number.isFinite(value) ? value.toFixed(1) : match[0];
    if (/\/\s*10/.test(text)) return text;
    return label ? `${scoreText}/10 ${label}` : `${scoreText}/10`;
  };

  const topicTagsForPaper = (paper) => {
    const seen = new Set();
    const blockedKinds = new Set(['query', 'score', 'reader', 'search']);
    const addSeen = (tag) => {
      const label = cleanTopicLabel(tag && tag.label);
      if (!label) return null;
      const key = label.toLowerCase();
      if (seen.has(key)) return null;
      seen.add(key);
      return { kind: normalizeText(tag.kind || 'topic').toLowerCase() || 'topic', label };
    };
    const topicTags = normalizeTopicTags(paper.topic_tags).map(addSeen).filter(Boolean).slice(0, 5);
    if (topicTags.length >= 5) return topicTags;
    const evidenceTags = isLocalPdfPaper(paper)
      ? []
      : topicTagsFromEvidence(paper)
          .map(addSeen)
          .filter(Boolean)
          .slice(0, 5 - topicTags.length);
    if (topicTags.length + evidenceTags.length >= 5) return topicTags.concat(evidenceTags);
    const explicitTags = normalizeTags(paper.tags)
      .filter((tag) => {
        const kind = normalizeText(tag.kind).toLowerCase();
        if (!['keyword', 'paper', 'topic', 'other'].includes(kind) || blockedKinds.has(kind)) return false;
        const label = cleanTopicLabel(tag.label);
        if (!label) return false;
        tag.label = label;
        const key = label.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 5 - topicTags.length - evidenceTags.length);
    return topicTags.concat(evidenceTags, explicitTags);
  };

  const topicTagsFromEvidence = (paper) => {
    const fields = [
      paper && paper.evidence,
      paper && paper.canonical_evidence,
      paper && paper.llm_evidence,
      paper && paper.llm_evidence_en,
      paper && paper.llm_evidence_cn,
    ];
    return fields.flatMap((value) => {
      const text = normalizeText(value);
      if (!/[,\u3001;；|，]/.test(text) || looksLikeEvidenceSentence(text)) return [];
      const tags = normalizeTopicTags(text);
      return tags.length >= 2 ? tags : [];
    });
  };

  const looksLikeEvidenceSentence = (value) => {
    const text = normalizeText(value);
    if (!text) return false;
    if (/[。.!?！？]/.test(text)) return true;
    const lower = text.toLowerCase();
    if (
      /\b(?:this|the)\s+paper\b|\b(?:proposes|introduces|shows|demonstrates|matches|addresses|improves|uses|applies|presents)\b/.test(
        lower,
      )
    ) {
      return true;
    }
    return /(?:本文|该论文|本论文|提出|使用|通过|证明|显示|表明|匹配|推荐|当前订阅)/.test(text);
  };

  const isRenderablePaper = (paper) => {
    if (!isLocalPdfPaper(paper)) return true;
    if (!state.catalogReady) return true;
    return state.catalogPaperIds.has(normalizePaperId(paper && paper.paperId));
  };

  const filterRenderablePapers = (papers) => (Array.isArray(papers) ? papers.filter(isRenderablePaper) : []);

  const renderTags = (paper) => {
    const tags = [];
    if (paper.date) {
      tags.push(`<span class="dpr-reader-card-tag is-date">${escapeHtml(paper.date)}</span>`);
    }
    const score = formatScore(paper.score);
    if (score) {
      tags.push(`<span class="dpr-reader-card-tag is-score">${escapeHtml(score)}</span>`);
    }
    const sectionLabel = isLocalPdfPaper(paper) ? '' : readerSectionLabel(paper.reader_section);
    if (sectionLabel) {
      const section = normalizeReaderSection(paper.reader_section);
      tags.push(
        `<span class="dpr-reader-card-tag is-section is-${escapeHtml(section)}">${escapeHtml(sectionLabel)}</span>`,
      );
    }
    topicTagsForPaper(paper).forEach((tag) => {
      const kind = cssToken(tag.kind);
      tags.push(
        `<span class="dpr-reader-card-tag is-topic dpr-reader-topic-${kind}">${escapeHtml(tag.label)}</span>`,
      );
    });
    return tags.join('');
  };

  const renderPaper = (paper, index = 0) => {
    const route = paper.route || routeForPaperId(paper.paperId);
    const title = paper.title || paper.paperId || 'Untitled paper';
    const titleZh = normalizeText(paper.title_zh);
    const evidence = normalizeText(paper.evidence);
    const tagsHtml = renderTags(paper);
    const indexText = String((Number.parseInt(index, 10) || 0) + 1).padStart(2, '0');
    return `
      <article class="dpr-reader-card${markerClass(paper.marker)}">
        <div class="dpr-reader-card-index">${escapeHtml(indexText)}</div>
        <div class="dpr-reader-card-main">
          <a class="dpr-reader-card-title" href="${escapeHtml(route)}">${escapeHtml(title)}</a>
          ${titleZh ? `<div class="dpr-reader-card-title-zh">${escapeHtml(titleZh)}</div>` : ''}
          ${tagsHtml ? `<div class="dpr-reader-card-tags">${tagsHtml}</div>` : ''}
          <div class="dpr-reader-card-evidence"><span>推荐依据</span>${escapeHtml(evidence || '-')}</div>
        </div>
      </article>
    `;
  };

  const clampPage = (totalItems) => {
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
    state.page = Math.max(1, Math.min(totalPages, Number.parseInt(state.page, 10) || 1));
    return totalPages;
  };

  const applySearch = () => {
    state.query = normalizeText(state.queryInput);
    state.page = 1;
    render();
  };

  const pageButtonAttrs = (target, disabled) =>
    `type="button" data-reader-page="${target}"${disabled ? ' disabled aria-disabled="true"' : ''}`;

  const renderPagination = (totalPages) => {
    const isFirst = state.page <= 1;
    const isLast = state.page >= totalPages;
    return `
      <div class="dpr-reader-pagination" aria-label="个人论文库分页">
        <button ${pageButtonAttrs('first', isFirst)}>首页</button>
        <button ${pageButtonAttrs('prev', isFirst)}>上一页</button>
        <span>第 ${state.page} / ${totalPages} 页</span>
        <button ${pageButtonAttrs('next', isLast)}>下一页</button>
        <button ${pageButtonAttrs('last', isLast)}>末页</button>
      </div>
    `;
  };

  const render = () => {
    const root = document.getElementById('dpr-reader-library-root');
    if (!root) return;
    const activeId = document.activeElement && document.activeElement.id;
    const store = getStore();
    if (!store) {
      root.innerHTML = '<section class="dpr-reader-library"><div class="dpr-reader-empty">个人论文库不可用。</div></section>';
      return;
    }
    const items = filterRenderablePapers(store.listPapers({
      filter: state.filter,
      query: state.query,
      sort: 'date',
    }));
    const completeItems = filterRenderablePapers(store.listPapers({ filter: 'all', query: '', sort: 'date' }));
    const totalPages = clampPage(items.length);
    const start = (state.page - 1) * PAGE_SIZE;
    const pageItems = items.slice(start, start + PAGE_SIZE);
    const currentCount = items.length;
    const status = store.getState ? store.getState() : {};
    const statusText = status.dirty ? '待同步' : '本地已保存';
    const activeFilter = FILTERS.find((item) => item.key === state.filter) || FILTERS[0];

    root.innerHTML = `
      <section class="dpr-reader-library">
        <header class="dpr-reader-library-head">
          <div>
            <div class="dpr-reader-kicker">Reader Library</div>
            <h1>个人论文库</h1>
          </div>
          <div class="dpr-reader-sync-state">${escapeHtml(statusText)}</div>
        </header>
        <div class="dpr-reader-controls">
          <div class="dpr-reader-tabs" role="tablist" aria-label="Reader library filters">
            ${FILTERS.map((item) => `
              <button type="button" data-reader-filter="${escapeHtml(item.key)}" class="${item.key === activeFilter.key ? 'is-active' : ''}">
                ${escapeHtml(item.label)}
              </button>
            `).join('')}
          </div>
          <div class="dpr-reader-tools" role="search">
            <input id="dpr-reader-search" type="search" value="${escapeHtml(state.queryInput)}" placeholder="搜索论文标题、主题或推荐依据" />
            <button id="dpr-reader-search-btn" type="button">搜索</button>
          </div>
        </div>
        <div class="dpr-reader-count">当前论文数 ${currentCount} / 总论文数 ${completeItems.length}</div>
        <div class="dpr-reader-list">
          ${pageItems.length ? pageItems.map((paper, index) => renderPaper(paper, start + index)).join('') : '<div class="dpr-reader-empty">当前视图暂无论文。</div>'}
        </div>
        ${renderPagination(totalPages)}
      </section>
    `;

    root.querySelectorAll('[data-reader-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.filter = btn.getAttribute('data-reader-filter') || 'all';
        state.page = 1;
        render();
      });
    });
    root.querySelectorAll('[data-reader-page]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-reader-page') || '';
        if (target === 'first') state.page = 1;
        if (target === 'prev') state.page -= 1;
        if (target === 'next') state.page += 1;
        if (target === 'last') state.page = totalPages;
        render();
      });
    });
    const search = root.querySelector('#dpr-reader-search');
    if (search) {
      search.addEventListener('input', () => {
        state.queryInput = search.value || '';
      });
      search.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        state.queryInput = search.value || '';
        applySearch();
      });
    }
    const searchBtn = root.querySelector('#dpr-reader-search-btn');
    if (searchBtn) {
      searchBtn.addEventListener('click', () => {
        const nextSearch = root.querySelector('#dpr-reader-search');
        state.queryInput = nextSearch ? nextSearch.value || '' : state.queryInput;
        applySearch();
      });
    }
    if (activeId === 'dpr-reader-search') {
      const nextSearch = root.querySelector('#dpr-reader-search');
      if (nextSearch && nextSearch.focus) {
        nextSearch.focus();
        if (nextSearch.setSelectionRange) {
          const pos = nextSearch.value.length;
          nextSearch.setSelectionRange(pos, pos);
        }
      }
    }
  };

  const mount = () => {
    const root = document.getElementById('dpr-reader-library-root');
    if (!root) return;
    const store = getStore();
    if (store) syncSidebarCatalog(store);
    if (!state.unsubscribe && store && typeof store.subscribe === 'function') {
      state.unsubscribe = store.subscribe(() => {
        syncSidebarCatalog(store, { force: true });
        render();
      });
    }
    render();
  };

  return {
    mount,
    __test: {
      FILTERS,
      PAGE_SIZE,
      collectSidebarCatalog,
      cleanTopicLabel,
      formatScore,
      isExcludedRouteId,
      isRenderablePaper,
      isReaderPaperRouteId,
      normalizeTopicTags,
      paperMetaFromSidebarAnchor,
      renderPaper,
      state,
      topicTagsForPaper,
      updateCatalogState,
    },
  };
})();
