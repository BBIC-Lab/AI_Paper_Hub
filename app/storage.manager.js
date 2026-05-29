// Runtime storage manager for generated reports, local PDF artifacts, and trash folders.
window.DPRStorageManager = (function () {
  const RECYCLE_BRANCH_PREFIX = 'recycle/adpr-storage-';
  const TRASH_ROOT = 'trash';
  const TRASH_MANIFEST_PATH = `${TRASH_ROOT}/manifest.json`;
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
    trashInventory: null,
    trashSelectedIds: new Set(),
    trashExpandedIds: new Set(),
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

  const trashPathFor = (path) => `${TRASH_ROOT}/${normalizeRepoPath(path)}`;

  const originalPathFromTrash = (path) => {
    const clean = normalizeRepoPath(path);
    const prefix = `${TRASH_ROOT}/`;
    return clean.startsWith(prefix) ? clean.slice(prefix.length) : clean;
  };

  const routeTypeFromRouteId = (routeId) =>
    String(routeId || '').startsWith('local-pdf/') ? 'local-pdf' : 'daily';

  const groupKeyFromRouteId = (routeId) => {
    const clean = String(routeId || '').replace(/^#?\//, '').replace(/\.md$/i, '');
    if (clean.startsWith('local-pdf/')) {
      const date = clean.split('/')[1] || '';
      return `local:${date}`;
    }
    const parts = clean.split('/');
    if (/^\d{8}-\d{8}$/.test(parts[0] || '')) return `daily:${parts[0]}`;
    if (parts.length >= 2) return `daily:${parts[0]}/${parts[1]}`;
    return 'daily:unknown';
  };

  const makeTrashItemId = (routeId, deletedAt = new Date().toISOString()) => {
    const slug = String(routeId || 'item').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
    return `${deletedAt.replace(/[^0-9]/g, '').slice(0, 14)}-${slug}`;
  };

  const normalizeTrashManifest = (manifest) => {
    const raw = manifest && typeof manifest === 'object' ? manifest : {};
    const items = Array.isArray(raw.items) ? raw.items : [];
    const extras = Array.isArray(raw.extras) ? raw.extras : [];
    return {
      version: 1,
      updatedAt: String(raw.updatedAt || ''),
      items: items.map((item) => {
        const routeId = String(item.routeId || item.href || '').replace(/^#?\//, '').replace(/\.md$/i, '').replace(/\/$/, '');
        const type = item.type === 'local-pdf' ? 'local-pdf' : routeTypeFromRouteId(routeId);
        const groupKey = item.groupKey || groupKeyFromRouteId(routeId);
        const deletedAt = String(item.deletedAt || raw.updatedAt || new Date().toISOString());
        return {
          id: String(item.id || makeTrashItemId(routeId, deletedAt)),
          routeId,
          href: normalizeHref(item.href || `#/${routeId}`),
          type,
          groupKey,
          label: String(item.label || fileStemTitle(routeId)),
          deletedAt,
          deletedBy: String(item.deletedBy || 'settings'),
          paths: uniq(item.paths || []),
          hrefs: (item.hrefs || [item.href || `#/${routeId}`]).map(normalizeHref).filter(Boolean),
          sidebarContextLines: Array.isArray(item.sidebarContextLines) ? item.sidebarContextLines.map(String) : [],
        };
      }).filter((item) => item.routeId && item.paths.length),
      extras: extras.map((item) => ({
        id: String(item.id || `extra:${item.groupKey || 'unknown'}:${(item.paths || []).join('|')}`),
        type: item.type === 'local-pdf' ? 'local-pdf' : 'daily',
        groupKey: String(item.groupKey || ''),
        label: String(item.label || formatGroupLabel(item.groupKey || '')),
        paths: uniq(item.paths || []),
      })).filter((item) => item.groupKey && item.paths.length),
    };
  };

  const loadTrashManifest = async (api) => {
    try {
      const file = await api.loadRepoTextFile(TRASH_MANIFEST_PATH, { requireWorkflow: false });
      return normalizeTrashManifest(JSON.parse(file.content || '{}'));
    } catch (err) {
      const msg = String((err && err.message) || err || '');
      if (msg.includes('HTTP 404')) return normalizeTrashManifest({});
      throw err;
    }
  };

  const serializeTrashManifest = (manifest) => {
    const normalized = normalizeTrashManifest(manifest);
    normalized.updatedAt = new Date().toISOString();
    return `${JSON.stringify(normalized, null, 2)}\n`;
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

  const extractLineHref = (line) => {
    const match = String(line || '').match(/\bhref=["']([^"']+)["']/i);
    return match ? normalizeHref(match[1]) : '';
  };

  const lineIndent = (line) => (String(line || '').match(/^\s*/) || [''])[0].length;

  const extractSidebarContextLines = (content, href) => {
    const targetHref = normalizeHref(href);
    if (!targetHref) return [];
    const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
    const index = lines.findIndex((line) => extractLineHref(line) === targetHref);
    if (index < 0) return [];
    const context = [lines[index]];
    let childIndent = lineIndent(lines[index]);
    for (let i = index - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!String(line || '').trim().startsWith('*')) continue;
      const indent = lineIndent(line);
      if (indent < childIndent) {
        context.unshift(line);
        childIndent = indent;
      }
    }
    return context.filter((line) => String(line || '').trim());
  };

  const insertAfterSubtree = (lines, parentIndex, childLine) => {
    const indent = lineIndent(lines[parentIndex]);
    let insertAt = parentIndex + 1;
    while (insertAt < lines.length) {
      const next = lines[insertAt];
      if (String(next || '').trim() && lineIndent(next) <= indent) break;
      insertAt += 1;
    }
    lines.splice(insertAt, 0, childLine);
    return insertAt;
  };

  const subtreeEndIndex = (lines, parentIndex) => {
    if (parentIndex < 0) return lines.length;
    const indent = lineIndent(lines[parentIndex]);
    let end = parentIndex + 1;
    while (end < lines.length) {
      const next = lines[end];
      if (String(next || '').trim() && lineIndent(next) <= indent) break;
      end += 1;
    }
    return end;
  };

  const findExistingContextLine = (lines, line, parentIndex) => {
    const targetText = String(line || '').trim();
    const targetIndent = lineIndent(line);
    const start = parentIndex >= 0 ? parentIndex + 1 : 0;
    const end = subtreeEndIndex(lines, parentIndex);
    for (let i = start; i < end; i += 1) {
      const candidate = lines[i];
      if (String(candidate || '').trim() !== targetText) continue;
      if (lineIndent(candidate) !== targetIndent) continue;
      return i;
    }
    return -1;
  };

  const mergeSidebarContextLines = (content, contextGroups) => {
    const raw = String(content || '').replace(/\r\n/g, '\n');
    const hadTrailingNewline = raw.endsWith('\n');
    const lines = raw.split('\n');
    if (hadTrailingNewline) lines.pop();
    (contextGroups || []).forEach((group) => {
      const context = (Array.isArray(group) ? group : []).filter((line) => String(line || '').trim());
      if (!context.length) return;
      const leafHref = extractLineHref(context[context.length - 1]);
      if (leafHref && lines.some((line) => extractLineHref(line) === leafHref)) return;
      let parentIndex = -1;
      context.forEach((line) => {
        const existing = findExistingContextLine(lines, line, parentIndex);
        if (existing >= 0) {
          parentIndex = existing;
          return;
        }
        if (parentIndex >= 0) {
          parentIndex = insertAfterSubtree(lines, parentIndex, line);
        } else {
          lines.push(line);
          parentIndex = lines.length - 1;
        }
      });
    });
    return lines.join('\n') + (hadTrailingNewline ? '\n' : '');
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

  const createTrashInventory = ({ tree = [], manifest = {} } = {}) => {
    const files = (Array.isArray(tree) ? tree : [])
      .filter((item) => item && item.type === 'blob' && item.path)
      .map((item) => ({
        path: normalizeRepoPath(item.path),
        originalPath: originalPathFromTrash(item.path),
        size: Number(item.size || 0),
        sha: item.sha || '',
      }))
      .filter((item) => item.path.startsWith(`${TRASH_ROOT}/`) && item.path !== TRASH_MANIFEST_PATH);
    const fileMap = new Map(files.map((item) => [item.path, item]));
    const trashManifest = normalizeTrashManifest(manifest);
    const roots = [
      {
        id: 'trash-root:daily',
        type: 'daily',
        label: 'Daily Papers',
        note: '',
        children: [],
        extraPaths: [],
      },
      {
        id: 'trash-root:local-pdf',
        type: 'local-pdf',
        label: '本地导入 PDF',
        note: '',
        children: [],
        extraPaths: [],
      },
    ];
    const groups = new Map();
    const groupFor = (type, groupKey, label) => {
      const root = type === 'local-pdf' ? roots[1] : roots[0];
      if (!groups.has(groupKey)) {
        const node = {
          id: `trash-group:${groupKey}`,
          type,
          groupKey,
          label: label || formatGroupLabel(groupKey),
          note: '',
          children: [],
          extraPaths: [],
        };
        groups.set(groupKey, node);
        root.children.push(node);
      }
      return groups.get(groupKey);
    };
    trashManifest.items.forEach((item) => {
      const group = groupFor(item.type, item.groupKey, formatGroupLabel(item.groupKey));
      group.children.push({
        id: `trash-paper:${item.id}`,
        trashId: item.id,
        routeId: item.routeId,
        href: item.href,
        type: item.type,
        groupKey: item.groupKey,
        label: item.label,
        paths: item.paths || [],
        hrefs: item.hrefs || [item.href],
        sidebarContextLines: item.sidebarContextLines || [],
        deletedAt: item.deletedAt,
      });
    });
    trashManifest.extras.forEach((extra) => {
      const group = groupFor(extra.type, extra.groupKey, extra.label || formatGroupLabel(extra.groupKey));
      group.extraPaths.push(...(extra.paths || []));
      const root = extra.type === 'local-pdf' ? roots[1] : roots[0];
      root.extraPaths.push(...(extra.paths || []));
    });
    roots.forEach((root) => {
      root.children.sort((a, b) => String(b.groupKey).localeCompare(String(a.groupKey)));
      root.children.forEach((group) => group.children.sort((a, b) => String(b.routeId).localeCompare(String(a.routeId))));
      root.extraPaths = uniq(root.extraPaths || []);
    });
    groups.forEach((group) => {
      group.extraPaths = uniq(group.extraPaths || []);
    });
    return {
      files,
      fileMap,
      roots,
      leaves: trashManifest.items.map((item) => ({
        id: `trash-paper:${item.id}`,
        trashId: item.id,
        routeId: item.routeId,
        href: item.href,
        type: item.type,
        groupKey: item.groupKey,
        label: item.label,
        paths: item.paths || [],
        hrefs: item.hrefs || [item.href],
        sidebarContextLines: item.sidebarContextLines || [],
        deletedAt: item.deletedAt,
      })),
      manifest: trashManifest,
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
      originalSidebar: inventory.sidebar,
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
    const leafTrashPaths = new Map();
    for (const leaf of plan.leaves) {
      const mdPath = `docs/${leaf.routeId}.md`;
      const perLeafPaths = new Set((leaf.paths || []).map(normalizeRepoPath));
      try {
        const file = await api.loadRepoTextFile(mdPath, { requireWorkflow: false });
        const meta = parseFrontMatter((file && file.content) || '');
        const pdfPath = normalizeGeneratedAssetPath(meta.pdf || meta.PDF || '');
        addDeletePath(paths, pdfPath);
        if (pdfPath) perLeafPaths.add(pdfPath);
        parseFiguresMeta(meta).forEach((figure) => {
          const figurePath = normalizeGeneratedAssetPath(figure && figure.url);
          if (!figurePath) return;
          addDeletePath(paths, figurePath);
          perLeafPaths.add(figurePath);
          const dir = figurePath.replace(/\/[^/]+$/, '');
          if (dir && directoryCount(inventory, dir) > 0) {
            addDeletePath(paths, `${dir}/`);
            perLeafPaths.add(`${dir}/`);
          }
        });
      } catch (err) {
        const msg = String((err && err.message) || err || '');
        if (!msg.includes('HTTP 404')) {
          warnings.push(`读取 ${mdPath} 失败：${msg}`);
        }
      }
      leafTrashPaths.set(leaf.id, uniq(Array.from(perLeafPaths)));
    }
    return {
      ...plan,
      leaves: (plan.leaves || []).map((leaf) => ({
        ...leaf,
        trashPaths: leafTrashPaths.get(leaf.id) || leaf.paths || [],
      })),
      paths: uniq(Array.from(paths)),
      metadataLoaded: true,
      warnings,
    };
  };

  const leafTrashPaths = (plan, leaf) => {
    if (Array.isArray(leaf.trashPaths) && leaf.trashPaths.length) return uniq(leaf.trashPaths);
    const prefix = `docs/${leaf.routeId}`.replace(/\/+$/, '');
    const bases = new Set((leaf.paths || []).map(normalizeRepoPath));
    const out = new Set();
    (plan.paths || []).forEach((path) => {
      const clean = normalizeRepoPath(path);
      if (!clean) return;
      if (bases.has(clean)) {
        out.add(clean);
        return;
      }
      if (clean.startsWith(`${prefix}.`)) out.add(clean);
      if (clean.startsWith('docs/assets/figures/') || clean.startsWith('docs/assets/local_pdfs/')) {
        const stem = leaf.routeId.split('/').pop() || '';
        if (stem && clean.includes(stem)) out.add(clean);
      }
    });
    (leaf.paths || []).forEach((path) => out.add(path));
    return uniq(Array.from(out));
  };

  const collectLeafPathSet = (items) => {
    const set = new Set();
    (items || []).forEach((item) => (item.paths || []).forEach((path) => set.add(normalizeRepoPath(path))));
    return set;
  };

  const appendPlanToTrashManifest = (manifest, plan, source = 'settings') => {
    const next = normalizeTrashManifest(manifest);
    const deletedAt = new Date().toISOString();
    const items = (plan.leaves || []).map((leaf) => ({
      id: makeTrashItemId(leaf.routeId, deletedAt),
      routeId: leaf.routeId,
      href: leaf.href,
      type: leaf.type,
      groupKey: leaf.groupKey,
      label: leaf.label,
      deletedAt,
      deletedBy: source,
      paths: leafTrashPaths(plan, leaf),
      hrefs: [leaf.href],
      sidebarContextLines: extractSidebarContextLines(plan.originalSidebar || '', leaf.href),
    }));
    const leafPathSet = collectLeafPathSet(items);
    const extras = [];
    (plan.fullySelectedGroups || []).forEach((group) => {
      const paths = (plan.paths || []).filter((path) => {
        const clean = normalizeRepoPath(path);
        if (!clean || leafPathSet.has(clean)) return false;
        if (group.type === 'local-pdf') {
          const date = String(group.groupKey || '').replace(/^local:/, '');
          return clean.startsWith(`docs/local-pdf/${date}/`);
        }
        const key = String(group.groupKey || '').replace(/^daily:/, '');
        return clean.startsWith(`docs/${key}/`);
      });
      if (paths.length) {
        extras.push({
          id: `extra:${deletedAt}:${group.groupKey}`,
          type: group.type,
          groupKey: group.groupKey,
          label: group.label,
          paths: uniq(paths),
        });
      }
    });
    next.items.push(...items);
    next.extras.push(...extras);
    return normalizeTrashManifest(next);
  };

  const buildSidebarTrashItem = ({ href, title, paths, sidebar }) => {
    const routeId = normalizeHref(href).replace(/^#\//, '').replace(/\.md$/i, '').replace(/\/$/, '');
    const deletedAt = new Date().toISOString();
    return normalizeTrashManifest({
      items: [{
        id: makeTrashItemId(routeId, deletedAt),
        routeId,
        href: `#/${routeId}`,
        type: routeTypeFromRouteId(routeId),
        groupKey: groupKeyFromRouteId(routeId),
        label: title || fileStemTitle(routeId),
        deletedAt,
        deletedBy: 'sidebar',
        paths,
        hrefs: [`#/${routeId}`],
        sidebarContextLines: extractSidebarContextLines(sidebar || '', `#/${routeId}`),
      }],
    }).items[0];
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

  const trashDirectoryCount = (inventory, originalDirPath) => {
    const clean = normalizeRepoPath(originalDirPath).replace(/\/+$/, '');
    const prefix = `${TRASH_ROOT}/${clean}/`;
    return (inventory.files || []).filter((file) => file.path.startsWith(prefix)).length;
  };

  const collectSelectedTrashLeaves = (inventory, selectedIds) => {
    if (!inventory) return [];
    return inventory.leaves.filter((leaf) => selectedIds.has(leaf.id));
  };

  const buildTrashActionPlan = (inventory, selectedIds) => {
    const leaves = collectSelectedTrashLeaves(inventory, selectedIds);
    const paths = new Set();
    const contextGroups = [];
    const selectedGroups = [];
    (leaves || []).forEach((leaf) => {
      (leaf.paths || []).forEach((path) => paths.add(normalizeRepoPath(path)));
      if (leaf.sidebarContextLines && leaf.sidebarContextLines.length) {
        contextGroups.push(leaf.sidebarContextLines);
      }
    });
    (inventory.roots || []).forEach((root) => {
      (root.children || []).forEach((group) => {
        const info = selectionState(group, selectedIds);
        if (info.isChecked && info.total > 0) {
          selectedGroups.push(group);
          (group.extraPaths || []).forEach((path) => paths.add(normalizeRepoPath(path)));
        }
      });
      const rootInfo = selectionState(root, selectedIds);
      if (rootInfo.isChecked && rootInfo.total > 0) {
        (root.extraPaths || []).forEach((path) => paths.add(normalizeRepoPath(path)));
      }
    });
    return {
      leaves,
      selectedGroups,
      paths: uniq(Array.from(paths)),
      contextGroups,
    };
  };

  const summarizeTrashPlan = (plan, inventory) => {
    const fileCount = (plan.paths || []).reduce((sum, path) => {
      if (path.endsWith('/')) return sum + trashDirectoryCount(inventory, path);
      return sum + (inventory.fileMap.has(trashPathFor(path)) ? 1 : 0);
    }, 0);
    return {
      paperCount: (plan.leaves || []).length,
      pathCount: (plan.paths || []).length,
      fileCount,
    };
  };

  const removeTrashPlanFromManifest = (manifest, plan) => {
    const selectedIds = new Set((plan.leaves || []).map((leaf) => leaf.trashId || String(leaf.id || '').replace(/^trash-paper:/, '')));
    const selectedPaths = new Set((plan.paths || []).map(normalizeRepoPath));
    const next = normalizeTrashManifest(manifest);
    next.items = next.items.filter((item) => !selectedIds.has(item.id));
    next.extras = next.extras
      .map((extra) => ({
        ...extra,
        paths: (extra.paths || []).filter((path) => !selectedPaths.has(normalizeRepoPath(path))),
      }))
      .filter((extra) => extra.paths.length);
    return normalizeTrashManifest(next);
  };

  const routeImpactedByPaths = (href, paths) => {
    const route = normalizeHref(href || (window.location && window.location.hash) || '#/')
      .replace(/^#\//, '')
      .replace(/\/$/, '');
    if (!route) return false;
    const candidates = [`docs/${route}.md`, `docs/${route}.txt`, `docs/${route}/`].map(normalizeRepoPath);
    return (paths || []).map(normalizeRepoPath).some((path) => {
      if (!path) return false;
      if (path.endsWith('/')) return candidates.some((candidate) => candidate.startsWith(path));
      return candidates.includes(path);
    });
  };

  const delay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  const showBlockingProgress = ({ title = '正在处理运行态文件', message = '请稍候...', tone = 'neutral' } = {}) => {
    const overlay = document.createElement('div');
    overlay.className = `dpr-storage-progress-overlay is-${tone}`;
    overlay.innerHTML = `
      <div class="dpr-storage-progress-modal" role="alertdialog" aria-modal="true" aria-live="polite">
        <div class="dpr-storage-progress-spinner" aria-hidden="true"></div>
        <h3>${escapeHtml(title)}</h3>
        <p data-storage-progress-message>${escapeHtml(message)}</p>
        <button class="arxiv-tool-btn dpr-storage-soft-btn" type="button" data-storage-progress-close hidden>关闭</button>
      </div>
    `;
    overlay.addEventListener('click', (event) => {
      const closeBtn = event.target && event.target.closest ? event.target.closest('[data-storage-progress-close]') : null;
      if (closeBtn) overlay.remove();
    });
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('is-visible'));
    const messageEl = overlay.querySelector('[data-storage-progress-message]');
    const closeBtn = overlay.querySelector('[data-storage-progress-close]');
    return {
      setMessage(nextMessage) {
        if (messageEl) messageEl.textContent = nextMessage || '';
      },
      setError(nextMessage) {
        overlay.classList.add('is-error');
        if (messageEl) messageEl.textContent = nextMessage || '';
        if (closeBtn) closeBtn.hidden = false;
      },
      close() {
        overlay.classList.remove('is-visible');
        window.setTimeout(() => overlay.remove(), 140);
      },
    };
  };

  const removeVisibleSidebarHrefs = (hrefs = []) => {
    if (typeof document === 'undefined' || !document.querySelector) return;
    const nav = document.querySelector('.sidebar-nav');
    if (!nav) return;
    const targets = new Set(
      (hrefs || [])
        .map((href) => normalizeHref(href).replace(/\.md$/i, '').replace(/\/$/, ''))
        .filter(Boolean),
    );
    if (!targets.size) return;
    nav.querySelectorAll('a[href]').forEach((link) => {
      const href = normalizeHref(link.getAttribute('href') || '')
        .replace(/\.md$/i, '')
        .replace(/\/$/, '');
      if (!targets.has(href)) return;
      const li = link.closest && link.closest('li');
      if (li && li.remove) li.remove();
    });
    if (window.syncSidebarActiveIndicator && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => window.syncSidebarActiveIndicator({ animate: false }));
    }
  };

  const reloadAfterRuntimeMutation = async ({ impacted = false, removedHrefs = [] } = {}) => {
    removeVisibleSidebarHrefs(removedHrefs);
    if (impacted) {
      window.location.hash = '#/';
      await delay(80);
    }
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
    if (!state.inventory) return '<div class="dpr-settings-empty">想执行删除前，请先点击上方“扫描运行态文件”。</div>';
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
    const inventory = state.trashInventory;
    if (!inventory || !inventory.leaves.length) {
      return '<div class="dpr-settings-empty">回收站为空。首次删除会把文件移动到 trash/ 文件夹。</div>';
    }
    const plan = buildTrashActionPlan(inventory, state.trashSelectedIds);
    const summary = summarizeTrashPlan(plan, inventory);
    return `
      <div class="dpr-storage-plan-summary">
        <span><strong>${summary.paperCount}</strong> 篇文献</span>
        <span><strong>${summary.pathCount}</strong> 个路径</span>
        <span><strong>${summary.fileCount}</strong> 个仓库文件</span>
      </div>
      <div class="dpr-storage-trash-actions">
        <button class="arxiv-tool-btn dpr-storage-restore-btn" type="button" data-storage-trash-action="restore-selected" ${plan.leaves.length ? '' : 'disabled'}>恢复选中项</button>
        <button class="arxiv-tool-btn dpr-storage-danger-btn" type="button" data-storage-trash-action="delete-selected" ${plan.leaves.length ? '' : 'disabled'}>彻底删除选中项</button>
      </div>
      <ul class="dpr-storage-tree dpr-storage-compact-tree dpr-storage-trash-tree">
        ${inventory.roots.filter((root) => root.children && root.children.length).map((root) => renderTrashNode(root, 0)).join('')}
      </ul>
    `;
  };

  const renderTrashNode = (node, depth = 0) => {
    const stateInfo = selectionState(node, state.trashSelectedIds);
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    const expanded = hasChildren && state.trashExpandedIds.has(node.id);
    const meta = hasChildren ? `${stateInfo.checked}/${stateInfo.total}` : '文献';
    const selectedClass = stateInfo.isChecked ? 'is-selected' : (stateInfo.isPartial ? 'is-partial' : '');
    return `
      <li class="dpr-storage-node ${hasChildren ? 'has-children' : 'is-leaf'} ${selectedClass}" data-storage-trash-node-id="${escapeHtml(node.id)}" data-storage-depth="${depth}">
        <div class="dpr-storage-node-wrap">
          ${hasChildren ? `
            <button
              class="dpr-storage-disclosure ${expanded ? 'is-open' : ''}"
              type="button"
              data-storage-trash-toggle="${escapeHtml(node.id)}"
              aria-label="${expanded ? '收起' : '展开'} ${escapeHtml(node.label)}"
              aria-expanded="${expanded ? 'true' : 'false'}"
            >▸</button>
          ` : '<span class="dpr-storage-disclosure-spacer" aria-hidden="true"></span>'}
          <label class="dpr-storage-node-line ${selectedClass}">
            <input
              class="dpr-storage-select-dot"
              type="checkbox"
              data-storage-trash-select="${escapeHtml(node.id)}"
              ${stateInfo.isChecked ? 'checked' : ''}
            />
            <span class="dpr-storage-node-text">
              <strong>${escapeHtml(node.label)}</strong>
            </span>
            <span class="dpr-storage-node-meta">${escapeHtml(meta)}</span>
          </label>
        </div>
        ${hasChildren && expanded ? `<ul>${node.children.map((child) => renderTrashNode(child, depth + 1)).join('')}</ul>` : ''}
      </li>
    `;
  };

  const selectedPlanSummaryText = () => {
    if (!state.inventory) return '删除前请先扫描运行态文件';
    if (!state.plan || !state.plan.leaves.length) return '未选择运行态文件';
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

  const syncTrashIndeterminate = (root = document) => {
    if (!state.trashInventory) return;
    root.querySelectorAll('[data-storage-trash-select]').forEach((input) => {
      const node = findNodeById(state.trashInventory.roots, input.getAttribute('data-storage-trash-select'));
      const info = selectionState(node, state.trashSelectedIds);
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

  const refreshTrash = async (options = {}) => {
    const {
      progress = null,
      overlay = null,
      renderMain = true,
      resetSelection = true,
      resetExpanded = true,
      throwOnError = false,
      message = '正在扫描回收站文件...',
    } = options || {};
    const api = getApi();
    if (!api || typeof api.listRepoTree !== 'function' || typeof api.loadRepoTextFile !== 'function') {
      const err = new Error('GitHub Token 模块尚未加载，无法扫描回收站文件。');
      setMessage(err.message, '#c00');
      if (progress) progress.setError(err.message);
      if (throwOnError) throw err;
      return null;
    }
    try {
      if (progress) progress.setMessage(message);
      const tree = await api.listRepoTree({ requireWorkflow: false });
      if (progress) progress.setMessage('正在读取回收站清单...');
      const manifest = await loadTrashManifest(api);
      state.trashInventory = createTrashInventory({ tree: tree.files || tree.tree || tree, manifest });
      if (resetSelection) state.trashSelectedIds = new Set();
      if (resetExpanded) state.trashExpandedIds = new Set();
      if (renderMain) render();
      if (overlay) refreshTrashModalBody(overlay);
      return state.trashInventory;
    } catch (err) {
      const errorMessage = `读取回收站失败：${err && err.message ? err.message : err}`;
      setMessage(errorMessage, '#c00');
      if (progress) progress.setError(errorMessage);
      if (throwOnError) throw err;
      return null;
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
    const progress = showBlockingProgress({
      title: '正在扫描回收站文件',
      message: `正在读取 ${TRASH_ROOT}/ 目录...`,
      tone: 'neutral',
    });
    try {
      await refreshTrash({
        progress,
        renderMain: false,
        throwOnError: true,
        message: `正在扫描 ${TRASH_ROOT}/ 目录...`,
      });
      progress.close();
      const overlay = showInfoModal({
        title: '回收站',
        subtitle: `回收站目录：${TRASH_ROOT}/。恢复也会等待页面重建后刷新。`,
        className: 'dpr-storage-trash-modal-overlay',
        headActions: '<button class="arxiv-tool-btn dpr-storage-danger-btn" type="button" data-storage-trash-action="empty-all">清空回收站</button>',
        body: renderTrash(),
        bind: bindTrashModal,
      });
      syncTrashIndeterminate(overlay);
    } catch (err) {
      progress.setError(`扫描回收站失败：${err && err.message ? err.message : err}`);
    }
  };

  const refreshTrashModalBody = (overlay) => {
    const body = overlay && overlay.querySelector('.dpr-storage-modal-body');
    if (!body) return;
    body.innerHTML = renderTrash();
    syncTrashIndeterminate(overlay);
  };

  const bindTrashModal = (overlay) => {
    overlay.addEventListener('click', async (event) => {
      const toggleBtn = event.target && event.target.closest ? event.target.closest('[data-storage-trash-toggle]') : null;
      if (toggleBtn) {
        const id = toggleBtn.getAttribute('data-storage-trash-toggle') || '';
        if (state.trashExpandedIds.has(id)) state.trashExpandedIds.delete(id);
        else state.trashExpandedIds.add(id);
        refreshTrashModalBody(overlay);
        return;
      }
      const actionBtn = event.target && event.target.closest ? event.target.closest('[data-storage-trash-action]') : null;
      if (!actionBtn) return;
      const action = actionBtn.getAttribute('data-storage-trash-action');
      if (action === 'restore-selected') {
        overlay.remove();
        await restoreTrashSelection();
      } else if (action === 'delete-selected') {
        await deleteTrashSelection(overlay);
      } else if (action === 'empty-all') {
        await emptyAllTrash(overlay);
      }
    });
    overlay.addEventListener('change', (event) => {
      const input = event.target && event.target.closest ? event.target.closest('[data-storage-trash-select]') : null;
      if (!input || !state.trashInventory) return;
      const node = findNodeById(state.trashInventory.roots, input.getAttribute('data-storage-trash-select'));
      const ids = flattenLeafIds(node);
      ids.forEach((id) => {
        if (input.checked) state.trashSelectedIds.add(id);
        else state.trashSelectedIds.delete(id);
      });
      refreshTrashModalBody(overlay);
    });
  };

  const deleteSelected = async () => {
    if (!state.inventory) {
      setMessage('想执行删除前，请先点击“扫描运行态文件”。', '#c00');
      return;
    }
    if (!state.plan || !state.plan.leaves.length) {
      setMessage('请先选中要删除的运行态文件。', '#c00');
      return;
    }
    const api = getApi();
    if (!api || typeof api.moveRepoPathsToTrash !== 'function') {
      setMessage('GitHub Token 模块缺少文件夹回收站能力。', '#c00');
      return;
    }
    const plan = state.plan.metadataLoaded
      ? state.plan
      : await enrichDeletePlan(state.plan, api, state.inventory);
    const summary = summarizePlan(plan, state.inventory);
    const ok = await showConfirmPhrase({
      title: '移入回收站',
      message: `该操作会把 ${summary.paperCount} 篇文献、${summary.pathCount} 个路径移动到 ${TRASH_ROOT}/，之后可在回收站恢复或彻底删除。`,
      phrase: DELETE_CONFIRM_PHRASE,
      confirmLabel: '确认移入回收站',
    });
    if (!ok) {
      setMessage('已取消删除。');
      return;
    }
    const progress = showBlockingProgress({
      title: '正在移入回收站',
      message: '正在准备删除计划...',
      tone: 'danger',
    });
    try {
      progress.setMessage('正在读取回收站清单...');
      const manifest = await loadTrashManifest(api);
      const nextManifest = appendPlanToTrashManifest(manifest, plan, 'settings');
      const updates = plan.sidebarChanged
        ? [{ path: 'docs/_sidebar.md', content: plan.nextSidebar }]
        : [];
      updates.push({ path: TRASH_MANIFEST_PATH, content: serializeTrashManifest(nextManifest) });
      progress.setMessage('正在移动文件到回收站...');
      await api.moveRepoPathsToTrash(
        {
          paths: plan.paths,
          updates,
        },
        'chore: move runtime files to trash',
        { requireWorkflow: false },
      );
      progress.setMessage('正在更新当前页面状态...');
      await reloadAfterRuntimeMutation({
        impacted: routeImpactedByPaths(window.location.hash, plan.paths),
        removedHrefs: (plan.leaves || []).map((leaf) => leaf.href),
      });
      state.inventory = null;
      state.selectedIds = new Set();
      state.expandedIds = new Set();
      state.plan = null;
      render();
      setMessage('已将选中运行态文件移入回收站。如需继续删除，请重新扫描运行态文件。', '#080');
      progress.close();
    } catch (err) {
      progress.setError(`删除失败：${err && err.message ? err.message : err}`);
      setMessage(`删除失败：${err && err.message ? err.message : err}`, '#c00');
    }
  };

  const restoreTrashSelection = async () => {
    const api = getApi();
    if (!state.trashInventory) return;
    if (!api || typeof api.restoreRepoPathsFromTrash !== 'function') {
      setMessage('GitHub Token 模块缺少恢复能力。', '#c00');
      return;
    }
    const plan = buildTrashActionPlan(state.trashInventory, state.trashSelectedIds);
    if (!plan.leaves.length) {
      setMessage('请先选中要恢复的回收站条目。', '#c00');
      return;
    }
    const summary = summarizeTrashPlan(plan, state.trashInventory);
    const ok = await showConfirmPhrase({
      title: '恢复运行态',
      message: `将恢复 ${summary.paperCount} 篇文献、${summary.pathCount} 个路径，完成后会刷新回收站清单。`,
      phrase: RESTORE_CONFIRM_PHRASE,
      confirmLabel: '确认恢复',
      tone: 'restore',
    });
    if (!ok) {
      setMessage('已取消恢复。');
      return;
    }
    const progress = showBlockingProgress({
      title: '正在恢复运行态',
      message: '正在准备恢复计划...',
      tone: 'restore',
    });
    try {
      progress.setMessage('正在更新回收站清单和侧边栏...');
      const nextManifest = removeTrashPlanFromManifest(state.trashInventory.manifest, plan);
      let sidebar = '';
      try {
        const sidebarFile = await api.loadRepoTextFile('docs/_sidebar.md', { requireWorkflow: false });
        sidebar = sidebarFile.content || '';
      } catch {
        sidebar = '';
      }
      const nextSidebar = mergeSidebarContextLines(sidebar, plan.contextGroups);
      const updates = [{ path: TRASH_MANIFEST_PATH, content: serializeTrashManifest(nextManifest) }];
      if (nextSidebar !== sidebar) updates.push({ path: 'docs/_sidebar.md', content: nextSidebar });
      progress.setMessage('正在从回收站移回原路径...');
      await api.restoreRepoPathsFromTrash(
        {
          paths: plan.paths,
          updates,
        },
        'chore: restore runtime files from trash',
        { requireWorkflow: false },
      );
      progress.setMessage('正在重新扫描回收站文件...');
      await refreshTrash({
        progress,
        renderMain: true,
        throwOnError: true,
        message: '正在重新扫描回收站文件...',
      });
      setMessage('回收站选中项已恢复。站点发布可能稍后同步。', '#080');
      progress.close();
    } catch (err) {
      progress.setError(`恢复失败：${err && err.message ? err.message : err}`);
      setMessage(`恢复失败：${err && err.message ? err.message : err}`, '#c00');
    }
  };

  const deleteTrashSelection = async (overlay = null) => {
    const api = getApi();
    if (!state.trashInventory) return;
    if (!api || typeof api.deleteRepoTrashPaths !== 'function') {
      setMessage('GitHub Token 模块缺少彻底删除能力。', '#c00');
      return;
    }
    const plan = buildTrashActionPlan(state.trashInventory, state.trashSelectedIds);
    if (!plan.leaves.length) {
      setMessage('请先选中要彻底删除的回收站条目。', '#c00');
      return;
    }
    const summary = summarizeTrashPlan(plan, state.trashInventory);
    const ok = await showConfirmPhrase({
      title: '彻底删除回收站选中项',
      message: `将从回收站永久删除 ${summary.paperCount} 篇文献、${summary.pathCount} 个路径，该操作不可恢复。`,
      phrase: EMPTY_TRASH_CONFIRM_PHRASE,
      confirmLabel: '确认彻底删除',
    });
    if (!ok) {
      setMessage('已取消清空。');
      return;
    }
    const progress = showBlockingProgress({
      title: '正在删除回收站文件',
      message: '正在准备删除回收站选中项...',
      tone: 'danger',
    });
    try {
      progress.setMessage('正在删除回收站文件...');
      const nextManifest = removeTrashPlanFromManifest(state.trashInventory.manifest, plan);
      await api.deleteRepoTrashPaths(
        {
          paths: plan.paths,
          updates: [{ path: TRASH_MANIFEST_PATH, content: serializeTrashManifest(nextManifest) }],
        },
        'chore: permanently delete trash files',
        { requireWorkflow: false },
      );
      progress.setMessage('正在重新扫描回收站文件...');
      setMessage('已彻底删除回收站选中项。', '#080');
      await refreshTrash({
        progress,
        overlay,
        renderMain: !overlay,
        throwOnError: true,
        message: '正在重新扫描回收站文件...',
      });
      progress.close();
    } catch (err) {
      const errorMessage = `彻底删除失败：${err && err.message ? err.message : err}`;
      progress.setError(errorMessage);
      setMessage(errorMessage, '#c00');
    }
  };

  const emptyAllTrash = async (overlay = null) => {
    if (!state.trashInventory || !state.trashInventory.leaves.length) return;
    const allIds = new Set(state.trashInventory.leaves.map((leaf) => leaf.id));
    const plan = buildTrashActionPlan(state.trashInventory, allIds);
    const summary = summarizeTrashPlan(plan, state.trashInventory);
    const ok = await showConfirmPhrase({
      title: '清空回收站',
      message: `将永久删除回收站中的 ${summary.paperCount} 篇文献、${summary.pathCount} 个路径，该操作不可恢复。`,
      phrase: EMPTY_TRASH_CONFIRM_PHRASE,
      confirmLabel: '确认清空回收站',
    });
    if (!ok) {
      setMessage('已取消清空。');
      return;
    }
    const api = getApi();
    if (!api || typeof api.deleteRepoTrashPaths !== 'function') {
      setMessage('GitHub Token 模块缺少清空回收站能力。', '#c00');
      return;
    }
    const progress = showBlockingProgress({
      title: '正在删除回收站文件',
      message: '正在准备清空回收站...',
      tone: 'danger',
    });
    try {
      progress.setMessage('正在删除回收站文件...');
      const nextManifest = removeTrashPlanFromManifest(state.trashInventory.manifest, plan);
      await api.deleteRepoTrashPaths(
        {
          paths: plan.paths,
          updates: [{ path: TRASH_MANIFEST_PATH, content: serializeTrashManifest(nextManifest) }],
        },
        'chore: empty runtime trash',
        { requireWorkflow: false },
      );
      progress.setMessage('正在重新扫描回收站文件...');
      setMessage('回收站已清空。', '#080');
      await refreshTrash({
        progress,
        overlay,
        renderMain: !overlay,
        throwOnError: true,
        message: '正在重新扫描回收站文件...',
      });
      progress.close();
    } catch (err) {
      const errorMessage = `清空回收站失败：${err && err.message ? err.message : err}`;
      progress.setError(errorMessage);
      setMessage(errorMessage, '#c00');
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
      return;
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
    // Keep opening the storage page cheap; runtime scanning is user-triggered only.
    render();
  };

  return {
    mount,
    refresh,
    refreshIfEmpty,
    openTrashModal,
    __runtime: {
      TRASH_ROOT,
      TRASH_MANIFEST_PATH,
      normalizeHref,
      loadTrashManifest,
      serializeTrashManifest,
      normalizeTrashManifest,
      buildSidebarTrashItem,
      mergeSidebarContextLines,
      showBlockingProgress,
      reloadAfterRuntimeMutation,
      routeImpactedByPaths,
    },
    __test: {
      RECYCLE_BRANCH_PREFIX,
      TRASH_ROOT,
      TRASH_MANIFEST_PATH,
      DELETE_CONFIRM_PHRASE,
      RESTORE_CONFIRM_PHRASE,
      EMPTY_TRASH_CONFIRM_PHRASE,
      normalizeHref,
      normalizeRepoPath,
      routeFromRepoPath,
      parseFrontMatter,
      parseFiguresMeta,
      createInventory,
      createTrashInventory,
      buildDeletePlan,
      enrichDeletePlan,
      appendPlanToTrashManifest,
      buildSidebarTrashItem,
      buildTrashActionPlan,
      removeTrashPlanFromManifest,
      mergeSidebarContextLines,
      summarizePlan,
      removeSidebarLines,
      pathMatchesRuntime,
      RUNTIME_RESTORE_PREFIXES,
    },
  };
})();
