const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global.window || {};
global.document = global.document || {
  readyState: 'loading',
  addEventListener() {},
};

require('../app/subscriptions.manager.js');

const {
  normalizeSubscriptions,
  resolvePaperWindows,
  getWindowWarningText,
  buildEmailWorkflowCron,
  normalizeResearchDirections,
  resolveResearchDirections,
  normalizePeriodicReports,
  resolvePeriodicReports,
} = global.window.SubscriptionsManager.__test;

function buildBaseConfig() {
  return {
    supabase_shared: {
      kind: 'supabase',
      enabled: true,
      url: 'https://example.supabase.co',
      anon_key: 'sb_publishable_demo',
      schema: 'public',
    },
    source_backends: {
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
    },
    subscriptions: {
      schema_migration: {
        stage: 'A',
        diff_threshold_pct: 15,
      },
      keyword_recall_mode: 'or',
      intent_profiles: [
        {
          tag: 'GENE',
          description: '遗传学',
          enabled: true,
          paper_sources: ['biorxiv'],
          keywords: [
            {
              keyword: 'genetics',
              query: 'fundamental principles and study of genetics',
            },
          ],
          intent_queries: [
            {
              query: 'latest preprints in genetics',
            },
          ],
        },
      ],
    },
  };
}

function testNormalizeSubscriptionsAddsBiorxivBackend() {
  const normalized = normalizeSubscriptions(buildBaseConfig());
  const backend = normalized.source_backends.biorxiv;

  assert.ok(backend, '应自动补齐 biorxiv backend');
  assert.equal(backend.kind, 'supabase');
  assert.equal(backend.enabled, true);
  assert.equal(backend.url, 'https://example.supabase.co');
  assert.equal(backend.anon_key, 'sb_publishable_demo');
  assert.equal(backend.schema, 'public');
  assert.equal(backend.papers_table, 'biorxiv_papers');
  assert.equal(backend.vector_rpc, 'match_biorxiv_papers_exact');
  assert.equal(backend.vector_rpc_exact, 'match_biorxiv_papers_exact');
  assert.equal(backend.bm25_rpc, 'match_biorxiv_papers_bm25');
}

function testNormalizeSubscriptionsPreservesCustomBiorxivBackendFields() {
  const config = buildBaseConfig();
  config.source_backends.biorxiv = {
    enabled: false,
    papers_table: 'custom_biorxiv_papers',
    bm25_rpc: 'custom_match_biorxiv_papers_bm25',
    extra_flag: 'keep-me',
  };

  const normalized = normalizeSubscriptions(config);
  const backend = normalized.source_backends.biorxiv;

  assert.equal(backend.enabled, false);
  assert.equal(backend.papers_table, 'custom_biorxiv_papers');
  assert.equal(backend.bm25_rpc, 'custom_match_biorxiv_papers_bm25');
  assert.equal(backend.extra_flag, 'keep-me');
  assert.equal(backend.url, 'https://example.supabase.co');
  assert.equal(backend.anon_key, 'sb_publishable_demo');
  assert.equal(backend.vector_rpc, 'match_biorxiv_papers_exact');
  assert.equal(backend.vector_rpc_exact, 'match_biorxiv_papers_exact');
}

function testNormalizeSubscriptionsMigratesLegacyDailyPaperLimit() {
  const config = buildBaseConfig();
  config.subscriptions.intent_profiles[0].daily_paper_limit = 6;

  const normalized = normalizeSubscriptions(config);
  const profile = normalized.subscriptions.intent_profiles[0];

  assert.equal(profile.deep_daily_paper_limit, 6);
  assert.equal(profile.quick_daily_paper_limit, 6);
  assert.equal(Object.prototype.hasOwnProperty.call(profile, 'daily_paper_limit'), false);
}

function testNormalizeSubscriptionsKeepsSectionDailyPaperLimits() {
  const config = buildBaseConfig();
  config.subscriptions.intent_profiles[0].deep_daily_paper_limit = 6;
  config.subscriptions.intent_profiles[0].quick_daily_paper_limit = 4;

  const normalized = normalizeSubscriptions(config);
  const profile = normalized.subscriptions.intent_profiles[0];

  assert.equal(profile.deep_daily_paper_limit, 6);
  assert.equal(profile.quick_daily_paper_limit, 4);
}

function testNormalizeSubscriptionsDefaultsDailyPaperLimits() {
  const normalized = normalizeSubscriptions(buildBaseConfig());
  const profile = normalized.subscriptions.intent_profiles[0];

  assert.equal(profile.deep_daily_paper_limit, 10);
  assert.equal(profile.quick_daily_paper_limit, 10);
}

function testNormalizeSubscriptionsDefaultsPaperWindows() {
  const normalized = normalizeSubscriptions(buildBaseConfig());

  assert.equal(normalized.arxiv_paper_setting.days_window, 5);
  assert.equal(normalized.arxiv_paper_setting.carryover_days, 7);
}

function testResolvePaperWindowsKeepsSeparateCarryoverWindow() {
  const windows = resolvePaperWindows({
    arxiv_paper_setting: {
      days_window: 5,
      carryover_days: 2,
    },
  });

  assert.deepEqual(windows, { daysWindow: 5, carryoverDays: 2 });
}

