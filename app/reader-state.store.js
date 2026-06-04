// Repo-backed personal reader database for paper reactions and color markers.
window.DPRReaderStateStore = (function () {
  const SCHEMA_VERSION = 1;
  const LOCAL_STORAGE_KEY = 'dpr_reader_state_v1';
  const LEGACY_READ_STORAGE_KEY = 'dpr_read_papers_v1';
  const LEGACY_REACTION_STORAGE_KEY = 'dpr_paper_reactions_v1';
  const LEGACY_MARKER_LABEL_STORAGE_KEY = 'dpr_paper_marker_labels_v1';
  const DEFAULT_REPO_PATH = 'docs/reader-db/state.enc.json';
  const SYNC_DELAY_MS = 1500;

  const COLOR_MARKERS = [
    { key: 'good', label: 'Core', color: '#52c41a' },
    { key: 'blue', label: 'Novel', color: '#1890ff' },
    { key: 'orange', label: 'Useful', color: '#8a63d2' },
    { key: 'bad', label: 'Skim', color: '#f5222d' },
  ];
  const COLOR_MARKER_KEYS = COLOR_MARKERS.map((item) => item.key);
  const REACTION_KEYS = ['favorite', 'dislike'];
  const DEFAULT_MARKER_LABELS = COLOR_MARKERS.reduce((acc, item) => {
    acc[item.key] = item.label;
    return acc;
  }, {});

  const runtime = {
    state: null,
    syncTimer: 0,
    syncInFlight: false,
    remoteLoaded: false,
    subscribers: [],
    status: { mode: 'local', message: '' },
  };

  const nowIso = () => new Date().toISOString();
  const clone = (value) => JSON.parse(JSON.stringify(value || {}));
  const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  const normalizeText = (value) => String(value || '').trim();
  const isColorMarkerKey = (value) => COLOR_MARKER_KEYS.includes(value);
  const normalizeReaction = (value) => (REACTION_KEYS.includes(value) ? value : '');
  const normalizeRepoPath = (value) =>
    normalizeText(value).replace(/^\/+/, '').replace(/\/{2,}/g, '/') || DEFAULT_REPO_PATH;

  const sanitizeMarkerLabel = (value, fallback) => {
    const text = normalizeText(value);
    if (!text) return fallback;
    return text.split(/\s+/)[0].slice(0, 18) || fallback;
  };

  const getDefaultMarkerLabels = () => Object.assign({}, DEFAULT_MARKER_LABELS);

  const normalizeMarkerLabels = (labels) => {
    const normalized = getDefaultMarkerLabels();
    if (!isPlainObject(labels)) return normalized;
    COLOR_MARKERS.forEach((item) => {
      normalized[item.key] = sanitizeMarkerLabel(labels[item.key], item.label);
    });
    return normalized;
  };

  const normalizeTags = (tags) =>
    (Array.isArray(tags) ? tags : [])
      .map((item) => {
        if (typeof item === 'string') {
          const text = normalizeText(item);
          if (!text) return null;
          const m = text.match(/^([^:]+):(.+)$/);
          return m
            ? { kind: normalizeText(m[1]).toLowerCase() || 'other', label: normalizeText(m[2]) }
            : { kind: 'other', label: text };
        }
        if (!isPlainObject(item)) return null;
        const label = normalizeText(item.label || item.name || item.value);
        if (!label) return null;
        return {
          kind: normalizeText(item.kind || item.type || 'other').toLowerCase() || 'other',
          label,
        };
      })
      .filter(Boolean);

  const normalizePaperId = (paperId) =>
    normalizeText(paperId).replace(/^#\//, '').replace(/\.md$/i, '').replace(/\/$/, '');

  const routeForPaperId = (paperId, route) => {
    const cleanRoute = normalizeText(route);
    if (cleanRoute) return cleanRoute.startsWith('#/') ? cleanRoute : `#/${cleanRoute.replace(/^\/+/, '')}`;
    const id = normalizePaperId(paperId);
    return id ? `#/${id}` : '';
  };

  const normalizePaperRecord = (raw, fallbackPaperId = '') => {
    const source = isPlainObject(raw) ? raw : {};
    const paperId = normalizePaperId(source.paperId || source.paper_id || fallbackPaperId);
    if (!paperId) return null;
    const marker = isColorMarkerKey(source.marker) ? source.marker : '';
    const reaction = normalizeReaction(source.reaction);
    const read = source.read === false ? false : !!(source.read || marker || reaction);
    return {
      paperId,
      title: normalizeText(source.title || source.title_en),
      title_zh: normalizeText(source.title_zh || source.titleZh),
      date: normalizeText(source.date),
      source: normalizeText(source.source),
      selection_source: normalizeText(source.selection_source),
      route: routeForPaperId(paperId, source.route || source.href),
      link: normalizeText(source.link || source.url),
      pdf: normalizeText(source.pdf || source.pdf_url),
      score: normalizeText(source.score),
      evidence: normalizeText(source.evidence),
      tags: normalizeTags(source.tags),
      reaction,
      marker,
      read,
      updatedAt: normalizeText(source.updatedAt) || nowIso(),
    };
  };

  const emptyState = () => ({
    schemaVersion: SCHEMA_VERSION,
    updatedAt: nowIso(),
    markerLabels: getDefaultMarkerLabels(),
    papers: {},
    dirty: false,
    lastSyncedAt: '',
  });

  const normalizeState = (raw) => {
    const source = isPlainObject(raw) ? raw : {};
    const out = emptyState();
    out.schemaVersion = SCHEMA_VERSION;
    out.updatedAt = normalizeText(source.updatedAt) || out.updatedAt;
    out.markerLabels = normalizeMarkerLabels(source.markerLabels);
    out.dirty = !!source.dirty;
    out.lastSyncedAt = normalizeText(source.lastSyncedAt);
    const papers = isPlainObject(source.papers) ? source.papers : {};
    Object.keys(papers).forEach((paperId) => {
      const record = normalizePaperRecord(papers[paperId], paperId);
      if (record) out.papers[record.paperId] = record;
    });
    return out;
  };

  const compareUpdatedAt = (left, right) => {
    const a = Date.parse(left || '') || 0;
    const b = Date.parse(right || '') || 0;
    if (a === b) return 0;
    return a > b ? 1 : -1;
  };

  const mergeStates = (baseState, incomingState) => {
    const base = normalizeState(baseState);
    const incoming = normalizeState(incomingState);
    const out = normalizeState(base);
    if (compareUpdatedAt(incoming.updatedAt, out.updatedAt) >= 0) {
      out.markerLabels = normalizeMarkerLabels(
        Object.assign({}, out.markerLabels, incoming.markerLabels),
      );
      out.updatedAt = incoming.updatedAt || out.updatedAt;
    }
    Object.keys(incoming.papers || {}).forEach((paperId) => {
      const current = out.papers[paperId];
      const next = incoming.papers[paperId];
      if (!current || compareUpdatedAt(next.updatedAt, current.updatedAt) >= 0) {
        out.papers[paperId] = next;
      }
    });
    out.dirty = !!(base.dirty || incoming.dirty);
    out.lastSyncedAt = base.lastSyncedAt || incoming.lastSyncedAt || '';
    return out;
  };

  const readJsonStorage = (key) => {
    try {
      if (!window.localStorage) return null;
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  const writeJsonStorage = (key, value) => {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(key, JSON.stringify(value || {}));
    } catch {
      // ignore
    }
  };

  const buildLegacyState = () => {
    const state = emptyState();
    const readState = readJsonStorage(LEGACY_READ_STORAGE_KEY) || {};
    const reactions = readJsonStorage(LEGACY_REACTION_STORAGE_KEY) || {};
    state.markerLabels = normalizeMarkerLabels(readJsonStorage(LEGACY_MARKER_LABEL_STORAGE_KEY));
    const ids = new Set([...Object.keys(readState || {}), ...Object.keys(reactions || {})]);
    ids.forEach((rawId) => {
      const paperId = normalizePaperId(rawId);
      if (!paperId) return;
      const status = readState[rawId];
      const marker = isColorMarkerKey(status) ? status : '';
      const reaction = normalizeReaction(reactions[rawId]);
      if (!marker && !reaction && !(status === true || status === 'read')) return;
      state.papers[paperId] = normalizePaperRecord({
        paperId,
        marker,
        reaction,
        read: true,
        updatedAt: state.updatedAt,
      });
    });
    return state;
  };

  const loadLocalState = () => {
    const rawCurrent = readJsonStorage(LOCAL_STORAGE_KEY);
    const current = normalizeState(rawCurrent);
    const legacy = buildLegacyState();
    const merged = rawCurrent ? mergeStates(legacy, current) : legacy;
    if (rawCurrent && !isPlainObject(rawCurrent.markerLabels)) {
      merged.markerLabels = normalizeMarkerLabels(legacy.markerLabels);
    }
    if (Object.keys(legacy.papers).length || Object.keys(current.papers).length) {
      writeJsonStorage(LOCAL_STORAGE_KEY, merged);
    }
    return merged;
  };

  const saveLocalState = (state) => {
    runtime.state = normalizeState(state);
    writeJsonStorage(LOCAL_STORAGE_KEY, runtime.state);
    notify();
  };

  const ensureState = () => {
    if (!runtime.state) runtime.state = loadLocalState();
    return runtime.state;
  };

  const stateForRemote = (state) => {
    const normalized = normalizeState(state);
    return {
      schemaVersion: normalized.schemaVersion,
      updatedAt: normalized.updatedAt,
      markerLabels: normalized.markerLabels,
      papers: normalized.papers,
    };
  };

  const notify = () => {
    const snapshot = getState();
    runtime.subscribers.forEach((fn) => {
      try {
        fn(snapshot, runtime.status);
      } catch {
        // ignore
      }
    });
    try {
      document.dispatchEvent(
        new CustomEvent('dpr-reader-state-changed', {
          detail: { state: snapshot, status: runtime.status },
        }),
      );
    } catch {
      // ignore
    }
  };

  const setStatus = (mode, message) => {
    runtime.status = { mode: mode || 'local', message: message || '' };
    notify();
  };

  const getState = () => clone(ensureState());
  const getMarkerLabels = () => normalizeMarkerLabels(ensureState().markerLabels);

  const getReadStateObject = () => {
    const out = {};
    const state = ensureState();
    Object.keys(state.papers).forEach((paperId) => {
      const paper = state.papers[paperId];
      if (!paper || !paper.read) return;
      out[paperId] = isColorMarkerKey(paper.marker) ? paper.marker : 'read';
    });
    return out;
  };

  const getReactionStateObject = () => {
    const out = {};
    const state = ensureState();
    Object.keys(state.papers).forEach((paperId) => {
      const reaction = normalizeReaction(state.papers[paperId] && state.papers[paperId].reaction);
      if (reaction) out[paperId] = reaction;
    });
    return out;
  };

  const getPaper = (paperId) => {
    const id = normalizePaperId(paperId);
    return id ? clone(ensureState().papers[id] || {}) : {};
  };

  const mutatePaper = (paperId, patch, meta, options = {}) => {
    const id = normalizePaperId(paperId);
    if (!id) return getState();
    const state = ensureState();
    const prev = state.papers[id] || normalizePaperRecord({ paperId: id });
    const merged = normalizePaperRecord(
      Object.assign({}, prev, meta || {}, patch || {}, {
        paperId: id,
        updatedAt: options.updatedAt || nowIso(),
      }),
      id,
    );
    if (!merged) return getState();
    state.papers[id] = merged;
    state.updatedAt = merged.updatedAt;
    state.dirty = options.dirty !== false;
    saveLocalState(state);
    if (state.dirty && options.sync !== false) scheduleSync();
    return getState();
  };

  const upsertPaperMeta = (paperId, meta = {}, options = {}) => {
    const id = normalizePaperId(paperId || meta.paperId || meta.paper_id);
    if (!id) return getState();
    const state = ensureState();
    const prev = state.papers[id] || normalizePaperRecord({ paperId: id });
    const merged = normalizePaperRecord(
      Object.assign({}, prev, meta || {}, {
        paperId: id,
        updatedAt: options.updatedAt || (prev && prev.updatedAt) || nowIso(),
      }),
      id,
    );
    if (!merged) return getState();
    state.papers[id] = merged;
    if (options.dirty) {
      state.updatedAt = options.updatedAt || nowIso();
      state.dirty = true;
    }
    saveLocalState(state);
    if (options.dirty && options.sync !== false) scheduleSync();
    return getState();
  };

  const setRead = (paperId, meta = {}, options = {}) =>
    mutatePaper(paperId, { read: true }, meta, options);

  const setReaction = (paperId, reaction, meta = {}, options = {}) => {
    const current = getPaper(paperId);
    const normalized = normalizeReaction(reaction);
    const nextReaction = current.reaction === normalized ? '' : normalized;
    return mutatePaper(paperId, { reaction: nextReaction, read: true }, meta, options);
  };

  const setMarker = (paperId, marker, meta = {}, options = {}) => {
    const current = getPaper(paperId);
    const normalized = isColorMarkerKey(marker) ? marker : '';
    const nextMarker = current.marker === normalized ? '' : normalized;
    return mutatePaper(paperId, { marker: nextMarker, read: true }, meta, options);
  };

  const setMarkerLabels = (labels, options = {}) => {
    const state = ensureState();
    state.markerLabels = normalizeMarkerLabels(labels);
    state.updatedAt = options.updatedAt || nowIso();
    state.dirty = options.dirty !== false;
    saveLocalState(state);
    if (state.dirty && options.sync !== false) scheduleSync();
    return getMarkerLabels();
  };

  const replaceReadStateObject = (readState, options = {}) => {
    const state = ensureState();
    const normalized = isPlainObject(readState) ? readState : {};
    Object.keys(state.papers).forEach((paperId) => {
      const status = normalized[paperId];
      if (status === true || status === 'read') {
        state.papers[paperId].read = true;
        state.papers[paperId].marker = '';
      } else if (isColorMarkerKey(status)) {
        state.papers[paperId].read = true;
        state.papers[paperId].marker = status;
      } else {
        state.papers[paperId].read = !!state.papers[paperId].reaction;
        state.papers[paperId].marker = '';
      }
      state.papers[paperId].updatedAt = options.updatedAt || nowIso();
    });
    Object.keys(normalized).forEach((rawId) => {
      const paperId = normalizePaperId(rawId);
      if (!paperId || state.papers[paperId]) return;
      const status = normalized[rawId];
      const marker = isColorMarkerKey(status) ? status : '';
      const read = !!(marker || status === true || status === 'read');
      if (!read) return;
      state.papers[paperId] = normalizePaperRecord({
        paperId,
        read: true,
        marker,
        updatedAt: options.updatedAt || nowIso(),
      });
    });
    state.updatedAt = options.updatedAt || nowIso();
    state.dirty = options.dirty !== false;
    saveLocalState(state);
    if (state.dirty && options.sync !== false) scheduleSync();
    return getReadStateObject();
  };

  const replaceReactionStateObject = (reactionState, options = {}) => {
    const state = ensureState();
    const normalized = isPlainObject(reactionState) ? reactionState : {};
    Object.keys(state.papers).forEach((paperId) => {
      state.papers[paperId].reaction = normalizeReaction(normalized[paperId]);
      state.papers[paperId].read = !!(state.papers[paperId].read || state.papers[paperId].reaction);
      state.papers[paperId].updatedAt = options.updatedAt || nowIso();
    });
    Object.keys(normalized).forEach((rawId) => {
      const paperId = normalizePaperId(rawId);
      if (!paperId || state.papers[paperId]) return;
      const reaction = normalizeReaction(normalized[rawId]);
      if (!reaction) return;
      state.papers[paperId] = normalizePaperRecord({
        paperId,
        reaction,
        read: true,
        updatedAt: options.updatedAt || nowIso(),
      });
    });
    state.updatedAt = options.updatedAt || nowIso();
    state.dirty = options.dirty !== false;
    saveLocalState(state);
    if (state.dirty && options.sync !== false) scheduleSync();
    return getReactionStateObject();
  };

  const paperMatchesTag = (paper, tag) => {
    const key = normalizeText(tag || 'all').toLowerCase();
    if (!key || key === 'all') return true;
    if (key === 'read') return !!paper.read;
    if (key === 'favorite' || key === 'dislike') return paper.reaction === key;
    if (key.startsWith('marker:')) return paper.marker === key.slice(7);
    if (key.startsWith('tag:')) {
      const needle = key.slice(4);
      return (paper.tags || []).some((item) => normalizeText(item.label).toLowerCase() === needle);
    }
    return (
      paper.marker === key ||
      paper.reaction === key ||
      (paper.tags || []).some((item) => normalizeText(item.label).toLowerCase() === key)
    );
  };

  const paperMatchesQuery = (paper, query) => {
    const needle = normalizeText(query).toLowerCase();
    if (!needle) return true;
    return [
      paper.title,
      paper.title_zh,
      paper.source,
      paper.evidence,
      paper.score,
      ...(paper.tags || []).map((item) => item.label),
    ]
      .map((value) => normalizeText(value).toLowerCase())
      .some((value) => value.includes(needle));
  };

  const listPapers = (options = {}) => {
    const state = ensureState();
    const markerLabels = normalizeMarkerLabels(state.markerLabels);
    const filter = normalizeText(options.filter || options.tag || 'all');
    const query = normalizeText(options.query);
    const sort = normalizeText(options.sort || 'updated').toLowerCase();
    const items = Object.keys(state.papers)
      .map((paperId) => state.papers[paperId])
      .filter((paper) => paperMatchesTag(paper, filter))
      .filter((paper) => paperMatchesQuery(paper, query))
      .map((paper) =>
        Object.assign({}, paper, {
          markerLabel: paper.marker ? markerLabels[paper.marker] || paper.marker : '',
        }),
      );
    items.sort((a, b) => {
      if (sort === 'score') {
        const scoreA = Number.parseFloat(a.score) || -1;
        const scoreB = Number.parseFloat(b.score) || -1;
        if (scoreA !== scoreB) return scoreB - scoreA;
      }
      if (sort === 'date') {
        const dateA = Date.parse(a.date || '') || 0;
        const dateB = Date.parse(b.date || '') || 0;
        if (dateA !== dateB) return dateB - dateA;
      }
      return (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0);
    });
    return items;
  };

  const listByTag = (tag, options = {}) => listPapers(Object.assign({}, options, { filter: tag }));

  const bytesToBase64 = (bytes) => {
    let binary = '';
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
    return btoa(binary);
  };

  const base64ToBytes = (raw) => {
    const binary = atob(String(raw || '').replace(/\s+/g, ''));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  };

  const getCrypto = () => {
    const cryptoObj =
      (typeof window !== 'undefined' && (window.crypto || window.msCrypto)) ||
      (typeof globalThis !== 'undefined' && globalThis.crypto) ||
      null;
    if (!cryptoObj || !cryptoObj.subtle) {
      throw new Error('Web Crypto AES-GCM is not available.');
    }
    return cryptoObj;
  };

  const importAesKey = async (keyB64, usages) =>
    getCrypto().subtle.importKey('raw', base64ToBytes(keyB64), { name: 'AES-GCM' }, false, usages);

  const encryptState = async (plainState, keyB64) => {
    const cryptoObj = getCrypto();
    const iv = cryptoObj.getRandomValues(new Uint8Array(12));
    const key = await importAesKey(keyB64, ['encrypt']);
    const encoded = new TextEncoder().encode(JSON.stringify(stateForRemote(plainState)));
    const cipherBuf = await cryptoObj.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    return {
      version: 1,
      algorithm: 'AES-GCM',
      path: DEFAULT_REPO_PATH,
      updatedAt: normalizeState(plainState).updatedAt,
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(cipherBuf)),
    };
  };

  const decryptState = async (encryptedPayload, keyB64) => {
    if (!isPlainObject(encryptedPayload) || !encryptedPayload.iv || !encryptedPayload.ciphertext) {
      throw new Error('Reader database payload is not a valid encrypted JSON object.');
    }
    const key = await importAesKey(keyB64, ['decrypt']);
    const plainBuf = await getCrypto().subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(encryptedPayload.iv) },
      key,
      base64ToBytes(encryptedPayload.ciphertext),
    );
    const text = new TextDecoder().decode(plainBuf);
    return normalizeState(JSON.parse(text));
  };

  const canAttemptRemoteSync = () =>
    String(window.DPR_ACCESS_MODE || '').toLowerCase() === 'full' &&
    window.SubscriptionsGithubToken &&
    typeof window.SubscriptionsGithubToken.commitRepoChanges === 'function' &&
    typeof window.SubscriptionsGithubToken.loadRepoTextFile === 'function';

  const resolveReaderDbConfig = async () => {
    if (!canAttemptRemoteSync()) return null;
    const session = window.DPRSecretSession || {};
    if (typeof session.ensureReaderDatabaseConfig === 'function') {
      const cfg = await session.ensureReaderDatabaseConfig();
      if (cfg && cfg.key_b64) {
        return {
          path: normalizeRepoPath(cfg.path || DEFAULT_REPO_PATH),
          key_b64: cfg.key_b64,
          enabled: cfg.enabled !== false,
        };
      }
    }
    const secret = window.decoded_secret_private || {};
    const cfg = isPlainObject(secret.reader_database) ? secret.reader_database : {};
    if (!cfg.key_b64 || cfg.enabled === false) return null;
    return {
      path: normalizeRepoPath(cfg.path || DEFAULT_REPO_PATH),
      key_b64: cfg.key_b64,
      enabled: true,
    };
  };

  const loadRemoteState = async (cfg) => {
    const api = window.SubscriptionsGithubToken;
    try {
      const file = await api.loadRepoTextFile(cfg.path, { requireWorkflow: false });
      const encrypted = JSON.parse(file.content || '{}');
      return await decryptState(encrypted, cfg.key_b64);
    } catch (err) {
      const msg = String((err && err.message) || err || '');
      if (msg.includes('HTTP 404')) return null;
      throw err;
    }
  };

  const loadRemoteAndMerge = async () => {
    if (!canAttemptRemoteSync()) return getState();
    const cfg = await resolveReaderDbConfig();
    if (!cfg || cfg.enabled === false) return getState();
    const remote = await loadRemoteState(cfg);
    runtime.remoteLoaded = true;
    if (remote) {
      const local = ensureState();
      const merged = mergeStates(remote, local);
      merged.dirty = !!local.dirty;
      saveLocalState(merged);
      setStatus('synced', 'Remote reader database loaded.');
    }
    return getState();
  };

  const syncNow = async (options = {}) => {
    const state = ensureState();
    if (runtime.syncInFlight) return getState();
    if (!state.dirty && !options.force) return getState();
    if (!canAttemptRemoteSync()) {
      setStatus('local', 'Reader database is stored locally until the site is unlocked.');
      return getState();
    }
    runtime.syncInFlight = true;
    try {
      const cfg = await resolveReaderDbConfig();
      if (!cfg || cfg.enabled === false) {
        setStatus('local', 'Reader database sync is not configured.');
        return getState();
      }
      if (!runtime.remoteLoaded) {
        await loadRemoteAndMerge();
      }
      const latest = ensureState();
      const encrypted = await encryptState(latest, cfg.key_b64);
      encrypted.path = cfg.path;
      await window.SubscriptionsGithubToken.commitRepoChanges(
        {
          updates: [{ path: cfg.path, content: `${JSON.stringify(encrypted, null, 2)}\n` }],
          deletes: [],
        },
        'chore: sync reader database',
        { requireWorkflow: false },
      );
      const saved = ensureState();
      saved.dirty = false;
      saved.lastSyncedAt = nowIso();
      saveLocalState(saved);
      setStatus('synced', 'Reader database synced to repository.');
      return getState();
    } catch (err) {
      setStatus('error', String((err && err.message) || err || 'Reader database sync failed.'));
      return getState();
    } finally {
      runtime.syncInFlight = false;
    }
  };

  const scheduleSync = () => {
    window.clearTimeout(runtime.syncTimer);
    runtime.syncTimer = window.setTimeout(() => {
      syncNow({ silent: true });
    }, SYNC_DELAY_MS);
  };

  const subscribe = (fn) => {
    if (typeof fn !== 'function') return () => {};
    runtime.subscribers.push(fn);
    return () => {
      runtime.subscribers = runtime.subscribers.filter((item) => item !== fn);
    };
  };

  const init = () => {
    ensureState();
    document.addEventListener('dpr-access-mode-changed', () => {
      if (String(window.DPR_ACCESS_MODE || '').toLowerCase() === 'full') {
        loadRemoteAndMerge()
          .then(() => syncNow({ force: ensureState().dirty }))
          .catch((err) => setStatus('error', String((err && err.message) || err || 'Sync failed.')));
      }
    });
    if (String(window.DPR_ACCESS_MODE || '').toLowerCase() === 'full') {
      loadRemoteAndMerge()
        .then(() => syncNow({ force: ensureState().dirty }))
        .catch((err) => setStatus('error', String((err && err.message) || err || 'Sync failed.')));
    }
  };

  const api = {
    COLOR_MARKERS,
    DEFAULT_REPO_PATH,
    buildLegacyState,
    decryptState,
    encryptState,
    getDefaultMarkerLabels,
    getMarkerLabels,
    getPaper,
    getReactionStateObject,
    getReadStateObject,
    getState,
    init,
    isColorMarkerKey,
    listByTag,
    listPapers,
    loadRemoteAndMerge,
    mergeStates,
    normalizeMarkerLabels,
    normalizePaperRecord,
    normalizeReaction,
    normalizeState,
    scheduleSync,
    setMarker,
    setMarkerLabels,
    replaceReactionStateObject,
    replaceReadStateObject,
    setReaction,
    setRead,
    subscribe,
    syncNow,
    upsertPaperMeta,
    __test: {
      base64ToBytes,
      bytesToBase64,
      compareUpdatedAt,
      emptyState,
      mergeStates,
      normalizePaperRecord,
      normalizeState,
      stateForRemote,
    },
  };

  init();
  return api;
})();
