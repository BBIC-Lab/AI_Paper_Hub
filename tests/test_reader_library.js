const assert = require('assert');

global.window = {};
global.document = {
  querySelector() {
    return null;
  },
  getElementById() {
    return null;
  },
};

require('../app/reader-library.js');

const library = window.DPRReaderLibrary.__test;

assert.equal(library.FILTERS.some((item) => item.key === 'read' || item.label === '已读'), false);
assert.equal(library.isExcludedRouteId('tutorial/README'), true);
assert.equal(library.isExcludedRouteId('tutorial/quick-start'), true);
assert.equal(library.isExcludedRouteId('tutorial/workflow'), true);
assert.equal(library.isExcludedRouteId('AI_Daily_Paper_Reader/README'), true);
assert.equal(library.isExcludedRouteId('AI_Daily_Paper_Reader_Private/README'), true);
assert.equal(library.isExcludedRouteId('202606/04/README'), true);
assert.equal(library.isExcludedRouteId('202606/04/paper-a'), false);
assert.equal(library.isExcludedRouteId('local-pdf/20260527/paper-a'), false);
assert.equal(library.formatScore('8.5 订阅评分'), '8.5/10 订阅评分');

const topics = library.topicTagsForPaper({
  tags: [
    { kind: 'query', label: 'retrieval' },
    { kind: 'search', label: 'agent search' },
    { kind: 'paper', label: 'benchmark' },
    { kind: 'paper', label: 'benchmark' },
    { kind: 'keyword', label: 'memory' },
    { kind: 'other', label: 'evaluation' },
    { kind: 'paper', label: 'ai4nd:composite' },
  ],
});

assert.deepEqual(
  topics.map((tag) => tag.label),
  ['benchmark', 'memory', 'evaluation'],
);

const fallbackTopics = library.topicTagsForPaper({
  title: 'EVA-Net: Subject-Independent EEG Motor Decoding with Video-Derived Motor Priors',
  evidence: 'cross-modal alignment, video semantic priors, EEG motor decoding',
  tags: [{ kind: 'query', label: 'ai4nd' }],
});

assert.deepEqual(
  fallbackTopics.map((tag) => tag.label).slice(0, 3),
  ['cross-modal alignment', 'video semantic priors', 'EEG motor decoding'],
);
assert.equal(fallbackTopics.some((tag) => tag.label.toLowerCase() === 'ai4nd'), false);

const rendered = library.renderPaper(
  {
    paperId: '202606/04/paper-a',
    route: '#/202606/04/paper-a',
    title: 'Library Card Title',
    title_zh: '论文库卡片标题',
    date: '2026-06-04',
    score: '9.0',
    evidence: 'matches the reader profile',
    tags: [
      { kind: 'query', label: 'retrieval' },
      { kind: 'keyword', label: 'planning' },
      { kind: 'paper', label: 'agents' },
    ],
  },
  7,
);

assert.match(rendered, /class="dpr-reader-card-title"/);
assert.match(rendered, /class="dpr-reader-card-index">08</);
assert.match(rendered, /2026-06-04/);
assert.match(rendered, /9\.0\/10/);
assert.match(rendered, /planning/);
assert.match(rendered, /agents/);
assert.doesNotMatch(rendered, />retrieval</);
assert.doesNotMatch(rendered, />打开</);

console.log('reader library tests passed');
