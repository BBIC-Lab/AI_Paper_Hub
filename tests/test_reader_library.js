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
assert.equal(library.isExcludedRouteId('202606/04/paper-a'), false);
assert.equal(library.formatScore('8.5 订阅评分'), '8.5/10 订阅评分');

const topics = library.topicTagsForPaper({
  tags: [
    { kind: 'query', label: 'retrieval' },
    { kind: 'search', label: 'agent search' },
    { kind: 'paper', label: 'benchmark' },
    { kind: 'paper', label: 'benchmark' },
    { kind: 'other', label: 'evaluation' },
    { kind: 'paper', label: 'ai4nd:composite' },
  ],
});

assert.deepEqual(
  topics.map((tag) => tag.label),
  ['benchmark', 'evaluation'],
);

const rendered = library.renderPaper({
  paperId: '202606/04/paper-a',
  route: '#/202606/04/paper-a',
  title: 'Library Card Title',
  title_zh: '论文库卡片标题',
  date: '2026-06-04',
  score: '9.0',
  evidence: 'matches the reader profile',
  tags: [
    { kind: 'query', label: 'retrieval' },
    { kind: 'paper', label: 'agents' },
  ],
});

assert.match(rendered, /class="dpr-reader-card-title"/);
assert.match(rendered, /2026-06-04/);
assert.match(rendered, /9\.0\/10/);
assert.match(rendered, /agents/);
assert.doesNotMatch(rendered, />retrieval</);
assert.doesNotMatch(rendered, />打开</);

console.log('reader library tests passed');