function testResolvePaperWindowsFallsBackCarryoverToLegacyDaysWindow() {
  const windows = resolvePaperWindows({
    arxiv_paper_setting: {
      days_window: 8,
    },
  });

  assert.deepEqual(windows, { daysWindow: 8, carryoverDays: 8 });
}

function testWindowWarningOnlyAppearsForLongWindow() {
  assert.equal(getWindowWarningText(7), '');
  assert.equal(
    getWindowWarningText(8),
    '窗口较长，可能增加旧论文反复进入候选池的概率，提高token消耗。',
  );
}

function testRunProfileQuickFetchPassesProfileTagToWorkflow() {
  const calls = [];
  global.window.DPRWorkflowRunner = {
    runQuickFetchByDays(days, options) {
      calls.push({ days, options });
    },
  };

  const ok = global.window.SubscriptionsManager.runProfileQuickFetch('GENE', 30, {
    fetchMode: 'skims',
  });

  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].days, 30);
  assert.equal(calls[0].options.fetchMode, 'skims');
  assert.equal(calls[0].options.dispatchInputs.profile_tag, 'GENE');
}

function testEmailWorkflowCronConvertsShanghaiTimeToUtc() {
  const schedule = buildEmailWorkflowCron('08:30', 'Asia/Shanghai');

  assert.equal(schedule.cron, '30 0 * * *');
  assert.equal(schedule.time, '08:30');
  assert.equal(schedule.timezone, 'Asia/Shanghai');
}

function testEmailWorkflowCronKeepsUtcTime() {
  const schedule = buildEmailWorkflowCron('08:30', 'UTC');

  assert.equal(schedule.cron, '30 8 * * *');
  assert.equal(schedule.timezone, 'UTC');
}

function testNormalizeResearchDirectionsSplitsAndCaps() {
  const directions = normalizeResearchDirections(
    'symbolic regression、equation discovery，PySR;interpretable ML\nphysics-informed regression',
  );

  assert.deepEqual(directions, [
    'symbolic regression',
    'equation discovery',
    'PySR',
    'interpretable ML',
    'physics-informed regression',
  ]);
  assert.equal(normalizeResearchDirections(Array(10).fill(0).map((_, i) => `kw-${i}`)).length, 8);
}

function testResolveResearchDirectionsFallsBackToKeywords() {
  const config = buildBaseConfig();
  config.subscriptions.intent_profiles[0].keywords.push({
    keyword: 'equation discovery',
    query: 'scientific equation discovery',
  });
  const context = resolveResearchDirections(config);

  assert.equal(context.source, 'fallback');
  assert.deepEqual(context.directions, ['genetics', 'equation discovery']);
}

function testResolveResearchDirectionsPrefersConfiguredValues() {
  const config = buildBaseConfig();
  config.reader_profile = {
    research_directions: ['causal discovery', 'symbolic regression'],
  };
  const context = resolveResearchDirections(config);

  assert.equal(context.source, 'configured');
  assert.deepEqual(context.directions, ['causal discovery', 'symbolic regression']);
}

function testNormalizeSubscriptionsAddsPeriodicReportDefaults() {
  const normalized = normalizeSubscriptions(buildBaseConfig());
  const reports = normalized.periodic_reports;

  assert.equal(reports.enabled, true);
  assert.equal(reports.default_input_mode, 'artifacts');
  assert.equal(reports.weekly.input_mode, 'artifacts');
  assert.equal(reports.weekly.recrawl_days, 10);
  assert.equal(reports.weekly.max_candidates, 240);
  assert.equal(reports.weekly.representative_papers, 12);
  assert.equal(reports.weekly.topic_limits.related_topics, 10);
  assert.equal(reports.weekly.topic_limits.topic_timeline, 10);
  assert.equal(reports.weekly.topic_limits.cooccurrence_topics, 10);
  assert.equal(reports.weekly.topic_limits.cooccurrence_pairs, 12);
  assert.equal(reports.monthly.recrawl_days, 30);
  assert.equal(reports.monthly.max_candidates, 240);
  assert.equal(reports.monthly.representative_papers, 12);
  assert.equal(reports.monthly.topic_limits.topics, 10);
  assert.equal(reports.monthly.topic_limits.topic_timeline, 10);
  assert.equal(reports.charts.topic_timeline, true);
  assert.deepEqual(reports.topic_aliases, {});
}

