const assert = require('node:assert/strict');

global.window = global.window || {
  location: { href: 'https://example.github.io/AI_Daily_Paper_Reader/' },
  setTimeout: (fn) => setTimeout(fn, 0),
};

require('../app/storage.manager.js');

const {
  normalizeHref,
  DELETE_CONFIRM_PHRASE,
  RESTORE_CONFIRM_PHRASE,
  EMPTY_TRASH_CONFIRM_PHRASE,
  routeFromRepoPath,
  parseFrontMatter,
  parseFiguresMeta,
  createInventory,
  createTrashInventory,
  buildDeletePlan,
  enrichDeletePlan,
  appendPlanToTrashManifest,
  buildTrashActionPlan,
  removeTrashPlanFromManifest,
  mergeSidebarContextLines,
  summarizePlan,
  removeSidebarLines,
  pathMatchesRuntime,
} = global.window.DPRStorageManager.__test;

function buildInventory() {
  const sidebar = [
    '* Daily Papers',
    '  * 2026-05-28',
    '    * <a class="dpr-sidebar-brief-link" href="#/202605/28/README">日报</a>',
    '    * 精读区',
    '      * <a class="dpr-sidebar-item-link" href="#/202605/28/daily-paper" data-sidebar-item="{&quot;title&quot;:&quot;Daily Paper&quot;}">Daily Paper</a>',
    '* 本地 PDF 解析',
    '  * <a class="dpr-sidebar-brief-link" href="#/local-pdf">上传解析</a>',
    '  * 2026-05-29',
    '    * <a class="dpr-sidebar-item-link" href="#/local-pdf/20260529/local-demo" data-sidebar-item="{&quot;title&quot;:&quot;Local Demo&quot;}">Local Demo</a>',
  ].join('\n');
  const tree = [
    { path: 'docs/_sidebar.md', type: 'blob', size: 100 },
    { path: 'docs/202605/28/README.md', type: 'blob', size: 200 },
    { path: 'docs/202605/28/daily-paper.md', type: 'blob', size: 300 },
    { path: 'docs/202605/28/daily-paper.txt', type: 'blob', size: 400 },
    { path: 'docs/local-pdf/20260529/local-demo.md', type: 'blob', size: 500 },
    { path: 'docs/local-pdf/20260529/local-demo.txt', type: 'blob', size: 600 },
    { path: 'docs/assets/local_pdfs/local-demo.pdf', type: 'blob', size: 700 },
    { path: 'docs/assets/figures/local-pdf/local-demo/fig-001.webp', type: 'blob', size: 800 },
  ];
  return createInventory({ tree, sidebar });
}

function testRouteRecognition() {
  assert.deepEqual(routeFromRepoPath('docs/202605/28/demo.md'), {
    routeId: '202605/28/demo',
    type: 'daily',
    groupKey: 'daily:202605/28',
  });
  assert.deepEqual(routeFromRepoPath('docs/local-pdf/20260529/demo.md'), {
    routeId: 'local-pdf/20260529/demo',
    type: 'local-pdf',
    groupKey: 'local:20260529',
  });
  assert.equal(routeFromRepoPath('docs/202605/28/README.md'), null);
}

function testInventoryAndSelectionPlan() {
  const inventory = buildInventory();
  assert.equal(inventory.leaves.length, 2);
  assert.equal(inventory.leaves[0].label, 'Local Demo');
  assert.equal(inventory.leaves[1].label, 'Daily Paper');
  assert.equal(inventory.roots[0].children[0].label, '2026-05-28');
  assert.equal(inventory.roots[1].children[0].label, '2026-05-29');

  const selected = new Set(['paper:local-pdf/20260529/local-demo']);
  const plan = buildDeletePlan(inventory, selected);
  assert.equal(plan.leaves.length, 1);
  assert.ok(plan.paths.includes('docs/local-pdf/20260529/local-demo.md'));
  assert.ok(plan.paths.includes('docs/local-pdf/20260529/local-demo.txt'));
  assert.ok(plan.sidebarChanged);
  assert.ok(!plan.nextSidebar.includes('#/local-pdf/20260529/local-demo'));
  assert.ok(plan.nextSidebar.includes('#/local-pdf">上传解析</a>'));
}

async function testEnrichedPlanIncludesPdfAndFigures() {
  const inventory = buildInventory();
  const selected = new Set(['paper:local-pdf/20260529/local-demo']);
  const basePlan = buildDeletePlan(inventory, selected);
  const api = {
    async loadRepoTextFile(path) {
      assert.equal(path, 'docs/local-pdf/20260529/local-demo.md');
      return {
        content: [
          '---',
          'title: Local Demo',
          'pdf: assets/local_pdfs/local-demo.pdf',
          'figures_json: "[{\\"url\\":\\"assets/figures/local-pdf/local-demo/fig-001.webp\\"}]"',
          '---',
          '',
        ].join('\n'),
      };
    },
  };
  const plan = await enrichDeletePlan(basePlan, api, inventory);
  assert.ok(plan.paths.includes('docs/assets/local_pdfs/local-demo.pdf'));
  assert.ok(plan.paths.includes('docs/assets/figures/local-pdf/local-demo/'));
  const summary = summarizePlan(plan, inventory);
  assert.equal(summary.paperCount, 1);
  assert.ok(summary.fileCount >= 4);
}

