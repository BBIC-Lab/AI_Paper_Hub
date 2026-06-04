// Personal reader database page rendered inside Docsify.
window.DPRReaderLibrary = (function () {
  const FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'favorite', label: '收藏' },
    { key: 'marker:good', label: 'Core' },
    { key: 'marker:blue', label: 'Novel' },
    { key: 'marker:orange', label: 'Useful' },
    { key: 'marker:bad', label: 'Skim' },
    { key: 'dislike', label: '不喜欢' },
    { key: 'read', label: '已读' },
  ];

  const state = {
    filter: 'all',
    query: '',
    sort: 'updated',
    unsubscribe: null,
  };

  const escapeHtml = (value) =>
    String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const getStore = () =>
    window.DPRReaderStateStore && typeof window.DPRReaderStateStore.listPapers === 'function'
      ? window.DPRReaderStateStore
      : null;

  const markerClass = (marker) => (marker ? ` marker-${escapeHtml(marker)}` : '');

  const renderTags = (paper) => {
    const tags = Array.isArray(paper.tags) ? paper.tags : [];
    const userTags = [];
    if (paper.reaction) userTags.push({ kind: 'reader', label: paper.reaction });
    if (paper.markerLabel) userTags.push({ kind: 'reader', label: paper.markerLabel });
    return userTags
      .concat(tags)
      .slice(0, 8)
      .map((tag) => `<span>${escapeHtml(tag.label || tag)}</span>`)
      .join('');
  };

  const renderPaper = (paper) => {
    const route = paper.route || (paper.paperId ? `#/${paper.paperId}` : '#/');
    const title = paper.title || paper.paperId || 'Untitled paper';
    const subtitle = paper.title_zh || paper.evidence || '';
    const tagsHtml = renderTags(paper);
    const pdfLink = paper.pdf
      ? `<a class="dpr-reader-card-link" href="${escapeHtml(paper.pdf)}" target="_blank" rel="noopener noreferrer">PDF</a>`
      : '';
    return `
      <article class="dpr-reader-card${markerClass(paper.marker)}">
        <div class="dpr-reader-card-main">
          <a class="dpr-reader-card-title" href="${escapeHtml(route)}">${escapeHtml(title)}</a>
          ${subtitle ? `<div class="dpr-reader-card-subtitle">${escapeHtml(subtitle)}</div>` : ''}
          <div class="dpr-reader-card-meta">
            ${paper.date ? `<span>${escapeHtml(paper.date)}</span>` : ''}
            ${paper.source ? `<span>${escapeHtml(paper.source)}</span>` : ''}
            ${paper.score ? `<span>${escapeHtml(paper.score)}</span>` : ''}
          </div>
          <div class="dpr-reader-card-tags">${tagsHtml || '<span>-</span>'}</div>
        </div>
        <div class="dpr-reader-card-actions">
          ${pdfLink}
          <a class="dpr-reader-card-link" href="${escapeHtml(route)}">打开</a>
        </div>
      </article>
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
    const items = store.listPapers({
      filter: state.filter,
      query: state.query,
      sort: state.sort,
    });
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
          <div class="dpr-reader-tools">
            <input id="dpr-reader-search" type="search" value="${escapeHtml(state.query)}" placeholder="搜索" />
            <select id="dpr-reader-sort" aria-label="排序论文">
              <option value="updated" ${state.sort === 'updated' ? 'selected' : ''}>最近更新</option>
              <option value="date" ${state.sort === 'date' ? 'selected' : ''}>日期</option>
              <option value="score" ${state.sort === 'score' ? 'selected' : ''}>评分</option>
            </select>
          </div>
        </div>
        <div class="dpr-reader-count">${items.length} 篇论文</div>
        <div class="dpr-reader-list">
          ${items.length ? items.map(renderPaper).join('') : '<div class="dpr-reader-empty">当前视图暂无论文。</div>'}
        </div>
      </section>
    `;

    root.querySelectorAll('[data-reader-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.filter = btn.getAttribute('data-reader-filter') || 'all';
        render();
      });
    });
    const search = root.querySelector('#dpr-reader-search');
    if (search) {
      search.addEventListener('input', () => {
        state.query = search.value || '';
        render();
      });
    }
    const sort = root.querySelector('#dpr-reader-sort');
    if (sort) {
      sort.addEventListener('change', () => {
        state.sort = sort.value || 'updated';
        render();
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
    if (!state.unsubscribe && getStore() && typeof getStore().subscribe === 'function') {
      state.unsubscribe = getStore().subscribe(() => render());
    }
    render();
  };

  return {
    mount,
    __test: {
      FILTERS,
      renderPaper,
    },
  };
})();
