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
      toggle() {},
    },
    dataset: {},
    style: {
      setProperty() {},
    },
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
  location: { hash: '', href: 'http://localhost/#/202605/24/paper' },
  localStorage: {
    getItem() {
      return null;
    },
    setItem() {},
  },
};

global.document = {
  body: Object.assign(createElementStub('body'), {
    appendChild() {},
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
  route: { file: '202605/24/example.md', path: '/202605/24/example' },
});

const actions = window.DPRPaperActions;

assert.deepEqual(
  actions.togglePaperReactionState({}, 'paper-1', 'favorite'),
  { 'paper-1': 'favorite' },
);
assert.deepEqual(
  actions.togglePaperReactionState({ 'paper-1': 'favorite' }, 'paper-1', 'dislike'),
  { 'paper-1': 'dislike' },
);
assert.deepEqual(
  actions.togglePaperReactionState({ 'paper-1': 'dislike' }, 'paper-1', 'dislike'),
  {},
);

assert.deepEqual(
  actions.setPaperColorMarkerState({ 'paper-1': 'read' }, 'paper-1', 'good'),
  { 'paper-1': 'good' },
);
assert.deepEqual(
  actions.setPaperColorMarkerState({ 'paper-1': 'good' }, 'paper-1', 'good'),
  { 'paper-1': 'read' },
);

const badges = actions.buildPaperStateBadges(
  'blue',
  'favorite',
  actions.getDefaultMarkerLabels(),
);
assert.deepEqual(
  badges.map((item) => [item.type, item.key, item.title]),
  [
    ['reaction', 'favorite', 'Favorite'],
    ['marker', 'blue', 'Novel'],
  ],
);
assert.deepEqual(actions.buildPaperStateBadges('read', '', {}), []);

console.log('paper action state tests passed');