function testTrashManifestAndRestorePlan() {
  const inventory = buildInventory();
  const selected = new Set(['paper:local-pdf/20260529/local-demo']);
  const basePlan = buildDeletePlan(inventory, selected);
  const plan = {
    ...basePlan,
    metadataLoaded: true,
    paths: [
      ...basePlan.paths,
      'docs/assets/local_pdfs/local-demo.pdf',
      'docs/assets/figures/local-pdf/local-demo/',
    ],
  };
  const manifest = appendPlanToTrashManifest({ items: [] }, plan, 'settings');
  assert.equal(manifest.items.length, 1);
  assert.equal(manifest.items[0].groupKey, 'local:20260529');
  assert.ok(manifest.items[0].paths.includes('docs/local-pdf/20260529/local-demo.md'));
  assert.ok(manifest.items[0].sidebarContextLines.some((line) => line.includes('#/local-pdf/20260529/local-demo')));

  const tree = [
    { path: 'trash/docs/local-pdf/20260529/local-demo.md', type: 'blob', size: 500 },
    { path: 'trash/docs/local-pdf/20260529/local-demo.txt', type: 'blob', size: 600 },
    { path: 'trash/docs/assets/local_pdfs/local-demo.pdf', type: 'blob', size: 700 },
    { path: 'trash/docs/assets/figures/local-pdf/local-demo/fig-001.webp', type: 'blob', size: 800 },
    { path: 'trash/manifest.json', type: 'blob', size: 300 },
  ];
  const trash = createTrashInventory({ tree, manifest });
  assert.equal(trash.leaves.length, 1);
  assert.equal(trash.roots[1].children[0].label, '2026-05-29');
  const restorePlan = buildTrashActionPlan(trash, new Set([trash.leaves[0].id]));
  assert.equal(restorePlan.leaves.length, 1);
  assert.ok(restorePlan.paths.includes('docs/local-pdf/20260529/local-demo.md'));
  const cleaned = removeTrashPlanFromManifest(manifest, restorePlan);
  assert.equal(cleaned.items.length, 0);
}

function testMergeSidebarContextLines() {
  const current = [
    '* Daily Papers',
    '* 本地 PDF 解析',
    '  * <a class="dpr-sidebar-brief-link" href="#/local-pdf">上传解析</a>',
  ].join('\n');
  const restored = mergeSidebarContextLines(current, [[
    '* 本地 PDF 解析',
    '  * 2026-05-29',
    '    * <a class="dpr-sidebar-item-link" href="#/local-pdf/20260529/local-demo">Local Demo</a>',
  ]]);
  assert.ok(restored.includes('  * 2026-05-29'));
  assert.ok(restored.includes('#/local-pdf/20260529/local-demo'));
  assert.equal((restored.match(/本地 PDF 解析/g) || []).length, 1);
}

function testHelpers() {
  assert.equal(DELETE_CONFIRM_PHRASE, '删除运行态');
  assert.equal(RESTORE_CONFIRM_PHRASE, '恢复运行态');
  assert.equal(EMPTY_TRASH_CONFIRM_PHRASE, '清空回收站');
  assert.equal(normalizeHref('/202605/28/demo.md?x=1'), '#/202605/28/demo');
  const meta = parseFrontMatter([
    '---',
    'pdf: "assets/local_pdfs/demo.pdf"',
    'figures_json: "[{\\"url\\":\\"assets/figures/demo/fig.webp\\"}]"',
    '---',
  ].join('\n'));
  assert.equal(meta.pdf, 'assets/local_pdfs/demo.pdf');
  assert.equal(parseFiguresMeta(meta)[0].url, 'assets/figures/demo/fig.webp');
  assert.ok(pathMatchesRuntime('docs/assets/local_pdfs/demo.pdf'));
  assert.ok(pathMatchesRuntime('docs/202605/28/demo.md'));
  assert.ok(!pathMatchesRuntime('app/storage.manager.js'));
}

function testRemoveSidebarLines() {
  const next = removeSidebarLines(
    [
      '* Daily Papers',
      '  * 2026-05-28',
      '    * <a href="#/202605/28/README">日报</a>',
      '    * <a href="#/202605/28/demo">Demo</a>',
    ].join('\n'),
    ['#/202605/28/demo', '#/202605/28/README'],
  );
  assert.ok(!next.includes('#/202605/28/demo'));
  assert.ok(!next.includes('#/202605/28/README'));
  assert.ok(next.includes('* Daily Papers'));
}

