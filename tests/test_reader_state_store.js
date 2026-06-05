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

  store.upsertPaperCatalog(
    [
      {
        paperId: '202605/20/catalog-old',
        title: 'Older Catalog Paper',
        date: '2026-05-20',
        tags: [{ kind: 'paper', label: 'library' }],
      },
      {
        paperId: '202606/04/catalog-new',
        title: 'Newer Catalog Paper',
        date: '2026-06-04',
        reader_section: 'deep',
        topic_tags: ['planning', 'memory'],
        tags: [
          { kind: 'paper', label: 'library' },
          { kind: 'query', label: 'retrieval' },
        ],
      },
      {
        paperId: '202606/03/catalog-quick',
        title: 'Quick Catalog Paper',
        date: '2026-06-03',
        reader_section: 'quick',
        tags: [{ kind: 'paper', label: 'library' }],
      },
      {
        paperId: '202606/03/local-source',
        title: 'Local Source Paper',
        date: '2026-06-03',
        source: 'local-pdf',
        reader_section: 'deep',
      },
      {
        paperId: 'local-pdf/20260604/local-route',
        title: 'Local Route Paper',
        date: '2026-06-04',
      },
      {
        paperId: '202606/02/local-tag',
        title: 'Local Tag Paper',
        date: '2026-06-02',
        tags: [{ kind: 'paper', label: '本地PDF' }],
      },
      {
        paperId: '202606/04/not-local',
        title: 'Regular Local Topic Paper',
        date: '2026-06-04',
        tags: [{ kind: 'paper', label: 'local' }],
      },
      {
        paperId: 'tutorial/workflow',
        title: 'Workflow Tutorial',
        tags: [{ kind: 'paper', label: 'library' }],
      },
      {
        paperId: 'AI_Daily_Paper_Reader/README',
        title: 'Project README',
        tags: [{ kind: 'paper', label: 'library' }],
      },
    ],
    { dirty: false },
  );
  const catalogState = store.getState();
  assert.equal(catalogState.dirty, false);
  assert.equal(catalogState.papers['202606/04/catalog-new'].read, false);
  assert.equal(catalogState.papers['202606/04/catalog-new'].reader_section, 'deep');
  assert.deepEqual(
    catalogState.papers['202606/04/catalog-new'].topic_tags.map((tag) => tag.label),
    ['planning', 'memory'],
  );
  assert.equal(catalogState.papers['tutorial/workflow'], undefined);
  assert.equal(catalogState.papers['AI_Daily_Paper_Reader/README'], undefined);
  assert.equal(
    store.listPapers({ filter: 'tag:library', sort: 'date' })[0].paperId,
    '202606/04/catalog-new',
  );
  assert.equal(
    store.listPapers({ filter: 'tag:planning', sort: 'date' })[0].paperId,
    '202606/04/catalog-new',
  );
  assert.equal(
    store.listPapers({ query: '精读' }).some((paper) => paper.paperId === '202606/04/catalog-new'),
    true,
  );
  const localIds = new Set(store.listPapers({ filter: 'source:local-pdf' }).map((paper) => paper.paperId));
  assert.equal(localIds.has('202606/03/local-source'), true);
  assert.equal(localIds.has('local-pdf/20260604/local-route'), true);
  assert.equal(localIds.has('202606/02/local-tag'), true);
  assert.equal(localIds.has('202606/04/not-local'), false);
  const deepIds = new Set(store.listPapers({ filter: 'reader:deep' }).map((paper) => paper.paperId));
  assert.equal(deepIds.has('202606/04/catalog-new'), true);
  assert.equal(deepIds.has('202606/03/local-source'), false);
  const quickIds = new Set(store.listPapers({ filter: 'reader:quick' }).map((paper) => paper.paperId));
  assert.equal(quickIds.has('202606/03/catalog-quick'), true);
  assert.equal(quickIds.has('202606/04/catalog-new'), false);

  store.upsertPaperMeta(
    '202606/04/eva-net',
    {
      title: 'EVA-Net: Subject-Independent EEG Motor Decoding with Video-Derived Motor Priors',
      date: '2026-06-04',
      published: '2026-06-01',
    },
    { dirty: false },
  );
  assert.equal(store.getPaper('202606/04/eva-net').date, '2026-06-01');

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
      '202606/05/paper-p': {
        paperId: '202606/05/paper-p',
        title: 'old',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  });
  const newer = store.normalizeState({
    updatedAt: '2026-01-02T00:00:00.000Z',
    papers: {
      '202606/05/paper-p': {
        paperId: '202606/05/paper-p',
        title: 'new',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    },
  });
  assert.equal(store.mergeStates(older, newer).papers['202606/05/paper-p'].title, 'new');

  const normalized = store.normalizeState({
    papers: {
      '202606/04/README': { paperId: '202606/04/README', title: 'Daily Index' },
      'tutorial/quick-start': { paperId: 'tutorial/quick-start', title: 'Quick Start' },
      'AI_Daily_Paper_Reader_Private/README': {
        paperId: 'AI_Daily_Paper_Reader_Private/README',
        title: 'Private README',
      },
      '202606/04/paper-ok': { paperId: '202606/04/paper-ok', title: 'Paper OK' },
    },
  });
  assert.equal(normalized.papers['202606/04/README'], undefined);
  assert.equal(normalized.papers['tutorial/quick-start'], undefined);
  assert.equal(normalized.papers['AI_Daily_Paper_Reader_Private/README'], undefined);
  assert.equal(normalized.papers['202606/04/paper-ok'].title, 'Paper OK');

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
