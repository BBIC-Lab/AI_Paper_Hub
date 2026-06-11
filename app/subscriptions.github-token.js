// GitHub Token 订阅配置模块
// 负责：本地存储 Token、验证权限、更新按钮与信息区状态

window.SubscriptionsGithubToken = (function () {
  // 从本地存储加载 GitHub Token 数据
  const loadGithubToken = () => {
    try {
      const tokenData = localStorage.getItem('github_token_data');
      if (tokenData) {
        const data = JSON.parse(tokenData);
        return data;
      }
    } catch (e) {
      console.error('Failed to load GitHub token:', e);
    }
    return null;
  };

  // 保存 GitHub Token 数据到本地存储
  const saveGithubToken = (data) => {
    try {
      localStorage.setItem('github_token_data', JSON.stringify(data));
    } catch (e) {
      console.error('Failed to save GitHub token:', e);
    }
  };

  // 清除 GitHub Token 数据
  const clearGithubToken = () => {
    try {
      localStorage.removeItem('github_token_data');
    } catch (e) {
      console.error('Failed to clear GitHub token:', e);
    }
  };

  const readConfigYamlForRepo = async () => {
    const yaml = window.jsyaml || window.jsYaml || window.jsYAML;
    if (!yaml || typeof yaml.load !== 'function') {
      return null;
    }
    const candidates = ['config.yaml', 'docs/config.yaml', '../config.yaml', '/config.yaml'];
    for (const url of candidates) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) continue;
        const text = await res.text();
        const cfg = yaml.load(text || '') || {};
        const githubCfg = (cfg && cfg.github) || {};
        if (githubCfg && typeof githubCfg === 'object') {
          const owner = String(githubCfg.owner || '').trim();
          const repo = String(githubCfg.repo || '').trim();
          if (owner || repo) {
            return { owner, repo };
          }
        }
      } catch {
        // ignore
      }
    }
    return null;
  };

  // 验证 GitHub Token 并检查权限
  const verifyGithubToken = async (token, options = {}) => {
    const { requireWorkflow = true } = options;
    try {
      // 1. 获取用户信息
      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (!userRes.ok) {
        throw new Error('Token 无效或已过期');
      }

      const userData = await userRes.json();

      // 2. 检查权限 - 通过响应头的 X-OAuth-Scopes
      const scopes = userRes.headers.get('X-OAuth-Scopes');
      const scopeList = scopes ? scopes.split(',').map((s) => s.trim()) : [];

      const requiredScopes = requireWorkflow ? ['repo', 'workflow', 'gist'] : ['repo', 'gist'];
      const missingScopes = requiredScopes.filter(
        (scope) => !scopeList.includes(scope),
      );

      if (missingScopes.length > 0) {
        // 权限不足时直接返回失败结果，并带上现有权限列表，供 UI 做更友好的展示
        return {
          valid: false,
          error: `Token 权限不足：缺少 ${missingScopes.join(
            ', ',
          )}。请使用 Classic Personal Access Token，并补充所示权限。`,
          scopes: scopeList,
          login: userData.login,
        };
      }

      // 3. 获取当前页面的仓库信息
      // 规则：
      // - 若运行在 localhost（含 127.0.0.1），默认仓库名为 AI_Daily_Paper_Reader，owner 为当前登录用户
      // - 若运行在 username.github.io/repo-name，则从 URL 解析 owner/repo
      // - 其它域名：尝试从当前站点 config.yaml 中读取 github 信息
      const currentUrl = window.location.href;
      const urlObj = new URL(currentUrl);
      const host = urlObj.hostname || '';

      let repoOwner = '';
      let repoName = '';

      // 情况 A：本地开发（localhost 或 127.0.0.1）
      if (host === 'localhost' || host === '127.0.0.1') {
        repoOwner = userData.login || '';
        repoName = 'AI_Daily_Paper_Reader';
      } else {
        // 情况 B：GitHub Pages
        const githubPagesMatch = currentUrl.match(
          /https?:\/\/([^.]+)\.github\.io\/([^\/]+)/,
        );
        if (githubPagesMatch) {
          repoOwner = githubPagesMatch[1];
          repoName = githubPagesMatch[2];
        } else {
          const parsedRepo = await readConfigYamlForRepo();
          if (parsedRepo) {
            repoOwner = parsedRepo.owner || repoOwner;
            repoName = parsedRepo.repo || repoName;
          }
          // 情况 C：其它域名，尝试从当前站点的 config.yaml 中读取 github 信息
          // 若 config.yaml 未提供 owner，则至少使用当前用户作为 owner
          if (!repoOwner) {
            repoOwner = userData.login || '';
          }
        }
      }

      // 4. 如果有仓库信息，验证 Token 是否有权限访问该仓库
      if (repoOwner && repoName) {
        const repoRes = await fetch(
          `https://api.github.com/repos/${repoOwner}/${repoName}`,
          {
            headers: {
              Authorization: `token ${token}`,
              Accept: 'application/vnd.github.v3+json',
            },
          },
        );

        if (!repoRes.ok) {
          throw new Error(
            `无法访问仓库 ${repoOwner}/${repoName}，请确认 Token 权限`,
          );
        }

        const repoData = await repoRes.json();

        if (!repoData.permissions || !repoData.permissions.push) {
          throw new Error(
            `没有仓库 ${repoOwner}/${repoName} 的写入权限`,
          );
        }
      }

      return {
        valid: true,
        login: userData.login,
        name: userData.name,
        repo:
          repoOwner && repoName
            ? `${repoOwner}/${repoName}`
            : '未检测到仓库',
        scopes: scopeList,
      };
    } catch (error) {
      return {
        valid: false,
        error: error.message,
      };
    }
  };

  // 优先从密钥配置（secret.private 解密后的 decoded_secret_private）中获取 GitHub Token；
  // 若不存在，则回退到旧的本地存储 Token。
  const getTokenForConfig = () => {
    const secret = window.decoded_secret_private || {};
    if (secret.github && secret.github.token) {
      return String(secret.github.token || '').trim();
    }
    const tokenData = loadGithubToken();
    if (tokenData && tokenData.token) {
      return String(tokenData.token || '').trim();
    }
    return null;
  };

  // 基于 Token 推断仓库 owner/name（复用 verifyGithubToken 的逻辑）
  const resolveRepoInfoFromToken = async (token, requireWorkflow = true) => {
    const result = await verifyGithubToken(token, { requireWorkflow });
    if (!result.valid) {
      throw new Error(
        `GitHub Token 验证失败：${result.error || '原因未知'}`,
      );
    }
    if (!result.repo || !result.repo.includes('/')) {
      throw new Error('无法从 GitHub Token 推断有效的仓库信息');
    }
    const parts = result.repo.split('/');
    const owner = parts[0];
    const repo = parts[1];
    return { owner, repo, token };
  };

  const encodeRepoPath = (path) => String(path || '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');

  const normalizeRepoPath = (path) => String(path || '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
    .trim();

  const uniq = (items) => {
    const out = [];
    const seen = new Set();
    (items || []).forEach((item) => {
      const value = normalizeRepoPath(item);
      if (!value || seen.has(value)) return;
      seen.add(value);
      out.push(value);
    });
    return out;
  };

  const decodeBase64Utf8 = (rawBase64) => {
    const binary = atob(String(rawBase64 || '').replace(/\n/g, ''));
    if (window.TextDecoder) {
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new TextDecoder('utf-8').decode(bytes);
    }
    // eslint-disable-next-line no-escape
    return decodeURIComponent(escape(binary));
  };

  const encodeUtf8Base64 = (text) => btoa(unescape(encodeURIComponent(String(text || ''))));

  const fetchGitHubJson = async (url, token, options = {}) => {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        ...(options.headers || {}),
      },
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text || null;
    }
    if (!res.ok) {
      const detail = typeof data === 'string' ? data : (data && data.message) || text;
      throw new Error(`GitHub API 请求失败：HTTP ${res.status} ${res.statusText}${detail ? ` - ${detail}` : ''}`);
    }
    return data;
  };

  const ensureSodiumReady = async () => {
    if (
      window.sodium &&
      window.sodium.ready &&
      typeof window.sodium.ready.then === 'function'
    ) {
      await window.sodium.ready;
    }
    if (!window.sodium) {
      throw new Error('浏览器缺少 libsodium，无法写入 GitHub Secrets。');
    }
    return window.sodium;
  };

  const loadRepoTextFile = async (path, options = {}) => {
    const token = getTokenForConfig();
    if (!token) {
      throw new Error('未配置有效的 GitHub Token，请先完成首页的新配置指引。');
    }
    const info = await resolveRepoInfoFromToken(token, options.requireWorkflow !== false);
    const refQuery = options.ref || options.branch
      ? `?ref=${encodeURIComponent(options.ref || options.branch)}`
      : '';
    const res = await fetch(
      `https://api.github.com/repos/${info.owner}/${info.repo}/contents/${encodeRepoPath(path)}${refQuery}`,
      {
        headers: {
          Authorization: `token ${info.token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`无法读取 ${path}：HTTP ${res.status} ${res.statusText} - ${text}`);
    }
    const data = await res.json();
    return {
      content: decodeBase64Utf8(data.content || ''),
      sha: data.sha,
      owner: info.owner,
      repo: info.repo,
      token: info.token,
    };
  };

  const getRepoContext = async (options = {}) => {
    const token = getTokenForConfig();
    if (!token) {
      throw new Error('未配置有效的 GitHub Token，请先完成首页的新配置指引。');
    }
    const info = await resolveRepoInfoFromToken(token, options.requireWorkflow !== false);
    const repoApi = `https://api.github.com/repos/${info.owner}/${info.repo}`;
    const repoData = await fetchGitHubJson(repoApi, info.token);
    const branch = String(options.branch || repoData.default_branch || 'main').trim();
    if (!branch) throw new Error('无法确定要写入的 Git 分支。');
    return {
      ...info,
      repoApi,
      defaultBranch: String(repoData.default_branch || 'main').trim() || 'main',
      branch,
      repoData,
    };
  };

  const encodeBranchForGitRef = (branch) =>
    encodeURIComponent(String(branch || '').trim()).replace(/%2F/g, '/');

  const getBranchCommit = async (ctx, branch) => {
    const cleanBranch = String(branch || ctx.branch || ctx.defaultBranch || 'main').trim();
    const encodedBranch = encodeBranchForGitRef(cleanBranch);
    const ref = await fetchGitHubJson(
      `${ctx.repoApi}/git/ref/heads/${encodedBranch}`,
      ctx.token,
    );
    const headSha = ref && ref.object && ref.object.sha;
    if (!headSha) throw new Error(`无法读取 ${cleanBranch} 分支的 HEAD。`);
    const commit = await fetchGitHubJson(`${ctx.repoApi}/git/commits/${headSha}`, ctx.token);
    const treeSha = commit && commit.tree && commit.tree.sha;
    if (!treeSha) throw new Error(`无法读取 ${cleanBranch} 分支的 tree。`);
    return { branch: cleanBranch, headSha, commit, treeSha };
  };

  const listRepoTree = async (options = {}) => {
    const ctx = await getRepoContext(options);
    const head = await getBranchCommit(ctx, options.branch || ctx.branch);
    const treeData = await fetchGitHubJson(
      `${ctx.repoApi}/git/trees/${head.treeSha}?recursive=1`,
      ctx.token,
    );
    return {
      owner: ctx.owner,
      repo: ctx.repo,
      branch: head.branch,
      headSha: head.headSha,
      treeSha: head.treeSha,
      files: ((treeData && treeData.tree) || []).map((item) => ({
        path: normalizeRepoPath(item && item.path),
        type: item && item.type,
        sha: item && item.sha,
        size: Number((item && item.size) || 0),
        mode: item && item.mode,
      })),
    };
  };

  const createRecycleBranch = async (branchName, options = {}) => {
    const ctx = await getRepoContext(options);
    const source = await getBranchCommit(ctx, options.fromBranch || ctx.branch);
    const cleanBranch = String(branchName || '').trim();
    if (!cleanBranch) throw new Error('缺少回收站分支名。');
    return fetchGitHubJson(`${ctx.repoApi}/git/refs`, ctx.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: `refs/heads/${cleanBranch}`,
        sha: source.headSha,
      }),
    });
  };

  const listRecycleBranches = async (prefix = 'recycle/adpr-storage-', options = {}) => {
    const ctx = await getRepoContext(options);
    const cleanPrefix = String(prefix || '').replace(/^refs\/heads\//, '');
    const refs = await fetchGitHubJson(
      `${ctx.repoApi}/git/matching-refs/heads/${encodeBranchForGitRef(cleanPrefix)}`,
      ctx.token,
    );
    return (Array.isArray(refs) ? refs : [])
      .map((ref) => {
        const name = String((ref && ref.ref) || '').replace(/^refs\/heads\//, '');
        return {
          name,
          sha: ref && ref.object && ref.object.sha,
          ref: ref && ref.ref,
        };
      })
      .filter((item) => item.name && item.name.startsWith(cleanPrefix))
      .sort((a, b) => String(b.name).localeCompare(String(a.name)));
  };

  const deleteBranch = async (branchName, options = {}) => {
    const ctx = await getRepoContext(options);
    const cleanBranch = String(branchName || '').trim();
    if (!cleanBranch) throw new Error('缺少要删除的分支名。');
    return fetchGitHubJson(
      `${ctx.repoApi}/git/refs/heads/${encodeBranchForGitRef(cleanBranch)}`,
      ctx.token,
      { method: 'DELETE' },
    );
  };

  const runtimePathMatches = (path, matchers) => {
    const clean = normalizeRepoPath(path);
    const list = Array.isArray(matchers) && matchers.length
      ? matchers
      : [
        'docs/_sidebar.md',
        'docs/assets/figures/',
        'docs/assets/local_pdfs/',
        'docs/local-pdf/',
        /^docs\/\d{6}\//,
        /^docs\/\d{8}-\d{8}\//,
      ];
    return list.some((matcher) => {
      if (matcher instanceof RegExp) return matcher.test(clean);
      if (String(matcher).endsWith('/')) return clean.startsWith(String(matcher));
      return clean === String(matcher);
    });
  };

  const restoreRuntimeFromBranch = async (sourceBranch, options = {}) => {
    const ctx = await getRepoContext(options);
    const target = await getBranchCommit(ctx, options.branch || ctx.branch);
    const source = await getBranchCommit(ctx, sourceBranch);
    const sourceTree = await fetchGitHubJson(
      `${ctx.repoApi}/git/trees/${source.treeSha}?recursive=1`,
      ctx.token,
    );
    const targetTree = await fetchGitHubJson(
      `${ctx.repoApi}/git/trees/${target.treeSha}?recursive=1`,
      ctx.token,
    );
    const targetFiles = new Map(
      ((targetTree && targetTree.tree) || [])
        .filter((item) => item && item.type === 'blob' && item.path)
        .map((item) => [normalizeRepoPath(item.path), item.sha]),
    );
    const restoreEntries = ((sourceTree && sourceTree.tree) || [])
      .filter((item) => item && item.type === 'blob' && item.path && item.sha)
      .filter((item) => runtimePathMatches(item.path, options.runtimeMatchers))
      .filter((item) => options.overwrite === true || targetFiles.get(normalizeRepoPath(item.path)) !== item.sha)
      .map((item) => ({
        path: normalizeRepoPath(item.path),
        mode: item.mode || '100644',
        type: 'blob',
        sha: item.sha,
      }));

    if (!restoreEntries.length) {
      return { skipped: true, restored: [], branch: target.branch };
    }

    const newTree = await fetchGitHubJson(`${ctx.repoApi}/git/trees`, ctx.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_tree: target.treeSha,
        tree: restoreEntries,
      }),
    });
    const newCommit = await fetchGitHubJson(`${ctx.repoApi}/git/commits`, ctx.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: options.commitMessage || `chore: restore runtime files from ${sourceBranch}`,
        tree: newTree.sha,
        parents: [target.headSha],
      }),
    });
    await fetchGitHubJson(
      `${ctx.repoApi}/git/refs/heads/${encodeBranchForGitRef(target.branch)}`,
      ctx.token,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sha: newCommit.sha,
          force: false,
        }),
      },
    );
    return {
      branch: target.branch,
      commit: newCommit,
      restored: restoreEntries.map((item) => item.path),
    };
  };

  const saveRepoTextFile = async (path, content, commitMessage, options = {}) => {
    const token = getTokenForConfig();
    if (!token) {
      throw new Error('未配置有效的 GitHub Token，请先完成首页的新配置指引。');
    }
    const info = await resolveRepoInfoFromToken(token, options.requireWorkflow !== false);
    let sha = options.sha || '';
    if (!sha) {
      try {
        const current = await loadRepoTextFile(path, options);
        sha = current.sha || '';
      } catch (e) {
        if (!String(e.message || '').includes('HTTP 404')) {
          throw e;
        }
      }
    }
    const body = {
      message: commitMessage || `chore: update ${path}`,
      content: encodeUtf8Base64(content),
    };
    if (sha) {
      body.sha = sha;
    }
    const res = await fetch(
      `https://api.github.com/repos/${info.owner}/${info.repo}/contents/${encodeRepoPath(path)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `token ${info.token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`写入 ${path} 失败：HTTP ${res.status} ${res.statusText} - ${text}`);
    }
    return res.json();
  };

  const updateRepoTextFile = async (path, updater, commitMessage, options = {}) => {
    const current = await loadRepoTextFile(path, options);
    const nextContent = typeof updater === 'function'
      ? updater(current.content, current)
      : current.content;
    if (nextContent === current.content) {
      return { skipped: true, sha: current.sha };
    }
    return saveRepoTextFile(path, nextContent, commitMessage, {
      ...options,
      sha: current.sha,
    });
  };

  const commitRepoChanges = async (changes = {}, commitMessage = '', options = {}) => {
    const token = getTokenForConfig();
    if (!token) {
      throw new Error('未配置有效的 GitHub Token，请先完成首页的新配置指引。');
    }
    const info = await resolveRepoInfoFromToken(token, options.requireWorkflow !== false);
    const repoApi = `https://api.github.com/repos/${info.owner}/${info.repo}`;
    const repoData = await fetchGitHubJson(repoApi, info.token);
    const branch = String(options.branch || repoData.default_branch || 'main').trim();
    if (!branch) throw new Error('无法确定要写入的 Git 分支。');
    const encodedBranch = encodeURIComponent(branch).replace(/%2F/g, '/');

    const ref = await fetchGitHubJson(
      `${repoApi}/git/ref/heads/${encodedBranch}`,
      info.token,
    );
    const headSha = ref && ref.object && ref.object.sha;
    if (!headSha) throw new Error(`无法读取 ${branch} 分支的 HEAD。`);
    const headCommit = await fetchGitHubJson(
      `${repoApi}/git/commits/${headSha}`,
      info.token,
    );
    const baseTreeSha = headCommit && headCommit.tree && headCommit.tree.sha;
    if (!baseTreeSha) throw new Error('无法读取当前仓库 tree。');

    const treeData = await fetchGitHubJson(
      `${repoApi}/git/trees/${baseTreeSha}?recursive=1`,
      info.token,
    );
    const existingFiles = new Set(
      ((treeData && treeData.tree) || [])
        .filter((item) => item && item.type === 'blob' && item.path)
        .map((item) => normalizeRepoPath(item.path)),
    );

    const updates = Array.isArray(changes.updates) ? changes.updates : [];
    const deleteInputs = uniq(changes.deletes || []);
    const updatePaths = new Set(updates.map((item) => normalizeRepoPath(item && item.path)).filter(Boolean));
    const deletes = new Set();
    deleteInputs.forEach((path) => {
      const isDirHint = /\/$/.test(String(path || ''));
      const clean = normalizeRepoPath(path).replace(/\/+$/, '');
      if (!clean) return;
      if (!isDirHint && existingFiles.has(clean)) {
        deletes.add(clean);
        return;
      }
      const prefix = `${clean}/`;
      existingFiles.forEach((filePath) => {
        if (filePath.startsWith(prefix)) deletes.add(filePath);
      });
    });
    updatePaths.forEach((path) => deletes.delete(path));

    const tree = [];
    for (const item of updates) {
      const path = normalizeRepoPath(item && item.path);
      if (!path) continue;
      const blob = await fetchGitHubJson(`${repoApi}/git/blobs`, info.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: String((item && item.content) || ''),
          encoding: 'utf-8',
        }),
      });
      tree.push({
        path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      });
    }
    deletes.forEach((path) => {
      tree.push({
        path,
        mode: '100644',
        type: 'blob',
        sha: null,
      });
    });

    if (!tree.length) {
      return { skipped: true, branch, deleted: [], updated: [] };
    }

    const newTree = await fetchGitHubJson(`${repoApi}/git/trees`, info.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree,
      }),
    });
    const newCommit = await fetchGitHubJson(`${repoApi}/git/commits`, info.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: commitMessage || 'chore: update repository files',
        tree: newTree.sha,
        parents: [headSha],
      }),
    });
    await fetchGitHubJson(`${repoApi}/git/refs/heads/${encodedBranch}`, info.token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sha: newCommit.sha,
        force: false,
      }),
    });
    return {
      branch,
      commit: newCommit,
      deleted: Array.from(deletes),
      updated: Array.from(updatePaths),
    };
  };

  const expandTreePaths = (treeItems, inputs = [], prefix = '') => {
    const files = (treeItems || [])
      .filter((item) => item && item.type === 'blob' && item.path)
      .map((item) => ({
        ...item,
        path: normalizeRepoPath(item.path),
      }));
    const byPath = new Map(files.map((item) => [item.path, item]));
    const out = new Map();
    uniq(inputs).forEach((input) => {
      const cleanInput = normalizeRepoPath(input).replace(/\/+$/, '');
      if (!cleanInput) return;
      const clean = prefix ? normalizeRepoPath(`${prefix}/${cleanInput}`) : cleanInput;
      const isDirHint = /\/$/.test(String(input || '')) || !byPath.has(clean);
      if (!isDirHint && byPath.has(clean)) {
        out.set(clean, byPath.get(clean));
        return;
      }
      const dirPrefix = `${clean}/`;
      files.forEach((item) => {
        if (item.path.startsWith(dirPrefix)) out.set(item.path, item);
      });
    });
    return Array.from(out.values());
  };

  const commitTreeEntries = async ({ ctx, target, entries, commitMessage }) => {
    if (!entries.length) {
      return { skipped: true, branch: target.branch, moved: [], restored: [], deleted: [], updated: [] };
    }
    const newTree = await fetchGitHubJson(`${ctx.repoApi}/git/trees`, ctx.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_tree: target.treeSha,
        tree: entries,
      }),
    });
    const newCommit = await fetchGitHubJson(`${ctx.repoApi}/git/commits`, ctx.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: commitMessage || 'chore: update repository files',
        tree: newTree.sha,
        parents: [target.headSha],
      }),
    });
    await fetchGitHubJson(
      `${ctx.repoApi}/git/refs/heads/${encodeBranchForGitRef(target.branch)}`,
      ctx.token,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sha: newCommit.sha,
          force: false,
        }),
      },
    );
    return { branch: target.branch, commit: newCommit };
  };

  const blobEntriesForUpdates = async (ctx, updates = []) => {
    const entries = [];
    for (const item of updates || []) {
      const path = normalizeRepoPath(item && item.path);
      if (!path) continue;
      const blob = await fetchGitHubJson(`${ctx.repoApi}/git/blobs`, ctx.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: String((item && item.content) || ''),
          encoding: 'utf-8',
        }),
      });
      entries.push({
        path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      });
    }
    return entries;
  };

  const moveRepoPathsToTrash = async (changes = {}, commitMessage = '', options = {}) => {
    const ctx = await getRepoContext(options);
    const target = await getBranchCommit(ctx, options.branch || ctx.branch);
    const treeData = await fetchGitHubJson(
      `${ctx.repoApi}/git/trees/${target.treeSha}?recursive=1`,
      ctx.token,
    );
    const treeItems = (treeData && treeData.tree) || [];
    const filesByPath = new Map(
      treeItems
        .filter((item) => item && item.type === 'blob' && item.path)
        .map((item) => [normalizeRepoPath(item.path), item]),
    );
    const sourceFiles = expandTreePaths(treeItems, changes.paths || [])
      .filter((item) => !normalizeRepoPath(item.path).startsWith('trash/'))
      .filter((item) => normalizeRepoPath(item.path) !== 'docs/_sidebar.md');
    const entries = await blobEntriesForUpdates(ctx, changes.updates || []);
    const updatePaths = new Set(entries.map((item) => item.path));
    const moved = [];
    sourceFiles.forEach((item) => {
      const sourcePath = normalizeRepoPath(item.path);
      const targetPath = normalizeRepoPath(`trash/${sourcePath}`);
      if (filesByPath.has(targetPath) && !updatePaths.has(targetPath)) {
        throw new Error(`回收站已存在同名文件：${targetPath}`);
      }
      entries.push({
        path: targetPath,
        mode: item.mode || '100644',
        type: 'blob',
        sha: item.sha,
      });
      entries.push({
        path: sourcePath,
        mode: item.mode || '100644',
        type: 'blob',
        sha: null,
      });
      moved.push(sourcePath);
    });
    const result = await commitTreeEntries({
      ctx,
      target,
      entries,
      commitMessage: commitMessage || 'chore: move runtime files to trash',
    });
    return {
      ...result,
      moved,
      updated: Array.from(updatePaths),
    };
  };

  const restoreRepoPathsFromTrash = async (changes = {}, commitMessage = '', options = {}) => {
    const ctx = await getRepoContext(options);
    const target = await getBranchCommit(ctx, options.branch || ctx.branch);
    const treeData = await fetchGitHubJson(
      `${ctx.repoApi}/git/trees/${target.treeSha}?recursive=1`,
      ctx.token,
    );
    const treeItems = (treeData && treeData.tree) || [];
    const filesByPath = new Map(
      treeItems
        .filter((item) => item && item.type === 'blob' && item.path)
        .map((item) => [normalizeRepoPath(item.path), item]),
    );
    const trashFiles = expandTreePaths(treeItems, changes.paths || [], 'trash');
    const entries = await blobEntriesForUpdates(ctx, changes.updates || []);
    const updatePaths = new Set(entries.map((item) => item.path));
    const restored = [];
    trashFiles.forEach((item) => {
      const trashPath = normalizeRepoPath(item.path);
      const sourcePath = trashPath.replace(/^trash\//, '');
      if (filesByPath.has(sourcePath) && !updatePaths.has(sourcePath)) {
        throw new Error(`恢复目标已存在：${sourcePath}`);
      }
      entries.push({
        path: sourcePath,
        mode: item.mode || '100644',
        type: 'blob',
        sha: item.sha,
      });
      entries.push({
        path: trashPath,
        mode: item.mode || '100644',
        type: 'blob',
        sha: null,
      });
      restored.push(sourcePath);
    });
    const result = await commitTreeEntries({
      ctx,
      target,
      entries,
      commitMessage: commitMessage || 'chore: restore runtime files from trash',
    });
    return {
      ...result,
      restored,
      updated: Array.from(updatePaths),
    };
  };

  const deleteRepoTrashPaths = async (changes = {}, commitMessage = '', options = {}) => {
    const ctx = await getRepoContext(options);
    const target = await getBranchCommit(ctx, options.branch || ctx.branch);
    const treeData = await fetchGitHubJson(
      `${ctx.repoApi}/git/trees/${target.treeSha}?recursive=1`,
      ctx.token,
    );
    const treeItems = (treeData && treeData.tree) || [];
    const trashFiles = expandTreePaths(treeItems, changes.paths || [], 'trash');
    const entries = await blobEntriesForUpdates(ctx, changes.updates || []);
    const deleted = [];
    trashFiles.forEach((item) => {
      const trashPath = normalizeRepoPath(item.path);
      entries.push({
        path: trashPath,
        mode: item.mode || '100644',
        type: 'blob',
        sha: null,
      });
      deleted.push(trashPath);
    });
    const result = await commitTreeEntries({
      ctx,
      target,
      entries,
      commitMessage: commitMessage || 'chore: delete runtime trash files',
    });
    return {
      ...result,
      deleted,
      updated: entries.filter((item) => item.sha).map((item) => item.path),
    };
  };

  const waitForPagesBuild = async (_startedAt, options = {}) => {
    const fallbackMs = Number(options.fallbackMs || 2500);
    const startedAt = new Date(_startedAt || Date.now()).getTime();
    const ctx = await getRepoContext(options);
    const timeoutMs = Number(options.timeoutMs || 90000);
    const pollMs = Number(options.pollMs || 5000);
    const deadline = Date.now() + timeoutMs;
    const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
    try {
      while (Date.now() < deadline) {
        const build = await fetchGitHubJson(`${ctx.repoApi}/pages/builds/latest`, ctx.token);
        const status = String((build && build.status) || '').toLowerCase();
        const updated = new Date((build && (build.updated_at || build.created_at)) || 0).getTime();
        if (status === 'built' && (!Number.isFinite(startedAt) || updated >= startedAt - 5000)) {
          return { status: 'built', build };
        }
        if (status === 'errored' || status === 'error') {
          throw new Error('GitHub Pages 重建失败。');
        }
        await sleep(pollMs);
      }
      return { timeout: true };
    } catch (err) {
      const msg = String((err && err.message) || err || '');
      if (msg.includes('HTTP 404') || msg.includes('HTTP 403')) {
        await sleep(fallbackMs);
        return { skipped: true };
      }
      throw err;
    }
  };

  const saveSecrets = async (secretValues, progress) => {
    const token = getTokenForConfig();
    if (!token) {
      throw new Error('未配置有效的 GitHub Token，请先完成首页的新配置指引。');
    }
    const info = await resolveRepoInfoFromToken(token, true);
    const sodium = await ensureSodiumReady();
    const pkRes = await fetch(
      `https://api.github.com/repos/${info.owner}/${info.repo}/actions/secrets/public-key`,
      {
        headers: {
          Authorization: `token ${info.token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      },
    );
    if (!pkRes.ok) {
      throw new Error(`获取仓库 Public Key 失败（HTTP ${pkRes.status}），请确认 Token 权限。`);
    }
    const pkData = await pkRes.json();
    const publicKey = pkData.key;
    const keyId = pkData.key_id;
    if (!publicKey || !keyId) {
      throw new Error('Public Key 数据不完整，无法写入 Secrets。');
    }

    const binkey = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
    const encryptValue = (value) => {
      const binsec = sodium.from_string(String(value == null ? '' : value));
      const encBytes = sodium.crypto_box_seal(binsec, binkey);
      return sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL);
    };
    const entries = Array.isArray(secretValues)
      ? secretValues
      : Object.entries(secretValues || {}).map(([name, value]) => ({ name, value }));

    for (let i = 0; i < entries.length; i += 1) {
      const item = entries[i] || {};
      const name = String(item.name || '').trim();
      if (!name) continue;
      if (typeof progress === 'function') {
        progress(i + 1, entries.length, name);
      }
      const res = await fetch(
        `https://api.github.com/repos/${info.owner}/${info.repo}/actions/secrets/${encodeURIComponent(name)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `token ${info.token}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            encrypted_value: encryptValue(item.value),
            key_id: keyId,
          }),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`写入 GitHub Secret ${name} 失败：HTTP ${res.status} ${res.statusText} - ${text}`);
      }
    }
    return true;
  };

  const saveVariables = async (variableValues, progress) => {
    const token = getTokenForConfig();
    if (!token) {
      throw new Error('未配置有效的 GitHub Token，请先完成首页的新配置指引。');
    }
    const info = await resolveRepoInfoFromToken(token, true);
    const entries = Array.isArray(variableValues)
      ? variableValues
      : Object.entries(variableValues || {}).map(([name, value]) => ({ name, value }));

    for (let i = 0; i < entries.length; i += 1) {
      const item = entries[i] || {};
      const name = String(item.name || '').trim();
      if (!name) continue;
      const value = String(item.value == null ? '' : item.value);
      if (typeof progress === 'function') {
        progress(i + 1, entries.length, name);
      }

      const createRes = await fetch(
        `https://api.github.com/repos/${info.owner}/${info.repo}/actions/variables`,
        {
          method: 'POST',
          headers: {
            Authorization: `token ${info.token}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name, value }),
        },
      );
      if (createRes.ok) {
        continue;
      }
      if (createRes.status !== 409) {
        const text = await createRes.text().catch(() => '');
        throw new Error(`写入 GitHub Variable ${name} 失败：HTTP ${createRes.status} ${createRes.statusText} - ${text}`);
      }

      const updateRes = await fetch(
        `https://api.github.com/repos/${info.owner}/${info.repo}/actions/variables/${encodeURIComponent(name)}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `token ${info.token}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name, value }),
        },
      );
      if (!updateRes.ok) {
        const text = await updateRes.text().catch(() => '');
        throw new Error(`更新 GitHub Variable ${name} 失败：HTTP ${updateRes.status} ${updateRes.statusText} - ${text}`);
      }
    }
    return true;
  };

  // 通过 GitHub API 读取 config.yaml（用于保存时获取最新 sha）
  const loadConfigFromGithub = async () => {
    const token = getTokenForConfig();
    if (!token) {
      throw new Error('未配置有效的 GitHub Token，请先完成首页的新配置指引。');
    }
    const info = await resolveRepoInfoFromToken(token, false);
    const res = await fetch(
      `https://api.github.com/repos/${info.owner}/${info.repo}/contents/config.yaml`,
      {
        headers: {
          Authorization: `token ${info.token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      },
    );
    if (!res.ok) {
      throw new Error('无法读取 config.yaml，请确认文件已存在且 Token 有权限。');
    }
    const data = await res.json();
    const rawBase64 = (data.content || '').replace(/\n/g, '');
    // 使用 UTF-8 解码 base64，避免包含中文时出现乱码
    let content = '';
    try {
      const binary = atob(rawBase64);
      // 兼容旧浏览器：优先使用 TextDecoder，其次使用 escape/decodeURIComponent 方案
      if (window.TextDecoder) {
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        content = new TextDecoder('utf-8').decode(bytes);
      } else {
        // eslint-disable-next-line no-escape
        content = decodeURIComponent(escape(binary));
      }
    } catch (e) {
      console.error('Failed to decode config.yaml content from GitHub:', e);
      content = '';
    }
    const yaml = window.jsyaml || window.jsYaml || window.jsYAML;
    if (!yaml || typeof yaml.load !== 'function') {
      throw new Error('前端缺少 YAML 解析库（js-yaml），无法解析 config.yaml。');
    }
    const cfg = yaml.load(content) || {};
    return { config: cfg, sha: data.sha };
  };

  // 从当前站点相对路径读取 config.yaml（无需 GitHub Token，仅用于前端展示）
  // 注意：GitHub Pages 通常是 https://<user>.github.io/<repo>/，因此不能用绝对路径 /config.yaml（会指向域名根）。
  const loadConfig = async () => {
    try {
      const candidates = [
        'config.yaml',
        'docs/config.yaml',
        '../config.yaml',
      ];

      let lastError = null;
      for (const url of candidates) {
        try {
          const res = await fetch(url, { cache: 'no-store' });
          if (!res.ok) {
            lastError = new Error(`无法读取 ${url}（HTTP ${res.status}）`);
            continue;
          }
          const text = await res.text();
          const yaml = window.jsyaml || window.jsYaml || window.jsYAML;
          if (!yaml || typeof yaml.load !== 'function') {
            throw new Error('前端缺少 YAML 解析库（js-yaml），无法解析 config.yaml。');
          }
          const cfg = yaml.load(text || '') || {};
          return { config: cfg, sha: null, source: url };
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError || new Error('无法读取本地 config.yaml（未知原因）');
    } catch (e) {
      console.error('从站点读取 config.yaml 失败：', e);
      throw e;
    }
  };

  // 更新 config.yaml：接收一个 updater(config) 回调，返回新的 config 对象
  const updateConfig = async (updater, commitMessage = 'chore: update config.yaml from dashboard') => {
    const token = getTokenForConfig();
    if (!token) {
      throw new Error('未配置有效的 GitHub Token，请先完成首页的新配置指引。');
    }
    const info = await resolveRepoInfoFromToken(token, false);
    const { config: current, sha } = await loadConfigFromGithub();
    const next = typeof updater === 'function' ? updater({ ...(current || {}) }) || current : current;
    const yaml = window.jsyaml || window.jsYaml || window.jsYAML;
    if (!yaml || typeof yaml.dump !== 'function') {
      throw new Error('前端缺少 YAML 序列化库（js-yaml），无法写入 config.yaml。');
    }
    const newContent = yaml.dump(next, { lineWidth: 120 });
    const body = {
      message: commitMessage,
      content: btoa(unescape(encodeURIComponent(newContent))),
      sha,
    };
    const res = await fetch(
      `https://api.github.com/repos/${info.owner}/${info.repo}/contents/config.yaml`,
      {
        method: 'PUT',
        headers: {
          Authorization: `token ${info.token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `写入 config.yaml 失败：${res.status} ${res.statusText} - ${text}`,
      );
    }
    return res.json();
  };

  // 使用给定的 config 对象保存到远端 config.yaml（用于“保存”按钮）
  const saveConfig = async (configObject, commitMessage = 'chore: save dashboard config from panel') => {
    const token = getTokenForConfig();
    if (!token) {
      throw new Error('未配置有效的 GitHub Token，请先完成首页的新配置指引。');
    }
    const info = await resolveRepoInfoFromToken(token, false);
    // 仅用于获取当前文件的 sha
    const { sha } = await loadConfigFromGithub();
    const yaml = window.jsyaml || window.jsYaml || window.jsYAML;
    if (!yaml || typeof yaml.dump !== 'function') {
      throw new Error('前端缺少 YAML 序列化库（js-yaml），无法写入 config.yaml。');
    }
    const safeConfig = configObject || {};
    const newContent = yaml.dump(safeConfig, { lineWidth: 120 });
    const body = {
      message: commitMessage,
      content: btoa(unescape(encodeURIComponent(newContent))),
      sha,
    };
    const res = await fetch(
      `https://api.github.com/repos/${info.owner}/${info.repo}/contents/config.yaml`,
      {
        method: 'PUT',
        headers: {
          Authorization: `token ${info.token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `写入 config.yaml 失败：${res.status} ${res.statusText} - ${text}`,
      );
    }
    return res.json();
  };

    const init = (dom) => {
      const {
        githubAuthBtn, // 现在可能为 null，仅用于兼容旧调用
        githubTokenSection,
      githubTokenInput,
      githubTokenToggleBtn,
      githubTokenVerifyBtn,
      githubTokenClearBtn,
      githubTokenMessage,
      githubTokenInfo,
      githubUserName,
      githubRepoName,
    } = dom;

    // 公共：渲染“验证成功”提示信息
    const renderSuccessMessage = (data) => {
      if (!githubTokenMessage) return;
      const scopes = Array.isArray(data.scopes) ? data.scopes : [];
      githubTokenMessage.innerHTML = `
        <div style="color:#28a745; font-size:12px; line-height:1.6;">
          <strong>✅ 验证成功！</strong><br>
          用户: ${data.login || ''}<br>
          仓库: ${data.repo || ''}<br>
          权限: ${scopes.join(', ')}<br>
          Gist 分享: 已开启
        </div>
      `;
    };

    // 更新登录按钮状态（兼容旧逻辑；若没有按钮则直接忽略）
    const updateAuthButtonStatus = () => {
      if (!githubAuthBtn) return;
      const tokenData = loadGithubToken();
      if (tokenData && tokenData.token && tokenData.verified) {
        githubAuthBtn.textContent = '登录成功';
        githubAuthBtn.style.background = '#28a745';
        githubAuthBtn.style.color = 'white';
      } else {
        githubAuthBtn.textContent = '未登录';
        githubAuthBtn.style.background = '#6c757d';
        githubAuthBtn.style.color = 'white';
      }
    };

    // 显示 Token 信息
    const showTokenInfo = (userData) => {
      if (githubTokenInfo && githubUserName && githubRepoName) {
        githubUserName.textContent = userData.login || 'Unknown';
        githubRepoName.textContent = userData.repo || 'Unknown';
        githubTokenInfo.style.display = 'block';
      }
    };

    // 隐藏 Token 信息
    const hideTokenInfo = () => {
      if (githubTokenInfo) {
        githubTokenInfo.style.display = 'none';
      }
    };

    // 登录按钮点击事件 - 旧逻辑（当前已无按钮，这里仅保留兼容）
    if (githubAuthBtn && !githubAuthBtn._bound) {
      githubAuthBtn._bound = true;
      githubAuthBtn.addEventListener('click', () => {
        if (githubTokenSection.style.display === 'none') {
          githubTokenSection.style.display = 'block';

          const tokenData = loadGithubToken();
          if (tokenData && tokenData.verified) {
            if (githubTokenInput) {
              githubTokenInput.value = tokenData.token || '';
            }
            renderSuccessMessage(tokenData);
            showTokenInfo(tokenData);
          }
        } else {
          githubTokenSection.style.display = 'none';
        }
      });
    }

    // Token 可见性切换
    if (githubTokenToggleBtn && !githubTokenToggleBtn._bound) {
      githubTokenToggleBtn._bound = true;
      githubTokenToggleBtn.addEventListener('click', () => {
        if (githubTokenInput.type === 'password') {
          githubTokenInput.type = 'text';
          githubTokenToggleBtn.textContent = '🙈';
        } else {
          githubTokenInput.type = 'password';
          githubTokenToggleBtn.textContent = '👁️';
        }
      });
    }

    // Token 验证并保存
    if (githubTokenVerifyBtn && !githubTokenVerifyBtn._bound) {
      githubTokenVerifyBtn._bound = true;
      githubTokenVerifyBtn.addEventListener('click', async () => {
        const token = githubTokenInput.value.trim();

        if (!token) {
          githubTokenMessage.innerHTML =
            '<span style="color:#dc3545;">❌ 请输入 GitHub Token</span>';
          return;
        }

        githubTokenVerifyBtn.disabled = true;
        githubTokenVerifyBtn.textContent = '验证中...';
        githubTokenMessage.innerHTML =
          '<span style="color:#666;">正在验证 Token...</span>';
        hideTokenInfo();

        const result = await verifyGithubToken(token);

        if (result.valid) {
          const tokenData = {
            token: token,
            verified: true,
            login: result.login,
            name: result.name,
            repo: result.repo,
            scopes: result.scopes,
            savedAt: new Date().toISOString(),
          };

          saveGithubToken(tokenData);

          renderSuccessMessage(tokenData);

          showTokenInfo(tokenData);
          updateAuthButtonStatus();
          githubTokenInput.value = '';
        } else {
          const userText =
            result.login && typeof result.login === 'string'
              ? `用户: ${result.login}<br>`
              : '';
          const scopesText =
            result.scopes && result.scopes.length
              ? `现有权限: ${result.scopes.join(', ')}<br>`
              : '现有权限: （无）<br>';
          const gistHint = '当前配置要求使用 Classic PAT，并同时具备 repo、workflow、gist 权限。<br>';
          githubTokenMessage.innerHTML = `
            <div style="font-size:12px; line-height:1.6;">
              ${userText}${scopesText}${gistHint}
              <span style="color:#dc3545;">❌ ${result.error}</span>
            </div>
          `;
          hideTokenInfo();

          // 验证失败时，如果有顶部按钮，则将其状态改为「验证失败」红色按钮
          if (githubAuthBtn) {
            githubAuthBtn.textContent = '验证失败';
            githubAuthBtn.style.background = '#dc3545';
            githubAuthBtn.style.color = 'white';
          }

          // 同时清除本地已保存的 Token，避免刷新后仍显示“登录成功”
          clearGithubToken();
        }

        githubTokenVerifyBtn.disabled = false;
        githubTokenVerifyBtn.textContent = '验证并保存';
      });
    }

    // Token 清除
    if (githubTokenClearBtn && !githubTokenClearBtn._bound) {
      githubTokenClearBtn._bound = true;
      githubTokenClearBtn.addEventListener('click', () => {
        if (confirm('确定要清除保存的 GitHub Token 吗？')) {
          clearGithubToken();
          githubTokenInput.value = '';
          githubTokenMessage.innerHTML =
            '<span style="color:#666;">Token 已清除</span>';
          hideTokenInfo();
          updateAuthButtonStatus();
        }
      });
    }

    updateAuthButtonStatus();
  };

  return {
    init,
    loadGithubToken,
    loadConfig,
    updateConfig,
    saveConfig,
    getRepoContext,
    listRepoTree,
    createRecycleBranch,
    listRecycleBranches,
    deleteBranch,
    restoreRuntimeFromBranch,
    moveRepoPathsToTrash,
    restoreRepoPathsFromTrash,
    deleteRepoTrashPaths,
    waitForPagesBuild,
    loadRepoTextFile,
    saveRepoTextFile,
    updateRepoTextFile,
    commitRepoChanges,
    saveSecrets,
    saveVariables,
  };
})();
