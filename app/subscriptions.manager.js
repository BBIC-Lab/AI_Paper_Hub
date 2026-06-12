// 订阅管理总模块（智能 Query）
// 负责：
// 1) 维护本地草稿配置
// 2) 统一渲染 intent_profiles
// 3) 保存前仅保留 intent_profiles

window.SubscriptionsManager = (function () {
  const MAX_KEYWORDS_PER_PROFILE = 6;
  const MAX_INTENT_QUERIES_PER_PROFILE = 4;
  const MAX_RESEARCH_DIRECTIONS = 8;
  const DEFAULT_DAILY_SECTION_PAPER_LIMIT = 10;
  const DEFAULT_DAILY_RECALL_WINDOW_DAYS = 5;
  const DEFAULT_CARRYOVER_WINDOW_DAYS = 7;
  const LONG_WINDOW_WARNING_THRESHOLD_DAYS = 7;
  const LONG_WINDOW_WARNING_TEXT = '窗口较长，可能增加旧论文反复进入候选池的概率，提高token消耗。';
  const DEFAULT_DAILY_REPORTS = {
    enabled: true,
  };
  const DAILY_AUTO_SCHEDULE_LABEL = '每周一至周五 北京时间 03:00';
  const DAILY_AUTO_DEFAULT_MESSAGE = '仅影响 GitHub Actions 定时 schedule；“快速使用”的手动抓取仍可运行。';
  const DAILY_AUTO_DIRTY_MESSAGE = '检测到未保存修改，请先保存后再切换自动日报。';
  const EMAIL_WORKFLOW_PATH = '.github/workflows/email-daily-brief.yml';
  const DEFAULT_EMAIL_PUSH_TIME = '08:30';
  const DEFAULT_EMAIL_TIMEZONE = 'Asia/Shanghai';
  const DEFAULT_EMBEDDING_PROFILE = 'default_remote';
  const DEFAULT_EMBEDDING_PROVIDER = 'openai';
  const DEFAULT_EMBEDDING_MODEL = 'BAAI/bge-small-en-v1.5';
  const DEFAULT_EMBEDDING_TIMEOUT = 60;
  const DEFAULT_EMBEDDING_FALLBACK = 'local';
  const DEFAULT_RERANK_PROVIDER = 'openai';
  const DEFAULT_RERANK_TIMEOUT = 60;
  const DEFAULT_PERIODIC_REPORTS = {
    enabled: true,
    default_input_mode: 'artifacts',
    language: 'zh-CN',
    max_candidates: 240,
    max_topics: 10,
    representative_papers: 12,
    weekly: {
      enabled: true,
      schedule: '30 23 * * 5',
      input_mode: 'artifacts',
      recrawl_days: 10,
      max_candidates: 240,
      representative_papers: 12,
      topic_limits: {
        related_topics: 10,
        topic_timeline: 10,
        cooccurrence_topics: 10,
        cooccurrence_pairs: 12,
      },
    },
    monthly: {
      enabled: true,
      schedule: '30 23 1 * *',
      input_mode: 'artifacts',
      recrawl_days: 30,
      max_candidates: 240,
      representative_papers: 12,
      topic_limits: {
        topics: 10,
        related_topics: 12,
        topic_timeline: 12,
        word_cloud_terms: 36,
        cooccurrence_topics: 12,
        cooccurrence_pairs: 18,
        comparison_topics: 10,
      },
    },
    charts: {
      topics: true,
      sources: true,
      score_distribution: true,
      timeline: true,
      topic_timeline: true,
    },
    topic_aliases: {},
    include_low_score_novelty: false,
  };
  let overlay = null;
  let panel = null;
  let saveBtn = null;
  let closeBtn = null;
  let msgEl = null;
  let quickRunTodayBtn = null;
  let quickRun10dBtn = null;
  let quickRun30dBtn = null;
  let quickRun30dStandardBtn = null;
  let quickRunWeeklyReportBtn = null;
  let quickRunMonthlyReportBtn = null;
  let quickRunWeeklyRecrawlBtn = null;
  let quickRunMonthlyRecrawlBtn = null;
  let periodicReportMsgEl = null;
  let quickRunOpenWorkflowPanelBtn = null;
  let dailyAutoToggleBtn = null;
  let dailyAutoCardEl = null;
  let dailyAutoStatusEl = null;
  let dailyAutoSummaryEl = null;
  let dailyAutoMsgEl = null;
  let quickRunMsgEl = null;
  let resetContentBtn = null;
  let resetContentMsgEl = null;
  let emailSaveBtn = null;
  let emailTestBtn = null;
  let emailMsgEl = null;
  let embeddingSaveBtn = null;
  let embeddingMsgEl = null;
  let rerankerSaveBtn = null;
  let rerankerMsgEl = null;
  let advancedConfigHideTimer = null;
  let researchSaveBtn = null;
  let researchMsgEl = null;
  let settingsDirtyBadge = null;
  let activeSettingsPage = 'search';
  let lastConfigSource = '';

  let draftConfig = null;
  let hasUnsavedChanges = false;
  let isSavingDraftConfig = false;

  const defaultPromptTemplate = [
    'You are a retrieval planning assistant.',
    '标签 (Tag): {{TAG}}',
    '中文描述 (Description): {{USER_DESCRIPTION}}',
    'Retrieval context: {{RETRIEVAL_CONTEXT}}',
    '',
    'Return JSON only:',
    '{',
    '  "tag": "optional tag suggestion (for user convenience)",',
    '  "description": "optional Chinese description (for user convenience)",',
    '  "keywords": [',
    '    {',
      '      "keyword": "short keyword phrase for BM25 recall",',
      '      "query": "semantic rewrite for this keyword",',
      '      "keyword_cn": "中文直译（可选）",',
    '    },',
    '  ],',
    '  "intent_queries": [',
    '    {',
      '      "query": "intent-oriented semantic query 1",',
      '      "query_cn": "中文直译（可选）",',
    '    },',
    '    {',
      '      "query": "intent-oriented semantic query 2",',
      '      "query_cn": "中文直译（可选）",',
    '    }',
    '  ],',
    '}',
    'Requirements:',
    '1) keywords: output 5-12 objects; each item must include keyword and query, keyword_cn optional.',
    '2) keywords are used for recall and should be atomic phrases (prefer 1-3 core words).',
    '3) Avoid coupling core terms (e.g., "symbolic regression", "reinforcement learning", "genetic programming", "Transformer") with extra qualifiers into one keyword. Keep core terms atomic in keyword and use query for full intent.',
    '4) Suggested example:',
    '   {"keyword":"symbolic regression","query":"deep symbolic regression methods","keyword_cn":"符号回归","query_cn":"符号回归深度方法"},',
    '   {"keyword":"reinforcement learning","query":"policy gradient symbolic regression","keyword_cn":"强化学习","query_cn":"策略梯度在符号回归中的应用"},',
    '   {"keyword":"MCTS","query":"MCTS for symbolic regression"}',
    '5) intent_queries: output 1-4 actionable intent queries. Each item should include query and optional query_cn.',
    '6) Do not output extra fields like must_have / optional / exclude / rewrite_for_embedding / must_have.',
    '7) Return pure JSON only, no explanations.',
    '8) Tag suggestion should be concise, preferably under 6 characters.',
  ].join('\n');


  const normalizeText = (v) => String(v || '').trim();
  const normalizeSourceKey = (v) => normalizeText(v).toLowerCase();
  const escapeHtml = (str) => String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const isLikelyEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeText(value));
  const normalizeDailyPushTime = (value) => {
    const text = normalizeText(value);
    const match = text.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return DEFAULT_EMAIL_PUSH_TIME;
    const hour = Math.max(0, Math.min(23, parseInt(match[1], 10)));
    const minute = Math.max(0, Math.min(59, parseInt(match[2], 10)));
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  };
  const normalizeEmailTimezone = (value) => (
    normalizeText(value) === 'UTC' ? 'UTC' : DEFAULT_EMAIL_TIMEZONE
  );
  const isHttpUrl = (value) => /^https?:\/\//i.test(normalizeText(value));
  const normalizeEmbeddingProfile = (value) => {
    const text = normalizeText(value).toLowerCase();
    return ['local', 'default_remote', 'advanced', 'custom'].includes(text)
      ? text
      : DEFAULT_EMBEDDING_PROFILE;
  };
  const normalizeEmbeddingProvider = (value) => {
    const text = normalizeText(value).toLowerCase();
    if (['legacy', 'custom'].includes(text)) return 'legacy';
    if (['openai', 'openai-compatible', 'openai_compatible', 'vllm'].includes(text)) return 'openai';
    return DEFAULT_EMBEDDING_PROVIDER;
  };
  const normalizeEmbeddingFallback = (value) => {
    const text = normalizeText(value).toLowerCase();
    return text === 'fail' ? 'fail' : DEFAULT_EMBEDDING_FALLBACK;
  };
  const normalizeEmbeddingTimeout = (value) => {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EMBEDDING_TIMEOUT;
    return Math.min(parsed, 600);
  };
  const resolveEmbeddingServiceState = (secretValue) => {
    const secret = isPlainObject(secretValue)
      ? secretValue
      : (isPlainObject(window.decoded_secret_private) ? window.decoded_secret_private : {});
    const embedding = isPlainObject(secret.embeddingService) ? secret.embeddingService : {};
    return {
      profile: normalizeEmbeddingProfile(embedding.profile || DEFAULT_EMBEDDING_PROFILE),
      provider: normalizeEmbeddingProvider(embedding.provider || DEFAULT_EMBEDDING_PROVIDER),
      timeout: normalizeEmbeddingTimeout(embedding.timeout || DEFAULT_EMBEDDING_TIMEOUT),
      fallback: normalizeEmbeddingFallback(embedding.fallback || DEFAULT_EMBEDDING_FALLBACK),
      hasCustomCredentials: !!embedding.hasCustomCredentials,
    };
  };
  const buildEmbeddingSecretsPayload = (settings) => {
    const safe = isPlainObject(settings) ? settings : {};
    const profile = normalizeEmbeddingProfile(safe.profile);
    if (profile !== 'custom') {
      return {};
    }
    const apiKey = normalizeText(safe.apiKey);
    if (!apiKey) {
      throw new Error('请填写自定义 embedding API Key。');
    }
    return { MODEL_API_KEY: apiKey };
  };
  const buildEmbeddingVariablesPayload = (settings) => {
    const safe = isPlainObject(settings) ? settings : {};
    const profile = normalizeEmbeddingProfile(safe.profile);
    const variables = { DPR_EMBED_PROFILE: profile };
    if (profile !== 'custom') {
      if (profile === 'default_remote') {
        variables.DPR_EMBED_PROVIDER = 'legacy';
      }
      if (profile === 'default_remote' || profile === 'local') {
        variables.DPR_EMBED_MODEL = DEFAULT_EMBEDDING_MODEL;
      }
      return variables;
    }
    const endpoint = normalizeText(safe.endpoint || safe.apiUrl);
    const model = normalizeText(safe.model);
    if (!isHttpUrl(endpoint)) {
      throw new Error('请填写以 http:// 或 https:// 开头的 embedding endpoint。');
    }
    if (!model) {
      throw new Error('请填写 embedding 模型名称。');
    }
    variables.DPR_EMBED_PROVIDER = normalizeEmbeddingProvider(safe.provider);
    variables.DPR_EMBED_ENDPOINT = endpoint;
    variables.DPR_EMBED_MODEL = model;
    variables.DPR_EMBED_API_TIMEOUT = String(DEFAULT_EMBEDDING_TIMEOUT);
    variables.DPR_EMBED_REMOTE_FALLBACK = DEFAULT_EMBEDDING_FALLBACK;
    return variables;
  };
  const normalizeRerankerProvider = (value) => {
    const text = normalizeText(value).toLowerCase();
    if (['', 'none', 'off', 'disabled'].includes(text)) return 'disabled';
    if (['openai', 'openai-compatible', 'openai_compatible', 'vllm'].includes(text)) return 'openai';
    return DEFAULT_RERANK_PROVIDER;
  };
  const normalizeRerankerEnabled = (value) => {
    if (value === true) return true;
    if (value === false) return false;
    const text = normalizeText(value).toLowerCase();
    return ['1', 'true', 'yes', 'on', 'enabled', 'openai'].includes(text);
  };
  const resolveRerankerServiceState = (secretValue) => {
    const secret = isPlainObject(secretValue)
      ? secretValue
      : (isPlainObject(window.decoded_secret_private) ? window.decoded_secret_private : {});
    const reranker = isPlainObject(secret.rerankerService) ? secret.rerankerService : {};
    const legacyReranker = isPlainObject(secret.rerankerLLM) ? secret.rerankerLLM : {};
    const enabled = typeof reranker.enabled === 'boolean'
      ? reranker.enabled
      : !!legacyReranker.enabled;
    return {
      enabled,
      provider: normalizeRerankerProvider(reranker.provider || (enabled ? DEFAULT_RERANK_PROVIDER : 'disabled')),
      timeout: normalizeEmbeddingTimeout(reranker.timeout || DEFAULT_RERANK_TIMEOUT),
      hasCredentials: !!reranker.hasCredentials,
    };
  };
  const buildRerankerSecretsPayload = (settings) => {
    const safe = isPlainObject(settings) ? settings : {};
    const enabledValue = Object.prototype.hasOwnProperty.call(safe, 'enabled')
      ? safe.enabled
      : safe.mode;
    const enabled = normalizeRerankerEnabled(enabledValue);
    if (!enabled) {
      return {};
    }
    const apiKey = normalizeText(safe.apiKey);
    if (!apiKey) {
      throw new Error('请填写 reranker API Key。');
    }
    return { MODEL_API_KEY: apiKey };
  };
  const buildRerankerVariablesPayload = (settings) => {
    const safe = isPlainObject(settings) ? settings : {};
    const enabledValue = Object.prototype.hasOwnProperty.call(safe, 'enabled')
      ? safe.enabled
      : safe.mode;
    const enabled = normalizeRerankerEnabled(enabledValue);
    if (!enabled) {
      return {
        DPR_SKIP_RERANK: 'true',
        DPR_RERANK_PROVIDER: 'disabled',
      };
    }
    const endpoint = normalizeText(safe.endpoint);
    const model = normalizeText(safe.model);
    if (!isHttpUrl(endpoint)) {
      throw new Error('请填写以 http:// 或 https:// 开头的 reranker endpoint。');
    }
    if (!model) {
      throw new Error('请填写 reranker 模型名称。');
    }
    return {
      DPR_SKIP_RERANK: 'false',
      DPR_RERANK_PROVIDER: normalizeRerankerProvider(safe.provider || DEFAULT_RERANK_PROVIDER),
      DPR_RERANK_ENDPOINT: endpoint,
      DPR_RERANK_MODEL: model,
      DPR_RERANK_API_TIMEOUT: String(DEFAULT_RERANK_TIMEOUT),
    };
  };
  const buildEmailWorkflowCron = (timeValue, timezoneValue) => {
    const timeText = normalizeDailyPushTime(timeValue);
    const timezone = normalizeEmailTimezone(timezoneValue);
    const parts = timeText.split(':').map((item) => parseInt(item, 10));
    const offsetHours = timezone === DEFAULT_EMAIL_TIMEZONE ? 8 : 0;
    const utcHour = (parts[0] - offsetHours + 24) % 24;
    return {
      cron: `${parts[1]} ${utcHour} * * *`,
      time: timeText,
      timezone,
    };
  };
  const toStableId = (value) => {
    const text = normalizeText(value).toLowerCase();
    const slug = text
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .trim();
    return slug || 'item';
  };

  const cloneDeep = (obj) => {
    try {
      return JSON.parse(JSON.stringify(obj || {}));
    } catch {
      return obj || {};
    }
  };

  const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

  const PAPER_SOURCE_ORDER = [
    'arxiv',
    'biorxiv',
    'medrxiv',
    'chemrxiv',
    'neurips',
    'iclr',
    'icml',
    'acl',
    'emnlp',
    'aaai',
  ];
  const VISIBLE_PAPER_SOURCES = ['arxiv', 'biorxiv'];
  const SOURCE_LABELS = {
    arxiv: 'arXiv',
    biorxiv: 'bioRxiv',
    medrxiv: 'medRxiv',
    chemrxiv: 'ChemRxiv',
    neurips: 'NeurIPS',
    iclr: 'ICLR',
    icml: 'ICML',
    acl: 'ACL',
    emnlp: 'EMNLP',
    aaai: 'AAAI',
  };
  const SOURCE_BACKEND_DEFAULTS = {
    arxiv: {
      papers_table: 'arxiv_papers',
      use_vector_rpc: true,
      vector_rpc: 'match_arxiv_papers_exact',
      vector_rpc_exact: 'match_arxiv_papers_exact',
      use_bm25_rpc: true,
      bm25_rpc: 'match_arxiv_papers_bm25',
      sync_table: 'arxiv_sync_status',
      sync_success_value: 'success',
      schema: 'public',
    },
    biorxiv: {
      papers_table: 'biorxiv_papers',
      use_vector_rpc: true,
      vector_rpc: 'match_biorxiv_papers_exact',
      vector_rpc_exact: 'match_biorxiv_papers_exact',
      use_bm25_rpc: true,
      bm25_rpc: 'match_biorxiv_papers_bm25',
      schema: 'public',
    },
  };

  const filterVisiblePaperSources = (values) => {
    const visible = new Set(VISIBLE_PAPER_SOURCES);
    return (Array.isArray(values) ? values : []).filter((value) => visible.has(normalizeSourceKey(value)));
  };

  const getAvailablePaperSources = (config) => {
    const cfg = config && typeof config === 'object' ? config : {};
    const rawBackends = cfg.source_backends && typeof cfg.source_backends === 'object'
      ? cfg.source_backends
      : {};
    const seen = new Set();
    const out = [];
    const runtimeCandidates = [];
    if (window.DPR_RUNTIME_SOURCE_BACKENDS && typeof window.DPR_RUNTIME_SOURCE_BACKENDS === 'object') {
      runtimeCandidates.push(...Object.keys(window.DPR_RUNTIME_SOURCE_BACKENDS || {}));
    }
    ['arxiv', ...Object.keys(rawBackends || {}), ...runtimeCandidates].forEach((key) => {
      const normalized = normalizeSourceKey(key);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      out.push(normalized);
    });
    const visibleOut = filterVisiblePaperSources(out);
    visibleOut.sort((a, b) => {
      const idxA = PAPER_SOURCE_ORDER.indexOf(a);
      const idxB = PAPER_SOURCE_ORDER.indexOf(b);
      const rankA = idxA >= 0 ? idxA : Number.MAX_SAFE_INTEGER;
      const rankB = idxB >= 0 ? idxB : Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      return a.localeCompare(b);
    });
    return visibleOut;
  };

  const getPaperSourceLabel = (source) => {
    const key = normalizeSourceKey(source);
    return SOURCE_LABELS[key] || (key ? key.toUpperCase() : 'Unknown');
  };

  const getAccessModeLabel = () => {
    const mode = String(window.DPR_ACCESS_MODE || '').toLowerCase();
    if (mode === 'full') return '完整权限';
    if (mode === 'guest') return '游客模式';
    if (mode === 'locked') return '尚未解锁';
    return '未初始化';
  };

  const normalizePaperSources = (values, options = {}) => {
    const fallbackToArxiv = options.fallbackToArxiv !== false;
    const rawList = Array.isArray(values)
      ? values
      : (typeof values === 'string' && values ? [values] : []);
    const seen = new Set();
    const out = [];
    rawList.forEach((value) => {
      const key = normalizeSourceKey(value);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(key);
    });
    const visibleOut = filterVisiblePaperSources(out);
    if (!visibleOut.length && fallbackToArxiv) {
      return ['arxiv'];
    }
    return visibleOut;
  };

  const normalizeDailyPaperLimit = (value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_SECTION_PAPER_LIMIT;
  };

  const normalizeWindowDays = (value, fallback = DEFAULT_DAILY_RECALL_WINDOW_DAYS) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  const resolvePaperWindows = (config) => {
    const cfg = isPlainObject(config) ? config : {};
    const setting = isPlainObject(cfg.arxiv_paper_setting) ? cfg.arxiv_paper_setting : {};
    const daysWindow = normalizeWindowDays(setting.days_window, DEFAULT_DAILY_RECALL_WINDOW_DAYS);
    const fallbackCarryover = Object.prototype.hasOwnProperty.call(setting, 'days_window')
      ? daysWindow
      : DEFAULT_CARRYOVER_WINDOW_DAYS;
    const carryoverDays = normalizeWindowDays(setting.carryover_days, fallbackCarryover);
    return { daysWindow, carryoverDays };
  };

  const getWindowWarningText = (value) => (
    normalizeWindowDays(value, DEFAULT_DAILY_RECALL_WINDOW_DAYS) > LONG_WINDOW_WARNING_THRESHOLD_DAYS
      ? LONG_WINDOW_WARNING_TEXT
      : ''
  );

  const normalizeDailyReports = (value) => {
    const raw = isPlainObject(value) ? value : {};
    const defaults = DEFAULT_DAILY_REPORTS;
    return {
      enabled: Object.prototype.hasOwnProperty.call(raw, 'enabled')
        ? raw.enabled !== false
        : defaults.enabled,
    };
  };

  const resolveDailyReports = (config) => normalizeDailyReports(
    isPlainObject(config) ? config.daily_reports : {},
  );

  const normalizePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  const normalizePeriodicInputMode = (value, fallback = 'artifacts') => {
    const mode = normalizeText(value).toLowerCase();
    return ['artifacts', 'recrawl', 'hybrid'].includes(mode) ? mode : fallback;
  };

  const normalizePeriodicReports = (value) => {
    const raw = isPlainObject(value) ? value : {};
    const weeklyRaw = isPlainObject(raw.weekly) ? raw.weekly : {};
    const monthlyRaw = isPlainObject(raw.monthly) ? raw.monthly : {};
    const chartsRaw = isPlainObject(raw.charts) ? raw.charts : {};
    const defaults = cloneDeep(DEFAULT_PERIODIC_REPORTS);
    const defaultMode = normalizePeriodicInputMode(raw.default_input_mode, defaults.default_input_mode);
    const normalizeTopicLimits = (limits, fallback) => {
      const rawLimits = isPlainObject(limits) ? limits : {};
      const out = {};
      Object.keys(fallback || {}).forEach((key) => {
        out[key] = normalizePositiveInt(rawLimits[key], fallback[key]);
      });
      return out;
    };
    const normalizePeriod = (periodRaw, periodDefaults) => ({
      enabled: periodRaw.enabled !== false,
      schedule: normalizeText(periodRaw.schedule || periodDefaults.schedule),
      input_mode: normalizePeriodicInputMode(periodRaw.input_mode, defaultMode),
      recrawl_days: normalizePositiveInt(periodRaw.recrawl_days, periodDefaults.recrawl_days),
      max_candidates: normalizePositiveInt(
        periodRaw.max_candidates ?? raw.max_candidates,
        periodDefaults.max_candidates,
      ),
      representative_papers: normalizePositiveInt(
        periodRaw.representative_papers ?? raw.representative_papers,
        periodDefaults.representative_papers,
      ),
      topic_limits: normalizeTopicLimits(periodRaw.topic_limits, periodDefaults.topic_limits),
    });
    const weekly = normalizePeriod(weeklyRaw, defaults.weekly);
    const monthly = normalizePeriod(monthlyRaw, defaults.monthly);
    return {
      enabled: raw.enabled !== false && (weekly.enabled || monthly.enabled),
      default_input_mode: defaultMode,
      language: normalizeText(raw.language || defaults.language) || defaults.language,
      max_candidates: normalizePositiveInt(raw.max_candidates, defaults.max_candidates),
      max_topics: normalizePositiveInt(raw.max_topics, defaults.max_topics),
      representative_papers: normalizePositiveInt(raw.representative_papers, defaults.representative_papers),
      weekly,
      monthly,
      charts: {
        topics: chartsRaw.topics !== false,
        sources: chartsRaw.sources !== false,
        score_distribution: chartsRaw.score_distribution !== false,
        timeline: chartsRaw.timeline !== false,
        topic_timeline: chartsRaw.topic_timeline !== false,
      },
      topic_aliases: isPlainObject(raw.topic_aliases) ? cloneDeep(raw.topic_aliases) : {},
      include_low_score_novelty: raw.include_low_score_novelty === true,
    };
  };

  const resolvePeriodicReports = (config) => normalizePeriodicReports(
    isPlainObject(config) ? config.periodic_reports : {},
  );

  const resolveDailyPaperLimits = (profile) => {
    const p = isPlainObject(profile) ? profile : {};
    const legacy = p.daily_paper_limit ?? p.daily_candidate_limit ?? p.daily_limit;
    return {
      deep: normalizeDailyPaperLimit(p.deep_daily_paper_limit ?? legacy),
      quick: normalizeDailyPaperLimit(p.quick_daily_paper_limit ?? legacy),
    };
  };

  const mergeDefinedFields = (base, override) => {
    const next = { ...(isPlainObject(base) ? base : {}) };
    if (!isPlainObject(override)) return next;
    Object.keys(override).forEach((key) => {
      const value = override[key];
      if (value === undefined) return;
      next[key] = value;
    });
    return next;
  };

  const buildDefaultSourceBackend = (sourceKey, config) => {
    const normalizedKey = normalizeSourceKey(sourceKey);
    const defaults = SOURCE_BACKEND_DEFAULTS[normalizedKey];
    if (!defaults) return null;

    const cfg = isPlainObject(config) ? config : {};
    const shared = isPlainObject(cfg.supabase_shared) ? cfg.supabase_shared : {};
    const legacy = isPlainObject(cfg.supabase) ? cfg.supabase : {};

    let base = {
      kind: normalizeText(shared.kind || legacy.kind || 'supabase') || 'supabase',
      enabled: shared.enabled !== false && legacy.enabled !== false,
      url: normalizeText(shared.url || legacy.url || ''),
      anon_key: normalizeText(shared.anon_key || legacy.anon_key || ''),
      schema: normalizeText(shared.schema || legacy.schema || defaults.schema || 'public') || 'public',
    };

    if (normalizedKey === 'arxiv') {
      base = mergeDefinedFields(base, {
        enabled: Object.prototype.hasOwnProperty.call(legacy, 'enabled') ? legacy.enabled !== false : undefined,
        papers_table: normalizeText(legacy.papers_table || ''),
        use_vector_rpc: Object.prototype.hasOwnProperty.call(legacy, 'use_vector_rpc') ? legacy.use_vector_rpc !== false : undefined,
        vector_rpc: normalizeText(legacy.vector_rpc || ''),
        vector_rpc_exact: normalizeText(legacy.vector_rpc_exact || legacy.vector_rpc || ''),
        use_bm25_rpc: Object.prototype.hasOwnProperty.call(legacy, 'use_bm25_rpc') ? legacy.use_bm25_rpc !== false : undefined,
        bm25_rpc: normalizeText(legacy.bm25_rpc || ''),
        sync_table: normalizeText(legacy.sync_table || ''),
        sync_success_value: normalizeText(legacy.sync_success_value || ''),
      });
    }

    return mergeDefinedFields(defaults, base);
  };

  const ensureSourceBackendsForProfiles = (config) => {
    const next = isPlainObject(config) ? config : {};
    const subs = isPlainObject(next.subscriptions) ? next.subscriptions : {};
    const profiles = Array.isArray(subs.intent_profiles) ? subs.intent_profiles : [];
    const existingBackends = isPlainObject(next.source_backends) ? next.source_backends : {};
    const mergedBackends = cloneDeep(existingBackends);
    let changed = !isPlainObject(next.source_backends);

    profiles.forEach((profile) => {
      if (!isPlainObject(profile)) return;
      const fallbackToArxiv = !Object.prototype.hasOwnProperty.call(profile, 'paper_sources');
      const paperSources = normalizePaperSources(profile.paper_sources, { fallbackToArxiv });
      paperSources.forEach((sourceKey) => {
        const template = buildDefaultSourceBackend(sourceKey, next);
        if (!template) return;
        const current = isPlainObject(mergedBackends[sourceKey]) ? mergedBackends[sourceKey] : {};
        const merged = mergeDefinedFields(template, current);
        const before = JSON.stringify(current);
        const after = JSON.stringify(merged);
        if (before !== after) {
          mergedBackends[sourceKey] = merged;
          changed = true;
        }
      });
    });

    if (changed) {
      next.source_backends = mergedBackends;
    }
    return next;
  };

  const normalizeKeywordItem = (item) => {
    if (typeof item === 'string') {
      const text = normalizeText(item);
      if (!text) return null;
      return {
        keyword: text,
        keyword_cn: '',
        query: text,
      };
    }
    if (!item || typeof item !== 'object') return null;

    const keyword = normalizeText(item.keyword || item.expr || item.text || '');
    if (!keyword) return null;
    const query = normalizeText(
      item.query ||
        item.rewrite ||
        item.rewrite_for_embedding ||
        item.text ||
        item.keyword ||
        '',
    );
    const keywordCn = normalizeText(item.keyword_cn || item.keyword_zh || item.zh || '');

    return {
      keyword,
      keyword_cn: keywordCn,
      query: query || keyword,
      embedding_cache:
        item.embedding_cache && typeof item.embedding_cache === 'object'
          ? cloneDeep(item.embedding_cache)
          : undefined,
    };
  };

  const dedupeKeywords = (items) => {
    const list = Array.isArray(items) ? items : [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const key = normalizeText(item.keyword || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  };

  const splitResearchDirectionText = (value) => String(value || '')
    .split(/[、，,；;\n\r]+/)
    .map((item) => normalizeText(item))
    .filter(Boolean);

  const normalizeResearchDirections = (value) => {
    const rawItems = Array.isArray(value)
      ? value.flatMap((item) => splitResearchDirectionText(item))
      : splitResearchDirectionText(value);
    const seen = new Set();
    const out = [];
    for (const item of rawItems) {
      const key = item.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= MAX_RESEARCH_DIRECTIONS) break;
    }
    return out;
  };

  const getConfiguredResearchDirections = (config) => {
    const readerProfile = isPlainObject(config && config.reader_profile)
      ? config.reader_profile
      : {};
    return normalizeResearchDirections(readerProfile.research_directions || []);
  };

  const getRawResearchDirections = (config) => {
    const readerProfile = isPlainObject(config && config.reader_profile)
      ? config.reader_profile
      : {};
    return Array.isArray(readerProfile.research_directions)
      ? readerProfile.research_directions.map((item) => String(item || ''))
      : [];
  };

  const getFallbackResearchDirections = (config) => {
    const subs = isPlainObject(config && config.subscriptions) ? config.subscriptions : {};
    const profiles = Array.isArray(subs.intent_profiles) ? subs.intent_profiles : [];
    const raw = [];
    profiles.forEach((profile) => {
      if (!isPlainObject(profile)) return;
      if (profile.enabled === false || profile.paused === true) return;
      (Array.isArray(profile.keywords) ? profile.keywords : []).forEach((item) => {
        const normalized = normalizeKeywordItem(item);
        if (normalized && normalized.keyword) raw.push(normalized.keyword);
      });
    });
    return normalizeResearchDirections(raw);
  };

  const resolveResearchDirections = (config) => {
    const configured = getConfiguredResearchDirections(config);
    if (configured.length) {
      return { directions: configured, source: 'configured' };
    }
    return { directions: getFallbackResearchDirections(config), source: 'fallback' };
  };

  const normalizeReaderProfile = (config) => {
    const next = isPlainObject(config) ? config : {};
    const readerProfile = isPlainObject(next.reader_profile)
      ? cloneDeep(next.reader_profile)
      : {};
    readerProfile.research_directions = normalizeResearchDirections(
      readerProfile.research_directions || [],
    );
    next.reader_profile = readerProfile;
    return next;
  };

  const normalizeIntentQueryItem = (item) => {
    if (typeof item === 'string') {
      const query = normalizeText(item);
      if (!query) return null;
      return {
        query,
        query_cn: '',
        enabled: true,
        source: 'manual',
      };
    }
    if (!item || typeof item !== 'object') return null;

    const query = normalizeText(item.query || item.text || item.keyword || item.expr || '');
    if (!query) return null;
    const queryCn = normalizeText(item.query_cn || item.query_zh || item.zh || item.note || '');

    return {
      query,
      query_cn: queryCn,
      enabled: item.enabled !== false,
      source: normalizeText(item.source || 'manual'),
      note: normalizeText(item.note || ''),
      embedding_cache:
        item.embedding_cache && typeof item.embedding_cache === 'object'
          ? cloneDeep(item.embedding_cache)
          : undefined,
    };
  };

  const normalizeIntentQueries = (items) => {
    const list = Array.isArray(items) ? items : [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const normalized = normalizeIntentQueryItem(item);
      if (!normalized) continue;
      const key = normalizeText(normalized.query).toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
    return out;
  };

  const updateSettingsChrome = () => {
    if (settingsDirtyBadge) {
      settingsDirtyBadge.textContent = hasUnsavedChanges ? '有未保存更改' : '已保存';
      settingsDirtyBadge.classList.toggle('is-dirty', hasUnsavedChanges);
    }
    if (saveBtn) {
      saveBtn.classList.toggle('is-dirty', hasUnsavedChanges);
      saveBtn.title = hasUnsavedChanges
        ? '保存当前设置到 config.yaml'
        : '当前没有未保存修改';
    }
    if (researchSaveBtn) {
      researchSaveBtn.classList.toggle('is-dirty', hasUnsavedChanges);
      researchSaveBtn.title = hasUnsavedChanges
        ? '保存当前研究方向到 config.yaml'
        : '当前没有未保存修改';
    }
  };

  const clearUnsavedRunMessage = (el) => {
    if (!el) return false;
    const text = normalizeText(el.textContent);
    if (!text.startsWith('检测到未保存修改')) return false;
    el.textContent = '';
    el.style.color = '#666';
    return true;
  };

  const activateSettingsPage = (pageKey) => {
    const key = normalizeText(pageKey) || 'search';
    activeSettingsPage = key;
    if (!panel) return;

    panel.querySelectorAll('[data-settings-page]').forEach((btn) => {
      const selected = btn.getAttribute('data-settings-page') === key;
      btn.classList.toggle('is-active', selected);
      btn.setAttribute('aria-selected', selected ? 'true' : 'false');
    });

    panel.querySelectorAll('[data-settings-page-panel]').forEach((section) => {
      const selected = section.getAttribute('data-settings-page-panel') === key;
      section.classList.toggle('is-active', selected);
      section.hidden = !selected;
    });

    if (key === 'storage' && window.DPRStorageManager) {
      window.DPRStorageManager.refreshIfEmpty();
    }
  };

  const syncPeriodicReportFields = () => {
    const settings = resolvePeriodicReports(draftConfig || {});
    const syncValue = (id, value) => {
      const el = document.getElementById(id);
      if (el && document.activeElement !== el) el.value = String(value);
    };
    const syncChecked = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.checked = !!value;
    };
    syncChecked('dpr-periodic-weekly-enabled-true', settings.weekly.enabled);
    syncChecked('dpr-periodic-weekly-enabled-false', !settings.weekly.enabled);
    syncValue('dpr-periodic-weekly-mode-select', settings.weekly.input_mode);
    syncValue('dpr-periodic-weekly-recrawl-input', settings.weekly.recrawl_days);
    syncValue('dpr-periodic-weekly-max-candidates-input', settings.weekly.max_candidates);
    syncValue('dpr-periodic-weekly-representative-input', settings.weekly.representative_papers);
    syncValue('dpr-periodic-weekly-related-topics-input', settings.weekly.topic_limits.related_topics);
    syncValue('dpr-periodic-weekly-topic-timeline-input', settings.weekly.topic_limits.topic_timeline);
    syncValue('dpr-periodic-weekly-cooccurrence-topics-input', settings.weekly.topic_limits.cooccurrence_topics);
    syncValue('dpr-periodic-weekly-cooccurrence-pairs-input', settings.weekly.topic_limits.cooccurrence_pairs);
    syncValue('dpr-periodic-word-cloud-topics-input', settings.max_topics);
    syncChecked('dpr-periodic-monthly-enabled-true', settings.monthly.enabled);
    syncChecked('dpr-periodic-monthly-enabled-false', !settings.monthly.enabled);
    syncValue('dpr-periodic-monthly-mode-select', settings.monthly.input_mode);
    syncValue('dpr-periodic-monthly-recrawl-input', settings.monthly.recrawl_days);
    syncValue('dpr-periodic-monthly-max-candidates-input', settings.monthly.max_candidates);
    syncValue('dpr-periodic-monthly-representative-input', settings.monthly.representative_papers);
    syncValue('dpr-periodic-monthly-topics-input', settings.monthly.topic_limits.topics);
    syncValue('dpr-periodic-monthly-related-topics-input', settings.monthly.topic_limits.related_topics);
    syncValue('dpr-periodic-monthly-topic-timeline-input', settings.monthly.topic_limits.topic_timeline);
    syncValue('dpr-periodic-monthly-word-cloud-input', settings.monthly.topic_limits.word_cloud_terms);
    syncValue('dpr-periodic-monthly-cooccurrence-topics-input', settings.monthly.topic_limits.cooccurrence_topics);
    syncValue('dpr-periodic-monthly-cooccurrence-pairs-input', settings.monthly.topic_limits.cooccurrence_pairs);
    syncValue('dpr-periodic-monthly-comparison-topics-input', settings.monthly.topic_limits.comparison_topics);
  };

  const setDailyAutoMessage = (text, color) => {
    if (dailyAutoMsgEl) {
      dailyAutoMsgEl.textContent = text || DAILY_AUTO_DEFAULT_MESSAGE;
      dailyAutoMsgEl.style.color = color || '#666';
    }
  };

  const syncDailyReportFields = () => {
    const settings = resolveDailyReports(draftConfig || {});
    const enabled = settings.enabled !== false;
    const blocked = hasUnsavedChanges && !isSavingDraftConfig;
    if (dailyAutoCardEl) {
      dailyAutoCardEl.classList.toggle('is-paused', !enabled);
    }
    if (dailyAutoStatusEl) {
      dailyAutoStatusEl.textContent = enabled ? '已开启' : '已暂停';
    }
    if (dailyAutoSummaryEl) {
      dailyAutoSummaryEl.textContent = enabled
        ? `${DAILY_AUTO_SCHEDULE_LABEL} 自动生成日报。`
        : '定时运行会跳过，不会自动生成新日报。';
    }
    if (dailyAutoToggleBtn) {
      dailyAutoToggleBtn.textContent = enabled ? '暂停自动日报' : '恢复自动日报';
      dailyAutoToggleBtn.disabled = blocked || isSavingDraftConfig;
      dailyAutoToggleBtn.classList.toggle('is-paused', !enabled);
      dailyAutoToggleBtn.title = blocked
        ? DAILY_AUTO_DIRTY_MESSAGE
        : (enabled ? '暂停 scheduled 自动日报；手动快速抓取不受影响。' : '恢复 scheduled 自动日报。');
    }
    if (blocked && dailyAutoMsgEl) {
      setDailyAutoMessage(DAILY_AUTO_DIRTY_MESSAGE, '#c00');
    } else if (dailyAutoMsgEl && dailyAutoMsgEl.textContent === DAILY_AUTO_DIRTY_MESSAGE) {
      setDailyAutoMessage(DAILY_AUTO_DEFAULT_MESSAGE, '#666');
    }
  };

  const renderSettingsSnapshot = () => {
    if (!panel) return;
    const cfg = isPlainObject(draftConfig) ? draftConfig : {};
    const subs = isPlainObject(cfg.subscriptions) ? cfg.subscriptions : {};
    const profiles = Array.isArray(subs.intent_profiles) ? subs.intent_profiles : [];
    const sources = getAvailablePaperSources(cfg);
    const sourceListEl = document.getElementById('dpr-settings-sources-list');
    const sourceSummaryEl = document.getElementById('dpr-settings-sources-summary');
    const storageStatusEl = document.getElementById('dpr-settings-storage-status');
    const profileCountEl = document.getElementById('dpr-settings-profile-count');
    const sourceCountEl = document.getElementById('dpr-settings-source-count');
    const accessModeEl = document.getElementById('dpr-settings-access-mode');
    const windows = resolvePaperWindows(cfg);
    const syncWindowField = (inputId, value) => {
      const inputEl = document.getElementById(inputId);
      if (inputEl && document.activeElement !== inputEl) {
        inputEl.value = String(value);
      }
    };
    const windowWarningEl = document.getElementById('dpr-settings-window-warning');

    syncWindowField('dpr-settings-days-window-input', windows.daysWindow);
    syncWindowField('dpr-settings-carryover-window-input', windows.carryoverDays);
    if (windowWarningEl) {
      const warningText = getWindowWarningText(
        Math.max(windows.daysWindow, windows.carryoverDays),
      );
      windowWarningEl.textContent = warningText;
      windowWarningEl.hidden = !warningText;
    }
    panel.querySelectorAll('[data-dpr-default-window-days]').forEach((el) => {
      el.textContent = String(windows.daysWindow);
    });
    syncEmailSettingsFields();
    syncEmbeddingSettingsFields();
    syncRerankerSettingsFields();
    syncPeriodicReportFields();
    syncDailyReportFields();
    renderResearchDirections();

    if (profileCountEl) {
      profileCountEl.textContent = String(profiles.length);
    }
    if (sourceCountEl) {
      sourceCountEl.textContent = String(sources.length || 0);
    }
    if (accessModeEl) {
      accessModeEl.textContent = getAccessModeLabel();
    }
    if (sourceSummaryEl) {
      sourceSummaryEl.textContent = sources.length
        ? `已启用 ${sources.map(getPaperSourceLabel).join(' / ')}，检索词条可按来源选择。`
        : '尚未读取到可见文献源，默认会回退到 arXiv。';
    }
    if (sourceListEl) {
      const backends = isPlainObject(cfg.source_backends) ? cfg.source_backends : {};
      const list = sources.length ? sources : ['arxiv'];
      sourceListEl.innerHTML = list.map((source) => {
        const key = normalizeSourceKey(source);
        const backend = isPlainObject(backends[key])
          ? backends[key]
          : (buildDefaultSourceBackend(key, cfg) || {});
        const enabled = backend.enabled !== false;
        const schema = normalizeText(backend.schema || 'public');
        const table = normalizeText(backend.papers_table || '未配置');
        const vectorRpc = normalizeText(backend.vector_rpc_exact || backend.vector_rpc || '未配置');
        const bm25Rpc = normalizeText(backend.bm25_rpc || '未配置');
        return `
          <article class="dpr-source-card">
            <div class="dpr-source-card-head">
              <div>
                <div class="dpr-source-name">${escapeHtml(getPaperSourceLabel(key))}</div>
                <div class="dpr-source-subtitle">schema: ${escapeHtml(schema)}</div>
              </div>
              <span class="dpr-source-status ${enabled ? 'is-on' : 'is-off'}">${enabled ? '已启用' : '已停用'}</span>
            </div>
            <div class="dpr-source-meta">
              <span>表：${escapeHtml(table)}</span>
              <span>向量 RPC：${escapeHtml(vectorRpc)}</span>
              <span>BM25 RPC：${escapeHtml(bm25Rpc)}</span>
            </div>
          </article>
        `;
      }).join('');
    }
    if (storageStatusEl) {
      const sourceText = lastConfigSource || 'config.yaml';
      storageStatusEl.innerHTML = `
        <div class="dpr-storage-row">
          <span>配置来源</span>
          <strong>${escapeHtml(sourceText)}</strong>
        </div>
        <div class="dpr-storage-row">
          <span>检索配置</span>
          <strong>${profiles.length} 个词条</strong>
        </div>
        <div class="dpr-storage-row">
          <span>草稿状态</span>
          <strong>${hasUnsavedChanges ? '有未保存更改' : '已同步'}</strong>
        </div>
      `;
    }
  };

  const refreshQuickRunButtons = (options = {}) => {
    const blocked = hasUnsavedChanges;
    [
      quickRunTodayBtn,
      quickRun10dBtn,
      quickRun30dBtn,
      quickRun30dStandardBtn,
      quickRunWeeklyReportBtn,
      quickRunMonthlyReportBtn,
      quickRunWeeklyRecrawlBtn,
      quickRunMonthlyRecrawlBtn,
    ].forEach((btn) => {
      if (!btn) return;
      btn.disabled = blocked;
      btn.classList.toggle('chat-quick-run-item--disabled', blocked);
      btn.title = blocked
        ? '请先点击“保存”后再发起快速抓取。'
        : (btn.getAttribute('data-default-title') || btn.textContent || '');
    });
    if (blocked && quickRunMsgEl) {
      quickRunMsgEl.textContent = '检测到未保存修改，请先保存后再发起快速抓取。';
      quickRunMsgEl.style.color = '#c00';
    }
    if (blocked && periodicReportMsgEl) {
      periodicReportMsgEl.textContent = '检测到未保存修改，请先保存后再发起周期报告。';
      periodicReportMsgEl.style.color = '#c00';
    }
    if (!blocked) {
      clearUnsavedRunMessage(quickRunMsgEl);
      clearUnsavedRunMessage(periodicReportMsgEl);
    }
    syncDailyReportFields();
    updateSettingsChrome();
    if (options.renderSnapshot !== false) {
      renderSettingsSnapshot();
    }
  };

  const setQuickRunMessage = (text, color) => {
    if (quickRunMsgEl) {
      quickRunMsgEl.textContent = text || '';
      quickRunMsgEl.style.color = color || '#666';
    }
    if (msgEl && msgEl !== quickRunMsgEl) {
      msgEl.textContent = text || '';
      msgEl.style.color = color || '#666';
    }
  };

  const runQuickFetch = (days, msgEl, tipText, runOptions) => {
    if (hasUnsavedChanges) {
      const text = '检测到未保存修改，请先点击“保存”后再发起快速抓取。';
      if (msgEl) {
        msgEl.textContent = text;
        msgEl.style.color = '#c00';
      }
      setQuickRunMessage(text, '#c00');
      return false;
    }
    if (!window.DPRWorkflowRunner || typeof window.DPRWorkflowRunner.runQuickFetchByDays !== 'function') {
      const text = '工作流触发器未加载到当前页面。';
      if (msgEl) {
        msgEl.textContent = text;
        msgEl.style.color = '#c00';
      }
      setQuickRunMessage(text, '#c00');
      return false;
    }
    const options = runOptions && typeof runOptions === 'object' ? runOptions : {};
    window.DPRWorkflowRunner.runQuickFetchByDays(days, options);
    const finalTip = (typeof tipText === 'string' ? tipText : null) || `已发起 ${days} 天内抓取任务。`;
    if (msgEl) {
      msgEl.textContent = finalTip;
      msgEl.style.color = '#080';
    }
    setQuickRunMessage(finalTip, '#080');
    return true;
  };

  const setPeriodicReportMessage = (text, color) => {
    if (periodicReportMsgEl) {
      periodicReportMsgEl.textContent = text || '';
      periodicReportMsgEl.style.color = color || '#666';
    }
    if (msgEl && msgEl !== periodicReportMsgEl) {
      msgEl.textContent = text || '';
      msgEl.style.color = color || '#666';
    }
  };

  const runPeriodicReportQuick = (period, inputMode, fetchDays) => {
    if (hasUnsavedChanges) {
      setPeriodicReportMessage('检测到未保存修改，请先点击“保存”后再发起周期报告。', '#c00');
      return false;
    }
    if (!window.DPRWorkflowRunner || typeof window.DPRWorkflowRunner.runPeriodicReport !== 'function') {
      setPeriodicReportMessage('周期报告工作流触发器未加载到当前页面。', '#c00');
      return false;
    }
    const periodKey = period === 'monthly' ? 'monthly' : 'weekly';
    const mode = normalizePeriodicInputMode(inputMode, 'artifacts');
    const dispatchInputs = {};
    if (fetchDays) {
      dispatchInputs.fetch_days = String(fetchDays);
    }
    window.DPRWorkflowRunner.runPeriodicReport(periodKey, mode, { dispatchInputs });
    const periodLabel = periodKey === 'monthly' ? '月报' : '周报';
    const modeLabel = mode === 'artifacts' ? 'artifact' : mode;
    const fetchText = fetchDays ? `，候选池窗口 ${fetchDays} 天` : '';
    setPeriodicReportMessage(`已发起${periodLabel}生成任务（${modeLabel}${fetchText}）。`, '#080');
    return true;
  };

  const runProfileQuickFetch = (profileTag, days, runOptions) => {
    const normalizedTag = normalizeText(profileTag);
    if (!normalizedTag) {
      setQuickRunMessage('词条标签为空，无法发起单词条抓取。', '#c00');
      return false;
    }
    const options = runOptions && typeof runOptions === 'object' ? cloneDeep(runOptions) : {};
    const dispatchInputs = isPlainObject(options.dispatchInputs) ? options.dispatchInputs : {};
    options.dispatchInputs = {
      ...dispatchInputs,
      profile_tag: normalizedTag,
    };
    const fetchMode = normalizeText(options.fetchMode).toLowerCase();
    const modeText = fetchMode === 'standard'
      ? '30 天标准抓取任务'
      : (fetchMode === 'skims' ? '30 天速览抓取任务' : `${days} 天抓取任务`);
    const tip = `已发起词条「${normalizedTag}」的${modeText}。`;
    return runQuickFetch(days, quickRunMsgEl || msgEl, tip, options);
  };

  const runResetContent = (msgEl) => {
    if (String(window.DPR_ACCESS_MODE || '') !== 'full') {
      if (msgEl) {
        msgEl.textContent = '未检测到完整登录权限，危险操作未开启。';
        msgEl.style.color = '#c00';
      }
      return;
    }

    const confirmText = window.prompt(
      '危险操作：该操作会将 docs 备份为 docs_backup_xxx 后恢复为 docs_init，并清空 archive。输入「RESET_ALL」确认。',
    );
    if (confirmText !== 'RESET_ALL') {
      if (msgEl) {
        msgEl.textContent = '已取消危险操作。';
        msgEl.style.color = '#666';
      }
      return;
    }

    if (!window.DPRWorkflowRunner || typeof window.DPRWorkflowRunner.runWorkflowByKey !== 'function') {
      if (msgEl) {
        msgEl.textContent = '工作流触发器未加载到当前页面。';
        msgEl.style.color = '#c00';
      }
      return;
    }

    window.DPRWorkflowRunner.runWorkflowByKey('reset-content');
    if (msgEl) {
      msgEl.textContent = '已发起删除并重置任务，已触发工作流。';
      msgEl.style.color = '#080';
    }
  };

  const setEmailMessage = (text, color) => {
    if (emailMsgEl) {
      emailMsgEl.textContent = text || '';
      emailMsgEl.style.color = color || '#666';
    }
  };

  const getEmailDeliveryDraft = () => {
    const secret = window.decoded_secret_private || {};
    const email = isPlainObject(secret.emailDelivery) ? secret.emailDelivery : {};
    return {
      enabled: Object.prototype.hasOwnProperty.call(email, 'enabled')
        ? email.enabled !== false
        : false,
      to: normalizeText(email.to || ''),
      from: normalizeText(email.from || ''),
      smtpHost: normalizeText(email.smtpHost || ''),
      smtpPort: normalizeText(email.smtpPort || '587'),
      smtpUser: normalizeText(email.smtpUser || ''),
      siteUrl: normalizeText(email.siteUrl || ''),
      time: normalizeDailyPushTime(email.time || DEFAULT_EMAIL_PUSH_TIME),
      timezone: normalizeEmailTimezone(email.timezone || DEFAULT_EMAIL_TIMEZONE),
    };
  };

  const syncEmailSettingsFields = () => {
    if (!panel) return;
    const draft = getEmailDeliveryDraft();
    const setValue = (id, value) => {
      const input = document.getElementById(id);
      if (input && document.activeElement !== input) {
        input.value = value;
      }
    };
    const enabledEl = document.getElementById('dpr-email-enabled-select');
    if (enabledEl && document.activeElement !== enabledEl) {
      enabledEl.value = draft.enabled ? 'true' : 'false';
    }
    setValue('dpr-email-to-input', draft.to);
    setValue('dpr-email-from-input', draft.from);
    setValue('dpr-email-smtp-host-input', draft.smtpHost);
    setValue('dpr-email-smtp-port-input', draft.smtpPort);
    setValue('dpr-email-smtp-user-input', draft.smtpUser);
    setValue('dpr-email-site-url-input', draft.siteUrl);
    setValue('dpr-email-time-input', draft.time);
    const timezoneEl = document.getElementById('dpr-email-timezone-select');
    if (timezoneEl && document.activeElement !== timezoneEl) {
      timezoneEl.value = draft.timezone;
    }
  };

  const collectEmailSettingsDraft = () => {
    const getValue = (id) => normalizeText((document.getElementById(id) || {}).value || '');
    const enabled = getValue('dpr-email-enabled-select') !== 'false';
    const to = getValue('dpr-email-to-input');
    const from = getValue('dpr-email-from-input');
    const smtpHost = getValue('dpr-email-smtp-host-input');
    const smtpPort = getValue('dpr-email-smtp-port-input') || '587';
    const smtpUser = getValue('dpr-email-smtp-user-input');
    const smtpPassword = getValue('dpr-email-smtp-password-input');
    const siteUrl = getValue('dpr-email-site-url-input');
    const time = normalizeDailyPushTime(getValue('dpr-email-time-input'));
    const timezone = normalizeEmailTimezone(getValue('dpr-email-timezone-select'));
    const portNumber = parseInt(smtpPort, 10);

    if (enabled) {
      if (!isLikelyEmail(to)) throw new Error('请填写有效的收件邮箱。');
      if (!isLikelyEmail(from)) throw new Error('请填写有效的发件邮箱。');
      if (!smtpHost) throw new Error('请填写 SMTP Host。');
      if (!Number.isFinite(portNumber) || portNumber <= 0 || portNumber > 65535) {
        throw new Error('SMTP Port 必须是 1-65535 之间的数字。');
      }
      if (!smtpUser) throw new Error('请填写 SMTP 用户名。');
      if (!smtpPassword) throw new Error('请填写 SMTP 密码或应用专用密码。');
    }

    return {
      enabled,
      to,
      from,
      smtpHost,
      smtpPort: String(portNumber || 587),
      smtpUser,
      smtpPassword,
      siteUrl,
      time,
      timezone,
    };
  };

  const updateEmailWorkflowSchedule = async (time, timezone) => {
    const schedule = buildEmailWorkflowCron(time, timezone);
    const nextLine = `    - cron: "${schedule.cron}" # DPR_EMAIL_SCHEDULE ${schedule.timezone} ${schedule.time}`;
    const updateWorkflow = (content) => {
      const text = String(content || '');
      if (text.includes('# DPR_EMAIL_SCHEDULE')) {
        return text.replace(/^    - cron: ".*" # DPR_EMAIL_SCHEDULE .*$/m, nextLine);
      }
      return text.replace(/^    - cron: ".*".*$/m, nextLine);
    };
    await window.SubscriptionsGithubToken.updateRepoTextFile(
      EMAIL_WORKFLOW_PATH,
      updateWorkflow,
      `[chore] update email brief schedule ${schedule.timezone} ${schedule.time}`,
      { requireWorkflow: true },
    );
    return schedule;
  };

  const saveEmailPushSettings = async () => {
    if (!window.SubscriptionsGithubToken || typeof window.SubscriptionsGithubToken.saveSecrets !== 'function') {
      setEmailMessage('当前无法写入 GitHub Secrets，请先完成 GitHub 登录。', '#c00');
      return;
    }
    if (typeof window.SubscriptionsGithubToken.updateRepoTextFile !== 'function') {
      setEmailMessage('当前无法更新邮件工作流，请刷新页面后重试。', '#c00');
      return;
    }

    let settings = null;
    try {
      settings = collectEmailSettingsDraft();
    } catch (e) {
      setEmailMessage(e.message || '邮件配置不完整。', '#c00');
      return;
    }

    try {
      if (emailSaveBtn) emailSaveBtn.disabled = true;
      if (emailTestBtn) emailTestBtn.disabled = true;
      setEmailMessage('正在写入 GitHub Secrets...', '#666');
      const secrets = {
        DPR_EMAIL_ENABLED: settings.enabled ? 'true' : 'false',
        DPR_EMAIL_TIME: settings.time,
        DPR_EMAIL_TIMEZONE: settings.timezone,
      };
      if (settings.enabled) {
        Object.assign(secrets, {
          DPR_EMAIL_TO: settings.to,
          DPR_EMAIL_FROM: settings.from,
          DPR_SMTP_HOST: settings.smtpHost,
          DPR_SMTP_PORT: settings.smtpPort,
          DPR_SMTP_USER: settings.smtpUser,
          DPR_SMTP_PASSWORD: settings.smtpPassword,
        });
        if (settings.siteUrl) {
          secrets.DPR_EMAIL_SITE_URL = settings.siteUrl;
        }
      }
      await window.SubscriptionsGithubToken.saveSecrets(secrets, (current, total, name) => {
        setEmailMessage(`(${current}/${total}) 正在上传 GitHub Secret：${name}...`, '#666');
      });
      setEmailMessage('Secrets 已保存，正在更新邮件工作流定时...', '#666');
      const schedule = await updateEmailWorkflowSchedule(settings.time, settings.timezone);
      const secret = isPlainObject(window.decoded_secret_private)
        ? window.decoded_secret_private
        : {};
      secret.emailDelivery = {
        enabled: settings.enabled,
        to: settings.to,
        from: settings.from,
        smtpHost: settings.smtpHost,
        smtpPort: settings.smtpPort,
        smtpUser: settings.smtpUser,
        siteUrl: settings.siteUrl,
        time: settings.time,
        timezone: settings.timezone,
      };
      window.decoded_secret_private = secret;
      const passwordInput = document.getElementById('dpr-email-smtp-password-input');
      if (passwordInput) {
        passwordInput.value = '';
      }
      setEmailMessage(`邮件推送已保存；GitHub Actions 将按 ${schedule.timezone} ${schedule.time} 运行。`, '#080');
    } catch (e) {
      console.error(e);
      setEmailMessage(`保存邮件推送失败：${(e && e.message) || e}`.slice(0, 220), '#c00');
    } finally {
      if (emailSaveBtn) emailSaveBtn.disabled = false;
      if (emailTestBtn) emailTestBtn.disabled = false;
    }
  };

  const setEmbeddingMessage = (text, color) => {
    if (embeddingMsgEl) {
      embeddingMsgEl.textContent = text || '';
      embeddingMsgEl.style.color = color || '#666';
    }
  };

  const setEmbeddingCustomPanelVisible = (visible) => {
    const customPanel = document.getElementById('dpr-embedding-custom-panel');
    if (!customPanel) return;
    customPanel.hidden = !visible;
    customPanel.setAttribute('aria-hidden', visible ? 'false' : 'true');
    Array.from(customPanel.querySelectorAll('input, select, textarea, button')).forEach((el) => {
      el.disabled = !visible;
    });
  };

  const syncEmbeddingSettingsFields = () => {
    if (!panel) return;
    const state = resolveEmbeddingServiceState();
    const profile = state.profile === 'advanced' ? DEFAULT_EMBEDDING_PROFILE : state.profile;
    const radio = document.querySelector(`input[name="dpr-embedding-profile"][value="${profile}"]`);
    if (radio) radio.checked = true;
    setEmbeddingCustomPanelVisible(profile === 'custom');
    const providerSelect = document.getElementById('dpr-embedding-provider-select');
    if (providerSelect && document.activeElement !== providerSelect) {
      providerSelect.value = state.provider || DEFAULT_EMBEDDING_PROVIDER;
    }
    const statusEl = document.getElementById('dpr-embedding-current-status');
    if (statusEl) {
      const labels = {
        local: '本地 embedding',
        default_remote: '默认 embedding',
        custom: state.hasCustomCredentials
          ? `自定义 embedding（${state.provider === 'legacy' ? 'legacy /embed' : 'OpenAI'} 已配置）`
          : '自定义 embedding（未配置）',
      };
      statusEl.textContent = labels[profile] || labels.default_remote;
    }
  };

  const collectEmbeddingSettingsDraft = () => {
    const selected = document.querySelector('input[name="dpr-embedding-profile"]:checked');
    const profile = normalizeEmbeddingProfile(selected ? selected.value : DEFAULT_EMBEDDING_PROFILE);
    const getValue = (id) => normalizeText((document.getElementById(id) || {}).value || '');
    return {
      profile,
      provider: getValue('dpr-embedding-provider-select') || DEFAULT_EMBEDDING_PROVIDER,
      endpoint: getValue('dpr-embedding-endpoint-input') || getValue('dpr-embedding-api-url-input'),
      model: getValue('dpr-embedding-model-input'),
      apiKey: getValue('dpr-embedding-api-key-input'),
    };
  };

  const saveEmbeddingSettings = async () => {
    if (
      !window.SubscriptionsGithubToken
      || typeof window.SubscriptionsGithubToken.saveSecrets !== 'function'
      || typeof window.SubscriptionsGithubToken.saveVariables !== 'function'
    ) {
      setEmbeddingMessage('当前无法写入 GitHub Secrets/Variables，请先完成 GitHub 登录。', '#c00');
      return;
    }

    let draft = null;
    let secrets = null;
    let variables = null;
    try {
      draft = collectEmbeddingSettingsDraft();
      secrets = buildEmbeddingSecretsPayload(draft);
      variables = buildEmbeddingVariablesPayload(draft);
    } catch (e) {
      setEmbeddingMessage(e.message || 'Embedding 配置不完整。', '#c00');
      return;
    }

    try {
      if (embeddingSaveBtn) embeddingSaveBtn.disabled = true;
      setEmbeddingMessage('正在写入 GitHub Variables...', '#666');
      await window.SubscriptionsGithubToken.saveVariables(variables, (current, total, name) => {
        setEmbeddingMessage(`(${current}/${total}) 正在保存 GitHub Variable：${name}...`, '#666');
      });
      if (Object.keys(secrets || {}).length > 0) {
        setEmbeddingMessage('正在写入 GitHub Secrets...', '#666');
        await window.SubscriptionsGithubToken.saveSecrets(secrets, (current, total, name) => {
          setEmbeddingMessage(`(${current}/${total}) 正在上传 GitHub Secret：${name}...`, '#666');
        });
      }
      const secret = isPlainObject(window.decoded_secret_private)
        ? window.decoded_secret_private
        : {};
      secret.embeddingService = {
        profile: normalizeEmbeddingProfile(draft.profile),
        provider: normalizeEmbeddingProvider(draft.provider),
        timeout: DEFAULT_EMBEDDING_TIMEOUT,
        fallback: DEFAULT_EMBEDDING_FALLBACK,
        hasCustomCredentials: normalizeEmbeddingProfile(draft.profile) === 'custom',
      };
      window.decoded_secret_private = secret;
      const apiKeyInput = document.getElementById('dpr-embedding-api-key-input');
      if (apiKeyInput) apiKeyInput.value = '';
      syncEmbeddingSettingsFields();
      setEmbeddingMessage('Embedding 设置已保存；Endpoint/模型写入 Variables，API Key 写入 Secrets 且不会回显明文。', '#080');
    } catch (e) {
      console.error(e);
      setEmbeddingMessage(`保存 embedding 设置失败：${(e && e.message) || e}`.slice(0, 220), '#c00');
    } finally {
      if (embeddingSaveBtn) embeddingSaveBtn.disabled = false;
    }
  };

  const bindEmbeddingSettingsInputs = () => {
    const profileInputs = Array.from(document.querySelectorAll('input[name="dpr-embedding-profile"]'));
    profileInputs.forEach((input) => {
      if (input._bound) return;
      input._bound = true;
      input.addEventListener('change', () => {
        setEmbeddingCustomPanelVisible(normalizeEmbeddingProfile(input.value) === 'custom');
        setEmbeddingMessage('', '#666');
      });
    });
    embeddingSaveBtn = document.getElementById('dpr-embedding-save-btn');
    embeddingMsgEl = document.getElementById('dpr-embedding-settings-msg');
    if (embeddingSaveBtn && !embeddingSaveBtn._bound) {
      embeddingSaveBtn._bound = true;
      embeddingSaveBtn.addEventListener('click', saveEmbeddingSettings);
    }
  };

  const setRerankerMessage = (text, color) => {
    if (rerankerMsgEl) {
      rerankerMsgEl.textContent = text || '';
      rerankerMsgEl.style.color = color || '#666';
    }
  };

  const setRerankerCustomPanelVisible = (visible) => {
    const customPanel = document.getElementById('dpr-reranker-custom-panel');
    if (!customPanel) return;
    customPanel.hidden = !visible;
    customPanel.setAttribute('aria-hidden', visible ? 'false' : 'true');
    Array.from(customPanel.querySelectorAll('input, select, textarea, button')).forEach((el) => {
      el.disabled = !visible;
    });
  };

  const syncRerankerSettingsFields = () => {
    if (!panel) return;
    const state = resolveRerankerServiceState();
    const mode = state.enabled ? 'enabled' : 'disabled';
    const radio = document.querySelector(`input[name="dpr-reranker-mode"][value="${mode}"]`);
    if (radio) radio.checked = true;
    setRerankerCustomPanelVisible(state.enabled);
    const statusEl = document.getElementById('dpr-reranker-current-status');
    if (statusEl) {
      statusEl.textContent = state.enabled && state.hasCredentials
        ? 'Reranker 已配置'
        : (state.enabled ? 'Reranker 待补全' : 'RRF fallback');
    }
  };

  const collectRerankerSettingsDraft = () => {
    const selected = document.querySelector('input[name="dpr-reranker-mode"]:checked');
    const mode = selected ? selected.value : 'disabled';
    const getValue = (id) => normalizeText((document.getElementById(id) || {}).value || '');
    return {
      enabled: mode === 'enabled',
      provider: DEFAULT_RERANK_PROVIDER,
      endpoint: getValue('dpr-reranker-endpoint-input'),
      model: getValue('dpr-reranker-model-input'),
      apiKey: getValue('dpr-reranker-api-key-input'),
    };
  };

  const saveRerankerSettings = async () => {
    if (
      !window.SubscriptionsGithubToken
      || typeof window.SubscriptionsGithubToken.saveSecrets !== 'function'
      || typeof window.SubscriptionsGithubToken.saveVariables !== 'function'
    ) {
      setRerankerMessage('当前无法写入 GitHub Secrets/Variables，请先完成 GitHub 登录。', '#c00');
      return;
    }

    let draft = null;
    let secrets = null;
    let variables = null;
    try {
      draft = collectRerankerSettingsDraft();
      secrets = buildRerankerSecretsPayload(draft);
      variables = buildRerankerVariablesPayload(draft);
    } catch (e) {
      setRerankerMessage(e.message || 'Reranker 配置不完整。', '#c00');
      return;
    }

    try {
      if (rerankerSaveBtn) rerankerSaveBtn.disabled = true;
      setRerankerMessage('正在写入 GitHub Variables...', '#666');
      await window.SubscriptionsGithubToken.saveVariables(variables, (current, total, name) => {
        setRerankerMessage(`(${current}/${total}) 正在保存 GitHub Variable：${name}...`, '#666');
      });
      if (Object.keys(secrets || {}).length > 0) {
        setRerankerMessage('正在写入 GitHub Secrets...', '#666');
        await window.SubscriptionsGithubToken.saveSecrets(secrets, (current, total, name) => {
          setRerankerMessage(`(${current}/${total}) 正在上传 GitHub Secret：${name}...`, '#666');
        });
      }
      const enabled = normalizeRerankerEnabled(draft.enabled);
      const secret = isPlainObject(window.decoded_secret_private)
        ? window.decoded_secret_private
        : {};
      secret.rerankerService = {
        enabled,
        provider: enabled ? DEFAULT_RERANK_PROVIDER : 'disabled',
        timeout: DEFAULT_RERANK_TIMEOUT,
        hasCredentials: enabled,
      };
      secret.rerankerLLM = {
        enabled,
      };
      window.decoded_secret_private = secret;
      const apiKeyInput = document.getElementById('dpr-reranker-api-key-input');
      if (apiKeyInput) apiKeyInput.value = '';
      syncRerankerSettingsFields();
      setRerankerMessage(
        enabled
          ? 'Reranker 设置已保存；Endpoint/模型写入 Variables，API Key 写入 Secrets 且不会回显明文。'
          : 'Reranker 已关闭；工作流将使用 RRF fallback。',
        '#080',
      );
    } catch (e) {
      console.error(e);
      setRerankerMessage(`保存 reranker 设置失败：${(e && e.message) || e}`.slice(0, 220), '#c00');
    } finally {
      if (rerankerSaveBtn) rerankerSaveBtn.disabled = false;
    }
  };

  const bindRerankerSettingsInputs = () => {
    const modeInputs = Array.from(document.querySelectorAll('input[name="dpr-reranker-mode"]'));
    modeInputs.forEach((input) => {
      if (input._bound) return;
      input._bound = true;
      input.addEventListener('change', () => {
        setRerankerCustomPanelVisible(input.value === 'enabled');
        setRerankerMessage('', '#666');
      });
    });
    rerankerSaveBtn = document.getElementById('dpr-reranker-save-btn');
    rerankerMsgEl = document.getElementById('dpr-reranker-settings-msg');
    if (rerankerSaveBtn && !rerankerSaveBtn._bound) {
      rerankerSaveBtn._bound = true;
      rerankerSaveBtn.addEventListener('click', saveRerankerSettings);
    }
  };

  const setAdvancedConfigDialogVisible = (visible) => {
    const overlay = document.getElementById('dpr-advanced-config-overlay');
    if (!overlay) return;
    if (visible) {
      if (advancedConfigHideTimer) {
        clearTimeout(advancedConfigHideTimer);
        advancedConfigHideTimer = null;
      }
      overlay.classList.remove('secret-gate-hidden');
      overlay.setAttribute('aria-hidden', 'false');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          overlay.classList.add('show');
        });
      });
      syncEmbeddingSettingsFields();
      syncRerankerSettingsFields();
      const closeButton = overlay.querySelector('[data-dpr-advanced-config-close]');
      if (closeButton && typeof closeButton.focus === 'function') {
        window.setTimeout(() => closeButton.focus(), 0);
      }
      return;
    }
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
    if (advancedConfigHideTimer) {
      clearTimeout(advancedConfigHideTimer);
    }
    advancedConfigHideTimer = window.setTimeout(() => {
      overlay.classList.add('secret-gate-hidden');
      advancedConfigHideTimer = null;
    }, 300);
  };

  const bindAdvancedConfigDialog = () => {
    const openBtn = document.getElementById('dpr-open-advanced-config-btn');
    const overlay = document.getElementById('dpr-advanced-config-overlay');
    if (!openBtn || !overlay) return;
    if (overlay.parentElement !== document.body) {
      document.body.appendChild(overlay);
    }

    if (!openBtn._bound) {
      openBtn._bound = true;
      openBtn.addEventListener('click', () => setAdvancedConfigDialogVisible(true));
    }
    Array.from(overlay.querySelectorAll('[data-dpr-advanced-config-close]')).forEach((btn) => {
      if (btn._bound) return;
      btn._bound = true;
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setAdvancedConfigDialogVisible(false);
      });
    });
    if (!overlay._bound) {
      overlay._bound = true;
      overlay.addEventListener('mousedown', (event) => {
        if (event.target === overlay) {
          event.preventDefault();
          event.stopPropagation();
          setAdvancedConfigDialogVisible(false);
        }
      });
      overlay.addEventListener('click', (event) => {
        event.stopPropagation();
      });
    }
    if (!document._dprAdvancedConfigEscBound) {
      document._dprAdvancedConfigEscBound = true;
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          setAdvancedConfigDialogVisible(false);
        }
      });
    }
  };


  const sendEmailTest = () => {
    if (!window.DPRWorkflowRunner || typeof window.DPRWorkflowRunner.runWorkflowByKey !== 'function') {
      setEmailMessage('工作流触发器未加载到当前页面。', '#c00');
      return;
    }
    window.DPRWorkflowRunner.runWorkflowByKey('email-brief', {
      force_send: 'true',
      dry_run: 'false',
    });
    setEmailMessage('已触发测试邮件工作流，请到 Actions 面板查看发送结果。', '#080');
  };

  const normalizeProfiles = (subs, availableSources) => {
    const profiles = Array.isArray(subs.intent_profiles) ? subs.intent_profiles : [];
    return profiles
      .map((p, idx) => {
        if (!p || typeof p !== 'object') return null;
        const tag = normalizeText(p.tag) || toStableId(p.description || `profile-${idx + 1}`);
        const description = normalizeText(p.description || '');
        const enabled = p.enabled !== false;
        const fallbackToArxiv = !Object.prototype.hasOwnProperty.call(p, 'paper_sources');
        const paperSources = normalizePaperSources(p.paper_sources, { fallbackToArxiv });
        const dailyPaperLimits = resolveDailyPaperLimits(p);
        const keywordRules = (Array.isArray(p.keywords) ? p.keywords : []).map(normalizeKeywordItem).filter(Boolean);
        const normalizedKeywords = dedupeKeywords(keywordRules);
        const normalizedIntentQueries = normalizeIntentQueries(p.intent_queries);
        if (!keywordRules.length && !normalizedKeywords.length && !normalizedIntentQueries.length) {
          return null;
        }

        const result = {
          tag,
          description,
          enabled,
          paper_sources: paperSources,
          deep_daily_paper_limit: dailyPaperLimits.deep,
          quick_daily_paper_limit: dailyPaperLimits.quick,
          keywords: normalizedKeywords,
          intent_queries: normalizedIntentQueries,
          updated_at: normalizeText(p.updated_at) || new Date().toISOString(),
        };
        if ('paused' in p) {
          result.paused = !!p.paused;
        }
        return result;
      })
      .filter(Boolean);
  };

  const validateIntentProfiles = (config) => {
    const cfg = ensureSourceBackendsForProfiles(cloneDeep(config || {}));
    const subs = (cfg && cfg.subscriptions) || {};
    const availableSources = getAvailablePaperSources(cfg);
    const profiles = Array.isArray(subs.intent_profiles) ? subs.intent_profiles : [];
    for (let idx = 0; idx < profiles.length; idx += 1) {
      const profile = profiles[idx];
      if (!profile || typeof profile !== 'object') continue;
      const tag = normalizeText(profile.tag) || `词条${idx + 1}`;
      const fallbackToArxiv = !Object.prototype.hasOwnProperty.call(profile, 'paper_sources');
      const paperSources = normalizePaperSources(profile.paper_sources, { fallbackToArxiv });
      const keywords = dedupeKeywords(
        (Array.isArray(profile.keywords) ? profile.keywords : [])
          .map(normalizeKeywordItem)
          .filter(Boolean),
      );
      const intentQueries = normalizeIntentQueries(profile.intent_queries);
      if (!paperSources.length) {
        return `词条「${tag}」至少需要 1 个论文源。`;
      }
      const unknownSources = paperSources.filter((item) => !availableSources.includes(item));
      if (unknownSources.length) {
        return `词条「${tag}」包含未配置的论文源：${unknownSources.join(', ')}。`;
      }
      if (!keywords.length) {
        return `词条「${tag}」至少需要 1 条关键词。`;
      }
      if (keywords.length > MAX_KEYWORDS_PER_PROFILE) {
        return `词条「${tag}」的关键词最多只能保留 ${MAX_KEYWORDS_PER_PROFILE} 条。`;
      }
      if (!intentQueries.length) {
        return `词条「${tag}」至少需要 1 条意图Query。`;
      }
      if (intentQueries.length > MAX_INTENT_QUERIES_PER_PROFILE) {
        return `词条「${tag}」的意图Query 最多只能保留 ${MAX_INTENT_QUERIES_PER_PROFILE} 条。`;
      }
    }
    return '';
  };

  const stripIntentProfileIds = (config) => {
    const next = cloneDeep(config || {});
    if (!next || typeof next !== 'object') return next;
    const subscriptions = next.subscriptions;
    if (!subscriptions || typeof subscriptions !== 'object') return next;
    const profiles = Array.isArray(subscriptions.intent_profiles) ? subscriptions.intent_profiles : [];
    if (!profiles.length) return next;

    subscriptions.intent_profiles = profiles
      .filter((p) => p && typeof p === 'object')
      .map((p) => {
        const profile = cloneDeep(p) || {};
        delete profile.id;

        if (Array.isArray(profile.keywords)) {
          profile.keywords = profile.keywords
            .filter((k) => k && typeof k === 'object')
            .map((k) => {
              const keyword = cloneDeep(k);
              delete keyword.id;
              return keyword;
            });
        }

        if (Array.isArray(profile.intent_queries)) {
          profile.intent_queries = profile.intent_queries
            .filter((item) => item && typeof item === 'object')
            .map((item) => {
              const intentQuery = cloneDeep(item);
              delete intentQuery.id;
              return intentQuery;
            });
        }

        return profile;
      });

    next.subscriptions = subscriptions;
    return next;
  };

  const migrateLegacyToProfilesIfNeeded = (subs) => {
    const existingProfiles = normalizeProfiles(subs);
    if (existingProfiles.length > 0) {
      subs.intent_profiles = existingProfiles;
    } else {
      subs.intent_profiles = [];
    }
    delete subs.keywords;
    delete subs.llm_queries;
    return subs;
  };

  const normalizeSubscriptions = (config) => {
    const next = cloneDeep(config || {});
    normalizeReaderProfile(next);
    if (!next.subscriptions) next.subscriptions = {};
    const subs = next.subscriptions;

    migrateLegacyToProfilesIfNeeded(subs);
    subs.intent_profiles = normalizeProfiles(subs, getAvailablePaperSources(next));

    const paperSetting = isPlainObject(next.arxiv_paper_setting)
      ? cloneDeep(next.arxiv_paper_setting)
      : {};
    const windows = resolvePaperWindows({ arxiv_paper_setting: paperSetting });
    paperSetting.days_window = windows.daysWindow;
    paperSetting.carryover_days = windows.carryoverDays;
    next.arxiv_paper_setting = paperSetting;
    next.daily_reports = normalizeDailyReports(next.daily_reports);
    next.periodic_reports = normalizePeriodicReports(next.periodic_reports);

    if (!subs.schema_migration || typeof subs.schema_migration !== 'object') {
      subs.schema_migration = {};
    }
    if (!normalizeText(subs.schema_migration.stage)) {
      subs.schema_migration.stage = 'A';
    }
    if (!normalizeText(subs.schema_migration.diff_threshold_pct)) {
      subs.schema_migration.diff_threshold_pct = 15;
    }

    if (!normalizeText(subs.keyword_recall_mode)) {
      subs.keyword_recall_mode = 'or';
    }

    next.subscriptions = subs;
    ensureSourceBackendsForProfiles(next);
    return stripIntentProfileIds(next);
  };

  const setMessage = (text, color) => {
    if (msgEl) {
      msgEl.textContent = text || '';
      msgEl.style.color = color || '#666';
    }
    if (researchMsgEl) {
      researchMsgEl.textContent = text || '';
      researchMsgEl.style.color = color || '#666';
    }
  };

  const setResearchMessage = (text, color) => {
    if (researchMsgEl) {
      researchMsgEl.textContent = text || '';
      researchMsgEl.style.color = color || '#666';
    }
    if (msgEl) {
      msgEl.textContent = text || '';
      msgEl.style.color = color || '#666';
    }
  };

  const setResearchDirectionsDraft = (items, options = {}) => {
    const next = cloneDeep(draftConfig || {});
    const readerProfile = isPlainObject(next.reader_profile)
      ? cloneDeep(next.reader_profile)
      : {};
    readerProfile.research_directions = options.normalize === false
      ? (Array.isArray(items) ? items.map((item) => String(item || '')) : [])
      : normalizeResearchDirections(items || []);
    next.reader_profile = readerProfile;
    draftConfig = options.normalize === false ? next : normalizeSubscriptions(next);
    hasUnsavedChanges = true;
    refreshQuickRunButtons({ renderSnapshot: options.renderSnapshot !== false });
  };

  const renderResearchDirections = () => {
    if (!panel) return;
    const listEl = document.getElementById('dpr-research-direction-list');
    const countEl = document.getElementById('dpr-research-direction-count');
    const fallbackEl = document.getElementById('dpr-research-direction-fallback');
    if (!listEl) return;
    const active = document.activeElement;
    const activeInList = active && active.closest && active.closest('#dpr-research-direction-list');
    const configured = getConfiguredResearchDirections(draftConfig || {});
    const resolved = resolveResearchDirections(draftConfig || {});
    const fallback = getFallbackResearchDirections(draftConfig || {});

    if (countEl) {
      countEl.textContent = `${configured.length}/${MAX_RESEARCH_DIRECTIONS}`;
    }
    if (fallbackEl) {
      if (configured.length) {
        fallbackEl.textContent = '已使用你手动配置的研究方向；清空后会自动回退到检索配置关键词。';
      } else if (fallback.length) {
        fallbackEl.textContent = `未手动配置时，将使用检索关键词：${fallback.join('、')}`;
      } else {
        fallbackEl.textContent = '尚未配置研究方向，也未从检索配置读取到可回退关键词。';
      }
    }

    if (activeInList) return;
    if (!configured.length) {
      listEl.innerHTML = `
        <div class="dpr-research-empty">
          <strong>未手动配置研究方向</strong>
          <span>${escapeHtml(resolved.directions.length ? '报告会使用检索配置关键词作为研究方向。' : '请先添加研究方向或完善检索关键词。')}</span>
        </div>
      `;
      return;
    }
    listEl.innerHTML = configured.map((item, index) => `
      <label class="dpr-research-direction-item">
        <input class="dpr-research-direction-check" type="checkbox" data-research-direction-index="${index}" />
        <span class="dpr-research-direction-index">${String(index + 1).padStart(2, '0')}</span>
        <input class="dpr-research-direction-input" type="text" value="${escapeHtml(item)}" data-research-direction-index="${index}" aria-label="研究方向 ${index + 1}" />
      </label>
    `).join('');
  };

  const addResearchDirectionsFromInput = () => {
    const inputEl = document.getElementById('dpr-research-bulk-input');
    const raw = inputEl ? inputEl.value : '';
    const incoming = normalizeResearchDirections(raw);
    if (!incoming.length) {
      setResearchMessage('请输入至少 1 个研究方向关键词；多条请用 、，逗号或分号分隔。', '#c00');
      return;
    }
    const current = getConfiguredResearchDirections(draftConfig || {});
    const merged = normalizeResearchDirections(current.concat(incoming));
    const added = Math.max(0, merged.length - current.length);
    setResearchDirectionsDraft(merged);
    if (inputEl) inputEl.value = '';
    if (merged.length >= MAX_RESEARCH_DIRECTIONS && current.length + incoming.length > MAX_RESEARCH_DIRECTIONS) {
      setResearchMessage(`已保留前 ${MAX_RESEARCH_DIRECTIONS} 个研究方向，超出的关键词未加入。`, '#c90');
    } else if (added === 0) {
      setResearchMessage('没有新增关键词；可能与已有研究方向重复。', '#c90');
    } else {
      setResearchMessage(`已新增 ${added} 个研究方向，记得点击右下角保存。`, '#080');
    }
  };

  const deleteSelectedResearchDirections = () => {
    const checks = Array.from(document.querySelectorAll('.dpr-research-direction-check:checked'));
    if (!checks.length) {
      setResearchMessage('请先勾选要删除的研究方向。', '#c00');
      return;
    }
    const selected = new Set(
      checks.map((el) => parseInt(el.getAttribute('data-research-direction-index') || '-1', 10)),
    );
    const current = getConfiguredResearchDirections(draftConfig || {});
    const next = current.filter((_item, idx) => !selected.has(idx));
    setResearchDirectionsDraft(next);
    setResearchMessage(`已删除 ${checks.length} 个研究方向，记得点击右下角保存。`, '#080');
  };

  const updateResearchDirectionAt = (index, value, options = {}) => {
    const current = getRawResearchDirections(draftConfig || {});
    if (index < 0 || index >= current.length) return;
    const next = current.slice();
    next[index] = options.normalize === false ? String(value || '') : normalizeText(value);
    setResearchDirectionsDraft(next, {
      normalize: options.normalize !== false,
      renderSnapshot: options.renderSnapshot !== false,
    });
  };

  const ensureOverlay = () => {
    if (overlay && panel) return;
    overlay = document.getElementById('arxiv-search-overlay');
    if (overlay) {
      panel = document.getElementById('arxiv-search-panel');
      return;
    }

    overlay = document.createElement('div');
    overlay.id = 'arxiv-search-overlay';
    overlay.innerHTML = `
      <div id="arxiv-search-panel">
        <div id="arxiv-search-panel-header">
          <div class="dpr-settings-title-block">
            <div id="dpr-settings-title">⚙️ 设置</div>
          </div>
          <div class="dpr-settings-window-actions">
            <span id="dpr-settings-unsaved-badge" class="dpr-settings-unsaved-badge">已保存</span>
            <button id="arxiv-search-close-btn" class="dpr-settings-close-btn" type="button" aria-label="关闭设置窗口">×</button>
          </div>
        </div>

        <div id="arxiv-search-panel-body">
          <aside class="dpr-settings-sidebar" aria-label="设置分类">
            <div class="dpr-settings-nav-group">
              <div class="dpr-settings-nav-label">常规</div>
              <button class="dpr-settings-nav-btn is-active" type="button" data-settings-page="search" aria-selected="true">
                <span class="dpr-settings-nav-icon">🔎</span>
                <span class="dpr-settings-nav-text">检索配置</span>
              </button>
              <button class="dpr-settings-nav-btn" type="button" data-settings-page="periodic" aria-selected="false">
                <span class="dpr-settings-nav-icon">📊</span>
                <span class="dpr-settings-nav-text">周期报告</span>
              </button>
              <button class="dpr-settings-nav-btn" type="button" data-settings-page="quick" aria-selected="false">
                <span class="dpr-settings-nav-icon">⚡</span>
                <span class="dpr-settings-nav-text">快速使用</span>
              </button>
              <button class="dpr-settings-nav-btn" type="button" data-settings-page="workflow" aria-selected="false">
                <span class="dpr-settings-nav-icon">▶</span>
                <span class="dpr-settings-nav-text">工作流</span>
              </button>
              <button class="dpr-settings-nav-btn" type="button" data-settings-page="sources" aria-selected="false">
                <span class="dpr-settings-nav-icon">📚</span>
                <span class="dpr-settings-nav-text">文献源</span>
              </button>
            </div>
            <div class="dpr-settings-nav-group">
              <div class="dpr-settings-nav-label">隐私</div>
              <button class="dpr-settings-nav-btn dpr-settings-nav-btn-privacy" type="button" data-settings-page="secrets" aria-selected="false">
                <span class="dpr-settings-nav-icon">🔐</span>
                <span class="dpr-settings-nav-text">密钥配置</span>
              </button>
              <button class="dpr-settings-nav-btn dpr-settings-nav-btn-privacy" type="button" data-settings-page="research" aria-selected="false">
                <span class="dpr-settings-nav-icon">🧭</span>
                <span class="dpr-settings-nav-text">研究方向</span>
              </button>
              <button class="dpr-settings-nav-btn dpr-settings-nav-btn-privacy" type="button" data-settings-page="email" aria-selected="false">
                <span class="dpr-settings-nav-icon">✉️</span>
                <span class="dpr-settings-nav-text">邮件推送</span>
              </button>
            </div>
            <div class="dpr-settings-nav-group">
              <div class="dpr-settings-nav-label">危险</div>
              <button class="dpr-settings-nav-btn dpr-settings-nav-btn-danger" type="button" data-settings-page="storage" aria-selected="false">
                <span class="dpr-settings-nav-icon">💾</span>
                <span class="dpr-settings-nav-text">存储</span>
              </button>
              <button class="dpr-settings-nav-btn dpr-settings-nav-btn-danger" type="button" data-settings-page="reset" aria-selected="false">
                <span class="dpr-settings-nav-icon">🧨</span>
                <span class="dpr-settings-nav-text">重置</span>
              </button>
            </div>
            <div class="dpr-settings-sidebar-card">
              <div class="dpr-settings-sidebar-kicker">当前状态</div>
              <div class="dpr-settings-sidebar-stats">
                <span><strong id="dpr-settings-profile-count">0</strong> 个检索词条</span>
                <span><strong id="dpr-settings-source-count">0</strong> 个文献源</span>
              </div>
            </div>
          </aside>

          <main id="arxiv-search-panel-main">
            <section class="dpr-settings-page dpr-settings-page-with-save is-active" data-settings-page-panel="search">
              <div class="dpr-search-config-layout">
                <div class="dpr-settings-card dpr-search-profiles-card">
                  <div class="dpr-settings-page-head dpr-search-profiles-head">
                    <div>
                      <div class="dpr-settings-page-kicker">General / Search</div>
                      <h2>检索配置</h2>
                      <p>用自然语言或手动规则维护检索词条，保存后写入 config.yaml。</p>
                    </div>
                    <button id="dpr-sq-open-chat-btn" class="arxiv-tool-btn dpr-settings-primary-btn" type="button">新增检索</button>
                  </div>

                  <div id="dpr-smart-query-section" class="arxiv-pane dpr-smart-pane dpr-smart-query-card">
                    <div id="dpr-sq-display" class="dpr-sq-display"></div>
                  </div>
                </div>

                <div class="dpr-settings-card dpr-window-settings-card">
                  <div class="dpr-settings-card-head">
                    <div>
                      <h3>窗口设置</h3>
                      <p>日报默认使用这些窗口；快速使用里的 10 / 30 天按钮仍会临时覆盖。Tips：建议顺延窗口&gt;=回溯窗口。</p>
                    </div>
                  </div>
                  <div class="dpr-window-settings-grid">
                    <label class="dpr-window-field" for="dpr-settings-days-window-input">
                      <span>回溯窗口：</span>
                      <div class="dpr-window-input-wrap">
                        <input id="dpr-settings-days-window-input" type="number" min="1" step="1" inputmode="numeric" />
                        <em>天</em>
                      </div>
                    </label>
                    <label class="dpr-window-field" for="dpr-settings-carryover-window-input">
                      <span>顺延窗口：</span>
                      <div class="dpr-window-input-wrap">
                        <input id="dpr-settings-carryover-window-input" type="number" min="1" step="1" inputmode="numeric" />
                        <em>天</em>
                      </div>
                    </label>
                  </div>
                  <div id="dpr-settings-window-warning" class="dpr-window-warning" hidden></div>
                </div>
              </div>

              <div id="dpr-smart-msg" class="dpr-settings-message">提示：修改后点击「保存更改」才会写入 config.yaml。</div>
              <div class="dpr-settings-save-row">
                <button id="arxiv-config-save-btn" class="arxiv-tool-btn dpr-settings-save-btn" type="button">保存更改</button>
              </div>
            </section>

            <section class="dpr-settings-page" data-settings-page-panel="quick" hidden>
              <div class="dpr-settings-page-head">
                <div>
                  <div class="dpr-settings-page-kicker">General / Quick Run</div>
                  <h2>快速使用</h2>
                  <p>选择常用抓取范围，直接触发日报工作流。存在未保存修改时会自动锁定。</p>
                </div>
              </div>
              <div class="dpr-quick-run-layout">
                <div id="arxiv-search-quick-run-side" class="dpr-settings-card dpr-quick-run-card">
                  <div class="dpr-settings-card-head">
                    <div>
                      <h3>快速抓取</h3>
                      <p>按常见使用场景启动论文检索与报告生成。</p>
                    </div>
                  </div>
                  <div class="dpr-quick-run-grid">
                    <button id="arxiv-admin-quick-run-today-btn" class="chat-quick-run-item" type="button">
                      <span>默认日报</span>
                      <small>使用检索配置回溯 <b data-dpr-default-window-days>5</b> 天，标准抓取</small>
                    </button>
                    <button id="arxiv-admin-quick-run-10d-btn" class="chat-quick-run-item" type="button">
                      <span>十天内论文</span>
                      <small>快速补齐近期遗漏论文</small>
                    </button>
                    <button id="arxiv-admin-quick-run-30d-btn" class="chat-quick-run-item" type="button">
                      <span>三十天速览</span>
                      <small>全速览模式，成本约 0.76</small>
                    </button>
                    <button id="arxiv-admin-quick-run-30d-standard-btn" class="chat-quick-run-item" type="button">
                      <span>三十天标准 / 精读</span>
                      <small>全标准模式，成本约 1.22</small>
                    </button>
                  </div>
                  <div id="arxiv-admin-quick-run-msg" class="chat-quick-run-msg"></div>
                </div>
                <div class="dpr-settings-card dpr-periodic-quick-card">
                  <div class="dpr-settings-card-head">
                    <div>
                      <h3>周期报告</h3>
                      <p>默认复用日报 artifact；重新抓取入口会扩大候选池，成本更高。</p>
                    </div>
                  </div>
                  <div class="dpr-quick-run-grid dpr-periodic-quick-grid">
                    <button id="arxiv-admin-weekly-report-btn" class="chat-quick-run-item" type="button">
                      <span>生成本周周报</span>
                      <small>artifact 模式：最省 token</small>
                    </button>
                    <button id="arxiv-admin-monthly-report-btn" class="chat-quick-run-item" type="button">
                      <span>生成本月月报</span>
                      <small>图表优先的 high-level 趋势</small>
                    </button>
                    <button id="arxiv-admin-weekly-recrawl-report-btn" class="chat-quick-run-item" type="button">
                      <span>重抓本周候选池</span>
                      <small>hybrid / 10 天窗口</small>
                    </button>
                    <button id="arxiv-admin-monthly-recrawl-report-btn" class="chat-quick-run-item" type="button">
                      <span>重抓本月候选池</span>
                      <small>hybrid / 30 天窗口</small>
                    </button>
                  </div>
                  <div id="dpr-periodic-report-msg" class="chat-quick-run-msg"></div>
                </div>
              </div>
            </section>

            <section class="dpr-settings-page" data-settings-page-panel="workflow" hidden>
              <div class="dpr-settings-page-head">
                <div>
                  <div class="dpr-settings-page-kicker">General / Workflow</div>
                  <h2>工作流</h2>
                  <p>查看 GitHub Actions 运行状态，或打开完整工作流面板发起高级操作。</p>
                </div>
                <button id="arxiv-admin-open-workflow-panel-btn" class="arxiv-tool-btn dpr-settings-primary-btn" type="button">打开工作流面板</button>
              </div>
              <div class="dpr-workflow-settings-layout">
                <div id="dpr-daily-auto-card" class="dpr-settings-card dpr-daily-auto-card">
                  <div class="dpr-daily-auto-main">
                    <div class="dpr-daily-auto-icon" aria-hidden="true">☀️</div>
                    <div class="dpr-daily-auto-copy">
                      <div class="dpr-daily-auto-kicker">Scheduled Daily Report</div>
                      <h3>自动日报</h3>
                      <p id="dpr-daily-auto-summary">${DAILY_AUTO_SCHEDULE_LABEL} 自动生成日报。</p>
                    </div>
                  </div>
                  <div class="dpr-daily-auto-actions">
                    <span id="dpr-daily-auto-status" class="dpr-daily-auto-status">已开启</span>
                    <button id="dpr-daily-auto-toggle-btn" class="arxiv-tool-btn dpr-settings-primary-btn dpr-daily-auto-toggle-btn" type="button">暂停自动日报</button>
                  </div>
                  <div id="dpr-daily-auto-msg" class="dpr-settings-message dpr-daily-auto-msg">${DAILY_AUTO_DEFAULT_MESSAGE}</div>
                </div>
                <div class="dpr-settings-card dpr-workflow-guide-card">
                  <div class="dpr-workflow-guide-step">
                    <span>1</span>
                    <div>
                      <h3>保存配置</h3>
                      <p>检索配置页右下角保存后，workflow 才会读取最新的 config.yaml。</p>
                    </div>
                  </div>
                  <div class="dpr-workflow-guide-step">
                    <span>2</span>
                    <div>
                      <h3>选择入口</h3>
                      <p>常用抓取走“快速使用”，同步和危险操作保留在对应设置页，避免误触。</p>
                    </div>
                  </div>
                  <div class="dpr-workflow-guide-step">
                    <span>3</span>
                    <div>
                      <h3>查看进度</h3>
                      <p>工作流面板聚合最近运行和执行过程，失败时可直接跳转 GitHub Actions。</p>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section class="dpr-settings-page dpr-settings-page-with-save" data-settings-page-panel="periodic" hidden>
              <div class="dpr-settings-page-head">
                <div>
                  <div class="dpr-settings-page-kicker">General / Periodic Reports</div>
                  <h2>周期报告</h2>
                  <p>周报偏阅读路线，月报偏研究热点趋势；默认复用日报 artifact，避免额外 PDF 精读和大上下文调用。</p>
                </div>
              </div>
              <div class="dpr-periodic-settings-grid">
                <div class="dpr-settings-card dpr-periodic-window-card">
                  <div class="dpr-settings-card-head">
                    <div>
                      <h3>周报配置</h3>
                      <p>控制周报是否启用、输入模式和主题图表密度。</p>
                    </div>
                  </div>
                  <div class="dpr-periodic-radio-group" role="radiogroup" aria-label="周报启用状态">
                    <label><input id="dpr-periodic-weekly-enabled-true" name="dpr-periodic-weekly-enabled" type="radio" value="true" /> 启用周报</label>
                    <label><input id="dpr-periodic-weekly-enabled-false" name="dpr-periodic-weekly-enabled" type="radio" value="false" /> 暂停周报</label>
                  </div>
                  <div class="dpr-settings-form-grid dpr-periodic-form-grid">
                    <label class="chat-quick-run-row" for="dpr-periodic-weekly-mode-select">
                      <span>周报模式</span>
                      <select id="dpr-periodic-weekly-mode-select">
                        <option value="artifacts">artifacts（复用日报，最省 token）</option>
                        <option value="hybrid">hybrid（补候选池后汇总）</option>
                        <option value="recrawl">recrawl（重抓窗口，成本最高）</option>
                      </select>
                    </label>
                    <label class="chat-quick-run-row" for="dpr-periodic-weekly-recrawl-input"><span>周报重抓天数</span><input id="dpr-periodic-weekly-recrawl-input" type="number" min="1" step="1" /></label>
                    <label class="chat-quick-run-row" for="dpr-periodic-weekly-max-candidates-input"><span>最大候选数</span><input id="dpr-periodic-weekly-max-candidates-input" type="number" min="1" step="1" /></label>
                    <label class="chat-quick-run-row" for="dpr-periodic-weekly-representative-input"><span>代表论文数</span><input id="dpr-periodic-weekly-representative-input" type="number" min="1" step="1" /></label>
                    <label class="chat-quick-run-row" for="dpr-periodic-weekly-related-topics-input"><span>相关主题数</span><input id="dpr-periodic-weekly-related-topics-input" type="number" min="1" step="1" /></label>
                    <label class="chat-quick-run-row" for="dpr-periodic-weekly-topic-timeline-input"><span>主题演化数</span><input id="dpr-periodic-weekly-topic-timeline-input" type="number" min="1" step="1" /></label>
                    <label class="chat-quick-run-row" for="dpr-periodic-weekly-cooccurrence-topics-input"><span>共现主题数</span><input id="dpr-periodic-weekly-cooccurrence-topics-input" type="number" min="1" step="1" /></label>
                    <label class="chat-quick-run-row" for="dpr-periodic-weekly-cooccurrence-pairs-input"><span>共现条目数</span><input id="dpr-periodic-weekly-cooccurrence-pairs-input" type="number" min="1" step="1" /></label>
                    <label class="chat-quick-run-row" for="dpr-periodic-word-cloud-topics-input"><span>词频云主题数</span><input id="dpr-periodic-word-cloud-topics-input" type="number" min="1" step="1" /></label>
                  </div>
                </div>
                <div class="dpr-settings-card dpr-periodic-window-card">
                  <div class="dpr-settings-card-head">
                    <div>
                      <h3>月报配置</h3>
                      <p>月报保留 dashboard 视角，适合按月汇总来源、主题和代表论文。</p>
                    </div>
                  </div>
                  <div class="dpr-periodic-radio-group" role="radiogroup" aria-label="月报启用状态">
                    <label><input id="dpr-periodic-monthly-enabled-true" name="dpr-periodic-monthly-enabled" type="radio" value="true" /> 启用月报</label>
                    <label><input id="dpr-periodic-monthly-enabled-false" name="dpr-periodic-monthly-enabled" type="radio" value="false" /> 暂停月报</label>
                  </div>
                  <div class="dpr-settings-form-grid dpr-periodic-form-grid">
                    <label class="chat-quick-run-row" for="dpr-periodic-monthly-mode-select">
                      <span>月报模式</span>
                      <select id="dpr-periodic-monthly-mode-select">
                        <option value="artifacts">artifacts（复用日报，最省 token）</option>
                        <option value="hybrid">hybrid（补候选池后汇总）</option>
                        <option value="recrawl">recrawl（重抓窗口，成本最高）</option>
                      </select>
                    </label>
                    <label class="chat-quick-run-row" for="dpr-periodic-monthly-recrawl-input"><span>月报重抓天数</span><input id="dpr-periodic-monthly-recrawl-input" type="number" min="1" step="1" /></label>
                    <label class="chat-quick-run-row" for="dpr-periodic-monthly-max-candidates-input"><span>最大候选数</span><input id="dpr-periodic-monthly-max-candidates-input" type="number" min="1" step="1" /></label>
                    <label class="chat-quick-run-row" for="dpr-periodic-monthly-representative-input"><span>代表论文数</span><input id="dpr-periodic-monthly-representative-input" type="number" min="1" step="1" /></label>
                    <label class="chat-quick-run-row" for="dpr-periodic-monthly-topics-input"><span>主题 Top 数</span><input id="dpr-periodic-monthly-topics-input" type="number" min="1" step="1" /></label>
                    <label class="chat-quick-run-row" for="dpr-periodic-monthly-related-topics-input"><span>相关主题数</span><input id="dpr-periodic-monthly-related-topics-input" type="number" min="1" step="1" /></label>
                    <label class="chat-quick-run-row" for="dpr-periodic-monthly-topic-timeline-input"><span>主题演化数</span><input id="dpr-periodic-monthly-topic-timeline-input" type="number" min="1" step="1" /></label>
                    <label class="chat-quick-run-row" for="dpr-periodic-monthly-word-cloud-input"><span>词频云词数</span><input id="dpr-periodic-monthly-word-cloud-input" type="number" min="1" step="1" /></label>
                    <label class="chat-quick-run-row" for="dpr-periodic-monthly-cooccurrence-topics-input"><span>共现主题数</span><input id="dpr-periodic-monthly-cooccurrence-topics-input" type="number" min="1" step="1" /></label>
                    <label class="chat-quick-run-row" for="dpr-periodic-monthly-cooccurrence-pairs-input"><span>共现条目数</span><input id="dpr-periodic-monthly-cooccurrence-pairs-input" type="number" min="1" step="1" /></label>
                    <label class="chat-quick-run-row" for="dpr-periodic-monthly-comparison-topics-input"><span>环比主题数</span><input id="dpr-periodic-monthly-comparison-topics-input" type="number" min="1" step="1" /></label>
                  </div>
                </div>
              </div>
              <div class="dpr-settings-save-row">
                <button id="dpr-periodic-save-btn" class="arxiv-tool-btn dpr-settings-save-btn" type="button">保存周期报告设置</button>
              </div>
            </section>

            <section class="dpr-settings-page" data-settings-page-panel="sources" hidden>
              <div class="dpr-settings-page-head">
                <div>
                  <div class="dpr-settings-page-kicker">General / Sources</div>
                  <h2>文献源</h2>
                  <p id="dpr-settings-sources-summary">加载配置后显示当前可用文献源。</p>
                </div>
              </div>
              <div id="dpr-settings-sources-list" class="dpr-source-card-grid">
                <div class="dpr-settings-empty">正在读取文献源配置...</div>
              </div>
            </section>

            <section class="dpr-settings-page" data-settings-page-panel="secrets" hidden>
              <div class="dpr-settings-page-head">
                <div>
                  <div class="dpr-settings-page-kicker">Privacy / Secrets</div>
                  <h2>密钥配置</h2>
                  <p>密钥只通过加密向导和 GitHub Secrets 管理，此处不会展示明文。</p>
                </div>
              </div>
              <div class="dpr-secret-settings-grid">
                <div class="dpr-settings-card dpr-secret-card dpr-secret-card--hero">
                  <div class="dpr-secret-status-orb">🔐</div>
                  <div class="dpr-secret-hero-copy">
                    <h3>访问模式：<span id="dpr-settings-access-mode">未初始化</span></h3>
                    <p>完整权限可读写 config.yaml、触发 workflow，并启用大模型对话；游客模式仅支持阅读。</p>
                  </div>
                  <button id="arxiv-open-secret-setup-btn" class="arxiv-tool-btn dpr-settings-primary-btn" type="button">打开密钥配置</button>
                </div>
                <div class="dpr-settings-card dpr-secret-info-card">
                  <span>GitHub Token</span>
                  <strong>保存配置与触发 workflow</strong>
                </div>
                <div class="dpr-settings-card dpr-secret-info-card">
                  <span>工作流大模型</span>
                  <strong>改写、筛选、速览与总结</strong>
                </div>
                <div class="dpr-settings-card dpr-secret-info-card">
                  <span>聊天模型</span>
                  <strong>可复用工作流 API 或单独配置</strong>
                </div>
                <div class="dpr-settings-card dpr-secret-card dpr-advanced-config-entry-card">
                  <div class="dpr-secret-status-orb dpr-advanced-config-orb">🚀</div>
                  <div class="dpr-secret-hero-copy">
                    <h3>高级配置</h3>
                    <p>可选配置自建 Embedding 与 Reranker 服务；Endpoint/模型写入 GitHub Variables，密钥只写入 GitHub Secrets。</p>
                  </div>
                  <button id="dpr-open-advanced-config-btn" class="arxiv-tool-btn dpr-settings-primary-btn" type="button">打开高级配置</button>
                </div>
                <div class="dpr-advanced-config-info-grid">
                  <div class="dpr-settings-card dpr-secret-info-card dpr-advanced-config-info-card">
                    <span>Embedding 服务</span>
                    <strong>将论文与检索意图转成语义向量，是召回质量的基础</strong>
                  </div>
                  <div class="dpr-settings-card dpr-secret-info-card dpr-advanced-config-info-card">
                    <span>Reranker 服务</span>
                    <strong>对候选论文二次精排，提升最终推荐的相关性</strong>
                  </div>
                </div>
              </div>
              <div id="dpr-advanced-config-overlay" class="dpr-advanced-config-overlay secret-gate-hidden" role="dialog" aria-modal="true" aria-labelledby="dpr-advanced-config-title" aria-hidden="true">
                <div class="dpr-advanced-config-modal">
                  <div class="dpr-advanced-config-modal-top">
                    <div class="dpr-advanced-config-title-card">
                      <div class="dpr-advanced-config-title-icon">🚀</div>
                      <div>
                        <h3 id="dpr-advanced-config-title">高级配置（可选）</h3>
                        <p>按需接入自定义 Embedding / Reranker 服务；运行时敏感值只保存到 GitHub Secrets。</p>
                      </div>
                    </div>
                    <button class="dpr-advanced-config-close" type="button" data-dpr-advanced-config-close aria-label="关闭高级配置">×</button>
                  </div>
                  <div class="dpr-advanced-config-service-stack">
                    <div class="dpr-settings-card dpr-secret-card dpr-embedding-settings-card">
                      <div class="dpr-settings-card-head dpr-settings-card-head-compact">
                        <div>
                          <h3>Embedding 服务</h3>
                          <p>选择向量编码方式。自定义 embedding 的 endpoint/模型写入 Variables，API Key 写入 Secrets。</p>
                        </div>
                        <span id="dpr-embedding-current-status" class="dpr-embedding-status-pill">默认 embedding</span>
                      </div>
                      <div class="dpr-embedding-profile-group" role="radiogroup" aria-label="Embedding 服务模式">
                        <label class="dpr-embedding-profile-option">
                          <input id="dpr-embedding-profile-local" name="dpr-embedding-profile" type="radio" value="local" />
                          <span><strong>本地 embedding</strong>（SentenceTransformers 本地加载 BAAI/bge-small-en-v1.5，CPU 执行，首次运行需下载模型）</span>
                        </label>
                        <label class="dpr-embedding-profile-option">
                          <input id="dpr-embedding-profile-default" name="dpr-embedding-profile" type="radio" value="default_remote" checked />
                          <span><strong>默认 embedding</strong>（BAAI/bge-small-en-v1.5，项目预置服务）</span>
                        </label>
                        <label class="dpr-embedding-profile-option">
                          <input id="dpr-embedding-profile-custom" name="dpr-embedding-profile" type="radio" value="custom" />
                          <span><strong>自定义 embedding</strong>（OpenAI-compatible embeddings 或 legacy /embed 服务）</span>
                        </label>
                      </div>
                      <div id="dpr-embedding-custom-panel" class="dpr-embedding-custom-panel" hidden>
                        <p class="dpr-embedding-safe-note">自定义 endpoint、模型名写入 GitHub Variables；API Key 只会加密写入 GitHub Secrets，不会写入仓库文件、config.yaml 或 docs/config.yaml。</p>
                        <div class="dpr-settings-form-grid">
                          <label class="chat-quick-run-row" for="dpr-embedding-provider-select"><span>接口协议</span><select id="dpr-embedding-provider-select" disabled><option value="openai" selected>OpenAI-compatible /v1/embeddings</option><option value="legacy">Legacy /embed</option></select></label>
                          <label class="chat-quick-run-row" for="dpr-embedding-endpoint-input"><span>Endpoint</span><input id="dpr-embedding-endpoint-input" type="text" autocomplete="off" disabled placeholder="http://127.0.0.1:8010/v1/embeddings" /></label>
                          <label class="chat-quick-run-row" for="dpr-embedding-model-input"><span>模型名称</span><input id="dpr-embedding-model-input" type="text" autocomplete="off" disabled placeholder="BAAI/bge-small-en-v1.5" /></label>
                          <label class="chat-quick-run-row" for="dpr-embedding-api-key-input"><span>API Key</span><input id="dpr-embedding-api-key-input" type="password" autocomplete="off" disabled placeholder="只写入 GitHub Secrets，不回显" /></label>
                        </div>
                      </div>
                      <div class="dpr-embedding-save-row">
                        <button id="dpr-embedding-save-btn" class="arxiv-tool-btn dpr-settings-primary-btn" type="button">保存 embedding 设置</button>
                      </div>
                      <div id="dpr-embedding-settings-msg" class="dpr-settings-message dpr-embedding-settings-msg">Endpoint/模型保存到 Variables；API Key 保存到 Secrets，保存后不会回显密钥明文。</div>
                    </div>
                    <div class="dpr-settings-card dpr-secret-card dpr-reranker-settings-card">
                      <div class="dpr-settings-card-head dpr-settings-card-head-compact">
                        <div>
                          <h3>Reranker 服务</h3>
                          <p>可启用自定义的 OpenAI-compatible rerank 接口；关闭时继续使用 RRF fallback。</p>
                        </div>
                        <span id="dpr-reranker-current-status" class="dpr-embedding-status-pill dpr-reranker-status-pill">RRF fallback</span>
                      </div>
                      <div class="dpr-embedding-profile-group" role="radiogroup" aria-label="Reranker 服务模式">
                        <label class="dpr-embedding-profile-option">
                          <input id="dpr-reranker-mode-disabled" name="dpr-reranker-mode" type="radio" value="disabled" checked />
                          <span><strong>关闭 reranker</strong>（默认跳过 Step 3 /rerank，使用 BM25 + embedding + RRF）</span>
                        </label>
                        <label class="dpr-embedding-profile-option">
                          <input id="dpr-reranker-mode-enabled" name="dpr-reranker-mode" type="radio" value="enabled" />
                          <span><strong>启用自定义 reranker</strong>（OpenAI/vLLM-compatible /v1/rerank）</span>
                        </label>
                      </div>
                      <div id="dpr-reranker-custom-panel" class="dpr-embedding-custom-panel dpr-reranker-custom-panel" hidden>
                        <p class="dpr-embedding-safe-note">Reranker endpoint、模型名写入 GitHub Variables；API Key 只会加密写入 GitHub Secrets，保存后旧密钥不会回显。</p>
                        <div class="dpr-settings-form-grid">
                          <label class="chat-quick-run-row" for="dpr-reranker-endpoint-input"><span>Endpoint</span><input id="dpr-reranker-endpoint-input" type="text" autocomplete="off" disabled placeholder="http://127.0.0.1:8011/v1/rerank" /></label>
                          <label class="chat-quick-run-row" for="dpr-reranker-model-input"><span>模型名称</span><input id="dpr-reranker-model-input" type="text" autocomplete="off" disabled placeholder="Qwen/Qwen3-Reranker-0.6B" /></label>
                          <label class="chat-quick-run-row" for="dpr-reranker-api-key-input"><span>API Key</span><input id="dpr-reranker-api-key-input" type="password" autocomplete="off" disabled placeholder="只写入 GitHub Secrets，不回显" /></label>
                        </div>
                      </div>
                      <div class="dpr-embedding-save-row">
                        <button id="dpr-reranker-save-btn" class="arxiv-tool-btn dpr-settings-primary-btn" type="button">保存 reranker 设置</button>
                      </div>
                      <div id="dpr-reranker-settings-msg" class="dpr-settings-message dpr-embedding-settings-msg">关闭时会写入 Variables：DPR_SKIP_RERANK=true；启用时 endpoint/模型写入 Variables，API Key 写入 Secrets。</div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section class="dpr-settings-page dpr-settings-page-with-save" data-settings-page-panel="research" hidden>
              <div class="dpr-settings-page-head">
                <div>
                  <div class="dpr-settings-page-kicker">Privacy / Research Profile</div>
                  <h2>研究方向</h2>
                  <p>配置最多 ${MAX_RESEARCH_DIRECTIONS} 个个人研究方向关键词，AI 精读会据此分析论文对你的启发和意义。</p>
                </div>
                <span id="dpr-research-direction-count" class="dpr-research-count-pill">0/${MAX_RESEARCH_DIRECTIONS}</span>
              </div>
              <div class="dpr-settings-card dpr-research-card">
                <div class="dpr-settings-card-head">
                  <div>
                    <h3>批量新增关键词</h3>
                    <p>一次新增多条时，请用“、”“，”“,”“；”“;”或换行显式区分不同关键词。</p>
                  </div>
                </div>
                <div class="dpr-research-add-row">
                  <textarea
                    id="dpr-research-bulk-input"
                    rows="3"
                    placeholder="例如：symbolic regression、equation discovery；interpretable machine learning"
                  ></textarea>
                  <button id="dpr-research-add-btn" class="arxiv-tool-btn dpr-settings-primary-btn" type="button">新增关键词</button>
                </div>
                <div id="dpr-research-direction-fallback" class="dpr-research-fallback-note"></div>
              </div>
              <div class="dpr-settings-card dpr-research-card">
                <div class="dpr-settings-card-head">
                  <div>
                    <h3>已配置研究方向</h3>
                    <p>每个关键词单独成框，可勾选后批量删除；编辑完成后点击右下角保存。</p>
                  </div>
                  <button id="dpr-research-delete-selected-btn" class="arxiv-tool-btn dpr-research-delete-btn" type="button">删除选中</button>
                </div>
                <div id="dpr-research-direction-list" class="dpr-research-direction-list"></div>
              </div>
              <div id="dpr-research-settings-msg" class="dpr-settings-message">
                提示：研究方向会写入 config.yaml；如果为空，报告会回退使用检索配置中的关键词。
              </div>
              <div class="dpr-settings-save-row">
                <button id="dpr-research-save-btn" class="arxiv-tool-btn dpr-settings-save-btn" type="button">保存研究方向</button>
              </div>
            </section>

            <section class="dpr-settings-page" data-settings-page-panel="email" hidden>
              <div class="dpr-settings-page-head">
                <div>
                  <div class="dpr-settings-page-kicker">Privacy / Email</div>
                  <h2>邮件推送</h2>
                  <p>通过 GitHub Secrets 保存邮箱与 SMTP 凭证，GitHub Actions 按每日定时发送最新日报正文。</p>
                </div>
              </div>
              <div class="dpr-settings-card">
                <div class="dpr-settings-card-head">
                  <div>
                    <h3>每日简报邮件</h3>
                    <p>邮件正文直接转换最新日报 Markdown，不重新调用 LLM；保存时会同步更新邮件工作流定时。</p>
                  </div>
                </div>
                <div class="dpr-settings-form-grid dpr-email-settings-grid">
                  <label class="chat-quick-run-row" for="dpr-email-enabled-select">
                    <span>启用状态</span>
                    <select id="dpr-email-enabled-select">
                      <option value="true">启用邮件推送</option>
                      <option value="false">暂停邮件推送</option>
                    </select>
                  </label>
                  <label class="chat-quick-run-row" for="dpr-email-to-input">
                    <span>收件邮箱</span>
                    <input id="dpr-email-to-input" type="email" autocomplete="email" placeholder="you@example.com" />
                  </label>
                  <label class="chat-quick-run-row" for="dpr-email-from-input">
                    <span>发件邮箱</span>
                    <input id="dpr-email-from-input" type="email" autocomplete="email" placeholder="bot@example.com" />
                  </label>
                  <label class="chat-quick-run-row" for="dpr-email-time-input">
                    <span>每日推送时间</span>
                    <input id="dpr-email-time-input" type="time" value="${DEFAULT_EMAIL_PUSH_TIME}" />
                  </label>
                  <label class="chat-quick-run-row" for="dpr-email-timezone-select">
                    <span>时区</span>
                    <select id="dpr-email-timezone-select">
                      <option value="Asia/Shanghai">Asia/Shanghai</option>
                      <option value="UTC">UTC</option>
                    </select>
                  </label>
                  <label class="chat-quick-run-row" for="dpr-email-site-url-input">
                    <span>详情链接基础地址（可选）</span>
                    <input id="dpr-email-site-url-input" type="url" placeholder="https://user.github.io/AI_Daily_Paper_Reader" />
                  </label>
                  <label class="chat-quick-run-row" for="dpr-email-smtp-host-input">
                    <span>SMTP Host</span>
                    <input id="dpr-email-smtp-host-input" type="text" autocomplete="off" placeholder="smtp.example.com" />
                  </label>
                  <label class="chat-quick-run-row" for="dpr-email-smtp-port-input">
                    <span>SMTP Port</span>
                    <input id="dpr-email-smtp-port-input" type="number" min="1" max="65535" step="1" value="587" />
                  </label>
                  <label class="chat-quick-run-row" for="dpr-email-smtp-user-input">
                    <span>SMTP 用户名</span>
                    <input id="dpr-email-smtp-user-input" type="text" autocomplete="username" placeholder="通常为发件邮箱或服务用户名" />
                  </label>
                  <label class="chat-quick-run-row" for="dpr-email-smtp-password-input">
                    <span>SMTP 密码 / 应用专用密码</span>
                    <input id="dpr-email-smtp-password-input" type="password" autocomplete="new-password" placeholder="保存后不会明文回显" />
                  </label>
                </div>
                <div class="dpr-settings-message" id="dpr-email-settings-msg">
                  邮箱、SMTP 用户名与密码只写入 GitHub Secrets；不会写入 config.yaml 或 docs/config.yaml。
                </div>
                <div class="dpr-settings-save-row dpr-email-actions-row">
                  <button id="dpr-email-save-btn" class="arxiv-tool-btn dpr-settings-save-btn" type="button">保存邮件推送</button>
                  <button id="dpr-email-test-btn" class="arxiv-tool-btn dpr-email-test-btn" type="button">发送测试邮件</button>
                </div>
              </div>
            </section>

            <section class="dpr-settings-page" data-settings-page-panel="storage" hidden>
              <div class="dpr-settings-page-head">
                <div>
                  <div class="dpr-settings-page-kicker">Danger / Storage</div>
                  <h2>存储</h2>
                  <p>查看运行态路径，按单篇、单日/批次或完整集合移入回收站，并可按原路径恢复。</p>
                </div>
                <button id="dpr-storage-open-trash-page" class="arxiv-tool-btn dpr-storage-danger-btn" type="button">回收站</button>
              </div>
              <div id="dpr-storage-manager-root">
                <div class="dpr-settings-empty">正在初始化存储管理器...</div>
              </div>
            </section>

            <section class="dpr-settings-page" data-settings-page-panel="reset" hidden>
              <div class="dpr-settings-page-head">
                <div>
                  <div class="dpr-settings-page-kicker">Danger / Reset</div>
                  <h2>重置</h2>
                  <p>这些操作会影响已生成内容，请确认你理解后果再继续。</p>
                </div>
              </div>
              <div class="dpr-settings-card dpr-danger-card">
                <div class="dpr-danger-icon">🧨</div>
                <div class="dpr-danger-content">
                  <h3>删除并重置 content</h3>
                  <p>该操作会通过工作流将 docs 备份为 docs_backup_xxx 后恢复为 docs_init，并清空 archive。需要输入 RESET_ALL 二次确认。</p>
                  <button
                    id="arxiv-admin-reset-content-btn"
                    class="chat-quick-run-run-btn dpr-danger-run-btn"
                    type="button"
                  >
                    删除所有并重置
                  </button>
                  <div id="arxiv-admin-reset-content-msg" class="chat-quick-run-msg"></div>
                </div>
              </div>
            </section>
          </main>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    panel = document.getElementById('arxiv-search-panel');

    saveBtn = document.getElementById('arxiv-config-save-btn');
    researchSaveBtn = document.getElementById('dpr-research-save-btn');
    researchMsgEl = document.getElementById('dpr-research-settings-msg');
    closeBtn = document.getElementById('arxiv-search-close-btn');
    msgEl = document.getElementById('dpr-smart-msg');
    settingsDirtyBadge = document.getElementById('dpr-settings-unsaved-badge');
    dailyAutoToggleBtn = document.getElementById('dpr-daily-auto-toggle-btn');
    dailyAutoCardEl = document.getElementById('dpr-daily-auto-card');
    dailyAutoStatusEl = document.getElementById('dpr-daily-auto-status');
    dailyAutoSummaryEl = document.getElementById('dpr-daily-auto-summary');
    dailyAutoMsgEl = document.getElementById('dpr-daily-auto-msg');
    if (window.DPRStorageManager) {
      window.DPRStorageManager.mount(document.getElementById('dpr-storage-manager-root'));
    }
    activateSettingsPage(activeSettingsPage);
    updateSettingsChrome();
    renderSettingsSnapshot();

    const reloadAll = () => {
      renderFromDraft();
    };

    if (window.SubscriptionsSmartQuery) {
      window.SubscriptionsSmartQuery.attach({
        displayListEl: document.getElementById('dpr-sq-display'),
        openChatBtn: document.getElementById('dpr-sq-open-chat-btn'),
        msgEl,
        reloadAll,
      });
    }

    bindBaseEvents();
  };

  const renderFromDraft = () => {
    const cfg = draftConfig || {};
    const subs = (cfg && cfg.subscriptions) || {};
    const profiles = Array.isArray(subs.intent_profiles) ? subs.intent_profiles : [];
    if (window.SubscriptionsSmartQuery && window.SubscriptionsSmartQuery.render) {
      window.SubscriptionsSmartQuery.render(profiles);
    }
    if (window.SubscriptionsSmartQuery && window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds) {
      window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds();
    }
    renderSettingsSnapshot();
  };

  const loadSubscriptions = async () => {
    try {
      if (!window.SubscriptionsGithubToken || !window.SubscriptionsGithubToken.loadConfig) {
        throw new Error('SubscriptionsGithubToken.loadConfig 不可用');
      }
      const loaded = await window.SubscriptionsGithubToken.loadConfig();
      const { config } = loaded || {};
      lastConfigSource = normalizeText(
        (loaded && loaded.source) || (loaded && loaded.sha ? 'GitHub config.yaml' : 'config.yaml'),
      );
      draftConfig = normalizeSubscriptions(config || {});
      hasUnsavedChanges = false;
      refreshQuickRunButtons();
      if (window.SubscriptionsSmartQuery && window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds) {
        window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds();
      }
      renderFromDraft();
      setMessage('已加载配置，可开始编辑。', '#666');
      renderSettingsSnapshot();
    } catch (e) {
      console.error(e);
      setMessage('加载配置失败，请确认 GitHub Token 可用。', '#c00');
    }
  };

  const saveDraftConfig = async (options = {}) => {
    const notify = typeof options.messageSetter === 'function' ? options.messageSetter : setMessage;
    if (isSavingDraftConfig) {
      notify('正在保存中，请稍后...', '#666');
      return false;
    }
    if (!window.SubscriptionsGithubToken || !window.SubscriptionsGithubToken.saveConfig) {
      notify('当前无法保存配置，请先完成 GitHub 登录。', '#c00');
      return false;
    }
    if (!draftConfig) {
      notify('配置尚未加载完成，请先等待配置读取完成后再试。', '#c00');
      return false;
    }
    try {
      isSavingDraftConfig = true;
      if (saveBtn) {
        saveBtn.disabled = true;
      }
      const toSave = normalizeSubscriptions(draftConfig || {});
      const validationError = validateIntentProfiles(toSave);
      if (validationError) {
        notify(validationError, '#c00');
        return false;
      }
      notify('正在保存配置...', '#666');
      await window.SubscriptionsGithubToken.saveConfig(
        toSave,
        options.commitMessage || 'chore: save smart query config from dashboard',
      );
      draftConfig = toSave;
      hasUnsavedChanges = false;
      refreshQuickRunButtons();
      if (window.SubscriptionsSmartQuery && window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds) {
        window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds();
      }
      notify(options.successMessage || '配置已保存。', '#080');
      renderSettingsSnapshot();
      return true;
    } catch (e) {
      console.error(e);
      const msg = e && e.message ? e.message : '未知错误';
      notify(`保存配置失败：${msg}`.slice(0, 180), '#c00');
      return false;
    } finally {
      isSavingDraftConfig = false;
      if (saveBtn) {
        saveBtn.disabled = false;
      }
      syncDailyReportFields();
    }
  };

  const reallyCloseOverlay = () => {
    if (!overlay) return;
    overlay.classList.remove('show');
    setTimeout(() => {
      overlay.style.display = 'none';
    }, 300);
  };

  const closeOverlay = () => {
    if (hasUnsavedChanges) {
      const ok = window.confirm('检测到未保存修改，确认直接关闭并丢弃本地草稿吗？');
      if (!ok) return;
      if (window.SubscriptionsSmartQuery && window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds) {
        window.SubscriptionsSmartQuery.clearPendingDeletedProfileIds();
      }
      draftConfig = null;
      hasUnsavedChanges = false;
      refreshQuickRunButtons();
    }
    reallyCloseOverlay();
  };

  const openOverlay = () => {
    ensureOverlay();
    if (!overlay) return;
    overlay.style.display = 'flex';
    activateSettingsPage(activeSettingsPage);
    updateSettingsChrome();
    renderSettingsSnapshot();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        overlay.classList.add('show');
      });
    });

    if (draftConfig) {
      renderFromDraft();
    } else {
      loadSubscriptions();
    }
  };

  const updatePaperWindowSetting = (field, rawValue) => {
    if (!draftConfig) return;
    const fallback = field === 'carryover_days'
      ? DEFAULT_CARRYOVER_WINDOW_DAYS
      : DEFAULT_DAILY_RECALL_WINDOW_DAYS;
    const value = normalizeWindowDays(rawValue, fallback);
    const next = cloneDeep(draftConfig || {});
    const setting = isPlainObject(next.arxiv_paper_setting) ? next.arxiv_paper_setting : {};
    setting[field] = value;
    next.arxiv_paper_setting = setting;
    draftConfig = normalizeSubscriptions(next);
    hasUnsavedChanges = true;
    refreshQuickRunButtons();
  };

  const toggleDailyAutoReport = async () => {
    if (!draftConfig) {
      setDailyAutoMessage('配置尚未加载完成，请先等待配置读取完成后再试。', '#c00');
      return;
    }
    if (hasUnsavedChanges) {
      setDailyAutoMessage(DAILY_AUTO_DIRTY_MESSAGE, '#c00');
      return;
    }
    const current = resolveDailyReports(draftConfig || {});
    const nextEnabled = current.enabled === false;
    const previousDraft = cloneDeep(draftConfig || {});
    const next = cloneDeep(draftConfig || {});
    next.daily_reports = normalizeDailyReports({
      ...current,
      enabled: nextEnabled,
    });
    draftConfig = normalizeSubscriptions(next);
    hasUnsavedChanges = true;
    syncDailyReportFields();
    setDailyAutoMessage('正在保存自动日报状态...', '#666');
    const ok = await saveDraftConfig({
      commitMessage: nextEnabled
        ? 'chore: resume scheduled daily reports'
        : 'chore: pause scheduled daily reports',
      successMessage: nextEnabled
        ? `自动日报已恢复；${DAILY_AUTO_SCHEDULE_LABEL} 将继续运行。`
        : '自动日报已暂停；定时运行会跳过，手动快速抓取仍可使用。',
      messageSetter: setDailyAutoMessage,
    });
    if (!ok) {
      draftConfig = previousDraft;
      hasUnsavedChanges = false;
      refreshQuickRunButtons();
    }
  };

  const bindWindowInput = (inputId, field) => {
    const inputEl = document.getElementById(inputId);
    if (!inputEl || inputEl._dprWindowBound) return;
    inputEl._dprWindowBound = true;
    inputEl.addEventListener('input', () => {
      updatePaperWindowSetting(field, inputEl.value);
    });
    inputEl.addEventListener('blur', () => {
      renderSettingsSnapshot();
    });
  };

  const updatePeriodicReportSetting = (updater, options = {}) => {
    if (!draftConfig) return;
    const next = cloneDeep(draftConfig || {});
    const current = normalizePeriodicReports(next.periodic_reports);
    const updated = typeof updater === 'function'
      ? updater(cloneDeep(current)) || current
      : current;
    next.periodic_reports = normalizePeriodicReports(updated);
    draftConfig = normalizeSubscriptions(next);
    hasUnsavedChanges = true;
    if (options.message) {
      setPeriodicReportMessage(options.message, options.color || '#080');
    }
    refreshQuickRunButtons({ renderSnapshot: options.renderSnapshot !== false });
  };

  const parsePeriodicAliases = (value) => {
    const text = normalizeText(value || '');
    if (!text) return {};
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      throw new Error('主题别名必须是 JSON 对象。');
    }
    return parsed;
  };

  const bindPeriodicInput = (inputId, updater, eventName = 'input') => {
    const inputEl = document.getElementById(inputId);
    if (!inputEl || inputEl._dprPeriodicBound) return;
    inputEl._dprPeriodicBound = true;
    inputEl.addEventListener(eventName, () => {
      updatePeriodicReportSetting((settings) => updater(settings, inputEl));
    });
    inputEl.addEventListener('blur', () => {
      renderSettingsSnapshot();
    });
  };

  const bindPeriodicReportInputs = () => {
    const bindEnabledRadio = (inputId, period, enabled) => {
      bindPeriodicInput(inputId, (settings, el) => {
        if (!el.checked) return settings;
        settings[period].enabled = enabled;
        settings.enabled = !!(settings.weekly.enabled || settings.monthly.enabled);
        return settings;
      }, 'change');
    };
    bindEnabledRadio('dpr-periodic-weekly-enabled-true', 'weekly', true);
    bindEnabledRadio('dpr-periodic-weekly-enabled-false', 'weekly', false);
    bindPeriodicInput('dpr-periodic-weekly-mode-select', (settings, el) => {
      settings.weekly.input_mode = normalizePeriodicInputMode(el.value, settings.default_input_mode);
      return settings;
    }, 'change');
    bindPeriodicInput('dpr-periodic-weekly-recrawl-input', (settings, el) => {
      settings.weekly.recrawl_days = normalizePositiveInt(
        el.value,
        DEFAULT_PERIODIC_REPORTS.weekly.recrawl_days,
      );
      return settings;
    });
    bindPeriodicInput('dpr-periodic-weekly-max-candidates-input', (settings, el) => {
      settings.weekly.max_candidates = normalizePositiveInt(
        el.value,
        DEFAULT_PERIODIC_REPORTS.weekly.max_candidates,
      );
      return settings;
    });
    bindPeriodicInput('dpr-periodic-weekly-representative-input', (settings, el) => {
      settings.weekly.representative_papers = normalizePositiveInt(
        el.value,
        DEFAULT_PERIODIC_REPORTS.weekly.representative_papers,
      );
      return settings;
    });
    bindPeriodicInput('dpr-periodic-weekly-related-topics-input', (settings, el) => {
      settings.weekly.topic_limits.related_topics = normalizePositiveInt(
        el.value,
        DEFAULT_PERIODIC_REPORTS.weekly.topic_limits.related_topics,
      );
      return settings;
    });
    bindPeriodicInput('dpr-periodic-weekly-topic-timeline-input', (settings, el) => {
      settings.weekly.topic_limits.topic_timeline = normalizePositiveInt(
        el.value,
        DEFAULT_PERIODIC_REPORTS.weekly.topic_limits.topic_timeline,
      );
      return settings;
    });
    bindPeriodicInput('dpr-periodic-weekly-cooccurrence-topics-input', (settings, el) => {
      settings.weekly.topic_limits.cooccurrence_topics = normalizePositiveInt(
        el.value,
        DEFAULT_PERIODIC_REPORTS.weekly.topic_limits.cooccurrence_topics,
      );
      return settings;
    });
    bindPeriodicInput('dpr-periodic-weekly-cooccurrence-pairs-input', (settings, el) => {
      settings.weekly.topic_limits.cooccurrence_pairs = normalizePositiveInt(
        el.value,
        DEFAULT_PERIODIC_REPORTS.weekly.topic_limits.cooccurrence_pairs,
      );
      return settings;
    });
    bindPeriodicInput('dpr-periodic-word-cloud-topics-input', (settings, el) => {
      settings.max_topics = normalizePositiveInt(el.value, DEFAULT_PERIODIC_REPORTS.max_topics);
      return settings;
    });
    bindEnabledRadio('dpr-periodic-monthly-enabled-true', 'monthly', true);
    bindEnabledRadio('dpr-periodic-monthly-enabled-false', 'monthly', false);
    bindPeriodicInput('dpr-periodic-monthly-mode-select', (settings, el) => {
      settings.monthly.input_mode = normalizePeriodicInputMode(el.value, settings.default_input_mode);
      return settings;
    }, 'change');
    bindPeriodicInput('dpr-periodic-monthly-recrawl-input', (settings, el) => {
      settings.monthly.recrawl_days = normalizePositiveInt(
        el.value,
        DEFAULT_PERIODIC_REPORTS.monthly.recrawl_days,
      );
      return settings;
    });
    bindPeriodicInput('dpr-periodic-monthly-max-candidates-input', (settings, el) => {
      settings.monthly.max_candidates = normalizePositiveInt(
        el.value,
        DEFAULT_PERIODIC_REPORTS.monthly.max_candidates,
      );
      return settings;
    });
    bindPeriodicInput('dpr-periodic-monthly-representative-input', (settings, el) => {
      settings.monthly.representative_papers = normalizePositiveInt(
        el.value,
        DEFAULT_PERIODIC_REPORTS.monthly.representative_papers,
      );
      return settings;
    });
    bindPeriodicInput('dpr-periodic-monthly-topics-input', (settings, el) => {
      settings.monthly.topic_limits.topics = normalizePositiveInt(
        el.value,
        DEFAULT_PERIODIC_REPORTS.monthly.topic_limits.topics,
      );
      return settings;
    });
    bindPeriodicInput('dpr-periodic-monthly-related-topics-input', (settings, el) => {
      settings.monthly.topic_limits.related_topics = normalizePositiveInt(
        el.value,
        DEFAULT_PERIODIC_REPORTS.monthly.topic_limits.related_topics,
      );
      return settings;
    });
    bindPeriodicInput('dpr-periodic-monthly-topic-timeline-input', (settings, el) => {
      settings.monthly.topic_limits.topic_timeline = normalizePositiveInt(
        el.value,
        DEFAULT_PERIODIC_REPORTS.monthly.topic_limits.topic_timeline,
      );
      return settings;
    });
    bindPeriodicInput('dpr-periodic-monthly-word-cloud-input', (settings, el) => {
      settings.monthly.topic_limits.word_cloud_terms = normalizePositiveInt(
        el.value,
        DEFAULT_PERIODIC_REPORTS.monthly.topic_limits.word_cloud_terms,
      );
      return settings;
    });
    bindPeriodicInput('dpr-periodic-monthly-cooccurrence-topics-input', (settings, el) => {
      settings.monthly.topic_limits.cooccurrence_topics = normalizePositiveInt(
        el.value,
        DEFAULT_PERIODIC_REPORTS.monthly.topic_limits.cooccurrence_topics,
      );
      return settings;
    });
    bindPeriodicInput('dpr-periodic-monthly-cooccurrence-pairs-input', (settings, el) => {
      settings.monthly.topic_limits.cooccurrence_pairs = normalizePositiveInt(
        el.value,
        DEFAULT_PERIODIC_REPORTS.monthly.topic_limits.cooccurrence_pairs,
      );
      return settings;
    });
    bindPeriodicInput('dpr-periodic-monthly-comparison-topics-input', (settings, el) => {
      settings.monthly.topic_limits.comparison_topics = normalizePositiveInt(
        el.value,
        DEFAULT_PERIODIC_REPORTS.monthly.topic_limits.comparison_topics,
      );
      return settings;
    });
  };

  const bindBaseEvents = () => {
    if (closeBtn && !closeBtn._bound) {
      closeBtn._bound = true;
      closeBtn.addEventListener('click', closeOverlay);
    }

    if (overlay && !overlay._boundClick) {
      overlay._boundClick = true;
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) closeOverlay();
      });
    }

    if (saveBtn && !saveBtn._bound) {
      saveBtn._bound = true;
      saveBtn.addEventListener('click', saveDraftConfig);
    }

    researchSaveBtn = document.getElementById('dpr-research-save-btn');
    researchMsgEl = document.getElementById('dpr-research-settings-msg');
    if (researchSaveBtn && !researchSaveBtn._bound) {
      researchSaveBtn._bound = true;
      researchSaveBtn.addEventListener('click', saveDraftConfig);
    }

    const researchAddBtn = document.getElementById('dpr-research-add-btn');
    if (researchAddBtn && !researchAddBtn._bound) {
      researchAddBtn._bound = true;
      researchAddBtn.addEventListener('click', addResearchDirectionsFromInput);
    }

    const researchDeleteBtn = document.getElementById('dpr-research-delete-selected-btn');
    if (researchDeleteBtn && !researchDeleteBtn._bound) {
      researchDeleteBtn._bound = true;
      researchDeleteBtn.addEventListener('click', deleteSelectedResearchDirections);
    }

    const researchList = document.getElementById('dpr-research-direction-list');
    if (researchList && !researchList._bound) {
      researchList._bound = true;
      researchList.addEventListener('input', (e) => {
        const input = e.target && e.target.closest
          ? e.target.closest('.dpr-research-direction-input')
          : null;
        if (!input) return;
        const index = parseInt(input.getAttribute('data-research-direction-index') || '-1', 10);
        updateResearchDirectionAt(index, input.value, { normalize: false, renderSnapshot: false });
      });
      researchList.addEventListener('blur', (e) => {
        const input = e.target && e.target.closest
          ? e.target.closest('.dpr-research-direction-input')
          : null;
        if (!input) return;
        const index = parseInt(input.getAttribute('data-research-direction-index') || '-1', 10);
        updateResearchDirectionAt(index, input.value, { normalize: true, renderSnapshot: true });
        setResearchMessage('研究方向已更新，记得点击右下角保存。', '#080');
      }, true);
    }

    if (panel && !panel._settingsNavBound) {
      panel._settingsNavBound = true;
      panel.querySelectorAll('[data-settings-page]').forEach((btn) => {
        btn.addEventListener('click', () => {
          activateSettingsPage(btn.getAttribute('data-settings-page'));
        });
      });
    }

    bindWindowInput('dpr-settings-days-window-input', 'days_window');
    bindWindowInput('dpr-settings-carryover-window-input', 'carryover_days');
    bindPeriodicReportInputs();
    bindEmbeddingSettingsInputs();
    bindRerankerSettingsInputs();
    bindAdvancedConfigDialog();

    const reloadConfigBtn = document.getElementById('dpr-settings-reload-config-btn');
    if (reloadConfigBtn && !reloadConfigBtn._bound) {
      reloadConfigBtn._bound = true;
      reloadConfigBtn.addEventListener('click', () => {
        loadSubscriptions();
      });
    }

    const secretBtn = document.getElementById('arxiv-open-secret-setup-btn');
    if (secretBtn && !secretBtn._bound) {
      secretBtn._bound = true;
      secretBtn.addEventListener('click', () => {
        try {
          if (window.DPRSecretSetup && window.DPRSecretSetup.openStep2) {
            window.DPRSecretSetup.openStep2();
          } else {
            alert('当前页面尚未加载密钥配置向导脚本，请刷新后重试。');
          }
        } catch (e) {
          console.error(e);
        }
      });
    }

    quickRunTodayBtn = document.getElementById('arxiv-admin-quick-run-today-btn');
    quickRun10dBtn = document.getElementById('arxiv-admin-quick-run-10d-btn');
    quickRun30dBtn = document.getElementById('arxiv-admin-quick-run-30d-btn');
    quickRun30dStandardBtn = document.getElementById('arxiv-admin-quick-run-30d-standard-btn');
    quickRunWeeklyReportBtn = document.getElementById('arxiv-admin-weekly-report-btn');
    quickRunMonthlyReportBtn = document.getElementById('arxiv-admin-monthly-report-btn');
    quickRunWeeklyRecrawlBtn = document.getElementById('arxiv-admin-weekly-recrawl-report-btn');
    quickRunMonthlyRecrawlBtn = document.getElementById('arxiv-admin-monthly-recrawl-report-btn');
    periodicReportMsgEl = document.getElementById('dpr-periodic-report-msg');
    quickRunOpenWorkflowPanelBtn = document.getElementById('arxiv-admin-open-workflow-panel-btn');
    quickRunMsgEl = document.getElementById('arxiv-admin-quick-run-msg');
    resetContentBtn = document.getElementById('arxiv-admin-reset-content-btn');
    resetContentMsgEl = document.getElementById('arxiv-admin-reset-content-msg');
    emailSaveBtn = document.getElementById('dpr-email-save-btn');
    emailTestBtn = document.getElementById('dpr-email-test-btn');
    emailMsgEl = document.getElementById('dpr-email-settings-msg');
    embeddingSaveBtn = document.getElementById('dpr-embedding-save-btn');
    embeddingMsgEl = document.getElementById('dpr-embedding-settings-msg');
    rerankerSaveBtn = document.getElementById('dpr-reranker-save-btn');
    rerankerMsgEl = document.getElementById('dpr-reranker-settings-msg');
    syncEmailSettingsFields();
    syncEmbeddingSettingsFields();
    syncRerankerSettingsFields();
    [
      quickRunTodayBtn,
      quickRun10dBtn,
      quickRun30dBtn,
      quickRun30dStandardBtn,
      quickRunWeeklyReportBtn,
      quickRunMonthlyReportBtn,
      quickRunWeeklyRecrawlBtn,
      quickRunMonthlyRecrawlBtn,
    ].forEach((btn) => {
      if (!btn) return;
      if (!btn.dataset.defaultTitle) {
        btn.setAttribute('data-default-title', btn.textContent || '');
      }
    });
    refreshQuickRunButtons();

    if (quickRunTodayBtn && !quickRunTodayBtn._bound) {
      quickRunTodayBtn._bound = true;
      quickRunTodayBtn.addEventListener('click', () => {
        const days = resolvePaperWindows(draftConfig || {}).daysWindow;
        runQuickFetch(
          days,
          quickRunMsgEl,
          `已发起默认日报任务（${days} 天标准抓取）。`,
          {
            fetchMode: 'standard',
            dispatchInputs: {
              fetch_mode: 'standard',
            },
          },
        );
      });
    }

    if (quickRun10dBtn && !quickRun10dBtn._bound) {
      quickRun10dBtn._bound = true;
      quickRun10dBtn.addEventListener('click', () => {
        runQuickFetch(10, quickRunMsgEl);
      });
    }

    if (quickRun30dBtn && !quickRun30dBtn._bound) {
      quickRun30dBtn._bound = true;
      quickRun30dBtn.addEventListener('click', () => {
        runQuickFetch(
          30,
          quickRunMsgEl,
          '已发起 30 天全速览抓取任务（skims，成本约 0.76）。',
          { fetchMode: 'skims' },
        );
      });
    }

    if (quickRun30dStandardBtn && !quickRun30dStandardBtn._bound) {
      quickRun30dStandardBtn._bound = true;
      quickRun30dStandardBtn.addEventListener('click', () => {
        runQuickFetch(
          30,
          quickRunMsgEl,
          '已发起 30 天全标准抓取任务（精读，成本约 1.22）。',
          { fetchMode: 'standard' },
        );
      });
    }

    if (quickRunWeeklyReportBtn && !quickRunWeeklyReportBtn._bound) {
      quickRunWeeklyReportBtn._bound = true;
      quickRunWeeklyReportBtn.addEventListener('click', () => {
        runPeriodicReportQuick('weekly', 'artifacts');
      });
    }

    if (quickRunMonthlyReportBtn && !quickRunMonthlyReportBtn._bound) {
      quickRunMonthlyReportBtn._bound = true;
      quickRunMonthlyReportBtn.addEventListener('click', () => {
        runPeriodicReportQuick('monthly', 'artifacts');
      });
    }

    if (quickRunWeeklyRecrawlBtn && !quickRunWeeklyRecrawlBtn._bound) {
      quickRunWeeklyRecrawlBtn._bound = true;
      quickRunWeeklyRecrawlBtn.addEventListener('click', () => {
        runPeriodicReportQuick('weekly', 'hybrid', DEFAULT_PERIODIC_REPORTS.weekly.recrawl_days);
      });
    }

    if (quickRunMonthlyRecrawlBtn && !quickRunMonthlyRecrawlBtn._bound) {
      quickRunMonthlyRecrawlBtn._bound = true;
      quickRunMonthlyRecrawlBtn.addEventListener('click', () => {
        runPeriodicReportQuick('monthly', 'hybrid', DEFAULT_PERIODIC_REPORTS.monthly.recrawl_days);
      });
    }

    if (quickRunOpenWorkflowPanelBtn && !quickRunOpenWorkflowPanelBtn._bound) {
      quickRunOpenWorkflowPanelBtn._bound = true;
      quickRunOpenWorkflowPanelBtn.addEventListener('click', () => {
        try {
          if (window.DPRWorkflowRunner && typeof window.DPRWorkflowRunner.open === 'function') {
            window.DPRWorkflowRunner.open();
            return;
          }
        } catch (e) {
          console.error(e);
        }
        if (quickRunMsgEl) {
          quickRunMsgEl.textContent = '工作流触发面板未加载，请刷新页面后重试。';
          quickRunMsgEl.style.color = '#c00';
        }
      });
    }

    if (dailyAutoToggleBtn && !dailyAutoToggleBtn._bound) {
      dailyAutoToggleBtn._bound = true;
      dailyAutoToggleBtn.addEventListener('click', toggleDailyAutoReport);
    }

    if (resetContentBtn && !resetContentBtn._bound) {
      resetContentBtn._bound = true;
      resetContentBtn.addEventListener('click', () => {
        runResetContent(resetContentMsgEl);
      });
    }

    if (emailSaveBtn && !emailSaveBtn._bound) {
      emailSaveBtn._bound = true;
      emailSaveBtn.addEventListener('click', saveEmailPushSettings);
    }

    if (emailTestBtn && !emailTestBtn._bound) {
      emailTestBtn._bound = true;
      emailTestBtn.addEventListener('click', sendEmailTest);
    }

    const periodicSaveBtn = document.getElementById('dpr-periodic-save-btn');
    if (periodicSaveBtn && !periodicSaveBtn._bound) {
      periodicSaveBtn._bound = true;
      periodicSaveBtn.addEventListener('click', saveDraftConfig);
    }

  };

  const init = () => {
    const run = () => {
      ensureOverlay();
      document.addEventListener('ensure-arxiv-ui', () => {
        ensureOverlay();
      });
      if (!document._arxivLoadSubscriptionsEventBound) {
        document._arxivLoadSubscriptionsEventBound = true;
        document.addEventListener('load-arxiv-subscriptions', () => {
          ensureOverlay();
          loadSubscriptions();
          openOverlay();
        });
      }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run);
    } else {
      run();
    }
  };

  return {
    init,
    openOverlay,
    closeOverlay,
    loadSubscriptions,
    markConfigDirty: () => {
      hasUnsavedChanges = true;
      refreshQuickRunButtons();
    },
    updateDraftConfig: (updater) => {
      const base = draftConfig || {};
      const next = typeof updater === 'function' ? updater(cloneDeep(base)) || base : base;
      draftConfig = normalizeSubscriptions(next);
      hasUnsavedChanges = true;
      refreshQuickRunButtons();
    },
    getDraftConfig: () => cloneDeep(draftConfig || {}),
    validateDraftConfig: () => validateIntentProfiles(draftConfig || {}),
    runProfileQuickFetch: (profileTag, days, runOptions) => runProfileQuickFetch(profileTag, days, runOptions),
    __test: {
      normalizeSubscriptions: (config) => normalizeSubscriptions(config),
      ensureSourceBackendsForProfiles: (config) => ensureSourceBackendsForProfiles(cloneDeep(config || {})),
      buildDefaultSourceBackend: (sourceKey, config) => buildDefaultSourceBackend(sourceKey, cloneDeep(config || {})),
      normalizePaperSources: (values, options) => normalizePaperSources(values, options),
      normalizeWindowDays: (value, fallback) => normalizeWindowDays(value, fallback),
      resolvePaperWindows: (config) => resolvePaperWindows(cloneDeep(config || {})),
      getWindowWarningText: (value) => getWindowWarningText(value),
      normalizeDailyReports: (value) => normalizeDailyReports(cloneDeep(value || {})),
      resolveDailyReports: (config) => resolveDailyReports(cloneDeep(config || {})),
      buildEmailWorkflowCron: (time, timezone) => buildEmailWorkflowCron(time, timezone),
      normalizeEmbeddingProfile: (value) => normalizeEmbeddingProfile(value),
      normalizeEmbeddingProvider: (value) => normalizeEmbeddingProvider(value),
      normalizeEmbeddingFallback: (value) => normalizeEmbeddingFallback(value),
      normalizeEmbeddingTimeout: (value) => normalizeEmbeddingTimeout(value),
      resolveEmbeddingServiceState: (secret) => resolveEmbeddingServiceState(secret),
      buildEmbeddingSecretsPayload: (settings) => buildEmbeddingSecretsPayload(settings),
      buildEmbeddingVariablesPayload: (settings) => buildEmbeddingVariablesPayload(settings),
      normalizeRerankerProvider: (value) => normalizeRerankerProvider(value),
      normalizeRerankerEnabled: (value) => normalizeRerankerEnabled(value),
      resolveRerankerServiceState: (secret) => resolveRerankerServiceState(secret),
      buildRerankerSecretsPayload: (settings) => buildRerankerSecretsPayload(settings),
      buildRerankerVariablesPayload: (settings) => buildRerankerVariablesPayload(settings),
      normalizeResearchDirections: (value) => normalizeResearchDirections(value),
      resolveResearchDirections: (config) => resolveResearchDirections(cloneDeep(config || {})),
      normalizePeriodicReports: (value) => normalizePeriodicReports(cloneDeep(value || {})),
      resolvePeriodicReports: (config) => resolvePeriodicReports(cloneDeep(config || {})),
      clearUnsavedRunMessage: (el) => clearUnsavedRunMessage(el),
    },
  };
})();
