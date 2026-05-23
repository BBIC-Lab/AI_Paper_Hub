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

const hooks = {
  beforeEach(fn) {
    this.beforeEachFn = fn;
  },
  doneEach(fn) {
    this.doneEachFn = fn;
  },
};

window.$docsify.plugins[0](hooks, {
  route: { file: '202605/22/example.md', path: '/202605/22/example' },
});

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

testFullwidthCommaInsideInlineMath();
testNarrativeTextIsMovedOutsideInlineMath();
testDisplayMathAndFollowingInlineMathCanCoexist();
testLatexTextCommandContentStaysInMath();
testDocsifyMathProtectionPreservesSubscriptMath();

console.log('docsify markdown math tests passed');