function testNormalizePeriodicReportsPreservesUserEdits() {
  const reports = normalizePeriodicReports({
    enabled: false,
    default_input_mode: 'hybrid',
    language: 'en-US',
    max_candidates: '120',
    max_topics: '7',
    representative_papers: '5',
    weekly: {
      input_mode: 'recrawl',
      recrawl_days: '9',
      max_candidates: '90',
      representative_papers: '6',
      topic_limits: {
        related_topics: '8',
        topic_timeline: '4',
        cooccurrence_topics: '6',
        cooccurrence_pairs: '11',
      },
    },
    monthly: {
      enabled: false,
      input_mode: 'hybrid',
      recrawl_days: '45',
      max_candidates: '180',
      representative_papers: '9',
      topic_limits: {
        topics: '12',
        topic_timeline: '5',
      },
    },
    charts: {
      topics: false,
      sources: true,
      score_distribution: false,
      timeline: true,
      topic_timeline: false,
    },
    topic_aliases: {
      Agents: ['agentic systems'],
    },
  });

  assert.equal(reports.enabled, false);
  assert.equal(reports.default_input_mode, 'hybrid');
  assert.equal(reports.language, 'en-US');
  assert.equal(reports.max_candidates, 120);
  assert.equal(reports.max_topics, 7);
  assert.equal(reports.representative_papers, 5);
  assert.equal(reports.weekly.enabled, true);
  assert.equal(reports.weekly.input_mode, 'recrawl');
  assert.equal(reports.weekly.recrawl_days, 9);
  assert.equal(reports.weekly.max_candidates, 90);
  assert.equal(reports.weekly.representative_papers, 6);
  assert.equal(reports.weekly.topic_limits.related_topics, 8);
  assert.equal(reports.weekly.topic_limits.topic_timeline, 4);
  assert.equal(reports.weekly.topic_limits.cooccurrence_topics, 6);
  assert.equal(reports.weekly.topic_limits.cooccurrence_pairs, 11);
  assert.equal(reports.monthly.enabled, false);
  assert.equal(reports.monthly.input_mode, 'hybrid');
  assert.equal(reports.monthly.recrawl_days, 45);
  assert.equal(reports.monthly.max_candidates, 180);
  assert.equal(reports.monthly.representative_papers, 9);
  assert.equal(reports.monthly.topic_limits.topics, 12);
  assert.equal(reports.monthly.topic_limits.topic_timeline, 5);
  assert.equal(reports.charts.topics, false);
  assert.equal(reports.charts.score_distribution, false);
  assert.equal(reports.charts.topic_timeline, false);
  assert.deepEqual(reports.topic_aliases, { Agents: ['agentic systems'] });
}

function testResolvePeriodicReportsFallsBackFromConfig() {
  const reports = resolvePeriodicReports({
    periodic_reports: {
      default_input_mode: 'invalid',
      weekly: {
        input_mode: 'hybrid',
      },
    },
  });

  assert.equal(reports.default_input_mode, 'artifacts');
  assert.equal(reports.weekly.input_mode, 'hybrid');
  assert.equal(reports.monthly.input_mode, 'artifacts');
}

function testPeriodicSettingsUiRemovesDeprecatedControls() {
  const source = fs.readFileSync(path.join(__dirname, '../app/subscriptions.manager.js'), 'utf8');

  assert.ok(source.includes('周报配置'));
  assert.ok(source.includes('月报配置'));
  assert.ok(source.includes('dpr-periodic-weekly-enabled-true'));
  assert.ok(source.includes('artifacts（复用日报，最省 token）'));
  assert.ok(!source.includes('输出语言'));
  assert.ok(!source.includes('图表与主题合并'));
  assert.ok(!source.includes('会议论文'));
}

function testQuickRunCssKeepsButtonsAligned() {
  const css = fs.readFileSync(path.join(__dirname, '../app/app.css'), 'utf8');

  assert.ok(css.includes('--dpr-quick-run-button-height: 86px;'));
  assert.ok(css.includes('--dpr-quick-run-grid-height: 380px;'));
  assert.ok(css.includes('.dpr-quick-run-layout #arxiv-search-quick-run-side'));
  assert.ok(css.includes('.dpr-quick-run-layout .dpr-periodic-quick-card'));
  assert.ok(css.includes('grid-template-rows: repeat(4, var(--dpr-quick-run-button-height));'));
  assert.ok(css.includes('margin: 0;'));
}

testNormalizeSubscriptionsAddsBiorxivBackend();
testNormalizeSubscriptionsPreservesCustomBiorxivBackendFields();
testNormalizeSubscriptionsMigratesLegacyDailyPaperLimit();
testNormalizeSubscriptionsKeepsSectionDailyPaperLimits();
testNormalizeSubscriptionsDefaultsDailyPaperLimits();
testNormalizeSubscriptionsDefaultsPaperWindows();
testResolvePaperWindowsKeepsSeparateCarryoverWindow();
testResolvePaperWindowsFallsBackCarryoverToLegacyDaysWindow();
testWindowWarningOnlyAppearsForLongWindow();
testRunProfileQuickFetchPassesProfileTagToWorkflow();
testEmailWorkflowCronConvertsShanghaiTimeToUtc();
testEmailWorkflowCronKeepsUtcTime();
testNormalizeResearchDirectionsSplitsAndCaps();
testResolveResearchDirectionsFallsBackToKeywords();
testResolveResearchDirectionsPrefersConfiguredValues();
testNormalizeSubscriptionsAddsPeriodicReportDefaults();
testNormalizePeriodicReportsPreservesUserEdits();
testResolvePeriodicReportsFallsBackFromConfig();
testPeriodicSettingsUiRemovesDeprecatedControls();
testQuickRunCssKeepsButtonsAligned();

console.log('subscriptions manager tests passed');
