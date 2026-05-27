const assert = require('assert');

global.window = {
  $docsify: {
    plugins: [],
  },
};

global.document = {
  getElementById() {
    return null;
  },
  createElement() {
    return {
      setAttribute() {},
      style: {},
      remove() {},
    };
  },
  head: {
    appendChild() {},
  },
  body: {
    appendChild() {},
  },
};

global.btoa = global.btoa || ((value) => Buffer.from(value, 'binary').toString('base64'));

require('../app/local-pdf-reader.js');

const helpers = window.DPRLocalPdfReader.helpers;

assert.strictEqual(typeof window.$docsify.plugins[0], 'function');
assert.strictEqual(helpers.formatBytes(1536), '1.5 KB');
assert.strictEqual(helpers.parsePdfDate('D:20260524091500Z'), '2026-05-24');
assert.strictEqual(
  helpers.sanitizePdfFileName('LightGlue: Local Feature Matching at Light Speed.pdf'),
  'lightglue-local-feature-matching-at-light-speed.pdf',
);
assert.strictEqual(
  helpers.encodeGitHubPath('docs/assets/local_pdfs/uploads/a paper.pdf'),
  'docs/assets/local_pdfs/uploads/a%20paper.pdf',
);
assert.strictEqual(
  helpers.arrayBufferToBase64(new Uint8Array([65, 66, 67]).buffer),
  'QUJD',
);
assert.match(
  helpers.buildUploadPath(
    'LightGlue: Local Feature Matching at Light Speed.pdf',
    new Date(Date.UTC(2026, 4, 25, 10, 11, 12)),
  ),
  /^docs\/assets\/local_pdfs\/uploads\/\d{8}-\d{6}-[a-z0-9]+-lightglue-local-feature-matching-at-light-speed\.pdf$/,
);
assert.deepStrictEqual(
  helpers.normalizePdfFiles([
    { name: 'paper-a.pdf', type: 'application/pdf' },
    { name: 'paper-b.PDF', type: '' },
    { name: 'notes.txt', type: 'text/plain' },
  ]).map((file) => file.name),
  ['paper-a.pdf', 'paper-b.PDF'],
);

const importItem = helpers.buildImportQueueItem(
  { name: 'wrong-title.pdf', type: 'application/pdf', size: 2048 },
  'item-1',
);
assert.strictEqual(importItem.status, 'queued');
assert.strictEqual(importItem.fileSizeText, '2.0 KB');
const appendedQueue = helpers.appendImportQueueItems(
  [importItem],
  [
    { name: 'second.pdf', type: 'application/pdf', size: 1024 },
    { name: 'third.pdf', type: 'application/pdf', size: 1024 },
  ],
);
assert.deepStrictEqual(appendedQueue.map((item) => item.fileName), [
  'wrong-title.pdf',
  'second.pdf',
  'third.pdf',
]);
const renamedQueue = helpers.updateImportQueueItemTitle(
  [{ ...importItem, result: { title: 'Wrong Title', fileName: 'wrong-title.pdf' } }],
  'item-1',
  'Corrected Paper Title',
);
assert.strictEqual(helpers.getImportItemTitle(renamedQueue[0]), 'Corrected Paper Title');
assert.strictEqual(renamedQueue[0].result.title, 'Corrected Paper Title');
assert.deepStrictEqual(helpers.deleteImportQueueItem(renamedQueue, 'item-1'), []);

const sampleText = [
  'Activation Geometry for Neural Models',
  '',
  'Abstract: This paper studies neural sensitivity in visual cortex and artificial systems. It compares local geometry, model responses, and alignment scores across multiple experimental settings. The results show that sensitivity geometry can explain differences that activation matching hides.',
  'Keywords: neural alignment; geometry; fMRI',
  '1 Introduction',
  'The rest of the paper begins here.',
].join('\n');

assert.strictEqual(
  helpers.guessTitle('', sampleText, 'fallback.pdf'),
  'Activation Geometry for Neural Models',
);
assert.match(helpers.extractAbstract(sampleText), /sensitivity geometry can explain/);
assert.strictEqual(helpers.extractKeywords(sampleText), 'neural alignment, geometry, fMRI');

const markdown = helpers.buildMarkdown({
  title: 'Activation Geometry for Neural Models',
  fileName: 'paper.pdf',
  pageCount: 12,
  charCount: 32000,
  wordCount: 5100,
  author: 'Ada Lovelace',
  createdAt: '2026-05-24',
  keywords: 'alignment, geometry',
  abstract: 'A short abstract.',
  deepSummary: '## 核心问题\n\nA deep summary.\n\n（完）',
  text: 'Body text.',
});

