const assert = require('assert');
const { webcrypto } = require('crypto');

const storage = new Map();
const localStorage = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null;
  },
  setItem(key, value) {
    storage.set(key, String(value));
  },
  removeItem(key) {
    storage.delete(key);
  },
};

global.atob = (value) => Buffer.from(String(value), 'base64').toString('binary');
global.btoa = (value) => Buffer.from(String(value), 'binary').toString('base64');
global.window = {
  localStorage,
  crypto: webcrypto,
  DPR_ACCESS_MODE: 'locked',
  clearTimeout,
  setTimeout,
};
global.document = {
  addEventListener() {},
  dispatchEvent() {},
};
global.CustomEvent = function CustomEvent(type, init) {
  return { type, detail: init && init.detail };
};

localStorage.setItem(
  'dpr_read_papers_v1',
  JSON.stringify({
    '202605/24/paper-a': 'good',
    '202605/24/paper-b': 'read',
  }),
);
localStorage.setItem(
  'dpr_paper_reactions_v1',
  JSON.stringify({
    '202605/24/paper-a': 'favorite',
  }),
);
localStorage.setItem(
  'dpr_paper_marker_labels_v1',
  JSON.stringify({
    good: 'MustRead',
    blue: 'Novel',
    orange: 'Useful',
    bad: 'Skim',
  }),
);

require('../app/reader-state.store.js');

const store = window.DPRReaderStateStore;

async function run() {
  const migrated = store.getState();
  assert.equal(migrated.papers['202605/24/paper-a'].marker, 'good');
  assert.equal(migrated.papers['202605/24/paper-a'].reaction, 'favorite');
  assert.equal(store.getMarkerLabels().good, 'MustRead');

  store.setMarker(
    '202605/25/paper-c',
    'blue',
    {
      title: 'A New Agent Benchmark',
      date: '2026-05-25',
      tags: [{ kind: 'query', label: 'agents' }],
      score: '8.5',
    },
    { sync: false },
  );
  store.setReaction('202605/25/paper-c', 'favorite', {}, { sync: false });
  assert.equal(store.getReadStateObject()['202605/25/paper-c'], 'blue');
  assert.equal(store.getReactionStateObject()['202605/25/paper-c'], 'favorite');
  assert.equal(store.listByTag('marker:blue').length, 1);
  assert.equal(store.listPapers({ query: 'agent' })[0].paperId, '202605/25/paper-c');

  const older = store.normalizeState({
    updatedAt: '2026-01-01T00:00:00.000Z',
    papers: {
      p: { paperId: 'p', title: 'old', updatedAt: '2026-01-01T00:00:00.000Z' },
    },
  });
  const newer = store.normalizeState({
    updatedAt: '2026-01-02T00:00:00.000Z',
    papers: {
      p: { paperId: 'p', title: 'new', updatedAt: '2026-01-02T00:00:00.000Z' },
    },
  });
  assert.equal(store.mergeStates(older, newer).papers.p.title, 'new');

  const key = Buffer.alloc(32, 7).toString('base64');
  const encrypted = await store.encryptState(store.getState(), key);
  assert.ok(encrypted.ciphertext);
  const decrypted = await store.decryptState(encrypted, key);
  assert.equal(decrypted.papers['202605/25/paper-c'].title, 'A New Agent Benchmark');
  await assert.rejects(
    () => store.decryptState(encrypted, Buffer.alloc(32, 8).toString('base64')),
    /decrypt|operation|data/i,
  );

  let commitPayload = null;
  window.DPR_ACCESS_MODE = 'full';
  window.DPRSecretSession = {
    async ensureReaderDatabaseConfig() {
      return {
        enabled: true,
        path: 'docs/reader-db/state.enc.json',
        key_b64: key,
      };
    },
  };
  window.SubscriptionsGithubToken = {
    async loadRepoTextFile() {
      throw new Error('HTTP 404 missing');
    },
    async commitRepoChanges(changes, message, options) {
      commitPayload = { changes, message, options };
      return { branch: 'main', updated: changes.updates.map((item) => item.path) };
    },
  };
  store.setMarker('202605/26/paper-d', 'bad', { title: 'Skim Later' }, { sync: false });
  await store.syncNow({ force: true });
  assert.equal(commitPayload.message, 'chore: sync reader database');
  assert.equal(commitPayload.options.requireWorkflow, false);
  assert.equal(commitPayload.changes.updates[0].path, 'docs/reader-db/state.enc.json');
  assert.ok(JSON.parse(commitPayload.changes.updates[0].content).ciphertext);

  console.log('reader state store tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
