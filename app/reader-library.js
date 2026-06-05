// Personal reader database page rendered inside Docsify.
window.DPRReaderLibrary = (function () {
  const PAGE_SIZE = 10;
  const FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'reader:deep', label: '精读' },
    { key: 'reader:quick', label: '速读' },
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

  const CATEGORY_TOPIC_LABELS = {
    'cs.ai': 'Artificial Intelligence',
    'cs.cl': 'NLP',
    'cs.cv': 'Computer Vision',
    'cs.ir': 'Information Retrieval',
    'cs.lg': 'Machine Learning',
    'cs.sd': 'Speech Processing',
    'cs.ro': 'Robotics',
    'cs.hc': 'Human-Computer Interaction',
    'cs.cr': 'Computer Security',
    'cs.dc': 'Distributed Systems',
    'cs.ds': 'Algorithms',
    'cs.gr': 'Computer Graphics',
    'cs.ma': 'Multi-Agent Systems',
    'cs.ne': 'Neural Computing',
    'cs.sy': 'Systems and Control',
    'eess.as': 'Audio and Speech Processing',
    'eess.iv': 'Image and Video Processing',
    'eess.sp': 'Signal Processing',
    'eess.sy': 'Control Systems',
    'stat.ml': 'Machine Learning',
  };

  const CANONICAL_TOPIC_PATTERNS = [
    ['EEG motor decoding', [/\beeg motor decoding\b/i]],
    ['EEG foundation models', [/\beeg foundation models?\b/i]],
    ['fMRI decoding', [/\bfmri\b.*\bdecod/i, /\bdecod\w*\b.*\bfmri\b/i]],
    ['BCI', [/\bbrain[- ]computer interface\b/i, /\bbci\b/i]],
    ['neural decoding', [/\bneural decoding\b/i, /\bbrain decoding\b/i]],
    ['speech reconstruction', [/\breconstruct\w* speech\b/i, /\bspeech reconstruction\b/i]],
    ['non-invasive neural signals', [/\bnon[- ]invasive neural signals?\b/i]],
    ['EMG-to-text', [/\bemg[- ]to[- ]text\b/i, /\belectromyography\b.*\btext\b/i]],
    ['semantic alignment', [/\bsemantic alignment\b/i]],
    ['cross-modal alignment', [/\bcross[- ]modal alignment\b/i]],
    ['multimodal alignment', [/\bmultimodal alignment\b/i, /\bmulti[- ]modal alignment\b/i]],
    ['cross-modal representation learning', [/\bcross[- ]modal representation learning\b/i]],
    ['cross-modal knowledge editing', [/\bcross[- ]modal knowledge editing\b/i, /\bknowledge editing\b/i]],
    ['cross-modal knowledge transfer', [/\bcross[- ]modal knowledge transfer\b/i]],
    ['multimodal models', [/\bmultimodal models?\b/i, /\bmulti[- ]modal models?\b/i, /\bumms?\b/i]],
    ['multimodal domain generalization', [/\bmultimodal domain generalization\b/i, /\bmmdg\b/i]],
    ['domain generalization', [/\bdomain generalization\b/i]],
    ['test-time adaptation', [/\btest[- ]time (?:training|adaptation)\b/i, /\bmodel at test time\b/i]],
    ['continual learning', [/\bcontinual learning\b/i]],
    ['instruction tuning', [/\binstruction tuning\b/i]],
    ['replay control', [/\breplay control\b/i, /\breplay controllers?\b/i]],
    ['dense retrieval', [/\bdense retrieval\b/i, /\bdense retrievers?\b/i]],
    ['pseudo-label reranking', [/\bpseudo[- ]labels?\b.*\brerank/i, /\brerank\w*\b.*\bpseudo[- ]labels?\b/i]],
    ['reranking', [/\breranking\b/i, /\bre-ranking\b/i]],
    ['time-series forecasting', [/\btime[- ]series forecasting\b/i, /\blong[- ]term time[- ]series forecasting\b/i]],
    ['time-series embeddings', [/\btime[- ]series embeddings?\b/i]],
    ['time-series prediction', [/\btime[- ]series prediction\b/i]],
    ['state space models', [/\bstate space models?\b/i, /\bselective state space\b/i]],
    ['non-stationary time series', [/\bnon[- ]stationary time series\b/i, /\bnon[- ]stationary temporal\b/i]],
    ['long-range temporal modeling', [/\blong[- ]range\b.*\btemporal\b/i, /\blong range credit assignment\b/i]],
    ['modality interaction', [/\bmodality interaction\b/i]],
    ['partial information decomposition', [/\bpartial information decomposition\b/i, /\bpid\b/i]],
    ['multimodal JEPA', [/\bmultimodal jepa\b/i, /\bmulti[- ]modal jepa\b/i]],
    ['temporal sentence grounding', [/\btemporal sentence grounding\b/i]],
    ['text-to-motion generation', [/\btext[- ]to[- ]motion generation\b/i]],
    ['text-to-speech', [/\btext[- ]to[- ]speech\b/i, /\btts\b/i]],
    ['diffusion transformers', [/\bdiffusion transformers?\b/i, /\bdit\b/i]],
    ['representation alignment', [/\brepresentation alignment\b/i]],
    ['agentic forecasting', [/\bagentic forecasting\b/i]],
    ['adaptive memory', [/\badaptive (?:factor )?memory\b/i]],
    ['generative retrieval', [/\bgenerative retrieval\b/i]],
    ['ranking', [/\branking\b/i]],
    ['recommendation systems', [/\brecommendation systems?\b/i, /\brecommender systems?\b/i]],
  ];

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

  const canonicalizeTopicLabel = (value) => {
    let label = normalizeText(value).replace(/[–—]/g, '-');
    const lower = label.toLowerCase();
    if (!label) return '';
    if (/\btest[- ]?time\b/i.test(label)) return 'test-time adaptation';
    if (/\bpseudo[- ]labels?\b/i.test(label) && /\brerank/i.test(label)) return 'pseudo-label reranking';
    if (/\breconstruct\w* speech\b/i.test(label) || /\bspeech reconstruction\b/i.test(label)) {
      return 'speech reconstruction';
    }
    if (/\bstate space models?\b/i.test(label) || /\bselective state space\b/i.test(label)) return 'state space models';
    if (/\blong range credit assignment\b/i.test(label)) return 'long-range temporal modeling';
    if (lower === 'multimodal domain generalization benchmark' || lower === 'multi-modal domain generalization benchmark') {
      return 'multimodal domain generalization';
    }
    label = label.replace(
      /^(?:analyz(?:e|es|ing)|adapt(?:s|ing)?|uses?|using|applies?|reconstruct(?:s|ing)?|benchmark(?:s|ing)?|align(?:s|ing)?|unify(?:ing|ies)?|unified|introduces?|presents?)\s+/i,
      '',
    );
    return normalizeText(label);
  };

  const cleanTopicLabel = (value) => {
    let label = canonicalizeTopicLabel(value)
      .replace(/<[^>]+>/g, ' ')
      .replace(/^[\s:：;；,，、.!?！？"()[\]{}-]+/, '')
      .replace(/[\s:：;；,，、.!?！？"()[\]{}-]+$/, '');
    label = normalizeText(label);
    if (!label) return '';
    const lower = label.toLowerCase();
    if (/^(query|search|score)\s*[:：]/i.test(label)) return '';
    if (
      [
        'ai4nd',
        'composite',
        'fresh_fetch',
        'carryover',
        'local-pdf',
        'model',
        'models',
        'method',
        'methods',
        'approach',
        'paper',
        'framework',
        'system',
        'not relevant',
      ].includes(lower) ||
      /:composite$/i.test(label) ||
      /\b(?:prioritize|especially|could inspire|current subscription|reader profile)\b/i.test(label)
    ) {
      return '';
    }
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

  const isEnglishTopicText = (value) => /[A-Za-z]/.test(value || '') && !/[\u4e00-\u9fff]/.test(value || '');

  const topicPhraseParts = (value) => {
    const text = normalizeText(value).replace(/[–—]/g, '-');
    if (!text || !isEnglishTopicText(text)) return [];
    const parts = /[,;|]/.test(text)
      ? text.split(/[,;|]+/)
      : text.split(/\b(?:with|via|using|through|for|in|from|into|across|on|by|towards?|toward)\b/i);
    const cleanParts = parts.map((part) => normalizeText(part)).filter(Boolean);
    return cleanParts.length > 1 ? cleanParts : [text];
  };

  const patternTopicTags = (value) => {
    const text = normalizeText(value);
    if (!text) return [];
    const out = [];
    CANONICAL_TOPIC_PATTERNS.forEach(([label, patterns]) => {
      if (patterns.some((pattern) => pattern.test(text))) out.push({ kind: 'topic', label });
    });
    return out;
  };

  const categoryTopicTags = (paper) => {
    const raw = [paper && paper.primary_category].concat(Array.isArray(paper && paper.categories) ? paper.categories : []);
    return raw
      .map((value) => {
        const text = normalizeText(value);
        if (!text) return '';
        const mapped = CATEGORY_TOPIC_LABELS[text.toLowerCase()];
        if (mapped) return mapped;
        if (!text.includes('.') && /^[A-Za-z][A-Za-z .&/-]{2,38}$/.test(text)) {
          return text === text.toLowerCase() ? text.replace(/\b[a-z]/g, (char) => char.toUpperCase()) : text;
        }
        return '';
      })
      .filter(Boolean)
      .map((label) => ({ kind: 'topic', label }));
  };

  const looksLikeShortQueryTopic = (value) => {
    const text = normalizeText(value);
    if (!text || looksLikeEvidenceSentence(text)) return false;
    if (/\b(?:prioritize|especially|could|should|papers central|subscription)\b/i.test(text)) return false;
    const words = text.split(/\s+/).filter(Boolean);
    return words.length >= 1 && words.length <= 5 && text.length <= 48;
  };

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
      date: normalizeDate(payload.published || payload.publication_date || payload.date, paperId),
      title,
      title_zh: normalizeText(payload.title_zh || payload.titleZh),
      link: normalizeText(payload.link || payload.url || fallbackLink),
      pdf: normalizeText(payload.pdf || payload.pdf_url),
      score: normalizeText(payload.score || scoreFromSidebarDom(anchor)),
      source: normalizeText(payload.source || (isLocalPdf ? 'local-pdf' : '')),
      reader_section: normalizeReaderSection(payload.reader_section || payload.readerSection),
      evidence: normalizeText(payload.evidence),
      llm_evidence_en: normalizeText(payload.llm_evidence_en || payload.evidence_en),
      llm_evidence_cn: normalizeText(payload.llm_evidence_cn || payload.evidence_cn),
      canonical_evidence: normalizeText(payload.canonical_evidence),
      matched_query_text: normalizeText(payload.matched_query_text || payload.matchedQueryText),
      primary_category: normalizeText(payload.primary_category || payload.primaryCategory),
      categories: Array.isArray(payload.categories) ? payload.categories.map(normalizeText).filter(Boolean) : [],
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
      if (Array.from(seen).some((existingKey) => existingKey.includes(key) || key.includes(existingKey))) return null;
      seen.add(key);
      return { kind: normalizeText(tag.kind || 'topic').toLowerCase() || 'topic', label };
    };
    const topicTags = normalizeTopicTags(paper.topic_tags).map(addSeen).filter(Boolean).slice(0, 5);
    if (topicTags.length >= 5) return topicTags;
    const metadataTags = isLocalPdfPaper(paper)
      ? []
      : topicTagsFromMetadata(paper)
          .map(addSeen)
          .filter(Boolean)
          .slice(0, 5 - topicTags.length);
    if (topicTags.length + metadataTags.length >= 5) return topicTags.concat(metadataTags);
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
      .slice(0, 5 - topicTags.length - metadataTags.length);
    return topicTags.concat(metadataTags, explicitTags);
  };

  const topicTagsFromMetadata = (paper) => {
    const out = [];
    const add = (tag) => {
      const label = cleanTopicLabel(tag && tag.label);
      if (label) out.push({ kind: normalizeText(tag.kind || 'topic').toLowerCase() || 'topic', label });
    };
    [paper && paper.llm_evidence_en, paper && paper.evidence_en].forEach((value) => {
      const text = normalizeText(value);
      if (!text) return;
      if (!looksLikeEvidenceSentence(text)) topicPhraseParts(text).forEach((label) => add({ kind: 'topic', label }));
      patternTopicTags(text).forEach(add);
    });
    if (looksLikeShortQueryTopic(paper && paper.matched_query_text)) {
      patternTopicTags(paper.matched_query_text).forEach(add);
      normalizeTopicTags(paper.matched_query_text).forEach(add);
    }
    [paper && paper.llm_evidence_cn, paper && paper.evidence_cn, paper && paper.llm_evidence, paper && paper.canonical_evidence, paper && paper.evidence]
      .forEach((value) => {
        const text = normalizeText(value);
        if (!text) return;
        const sentenceLike = looksLikeEvidenceSentence(text);
        if (!sentenceLike && /[,;|、，；]/.test(text)) {
          normalizeTopicTags(text).forEach(add);
        }
        if (!sentenceLike) patternTopicTags(text).forEach(add);
      });
    [paper && paper.title, paper && paper.title_zh].forEach((value) => patternTopicTags(value).forEach(add));
    categoryTopicTags(paper).forEach(add);
    return out;
  };

  const looksLikeEvidenceSentence = (value) => {
    const text = normalizeText(value);
    if (!text) return false;
    if (/[。.!?！？]/.test(text)) return true;
    const lower = text.toLowerCase();
    if (
      /\b(?:this|the)\s+paper\b|\b(?:proposes|introduces|shows|demonstrates|matches|addresses|improves|uses|applies|presents|analyzes|analyses|adapts|reconstructs|reconstructing)\b/.test(
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
