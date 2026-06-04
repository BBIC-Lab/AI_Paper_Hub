// 全局密钥会话管理：负责首次进入时的密码解锁 / 游客模式
(function () {
  const STORAGE_KEY_MODE = 'dpr_secret_access_mode_v1'; // 已不再使用，仅保留兼容
  const STORAGE_KEY_PASS = 'dpr_secret_password_v1';
  const SECRET_FILE_URL = 'secret.private';
  const SECRET_OVERLAY_ANIMATION_MS = 280;
  const FORCE_GUEST_DOMAIN_TOKEN = 'ziwenhahaha';
  let secretOverlayHideTimer = null;
  const isForceGuestDomain = (host) => {
    const normalized = String(host || '').toLowerCase();
    return normalized.includes(FORCE_GUEST_DOMAIN_TOKEN);
  };
  const FORCE_GUEST_MODE = isForceGuestDomain(window && window.location && window.location.hostname);

  const setAccessMode = (mode, detail) => {
    window.DPR_ACCESS_MODE = mode;
    try {
      const ev = new CustomEvent('dpr-access-mode-changed', {
        detail: detail || { mode },
      });
      document.dispatchEvent(ev);
    } catch {
      // ignore
    }
  };

  const enforceGuestMode = (overlayEl) => {
    setAccessMode('guest', { mode: 'guest', reason: 'domain_force_guest' });
    if (overlayEl) {
      try {
        overlayEl.classList.remove('show');
        overlayEl.classList.add('secret-gate-hidden');
      } catch {
        // ignore
      }
    }
  };

  const openSecretOverlay = (overlayEl) => {
    if (!overlayEl) return;
    if (secretOverlayHideTimer) {
      clearTimeout(secretOverlayHideTimer);
      secretOverlayHideTimer = null;
    }
    overlayEl.classList.remove('secret-gate-hidden');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        overlayEl.classList.add('show');
      });
    });
  };

  const closeSecretOverlay = (overlayEl) => {
    if (!overlayEl) return;
    overlayEl.classList.remove('show');
    if (secretOverlayHideTimer) {
      clearTimeout(secretOverlayHideTimer);
    }
    secretOverlayHideTimer = setTimeout(() => {
      overlayEl.classList.add('secret-gate-hidden');
      secretOverlayHideTimer = null;
    }, SECRET_OVERLAY_ANIMATION_MS);
  };

  // 简单的密码强度校验：至少 8 位，包含数字、小写字母、大写字母和特殊符号
  function validatePassword(pwd) {
    if (!pwd || pwd.length < 8) {
      return '密码至少需要 8 位字符。';
    }
    if (!/[0-9]/.test(pwd)) {
      return '密码必须包含数字。';
    }
    if (!/[a-z]/.test(pwd)) {
      return '密码必须包含小写字母。';
    }
    if (!/[A-Z]/.test(pwd)) {
      return '密码必须包含大写字母。';
    }
    if (!/[^A-Za-z0-9]/.test(pwd)) {
      return '密码必须包含至少一个特殊符号（如 !@# 等）。';
    }
    return '';
  }

  // 旧版模式标记已废弃，仅用于清理兼容
  function loadAccessMode() {
    try {
      if (!window.localStorage) return null;
      return window.localStorage.getItem(STORAGE_KEY_MODE);
    } catch {
      return null;
    }
  }

  function loadSavedPassword() {
    try {
      if (!window.localStorage) return '';
      return window.localStorage.getItem(STORAGE_KEY_PASS) || '';
    } catch {
      return '';
    }
  }

  function savePassword(pwd) {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(STORAGE_KEY_PASS, pwd);
    } catch {
      // ignore
    }
  }

  function clearPassword() {
    try {
      if (!window.localStorage) return;
      window.localStorage.removeItem(STORAGE_KEY_PASS);
    } catch {
      // ignore
    }
  }

  const getLLMUtils = () => window.DPRLLMConfigUtils || {};
  const normalizeText = (value) => {
    const utils = getLLMUtils();
    if (typeof utils.normalizeText === 'function') {
      return utils.normalizeText(value);
    }
    return String(value || '').trim();
  };
  const normalizeBaseUrlForStorage = (value) => {
    const utils = getLLMUtils();
    if (typeof utils.normalizeBaseUrlForStorage === 'function') {
      return utils.normalizeBaseUrlForStorage(value);
    }
    return normalizeText(value).replace(/\/chat\/completions$/i, '').replace(/\/+$/g, '');
  };
  const buildChatCompletionsEndpoint = (value) => {
    const utils = getLLMUtils();
    if (typeof utils.buildChatCompletionsEndpoint === 'function') {
      return utils.buildChatCompletionsEndpoint(value);
    }
    const raw = normalizeText(value).replace(/\/+$/g, '');
    if (!raw) return '';
    if (/\/chat\/completions$/i.test(raw)) return raw;
    if (/\/v\d+$/i.test(raw)) return `${raw}/chat/completions`;
    return `${raw}/v1/chat/completions`;
  };
  const sanitizeModelList = (values, maxCount) => {
    const utils = getLLMUtils();
    if (typeof utils.sanitizeModelList === 'function') {
      return utils.sanitizeModelList(values, maxCount);
    }
    const limit = Math.max(Number(maxCount) || 1, 1);
    const rawList = Array.isArray(values) ? values : [values];
    const out = [];
    const seen = new Set();
    rawList.forEach((value) => {
      String(value || '')
        .split(/[\n,]+/)
        .map((item) => normalizeText(item))
        .filter(Boolean)
        .forEach((name) => {
          const key = name.toLowerCase();
          if (!key || seen.has(key) || out.length >= limit) return;
          seen.add(key);
          out.push(name);
        });
    });
    return out;
  };
  const resolveSummaryLLM = (secret) => {
    const utils = getLLMUtils();
    if (typeof utils.resolveSummaryLLM === 'function') {
      return utils.resolveSummaryLLM(secret);
    }
    const safeSecret = secret && typeof secret === 'object' ? secret : {};
    const summarized = safeSecret.summarizedLLM || {};
    const baseUrl = normalizeBaseUrlForStorage(summarized.baseUrl || '');
    const apiKey = normalizeText(summarized.apiKey || '');
    const model = normalizeText(summarized.model || '');
    if (baseUrl && apiKey && model) {
      return { baseUrl, apiKey, model };
    }
    return null;
  };
  const inferProviderType = (secret) => {
    const utils = getLLMUtils();
    if (typeof utils.inferProviderType === 'function') {
      return utils.inferProviderType(secret);
    }
    return 'openai-compatible';
  };
  const getDefaultWorkflowBaseUrl = () => {
    const utils = getLLMUtils();
    return normalizeBaseUrlForStorage(utils.DEFAULT_OPENAI_COMPATIBLE_BASE_URL || 'https://api.openai.com/v1');
  };
  const getDefaultWorkflowChatModels = () => {
    const utils = getLLMUtils();
    const defaults = Array.isArray(utils.DEFAULT_OPENAI_COMPATIBLE_CHAT_MODELS)
      ? utils.DEFAULT_OPENAI_COMPATIBLE_CHAT_MODELS
      : [
          'gpt-5.4',
          'deepseek-chat',
          'qwen-plus',
          'kimi-k2.5',
        ];
    return sanitizeModelList(defaults, 99);
  };
  const getOpenAICompatiblePreset = (key) => {
    const utils = getLLMUtils();
    if (typeof utils.getOpenAICompatiblePreset === 'function') {
      return utils.getOpenAICompatiblePreset(key);
    }
    return null;
  };
  const buildConnectivityTestPayload = (baseUrl, model) => {
    const utils = getLLMUtils();
    if (typeof utils.buildConnectivityTestPayload === 'function') {
      return utils.buildConnectivityTestPayload({ baseUrl, model });
    }
    return {
      model: normalizeText(model || ''),
      messages: [
        {
          role: 'system',
          content: 'Reply with exactly: hello world',
        },
        {
          role: 'user',
          content: 'hello world',
        },
      ],
      temperature: 0,
      max_tokens: 256,
    };
  };
  const extractChatResponseText = (data) => {
    const normalizeContentPart = (part) => {
      if (typeof part === 'string') return normalizeText(part);
      if (!part || typeof part !== 'object') return '';
      return normalizeText(part.text || part.content || part.output_text || '');
    };

    const firstChoice = (((data || {}).choices || [])[0] || {});
    const message = firstChoice.message || {};
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((part) => normalizeContentPart(part)).filter(Boolean).join('\n');
    }
    if (content && typeof content === 'object') {
      return normalizeContentPart(content);
    }

    const reasoningContent = message.reasoning_content || message.thinking;
    if (typeof reasoningContent === 'string' && reasoningContent.trim()) {
      return reasoningContent;
    }

    const outputText = (data || {}).output_text;
    if (typeof outputText === 'string') return outputText;
    if (Array.isArray(outputText)) {
      return outputText.map((part) => normalizeContentPart(part)).filter(Boolean).join('\n');
    }
    return '';
  };

  async function pingChatModels(modelEntries, statusEl) {
    const entries = Array.isArray(modelEntries) ? modelEntries : [];
    if (!entries.length) {
      throw new Error('请先填写完整的模型配置。');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const results = [];

    try {
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i] || {};
        const model = normalizeText(entry.model || entry.name || '');
        const apiKey = normalizeText(entry.apiKey || '');
        const baseUrl = normalizeBaseUrlForStorage(entry.baseUrl || '');
        const endpoint = buildChatCompletionsEndpoint(baseUrl);

        if (!model || !apiKey || !endpoint) {
          throw new Error('模型配置缺少 apiKey、baseUrl 或 model。');
        }
        if (statusEl) {
          statusEl.textContent = `正在测试模型 ${i + 1}/${entries.length}：${model} ...`;
          statusEl.style.color = '#666';
        }

        const payload = buildConnectivityTestPayload(baseUrl, model);

        const headers = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
        };

        const doFetch = (requestPayload) => fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
        });
        let resp = await doFetch(payload);
        if (!resp.ok && payload.max_completion_tokens != null) {
          const text = await resp.text().catch(() => '');
          if (resp.status === 400 && /max_completion_tokens/i.test(text)) {
            const fallbackPayload = { ...payload };
            delete fallbackPayload.max_completion_tokens;
            resp = await doFetch(fallbackPayload);
          } else {
            resp._dprErrorPreview = text;
          }
        }
        if (!resp.ok) {
          const text = resp._dprErrorPreview || await resp.text().catch(() => '');
          throw new Error(
            `${model} 请求失败：HTTP ${resp.status} ${resp.statusText}${text ? ` - ${text.slice(0, 160)}` : ''}`,
          );
        }
        const data = await resp.json().catch(() => null);
        const text = extractChatResponseText(data);
        if (!normalizeText(text)) {
          throw new Error(`${model} 返回为空，请检查模型兼容性。`);
        }
        results.push(model);
      }
    } finally {
      clearTimeout(timeout);
    }

    return results;
  }

  // 使用 GitHub Token 推断目标仓库 owner/repo（与订阅面板保持一致的推断规则）
  async function detectGithubRepoFromToken(token) {
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    if (!userRes.ok) {
      throw new Error('无法使用当前 GitHub Token 获取用户信息。');
    }
    const userData = await userRes.json();
    const login = userData.login || '';

    const currentUrl = window.location.href;
    const urlObj = new URL(currentUrl);
    const host = urlObj.hostname || '';

    let repoOwner = '';
    let repoName = '';

    if (host === 'localhost' || host === '127.0.0.1') {
      repoOwner = login;
      repoName = 'AI_Daily_Paper_Reader';
    } else {
      const githubPagesMatch = currentUrl.match(
        /https?:\/\/([^.]+)\.github\.io\/([^\/]+)/,
      );
      if (githubPagesMatch) {
        repoOwner = githubPagesMatch[1];
        repoName = githubPagesMatch[2];
      } else {
        // 其它域名：尝试从 config.yaml 中读取
        try {
          const res = await fetch('/config.yaml');
          if (res.ok) {
            const text = await res.text();
            const yaml =
              window.jsyaml || window.jsYaml || window.jsYAML || window.jsYml;
            if (yaml && typeof yaml.load === 'function') {
              const cfg = yaml.load(text) || {};
              const githubCfg = (cfg && cfg.github) || {};
              if (githubCfg && typeof githubCfg === 'object') {
                if (githubCfg.owner) repoOwner = String(githubCfg.owner);
                if (githubCfg.repo) repoName = String(githubCfg.repo);
              }
            }
          }
        } catch {
          // 忽略 config.yaml 读取失败，后续用兜底逻辑
        }

        if (!repoOwner) {
          repoOwner = login;
        }
      }
    }

    if (!repoOwner || !repoName) {
      throw new Error('无法推断目标仓库，请检查当前访问域名或配置。');
    }

    return { owner: repoOwner, repo: repoName };
  }

  // 将总结模型 / workflow 所需的大模型配置写入 GitHub Secrets
  // 可选 progress 回调用于在 UI 中展示上传进度：progress(currentIndex, total, secretName)
  async function saveSummarizeSecretsToGithub(token, options, progress) {
    try {
      // 等待 libsodium-wrappers 就绪（通过 CDN 注入全局 sodium）
      if (!window.sodium || !window.sodium.ready) {
        if (
          window.sodium &&
          typeof window.sodium.ready === 'object' &&
          typeof window.sodium.ready.then === 'function'
        ) {
          await window.sodium.ready;
        } else {
          throw new Error(
            '浏览器未正确加载 libsodium-wrappers，无法写入 GitHub Secrets。',
          );
        }
      }
      const sodium = window.sodium;
      if (!sodium) {
        throw new Error('浏览器缺少 libsodium 支持，无法写入 GitHub Secrets。');
      }

      const { owner, repo } = await detectGithubRepoFromToken(token);

      // 获取仓库 Public Key
      const pkRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
          },
        },
      );
      if (!pkRes.ok) {
        throw new Error(
          `获取仓库 Public Key 失败（HTTP ${pkRes.status}），请确认 Token 是否具备 repo 权限。`,
        );
      }
      const pkData = await pkRes.json();
      const publicKey = pkData.key;
      const keyId = pkData.key_id;
      if (!publicKey || !keyId) {
        throw new Error('Public Key 数据不完整，无法写入 Secrets。');
      }

      const encryptValue = (value) => {
        const binkey = sodium.from_base64(
          publicKey,
          sodium.base64_variants.ORIGINAL,
        );
        const binsec = sodium.from_string(value);
        const encBytes = sodium.crypto_box_seal(binsec, binkey);
        return sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL);
      };

      const safeOptions = options && typeof options === 'object' ? options : {};
      const providerType = normalizeText(safeOptions.providerType || '').toLowerCase() || 'openai-compatible';
      const summarizedApiKey = normalizeText(safeOptions.summarizedApiKey || '');
      const summarizedBaseUrl = normalizeBaseUrlForStorage(safeOptions.summarizedBaseUrl || '');
      const summarizedModel = normalizeText(safeOptions.summarizedModel || safeOptions.summaryModel || '');
      const defaultModel = normalizeText(safeOptions.defaultModel || summarizedModel);
      const summaryModel = normalizeText(safeOptions.summaryModel || summarizedModel || defaultModel);
      const filterModel = normalizeText(safeOptions.filterModel || defaultModel);
      const rewriteModel = normalizeText(safeOptions.rewriteModel || defaultModel);
      const skipRerank = !!safeOptions.skipRerank;
      if (!summarizedApiKey || !summarizedBaseUrl || !defaultModel || !summaryModel || !filterModel || !rewriteModel) {
        throw new Error('总结模型配置不完整，无法写入 GitHub Secrets。');
      }

      const secretNameProvider = 'DPR_LLM_PROVIDER';
      const secretNameApiKey = 'DPR_LLM_API_KEY';
      const secretNameBaseUrl = 'DPR_LLM_BASE_URL';
      const secretNameDefaultModel = 'DPR_LLM_MODEL';
      const secretNameSummaryModel = 'DPR_LLM_SUMMARY_MODEL';
      const secretNameFilterModel = 'DPR_LLM_FILTER_MODEL';
      const secretNameRewriteModel = 'DPR_LLM_REWRITE_MODEL';
      const secretNameSkipRerank = 'DPR_SKIP_RERANK';

      const putSecret = async (name, encrypted) => {
        const body = {
          encrypted_value: encrypted,
          key_id: keyId,
        };
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(
            name,
          )}`,
          {
            method: 'PUT',
            headers: {
              Authorization: `token ${token}`,
              Accept: 'application/vnd.github.v3+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(
            `写入 GitHub Secret ${name} 失败：HTTP ${res.status} ${res.statusText} - ${txt}`,
          );
        }
      };

      const secrets = [
        { name: secretNameProvider, value: providerType || 'openai-compatible' },
        { name: secretNameApiKey, value: summarizedApiKey },
        { name: secretNameBaseUrl, value: summarizedBaseUrl },
        { name: secretNameDefaultModel, value: defaultModel },
        { name: secretNameSummaryModel, value: summaryModel },
        { name: secretNameFilterModel, value: filterModel },
        { name: secretNameRewriteModel, value: rewriteModel },
        { name: secretNameSkipRerank, value: 'true' },
      ];

      for (let i = 0; i < secrets.length; i += 1) {
        const item = secrets[i];
        if (typeof progress === 'function') {
          try {
            progress(i + 1, secrets.length, item.name);
          } catch {
            // 忽略进度回调中的异常
          }
        }
        await putSecret(item.name, encryptValue(item.value));
      }

      return true;
    } catch (e) {
      console.error('[SECRET] 保存 GitHub Secrets 失败：', e);
      return false;
    }
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  }

  // 将生成好的 secret.private 提交到当前 GitHub 仓库根目录
  async function saveSecretPrivateToGithubRepo(token, payload) {
    try {
      const { owner, repo } = await detectGithubRepoFromToken(token);
      const filePath = 'secret.private';

      // 先尝试获取现有文件，拿到 sha（如果不存在则忽略 404）
      let existingSha = null;
      try {
        const getRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
            filePath,
          )}`,
          {
            headers: {
              Authorization: `token ${token}`,
              Accept: 'application/vnd.github.v3+json',
            },
          },
        );
        if (getRes.ok) {
          const info = await getRes.json().catch(() => null);
          if (info && info.sha) {
            existingSha = info.sha;
          }
        } else if (getRes.status !== 404) {
          const txt = await getRes.text().catch(() => '');
          throw new Error(
            `读取远程 secret.private 失败：HTTP ${getRes.status} ${getRes.statusText} - ${txt}`,
          );
        }
      } catch (e) {
        console.error('[SECRET] 预读远程 secret.private 失败：', e);
        throw e;
      }

      const contentJson =
        typeof payload === 'string'
          ? payload
          : JSON.stringify(payload, null, 2);
      const contentB64 = btoa(unescape(encodeURIComponent(contentJson)));
      const body = {
        message: existingSha
          ? 'chore: update secret.private via web setup'
          : 'chore: init secret.private via web setup',
        content: contentB64,
      };
      if (existingSha) {
        body.sha = existingSha;
      }

      const putRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
          filePath,
        )}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      if (!putRes.ok) {
        const txt = await putRes.text().catch(() => '');
        throw new Error(
          `提交 secret.private 到仓库失败：HTTP ${putRes.status} ${putRes.statusText} - ${txt}`,
        );
      }

      return true;
    } catch (e) {
      console.error('[SECRET] 保存 secret.private 到 GitHub 仓库失败：', e);
      return false;
    }
  }

  async function deriveAesGcmKey(password, saltBytes, usages) {
    const enc = new TextEncoder();
    const cryptoObj = (typeof window !== 'undefined' && (window.crypto || window.msCrypto)) || null;
    if (!cryptoObj || !cryptoObj.subtle) {
      throw new Error(
        '当前环境不支持 Web Crypto AES-GCM。请通过 https 或 http://localhost 使用现代浏览器（Chrome/Edge/Firefox）打开本页面后重试。',
      );
    }
    const baseKey = await cryptoObj.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return cryptoObj.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBytes,
        iterations: 120000,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      usages,
    );
  }

  // 约定 secret.private 的结构为：
  // {
  //   "version": 1,
  //   "salt": "<base64>",
  //   "iv": "<base64>",
  //   "ciphertext": "<base64>"
  // }
  // 明文为 JSON 字符串，包含 LLM API Key 等配置信息。
  async function decryptSecret(password, payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('密文格式不正确');
    }
    const saltB64 = payload.salt;
    const ivB64 = payload.iv;
    const cipherB64 = payload.ciphertext;
    if (!saltB64 || !ivB64 || !cipherB64) {
      throw new Error('缺少必须字段（salt/iv/ciphertext）');
    }

    const saltBytes = base64ToBytes(saltB64);
    const ivBytes = base64ToBytes(ivB64);
    const cipherBytes = base64ToBytes(cipherB64);

    const key = await deriveAesGcmKey(password, saltBytes, ['decrypt']);
    const plainBuf = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: ivBytes,
      },
      key,
      cipherBytes,
    );
    const dec = new TextDecoder();
    const text = dec.decode(plainBuf);
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new Error('解密成功但内容不是有效 JSON');
    }
    return obj;
  }

  // 创建新的 secret.private：以明文配置对象 + 密码生成加密文件结构
  async function createEncryptedSecret(password, plainConfig) {
    const enc = new TextEncoder();
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const ivBytes = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveAesGcmKey(password, saltBytes, ['encrypt']);

    const plainText = JSON.stringify(plainConfig || {}, null, 2);
    const cipherBuf = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: ivBytes,
      },
      key,
      enc.encode(plainText),
    );

    const toB64 = (bytes) => {
      let bin = '';
      const view = new Uint8Array(bytes);
      for (let i = 0; i < view.length; i += 1) {
        bin += String.fromCharCode(view[i]);
      }
      return btoa(bin);
    };

    return {
      version: 1,
      salt: toB64(saltBytes),
      iv: toB64(ivBytes),
      ciphertext: toB64(cipherBuf),
    };
  }

  const getGithubTokenForSecretSave = () => {
    const secret = window.decoded_secret_private || {};
    if (secret.github && secret.github.token) {
      return String(secret.github.token || '').trim();
    }
    try {
      if (!window.localStorage) return '';
      const raw = window.localStorage.getItem('github_token_data');
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && parsed.token ? String(parsed.token || '').trim() : '';
    } catch {
      return '';
    }
  };

  const randomBase64 = (size) => {
    const bytes = crypto.getRandomValues(new Uint8Array(size));
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  const normalizeReaderDatabaseConfig = (cfg) => {
    const source = cfg && typeof cfg === 'object' ? cfg : {};
    return {
      enabled: source.enabled !== false,
      path: String(source.path || 'docs/reader-db/state.enc.json').replace(/^\/+/, ''),
      key_b64: String(source.key_b64 || '').trim(),
    };
  };

  async function ensureReaderDatabaseConfig() {
    if (String(window.DPR_ACCESS_MODE || '').toLowerCase() !== 'full') {
      throw new Error('Reader database sync requires full access mode.');
    }
    const secret =
      window.decoded_secret_private && typeof window.decoded_secret_private === 'object'
        ? window.decoded_secret_private
        : null;
    if (!secret) {
      throw new Error('secret.private is not unlocked.');
    }
    const current = normalizeReaderDatabaseConfig(secret.reader_database);
    if (current.enabled === false) return current;
    if (current.key_b64) return current;

    const password = loadSavedPassword();
    if (!password) {
      throw new Error('No saved unlock password is available for reader database setup.');
    }
    const token = getGithubTokenForSecretSave();
    if (!token) {
      throw new Error('No GitHub token is available for saving reader database settings.');
    }

    const next = Object.assign({}, current, {
      enabled: true,
      key_b64: randomBase64(32),
    });
    secret.reader_database = next;
    const encrypted = await createEncryptedSecret(password, secret);
    const ok = await saveSecretPrivateToGithubRepo(token, encrypted);
    if (!ok) {
      secret.reader_database = current;
      throw new Error('Failed to save reader database settings to secret.private.');
    }
    window.decoded_secret_private = secret;
    return next;
  }

  window.DPRSecretSession = Object.assign({}, window.DPRSecretSession || {}, {
    ensureReaderDatabaseConfig,
    getReaderDatabaseConfig() {
      const secret =
        window.decoded_secret_private && typeof window.decoded_secret_private === 'object'
          ? window.decoded_secret_private
          : {};
      return normalizeReaderDatabaseConfig(secret.reader_database);
    },
  });

  // 初始化模式：已有 secret.private -> 解锁 / 游客；无 secret.private -> 首次配置向导
  function setupOverlay(hasSecretFile) {
    const overlay = document.getElementById('secret-gate-overlay');
    const modal = document.getElementById('secret-gate-modal');
    if (!overlay || !modal) {
      return;
    }

    const setMode = (mode) => {
      if (FORCE_GUEST_MODE && mode !== 'guest') {
        enforceGuestMode(overlay);
        return;
      }
      setAccessMode(mode);
    };

    const hide = () => {
      closeSecretOverlay(overlay);
    };
    const setStep2Modal = (enabled) => {
      modal.classList.toggle('secret-gate-modal-step2', !!enabled);
    };

    if (overlay && !overlay._secretBound) {
      overlay._secretBound = true;
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) {
          hide();
        }
      });
    }

    // 已有 secret.private 时的解锁界面渲染逻辑
    const renderUnlockUI = () => {
      setStep2Modal(false);
      modal.innerHTML = `
        <h2 style="margin-top:0;">🔐 解锁密钥</h2>
        <p style="font-size:13px; color:#555; margin-bottom:8px;">
          检测到已存在密钥文件 <code>secret.private</code>。请输入解锁密码，
          或选择以游客身份访问（仅支持阅读论文，无法使用后台大模型能力）。
        </p>
        <label for="secret-gate-password" style="font-size:13px; color:#333; display:block; margin-bottom:4px;">
          解锁密码（至少 8 位，包含数字、小写字母、大写字母和特殊符号）：
        </label>
        <input
          id="secret-gate-password"
          type="password"
          autocomplete="off"
          style="width:100%; box-sizing:border-box; padding:6px 8px; margin-bottom:6px; font-size:13px;"
        />
        <div id="secret-gate-error" style="min-height:18px; font-size:12px; color:#999; margin-bottom:8px;">
          密码仅在本地用于解密，不会上传到服务器。
        </div>
        <div class="secret-gate-actions">
          <button id="secret-gate-guest" type="button" class="secret-gate-btn secondary">
            以游客身份访问
          </button>
          <button id="secret-gate-unlock" type="button" class="secret-gate-btn primary">
            解锁密钥
          </button>
        </div>
      `;

      const pwdInput = document.getElementById('secret-gate-password');
      const errorEl = document.getElementById('secret-gate-error');
      const guestBtn = document.getElementById('secret-gate-guest');
      const unlockBtn = document.getElementById('secret-gate-unlock');

      if (!pwdInput || !guestBtn || !unlockBtn) return;

      // 游客模式：不解密，不加载密钥，仅浏览 & 阅读
      guestBtn.addEventListener('click', () => {
        setMode('guest');
        hide();
      });

      unlockBtn.addEventListener('click', async () => {
        const pwd = (pwdInput.value || '').trim();
        const msg = validatePassword(pwd);
        if (msg) {
          if (errorEl) {
            errorEl.textContent = msg;
            errorEl.style.color = '#c00';
          }
          return;
        }
        if (errorEl) {
          errorEl.textContent = '正在解锁密钥，请稍候...';
          errorEl.style.color = '#666';
        }
        unlockBtn.disabled = true;
        guestBtn.disabled = true;
        try {
          const resp = await fetch(SECRET_FILE_URL, { cache: 'no-store' });
          if (!resp.ok) {
            throw new Error(`获取 secret.private 失败，HTTP ${resp.status}`);
          }
          const payload = await resp.json();
          const secret = await decryptSecret(pwd, payload);
          // 将解密后的配置保存在内存中，不落盘，同时记住密码以便下次自动解锁
          window.decoded_secret_private = secret;
          savePassword(pwd);
          setMode('full');
          hide();
        } catch (e) {
          console.error(e);
          if (errorEl) {
            errorEl.textContent =
              '解锁失败，请检查密码是否正确，或稍后重试。';
            errorEl.style.color = '#c00';
          }
        } finally {
          unlockBtn.disabled = false;
          guestBtn.disabled = false;
        }
      });

      setTimeout(() => {
        try {
          pwdInput.focus();
        } catch {
          // ignore
        }
      }, 100);
    };

    // 初始化向导：第 2 步（OpenAI-compatible Chat Completions）
    const renderInitStep2 = (password) => {
      setStep2Modal(true);
      const currentSecret =
        window.decoded_secret_private && typeof window.decoded_secret_private === 'object'
          ? window.decoded_secret_private
          : {};
      const currentProviderType = inferProviderType(currentSecret);
      const currentSummaryLLM = resolveSummaryLLM(currentSecret) || {};
      const currentChatEntry =
        Array.isArray(currentSecret.chatLLMs) && currentSecret.chatLLMs.length
          ? currentSecret.chatLLMs[0] || {}
          : {};
      const deepseekWorkflowModelPresets = [
        {
          value: 'deepseek-v4-flash',
          label: 'deepseek-v4-flash · 高频筛选 / 低成本默认',
        },
        {
          value: 'deepseek-v4-pro',
          label: 'deepseek-v4-pro · 深度总结 / 高质量输出',
        },
      ];
      const workflowScenarioFields = [
        {
          key: 'defaultModel',
          secret: 'DPR_LLM_MODEL',
          note: '默认兜底；建议 deepseek-v4-flash',
          recommended: 'deepseek-v4-flash',
        },
        {
          key: 'rewriteModel',
          secret: 'DPR_LLM_REWRITE_MODEL',
          note: '订阅词改写；建议 deepseek-v4-flash',
          recommended: 'deepseek-v4-flash',
        },
        {
          key: 'filterModel',
          secret: 'DPR_LLM_FILTER_MODEL',
          note: '批量筛选/JSON 打分；建议 deepseek-v4-flash',
          recommended: 'deepseek-v4-flash',
        },
        {
          key: 'summaryModel',
          secret: 'DPR_LLM_SUMMARY_MODEL',
          note: '精读总结/日报；建议 deepseek-v4-pro',
          recommended: 'deepseek-v4-pro',
        },
      ];

      const initialGithubToken = normalizeText(
        currentSecret.github && currentSecret.github.token,
      );
      const initialApiKey = normalizeText(currentSummaryLLM.apiKey || '');
      const initialWorkflowBaseUrl = normalizeBaseUrlForStorage(
        currentSummaryLLM.baseUrl || getDefaultWorkflowBaseUrl(),
      );
      const initialCustomApiKey = normalizeText(currentChatEntry.apiKey || '');
      const initialCustomBaseUrl = normalizeBaseUrlForStorage(
        currentChatEntry.baseUrl || '',
      );
      const initialWorkflowModel =
        normalizeText(currentSummaryLLM.model || '') || 'deepseek-v4-flash';
      const currentWorkflowLLM =
        currentSecret.workflowLLM && typeof currentSecret.workflowLLM === 'object'
          ? currentSecret.workflowLLM
          : {};
      const currentLLMProvider =
        currentSecret.llmProvider && typeof currentSecret.llmProvider === 'object'
          ? currentSecret.llmProvider
          : {};
      const initialWorkflowModelMode =
        normalizeText(currentWorkflowLLM.mode || currentLLMProvider.workflowModelMode || '').toLowerCase() === 'scenario'
          ? 'scenario'
          : 'single';
      const initialWorkflowModels = {
        defaultModel: normalizeText(currentWorkflowLLM.defaultModel || initialWorkflowModel),
        rewriteModel: normalizeText(currentWorkflowLLM.rewriteModel || currentWorkflowLLM.defaultModel || initialWorkflowModel),
        filterModel: normalizeText(currentWorkflowLLM.filterModel || currentWorkflowLLM.defaultModel || initialWorkflowModel),
        summaryModel: normalizeText(currentWorkflowLLM.summaryModel || currentSummaryLLM.model || initialWorkflowModel),
      };
      const initialCustomModels = sanitizeModelList(
        currentProviderType === 'openai-compatible'
          ? (currentChatEntry.models || [])
          : [],
        3,
      );
      const chatUsesCustom =
        !!initialCustomApiKey
        && !!initialCustomBaseUrl
        && (
          initialCustomBaseUrl !== initialWorkflowBaseUrl
          || initialCustomApiKey !== initialApiKey
          || (initialCustomModels[0] && initialCustomModels[0] !== initialWorkflowModel)
        );
      const initialChatMode = chatUsesCustom ? 'openai-compatible' : 'workflow';

      modal.innerHTML = `
        <h2 style="margin-top:0;">🛡️ 新配置指引 · 第二步</h2>
        <div class="secret-setup-step2-grid" style="font-size:13px;">
          <div class="secret-setup-step2-col">
            <div class="secret-setup-step2-block">
              <div class="secret-setup-step2-title">GitHub Token（必填）</div>
              <p class="secret-setup-step2-note">
                需要使用 <code>Classic PAT</code>，并同时具备 <code>repo</code>、<code>workflow</code> 和 <code>gist</code> 权限。
              </p>
              <div class="secret-setup-input-row">
                <input
                  id="secret-setup-github-token"
                  type="password"
                  autocomplete="off"
                  placeholder="用于读写 config.yaml 与触发 workflow 的 GitHub PAT"
                  style="width:100%; box-sizing:border-box; padding:6px 8px; font-size:13px;"
                />
                <button id="secret-setup-github-verify" type="button" class="secret-gate-btn secondary">
                  验证
                </button>
              </div>
              <div id="secret-setup-github-status" style="min-height:18px; font-size:12px; color:#999;">
                需要使用 <code>Classic PAT</code>，并同时具备 <code>repo</code>、<code>workflow</code> 和 <code>gist</code> 权限。
              </div>
            </div>

            <div id="secret-setup-workflow-section" class="secret-setup-step2-block">
              <div class="secret-setup-step2-title">工作流大模型 API（必填）</div>
              <p class="secret-setup-step2-note">
                用于 query enrich、LLM refine、速览与总结。第一版要求 OpenAI-compatible Chat Completions。
              </p>
              <div class="secret-setup-input-row multi-actions">
                <input
                  id="secret-setup-workflow-api-key"
                  type="password"
                  autocomplete="off"
                  placeholder="API Key，例如：sk-xxxx"
                  style="width:100%; box-sizing:border-box; padding:6px 8px; font-size:13px;"
                />
                <button id="secret-setup-workflow-verify" type="button" class="secret-gate-btn secondary">
                  测试
                </button>
                <button id="secret-setup-workflow-test" type="button" class="secret-gate-btn secondary">
                  重测
                </button>
              </div>
              <input
                id="secret-setup-workflow-base-url"
                type="text"
                autocomplete="off"
                placeholder="Base URL，例如 https://api.openai.com/v1"
                style="width:100%; box-sizing:border-box; padding:6px 8px; margin:6px 0 4px; font-size:13px;"
              />
              <div id="secret-setup-workflow-status" style="min-height:18px; font-size:12px; color:#999; margin-bottom:8px;">
                将发送一次 <code>hello world</code> 请求检查接口、Key 与模型是否可用。
              </div>

              <div style="font-weight:500; margin-bottom:4px; display:flex; align-items:center; gap:4px;">
                工作流大模型配置方式
                <span class="secret-model-tip">!
                  <span class="secret-model-tip-popup">
                    按照 Thinking（思考模式）的高负载场景估算：<br/>
                    <br/>
                    总结：15k 输入 + 4k 输出（含思考）<br/>
                    提问：16.1k 输入 + 2k 输出（含思考）<br/>
                    <br/>
                    模型 · 约价（单次）：<br/>
                    - Gemini 3 Flash：总结 ¥0.0195，提问 ¥0.0141（不到 2 分钱，100 篇论文约 2 元）<br/>
                    - DeepSeek V3：总结 ¥0.0294，提问 ¥0.0267（不到 3 分钱，长输出性价比极高）<br/>
                    - GPT-5：总结 ¥0.0588，提问 ¥0.0401（约 6 分钱）<br/>
                    - Gemini 3 Pro：总结 ¥0.0780，提问 ¥0.0562（约 8 分钱，一篇论文不到 1 毛钱）
                  </span>
                </span>
              </div>
              <div id="secret-setup-workflow-models" style="font-size:13px;">
                <div style="display:grid; gap:6px; margin-bottom:8px;">
                  <label class="secret-setup-provider-choice" style="margin:0;">
                    <input type="radio" name="secret-setup-workflow-model-mode" value="single" />
                    <span><strong>一键设置</strong>只填写一个模型并同步写入所有工作流模型 Secret。</span>
                  </label>
                  <label class="secret-setup-provider-choice" style="margin:0;">
                    <input type="radio" name="secret-setup-workflow-model-mode" value="scenario" />
                    <span><strong>分场景配置</strong>分别为改写、筛选、总结等任务指定模型。</span>
                  </label>
                </div>
                <div id="secret-setup-workflow-single-model-panel">
                  <p class="secret-setup-step2-note" style="margin:0 0 6px;">
                    可选择 <code>deepseek-v4-flash</code> / <code>deepseek-v4-pro</code>，也可以直接输入服务商支持的模型名。
                  </p>
                  <p class="secret-setup-step2-note" style="margin:0 0 6px; color:#b26a00;">
                    请慎重考虑：一键选择最高模型会让 query enrich、LLM refine、日报总结等全流程都使用该模型，消耗会明显增加。
                  </p>
                  <input
                    id="secret-setup-workflow-model-input"
                    type="text"
                    autocomplete="off"
                    placeholder="模型名，例如 deepseek-v4-flash / deepseek-v4-pro"
                    style="width:100%; box-sizing:border-box; padding:6px 8px; font-size:13px;"
                  />
                </div>
                <div id="secret-setup-workflow-scenario-model-panel" style="display:none;">
                  <p class="secret-setup-step2-note" style="margin:0 0 6px;">
                    将分别写入以下 GitHub Secrets；每项可从预设中选择，也可输入自定义模型名。
                  </p>
                  ${workflowScenarioFields.map((field) => `
                    <div class="secret-setup-workflow-secret-field" style="border:1px solid #eee; border-radius:8px; padding:8px; margin-bottom:6px; background:#fafafa;">
                      <div style="font-weight:600; margin-bottom:4px;">
                        <code>${field.secret}</code>
                        <span style="font-weight:400; color:#666;">（${field.note}）</span>
                      </div>
                      <input
                        class="secret-setup-workflow-model-field"
                        data-workflow-model-key="${field.key}"
                        type="text"
                        autocomplete="off"
                        placeholder="${field.recommended}"
                        style="width:100%; box-sizing:border-box; padding:6px 8px; font-size:13px;"
                      />
                    </div>
                  `).join('')}
                </div>
              </div>
            </div>
          </div>

          <div class="secret-setup-step2-col">
            <div class="secret-setup-step2-block">
              <div class="secret-setup-step2-title">聊天模型来源</div>
              <p class="secret-setup-step2-note">
                聊天区可以复用工作流 API，也可以填写另一组 OpenAI-compatible API。
              </p>
              <label class="secret-setup-provider-choice">
                <input type="radio" name="secret-setup-provider" value="workflow" />
                <span><strong>聊天区也使用工作流 API</strong>工作流总结、过滤与聊天区使用同一组 OpenAI-compatible 配置。</span>
              </label>
              <label class="secret-setup-provider-choice">
                <input type="radio" name="secret-setup-provider" value="openai-compatible" />
                <span><strong>聊天区使用另一组 OpenAI-compatible API</strong>最多 3 个自定义模型，仅用于论文页面聊天。</span>
              </label>
            </div>

            <div id="secret-setup-custom-section" class="secret-setup-step2-block">
              <div class="secret-setup-step2-title">OpenAI-compatible 聊天配置</div>
              <p class="secret-setup-step2-note">
                预设会自动填写 <code>Base URL</code> 与推荐模型；API Key 仍需你自行输入。这里的模型仅供聊天区使用。
              </p>
              <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:6px;">
                <button id="secret-setup-preset-deepseek" type="button" class="secret-gate-btn secondary">
                  填入 DeepSeek 预设
                </button>
                <button id="secret-setup-preset-glm" type="button" class="secret-gate-btn secondary">
                  填入 GLM 预设
                </button>
                <button id="secret-setup-preset-minimax" type="button" class="secret-gate-btn secondary">
                  填入 MiniMax 预设
                </button>
                <button id="secret-setup-preset-kimi" type="button" class="secret-gate-btn secondary">
                  填入 Kimi 预设
                </button>
                <button id="secret-setup-preset-openai" type="button" class="secret-gate-btn secondary">
                  填入 OpenAI 预设
                </button>
              </div>
              <input
                id="secret-setup-custom-api-key"
                type="password"
                autocomplete="off"
                placeholder="聊天 API Key"
                style="width:100%; box-sizing:border-box; padding:6px 8px; margin-bottom:4px; font-size:13px;"
              />
              <input
                id="secret-setup-custom-base-url"
                type="text"
                autocomplete="off"
                placeholder="聊天 Base URL，例如 https://api.openai.com/v1"
                style="width:100%; box-sizing:border-box; padding:6px 8px; margin-bottom:4px; font-size:13px;"
              />
              <input
                id="secret-setup-custom-model-1"
                type="text"
                autocomplete="off"
                placeholder="聊天模型 1（默认）"
                style="width:100%; box-sizing:border-box; padding:6px 8px; margin-bottom:4px; font-size:13px;"
              />
              <input
                id="secret-setup-custom-model-2"
                type="text"
                autocomplete="off"
                placeholder="聊天模型 2（可选）"
                style="width:100%; box-sizing:border-box; padding:6px 8px; margin-bottom:4px; font-size:13px;"
              />
              <input
                id="secret-setup-custom-model-3"
                type="text"
                autocomplete="off"
                placeholder="聊天模型 3（可选）"
                style="width:100%; box-sizing:border-box; padding:6px 8px; margin-bottom:4px; font-size:13px;"
              />
              <button id="secret-setup-custom-test" type="button" class="secret-gate-btn secondary secret-setup-step2-actions">
                测试当前配置
              </button>
              <div id="secret-setup-custom-status" style="min-height:18px; font-size:12px; color:#999; margin-top:6px;">
                将依次用已填写聊天模型发送 <code>hello world</code>，检查接口与模型是否可用。
              </div>
            </div>
          </div>
        </div>

        <div id="secret-setup-error" style="min-height:18px; font-size:12px; color:#999; margin-top:10px; margin-bottom:8px;">
          所有密钥信息将加密写入 GitHub Secrets（用于 GitHub Actions），并同步生成本地 <code>secret.private</code> 备份，原文不会直接存入仓库。
        </div>
        <div class="secret-gate-actions">
          <button id="secret-setup-back" type="button" class="secret-gate-btn secondary">
            上一步
          </button>
          <button id="secret-setup-close" type="button" class="secret-gate-btn secondary">
            关闭
          </button>
          <button id="secret-setup-generate" type="button" class="secret-gate-btn primary">
            保存配置
          </button>
        </div>
      `;

      const githubInput = document.getElementById('secret-setup-github-token');
      const githubVerifyBtn = document.getElementById('secret-setup-github-verify');
      const githubStatusEl = document.getElementById('secret-setup-github-status');
      const providerInputs = Array.from(
        document.querySelectorAll('input[name="secret-setup-provider"]'),
      );
      const workflowSection = document.getElementById('secret-setup-workflow-section');
      const customSection = document.getElementById('secret-setup-custom-section');
      const workflowApiKeyInput = document.getElementById('secret-setup-workflow-api-key');
      const workflowBaseUrlInput = document.getElementById('secret-setup-workflow-base-url');
      const workflowVerifyBtn = document.getElementById('secret-setup-workflow-verify');
      const workflowTestBtn = document.getElementById('secret-setup-workflow-test');
      const workflowStatusEl = document.getElementById('secret-setup-workflow-status');
      const workflowModelsWrap = document.getElementById('secret-setup-workflow-models');
      const workflowModelModeInputs = Array.from(
        document.querySelectorAll('input[name="secret-setup-workflow-model-mode"]'),
      );
      const workflowSingleModelPanel = document.getElementById('secret-setup-workflow-single-model-panel');
      const workflowScenarioModelPanel = document.getElementById('secret-setup-workflow-scenario-model-panel');
      const customApiKeyInput = document.getElementById('secret-setup-custom-api-key');
      const customBaseUrlInput = document.getElementById('secret-setup-custom-base-url');
      const customModel1Input = document.getElementById('secret-setup-custom-model-1');
      const customModel2Input = document.getElementById('secret-setup-custom-model-2');
      const customModel3Input = document.getElementById('secret-setup-custom-model-3');
      const workflowModelInput = document.getElementById('secret-setup-workflow-model-input');
      const workflowScenarioModelInputs = Array.from(
        document.querySelectorAll('.secret-setup-workflow-model-field'),
      );
      const deepseekPresetBtn = document.getElementById('secret-setup-preset-deepseek');
      const glmPresetBtn = document.getElementById('secret-setup-preset-glm');
      const minimaxPresetBtn = document.getElementById('secret-setup-preset-minimax');
      const kimiPresetBtn = document.getElementById('secret-setup-preset-kimi');
      const openaiPresetBtn = document.getElementById('secret-setup-preset-openai');
      const customTestBtn = document.getElementById('secret-setup-custom-test');
      const customStatusEl = document.getElementById('secret-setup-custom-status');
      const errorEl = document.getElementById('secret-setup-error');
      const backBtn = document.getElementById('secret-setup-back');
      const closeBtn = document.getElementById('secret-setup-close');
      const genBtn = document.getElementById('secret-setup-generate');

      if (
        !githubInput ||
        !githubVerifyBtn ||
        !githubStatusEl ||
        !providerInputs.length ||
        !workflowSection ||
        !customSection ||
        !workflowApiKeyInput ||
        !workflowBaseUrlInput ||
        !workflowVerifyBtn ||
        !workflowTestBtn ||
        !workflowStatusEl ||
        !workflowModelsWrap ||
        !workflowModelModeInputs.length ||
        !workflowSingleModelPanel ||
        !workflowScenarioModelPanel ||
        !workflowModelInput ||
        !workflowScenarioModelInputs.length ||
        !customApiKeyInput ||
        !customBaseUrlInput ||
        !customModel1Input ||
        !customModel2Input ||
        !customModel3Input ||
        !deepseekPresetBtn ||
        !glmPresetBtn ||
        !minimaxPresetBtn ||
        !kimiPresetBtn ||
        !openaiPresetBtn ||
        !customTestBtn ||
        !customStatusEl ||
        !errorEl ||
        !backBtn ||
        !closeBtn ||
        !genBtn
      ) {
        return;
      }

      workflowModelInput.setAttribute('list', 'secret-setup-workflow-model-presets');
      workflowScenarioModelInputs.forEach((input) => {
        input.setAttribute('list', 'secret-setup-workflow-model-presets');
      });
      workflowModelsWrap.insertAdjacentHTML(
        'beforeend',
        `<datalist id="secret-setup-workflow-model-presets">${
          deepseekWorkflowModelPresets
        .map((item) => `<option value="${item.value}">${item.label}</option>`)
        .join('')
        }</datalist>`,
      );

      githubInput.value = initialGithubToken;
      workflowApiKeyInput.value = initialApiKey;
      workflowBaseUrlInput.value = initialWorkflowBaseUrl;
      customApiKeyInput.value =
        initialChatMode === 'openai-compatible'
        ? normalizeText(currentChatEntry.apiKey || '')
        : '';
      customBaseUrlInput.value =
        initialChatMode === 'openai-compatible' ? initialCustomBaseUrl : '';
      customModel1Input.value = initialCustomModels[0] || '';
      customModel2Input.value = initialCustomModels[1] || '';
      customModel3Input.value = initialCustomModels[2] || '';

      providerInputs.forEach((input) => {
        input.checked = input.value === initialChatMode;
      });
      workflowModelModeInputs.forEach((input) => {
        input.checked = input.value === initialWorkflowModelMode;
      });
      workflowModelInput.value = initialWorkflowModels.defaultModel || initialWorkflowModel || 'deepseek-v4-flash';
      if (!workflowModelInput.value) {
        workflowModelInput.value = 'deepseek-v4-flash';
      }
      workflowScenarioModelInputs.forEach((input) => {
        const key = input.getAttribute('data-workflow-model-key') || '';
        input.value = initialWorkflowModels[key] || '';
      });

      let githubOk = !!initialGithubToken;
      let workflowOk =
        !!initialApiKey
        && !!initialWorkflowBaseUrl
        && workflowScenarioFields.every((field) => !!initialWorkflowModels[field.key]);
      let customOk =
        initialChatMode === 'openai-compatible'
        && !!initialCustomApiKey
        && !!initialCustomBaseUrl
        && initialCustomModels.length > 0;

      const setErrorText = (text, color) => {
        if (!errorEl) return;
        errorEl.textContent = text;
        errorEl.style.color = color || '#999';
      };

      const selectedProvider = () => {
        const checked = providerInputs.find((input) => input.checked);
        return checked ? checked.value : 'workflow';
      };

      const selectedWorkflowModel = () => {
        return normalizeText(workflowModelInput.value || '');
      };

      const selectedWorkflowModelMode = () => {
        const checked = workflowModelModeInputs.find((input) => input.checked);
        return checked ? checked.value : 'single';
      };

      const collectWorkflowModelDraft = () => {
        const mode = selectedWorkflowModelMode();
        if (mode !== 'scenario') {
          const model = selectedWorkflowModel();
          if (!model) {
            throw new Error('请选择或输入一键设置模型。');
          }
          return {
            mode: 'single',
            defaultModel: model,
            rewriteModel: model,
            filterModel: model,
            summaryModel: model,
          };
        }

        const values = {};
        workflowScenarioModelInputs.forEach((input) => {
          const key = input.getAttribute('data-workflow-model-key') || '';
          if (key) {
            values[key] = normalizeText(input.value || '');
          }
        });
        const missing = workflowScenarioFields
          .filter((field) => !values[field.key])
          .map((field) => field.secret);
        if (missing.length) {
          throw new Error(`请填写分场景模型：${missing.join(', ')}。`);
        }
        return {
          mode: 'scenario',
          defaultModel: values.defaultModel,
          rewriteModel: values.rewriteModel,
          filterModel: values.filterModel,
          summaryModel: values.summaryModel,
        };
      };

      const uniqueWorkflowPingModels = (draft) => {
        const models = [
          draft.defaultModel,
          draft.rewriteModel,
          draft.filterModel,
          draft.summaryModel,
        ];
        return sanitizeModelList(models, 10);
      };

      const syncWorkflowModelSections = () => {
        const mode = selectedWorkflowModelMode();
        workflowSingleModelPanel.style.display = mode === 'scenario' ? 'none' : 'block';
        workflowScenarioModelPanel.style.display = mode === 'scenario' ? 'block' : 'none';
      };

      const syncProviderSections = () => {
        const provider = selectedProvider();
        workflowSection.style.display = 'block';
        customSection.style.display =
          provider === 'openai-compatible' ? 'block' : 'none';
      };

      const resetGithubStatus = () => {
        githubOk = false;
        githubStatusEl.innerHTML = '需要使用 <code>Classic PAT</code>，并同时具备 <code>repo</code>、<code>workflow</code> 和 <code>gist</code> 权限。';
        githubStatusEl.style.color = '#999';
      };

      const resetWorkflowStatus = () => {
        workflowOk = false;
        workflowStatusEl.innerHTML =
          '将发送一次 <code>hello world</code> 请求检查接口、Key 与模型是否可用。';
        workflowStatusEl.style.color = '#999';
      };

      const resetCustomStatus = () => {
        customOk = false;
        customStatusEl.innerHTML =
          '将依次用已填写模型发送 <code>hello world</code>，检查接口与模型是否可用。';
        customStatusEl.style.color = '#999';
      };

      const applyOpenAICompatiblePreset = (presetKey) => {
        const preset = getOpenAICompatiblePreset(presetKey);
        if (!preset) return;
        providerInputs.forEach((input) => {
          input.checked = input.value === 'openai-compatible';
        });
        syncProviderSections();
        customApiKeyInput.value = '';
        customBaseUrlInput.value = preset.baseUrl || '';
        customModel1Input.value = preset.models[0] || '';
        customModel2Input.value = preset.models[1] || '';
        customModel3Input.value = preset.models[2] || '';
        resetCustomStatus();
        customApiKeyInput.focus();
        setErrorText(
          `已填入 ${preset.label} 预设，请补充 API Key 后点击“测试当前配置”。`,
          '#666',
        );
      };

      const validateCustomDraft = () => {
        const apiKey = normalizeText(customApiKeyInput.value);
        const baseUrl = normalizeBaseUrlForStorage(customBaseUrlInput.value);
        const models = sanitizeModelList(
          [
            customModel1Input.value,
            customModel2Input.value,
            customModel3Input.value,
          ],
          3,
        );

        if (!apiKey) {
          throw new Error('请先输入 OpenAI-compatible API Key。');
        }
        if (!baseUrl) {
          throw new Error('请先输入 OpenAI-compatible Base URL。');
        }
        if (!/^https?:\/\//i.test(baseUrl)) {
          throw new Error('Base URL 需要以 http:// 或 https:// 开头。');
        }
        if (!models.length) {
          throw new Error('请至少填写 1 个模型名称。');
        }
        return {
          apiKey,
          baseUrl,
          models,
        };
      };

      const collectProviderDraft = () => {
        const provider = selectedProvider();
        const apiKey = normalizeText(workflowApiKeyInput.value);
        const baseUrl = normalizeBaseUrlForStorage(workflowBaseUrlInput.value);
        if (!apiKey) {
          throw new Error('请先输入工作流 API Key。');
        }
        if (!baseUrl) {
          throw new Error('请先输入工作流 Base URL。');
        }
        if (!/^https?:\/\//i.test(baseUrl)) {
          throw new Error('工作流 Base URL 必须以 http:// 或 https:// 开头。');
        }
        const workflowModels = collectWorkflowModelDraft();
        if (provider === 'workflow') {
          return {
            providerType: 'openai-compatible',
            chatUsesCustom: false,
            summaryApiKey: apiKey,
            summaryBaseUrl: baseUrl,
            summaryModel: workflowModels.summaryModel,
            defaultModel: workflowModels.defaultModel,
            chatModels: [workflowModels.defaultModel],
            rewriteModel: workflowModels.rewriteModel,
            filterModel: workflowModels.filterModel,
            workflowModelMode: workflowModels.mode,
            skipRerank: true,
          };
        }

        const customDraft = validateCustomDraft();
        return {
          providerType: 'openai-compatible',
          chatUsesCustom: true,
          summaryApiKey: apiKey,
          summaryBaseUrl: baseUrl,
          summaryModel: workflowModels.summaryModel,
          chatModels: customDraft.models,
          chatApiKey: customDraft.apiKey,
          chatBaseUrl: customDraft.baseUrl,
          defaultModel: workflowModels.defaultModel,
          rewriteModel: workflowModels.rewriteModel,
          filterModel: workflowModels.filterModel,
          workflowModelMode: workflowModels.mode,
          skipRerank: true,
        };
      };

      const buildWorkflowPingEntries = () => {
        const apiKey = normalizeText(workflowApiKeyInput.value);
        const baseUrl = normalizeBaseUrlForStorage(workflowBaseUrlInput.value);
        const workflowModels = collectWorkflowModelDraft();
        if (!apiKey || !baseUrl) {
          throw new Error('请先填写工作流 API Key 和 Base URL。');
        }
        return uniqueWorkflowPingModels(workflowModels).map((model) => ({
          apiKey,
          baseUrl,
          model,
        }));
      };

      const buildCustomPingEntries = () => {
        const customDraft = validateCustomDraft();
        return customDraft.models.map((model) => ({
          apiKey: customDraft.apiKey,
          baseUrl: customDraft.baseUrl,
          model,
        }));
      };

      const buildPingEntries = () => {
        const provider = selectedProvider();
        if (provider === 'workflow') {
          return buildWorkflowPingEntries();
        }
        return buildCustomPingEntries();
      };

      const bindResetOnInput = (elements, resetFn) => {
        elements.forEach((el) => {
          if (!el) return;
          el.addEventListener('input', resetFn);
          el.addEventListener('change', resetFn);
        });
      };

      if (initialGithubToken) {
        githubStatusEl.textContent = '已载入当前加密配置；如更换 GitHub Token，保存前请重新验证。';
        githubStatusEl.style.color = '#666';
      }
      if (initialApiKey) {
        workflowStatusEl.textContent = '已载入当前加密配置；如更换 API Key 或模型，建议重新验证或点击测试按钮。';
        workflowStatusEl.style.color = '#666';
      }
      if (currentProviderType === 'openai-compatible' && initialCustomApiKey && initialCustomBaseUrl) {
        customStatusEl.textContent = '已载入当前加密配置；如更换 Base URL / 模型，建议重新点击测试。';
        customStatusEl.style.color = '#666';
      }

      syncProviderSections();
      syncWorkflowModelSections();

      bindResetOnInput([githubInput], resetGithubStatus);
      bindResetOnInput(
        [workflowApiKeyInput, workflowBaseUrlInput, workflowModelInput, ...workflowScenarioModelInputs],
        resetWorkflowStatus,
      );
      bindResetOnInput(
        [customApiKeyInput, customBaseUrlInput, customModel1Input, customModel2Input, customModel3Input],
        resetCustomStatus,
      );
      workflowModelModeInputs.forEach((input) => {
        input.addEventListener('change', () => {
          syncWorkflowModelSections();
          resetWorkflowStatus();
        });
      });
      providerInputs.forEach((input) => {
        input.addEventListener('change', () => {
          syncProviderSections();
          setErrorText(
            '所有密钥信息将加密写入 GitHub Secrets（用于 GitHub Actions），并同步生成本地 secret.private 备份。',
            '#999',
          );
        });
      });
      deepseekPresetBtn.addEventListener('click', () => {
        applyOpenAICompatiblePreset('deepseek');
      });
      glmPresetBtn.addEventListener('click', () => {
        applyOpenAICompatiblePreset('glm');
      });
      minimaxPresetBtn.addEventListener('click', () => {
        applyOpenAICompatiblePreset('minimax');
      });
      kimiPresetBtn.addEventListener('click', () => {
        applyOpenAICompatiblePreset('kimi');
      });
      openaiPresetBtn.addEventListener('click', () => {
        applyOpenAICompatiblePreset('openai');
      });

      backBtn.addEventListener('click', () => {
        renderInitStep1();
      });

      closeBtn.addEventListener('click', () => {
        hide();
      });

      githubVerifyBtn.addEventListener('click', async () => {
        const token = normalizeText(githubInput.value);
        if (!token) {
          githubStatusEl.textContent = '请先输入 GitHub Token。';
          githubStatusEl.style.color = '#c00';
          githubOk = false;
          return;
        }
        githubVerifyBtn.disabled = true;
        githubStatusEl.textContent = '正在验证 GitHub Token...';
        githubStatusEl.style.color = '#666';
        try {
          const res = await fetch('https://api.github.com/user', {
            headers: {
              Authorization: `token ${token}`,
              Accept: 'application/vnd.github.v3+json',
            },
          });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          const scopesHeader = res.headers.get('X-OAuth-Scopes') || '';
          const scopeList = scopesHeader
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          const requiredScopes = ['repo', 'workflow', 'gist'];
          const missing = requiredScopes.filter((scope) => !scopeList.includes(scope));
          if (missing.length) {
            throw new Error(
              `Token 权限不足，缺少：${missing.join(', ')}。请在 GitHub 中重新生成 PAT。`,
            );
          }
          const userData = await res.json().catch(() => ({}));
          githubStatusEl.innerHTML = `✅ 验证成功：用户 ${userData.login || ''}，权限：${scopeList.join(', ')}<br>Gist 分享：已开启。`;
          githubStatusEl.style.color = '#28a745';
          githubOk = true;
        } catch (e) {
          githubStatusEl.textContent = `❌ 验证失败：${e.message || e}`;
          githubStatusEl.style.color = '#c00';
          githubOk = false;
        } finally {
          githubVerifyBtn.disabled = false;
        }
      });

      workflowVerifyBtn.addEventListener('click', async () => {
        workflowVerifyBtn.disabled = true;
        workflowTestBtn.disabled = true;
        workflowStatusEl.textContent = '正在测试工作流大模型配置...';
        workflowStatusEl.style.color = '#666';
        try {
          const models = await pingChatModels(buildWorkflowPingEntries(), workflowStatusEl);
          workflowStatusEl.textContent = `✅ 工作流配置可用：${models.join(', ')}`;
          workflowStatusEl.style.color = '#28a745';
          workflowOk = true;
        } catch (e) {
          workflowStatusEl.textContent = `❌ 测试失败：${e.message || e}`;
          workflowStatusEl.style.color = '#c00';
          workflowOk = false;
        } finally {
          workflowVerifyBtn.disabled = false;
          workflowTestBtn.disabled = false;
        }
      });

      workflowTestBtn.addEventListener('click', async () => {
        workflowTestBtn.disabled = true;
        workflowVerifyBtn.disabled = true;
        try {
          const models = await pingChatModels(buildWorkflowPingEntries(), workflowStatusEl);
          workflowStatusEl.textContent = `✅ 工作流配置可用：${models.join(', ')}`;
          workflowStatusEl.style.color = '#28a745';
          workflowOk = true;
        } catch (e) {
          workflowStatusEl.textContent = `❌ 测试失败：${e.message || e}`;
          workflowStatusEl.style.color = '#c00';
          workflowOk = false;
        } finally {
          workflowTestBtn.disabled = false;
          workflowVerifyBtn.disabled = false;
        }
      });

      customTestBtn.addEventListener('click', async () => {
        customTestBtn.disabled = true;
        try {
          const models = await pingChatModels(buildCustomPingEntries(), customStatusEl);
          customStatusEl.textContent = `✅ 配置可用：${models.join(', ')}`;
          customStatusEl.style.color = '#28a745';
          customOk = true;
        } catch (e) {
          customStatusEl.textContent = `❌ 测试失败：${e.message || e}`;
          customStatusEl.style.color = '#c00';
          customOk = false;
        } finally {
          customTestBtn.disabled = false;
        }
      });

      genBtn.addEventListener('click', async () => {
        const githubToken = normalizeText(githubInput.value);
        if (!githubToken || !githubOk) {
          setErrorText('请先填写并通过验证 GitHub Token。', '#c00');
          return;
        }

        let providerDraft = null;
        try {
          providerDraft = collectProviderDraft();
        } catch (e) {
          setErrorText(e.message || '当前模型配置不完整。', '#c00');
          return;
        }

        if (!workflowOk) {
          setErrorText('请先测试工作流大模型配置，确认 API Key、Base URL 与模型可用。', '#c00');
          return;
        }
        if (providerDraft.chatUsesCustom && !customOk) {
          setErrorText('请先点击“测试当前配置”，确认聊天模型配置可用。', '#c00');
          return;
        }

        const nowIso = new Date().toISOString();
        const plainConfig = {
          createdAt: currentSecret.createdAt || nowIso,
          updatedAt: nowIso,
          github: {
            token: githubToken,
          },
          llmProvider: {
            type: providerDraft.providerType,
            skipRerank: providerDraft.skipRerank,
            workflowModelMode: providerDraft.workflowModelMode,
          },
          summarizedLLM: {
            apiKey: providerDraft.summaryApiKey,
            baseUrl: providerDraft.summaryBaseUrl,
            model: providerDraft.summaryModel,
          },
          workflowLLM: {
            mode: providerDraft.workflowModelMode,
            defaultModel: providerDraft.defaultModel,
            rewriteModel: providerDraft.rewriteModel,
            filterModel: providerDraft.filterModel,
            summaryModel: providerDraft.summaryModel,
          },
          rerankerLLM: {
            enabled: false,
          },
          chatLLMs: [
            {
              apiKey: providerDraft.chatUsesCustom
                ? providerDraft.chatApiKey
                : providerDraft.summaryApiKey,
              baseUrl: providerDraft.chatUsesCustom
                ? providerDraft.chatBaseUrl
                : providerDraft.summaryBaseUrl,
              models: providerDraft.chatModels,
            },
          ],
        };

        try {
          setErrorText('正在准备写入 GitHub Secrets...', '#666');
          genBtn.disabled = true;

          const secretsOk = await saveSummarizeSecretsToGithub(
            githubToken,
            {
              providerType: providerDraft.providerType,
              summarizedApiKey: providerDraft.summaryApiKey,
              summarizedBaseUrl: providerDraft.summaryBaseUrl,
              summarizedModel: providerDraft.summaryModel,
              defaultModel: providerDraft.defaultModel,
              summaryModel: providerDraft.summaryModel,
              filterModel: providerDraft.filterModel,
              rewriteModel: providerDraft.rewriteModel,
              skipRerank: providerDraft.skipRerank,
            },
            (current, total, secretName) => {
              setErrorText(`(${current}/${total}) 正在上传 GitHub Secret：${secretName}...`, '#666');
            },
          );
          if (!secretsOk) {
            setErrorText(
              '❌ 写入 GitHub Secrets 失败，请检查网络、Token 权限（需 Classic PAT + repo/workflow/gist）或稍后重试。',
              '#c00',
            );
            return;
          }

          setErrorText('GitHub Secrets 上传完成，正在生成加密配置 secret.private...', '#666');
          const payload = await createEncryptedSecret(password, plainConfig);
          window.decoded_secret_private = plainConfig;
          setMode('full');

          const blob = new Blob([JSON.stringify(payload, null, 2)], {
            type: 'application/json',
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'secret.private';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }, 0);

          setErrorText('正在将 secret.private 推送到 GitHub 仓库根目录...', '#666');
          const commitOk = await saveSecretPrivateToGithubRepo(githubToken, payload);
          if (!commitOk) {
            setErrorText(
              '⚠️ 已生成本地 secret.private，但自动推送到 GitHub 仓库失败，请稍后手动提交或检查 Token/网络。',
              '#c00',
            );
          }

          hide();

          try {
            if (window.SubscriptionsManager && window.SubscriptionsManager.openOverlay) {
              window.SubscriptionsManager.openOverlay();
            } else {
              var ensureEvent = new CustomEvent('ensure-arxiv-ui');
              document.dispatchEvent(ensureEvent);
              setTimeout(function () {
                var loadEvent = new CustomEvent('load-arxiv-subscriptions');
                document.dispatchEvent(loadEvent);
                var overlay = document.getElementById('arxiv-search-overlay');
                if (overlay) {
                  overlay.style.display = 'flex';
                  requestAnimationFrame(function () {
                    requestAnimationFrame(function () {
                      overlay.classList.add('show');
                    });
                  });
                }
              }, 120);
            }
          } catch {
            // 若后台订阅面板唤起失败，则静默忽略，不影响主流程
          }
        } catch (e) {
          console.error(e);
          setErrorText(
            '生成 secret.private 失败，请稍后重试或检查浏览器兼容性。',
            '#c00',
          );
        } finally {
          genBtn.disabled = false;
        }
      });
    };

    // 初始化向导：第 1 步（设置密码）
    const renderInitStep1 = () => {
      setStep2Modal(false);
      modal.innerHTML = `
        <h2 style="margin-top:0;">🛡️ 新配置指引 · 第一步</h2>
        <p style="font-size:13px; color:#555; margin-bottom:8px;">
          检测到当前仓库尚未创建 <code>secret.private</code> 文件。
          请先设置一个用于加密本地配置的密码，该密码将用于解锁大模型密钥等敏感信息。
        </p>
        <label for="secret-setup-password" style="font-size:13px; color:#333; display:block; margin-bottom:4px;">
          设置解锁密码：
        </label>
        <input
          id="secret-setup-password"
          type="password"
          autocomplete="off"
          style="width:100%; box-sizing:border-box; padding:6px 8px; margin-bottom:4px; font-size:13px;"
        />
        <input
          id="secret-setup-password-confirm"
          type="password"
          autocomplete="off"
          placeholder="再次输入密码确认"
          style="width:100%; box-sizing:border-box; padding:6px 8px; margin-bottom:6px; font-size:13px;"
        />
        <div id="secret-setup-error" style="min-height:18px; font-size:12px; color:#666; margin-bottom:8px;">
          密码至少 8 位，且必须包含数字、小写字母、大写字母和特殊符号。密码仅保存在浏览器本地，用于解锁密钥。
        </div>
        <div class="secret-gate-actions">
          <button id="secret-setup-guest" type="button" class="secret-gate-btn secondary">
            以游客身份访问
          </button>
          <button id="secret-setup-next" type="button" class="secret-gate-btn primary">
            下一步
          </button>
        </div>
      `;

      const pwdInput = document.getElementById('secret-setup-password');
      const pwdConfirmInput = document.getElementById(
        'secret-setup-password-confirm',
      );
      const errorEl = document.getElementById('secret-setup-error');
      const guestBtn = document.getElementById('secret-setup-guest');
      const nextBtn = document.getElementById('secret-setup-next');

      if (!pwdInput || !pwdConfirmInput || !guestBtn || !nextBtn) return;

      guestBtn.addEventListener('click', () => {
        setMode('guest');
        hide();
      });

      nextBtn.addEventListener('click', () => {
        const pwd = (pwdInput.value || '').trim();
        const pwd2 = (pwdConfirmInput.value || '').trim();
        const msg = validatePassword(pwd);
        if (msg) {
          if (errorEl) {
            errorEl.textContent = msg;
            errorEl.style.color = '#c00';
          }
          return;
        }
        if (pwd !== pwd2) {
          if (errorEl) {
            errorEl.textContent = '两次输入的密码不一致，请重新确认。';
            errorEl.style.color = '#c00';
          }
          return;
        }

        // 正式进入第 2 步
        renderInitStep2(pwd);
      });

      setTimeout(() => {
        try {
          pwdInput.focus();
        } catch {
          // ignore
        }
      }, 100);
    };

    // 统一渲染两种模式的 UI（仅使用新的两步初始化向导 / 解锁界面）
    // 同时在此处挂钩后台管理面板的“密钥配置”按钮入口，利用当前闭包中的 renderInitStep1/renderInitStep2
    try {
      window.DPRSecretSetup = window.DPRSecretSetup || {};
      window.DPRSecretSetup.openStep2 = function () {
        const savedPwd = loadSavedPassword();
        openSecretOverlay(overlay);
        // 确保浮层可见
        if (!savedPwd) {
          // 没有保存密码：从第 1 步开始完整向导
          renderInitStep1();
        } else {
          // 已保存密码：直接进入第 2 步配置向导
          renderInitStep2(savedPwd);
        }
      };
    } catch {
      // 忽略挂钩失败，后台按钮会走自身的降级提示
    }

    if (hasSecretFile) {
      // 已有 secret.private：展示“解锁 / 游客”界面
      renderUnlockUI();
    } else {
      // 不存在 secret.private：进入初始化两步向导
      renderInitStep1();
    }
  }

  function init() {
    const overlay = document.getElementById('secret-gate-overlay');
    const registerGuestOnlySecretSetup = () => {
      window.DPRSecretSetup = window.DPRSecretSetup || {};
      window.DPRSecretSetup.openStep2 = function () {
        enforceGuestMode(document.getElementById('secret-gate-overlay'));
        alert('当前域名已启用游客模式，不支持解锁密码与密钥配置。');
      };
    };

    // 默认视为锁定状态，直到用户选择“解锁 / 游客”
    window.DPR_ACCESS_MODE = FORCE_GUEST_MODE ? 'guest' : 'locked';

    if (FORCE_GUEST_MODE) {
      setAccessMode('guest', { mode: 'guest', reason: 'domain_force_guest' });
      registerGuestOnlySecretSetup();
      enforceGuestMode(overlay);
      return;
    }

    if (!overlay) return;

    // 检查是否已经存在 secret.private（用于区分“解锁”与“初始化”）
    (async () => {
      try {
        const resp = await fetch(SECRET_FILE_URL, {
          method: 'GET',
          cache: 'no-store',
        });
        let hasSecret = false;
        if (resp.ok) {
          try {
            // 不再依赖 content-type，只要能成功解析为 JSON，就认为是合法的 secret.private
            await resp.clone().json();
            hasSecret = true;
          } catch {
            hasSecret = false;
          }
        }

        window.DPR_ACCESS_MODE = 'locked';

        if (hasSecret) {
          // 已存在 secret.private：若浏览器保存了密码，先尝试自动解锁；
          // 成功则直接进入页面；失败或无密码则展示解锁/游客界面。
          const savedPwd = loadSavedPassword();
          if (savedPwd) {
            try {
              const resp2 = await fetch(SECRET_FILE_URL, {
                cache: 'no-store',
              });
              if (!resp2.ok) {
                throw new Error(
                  `获取 secret.private 失败，HTTP ${resp2.status}`,
                );
              }
              const payload = await resp2.json();
              const secret = await decryptSecret(savedPwd, payload);
              window.decoded_secret_private = secret;
              // 这里不在 setupOverlay 作用域内，直接标记全局访问模式为 full 并广播事件
              try {
                setAccessMode('full', { mode: 'full' });
              } catch {
                // ignore
              }
              // 自动解锁成功时，仍然初始化一次 overlay，以便后台“密钥配置”按钮可以直接打开第二步向导
              // 注意：此时不移除 hidden 类，浮层保持隐藏，仅注册 DPRSecretSetup.openStep2 等入口
              try {
                setupOverlay(true);
              } catch {
                // ignore
              }
              closeSecretOverlay(overlay);
              return;
            } catch (e) {
              console.error(
                '[SECRET] 自动解锁失败，将回退到手动输入密码界面：',
                e,
              );
              clearPassword();
            }
          }
          // 没有保存的密码或自动解锁失败：展示解锁/游客界面
          setupOverlay(true);
          openSecretOverlay(overlay);
        } else {
          // 不存在 secret.private：始终展示初始化向导
          setupOverlay(false);
          openSecretOverlay(overlay);
        }
      } catch {
        // 请求失败时按“文件不存在”处理：始终进入初始化向导
        window.DPR_ACCESS_MODE = 'locked';
        setupOverlay(false);
        openSecretOverlay(overlay);
      }
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