function createStorageContainerStub() {
  return {
    dataset: {},
    innerHTML: '',
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

function createDocumentStub() {
  const appended = [];
  const createElement = (tagName = 'div') => {
    const children = [];
    const el = {
      tagName,
      className: '',
      dataset: {},
      hidden: false,
      innerHTML: '',
      parentNode: null,
      style: {},
      textContent: '',
      children,
      classList: {
        add(...names) {
          const current = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
          names.forEach((name) => current.add(name));
          el.className = Array.from(current).join(' ');
        },
        remove(...names) {
          const current = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
          names.forEach((name) => current.delete(name));
          el.className = Array.from(current).join(' ');
        },
        contains(name) {
          return String(el.className || '').split(/\s+/).includes(name);
        },
      },
      appendChild(child) {
        child.parentNode = el;
        children.push(child);
        if (el === body) appended.push(child);
      },
      addEventListener() {},
      remove() {
        const index = appended.indexOf(el);
        if (index >= 0) appended.splice(index, 1);
      },
      querySelector(selector) {
        if (selector === '[data-storage-progress-message]') {
          el._progressMessage = el._progressMessage || createElement('p');
          return el._progressMessage;
        }
        if (selector === '[data-storage-progress-close]') {
          el._progressClose = el._progressClose || createElement('button');
          return el._progressClose;
        }
        if (selector === '.dpr-storage-modal-body') {
          el._modalBody = el._modalBody || createElement('div');
          return el._modalBody;
        }
        return null;
      },
      querySelectorAll() {
        return [];
      },
      setAttribute() {},
      focus() {},
    };
    return el;
  };
  const body = createElement('body');
  return {
    appended,
    body,
    createElement,
    getElementById() {
      return null;
    },
  };
}

async function testRefreshIfEmptyDoesNotAutoScan() {
  global.document = global.document || {
    getElementById() {
      return null;
    },
  };
  let scanCount = 0;
  const container = createStorageContainerStub();
  const api = {
    async listRepoTree() {
      scanCount += 1;
      return [];
    },
    async loadRepoTextFile() {
      return { content: '' };
    },
  };

  global.window.DPRStorageManager.mount(container, { api });
  global.window.DPRStorageManager.refreshIfEmpty();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(scanCount, 0);
  assert.ok(container.innerHTML.includes('删除前请先扫描运行态文件'));
  assert.ok(container.innerHTML.includes('想执行删除前，请先点击上方“扫描运行态文件”。'));
}

async function testOpenTrashShowsBlockingProgressBeforeScanCompletes() {
  const documentStub = createDocumentStub();
  global.document = documentStub;
  global.requestAnimationFrame = (fn) => fn();

  let scanCount = 0;
  let resolveTree;
  const treePromise = new Promise((resolve) => {
    resolveTree = resolve;
  });
  const api = {
    async listRepoTree() {
      scanCount += 1;
      return treePromise;
    },
    async loadRepoTextFile(path) {
      assert.equal(path, 'trash/manifest.json');
      return { content: '{"items":[]}' };
    },
  };

  global.window.DPRStorageManager.mount(createStorageContainerStub(), { api });
  const openPromise = global.window.DPRStorageManager.openTrashModal();

  assert.equal(scanCount, 1);
  assert.ok(
    documentStub.appended.some((el) =>
      String(el.className || '').includes('dpr-storage-progress-overlay')),
  );

  resolveTree({ files: [{ path: 'trash/manifest.json', type: 'blob', size: 20 }] });
  await openPromise;

  assert.ok(
    documentStub.appended.some((el) =>
      String(el.className || '').includes('dpr-storage-trash-modal-overlay')),
  );
}

async function testRuntimeMutationDoesNotForceReload() {
  const runtime = global.window.DPRStorageManager.__runtime;
  const originalLocation = global.window.location;
  let reloadCount = 0;
  global.window.location = {
    href: 'https://example.github.io/AI_Daily_Paper_Reader/#/202605/28/demo',
    hash: '#/202605/28/demo',
    reload() {
      reloadCount += 1;
    },
  };

  await runtime.reloadAfterRuntimeMutation({
    impacted: true,
    removedHrefs: ['#/202605/28/demo'],
  });

  assert.equal(global.window.location.hash, '#/');
  assert.equal(reloadCount, 0);
  global.window.location = originalLocation;
}

(async function run() {
  testRouteRecognition();
  testInventoryAndSelectionPlan();
  await testEnrichedPlanIncludesPdfAndFigures();
  testTrashManifestAndRestorePlan();
  testMergeSidebarContextLines();
  testHelpers();
  testRemoveSidebarLines();
  await testRefreshIfEmptyDoesNotAutoScan();
  await testOpenTrashShowsBlockingProgressBeforeScanCompletes();
  await testRuntimeMutationDoesNotForceReload();
  console.log('storage manager tests passed');
})();
