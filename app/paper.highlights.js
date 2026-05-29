// Paper text highlights: selection popup, inline marks, and repo-backed sync.
window.DPRPaperHighlights = (function () {
  const STORAGE_KEY = 'dpr_paper_text_highlights_v1';
  const SYNC_DELAY_MS = 2500;
  const COLORS = [
    { key: 'yellow', label: '黄色', value: '#fff2a8' },
    { key: 'green', label: '绿色', value: '#c9f7d4' },
    { key: 'blue', label: '蓝色', value: '#cfe8ff' },
    { key: 'purple', label: '紫色', value: '#eadcff' },
    { key: 'red', label: '红色', value: '#ffd6d6' },
  ];

  const state = {
    paperId: '',
    root: null,
    items: [],
    pendingSelection: null,
    popover: null,
    toast: null,
    syncTimer: 0,
    syncInFlight: false,
  };

  const nowIso = () => new Date().toISOString();

  const isPaperFile = (file) =>
    /^(?:\d{6}\/\d{2}|\d{8}-\d{8}|local-pdf\/\d{8})\/(?!README\.md$).+\.md$/i.test(
      String(file || ''),
    );

  const paperIdFromFile = (file) =>
    isPaperFile(file) ? String(file || '').replace(/\.md$/i, '') : '';

  const normalizeColor = (color) => {
    const found = COLORS.find((item) => item.key === color || item.value === color);
    return found ? found.value : COLORS[0].value;
  };

  const escapeHtml = (value) =>
    String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const loadStore = () => {
    try {
      if (!window.localStorage) return { papers: {} };
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' && parsed.papers
        ? parsed
        : { papers: {} };
    } catch {
      return { papers: {} };
    }
  };

  const saveStore = (store) => {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store || { papers: {} }));
    } catch {
      // ignore
    }
  };

  const sanitizeItems = (items) =>
    (Array.isArray(items) ? items : [])
      .map((item) => {
        const start = Number(item && item.start);
        const end = Number(item && item.end);
        return {
          id: String((item && item.id) || '').trim(),
          start,
          end,
          text: String((item && item.text) || ''),
          color: normalizeColor(item && item.color),
          createdAt: String((item && item.createdAt) || nowIso()),
          updatedAt: String((item && item.updatedAt) || nowIso()),
        };
      })
      .filter((item) => item.id && Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start);

  const getRecord = (paperId) => {
    const store = loadStore();
    const record = (store.papers && store.papers[paperId]) || {};
    return {
      paperId,
      items: sanitizeItems(record.items),
      updatedAt: String(record.updatedAt || ''),
      lastSyncedAt: String(record.lastSyncedAt || ''),
      dirty: !!record.dirty,
    };
  };

  const setRecord = (paperId, patch) => {
    if (!paperId) return;
    const store = loadStore();
    store.papers = store.papers || {};
    const prev = getRecord(paperId);
    store.papers[paperId] = Object.assign({}, prev, patch, {
      paperId,
      items: sanitizeItems((patch && patch.items) || prev.items),
    });
    saveStore(store);
  };

  const getRoot = () =>
    document.querySelector('.markdown-section .dpr-page-content') ||
    document.querySelector('.markdown-section');

  const getDocsifyBasePath = () => {
    const bp =
      window.$docsify && typeof window.$docsify.basePath === 'string'
        ? window.$docsify.basePath
        : 'docs/';
    return /\/$/.test(bp) ? bp : `${bp}/`;
  };

  const highlightRepoPath = (paperId) => `docs/highlights/${paperId}.json`;
  const highlightFetchPath = (paperId) => `${getDocsifyBasePath()}highlights/${paperId}.json`;

  const isIgnoredTextNodeParent = (parent) => {
    if (!parent) return true;
    return !!parent.closest('script, style, textarea, input, button, .dpr-highlight-popover');
  };

  const getTextNodes = (root) => {
    const nodes = [];
    if (!root || !document.createTreeWalker) return nodes;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node && node.parentElement;
        return isIgnoredTextNodeParent(parent)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    let node = walker.nextNode();
    while (node) {
      nodes.push(node);
      node = walker.nextNode();
    }
    return nodes;
  };

  const unwrapRenderedHighlights = (root) => {
    if (!root) return;
    root.querySelectorAll('span.dpr-paper-text-highlight').forEach((span) => {
      const parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) {
        parent.insertBefore(span.firstChild, span);
      }
      span.remove();
      parent.normalize();
    });
  };

  const getAcceptedText = (root) =>
    getTextNodes(root).map((node) => node.nodeValue || '').join('');

  const findNearestTextIndex = (rootText, text, near) => {
    if (!text) return -1;
    let best = -1;
    let bestDistance = Infinity;
    let from = 0;
    while (from <= rootText.length) {
      const idx = rootText.indexOf(text, from);
      if (idx < 0) break;
      const distance = Math.abs(idx - near);
      if (distance < bestDistance) {
        best = idx;
        bestDistance = distance;
      }
      from = idx + Math.max(1, text.length);
    }
    return best;
  };

  const resolveStoredRanges = (items, rootText) => {
    const resolved = [];
    let lastEnd = -1;
    sanitizeItems(items)
      .sort((a, b) => a.start - b.start || a.end - b.end)
      .forEach((item) => {
        let start = item.start;
        let end = item.end;
        if (rootText.slice(start, end) !== item.text && item.text) {
          const idx = findNearestTextIndex(rootText, item.text, start);
          if (idx >= 0) {
            start = idx;
            end = idx + item.text.length;
          }
        }
        if (start < 0 || end > rootText.length || end <= start) return;
        if (start < lastEnd) return;
        resolved.push(Object.assign({}, item, { start, end }));
        lastEnd = end;
      });
    return resolved;
  };

  const wrapTextSegment = (node, start, end, item) => {
    if (!node || start >= end) return;
    const len = node.nodeValue.length;
    let target = node;
    if (end < len) {
      target.splitText(end);
    }
    if (start > 0) {
      target = target.splitText(start);
    }
    const span = document.createElement('span');
    span.className = 'dpr-paper-text-highlight';
    span.dataset.highlightId = item.id;
    span.style.setProperty('--dpr-highlight-color', normalizeColor(item.color));
    span.title = '点击修改高亮';
    target.parentNode.insertBefore(span, target);
    span.appendChild(target);
  };

  const applySingleHighlight = (root, item) => {
    const nodes = getTextNodes(root).map((node) => ({
      node,
      len: node.nodeValue.length,
    }));
    let offset = 0;
    nodes.forEach(({ node, len }) => {
      const nodeStart = offset;
      const nodeEnd = offset + len;
      offset = nodeEnd;
      const start = Math.max(item.start, nodeStart);
      const end = Math.min(item.end, nodeEnd);
      if (start >= end) return;
      wrapTextSegment(node, start - nodeStart, end - nodeStart, item);
    });
  };

  const renderHighlights = () => {
    const root = state.root;
    if (!root) return;
    unwrapRenderedHighlights(root);
    const rootText = getAcceptedText(root);
    const items = resolveStoredRanges(state.items, rootText);
    state.items = items;
    items.forEach((item) => applySingleHighlight(root, item));
  };

  const rangeInsideRoot = (range, root) => {
    if (!range || !root) return false;
    const startNode = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range.startContainer.parentNode;
    const endNode = range.endContainer.nodeType === Node.ELEMENT_NODE
      ? range.endContainer
      : range.endContainer.parentNode;
    return root.contains(startNode) && root.contains(endNode);
  };

  const getRangeOffsets = (range, root) => {
    const fallbackText = range && typeof range.toString === 'function' ? range.toString() : '';
    const fallbackRootText = getAcceptedText(root);
    const fallbackIndex = () => findNearestTextIndex(fallbackRootText, fallbackText, 0);
    const nodes = getTextNodes(root);
    let cursor = 0;
    let start = null;
    let end = null;
    let text = '';

    try {
      nodes.forEach((node) => {
        const len = node.nodeValue.length;
        let intersects = false;
        try {
          intersects = range.intersectsNode(node);
        } catch {
          intersects = range.startContainer === node || range.endContainer === node;
        }

        if (!intersects) {
          cursor += len;
          return;
        }

        const sliceStart = range.startContainer === node ? range.startOffset : 0;
        const sliceEnd = range.endContainer === node ? range.endOffset : len;
        if (sliceEnd > sliceStart) {
          if (start === null) start = cursor + sliceStart;
          end = cursor + sliceEnd;
          text += node.nodeValue.slice(sliceStart, sliceEnd);
        }
        cursor += len;
      });
    } catch (err) {
      const idx = fallbackIndex();
      return {
        start: idx >= 0 ? idx : 0,
        end: idx >= 0 ? idx + fallbackText.length : 0,
        text: idx >= 0 ? fallbackText : '',
      };
    }

    if ((!text || !text.trim()) && fallbackText && fallbackText.trim()) {
      const idx = fallbackIndex();
      if (idx >= 0) {
        return {
          start: idx,
          end: idx + fallbackText.length,
          text: fallbackText,
        };
      }
    }

    return {
      start: start == null ? 0 : start,
      end: end == null ? 0 : end,
      text,
    };
  };

  const hidePopover = () => {
    if (state.popover) {
      state.popover.classList.remove('is-open');
    }
    state.pendingSelection = null;
  };

  const clampPopoverPosition = (x, y, popover) => {
    const rect = popover.getBoundingClientRect();
    const pad = 10;
    const left = Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad));
    const top = Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad));
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  };

  const ensurePopover = () => {
    if (state.popover && document.body.contains(state.popover)) return state.popover;
    const popover = document.createElement('div');
    popover.className = 'dpr-highlight-popover';
    popover.addEventListener('mousedown', (event) => event.preventDefault());
    popover.addEventListener('click', (event) => {
      const colorBtn = event.target && event.target.closest
        ? event.target.closest('[data-highlight-color]')
        : null;
      const deleteBtn = event.target && event.target.closest
        ? event.target.closest('[data-highlight-action="delete"]')
        : null;
      if (colorBtn) {
        const color = colorBtn.getAttribute('data-highlight-color');
        if (popover.dataset.mode === 'edit') {
          updateHighlightColor(popover.dataset.highlightId || '', color);
        } else {
          addHighlightFromPending(color);
        }
        hidePopover();
        return;
      }
      if (deleteBtn) {
        deleteHighlight(popover.dataset.highlightId || '');
        hidePopover();
      }
    });
    document.body.appendChild(popover);
    state.popover = popover;
    return popover;
  };

  const renderPopover = ({ mode, highlightId = '', x = 0, y = 0 }) => {
    const popover = ensurePopover();
    popover.dataset.mode = mode;
    popover.dataset.highlightId = highlightId;
    const isEdit = mode === 'edit';
    popover.innerHTML = [
      `<div class="dpr-highlight-popover-title">${isEdit ? '修改高亮' : '选择高亮颜色'}</div>`,
      '<div class="dpr-highlight-color-row">',
      COLORS.map((item) => (
        `<button type="button" class="dpr-highlight-color-btn" data-highlight-color="${escapeHtml(item.value)}" title="${escapeHtml(item.label)}" aria-label="${escapeHtml(item.label)}" style="--dpr-highlight-swatch:${escapeHtml(item.value)}"></button>`
      )).join(''),
      '</div>',
      isEdit
        ? '<button type="button" class="dpr-highlight-delete-btn" data-highlight-action="delete">删除高亮</button>'
        : '',
    ].join('');
    popover.classList.add('is-open');
    requestAnimationFrame(() => clampPopoverPosition(x, y, popover));
  };

  const showToast = (message, tone = 'info') => {
    if (!message) return;
    if (!state.toast || !document.body.contains(state.toast)) {
      state.toast = document.createElement('div');
      state.toast.className = 'dpr-highlight-toast';
      document.body.appendChild(state.toast);
    }
    state.toast.textContent = message;
    state.toast.dataset.tone = tone;
    state.toast.classList.add('is-visible');
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      if (state.toast) state.toast.classList.remove('is-visible');
    }, 2600);
  };

  const saveItems = (items, options = {}) => {
    const paperId = state.paperId;
    if (!paperId) return;
    const updatedAt = nowIso();
    state.items = sanitizeItems(items);
    setRecord(paperId, {
      items: state.items,
      updatedAt,
      dirty: options.dirty !== false,
    });
    renderHighlights();
    if (options.dirty !== false) {
      if (canSyncToRepo()) {
        scheduleSync();
        showToast('高亮已保存，稍后同步到仓库。');
      } else {
        showToast('高亮已保存到当前浏览器。');
      }
    }
  };

  const addHighlightFromPending = (color) => {
    const pending = state.pendingSelection;
    if (!pending || pending.end <= pending.start || !state.paperId) return;
    const id = `hl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const item = {
      id,
      start: pending.start,
      end: pending.end,
      text: pending.text,
      color: normalizeColor(color),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const next = state.items.filter((old) => old.end <= item.start || old.start >= item.end);
    next.push(item);
    saveItems(next);
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
  };

  const updateHighlightColor = (id, color) => {
    if (!id) return;
    saveItems(
      state.items.map((item) =>
        item.id === id
          ? Object.assign({}, item, { color: normalizeColor(color), updatedAt: nowIso() })
          : item,
      ),
    );
  };

  const deleteHighlight = (id) => {
    if (!id) return;
    saveItems(state.items.filter((item) => item.id !== id));
  };

  const onMouseUp = (event) => {
    window.setTimeout(() => {
      if (!state.paperId || !state.root) return;
      const selection = window.getSelection && window.getSelection();
      if (!selection || selection.rangeCount < 1 || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      if (!rangeInsideRoot(range, state.root)) return;
      const pending = getRangeOffsets(range, state.root);
      if (!pending.text || !pending.text.trim()) return;
      state.pendingSelection = pending;
      renderPopover({
        mode: 'new',
        x: event.clientX || window.innerWidth / 2,
        y: (event.clientY || window.innerHeight / 2) + 12,
      });
    }, 0);
  };

  const onDocumentClick = (event) => {
    const target = event.target;
    const mark = target && target.closest ? target.closest('.dpr-paper-text-highlight') : null;
    if (mark && state.root && state.root.contains(mark)) {
      event.preventDefault();
      event.stopPropagation();
      const selection = window.getSelection && window.getSelection();
      if (selection && selection.removeAllRanges) selection.removeAllRanges();
      renderPopover({
        mode: 'edit',
        highlightId: mark.dataset.highlightId || '',
        x: event.clientX || window.innerWidth / 2,
        y: (event.clientY || window.innerHeight / 2) + 12,
      });
      return;
    }
    if (state.popover && target && !state.popover.contains(target)) {
      hidePopover();
    }
  };

  const getAccessMode = () => String(window.DPR_ACCESS_MODE || '').toLowerCase();

  const hasConfiguredGithubToken = () => {
    const secret = window.decoded_secret_private || {};
    if (secret.github && secret.github.token) return true;
    const api = window.SubscriptionsGithubToken;
    if (api && typeof api.loadGithubToken === 'function') {
      try {
        const tokenData = api.loadGithubToken();
        return !!(tokenData && tokenData.token);
      } catch {
        return false;
      }
    }
    return false;
  };

  const canSyncToRepo = () => {
    const api = window.SubscriptionsGithubToken;
    return (
      getAccessMode() === 'full' &&
      !!api &&
      typeof api.commitRepoChanges === 'function' &&
      hasConfiguredGithubToken()
    );
  };

  const scheduleSync = () => {
    if (!canSyncToRepo()) return;
    window.clearTimeout(state.syncTimer);
    state.syncTimer = window.setTimeout(() => {
      syncNow({ silent: true });
    }, SYNC_DELAY_MS);
  };

  const syncNow = async (options = {}) => {
    const paperId = state.paperId;
    if (!paperId || state.syncInFlight || !canSyncToRepo()) return;
    const api = window.SubscriptionsGithubToken;
    if (!api || typeof api.commitRepoChanges !== 'function') return;
    const record = getRecord(paperId);
    if (!record.dirty) return;

    state.syncInFlight = true;
    const syncUpdatedAt = record.updatedAt || nowIso();
    const payload = {
      version: 1,
      paperId,
      updatedAt: syncUpdatedAt,
      highlights: sanitizeItems(record.items),
    };
    const path = highlightRepoPath(paperId);
    try {
      await api.commitRepoChanges(
        payload.highlights.length
          ? {
              updates: [{ path, content: `${JSON.stringify(payload, null, 2)}\n` }],
              deletes: [],
            }
          : {
              updates: [],
              deletes: [path],
            },
        `chore: sync paper highlights: ${paperId.split('/').pop()}`,
        { requireWorkflow: false },
      );
      const latest = getRecord(paperId);
      if (latest.updatedAt === syncUpdatedAt) {
        setRecord(paperId, {
          items: latest.items,
          updatedAt: latest.updatedAt,
          dirty: false,
          lastSyncedAt: nowIso(),
        });
      } else {
        scheduleSync();
      }
      if (!options.silent) showToast('高亮已同步到仓库。', 'success');
    } catch (err) {
      if (!options.silent) {
        showToast(`高亮同步失败：${err && err.message ? err.message : err}`, 'error');
      }
      window.console && console.warn && console.warn('DPR highlight sync failed', err);
    } finally {
      state.syncInFlight = false;
    }
  };

  const loadRemote = async (paperId) => {
    const local = getRecord(paperId);
    if (local.dirty) return;
    try {
      const res = await fetch(highlightFetchPath(paperId), { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || data.paperId !== paperId || !Array.isArray(data.highlights)) return;
      const remoteUpdatedAt = String(data.updatedAt || '');
      if (local.updatedAt && remoteUpdatedAt && remoteUpdatedAt <= local.updatedAt) return;
      setRecord(paperId, {
        items: sanitizeItems(data.highlights),
        updatedAt: remoteUpdatedAt || nowIso(),
        dirty: false,
        lastSyncedAt: nowIso(),
      });
      if (state.paperId === paperId) {
        state.items = getRecord(paperId).items;
        renderHighlights();
      }
    } catch {
      // Missing highlight files and offline reads are non-fatal.
    }
  };

  const initForRoute = (vm) => {
    const file = vm && vm.route ? vm.route.file : '';
    const paperId = paperIdFromFile(file);
    hidePopover();
    window.clearTimeout(state.syncTimer);
    if (!paperId) {
      state.paperId = '';
      state.root = null;
      state.items = [];
      return;
    }
    state.paperId = paperId;
    state.root = getRoot();
    state.items = getRecord(paperId).items;
    renderHighlights();
    loadRemote(paperId);
    scheduleSync();
  };

  const bindGlobalEvents = () => {
    if (window.__DPR_PAPER_HIGHLIGHTS_BOUND__) return;
    window.__DPR_PAPER_HIGHLIGHTS_BOUND__ = true;
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('keyup', (event) => {
      if (event.key === 'Escape') hidePopover();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') syncNow({ silent: true });
    });
    window.addEventListener('pagehide', () => {
      syncNow({ silent: true });
    });
  };

  const registerDocsifyPlugin = () => {
    window.$docsify = window.$docsify || {};
    window.$docsify.plugins = [].concat(window.$docsify.plugins || [], function (hook, vm) {
      hook.doneEach(function () {
        bindGlobalEvents();
        window.setTimeout(() => initForRoute(vm), 0);
      });
    });
  };

  registerDocsifyPlugin();

  return {
    syncNow,
    getRecord,
  };
})();
