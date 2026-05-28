const assert = require('node:assert/strict');

function createElementStub(tagName = 'div') {
  return {
    tagName,
    classList: {
      add() {},
      remove() {},
      contains() {
        return false;
      },
    },
    dataset: {},
    style: {},
    appendChild() {},
    addEventListener() {},
    setAttribute() {},
    remove() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

global.window = {
  marked: {
    setOptions() {},
    getDefaults() {
      return {};
    },
  },
  addEventListener() {},
  innerWidth: 1280,
  location: { hash: '' },
  localStorage: {
    getItem() {
      return null;
    },
    setItem() {},
  },
};

global.document = {
  body: Object.assign(createElementStub('body'), {
    classList: {
      add() {},
      remove() {},
      contains() {
        return false;
      },
    },
  }),
  head: createElementStub('head'),
  documentElement: {
    clientWidth: 1280,
    style: {
      setProperty() {},
    },
  },
  readyState: 'complete',
  title: '',
  addEventListener() {},
  dispatchEvent() {},
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
  getElementById() {
    return null;
  },
  createElement: createElementStub,
};

global.Event = function Event() {};
global.requestAnimationFrame = (fn) => fn();

require('../app/docsify-plugin.js');

function buildHooksForRoute(file, path) {
  const hooks = {
    beforeEach(fn) {
      this.beforeEachFn = fn;
    },
    doneEach(fn) {
      this.doneEachFn = fn;
    },
  };

  window.$docsify.plugins[0](hooks, {
    route: { file, path },
  });
  return hooks;
}

const hooks = buildHooksForRoute('202605/22/example.md', '/202605/22/example');

const {
  normalizeMarkdownMathDelimiters,
  protectMarkdownMathForDocsify,
  restoreMarkdownMathPlaceholders,
} = window.DPRMarkdown;

function testFullwidthCommaInsideInlineMath() {
  const input = `$k_{t'} = \\tilde{x}{m,t'}W^K + p(t')\uFF0Cv{t'} = \\tilde{x}_{m,t'}W^V + p(t')$`;
  const expected = `$k_{t'} = \\tilde{x}{m,t'}W^K + p(t'), v{t'} = \\tilde{x}_{m,t'}W^V + p(t')$`;

  assert.equal(normalizeMarkdownMathDelimiters(input), expected);
}

function testNarrativeTextIsMovedOutsideInlineMath() {
  const input = `$R_{i,j} = \\Delta_{i,j} + \\text{softmin}\\gamma(R{i-1, j}, R_{i, j-1}, R_{i-1, j-1})\uFF0C\u6700\u7ec8\u635f\u5931\u4e3aR_{n,m}$`;
  const expected = `$R_{i,j} = \\Delta_{i,j} + \\text{softmin}\\gamma(R{i-1, j}, R_{i, j-1}, R_{i-1, j-1})$\uFF0C\u6700\u7ec8\u635f\u5931\u4e3a$R_{n,m}$`;

  assert.equal(normalizeMarkdownMathDelimiters(input), expected);
}

function testDisplayMathAndFollowingInlineMathCanCoexist() {
  const input =
    `\u516c\u5f0f\u5b9a\u4e49\u5982\u4e0b\uFF1A $$\\text{softmin}\\gamma(z_1, ..., z_k) = -\\gamma \\log \\sum{i=1}^k \\exp\\left(-\\frac{z_i}{\\gamma}\\right)$$ ` +
    `\u7d2f\u79ef\u6210\u672c\u77e9\u9635\u9012\u63a8\u5f0f\u4e3a $R_{i,j} = \\Delta_{i,j}\uFF0C\u6700\u7ec8\u635f\u5931\u4e3aR_{n,m}$`;
  const expected =
    `\u516c\u5f0f\u5b9a\u4e49\u5982\u4e0b\uFF1A $$\\text{softmin}\\gamma(z_1, ..., z_k) = -\\gamma \\log \\sum{i=1}^k \\exp\\left(-\\frac{z_i}{\\gamma}\\right)$$ ` +
    `\u7d2f\u79ef\u6210\u672c\u77e9\u9635\u9012\u63a8\u5f0f\u4e3a $R_{i,j} = \\Delta_{i,j}$\uFF0C\u6700\u7ec8\u635f\u5931\u4e3a$R_{n,m}$`;

  assert.equal(normalizeMarkdownMathDelimiters(input), expected);
}

function testLatexTextCommandContentStaysInMath() {
  const input = `$\\text{\u6700\u7ec8\u635f\u5931} = R_{n,m}$`;

  assert.equal(normalizeMarkdownMathDelimiters(input), input);
}

function testDocsifyMathProtectionPreservesSubscriptMath() {
  const input =
    `\u5bf9 $\\mathbf{Z}_{\\text{non}}$ \u8ba1\u7b97 ` +
    `$\\mathbf{A}_{\\text{non}}=\\text{softmax}(\\mathbf{Z}_{\\text{non}}\\mathbf{Z}_{\\text{non}}^\\top/\\sqrt{d})$` +
    `\uff0c\u4fdd\u7559\u5b9e\u4f8b\u7279\u5b9a\u7684\u7ed3\u6784\u4ea4\u4e92\u3002`;

  const protectedText = protectMarkdownMathForDocsify(input);
  assert.ok(protectedText.includes('@@DPRDOCSIFYMATH'));
  assert.ok(!protectedText.includes('\\mathbf{Z}_{\\text{non}}'));
  assert.ok(!protectedText.includes('\\mathbf{A}_{\\text{non}}'));

  const restored = restoreMarkdownMathPlaceholders(`<p>${protectedText}</p>`);
  assert.ok(restored.includes('$\\mathbf{Z}_{\\text{non}}$'));
  assert.ok(
    restored.includes(
      '$\\mathbf{A}_{\\text{non}}=\\text{softmax}(\\mathbf{Z}_{\\text{non}}\\mathbf{Z}_{\\text{non}}^\\top/\\sqrt{d})$',
    ),
  );
  assert.ok(!restored.includes('\\mathbf{Z}{\\text{non}}'));
}

function testLocalPdfRouteRendersPaperFrontMatter() {
  const localHooks = buildHooksForRoute(
    'local-pdf/20260524/lightglue.md',
    '/local-pdf/20260524/lightglue',
  );
  const input = [
    '---',
    'title: "LightGlue: Local Feature Matching at Light Speed"',
    'title_zh: LightGlue：光速局部特征匹配',
    'authors: Unknown',
    'date: 2026-05-24',
    'tags: ["paper:本地PDF", "query:local-pdf"]',
    'score: local',
    'tldr: 本地 PDF 精读总结。',
    'source: local-pdf',
    '---',
    '',
    '## 摘要',
    'LightGlue 摘要正文。',
  ].join('\n');

  const rendered = localHooks.beforeEachFn(input);
  assert.ok(rendered.includes('paper-title-en'));
  assert.ok(rendered.includes('LightGlue: Local Feature Matching at Light Speed'));
  assert.ok(!rendered.startsWith('---'));
}

function testLocalPdfFiguresJsonKeepsEscapedCaptionQuotes() {
  const localHooks = buildHooksForRoute(
    'local-pdf/20260527/neural-driven-image-editing.md',
    '/local-pdf/20260527/neural-driven-image-editing',
  );
  const figures = JSON.stringify([
    {
      url: 'assets/figures/local-pdf/local-20260527-092525-neural-driven/fig-001.webp',
      caption: 'Failure case: "longlegged space creature".',
      page: 34,
      index: 1,
      width: 826,
      height: 540,
    },
  ]);
  const yamlFigures = figures.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const input = [
    '---',
    'title: Neural-Driven Image Editing',
    'authors: Unknown',
    'date: 2026-05-27',
    'source: local-pdf',
    `figures_json: "${yamlFigures}"`,
    '---',
    '',
    '## Abstract',
    'Demo body.',
  ].join('\n');

  const rendered = localHooks.beforeEachFn(input);
  assert.ok(rendered.includes('paper-figure-section'));
  assert.ok(rendered.includes('fig-001.webp'));
  assert.ok(rendered.includes('&quot;longlegged space creature&quot;'));
}

function testScoreLabelRendersAfterScore() {
  const localHooks = buildHooksForRoute(
    'local-pdf/20260527/scored-paper.md',
    '/local-pdf/20260527/scored-paper',
  );
  const input = [
    '---',
    'title: Scored Local Paper',
    'authors: Unknown',
    'date: 2026-05-27',
    'source: local-pdf',
    'score: 8.5 订阅评分',
    'score_label: 订阅评分',
    '---',
    '',
    '## Abstract',
    'Demo body.',
  ].join('\n');

  const rendered = localHooks.beforeEachFn(input);
  const scoreLabel = input.match(/^score_label: (.+)$/m)[1];
  assert.ok(rendered.includes('class="paper-meta-pill is-score"'));
  assert.ok(rendered.includes(`<strong>Score</strong>8.5 ${scoreLabel}`));
}

function testResearchValueSectionMovesBeforeResearchFlow() {
  const localHooks = buildHooksForRoute(
    'local-pdf/20260528/research-value.md',
    '/local-pdf/20260528/research-value',
  );
  const input = [
    '---',
    'title: Research Value Demo',
    'authors: Unknown',
    'date: 2026-05-28',
    'source: local-pdf',
    'method: Demo method.',
    'result: Demo result.',
    '---',
    '',
    '## 核心问题',
    '正文内容。',
    '',
    '## 9. 对读者研究方向的启发与意义',
    '',
    '- **关联方向：** 脑机接口；神经信号解码。',
    '- **启发与意义：** 可以快速判断是否值得精读。',
    '- **阅读建议：** 先读方法和实验。',
    '',
    '（完）',
  ].join('\n');

  const rendered = localHooks.beforeEachFn(input);
  const cardIndex = rendered.indexOf('## 研究价值与阅读建议');
  const flowIndex = rendered.indexOf('paper-flow-section');
  const bodyIndex = rendered.indexOf('## 核心问题');
  assert.ok(cardIndex > 0);
  assert.ok(flowIndex > 0);
  assert.ok(cardIndex < flowIndex);
  assert.ok(flowIndex < bodyIndex);
  assert.ok(rendered.includes('**关联方向：** 脑机接口；神经信号解码。'));
  assert.ok(!rendered.includes('## 9. 对读者研究方向的启发与意义'));
}

function testResearchValueExtractorKeepsDoneMarkerInBody() {
  const extracted = window.DPRResearchValueCard.extractResearchValueSectionFromMarkdown([
    '## 方法',
    '正文。',
    '',
    '9. 对读者研究方向的启发与意义',
    '关联方向：弱相关。',
    '',
    '（完）',
  ].join('\n'));

  assert.equal(extracted.section, '## 研究价值与阅读建议\n\n关联方向：弱相关。');
  assert.ok(extracted.body.includes('## 方法'));
  assert.ok(extracted.body.includes('（完）'));
  assert.ok(!extracted.body.includes('对读者研究方向的启发与意义'));
}

function testResearchValueBoundaryStopsBeforeGeneratedSections() {
  const isBoundary = window.DPRResearchValueCard.isResearchValueBoundaryNode;
  const figureSection = {
    nodeType: 1,
    tagName: 'section',
    textContent: 'Figure Gallery',
    classList: {
      contains(name) {
        return name === 'paper-figure-section';
      },
    },
  };
  const flowSection = {
    nodeType: 1,
    tagName: 'section',
    textContent: 'Research Flow',
    classList: {
      contains(name) {
        return name === 'paper-flow-section';
      },
    },
  };
  const normalParagraph = {
    nodeType: 1,
    tagName: 'p',
    textContent: '启发与意义：值得跟进。',
  };

  assert.equal(isBoundary(figureSection), true);
  assert.equal(isBoundary(flowSection), true);
  assert.equal(isBoundary(normalParagraph), false);
}

testFullwidthCommaInsideInlineMath();
testNarrativeTextIsMovedOutsideInlineMath();
testDisplayMathAndFollowingInlineMathCanCoexist();
testLatexTextCommandContentStaysInMath();
testDocsifyMathProtectionPreservesSubscriptMath();
testLocalPdfRouteRendersPaperFrontMatter();
testLocalPdfFiguresJsonKeepsEscapedCaptionQuotes();
testScoreLabelRendersAfterScore();
testResearchValueSectionMovesBeforeResearchFlow();
testResearchValueExtractorKeepsDoneMarkerInBody();
testResearchValueBoundaryStopsBeforeGeneratedSections();

console.log('docsify markdown math tests passed');
