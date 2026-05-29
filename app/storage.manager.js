// Runtime storage manager for generated reports, local PDF artifacts, and trash branches.
window.DPRStorageManager = (function () {
  const RECYCLE_BRANCH_PREFIX = 'recycle/adpr-storage-';
  const DELETE_CONFIRM_PHRASE = '删除运行态';
  const RESTORE_CONFIRM_PHRASE = '恢复运行态';
  const EMPTY_TRASH_CONFIRM_PHRASE = '清空回收站';

  const PATH_CARDS = [
    {
      label: 'Daily Papers 日报',
      path: 'docs/YYYYMM/DD/README.md',
      note: '每日总览页，侧栏 Daily Papers 日期入口会指向这里。',
    },
    {
      label: '论文报告与文本',
      path: 'docs/YYYYMM/DD/<paper>.md / .txt',
      note: '单篇论文的网页报告和精读文本，删除时以单篇为最小单位。',
    },
    {
      label: '论文图片',
      path: 'docs/assets/figures/<paper-or-source>/',
      note: '由 PDF 提取或渲染的插图目录，会随对应论文一起进入删除计划。',
    },
    {
      label: '本地 PDF 解析',
      path: 'docs/local-pdf/YYYYMMDD/ + docs/assets/local_pdfs/',
      note: '本地上传 PDF、解析页面、上传缓存和原始 PDF 资源。',
    },
  ];

  const RUNTIME_RESTORE_PREFIXES = [
    'docs/_sidebar.md',
    'docs/assets/figures/',
    'docs/assets/local_pdfs/',
    'docs/local-pdf/',
    /^docs\/\d{6}\//,
    /^docs\/\d{8}-\d{8}\//,
  ];

  const state = {
    container: null,
    api: null,
    inventory: null,
    selectedIds: new Set(),
    plan: null,
    loading: false,
    planSeq: 0,
    trash: [],
    mounted: false,
    pathsExpanded: false,
    expandedIds: new Set(),
  };

  const escapeHtml = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const decodeHtml = (value) => String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  const normalizeRepoPath = (value) => String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');

  const normalizeHref = (value) => {
    let raw = String(value || '').trim();
    if (!raw) return '';
    try {
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
        const url = new URL(raw, window.location.href);
        raw = url.hash || url.pathname || raw;
      }
    } catch {
      return '';
    }
    raw = decodeURIComponent(raw);
    raw = (raw.startsWith('#') ? raw.split('?')[0] : raw.split(/[?#]/)[0]).replace(/\\/g, '/');
    if (raw.startsWith('/')) raw = `#${raw}`;
    if (!raw.startsWith('#/')) raw = `#/${raw.replace(/^#?\/?/, '')}`;
    raw = raw.replace(/\.md$/i, '').replace(/\/+$/, '');
    return raw;
  };

  const routeFromRepoPath = (path) => {
    const clean = normalizeRepoPath(path);
    let match = clean.match(/^docs\/(local-pdf\/\d{8}\/[^/]+)\.md$/i);
    if (match) return { routeId: match[1], type: 'local-pdf', groupKey: `local:${match[1].split('/')[1]}` };

    match = clean.match(/^docs\/(\d{6}\/\d{2}\/(?!README$)[^/]+)\.md$/i);
    if (match) {
      if (/\/README$/i.test(match[1])) return null;
      const parts = match[1].split('/');
      return { routeId: match[1], type: 'daily', groupKey: `daily:${parts[0]}/${parts[1]}` };
    }

    match = clean.match(/^docs\/(\d{8}-\d{8}\/(?!README$)[^/]+)\.md$/i);
    if (match) {
      if (/\/README$/i.test(match[1])) return null;
      const range = match[1].split('/')[0];
      return { routeId: match[1], type: 'daily', groupKey: `daily:${range}` };
    }

    return null;
  };

  const readmeHrefForGroupKey = (groupKey) => {
    const clean = String(groupKey || '').replace(/^(daily|local):/, '');
    if (!clean || groupKey.startsWith('local:')) return '';
    return `#/${clean}/README`;
  };

  const formatGroupLabel = (groupKey) => {
    const clean = String(groupKey || '').replace(/^(daily|local):/, '');
    if (/^\d{6}\/\d{2}$/.test(clean)) {
      const [ym, day] = clean.split('/');
      if (ym.startsWith('20')) return `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${day}`;
      return `20${ym.slice(0, 2)}-${ym.slice(2, 4)}-${day}`;
    }
    if (/^\d{8}$/.test(clean)) {
      return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
    }
    if (/^\d{8}-\d{8}$/.test(clean)) {
      const a = clean.slice(0, 8);
      const b = clean.slice(9);
      return `${a.slice(0, 4)}-${a.slice(4, 6)}-${a.slice(6, 8)} 至 ${b.slice(0, 4)}-${b.slice(4, 6)}-${b.slice(6, 8)}`;
    }
    return clean || '未分组';
  };

  const fileStemTitle = (routeId) => {
    const stem = String(routeId || '').split('/').pop() || 'paper';
    return stem.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  };

  const parseSidebarItems = (content) => {
    const result = new Map();
    String(content || '').split(/\r?\n/).forEach((line) => {
      const hrefMatch = line.match(/href=["']([^"']+)["']/i);
      if (!hrefMatch) return;
      const href = normalizeHref(hrefMatch[1]);
      if (!href || /\/README$/i.test(href) || href === '#/local-pdf') return;
      let title = '';
      const payloadMatch = line.match(/data-sidebar-item=["']([^"']+)["']/i);
      if (payloadMatch) {
        try {
          const payload = JSON.parse(decodeHtml(payloadMatch[1]));
          title = String(payload.title || payload.title_zh || '').trim();
        } catch {
          title = '';
        }
      }
      if (!title) {
        title = decodeHtml(line.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      }
      result.set(href, { href, title });
    });
    return result;
  };

  const parseFrontMatter = (markdown) => {
    const text = String(markdown || '').replace(/\r\n/g, '\n');
    if (!text.startsWith('---\n')) return {};
    const end = text.indexOf('\n---', 4);
    if (end < 0) return {};
    const front = text.slice(4, end).split('\n');
    const meta = {};
    front.forEach((line) => {
      const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (!match) return;
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      value = value
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\\\/g, '\\');
      meta[match[1]] = value;
    });
    return meta;
  };

  const normalizeGeneratedAssetPath = (value) => {
    let raw = String(value || '').trim();
    if (!raw) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      try {
        const url = new URL(raw, window.location.href);
        if (url.origin !== window.location.origin) return '';
        raw = decodeURIComponent(url.pathname || '');
      } catch {
        return '';
      }
    }
    raw = raw.split(/[?#]/)[0].replace(/\\/g, '/').replace(/^\.\/+/, '');
    const docsIdx = raw.indexOf('/docs/');
    if (docsIdx >= 0) raw = raw.slice(docsIdx + 1);
    raw = raw.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
    if (raw.startsWith('docs/')) return raw;
    if (raw.startsWith('assets/')) return `docs/${raw}`;
    return '';
  };

  const parseFiguresMeta = (meta) => {
    const raw = String((meta && meta.figures_json) || '').trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const pathMatchesRuntime = (path, matchers = RUNTIME_RESTORE_PREFIXES) => {
    const clean = normalizeRepoPath(path);
    return matchers.some((matcher) => {
      if (matcher instanceof RegExp) return matcher.test(clean);
      if (String(matcher).endsWith('/')) return clean.startsWith(String(matcher));
      return clean === String(matcher);
    });
  };

  const uniq = (items) => Array.from(new Set((items || []).map(normalizeRepoPath).filter(Boolean))).sort();

  const createInventory = ({ tree = [], sidebar = '' } = {}) => {
    const files = (Array.isArray(tree) ? tree : [])
      .filter((item) => item && item.type === 'blob' && item.path)
      .map((item) => ({
        path: normalizeRepoPath(item.path),
        size: Number(item.size || 0),
        sha: item.sha || '',
      }));
    const fileMap = new Map(files.map((item) => [item.path, item]));
    const sidebarItems = parseSidebarItems(sidebar);
    const leaves = [];

    files.forEach((file) => {
      const route = routeFromRepoPath(file.path);
      if (!route) return;
      const href = `#/${route.routeId}`;
      const side = sidebarItems.get(href) || {};
      leaves.push({
        id: `paper:${route.routeId}`,
        routeId: route.routeId,
        href,
        type: route.type,
        groupKey: route.groupKey,
        label: side.title || fileStemTitle(route.routeId),
        paths: [file.path, file.path.replace(/\.md$/i, '.txt')],
        size: file.size || 0,
      });
    });

    leaves.sort((a, b) => String(b.routeId).localeCompare(String(a.routeId)));
    const roots = [
      {
        id: 'root:daily',
        type: 'daily',
        label: 'Daily Papers',
        note: '',
        children: [],
      },
      {
        id: 'root:local-pdf',
        type: 'local-pdf',
        label: '本地导入 PDF',
        note: '',
        children: [],
      },
    ];
    const groups = new Map();
    leaves.forEach((leaf) => {
      const root = leaf.type === 'local-pdf' ? roots[1] : roots[0];
      if (!groups.has(leaf.groupKey)) {
        const node = {
          id: `group:${leaf.groupKey}`,
          type: leaf.type,
          groupKey: leaf.groupKey,
          label: formatGroupLabel(leaf.groupKey),
          note: leaf.type === 'local-pdf' ? '本日导入的本地 PDF 报告。' : '当日所有日报报告。',
          children: [],
        };
        groups.set(leaf.groupKey, node);
        root.children.push(node);
      }
      groups.get(leaf.groupKey).children.push(leaf);
    });
    roots.forEach((root) => root.children.sort((a, b) => String(b.groupKey).localeCompare(String(a.groupKey))));

    return {
      files,
      fileMap,
      sidebar,
      roots,
      leaves,
      generatedAt: new Date().toISOString(),
    };
  };

  const flattenLeafIds = (node) => {
    if (!node) return [];
    if (!Array.isArray(node.children) || !node.children.length) return [node.id];
    return node.children.flatMap(flattenLeafIds);
  };

  const findNodeById = (nodes, id) => {
    for (const node of nodes || []) {
      if (node.id === id) return node;
      const found = findNodeById(node.children || [], id);
      if (found) return found;
    }
    return null;
  };

  const selectionState = (node, selectedIds) => {
    const ids = flattenLeafIds(node);
    const checked = ids.filter((id) => selectedIds.has(id)).length;
    return {
      total: ids.length,
      checked,
      isChecked: ids.length > 0 && checked === ids.length,
      isPartial: checked > 0 && checked < ids.length,
    };
  };

  const collectSelectedLeaves = (inventory, selectedIds) => {
    if (!inventory) return [];
    return inventory.leaves.filter((leaf) => selectedIds.has(leaf.id));
  };

  const directoryCount = (inventory, dirPath) => {
    const clean = normalizeRepoPath(dirPath).replace(/\/+$/, '');
    const prefix = `${clean}/`;
    return (inventory.files || []).filter((file) => file.path.startsWith(prefix)).length;
  };

  const addDeletePath = (paths, path) => {
    const clean = normalizeRepoPath(path);
    if (clean && clean !== 'docs/_sidebar.md') paths.add(clean);
  };

  const removeSidebarLines = (content, hrefs) => {
    const targets = new Set((hrefs || []).map(normalizeHref).filter(Boolean));
    if (!targets.size) return String(content || '');
    const raw = String(content || '').replace(/\r\n/g, '\n');
    const hadTrailingNewline = raw.endsWith('\n');
    const lines = raw.split('\n');
    if (hadTrailingNewline) lines.pop();
    const next = [];
    lines.forEach((line) => {
      const hrefMatch = line.match(/href=["']([^"']+)["']/i);
      const href = hrefMatch ? normalizeHref(hrefMatch[1]) : '';
      if (href && targets.has(href)) return;
      next.push(line);
    });
    return pruneEmptySidebarSections(next).join('\n') + (hadTrailingNewline ? '\n' : '');
  };

  const pruneEmptySidebarSections = (lines) => {
    const output = lines.slice();
    for (let i = output.length - 1; i >= 0; i -= 1) {
      const line = output[i] || '';
      const trimmed = line.trim();
      if (!trimmed.startsWith('* ')) continue;
      const indent = line.match(/^\s*/)[0].length;
      if (indent > 2) continue;
      const isRuntimeGroup =
        /Daily Papers/.test(trimmed) ||
        /本地 PDF 解析/.test(trimmed) ||
        /\d{2,4}[-/]\d{2}[-/]\d{2}/.test(trimmed) ||
        /\d{8}-\d{8}/.test(trimmed) ||
        /精读|速读|Deep|Quick/.test(trimmed);
      if (!isRuntimeGroup) continue;
      let hasChildLink = false;
      for (let j = i + 1; j < output.length; j += 1) {
        const nextLine = output[j] || '';
        const nextIndent = nextLine.match(/^\s*/)[0].length;
        if (nextIndent <= indent && nextLine.trim().startsWith('* ')) break;
        if (/dpr-sidebar-item-link|README|local-pdf/.test(nextLine)) {
          hasChildLink = true;
          break;
        }
      }
      const keepLocalUpload = /本地 PDF 解析/.test(trimmed);
      if (!hasChildLink && !keepLocalUpload && indent > 0) {
        output.splice(i, 1);
      }
    }
    return output;
  };

  const buildDeletePlan = (inventory, selectedIds) => {
    const leaves = collectSelectedLeaves(inventory, selectedIds);
    const paths = new Set();
    const hrefs = new Set();
    const fullySelectedGroups = [];
    const fullySelectedRoots = [];

    leaves.forEach((leaf) => {
      leaf.paths.forEach((path) => addDeletePath(paths, path));
      hrefs.add(leaf.href);
    });

    (inventory.roots || []).forEach((root) => {
      const rootState = selectionState(root, selectedIds);
      if (rootState.isChecked && rootState.total > 0) fullySelectedRoots.push(root);
      (root.children || []).forEach((group) => {
        const groupState = selectionState(group, selectedIds);
        if (groupState.isChecked && groupState.total > 0) {
          fullySelectedGroups.push(group);
          const readmeHref = readmeHrefForGroupKey(group.groupKey);
          if (readmeHref) {
            hrefs.add(readmeHref);
            addDeletePath(paths, `docs/${readmeHref.replace(/^#\//, '')}.md`);
          }
          if (group.type === 'local-pdf') {
            addDeletePath(paths, `docs/local-pdf/${String(group.groupKey).replace(/^local:/, '')}/`);
          }
        }
      });
    });

    fullySelectedRoots.forEach((root) => {
      if (root.type === 'local-pdf') {
        addDeletePath(paths, 'docs/local-pdf/');
        addDeletePath(paths, 'docs/assets/local_pdfs/');
      }
    });

    const nextSidebar = removeSidebarLines(inventory.sidebar, Array.from(hrefs));
    return {
      leaves,
      hrefs: Array.from(hrefs).sort(),
      paths: uniq(Array.from(paths)),
      sidebarChanged: nextSidebar !== inventory.sidebar,
      nextSidebar,
      fullySelectedGroups,
      fullySelectedRoots,
      metadataLoaded: false,
      warnings: [],
    };
  };

  const enrichDeletePlan = async (plan, api, inventory) => {
    const paths = new Set(plan.paths);
    const warnings = [];
    for (const leaf of plan.leaves) {
      const mdPath = `docs/${leaf.routeId}.md`;
      try {
        const file = await api.loadRepoTextFile(mdPath, { requireWorkflow: false });
        const meta = parseFrontMatter((file && file.content) || '');
        addDeletePath(paths, normalizeGeneratedAssetPath(meta.pdf || meta.PDF || ''));
        parseFiguresMeta(meta).forEach((figure) => {
          const figurePath = normalizeGeneratedAssetPath(figure && figure.url);
          if (!figurePath) return;
          addDeletePath(paths, figurePath);
          const dir = figurePath.replace(/\/[^/]+$/, '');
          if (dir && directoryCount(inventory, dir) > 0) addDeletePath(paths, `${dir}/`);
        });
      } catch (err) {
        const msg = String((err && err.message) || err || '');
        if (!msg.includes('HTTP 404')) {
          warnings.push(`读取 ${mdPath} 失败：${msg}`);
        }
      }
    }
    return {
      ...plan,
      paths: uniq(Array.from(paths)),
      metadataLoaded: true,
      warnings,
    };
  };

  const summarizePlan = (plan, inventory) => {
    const fileCount = plan.paths.reduce((sum, path) => {
      if (path.endsWith('/')) return sum + directoryCount(inventory, path);
      return sum + (inventory.fileMap.has(path) ? 1 : 0);
    }, 0);
    return {
      paperCount: plan.leaves.length,
      pathCount: plan.paths.length,
      fileCount,
      sidebarChanged: plan.sidebarChanged,
    };
  };

  const renderPathCards = () => PATH_CARDS.map((item) => `
    <article class="dpr-storage-path-card">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(item.path)}</strong>
      <p>${escapeHtml(item.note)}</p>
    </article>
  `).join('');

  const renderPathStrip = () => `
    <section class="dpr-settings-card dpr-storage-strip dpr-storage-path-strip ${state.pathsExpanded ? 'is-expanded' : ''}">
      <div class="dpr-storage-strip-head">
        <div>
          <h3>运行态路径</h3>
          <p>查看日报、论文报告、图片、本地 PDF 等运行态文件的大致存储位置。</p>
        </div>
        <button class="arxiv-tool-btn dpr-storage-soft-btn" type="button" data-storage-action="toggle-paths">
          ${state.pathsExpanded ? '收起路径' : '展开路径'}
        </button>
      </div>
      ${state.pathsExpanded ? `<div class="dpr-storage-path-details"><div class="dpr-storage-path-grid">${renderPathCards()}</div></div>` : ''}
    </section>
  `;

  const nodeSelectionClass = (node) => {
    const info = selectionState(node, state.selectedIds);
    if (info.isChecked) return 'is-selected';
    if (info.isPartial) return 'is-partial';
    return '';
  };

  const renderNode = (node, depth = 0) => {
    const stateInfo = selectionState(node, state.selectedIds);
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    const expanded = hasChildren && state.expandedIds.has(node.id);
    const meta = hasChildren ? `${stateInfo.checked}/${stateInfo.total}` : '论文';
    const selectedClass = nodeSelectionClass(node);
    return `
      <li class="dpr-storage-node ${hasChildren ? 'has-children' : 'is-leaf'} ${selectedClass}" data-storage-node-id="${escapeHtml(node.id)}" data-storage-depth="${depth}">
        <div class="dpr-storage-node-wrap">
          ${hasChildren ? `
            <button
              class="dpr-storage-disclosure ${expanded ? 'is-open' : ''}"
              type="button"
              data-storage-toggle="${escapeHtml(node.id)}"
              aria-label="${expanded ? '收起' : '展开'} ${escapeHtml(node.label)}"
              aria-expanded="${expanded ? 'true' : 'false'}"
            >▸</button>
          ` : '<span class="dpr-storage-disclosure-spacer" aria-hidden="true"></span>'}
          <label class="dpr-storage-node-line ${selectedClass}">
            <input
              class="dpr-storage-select-dot"
              type="checkbox"
              data-storage-select="${escapeHtml(node.id)}"
              ${stateInfo.isChecked ? 'checked' : ''}
            />
            <span class="dpr-storage-node-text">
              <strong>${escapeHtml(node.label)}</strong>
            </span>
            <span class="dpr-storage-node-meta">${escapeHtml(meta)}</span>
          </label>
        </div>
        ${hasChildren && expanded ? `<ul>${node.children.map((child) => renderNode(child, depth + 1)).join('')}</ul>` : ''}
      </li>
    `;
  };

  const renderTree = () => {
    if (!state.inventory) return '<div class="dpr-settings-empty">点击“扫描运行态文件”后显示可删除层级。</div>';
    if (!state.inventory.leaves.length) {
      return '<div class="dpr-settings-empty">没有扫描到 Daily Papers 或本地 PDF 运行态报告。</div>';
    }
    return `<ul class="dpr-storage-tree dpr-storage-compact-tree">${state.inventory.roots.map((root) => renderNode(root, 0)).join('')}</ul>`;
  };

  const renderPlan = () => {
    if (!state.inventory || !state.plan || !state.plan.leaves.length) {
      return '<div class="dpr-settings-empty">尚未选中任何运行态文件。</div>';
    }
    const plan = state.plan;
    const summary = summarizePlan(plan, state.inventory);
    const samplePaths = plan.paths.map((path) => `<li>${escapeHtml(path)}</li>`).join('');
    return `
      <div class="dpr-storage-plan-summary">
        <span><strong>${summary.paperCount}</strong> 篇文献</span>
        <span><strong>${summary.pathCount}</strong> 个路径</span>
        <span><strong>${summary.fileCount}</strong> 个仓库文件</span>
      </div>
      <div class="dpr-storage-plan-note ${plan.metadataLoaded ? 'is-ready' : ''}">
        ${plan.metadataLoaded ? '已读取 front matter，PDF 与图片目录已纳入计划。' : '正在等待精确扫描图片/PDF 路径。'}
      </div>
      ${plan.warnings && plan.warnings.length ? `<div class="dpr-storage-warning">${escapeHtml(plan.warnings.join('；'))}</div>` : ''}
      <ol class="dpr-storage-plan-list">${samplePaths || '<li>未选中任何路径</li>'}</ol>
    `;
  };

  const renderTrash = () => {
    if (!state.trash.length) {
      return '<div class="dpr-settings-empty">回收站为空。批量删除前会自动创建一个备份分支。</div>';
    }
    return `
      <div class="dpr-storage-trash-list">
        ${state.trash.map((item) => `
          <article class="dpr-storage-trash-item">
            <div>
              <strong>${escapeHtml(item.name)}</strong>
              <span>${escapeHtml(item.sha ? item.sha.slice(0, 8) : 'unknown')}</span>
            </div>
            <div class="dpr-storage-trash-buttons">
              <button class="arxiv-tool-btn dpr-storage-restore-btn" type="button" data-storage-restore="${escapeHtml(item.name)}">恢复</button>
              <button class="arxiv-tool-btn dpr-storage-danger-btn" type="button" data-storage-empty="${escapeHtml(item.name)}">删除分支</button>
            </div>
          </article>
        `).join('')}
      </div>
    `;
  };

  const selectedPlanSummaryText = () => {
    if (!state.inventory || !state.plan || !state.plan.leaves.length) return '未选择运行态文件';
    const summary = summarizePlan(state.plan, state.inventory);
    return `已选择 ${summary.paperCount} 篇文献，${summary.pathCount} 个路径`;
  };

  const renderScanStrip = () => `
    <section class="dpr-settings-card dpr-storage-strip dpr-storage-scan-strip">
      <div class="dpr-storage-strip-head">
        <div>
          <h3>运行态扫描</h3>
          <p>${state.inventory ? `已扫描 ${state.inventory.leaves.length} 篇报告，${state.inventory.files.length} 个仓库文件。` : '尚未扫描。'}</p>
        </div>
        <button class="arxiv-tool-btn dpr-settings-primary-btn" type="button" data-storage-action="refresh">
          ${state.loading ? '扫描中...' : '扫描运行态文件'}
        </button>
      </div>
    </section>
  `;

  const renderDeleteStrip = () => `
    <section class="dpr-settings-card dpr-storage-strip dpr-storage-delete-strip">
      <div class="dpr-storage-strip-head">
        <div>
          <h3>批量删除</h3>
          <p>${escapeHtml(selectedPlanSummaryText())}</p>
        </div>
        <div class="dpr-storage-toolbar-actions">
          <button class="arxiv-tool-btn dpr-storage-soft-btn" type="button" data-storage-action="open-plan" ${state.plan && state.plan.leaves.length ? '' : 'disabled'}>查看待删除列表</button>
          <button class="arxiv-tool-btn dpr-storage-danger-btn" type="button" data-storage-action="delete-selected" ${state.plan && state.plan.leaves.length ? '' : 'disabled'}>移入回收站</button>
        </div>
      </div>
      <div data-storage-tree-root>${renderTree()}</div>
    </section>
  `;

  const render = () => {
    if (!state.container) return;
    state.container.innerHTML = `
      <div class="dpr-storage-manager">
        ${renderPathStrip()}
        ${renderScanStrip()}
        ${renderDeleteStrip()}
        <div class="dpr-settings-message" data-storage-message>
          说明：暂不清理本机阅读状态、收藏、颜色标记或聊天缓存。
        </div>
      </div>
    `;
    syncIndeterminate();
  };

  const setMessage = (text, color = '#475467') => {
    const el = state.container && state.container.querySelector('[data-storage-message]');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = color;
  };

  const syncIndeterminate = () => {
    if (!state.container || !state.inventory) return;
    state.container.querySelectorAll('[data-storage-select]').forEach((input) => {
      const node = findNodeById(state.inventory.roots, input.getAttribute('data-storage-select'));
      const info = selectionState(node, state.selectedIds);
      input.indeterminate = info.isPartial;
    });
  };

  const schedulePlanRefresh = () => {
    const seq = ++state.planSeq;
    const basePlan = state.inventory ? buildDeletePlan(state.inventory, state.selectedIds) : null;
    state.plan = basePlan;
    render();
    if (!basePlan || !basePlan.leaves.length) return;
    window.setTimeout(async () => {
      if (seq !== state.planSeq) return;
      try {
        const plan = await enrichDeletePlan(basePlan, getApi(), state.inventory);
        if (seq !== state.planSeq) return;
        state.plan = plan;
        render();
      } catch (err) {
        setMessage(`生成删除计划失败：${err && err.message ? err.message : err}`, '#c00');
      }
    }, 80);
  };

  const getApi = () => state.api || window.SubscriptionsGithubToken;

  const refresh = async () => {
    const api = getApi();
    if (!api || typeof api.listRepoTree !== 'function' || typeof api.loadRepoTextFile !== 'function') {
      setMessage('GitHub Token 模块尚未加载，无法扫描运行态文件。', '#c00');
      return;
    }
    state.loading = true;
    render();
    try {
      const tree = await api.listRepoTree({ requireWorkflow: false });
      let sidebar = '';
      try {
        const sidebarFile = await api.loadRepoTextFile('docs/_sidebar.md', { requireWorkflow: false });
        sidebar = sidebarFile.content || '';
      } catch {
        sidebar = '';
      }
      state.inventory = createInventory({ tree: tree.files || tree.tree || tree, sidebar });
      state.selectedIds = new Set();
      state.expandedIds = new Set();
      state.plan = null;
      setMessage('运行态文件扫描完成。', '#080');
    } catch (err) {
      setMessage(`扫描失败：${err && err.message ? err.message : err}`, '#c00');
    } finally {
      state.loading = false;
      render();
    }
  };

  const refreshTrash = async () => {
    const api = getApi();
    if (!api || typeof api.listRecycleBranches !== 'function') return;
    try {
      state.trash = await api.listRecycleBranches(RECYCLE_BRANCH_PREFIX, { requireWorkflow: false });
      render();
    } catch (err) {
      setMessage(`读取回收站失败：${err && err.message ? err.message : err}`, '#c00');
    }
  };

  const closeModal = (overlay, value, resolve) => {
    if (!overlay) {
      resolve(value);
      return;
    }
    overlay.classList.remove('is-visible');
    window.setTimeout(() => {
      if (overlay.parentNode) overlay.remove();
      resolve(value);
    }, 120);
  };

  const showInfoModal = ({ title, subtitle, body, className = '', headActions = '', bind }) => {
    const overlay = document.createElement('div');
    overlay.className = `dpr-storage-modal-overlay ${className}`.trim();
    overlay.innerHTML = `
      <div class="dpr-storage-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="dpr-storage-modal-head">
          <div>
            <h3>${escapeHtml(title)}</h3>
            ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
          </div>
          <div class="dpr-storage-modal-head-actions">
            ${headActions || ''}
            <button class="arxiv-tool-btn dpr-storage-soft-btn" type="button" data-storage-modal-close>关闭</button>
          </div>
        </div>
        <div class="dpr-storage-modal-body">${body || ''}</div>
      </div>
    `;
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay || (event.target && event.target.closest('[data-storage-modal-close]'))) {
        overlay.classList.remove('is-visible');
        window.setTimeout(() => overlay.remove(), 120);
      }
    });
    document.body.appendChild(overlay);
    if (typeof bind === 'function') bind(overlay);
    requestAnimationFrame(() => overlay.classList.add('is-visible'));
    return overlay;
  };

  const showConfirmPhrase = ({ title, message, phrase, confirmLabel, tone = 'danger' }) => new Promise((resolve) => {
    const isRestoreTone = tone === 'restore';
    const overlay = document.createElement('div');
    overlay.className = 'dpr-storage-modal-overlay dpr-storage-confirm-overlay';
    overlay.innerHTML = `
      <div class="dpr-storage-modal dpr-storage-confirm-modal ${isRestoreTone ? 'is-restore' : 'is-danger'}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="dpr-storage-modal-head">
          <div>
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(message)}</p>
          </div>
        </div>
        <label class="dpr-storage-confirm-field">
          <span>请输入确认短语：<strong>${escapeHtml(phrase)}</strong></span>
          <input type="text" data-storage-confirm-input autocomplete="off" />
        </label>
        <div class="dpr-storage-confirm-actions">
          <button class="arxiv-tool-btn dpr-storage-soft-btn" type="button" data-storage-confirm-cancel>取消</button>
          <button class="arxiv-tool-btn ${isRestoreTone ? 'dpr-storage-restore-btn' : 'dpr-storage-danger-btn'}" type="button" data-storage-confirm-ok disabled>${escapeHtml(confirmLabel || '确认')}</button>
        </div>
      </div>
    `;
    const input = overlay.querySelector('[data-storage-confirm-input]');
    const okBtn = overlay.querySelector('[data-storage-confirm-ok]');
    const cancelBtn = overlay.querySelector('[data-storage-confirm-cancel]');
    const update = () => {
      okBtn.disabled = input.value !== phrase;
    };
    input.addEventListener('input', update);
    cancelBtn.addEventListener('click', () => closeModal(overlay, false, resolve));
    okBtn.addEventListener('click', () => closeModal(overlay, true, resolve));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeModal(overlay, false, resolve);
    });
    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.add('is-visible');
      input.focus();
    });
  });

  const openPlanModal = () => {
    showInfoModal({
      title: '待删除列表',
      subtitle: '仅查看选中项和关联路径，不在此处执行删除。',
      body: renderPlan(),
      className: 'dpr-storage-plan-modal-overlay',
    });
  };

  const openTrashModal = async () => {
    await refreshTrash();
    showInfoModal({
      title: '回收站',
      subtitle: `备份分支前缀：${RECYCLE_BRANCH_PREFIX}`,
      className: 'dpr-storage-trash-modal-overlay',
      headActions: '<button class="arxiv-tool-btn dpr-storage-danger-btn" type="button" data-storage-action="empty-all-trash">清空回收站</button>',
      body: renderTrash(),
      bind: (overlay) => {
        overlay.addEventListener('click', (event) => {
          const restoreBtn = event.target && event.target.closest ? event.target.closest('[data-storage-restore]') : null;
          if (restoreBtn) {
            restoreBranch(restoreBtn.getAttribute('data-storage-restore') || '');
            overlay.remove();
            return;
          }
          const emptyBtn = event.target && event.target.closest ? event.target.closest('[data-storage-empty]') : null;
          if (emptyBtn) {
            emptyBranch(emptyBtn.getAttribute('data-storage-empty') || '');
            overlay.remove();
            return;
          }
          const emptyAllBtn = event.target && event.target.closest ? event.target.closest('[data-storage-action="empty-all-trash"]') : null;
          if (emptyAllBtn) {
            emptyAllTrash();
            overlay.remove();
          }
        });
      },
    });
  };

  const makeRecycleBranchName = () => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${RECYCLE_BRANCH_PREFIX}${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  };

  const deleteSelected = async () => {
    if (!state.inventory || !state.plan || !state.plan.leaves.length) {
      setMessage('请先选中要删除的运行态文件。', '#c00');
      return;
    }
    const api = getApi();
    if (
      !api ||
      typeof api.createRecycleBranch !== 'function' ||
      typeof api.commitRepoChanges !== 'function'
    ) {
      setMessage('GitHub Token 模块缺少回收站或提交能力。', '#c00');
      return;
    }
    const plan = state.plan.metadataLoaded
      ? state.plan
      : await enrichDeletePlan(state.plan, api, state.inventory);
    const summary = summarizePlan(plan, state.inventory);
    const ok = await showConfirmPhrase({
      title: '移入回收站',
      message: `该操作会先创建回收站分支，再删除 ${summary.paperCount} 篇文献、${summary.pathCount} 个路径。之后可通过回收站恢复。`,
      phrase: DELETE_CONFIRM_PHRASE,
      confirmLabel: '确认移入回收站',
    });
    if (!ok) {
      setMessage('已取消删除。');
      return;
    }
    const branchName = makeRecycleBranchName();
    try {
      setMessage('正在创建回收站分支...');
      await api.createRecycleBranch(branchName, { requireWorkflow: false });
      setMessage('正在提交删除计划...');
      const updates = plan.sidebarChanged
        ? [{ path: 'docs/_sidebar.md', content: plan.nextSidebar }]
        : [];
      await api.commitRepoChanges(
        {
          updates,
          deletes: plan.paths,
        },
        `chore: move runtime files to trash: ${branchName}`,
        { requireWorkflow: false },
      );
      setMessage(`已删除选中运行态文件，回收站分支：${branchName}`, '#080');
      await refresh();
      await refreshTrash();
    } catch (err) {
      setMessage(`删除失败：${err && err.message ? err.message : err}`, '#c00');
    }
  };

  const restoreBranch = async (branchName) => {
    const api = getApi();
    if (!api || typeof api.restoreRuntimeFromBranch !== 'function') {
      setMessage('GitHub Token 模块缺少恢复能力。', '#c00');
      return;
    }
    const ok = await showConfirmPhrase({
      title: '恢复运行态',
      message: `将从 ${branchName} 恢复运行态文件和侧栏快照。`,
      phrase: RESTORE_CONFIRM_PHRASE,
      confirmLabel: '确认恢复',
      tone: 'restore',
    });
    if (!ok) {
      setMessage('已取消恢复。');
      return;
    }
    try {
      setMessage('正在从回收站恢复...');
      const result = await api.restoreRuntimeFromBranch(branchName, {
        requireWorkflow: false,
        runtimeMatchers: RUNTIME_RESTORE_PREFIXES,
        commitMessage: `chore: restore runtime files from ${branchName}`,
      });
      setMessage(`恢复完成：${(result && result.restored && result.restored.length) || 0} 个文件。`, '#080');
      await refresh();
      await refreshTrash();
    } catch (err) {
      setMessage(`恢复失败：${err && err.message ? err.message : err}`, '#c00');
    }
  };

  const emptyBranch = async (branchName) => {
    const api = getApi();
    if (!api || typeof api.deleteBranch !== 'function') {
      setMessage('GitHub Token 模块缺少删除分支能力。', '#c00');
      return;
    }
    const ok = await showConfirmPhrase({
      title: '删除回收站分支',
      message: `将永久删除回收站分支 ${branchName}，该操作不会删除当前 main 文件。`,
      phrase: EMPTY_TRASH_CONFIRM_PHRASE,
      confirmLabel: '确认删除分支',
    });
    if (!ok) {
      setMessage('已取消清空。');
      return;
    }
    try {
      await api.deleteBranch(branchName, { requireWorkflow: false });
      setMessage(`已删除回收站分支：${branchName}`, '#080');
      await refreshTrash();
    } catch (err) {
      setMessage(`删除回收站分支失败：${err && err.message ? err.message : err}`, '#c00');
    }
  };

  const emptyAllTrash = async () => {
    if (!state.trash.length) return;
    const ok = await showConfirmPhrase({
      title: '清空回收站',
      message: `将删除 ${state.trash.length} 个回收站分支。该操作只删除备份分支，不删除当前运行态文件。`,
      phrase: EMPTY_TRASH_CONFIRM_PHRASE,
      confirmLabel: '确认清空回收站',
    });
    if (!ok) {
      setMessage('已取消清空。');
      return;
    }
    const api = getApi();
    try {
      for (const item of state.trash) {
        await api.deleteBranch(item.name, { requireWorkflow: false });
      }
      setMessage('回收站已清空。', '#080');
      await refreshTrash();
    } catch (err) {
      setMessage(`清空回收站失败：${err && err.message ? err.message : err}`, '#c00');
    }
  };

  const handleClick = (event) => {
    const toggleBtn = event.target && event.target.closest ? event.target.closest('[data-storage-toggle]') : null;
    if (toggleBtn) {
      const id = toggleBtn.getAttribute('data-storage-toggle') || '';
      if (state.expandedIds.has(id)) state.expandedIds.delete(id);
      else state.expandedIds.add(id);
      render();
      return;
    }
    const actionBtn = event.target && event.target.closest ? event.target.closest('[data-storage-action]') : null;
    if (actionBtn) {
      const action = actionBtn.getAttribute('data-storage-action');
      if (action === 'toggle-paths') {
        state.pathsExpanded = !state.pathsExpanded;
        render();
      }
      if (action === 'refresh') refresh();
      if (action === 'refresh-trash') refreshTrash();
      if (action === 'open-plan') openPlanModal();
      if (action === 'open-trash') openTrashModal();
      if (action === 'delete-selected') deleteSelected();
      if (action === 'empty-all-trash') emptyAllTrash();
      return;
    }
    const restoreBtn = event.target && event.target.closest ? event.target.closest('[data-storage-restore]') : null;
    if (restoreBtn) {
      restoreBranch(restoreBtn.getAttribute('data-storage-restore') || '');
      return;
    }
    const emptyBtn = event.target && event.target.closest ? event.target.closest('[data-storage-empty]') : null;
    if (emptyBtn) {
      emptyBranch(emptyBtn.getAttribute('data-storage-empty') || '');
    }
  };

  const handleChange = (event) => {
    const input = event.target && event.target.matches && event.target.matches('[data-storage-select]')
      ? event.target
      : null;
    if (!input || !state.inventory) return;
    const node = findNodeById(state.inventory.roots, input.getAttribute('data-storage-select'));
    const ids = flattenLeafIds(node);
    ids.forEach((id) => {
      if (input.checked) state.selectedIds.add(id);
      else state.selectedIds.delete(id);
    });
    schedulePlanRefresh();
  };

  const bindExternalTrashButton = () => {
    const btn = document.getElementById('dpr-storage-open-trash-page');
    if (!btn || btn._dprStorageTrashBound) return;
    btn._dprStorageTrashBound = true;
    btn.addEventListener('click', () => {
      openTrashModal();
    });
  };

  const mount = (container, options = {}) => {
    if (!container) return;
    if (state.container && state.container !== container) {
      state.container.removeEventListener('click', handleClick);
      state.container.removeEventListener('change', handleChange);
    }
    state.container = container;
    state.api = options.api || state.api || null;
    if (container.dataset.storageManagerMounted !== '1') {
      container.dataset.storageManagerMounted = '1';
      container.addEventListener('click', handleClick);
      container.addEventListener('change', handleChange);
    }
    render();
    bindExternalTrashButton();
    if (options.autoRefresh) refresh();
    if (options.autoRefreshTrash) refreshTrash();
  };

  const refreshIfEmpty = () => {
    if (!state.inventory && !state.loading) refresh();
    refreshTrash();
  };

  return {
    mount,
    refresh,
    refreshIfEmpty,
    openTrashModal,
    __test: {
      RECYCLE_BRANCH_PREFIX,
      DELETE_CONFIRM_PHRASE,
      RESTORE_CONFIRM_PHRASE,
      EMPTY_TRASH_CONFIRM_PHRASE,
      normalizeHref,
      normalizeRepoPath,
      routeFromRepoPath,
      parseFrontMatter,
      parseFiguresMeta,
      createInventory,
      buildDeletePlan,
      enrichDeletePlan,
      summarizePlan,
      removeSidebarLines,
      pathMatchesRuntime,
      RUNTIME_RESTORE_PREFIXES,
    },
  };
})();