assert.match(markdown, /^# Activation Geometry for Neural Models/);
assert.match(markdown, /- 页数：12/);
assert.match(markdown, /## 论文详细总结（自动生成）\n## 核心问题/);
assert.match(markdown, /## 正文摘录\nBody text\./);

const stored = helpers.buildStoredDeepEntry(
  {
    title: 'Activation Geometry for Neural Models',
    fileName: 'paper.pdf',
    pageCount: 12,
    fileSizeText: '1.2 MB',
    tldr: 'A stored TLDR.',
    motivation: 'A stored motivation.',
    method: 'A stored method.',
    result: 'A stored result.',
    conclusion: 'A stored conclusion.',
    figurePreviews: [
      {
        url: 'data:image/jpeg;base64,page1',
        caption: 'Page 1 preview',
        page: 1,
        index: 1,
        width: 320,
        height: 420,
      },
      {
        url: 'data:image/jpeg;base64,page2',
        caption: 'Page 2 preview',
        page: 2,
        index: 2,
        width: 320,
        height: 420,
      },
    ],
    figureDataUrl: 'data:image/jpeg;base64,abc',
    figureWidth: 640,
    figureHeight: 480,
    deepSummary: 'Stored summary.',
    text: 'Full paper text that should not be stored.',
  },
  'entry-1',
  '2026-05-24T09:30:00.000Z',
);

assert.strictEqual(stored.id, 'entry-1');
assert.strictEqual(stored.title, 'Activation Geometry for Neural Models');
assert.strictEqual(stored.deepSummary, 'Stored summary.');
assert.strictEqual(stored.text, undefined);
assert.strictEqual(stored.figurePreviews.length, 2);
assert.strictEqual(stored.figurePreviews[1].page, 2);

const storedMarkdown = helpers.buildMarkdown({
  ...stored,
  text: '',
});
assert.doesNotMatch(storedMarkdown, /正文摘录/);

const routeMarkdown = helpers.buildLocalDeepRouteMarkdown({
  ...stored,
  abstract: 'A stored abstract.',
});
assert.match(routeMarkdown, /^---\ntitle: "Activation Geometry for Neural Models"/);
assert.match(routeMarkdown, /source: local-pdf/);
assert.match(routeMarkdown, /motivation: "A stored motivation\."/);
assert.match(routeMarkdown, /figures_json: "\[/);
assert.match(routeMarkdown, /PDF 第 2 页|page2|Page 2 preview/);
assert.match(routeMarkdown, /## 摘要\n\nA stored abstract\./);
assert.match(routeMarkdown, /## 论文详细总结（自动生成）\n\nStored summary\./);

const glance = helpers.deriveGlanceFields(
  { abstract: 'Abstract sentence.' },
  [
    '## 1. 论文的核心问题与整体含义',
    '- Research motivation sentence.',
    '## 2. 方法论核心',
    '- Method sentence.',
    '## 6. 主要结论与发现',
    '- Result sentence.',
  ].join('\n'),
);
assert.match(glance.motivation, /Research motivation/);
assert.match(glance.method, /Method sentence/);
assert.match(glance.result, /Result sentence/);

const messages = helpers.buildDeepReadMessages({
  title: 'Activation Geometry for Neural Models',
  fileName: 'paper.pdf',
  pageCount: 12,
  abstract: 'A short abstract.',
  text: 'Full paper text.',
});

assert.strictEqual(messages[0].role, 'system');
assert.match(messages[0].content, /资深学术论文分析助手/);
assert.match(messages[1].content, /论文 PDF 提取文本/);
assert.match(messages[2].content, /论文 Markdown 元数据/);
assert.match(messages[3].content, /论文的核心问题与整体含义/);
assert.match(messages[3].content, /（完）/);

const longText = `${'a'.repeat(90000)}${'b'.repeat(90000)}`;
const truncated = helpers.truncateForLLM(longText, 120000);
assert.strictEqual(truncated.truncated, true);
assert.ok(truncated.text.length > 120000);
assert.match(truncated.text, /中间内容/);

assert.strictEqual(
  helpers.extractChatResponseText({
    choices: [
      {
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: 'world' },
          ],
        },
      },
    ],
  }),
  'hello\nworld',
);

console.log('local pdf reader tests passed');
