// Docsify 配置与公共插件（评论区 + Zotero 元数据）
(() => {
  if (window.__dprSidebarCacheBusterInstalled) return;
  window.__dprSidebarCacheBusterInstalled = true;

  const refreshSidebarCacheBuster = () => {
    window.DPR_SIDEBAR_CACHE_BUSTER = `${Date.now()}`;
    return window.DPR_SIDEBAR_CACHE_BUSTER;
  };
  window.DPR_REFRESH_SIDEBAR_CACHE_BUSTER = refreshSidebarCacheBuster;
  refreshSidebarCacheBuster();

  const appendSidebarCacheBuster = (url) => {
    if (typeof url !== 'string') return url;
    const [beforeHash, hashPart = ''] = url.split('#');
    const pathPart = beforeHash.split('?')[0];
    if (!/(^|\/)_sidebar\.md$/i.test(pathPart)) return url;
    const token = encodeURIComponent(window.DPR_SIDEBAR_CACHE_BUSTER || refreshSidebarCacheBuster());
    const nextBeforeHash = /([?&])dpr_v=/.test(beforeHash)
      ? beforeHash.replace(/([?&]dpr_v=)[^&#]*/i, `$1${token}`)
      : `${beforeHash}${beforeHash.includes('?') ? '&' : '?'}dpr_v=${token}`;
    return `${nextBeforeHash}${hashPart ? `#${hashPart}` : ''}`;
  };

  window.DPRAppendSidebarCacheBuster = appendSidebarCacheBuster;

  if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype && XMLHttpRequest.prototype.open) {
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function dprOpen(method, url, ...rest) {
      return originalOpen.call(this, method, appendSidebarCacheBuster(url), ...rest);
    };
  }

  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (typeof Request !== 'undefined' && input instanceof Request) {
        const nextUrl = appendSidebarCacheBuster(input.url);
        if (nextUrl !== input.url) {
          return originalFetch(new Request(nextUrl, input), init);
        }
      }
      return originalFetch(appendSidebarCacheBuster(input), init);
    };
  }
})();

window.$docsify = {
  name:
    '<span class="dpr-brand"><img class="dpr-brand-logo" src="app/asserts/adpr-logo.svg" alt="" aria-hidden="true"><span class="dpr-brand-text">ADPR</span></span>',
  repo: '',
  // 文档内容与侧边栏都存放在 docs/ 下
  basePath: 'docs/', // 所有 Markdown 路由以 docs/ 为前缀
  loadSidebar: '_sidebar.md', // 在 basePath 下加载 _sidebar.md
  // 始终使用根目录的 _sidebar.md，避免每个子目录都要放一份
  alias: {
    '/.*/_sidebar.md': '/_sidebar.md',
  },
  // 只在侧边栏展示论文列表标题，不展示文内小节（例如 Abstract）
  subMaxLevel: 0,

  // --- 核心：注册自定义插件 ---
  plugins: [
    function (hook, vm) {
      // 确保 marked 开启 GFM 表格支持，并允许内联 HTML（用于聊天区 Markdown 渲染）
      if (window.marked && window.marked.setOptions) {
        const baseOptions =
          (window.marked.getDefaults && window.marked.getDefaults()) || {};
        window.marked.setOptions(
          Object.assign({}, baseOptions, {
            gfm: true,
            breaks: false,
            tables: true,
            // 允许 <sup> 等内联 HTML 直接渲染，而不是被转义
            sanitize: false,
            mangle: false,
            headerIds: false,
          }),
        );
      }

      // 1. 解析当前文章 ID (简单用文件名作为 ID)
      const getPaperId = () => {
        return vm.route.file.replace('.md', '');
      };

      const metaFallbacks = {
        citation_title: 'Daily Paper Reader Default Entry',
        citation_journal_title: 'arxiv',
        citation_pdf_url: 'https://daily-paper-reader.invalid/default.pdf',
        citation_publication_date: '2024-01-01',
        citation_date: '2024/01/01',
      };

      const defaultAuthors = ['Daily Paper Reader Team', 'Docsify Renderer'];

      const stripSidebarEmoji = (value) =>
        String(value || '')
          .replace(/^(?:[\s\uFE0F\u200D]*(?:[\u2600-\u27BF]|[\u{1F300}-\u{1FAFF}])\uFE0F?\s*)+/u, '')
          .trim();

      window.DPRSidebarUtils = Object.assign({}, window.DPRSidebarUtils || {}, {
        stripSidebarEmoji,
      });

      // Zotero 摘要结构标记：方便后续在 Zotero 插件中重新解析
      const START_MARKER = '【🤖 AI Summary】';
      const CHAT_MARKER = '【💬 Chat History】';
      const ORIG_MARKER = '【📄 Original Abstract】';
      const TLDR_MARKER = '【📝 TLDR】';
      const GLANCE_MARKER = '【🧭 速览区】';
      const GLANCE_MARKER_LEGACY = '【🧭 Glance】';
      const DETAIL_MARKER = '【🧩 论文详细总结区】';
      const DETAIL_MARKER_LEGACY = '【🧩 论文详细总结】';
      let latestPaperRawMarkdown = '';

      const extractSectionByTitle = (rawContent, matchFn) => {
        if (!rawContent || typeof rawContent !== 'string') return '';
        const contentWithoutFrontMatter = rawContent
          .replace(/^---[\s\S]*?---\s*/, '')
          .replace(/\r\n/g, '\n');
        const lines = contentWithoutFrontMatter.split('\n');
        let headingIndex = -1;
        for (let i = 0; i < lines.length; i += 1) {
          const m = lines[i].match(/^#{1,6}\s+(.*)$/);
          if (!m) continue;
          if (matchFn(m[1])) {
            headingIndex = i;
            break;
          }
        }
        if (headingIndex < 0) return '';

        const chunk = [];
        for (
          let i = headingIndex + 1;
          i < lines.length && !/^#{1,6}\s+/.test(lines[i]);
          i += 1
        ) {
          chunk.push(lines[i]);
        }
        return chunk.join('\n').trim();
      };

      const escapeRegExp = (value) =>
        String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const normalizeTextForMeta = (value) =>
        (value || '').toString().replace(/\r\n/g, '\n').trim();
      const CITATION_ABSTRACT_BR = '__BR__';
      const encodeCitationAbstractForMeta = (value) =>
        normalizeTextForMeta(value)
          .replace(/\r/g, '\n')
          .replace(/\n/g, CITATION_ABSTRACT_BR);

      const trimBeforeMarkers = (value, markers) => {
        const text = normalizeTextForMeta(value);
        if (!text) return '';
        const indices = markers
          .map((marker) => text.indexOf(marker))
          .filter((idx) => idx >= 0)
          .sort((a, b) => a - b);
        if (indices.length === 0) return text;
        return text.slice(0, indices[0]).trim();
      };

      const cleanSectionText = (value) => {
        let text = normalizeTextForMeta(value);
        if (!text) return '';

        text = trimBeforeMarkers(text, [
          CHAT_MARKER,
          ORIG_MARKER,
          START_MARKER,
          TLDR_MARKER,
          GLANCE_MARKER,
          GLANCE_MARKER_LEGACY,
          DETAIL_MARKER,
          DETAIL_MARKER_LEGACY,
        ]);
        text = text.replace(new RegExp(`^\\s*${escapeRegExp(START_MARKER)}\\s*\\n?`, 'i'), '');
        text = text.replace(new RegExp(`^\\s*${escapeRegExp(ORIG_MARKER)}\\s*\\n?`, 'i'), '');
        text = text.replace(new RegExp(`^\\s*${escapeRegExp(CHAT_MARKER)}\\s*\\n?`, 'i'), '');
        text = text.replace(new RegExp(`^\\s*${escapeRegExp(TLDR_MARKER)}\\s*\\n?`, 'i'), '');
        text = text.replace(new RegExp(`^\\s*${escapeRegExp(GLANCE_MARKER)}\\s*\\n?`, 'i'), '');
        text = text.replace(
          new RegExp(`^\\s*${escapeRegExp(GLANCE_MARKER_LEGACY)}\\s*\\n?`, 'i'),
          '',
        );
        text = text.replace(new RegExp(`^\\s*${escapeRegExp(DETAIL_MARKER)}\\s*\\n?`, 'i'), '');
        text = text.replace(
          new RegExp(`^\\s*${escapeRegExp(DETAIL_MARKER_LEGACY)}\\s*\\n?`, 'i'),
          '',
        );
        text = text.replace(/^Tags:\s*.*$/gim, '');
        text = text.replace(/^>?\s*由\s*daily-paper-reader\s*自动生成\s*$/gim, '');
        return text.trim();
      };

      const parseDateFromText = (value) => {
        const text = normalizeTextForMeta(value);
        if (!text) return '';
        const ymdMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (ymdMatch) {
          return `${ymdMatch[1]}-${ymdMatch[2]}-${ymdMatch[3]}`;
        }
        const date8Match = text.match(/(\d{4})(\d{2})(\d{2})/);
        if (date8Match && text.indexOf('/') === -1 && text.indexOf('.') === -1) {
          return `${date8Match[1]}-${date8Match[2]}-${date8Match[3]}`;
        }
        return '';
      };

      const splitRawSectionByTitle = (rawContent, shouldMatchTitle) => {
        const source = (rawContent || '').toString();
        const parsed = parseFrontMatter(source);
        const body = (parsed && parsed.body) || source;
        const lines = normalizeTextForMeta(body).split('\n');
        const headingMeta = (lineText) => {
          const normalized = normalizeTextForMeta(lineText).trim();
          const match = normalized.match(/^(#{1,6})\s+(.*)$/);
          if (!match) return null;
          return {
            level: match[1].length,
            title: normalizeTextForMeta(match[2]),
          };
        };
        const isBoundary = (lineText, sectionHeadingLevel) => {
          const t = normalizeTextForMeta(lineText);
          if (!t) return false;
          if (
            t.startsWith(START_MARKER) ||
            t.startsWith(CHAT_MARKER) ||
            t.startsWith(ORIG_MARKER) ||
            t.startsWith(TLDR_MARKER) ||
            t.startsWith(GLANCE_MARKER) ||
            t.startsWith(GLANCE_MARKER_LEGACY) ||
            t.startsWith(DETAIL_MARKER)
            || t.startsWith(DETAIL_MARKER_LEGACY)
          ) {
            return true;
          }
          const heading = headingMeta(lineText);
          if (heading && sectionHeadingLevel) {
            return heading.level <= sectionHeadingLevel;
          }
          return /^#{1,6}\s+/.test(t);
        };

        const extractHeadingTitle = (lineText) => {
          const normalized = normalizeTextForMeta(lineText).trim();
          if (!normalized) return '';
          if (normalized.startsWith(START_MARKER)) return START_MARKER;
          if (normalized.startsWith(CHAT_MARKER)) return CHAT_MARKER;
            if (normalized.startsWith(ORIG_MARKER)) return ORIG_MARKER;
            if (normalized.startsWith(TLDR_MARKER)) return TLDR_MARKER;
            if (normalized.startsWith(GLANCE_MARKER)) return GLANCE_MARKER;
            if (normalized.startsWith(GLANCE_MARKER_LEGACY)) return GLANCE_MARKER_LEGACY;
            if (normalized.startsWith(DETAIL_MARKER)) return DETAIL_MARKER;
            if (normalized.startsWith(DETAIL_MARKER_LEGACY)) return DETAIL_MARKER_LEGACY;
          return normalized.replace(/^#{1,6}\s*/, '');
        };

        let start = -1;
        let sectionHeadingLevel = 1;
        for (let i = 0; i < lines.length; i += 1) {
          const title = extractHeadingTitle(lines[i]);
          if (!title) continue;
          if (shouldMatchTitle(title)) {
            start = i;
            const heading = headingMeta(lines[i]);
            sectionHeadingLevel = heading ? heading.level : 1;
            break;
          }
        }
        if (start < 0) {
          return '';
        }

        let end = lines.length;
        for (let j = start + 1; j < lines.length; j += 1) {
          if (isBoundary(lines[j], sectionHeadingLevel)) {
            end = j;
            break;
          }
        }
        return lines
          .slice(start + 1, end)
          .join('\n')
          .trim();
      };

      const getRawPaperSections = (rawContent) => {
        const helper =
          window.DPRZoteroMetaUtils &&
          typeof window.DPRZoteroMetaUtils.getRawPaperSections === 'function'
            ? window.DPRZoteroMetaUtils.getRawPaperSections
            : null;
        if (helper) {
          return helper(rawContent);
        }
        return {
          aiSummaryText: splitRawSectionByTitle(
            rawContent,
            (title) => {
              const t = normalizeTextForMeta(title).replace(/^\s*#{1,6}\s*/, '').trim().toLowerCase();
              return (
                t.includes('论文详细总结') ||
                t.includes('论文详细总结（自动生成）') ||
                t.includes('ai summary') ||
                t.includes('🤖 ai summary')
              );
            },
          ),
          originalAbstractText: splitRawSectionByTitle(
            rawContent,
            (title) => {
              const t = normalizeTextForMeta(title)
                .replace(/^\s*#{1,6}\s*/, '')
                .trim()
                .toLowerCase();
              return (
                t === 'abstract' ||
                t.includes('原文摘要') ||
                t.includes('original abstract')
              );
            },
          ),
          tldrText: splitRawSectionByTitle(
            rawContent,
            (title) => {
              const t = normalizeTextForMeta(title)
                .replace(/^\s*#{1,6}\s*/, '')
                .trim()
                .toLowerCase();
              return t.includes('tldr') || t.includes('tl;dr') || t.includes('摘要要点');
            },
          ),
        };
      };

      const collectPaperBodySections = (sectionEl) => {
        if (!sectionEl || !sectionEl.children) return [];

        const headingTag = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'];
        const shouldSkipHeadingBlock = (headingText) => {
          const text = normalizeTextForMeta(headingText || '').toLowerCase();
          if (!text) return false;
          const blocked = [
            'paper-title-row',
            'paper-meta-row',
            'paper-glance-section',
            '互动区',
            '页面导航与交互层',
            '原文摘要',
            'original abstract',
            '论文详细总结',
            'ai summary',
            'chat history',
          ];
          return blocked.some((token) => text.includes(token));
        };

        const shouldSkipNode = (node) =>
          !!(
            node &&
            node.classList &&
            (node.classList.contains('paper-title-row') ||
              node.classList.contains('paper-meta-row') ||
              node.classList.contains('paper-glance-section') ||
              node.classList.contains('paper-title-cn') ||
              node.classList.contains('paper-title-en'))
          );
        const sections = [];
        let currentTitle = '📝 论文正文';
        let currentContent = [];
        let seenHeading = false;
        let skipCurrentSection = false;
        const collectText = (node) => normalizeTextForMeta(node && (node.innerText || node.textContent || ''));

        const flush = () => {
          const text = trimBeforeMarkers(collectText({ innerText: currentContent.join('\n') }), []);
          const cleanText = text.replace(/\n{3,}/g, '\n\n').trim();
          if (cleanText) {
            sections.push({
              title: currentTitle,
              text: cleanText,
            });
          }
          currentContent = [];
        };

        const children = Array.from(sectionEl.children);
        for (const child of children) {
          const tag = child.tagName || '';
          if (shouldSkipNode(child)) {
            flush();
            continue;
          }
          if (
            child.id === 'paper-chat-container' ||
            (child.querySelector && child.querySelector('#paper-chat-container'))
          ) {
            flush();
            continue;
          }

          if (headingTag.includes(tag)) {
            flush();
            const text = normalizeTextForMeta(child.innerText || '').trim();
            skipCurrentSection = shouldSkipHeadingBlock(text);
            if (skipCurrentSection) {
              continue;
            }
            if (text) {
              currentTitle = text;
              seenHeading = true;
            }
            continue;
          }
          if (skipCurrentSection) {
            continue;
          }

          const txt = collectText(child).replace(/\n{2,}/g, '\n').trim();
          if (!txt) {
            continue;
          }
          currentContent.push(txt);
          seenHeading = true;
        }

        if (seenHeading) {
          flush();
        } else {
          const fallback = collectText(sectionEl);
          if (fallback) {
            sections.push({
              title: currentTitle,
              text: fallback,
            });
          }
        }
        return sections;
      };

      // Zotero 元数据更新函数：可被 Docsify 生命周期和聊天模块重复调用
      const updateZoteroMetaFromPage = async (
        paperId,
        vmRouteFile,
        rawPaperContent = '',
      ) => {
        try {
          // 优先使用自定义标题条（避免 h1 被隐藏/改造后 innerText 不稳定）
          const dprEn = document.querySelector('.dpr-title-en');
          const dprCn = document.querySelector('.dpr-title-cn');
          let title = '';
          if (dprEn && (dprEn.textContent || '').trim()) {
            title = (dprEn.textContent || '').trim();
          } else if (dprCn && (dprCn.textContent || '').trim()) {
            title = (dprCn.textContent || '').trim();
          } else {
            const titleEl = document.querySelector('.markdown-section h1');
            title = titleEl ? (titleEl.textContent || '').trim() : document.title;
          }
          if (title) {
            // 清理标题中的多余空白与插件注入内容
            title = title.replace(/\s+/g, ' ').trim();
          }

          let pdfLinkEl = document.querySelector('a[href*="arxiv.org/pdf"]');
          if (!pdfLinkEl) {
            pdfLinkEl = document.querySelector('a[href$=".pdf"]');
          }

          let pdfUrl = '';
          if (pdfLinkEl) {
            pdfUrl = new URL(pdfLinkEl.href, window.location.href).href;
          }

          const frontmatterPaperMeta = (() => {
            try {
              const parsed = parseFrontMatter(rawPaperContent || '');
              return parsed && parsed.meta ? parsed.meta : {};
            } catch {
              return {};
            }
          })();

          let date = parseDateFromText(frontmatterPaperMeta.date);
          if (!date) {
            const matchDate = vmRouteFile
              ? vmRouteFile.match(/(\d{4}-\d{2}-\d{2})/)
              : null;
            if (matchDate) {
              date = matchDate[1];
            }
          }
          if (!date) {
            const matchFolderDate = vmRouteFile
              ? vmRouteFile.match(/(?:^|\/)(\d{4})(\d{2})\/(\d{2})(?:\/|$)/)
              : null;
            if (matchFolderDate) {
              date = `${matchFolderDate[1]}-${matchFolderDate[2]}-${matchFolderDate[3]}`;
            }
          }
          if (!date) {
            date = parseDateFromText(frontmatterPaperMeta.published);
          }
          if (!date) {
            date = parseDateFromText(frontmatterPaperMeta.submitted);
          }
          if (!date) {
            date = parseDateFromText(frontmatterPaperMeta.submit_date);
          }
          if (!date && vmRouteFile) {
            const routeMatch = vmRouteFile.match(/(\d{6})\/(\d{2})/);
            if (routeMatch) {
              const yyyymm = routeMatch[1];
              date = `${yyyymm.slice(0, 4)}-${yyyymm.slice(4)}-${routeMatch[2]}`;
            }
          }
          const citationDate = date ? date.replace(/-/g, '/') : '';

          let authors = [];
          document.querySelectorAll('.markdown-section p').forEach((p) => {
            if (p.innerText.includes('Authors:')) {
              let text = p.innerText.replace('Authors:', '').trim();
              // 清理可能被其它扩展注入的换行和尾部信息，以及尾部日期
              text = text.replace(/\s+/g, ' ').trim();
              text = text
                .replace(/Date\s*:\s*\d{4}-\d{2}-\d{2}.*/i, '')
                .trim();
              authors = text
                .split(/,|，/)
                .map((a) => a.trim())
                .filter(Boolean);
            }
          });

          updateMetaTag('citation_title', title);
          updateMetaTag('citation_journal_title', 'arxiv');
          updateMetaTag('citation_pdf_url', pdfUrl, {
            useFallback: false,
          });
          updateMetaTag('citation_publication_date', date, { useFallback: false });
          updateMetaTag('citation_date', citationDate, { useFallback: false });

          const {
            aiSummaryText: rawSummary,
            originalAbstractText: rawOriginal,
            tldrText: rawTldrText,
          } =
            getRawPaperSections(rawPaperContent || '');

          // 每次路由刷新先清理上一个页面注入的摘要 meta，避免重复残留
          clearSummaryMetaFields();

          // 构造给 Zotero 用的“摘要”元信息：按「AI 总结 / 对话历史 / 原始摘要」分段组织
          let abstractText = '';
          let abstractTextForMetaRaw = '';
          const sectionEl = document.querySelector('.markdown-section');
          if (sectionEl) {
            let aiSummaryText = rawSummary;
            let origAbstractText = rawOriginal;
            aiSummaryText = cleanSectionText(aiSummaryText);
            origAbstractText = cleanSectionText(origAbstractText);

            // 3) 解析聊天历史，优先读取本地原始聊天记录，避免从 DOM innerText 读公式时被拆碎
            let chatSection = '';
            const buildChatLinesFromMessages =
              window.DPRZoteroChatUtils &&
              typeof window.DPRZoteroChatUtils.buildChatLinesFromMessages === 'function'
                ? window.DPRZoteroChatUtils.buildChatLinesFromMessages
                : null;
            const storedChat = await loadChatHistoryForPaper(paperId);
            const storedLines = buildChatLinesFromMessages
              ? buildChatLinesFromMessages(storedChat)
              : [];
            if (storedLines.length) {
              chatSection = storedLines.join('\n\n');
            } else {
              const chatRoot = document.getElementById('chat-history');
              if (chatRoot) {
                const items = chatRoot.querySelectorAll('.msg-item');
                const lines = [];
                const inferSpeaker =
                  window.DPRZoteroChatUtils &&
                  typeof window.DPRZoteroChatUtils.inferSpeaker === 'function'
                    ? window.DPRZoteroChatUtils.inferSpeaker
                    : ({ roleText = '', className = '' } = {}) => {
                        const role = String(roleText || '').trim();
                        const cls = String(className || '').trim();
                        if (role.includes('思考过程')) return '';
                        if (role.includes('你')) return 'User';
                        if (role.includes('助手')) return 'AI';
                        if (/\bmsg-content-user\b/.test(cls)) return 'User';
                        if (/\bmsg-content-ai\b/.test(cls)) return 'AI';
                        return '';
                      };
                items.forEach((item) => {
                  const roleEl = item.querySelector('.msg-role');
                  const contentEl = item.querySelector('.msg-content');
                  if (!contentEl) return;
                  const roleText = roleEl ? (roleEl.textContent || '') : '';
                  const speaker = inferSpeaker({
                    roleText,
                    className: contentEl.className || '',
                  });
                  if (!speaker) return;
                  const contentText = (contentEl.innerText || '').trim();
                  if (!contentText) return;
                  const icon = speaker === 'User' ? '👤' : '🤖';
                  lines.push(`${icon} ${speaker}: ${contentText}`);
                });
                if (lines.length) {
                  chatSection = lines.join('\n\n');
                }
              }
            }

            chatSection = cleanSectionText(chatSection);

            const parts = [];
            const seenBlocks = new Set();
            const seenTitles = new Set();
            const cleanText = (value) => cleanSectionText(normalizeTextForMeta(value));
            const rawParts = [];
            const seenRawBlocks = new Set();
            const addMetaSectionBlock = (title, content) => {
              const cleanText = cleanSectionText(content);
              if (!cleanText) return;
              const titleKey = normalizeTextForMeta(title)
                .toLowerCase()
                .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
              const contentKey = cleanText
                .toLowerCase()
                .replace(/\s+/g, '')
                .replace(/[#>*_`[\]]/g, '');
              const signature = `${titleKey}|${contentKey}`;
              if (seenTitles.has(titleKey) && seenBlocks.has(signature)) {
                return;
              }
              seenTitles.add(titleKey);
              if (seenBlocks.has(signature)) return;
              seenBlocks.add(signature);
              parts.push(`## ${title}\n${cleanText}`);
            };
            const normalizeMarkerTitle = (label) => {
              const raw = normalizeTextForMeta(label).trim();
              if (!raw) return "";
              if (raw === START_MARKER) return "🤖 AI Summary";
              if (raw === CHAT_MARKER) return "💬 Chat History";
              if (raw === ORIG_MARKER) return "📄 Original Abstract";
              if (raw === TLDR_MARKER) return "📝 TLDR";
              if (raw === GLANCE_MARKER || raw === GLANCE_MARKER_LEGACY) return "🧭 速览区";
              if (raw === DETAIL_MARKER || raw === DETAIL_MARKER_LEGACY) return "🧩 论文详细总结区";
              return raw.replace(/^#{1,6}\s*/, '');
            };
            const addRawMetaBlock = (label, content) => {
              const text = normalizeTextForMeta(content);
              if (!text) return;
              const sectionTitle = normalizeMarkerTitle(label);
              const signature = `${sectionTitle}|${text.replace(/\s+/g, ' ')}`;
              if (seenRawBlocks.has(signature)) return;
              seenRawBlocks.add(signature);
              rawParts.push(`## ${sectionTitle}\n${text}`);
            };
            const addMetaBlock = (label, content) => {
              const cleanText = cleanSectionText(content);
              if (!cleanText) return;
              const signature = cleanText.replace(/\s+/g, ' ');
              if (seenBlocks.has(signature)) return;
              seenBlocks.add(signature);
              const sectionTitle = normalizeMarkerTitle(label);
              parts.push(`## ${sectionTitle}\n${cleanText}`);
            };
            const parseLabelLine = (line) => {
              const raw = normalizeTextForMeta(line || '').trim();
              if (!raw) return null;
              const lineText = raw
                .replace(/^[\-\*]\s*/, '')
                .replace(/^\*\*(.*?)\*\*\s*:?\s*/, '$1:');
              const m = lineText.match(/^(.+?)\s*[:：]\s*(.*)$/);
              if (!m) return null;
              return [normalizeTextForMeta(m[1]).trim(), normalizeTextForMeta(m[2]).trim()];
            };
            const pickFirst = (labelList, fallbackValue) => {
              for (const item of labelList) {
                if (item) return item;
              }
              return fallbackValue || '';
            };
            const normalizeTagValue = (value) =>
              normalizeTextForMeta(value || '')
                .replace(/\s+/g, ' ')
                .trim();

            const collectLabeledPairs = (rows) => {
              const map = new Map();
              rows.forEach((line) => {
                const parsed = parseLabelLine(line);
                if (!parsed) return;
                const [label, value] = parsed;
                if (!label || !value) return;
                const key = label.toLowerCase();
                if (!map.has(key) || normalizeTagValue(map.get(key)).length < value.length) {
                  map.set(key, value);
                }
              });
              return map;
            };
            const buildLabeledText = (map, order) => {
              const lines = [];
              order.forEach((label) => {
                const key = normalizeTextForMeta(label).toLowerCase();
                if (map.has(key)) {
                  lines.push(`- **${label}**: ${map.get(key)}`);
                }
              });
              map.forEach((value, key) => {
                if (!order.includes(key)) {
                  lines.push(`- **${key}**: ${value}`);
                }
              });
              return lines.join('\n');
            };

            const splitBlockText = (text) => {
              const normalized = normalizeTextForMeta(text || '');
              if (!normalized) return [];
              return normalized
                .split('\n')
                .map((item) => item.trim())
                .filter(Boolean);
            };
            const getNodeText = (el) =>
              normalizeTextForMeta(el && (el.innerText || el.textContent || ''));
            const titleZhText = getNodeText(
              document.querySelector('.paper-title-row .paper-title-zh'),
            ) || getNodeText(document.querySelector('.paper-title-zh'));
            const titleEnText = getNodeText(
              document.querySelector('.paper-title-row .paper-title-en'),
            ) || getNodeText(document.querySelector('.dpr-title-en'));
            const metaLeftRows = Array.from(
              document.querySelectorAll('.paper-meta-left p'),
            ).flatMap((el) => splitBlockText(getNodeText(el)));
            const metaRightRows = Array.from(
              document.querySelectorAll('.paper-meta-right p'),
            ).flatMap((el) => splitBlockText(getNodeText(el)));
            const glanceRows = Array.from(
              document.querySelectorAll('.paper-glance-col'),
            ).map((col) => {
              const label = getNodeText(
                col.querySelector('.paper-glance-label'),
              );
              const content = getNodeText(
                col.querySelector('.paper-glance-content'),
              );
              if (!label && !content) return '';
              return `- **${label || '项'}**: ${content || '-'}`;
            });
            const fallbackArray = (value, label = '') =>
              value ? [`- **${label}**: ${Array.isArray(value) ? value.join(' / ') : String(value)}`] : [];

            const titleRowText = [
              `- **中英文标题**: ${titleZhText || frontmatterPaperMeta.title_zh || '-'} / ${titleEnText || frontmatterPaperMeta.title || '-'}`,
            ].filter(Boolean);

            const metaPairs = collectLabeledPairs([...metaLeftRows, ...metaRightRows]);
            const fallbackMetaPairs = collectLabeledPairs([
              ...fallbackArray(frontmatterPaperMeta.evidence, 'Evidence'),
              ...fallbackArray(frontmatterPaperMeta.tldr, 'TLDR'),
              ...fallbackArray(frontmatterPaperMeta.authors, 'Authors'),
              ...fallbackArray(frontmatterPaperMeta.date, 'Date'),
              ...fallbackArray(frontmatterPaperMeta.pdf, 'PDF'),
              ...fallbackArray(frontmatterPaperMeta.tags, 'Tags'),
              ...fallbackArray(frontmatterPaperMeta.score, 'Score'),
            ]);
            ['Evidence', 'TLDR', 'Authors', 'Date', 'PDF', 'Tags', 'Score'].forEach(
              (label) => {
                const key = label.toLowerCase();
                if (!metaPairs.has(key)) {
                  const value = normalizeTagValue(
                    fallbackMetaPairs.get(key) || '',
                  );
                  if (value) metaPairs.set(key, value);
                }
              },
            );
            const glancePairs = collectLabeledPairs(glanceRows);
            const fallbackGlancePairs = collectLabeledPairs([
              ...fallbackArray(frontmatterPaperMeta.motivation, 'Motivation'),
              ...fallbackArray(frontmatterPaperMeta.method, 'Method'),
              ...fallbackArray(frontmatterPaperMeta.result, 'Result'),
              ...fallbackArray(frontmatterPaperMeta.conclusion, 'Conclusion'),
            ]);
            ['Motivation', 'Method', 'Result', 'Conclusion'].forEach((label) => {
              const key = label.toLowerCase();
              if (!glancePairs.has(key)) {
                const value = normalizeTagValue(
                  fallbackGlancePairs.get(key) || '',
                );
                if (value) glancePairs.set(key, value);
              }
            });

            const titleBarEl = document.querySelector('.dpr-title-bar');
            const pageContentEl = document.querySelector('.dpr-page-content');
            const chatContainerEl = document.getElementById('paper-chat-container');
            const chatHistoryEl = document.getElementById('chat-history');
            const uiRows = [
              `- **dpr-title-bar**: ${titleBarEl ? '已挂载' : '未检测到'}`,
              `- **dpr-page-content**: ${pageContentEl ? '已挂载' : '未检测到'}`,
              `- **paper-title-row**: ${document.querySelector('.paper-title-row') ? '已挂载' : '未检测到'}`,
              `- **paper-meta-row**: ${document.querySelector('.paper-meta-row') ? '已挂载' : '未检测到'}`,
              `- **paper-glance-section**: ${document.querySelector('.paper-glance-section') ? '已挂载' : '未检测到'}`,
              `- **#paper-chat-container**: ${chatContainerEl ? '已挂载' : '未检测到'}`,
              `- **#chat-history**: ${chatHistoryEl ? '已挂载' : '未检测到'}`,
            ];

            addMetaSectionBlock(
              'paper-title-row（双语标题区域）',
              titleRowText.join('\n'),
            );
            addMetaSectionBlock(
              'paper-meta-row（中间信息区）',
              cleanText(
                buildLabeledText(
                  metaPairs,
                  ['evidence', 'tldr', 'authors', 'date', 'pdf', 'tags', 'score'],
                ),
              ),
            );
            const tldrText = pickFirst(
              [
                rawTldrText,
                metaPairs.get('tldr'),
                fallbackMetaPairs.get('tldr'),
              ],
              '',
            );
            if (tldrText) {
              addMetaBlock(TLDR_MARKER, normalizeTagValue(tldrText));
              addRawMetaBlock(TLDR_MARKER, normalizeTagValue(tldrText));
            }
            const glanceText = cleanText(
              buildLabeledText(glancePairs, [
                'motivation',
                'method',
                'result',
                'conclusion',
              ]),
            );
            if (glanceText) {
              addMetaBlock(GLANCE_MARKER, glanceText);
              addRawMetaBlock(GLANCE_MARKER, glanceText);
            }
            addMetaSectionBlock(
              '页面导航与交互层',
              cleanText(uiRows.join('\n')),
            );

            // 1) 全文段落：按页面 heading 自动切块，保持顺序写入
            const paperBodySections = collectPaperBodySections(sectionEl);
            paperBodySections.forEach((section) => {
              if (section && section.text) {
                addMetaSectionBlock(section.title, section.text);
              }
            });

            if (aiSummaryText) {
              // AI Summary 区块：仅保留 AI 摘要正文，不再自动拼入 Tags
              let aiBlock = `${START_MARKER}\n`;
              if (aiSummaryText) {
                aiBlock += aiSummaryText;
              }
              addMetaBlock(START_MARKER, aiBlock);
              addRawMetaBlock(
                START_MARKER,
                [rawSummary]
                  .filter(Boolean)
                  .join('\n\n'),
              );
            }
            if (chatSection) {
              addMetaBlock(CHAT_MARKER, chatSection);
              addRawMetaBlock(CHAT_MARKER, chatSection);
            }
            if (origAbstractText) {
              addMetaBlock(ORIG_MARKER, origAbstractText);
              addRawMetaBlock(ORIG_MARKER, rawOriginal);
            }

            // 兜底 raw 聚合：确保保留 AI Summary / Original Abstract 原始 Markdown
            // （避免经过 DOM 文本化路径后公式被改写）
            abstractText = parts.join('\n\n\n').trim();
            abstractTextForMetaRaw = rawParts.join('\n\n\n').trim();
          }

          if (abstractText) {
            const abstractTextForMeta =
              abstractTextForMetaRaw || abstractText;
            if (abstractTextForMeta) {
              // 用 Zotero Connector 常识别的字段名：citation_abstract
              // 用占位符编码换行，避免 Connector 导入时丢失段落边界
              const metaText = encodeCitationAbstractForMeta(abstractTextForMeta);
              updateMetaTag('citation_abstract', metaText, {
                useFallback: false,
              });
            }
          }

          document
            .querySelectorAll('meta[name="citation_author"]')
            .forEach((el) => el.remove());
          const authorList = authors.length ? authors : defaultAuthors;
          authorList.forEach((author) => {
            const meta = document.createElement('meta');
            meta.name = 'citation_author';
            meta.content = author;
            document.head.appendChild(meta);
          });

          document.dispatchEvent(
            new Event('ZoteroItemUpdated', {
              bubbles: true,
              cancelable: true,
            }),
          );
        } catch (e) {
          console.error('Zotero meta update failed:', e);
        }
      };

      // 导出给其它前端模块（例如聊天模块）主动刷新 Zotero 元数据
      window.DPRZoteroMeta = window.DPRZoteroMeta || {};
      window.DPRZoteroMeta.updateFromPage = (paperId, vmRouteFile) =>
        Promise.resolve(
          updateZoteroMetaFromPage(paperId, vmRouteFile, latestPaperRawMarkdown),
        ).catch((e) => {
          console.error('Zotero meta update failed:', e);
        });

      // 公共工具：在指定元素上渲染公式
      const renderMathInEl = (el) => {
        if (!window.renderMathInElement || !el) return;
        window.renderMathInElement(el, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\[', right: '\\]', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
          ],
          throwOnError: false,
        });
      };

      const normalizeMarkdownMathDelimiters = (markdown) => {
        let text = String(markdown || '');
        const codeBlocks = [];
        text = text.replace(
          /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g,
          (match) => {
            const idx = codeBlocks.length;
            codeBlocks.push(match);
            return `%%DPR_CODE_BLOCK_${idx}%%`;
          },
        );

        const inlineCodes = [];
        text = text.replace(/`[^`\n]*`/g, (match) => {
          const idx = inlineCodes.length;
          inlineCodes.push(match);
          return `%%DPR_INLINE_CODE_${idx}%%`;
        });

        const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
        const CJK_TEXT_PUNCT_RE = /[，。、；：！？]/;
        const TEX_TEXT_COMMAND_RE =
          /\\(?:text|operatorname|mathrm|mathbf|mathit|mathsf|emph)\s*\{[^{}]*\}/g;

        const protectTexTextCommands = (expr) => {
          const commands = [];
          const protectedExpr = String(expr || '').replace(TEX_TEXT_COMMAND_RE, (match) => {
            const idx = commands.length;
            commands.push(match);
            return `%%DPR_TEX_TEXT_${idx}%%`;
          });
          const restore = (value) =>
            String(value || '').replace(
              /%%DPR_TEX_TEXT_(\d+)%%/g,
              (_match, idx) => commands[Number(idx)] || '',
            );
          return { protectedExpr, restore };
        };

        const normalizeMathPunctuation = (expr) =>
          String(expr || '')
            .replace(/[，、]\s*/g, ', ')
            .replace(/；\s*/g, '; ')
            .replace(/：\s*/g, ': ')
            .replace(/。/g, '.')
            .replace(/（/g, '(')
            .replace(/）/g, ')')
            .replace(/＝/g, '=')
            .replace(/[＋﹢]/g, '+')
            .replace(/[－−]/g, '-')
            .replace(/／/g, '/');

        const hasCjkText = (value) => CJK_CHAR_RE.test(String(value || ''));

        const hasNearbyCjkText = (value, index) => {
          const textValue = String(value || '');
          const start = Math.max(0, index - 8);
          const end = Math.min(textValue.length, index + 9);
          return CJK_CHAR_RE.test(textValue.slice(start, index))
            || CJK_CHAR_RE.test(textValue.slice(index + 1, end));
        };

        const isNarrativeChar = (value, index) => {
          const ch = value[index];
          if (CJK_CHAR_RE.test(ch)) return true;
          if (CJK_TEXT_PUNCT_RE.test(ch) && hasNearbyCjkText(value, index)) return true;
          return false;
        };

        const splitMathAndNarrative = (expr) => {
          const value = String(expr || '');
          const parts = [];
          let mathBuffer = '';
          let i = 0;

          const flushMath = () => {
            if (!mathBuffer.trim()) {
              mathBuffer = '';
              return;
            }
            parts.push({ type: 'math', value: mathBuffer });
            mathBuffer = '';
          };

          while (i < value.length) {
            if (!isNarrativeChar(value, i)) {
              mathBuffer += value[i];
              i += 1;
              continue;
            }

            flushMath();
            let textBuffer = '';
            while (i < value.length) {
              const ch = value[i];
              if (isNarrativeChar(value, i) || (/\s/.test(ch) && textBuffer)) {
                textBuffer += ch;
                i += 1;
                continue;
              }
              break;
            }
            if (textBuffer) {
              parts.push({ type: 'text', value: textBuffer });
            }
          }

          flushMath();
          return parts;
        };

        const normalizeInlineMathExpression = (expr) => {
          const { protectedExpr, restore } = protectTexTextCommands(expr);
          if (!hasCjkText(protectedExpr)) {
            return `$${restore(normalizeMathPunctuation(protectedExpr))}$`;
          }
          const parts = splitMathAndNarrative(protectedExpr);
          return parts
            .map((part) => {
              if (part.type === 'text') return part.value;
              return `$${restore(normalizeMathPunctuation(part.value))}$`;
            })
            .join('')
            .replace(/\$\s*\$/g, '');
        };

        const normalizeDisplayMathExpression = (expr) => {
          const { protectedExpr, restore } = protectTexTextCommands(expr);
          if (!hasCjkText(protectedExpr)) {
            return `$$${restore(normalizeMathPunctuation(protectedExpr))}$$`;
          }
          const parts = splitMathAndNarrative(protectedExpr);
          return parts
            .map((part) => {
              if (part.type === 'text') return part.value;
              return `$$${restore(normalizeMathPunctuation(part.value))}$$`;
            })
            .join('')
            .replace(/\$\$\s*\$\$/g, '');
        };

        const displayMathBlocks = [];
        text = text
          .replace(/\\\[([\s\S]*?)\\\]/g, (_match, expr) => `$$${expr}$$`)
          .replace(/\\\(([^\n]*?)\\\)/g, (_match, expr) => `$${expr}$`);

        text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_match, expr) => {
          const idx = displayMathBlocks.length;
          displayMathBlocks.push(normalizeDisplayMathExpression(expr));
          return `%%DPR_DISPLAY_MATH_${idx}%%`;
        });
        text = text.replace(/\$([^\$\n]+?)\$/g, (_match, expr) =>
          normalizeInlineMathExpression(expr),
        );
        text = text.replace(
          /%%DPR_DISPLAY_MATH_(\d+)%%/g,
          (_match, idx) => displayMathBlocks[Number(idx)] || '',
        );

        text = text.replace(
          /%%DPR_INLINE_CODE_(\d+)%%/g,
          (_match, idx) => inlineCodes[Number(idx)] || '',
        );
        text = text.replace(
          /%%DPR_CODE_BLOCK_(\d+)%%/g,
          (_match, idx) => codeBlocks[Number(idx)] || '',
        );
        return text;
      };

      let docsifyMathPlaceholderRun = 0;
      let docsifyMathPlaceholderPrefix = '';
      const docsifyMathPlaceholders = [];

      const escapeMathPlaceholderHtml = (value) =>
        String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');

      const protectMarkdownMathForDocsify = (markdown) => {
        let text = String(markdown || '');
        docsifyMathPlaceholders.length = 0;
        docsifyMathPlaceholderRun += 1;
        docsifyMathPlaceholderPrefix =
          `@@DPRDOCSIFYMATH${docsifyMathPlaceholderRun}X`;

        const codeBlocks = [];
        text = text.replace(
          /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g,
          (match) => {
            const idx = codeBlocks.length;
            codeBlocks.push(match);
            return `@@DPRDOCSIFYCODE${idx}@@`;
          },
        );

        const inlineCodes = [];
        text = text.replace(/`[^`\n]*`/g, (match) => {
          const idx = inlineCodes.length;
          inlineCodes.push(match);
          return `@@DPRDOCSIFYINLINE${idx}@@`;
        });

        const stashMath = (match) => {
          const idx = docsifyMathPlaceholders.length;
          docsifyMathPlaceholders.push(match);
          return `${docsifyMathPlaceholderPrefix}${idx}@@`;
        };

        text = text.replace(/\$\$([\s\S]*?)\$\$/g, stashMath);
        text = text.replace(/\$([^\$\n]+?)\$/g, stashMath);

        text = text.replace(
          /@@DPRDOCSIFYINLINE(\d+)@@/g,
          (_match, idx) => inlineCodes[Number(idx)] || '',
        );
        text = text.replace(
          /@@DPRDOCSIFYCODE(\d+)@@/g,
          (_match, idx) => codeBlocks[Number(idx)] || '',
        );
        return text;
      };

      const restoreMarkdownMathPlaceholders = (html) => {
        if (!docsifyMathPlaceholders.length || !docsifyMathPlaceholderPrefix) {
          return String(html || '');
        }
        const pattern = new RegExp(
          `${escapeRegExp(docsifyMathPlaceholderPrefix)}(\\d+)@@`,
          'g',
        );
        return String(html || '').replace(pattern, (match, idx) => {
          const math = docsifyMathPlaceholders[Number(idx)];
          return typeof math === 'string'
            ? escapeMathPlaceholderHtml(math)
            : match;
        });
      };

      const restoreMarkdownMathPlaceholdersInEl = (el) => {
        if (!el || !docsifyMathPlaceholders.length) return;
        const html = el.innerHTML || '';
        const restored = restoreMarkdownMathPlaceholders(html);
        if (restored !== html) {
          el.innerHTML = restored;
        }
      };

      // 公共工具：简单表格 + 标记修正：
      // 1）移除协议标记 [ANS]/[THINK]
      // 2）移除表格行之间多余空行，避免把同一张表拆成两块
      const normalizeTables = (markdown) => {
        if (!markdown) return '';
        // 清理历史遗留的协议标记
        let text = markdown
          .replace(/\[ANS\]/g, '')
          .replace(/\[THINK\]/g, '');

        const lines = text.split('\n');
        const isTableLine = (line) => /^\s*\|.*\|\s*$/.test(line);
        const result = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const prev = result.length ? result[result.length - 1] : '';
          const next = i + 1 < lines.length ? lines[i + 1] : '';
          if (
            line.trim() === '' &&
            isTableLine(prev || '') &&
            isTableLine(next || '')
          ) {
            // 跳过表格行之间的空行
            continue;
          }
          result.push(line);
        }
        return result.join('\n');
      };

      const escapeHtml = (str) => {
        return str
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      };

      // 自定义表格渲染：检测 Markdown 表格块并手写生成 <table>，
      // 其他内容仍交给 marked 渲染。
      // 同时保护 LaTeX 公式块，避免被 marked 误解析。
      const renderMarkdownWithTables = (markdown) => {
        const text = normalizeTables(
          normalizeMarkdownMathDelimiters(markdown || ''),
        );

        // 保护 LaTeX 公式：先用占位符替换，渲染后再恢复
        const latexBlocks = [];
        let protectedText = text;

        // 保护块级公式 $$...$$
        protectedText = protectedText.replace(/\$\$([\s\S]*?)\$\$/g, (match) => {
          const idx = latexBlocks.length;
          latexBlocks.push(match);
          return `%%LATEX_BLOCK_${idx}%%`;
        });

        // 保护行内公式 $...$（不跨行）
        protectedText = protectedText.replace(/\$([^\$\n]+?)\$/g, (match) => {
          const idx = latexBlocks.length;
          latexBlocks.push(match);
          return `%%LATEX_INLINE_${idx}%%`;
        });

        // 预处理：手动将 **...** 和 *...* 转换为 HTML 标签
        // 解决 marked 对中文字符旁的粗体/斜体识别问题
        // 注意：只匹配同一行内、且内容不超过 100 字符的情况，避免误匹配
        protectedText = protectedText.replace(/\*\*([^*\n]{1,100}?)\*\*/g, '<strong>$1</strong>');
        // 斜体：要求前后有空格或中文字符边界，避免误匹配乘号等
        protectedText = protectedText.replace(/(?<=[^\*]|^)\*([^*\n]{1,50}?)\*(?=[^\*]|$)/g, '<em>$1</em>');

        const lines = protectedText.split('\n');
        const isTableLine = (line) => /^\s*\|.*\|\s*$/.test(line);
        const isAlignLine = (line) =>
          /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line);

        const parseRow = (line) => {
          const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
          return trimmed.split('|').map((cell) => cell.trim());
        };

        const inlineRender = (cellText) => {
          if (!cellText) return '';
          if (window.marked && window.marked.parseInline) {
            return window.marked.parseInline(cellText);
          }
          return escapeHtml(cellText);
        };

        const blocks = [];
        let i = 0;

        const flushParagraph = (paraLines) => {
          const paraText = paraLines.join('\n').trim();
          if (!paraText) return;
          if (window.marked) {
            blocks.push(window.marked.parse(`\n${paraText}\n`));
          } else {
            blocks.push(`<p>${escapeHtml(paraText)}</p>`);
          }
        };

        while (i < lines.length) {
          const line = lines[i];

          // 检测表格块：当前行是表格行，下一行是对齐行
          if (
            isTableLine(line) &&
            i + 1 < lines.length &&
            isAlignLine(lines[i + 1])
          ) {
            const headerLine = lines[i];
            i += 2; // 跳过对齐行

            const bodyLines = [];
            while (i < lines.length && isTableLine(lines[i])) {
              bodyLines.push(lines[i]);
              i++;
            }

            const headers = parseRow(headerLine);
            const rows = bodyLines.map(parseRow);

            let html = '<table class="chat-table"><thead><tr>';
            headers.forEach((h) => {
              html += `<th>${inlineRender(h)}</th>`;
            });
            html += '</tr></thead><tbody>';
            rows.forEach((row) => {
              html += '<tr>';
              row.forEach((cell) => {
                html += `<td>${inlineRender(cell)}</td>`;
              });
              html += '</tr>';
            });
            html += '</tbody></table>';

            blocks.push(html);
          } else {
            // 非表格块：收集到下一个表格或结尾
            const paraLines = [];
            while (
              i < lines.length &&
              !(
                isTableLine(lines[i]) &&
                i + 1 < lines.length &&
                isAlignLine(lines[i + 1])
              )
            ) {
              paraLines.push(lines[i]);
              i++;
            }
            flushParagraph(paraLines);
          }
        }

        let result = blocks.join('');

        // 恢复 LaTeX 公式
        result = result.replace(/%%LATEX_BLOCK_(\d+)%%/g, (_, idx) => latexBlocks[parseInt(idx, 10)]);
        result = result.replace(/%%LATEX_INLINE_(\d+)%%/g, (_, idx) => latexBlocks[parseInt(idx, 10)]);

        return result;
      };

      const updateMetaTag = (name, content, options = {}) => {
        document
          .querySelectorAll(`meta[name="${name}"]`)
          .forEach((el) => el.remove());
        const useFallback = options.useFallback !== false;
        const value = content || (useFallback ? metaFallbacks[name] : '');
        if (!value) return;
        const meta = document.createElement('meta');
        meta.name = name;
        meta.content = value;
        document.head.appendChild(meta);
      };

      const SUMMARY_META_NAMES = ['citation_abstract'];

      const clearSummaryMetaFields = () => {
        SUMMARY_META_NAMES.forEach((name) => {
          document
            .querySelectorAll(`meta[name="${name}"]`)
            .forEach((el) => el.remove());
        });
      };

      // 导出给外部模块（例如聊天模块）复用
      window.DPRMarkdown = {
        normalizeTables,
        normalizeMarkdownMathDelimiters,
        protectMarkdownMathForDocsify,
        restoreMarkdownMathPlaceholders,
        renderMarkdownWithTables,
        renderMathInEl,
      };

      // 3. 小屏下：点击侧边栏条目后自动收起侧边栏（全屏列表 → 正文）
      const setupMobileSidebarAutoCloseOnItemClick = () => {
        const nav = document.querySelector('.sidebar-nav');
        if (!nav) return;
        if (nav.dataset.mobileAutoCloseBound === '1') return;
        nav.dataset.mobileAutoCloseBound = '1';

        nav.addEventListener('click', (event) => {
          const link = event.target.closest('a');
          if (!link) return;

          const href = link.getAttribute('href') || '';
          // 只处理 Docsify 内部路由（#/ 开头），避免影响外链
          if (!href.includes('#/')) return;

          const width =
            window.innerWidth || document.documentElement.clientWidth || 0;
          // 统一“微宽屏 + 窄屏”为同一套逻辑：<1024 时点击条目后自动收起 sidebar（全屏列表 → 正文）
          if (width >= 1024) return;

          // 让 Docsify 先完成路由跳转，再收起侧边栏
          setTimeout(() => {
            const body = document.body;
            if (!body) return;
            // 适配 Docsify 移动端原生语义：小屏收起侧边栏时不保留 close 类
            body.classList.remove('close');
          }, 0);
        });
      };

      // 4. 侧边栏按“日期”折叠的辅助函数
      const setupCollapsibleSidebarByDay = () => {
        const nav = document.querySelector('.sidebar-nav');
        if (!nav) return;

        const joinUrlPath = (a, b) => {
          const aa = String(a || '');
          const bb = String(b || '');
          if (!aa) return bb.replace(/^\/+/, '');
          if (!bb) return aa;
          const left = aa.endsWith('/') ? aa : `${aa}/`;
          const right = bb.replace(/^\/+/, '');
          return `${left}${right}`;
        };

        const getDocsifyBasePath = () => {
          const bp =
            window.$docsify && typeof window.$docsify.basePath === 'string'
              ? window.$docsify.basePath
              : '';
          return String(bp || '');
        };

        const normalizeHashHref = (href) => {
          const raw = String(href || '').trim();
          if (!raw) return '';
          if (raw.startsWith('#/')) return raw;
          if (raw.startsWith('#')) return `#/${raw.slice(1).replace(/^\//, '')}`;
          return `#/${raw.replace(/^\//, '')}`;
        };

        const getSidebarEmoji = (type, text) => {
          const value = stripSidebarEmoji(text);
          if (type === 'daily-root' || value === 'Daily Papers') return '🗂️';
          if (type === 'local-root' || value === '本地 PDF 解析') return '📄';
          if (type === 'day') return '📅';
          if (value === '精读区') return '🔬';
          if (value === '速读区') return '⚡';
          if (value === '今日简报') return '📝';
          return '';
        };

        const setSidebarLabelContent = (el, type, text) => {
          if (!el) return;
          const clean = stripSidebarEmoji(text);
          const emoji = getSidebarEmoji(type, clean);
          el.dataset.dprRawLabel = clean;
          el.textContent = '';
          if (!emoji) {
            el.textContent = clean;
            return;
          }
          const wrap = document.createElement('span');
          wrap.className = 'dpr-sidebar-label-with-icon';
          const icon = document.createElement('span');
          icon.className = 'dpr-sidebar-label-icon';
          icon.textContent = emoji;
          const label = document.createElement('span');
          label.className = 'dpr-sidebar-label-text';
          label.textContent = clean;
          wrap.appendChild(icon);
          wrap.appendChild(label);
          el.appendChild(wrap);
        };

        const buildDayReportHref = (label) => {
          const text = String(label || '').trim();
          const range = text.match(
            /^(\d{4})-(\d{2})-(\d{2})\s*~\s*(\d{4})-(\d{2})-(\d{2})$/,
          );
          if (range) {
            return `#/${range[1]}${range[2]}${range[3]}-${range[4]}${range[5]}${range[6]}/README`;
          }
          const single = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
          if (single) {
            return `#/${single[1]}${single[2]}/${single[3]}/README`;
          }
          return '';
        };

        const isPaperRouteHash = (hash) => {
          const route = String(hash || '')
            .replace(/^#\/?/, '')
            .replace(/\.md$/i, '')
            .replace(/\/$/, '');
          return (
            /^(\d{6}\/\d{2}|\d{8}(?:-\d{8}))\/(?!README$).+/i.test(route) &&
            /^(\d{6}\/\d{2}|\d{8}(?:-\d{8}))\/[^/]+$/i.test(route)
          );
        };

        const getDirectText = (li) => {
          if (!li) return '';
          if (typeof Node !== 'undefined') {
            const directTextNode = Array.from(li.childNodes || []).find((n) => {
              if (!n || n.nodeType !== Node.TEXT_NODE) return false;
              return String(n.textContent || '').trim();
            });
            if (directTextNode) {
              return String(directTextNode.textContent || '').trim();
            }
          }
          const title = li.querySelector(
            ':scope > .sidebar-day-toggle .sidebar-day-toggle-label',
          );
          return String((title && title.textContent) || '').trim();
        };

        const getPaperSectionFromAnchor = (anchor, rowLi) => {
          if (!anchor || !rowLi) return '';
          let currentLi = anchor.closest('li');
          while (currentLi) {
            const parentUl = currentLi.parentElement;
            const parentLi = parentUl ? parentUl.closest('li') : null;
            if (!parentLi || parentLi === rowLi) break;
            const text = getDirectText(parentLi);
            if (
              text &&
              !/^(\d{4}-\d{2}-\d{2})(\s*~\s*\d{4}-\d{2}-\d{2})?$/.test(
                text,
              )
            ) {
              return text;
            }
            currentLi = parentLi;
          }
          return '';
        };

        const collectDayPaperItems = (rowLi) => {
          if (!rowLi) return [];
          const anchors = Array.from(rowLi.querySelectorAll('a[href*=\"#/\"]'));
          const out = [];
          const seen = new Set();

          anchors.forEach((anchor) => {
            const href = normalizeHashHref(anchor.getAttribute('href'));
            if (!href || !isPaperRouteHash(href)) return;
            const paperId = href.replace(/^#\//, '');
            if (!paperId || paperId.endsWith('/README')) return;
            if (seen.has(paperId)) return;
            seen.add(paperId);
            out.push({
              anchor,
              href,
              paperId,
              section: getPaperSectionFromAnchor(anchor, rowLi),
            });
          });
          return out;
        };

        const normalizeSection = (section) => {
          const v = String(section || '').trim();
          if (!v) return '';
          if (/深度|精读|deep/i.test(v)) return 'deep';
          if (/速读|速览|quick/i.test(v)) return 'quick';
          return v.toLowerCase();
        };

        const normalizeAuthorsForExport = (authors) => {
          if (Array.isArray(authors)) {
            return authors
              .map((item) => String(item || '').trim())
              .filter(Boolean)
              .join(', ');
          }
          return String(authors || '').trim();
        };

        const normalizeTagsForExport = (tags) => {
          if (!tags) return '';
          if (Array.isArray(tags)) {
            return tags
              .map((tag) => {
                if (typeof tag === 'string') return tag.trim();
                if (!tag || typeof tag !== 'object') return '';
                const kind = String(tag.kind || '').trim();
                const label = String(tag.label || '').trim();
                return kind ? `${kind}:${label}` : label;
              })
              .filter(Boolean)
              .join(', ');
          }
          return String(tags || '').trim();
        };

        const normalizeDateField = (value) => {
          const text = String(value || '').trim();
          if (!text) return '';
          const m = text.match(/(\d{4})(\d{2})(\d{2})/);
          if (!m) return text;
          return `${m[1]}-${m[2]}-${m[3]}`;
        };

        const buildPaperMetaFromMarkdown = (paperId, section, markdownText) => {
          const parsed = parseFrontMatter(markdownText || '');
          const meta = parsed && parsed.meta ? parsed.meta : {};
          const body = parsed && parsed.body ? parsed.body : '';

          const title_en = String(meta.title_en || meta.title || '').trim();
          const abstractFromFrontMatter = String(
            meta.abstract_en || meta.abstract || '',
          ).trim();
          const authors = normalizeAuthorsForExport(meta.authors || meta.author);
          const score = String(meta.score || '').trim();
          const evidence = String(meta.evidence || '').trim();
          const tldr = String(meta.tldr || meta.summary || '').trim();

          const abstractFromBody = trimBeforeMarkers(
            extractSectionByTitle(body, (title) => {
              const normalized = String(title || '').trim().toLowerCase();
              return normalized === 'abstract' || normalized === '摘要';
            }),
            [],
          ).trim();

          return {
            paper_id: paperId,
            section: normalizeSection(section) || 'quick',
            title_en,
            source: String(meta.source || meta.Source || '').trim(),
            selection_source: String(meta.selection_source || '').trim(),
            authors,
            date: normalizeDateField(meta.date || ''),
            pdf: String(meta.pdf || meta.PDF || '').trim(),
            score,
            evidence,
            tldr,
            tags: normalizeTagsForExport(meta.tags || []),
            abstract_en: abstractFromFrontMatter || abstractFromBody,
          };
        };

        const markDayPapersUnrecommended = (paperItems) => {
          if (!Array.isArray(paperItems) || !paperItems.length) return;
          let readState = loadReadState();
          if (!readState || typeof readState !== 'object') readState = {};
          const toClear = new Set(['good', 'blue', 'orange', 'bad']);
          let changed = false;
          paperItems.forEach((item) => {
            const paperId = item && typeof item.paperId === 'string' ? item.paperId : '';
            if (!paperId) return;
            if (toClear.has(String(readState[paperId] || '').trim().toLowerCase())) {
              delete readState[paperId];
              changed = true;
            }
          });
          if (changed) saveReadState(readState);
        };

        const closeAllDayMenus = () => {
          const openedMenus = nav.querySelectorAll('.sidebar-day-menu.is-open');
          openedMenus.forEach((m) => {
            m.classList.remove('is-open');
          });
        };

        if (!nav.dataset.dprDayMenuBound) {
          nav.dataset.dprDayMenuBound = '1';
          document.addEventListener('click', (e) => {
            const target = e && e.target ? e.target : null;
            if (!target || !target.closest) return;
            if (!target.closest('.sidebar-day-toggle-actions')) {
              closeAllDayMenus();
            }
          });
        }

        const downloadJson = (filename, data) => {
          const blob = new Blob([JSON.stringify(data, null, 2)], {
            type: 'application/json;charset=utf-8',
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          a.className = 'dpr-sidebar-export-link';
          a.target = '_self';
          a.style.display = 'none';
          const stopLinkNav = (event) => {
            event.stopPropagation();
            if (event.stopImmediatePropagation) event.stopImmediatePropagation();
          };
          a.addEventListener('click', stopLinkNav, true);
          document.body.appendChild(a);
          requestAnimationFrame(() => {
            a.click();
            setTimeout(() => {
              a.remove();
            }, 0);
          });
          setTimeout(() => URL.revokeObjectURL(url), 500);
        };

        const STORAGE_KEY = 'dpr_sidebar_day_state_v1';
        const HIDDEN_DAYS_KEY = '__hiddenDays';
        let state = {};
        let hiddenDays = new Set();
        try {
          const raw = window.localStorage
            ? window.localStorage.getItem(STORAGE_KEY)
            : null;
          if (raw) {
            state = JSON.parse(raw) || {};
            const savedHidden = state[HIDDEN_DAYS_KEY];
            if (Array.isArray(savedHidden)) {
              hiddenDays = new Set(
                savedHidden
                  .map((x) => (typeof x === 'string' ? x : ''))
                  .filter(Boolean),
              );
            }
          }
        } catch {
          state = {};
          hiddenDays = new Set();
        }
        // 先扫描一遍，找出所有日期和最新一天
        const items = nav.querySelectorAll('li');
        const dayItems = [];
        let latestDay = '';

        items.forEach((li) => {
          const childUl = li.querySelector(':scope > ul');
          const directLink = li.querySelector(':scope > a');
          if (!childUl || directLink) return;

          // 取日期文本：
          // - 初次：li 的第一个文本节点
          // - 已初始化过：wrapper 内的 label
          let rawText = '';
          let firstTextNode = null;
          const first = li.firstChild;
          if (first && first.nodeType === Node.TEXT_NODE) {
            rawText = (first.textContent || '').trim();
            firstTextNode = first;
          } else {
            const label = li.querySelector(
              ':scope > .sidebar-day-toggle .sidebar-day-toggle-label',
            );
            rawText =
              (label &&
                ((label.dataset && label.dataset.dprRawLabel) ||
                  (label.textContent || '').trim())) ||
              '';
          }
          rawText = stripSidebarEmoji(rawText);

          const rangeMatch = rawText.match(
            /^(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})$/,
          );
          const isSingleDay = /^\d{4}-\d{2}-\d{2}$/.test(rawText);
          if (!isSingleDay && !rangeMatch) return;

          const dayKey = rangeMatch ? rangeMatch[2] : rawText; // 用区间“结束日”参与最新日判断
          if (hiddenDays.has(dayKey)) return;

          dayItems.push({
            li,
            text: rawText,
            firstTextNode,
            dayKey,
            reportHref: buildDayReportHref(rawText),
          });
          if (!latestDay || dayKey > latestDay) {
            latestDay = dayKey;
          }
        });

        if (!dayItems.length) return;

        // 判断是否出现了“更新后的新一天”
        const prevLatest =
          typeof state.__latestDay === 'string' ? state.__latestDay : null;
        const isNewDay =
          latestDay &&
          (!prevLatest || (typeof prevLatest === 'string' && latestDay > prevLatest));

        // 如果出现了新的一天：清空历史状态，只保留最新一天的信息
        if (isNewDay) {
          const prevHidden = hiddenDays;
          state = { __latestDay: latestDay };
          if (prevHidden.size) {
            state[HIDDEN_DAYS_KEY] = Array.from(prevHidden);
          }
        } else if (!prevLatest && latestDay) {
          // 第一次使用，没有历史记录但也不算“新一天触发重置”的场景：记录当前最新日期
          state.__latestDay = latestDay;
        }

        const hasAnyState =
          !isNewDay &&
          Object.keys(state).some((k) => k && !k.startsWith('__'));

        const ensureStateSaved = () => {
          try {
            if (window.localStorage) {
              state[HIDDEN_DAYS_KEY] = Array.from(hiddenDays);
              window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            }
          } catch {
            // ignore
          }
        };

        const downloadDayMeta = async (opts) => {
          const { li: rowLi, rawText: rowText } = opts || {};
          const dayPaperItems = collectDayPaperItems(rowLi);
          const payload = {
            label: String(rowText || 'daily-papers').trim(),
            date: String(rowText || '').trim(),
            generated_at: new Date().toISOString(),
            count: 0,
            papers: [],
            errors: [],
          };

          const menuDownload = rowLi
            ? rowLi.querySelector('.sidebar-day-menu-item-download')
            : null;
          const oldText = menuDownload ? menuDownload.textContent : null;
          if (menuDownload) {
            menuDownload.disabled = true;
            menuDownload.textContent = '下载中...';
          }
          try {
            if (!dayPaperItems.length) {
              payload.errors.push({
                paper_id: '',
                error: '本日分组下未找到可导出的论文',
              });
            } else {
              const baseHref = window.location.href.split('#')[0];
              await Promise.all(
                dayPaperItems.map(async (item) => {
                  let rawMarkdown = '';
                  try {
                    const rel = joinUrlPath(
                      getDocsifyBasePath(),
                      `${item.paperId}.md`,
                    );
                    const mdUrl = new URL(rel, baseHref).toString();
                    const resp = await fetch(mdUrl, { cache: 'no-store' });
                    if (!resp.ok) {
                      throw new Error(`HTTP ${resp.status}`);
                    }
                    rawMarkdown = await resp.text();
                  } catch (err) {
                    payload.errors.push({
                      paper_id: item.paperId,
                      error: String(err && err.message ? err.message : err),
                    });
                    return;
                  }

                  try {
                    payload.papers.push(
                      buildPaperMetaFromMarkdown(item.paperId, item.section, rawMarkdown),
                    );
                  } catch (err) {
                    payload.errors.push({
                      paper_id: item.paperId,
                      error: String(err && err.message ? err.message : err),
                    });
                  }
                }),
              );
            }

            payload.count = payload.papers.length;
            window.DPRLastDayExport = payload;

            const safeLabel = String(payload.label || 'daily-papers')
              .replace(/\s+/g, ' ')
              .trim()
              .replace(/[^\d\-~_ ]/g, '')
              .replace(/\s+/g, '_');
            const filename = `${safeLabel || 'daily-papers'}.json`;
            downloadJson(filename, payload);

            if (rowLi) {
              const trigger = rowLi.querySelector('.sidebar-day-menu-trigger');
              if (trigger) {
                trigger.title = `已下载：${payload.count || 0} 篇`;
              }
            }
          } catch (err) {
            if (rowLi) {
              const trigger = rowLi.querySelector('.sidebar-day-menu-trigger');
              if (trigger) {
                trigger.title = `下载失败（见控制台）：${String(
                  err && err.message ? err.message : err,
                )}`;
              }
            }
            console.warn('[DPR Export] 下载失败：', err);
            throw err;
          } finally {
            if (menuDownload) {
              menuDownload.disabled = false;
              menuDownload.textContent = oldText || '下载 JSON';
            }
          }
        };

        const deleteDaySection = ({ rowLi, rowText, dayKey }) => {
          if (!rowLi) return;
          if (dayKey) hiddenDays.add(dayKey);
          if (dayKey) delete state[dayKey];
          if (rowText) delete state[rowText];
          markDayPapersUnrecommended(collectDayPaperItems(rowLi));
          closeAllDayMenus();
          ensureStateSaved();
          rowLi.remove();
          syncSidebarActiveIndicator({ animate: false });
        };

        const DAY_ANIM_MS = 240;

        const getFoldContent = (li) =>
          li
            ? li.querySelector(
                ':scope > ul.sidebar-day-content, :scope > ul.dpr-sidebar-fold-content, :scope > ul',
              )
            : null;

        const isFoldCollapsed = (li) =>
          !li ||
          li.classList.contains('sidebar-day-collapsed') ||
          li.classList.contains('dpr-sidebar-group-collapsed');

        const unlockOpenFoldHeight = (li) => {
          if (isFoldCollapsed(li)) return;
          const ul = getFoldContent(li);
          if (!ul) return;
          ul.style.maxHeight = 'none';
          ul.style.opacity = '1';
        };

        const refreshOpenFoldHeights = (fromLi, options = {}) => {
          const { unlock = true } = options || {};
          let current = fromLi;
          while (current) {
            try {
              if (!isFoldCollapsed(current)) {
                const ul = getFoldContent(current);
                if (ul) {
                  ul.style.opacity = '1';
                  ul.style.maxHeight = unlock ? 'none' : `${ul.scrollHeight}px`;
                }
              }
            } catch {
              // ignore
            }
            current =
              current.parentElement && current.parentElement.closest
                ? current.parentElement.closest('li')
                : null;
          }
        };

        const setDayCollapsed = (li, collapsed, options = {}) => {
          const { animate = true } = options || {};
          const ul = li.querySelector(':scope > ul');
          if (!ul) return;
          ul.classList.add('sidebar-day-content');

          const doAnimate = animate && !prefersReducedMotion();
          if (!doAnimate) {
            ul.style.transition = 'none';
            ul.style.maxHeight = collapsed ? '0px' : 'none';
            ul.style.opacity = collapsed ? '0' : '1';
            requestAnimationFrame(() => {
              ul.style.transition = '';
              if (!collapsed) {
                unlockOpenFoldHeight(li);
              }
              refreshOpenFoldHeights(li.parentElement ? li.parentElement.closest('li') : null);
            });
            return;
          }

          if (collapsed) {
            ul.style.maxHeight = `${ul.scrollHeight}px`;
            ul.style.opacity = '0';
            requestAnimationFrame(() => {
              ul.style.maxHeight = '0px';
              refreshOpenFoldHeights(li.parentElement ? li.parentElement.closest('li') : null, {
                unlock: false,
              });
            });
          } else {
            ul.style.opacity = '1';
            ul.style.maxHeight = '0px';
            requestAnimationFrame(() => {
              ul.style.maxHeight = `${ul.scrollHeight}px`;
              refreshOpenFoldHeights(li.parentElement ? li.parentElement.closest('li') : null, {
                unlock: false,
              });
            });
          }

          setTimeout(() => {
            try {
              if (!li.classList.contains('sidebar-day-collapsed')) {
                unlockOpenFoldHeight(li);
              }
              refreshOpenFoldHeights(li.parentElement ? li.parentElement.closest('li') : null);
            } catch {
              // ignore
            }
          }, DAY_ANIM_MS + 30);
        };

        // 第二遍：真正安装折叠行为
        dayItems.forEach(({ li, text: rawText, firstTextNode, dayKey, reportHref }) => {
          const childUl = li.querySelector(':scope > ul');
          if (childUl) childUl.classList.add('sidebar-day-content');
          const key = dayKey || rawText;
          li.dataset.dprDayKey = key;
          li.dataset.dprDayLabel = rawText;
          const dayReportHref = reportHref || buildDayReportHref(rawText);

          // 复用或创建 wrapper（包含日期文字和小箭头）
          let wrapper = li.querySelector(':scope > .sidebar-day-toggle');
          if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.className = 'sidebar-day-toggle';

            const labelSpan = document.createElement('span');
            labelSpan.className = 'sidebar-day-toggle-label';
            labelSpan.textContent = rawText;

            const menuTrigger = document.createElement('button');
            menuTrigger.type = 'button';
            menuTrigger.className = 'sidebar-day-menu-trigger';
            menuTrigger.title = '更多操作';
            menuTrigger.setAttribute('aria-label', '更多操作');
            menuTrigger.textContent = '⋮';

            const menu = document.createElement('span');
            menu.className = 'sidebar-day-menu';

            const downloadBtn = document.createElement('button');
            downloadBtn.type = 'button';
            downloadBtn.className = 'sidebar-day-menu-item sidebar-day-menu-item-download';
            downloadBtn.textContent = '下载 JSON';
            downloadBtn.setAttribute('aria-label', '下载论文元数据 JSON');

            const arrowSpan = document.createElement('span');
            arrowSpan.className = 'sidebar-day-toggle-arrow';
            arrowSpan.textContent = '▾';

            const actions = document.createElement('span');
            actions.className = 'sidebar-day-toggle-actions';
            actions.appendChild(menuTrigger);
            menu.appendChild(downloadBtn);
            actions.appendChild(menu);
            actions.appendChild(arrowSpan);

            wrapper.appendChild(labelSpan);
            wrapper.appendChild(actions);

            // 用 wrapper 替换原始文本节点
            if (firstTextNode && firstTextNode.parentNode === li) {
              li.replaceChild(wrapper, firstTextNode);
            }
          }

          wrapper.dataset.dprDayReportHref = dayReportHref;
          wrapper.classList.add('dpr-sidebar-fold-toggle', 'dpr-sidebar-fold-toggle-day');
          wrapper.setAttribute('role', 'button');
          wrapper.setAttribute('tabindex', '0');

          const labelSpan = wrapper.querySelector('.sidebar-day-toggle-label');
          if (labelSpan) {
            setSidebarLabelContent(labelSpan, 'day', rawText);
          }
          const arrowSpan = wrapper.querySelector('.sidebar-day-toggle-arrow');
          const menuTrigger = wrapper.querySelector('.sidebar-day-menu-trigger');
          const menu = wrapper.querySelector('.sidebar-day-menu');
          const downloadBtn = wrapper.querySelector('.sidebar-day-menu-item-download');
          const toggleDayMenu = () => {
            if (!menu) return;
            const nowOpen = !menu.classList.contains('is-open');
            if (nowOpen) {
              closeAllDayMenus();
              menu.classList.add('is-open');
            } else {
              menu.classList.remove('is-open');
            }
          };

          if (menuTrigger && !menuTrigger.dataset.dprDayMenuTriggerBound) {
            menuTrigger.dataset.dprDayMenuTriggerBound = '1';
            menuTrigger.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              if (e.stopImmediatePropagation) e.stopImmediatePropagation();
              toggleDayMenu();
            });
          }

          if (downloadBtn && !downloadBtn.dataset.dprDownloadBound) {
            downloadBtn.dataset.dprDownloadBound = '1';
            downloadBtn.addEventListener('click', async (e) => {
              e.preventDefault();
              e.stopPropagation();
              if (e.stopImmediatePropagation) e.stopImmediatePropagation();
              if (downloadBtn.disabled) return;
              try {
                await downloadDayMeta({
                  li,
                  rawText,
                  dateKey: dayKey || rawText,
                });
              } catch {
                // ignore
              }
              if (menu) {
                menu.classList.remove('is-open');
              }
            });
          }

          // 决定默认展开 / 收起：
          // - 如果本次是“出现了新的一天”：清空历史，只展开最新一天；
          // - 否则若已有用户偏好（state），按偏好来；
          // - 否则（首次使用且没有历史）：仅“最新一天”展开，其余收起。
          let collapsed;
          if (isNewDay) {
            collapsed = key === latestDay ? false : true;
          } else if (hasAnyState) {
            const saved = state[rawText];
            if (saved === 'open') {
              collapsed = false;
            } else if (saved === 'closed') {
              collapsed = true;
            } else {
              // 新出现的日期：默认跟最新一天策略走
              collapsed = key === latestDay ? false : true;
            }
          } else {
            collapsed = key === latestDay ? false : true;
          }

          if (collapsed) {
            li.classList.add('sidebar-day-collapsed');
            if (arrowSpan) arrowSpan.textContent = '▸';
          } else {
            li.classList.remove('sidebar-day-collapsed');
            if (arrowSpan) arrowSpan.textContent = '▾';
          }
          wrapper.classList.toggle('is-open', !collapsed);
          wrapper.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

          // 初始化一次高度（不做动画，避免首次渲染闪动）
          setDayCollapsed(li, collapsed, { animate: false });

          // 绑定点击：使用 capture 阶段，确保即使旧版本已有 handler 也能覆盖
          if (!wrapper.dataset.dprDayToggleBound) {
            wrapper.dataset.dprDayToggleBound = '1';
            const activateDayRow = (e) => {
                try {
                  const target = e && e.target && e.target.closest
                    ? e.target.closest(
                        '.sidebar-day-menu-trigger,.sidebar-day-menu,.sidebar-day-menu-item',
                      )
                    : null;
                  if (target) return;
                  if (menuTrigger && e && typeof e.clientX === 'number') {
                    const rect = menuTrigger.getBoundingClientRect();
                    const hitMenuTrigger =
                      e.clientX >= rect.left &&
                      e.clientX <= rect.right &&
                      e.clientY >= rect.top &&
                      e.clientY <= rect.bottom;
                    if (hitMenuTrigger) {
                      e.preventDefault();
                      e.stopPropagation();
                      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                      toggleDayMenu();
                      return;
                    }
                  }
                } catch {
                  // ignore
                }
                closeAllDayMenus();
                e.preventDefault();
                e.stopPropagation();
                if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                const collapsed = li.classList.toggle('sidebar-day-collapsed');
                if (arrowSpan) arrowSpan.textContent = collapsed ? '\u25b8' : '\u25be';
                wrapper.classList.toggle('is-open', !collapsed);
                wrapper.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
                setDayCollapsed(li, collapsed, { animate: true });
                state[rawText] = collapsed ? 'closed' : 'open';
                state.__latestDay = latestDay;
                ensureStateSaved();
                requestAnimationFrame(() => {
                  syncSidebarActiveIndicator({ animate: false });
                });
                setTimeout(() => {
                  syncSidebarActiveIndicator({ animate: false });
                }, DAY_ANIM_MS + 34);
            };
            wrapper.addEventListener('click', activateDayRow, true);
            wrapper.addEventListener('keydown', (e) => {
              const keyName = e && (e.key || e.code);
              if (keyName !== 'Enter' && keyName !== ' ') return;
              activateDayRow(e);
            });
          }

          li.dataset.dayToggleApplied = '2';
        });

        const getGroupTextAndNode = (li) => {
          if (!li) return { text: '', firstTextNode: null };
          const existingLabel = li.querySelector(
            ':scope > .dpr-sidebar-group-toggle .dpr-sidebar-group-toggle-label',
          );
          if (existingLabel) {
            return {
              text: stripSidebarEmoji(
                (existingLabel.dataset && existingLabel.dataset.dprRawLabel) ||
                  existingLabel.textContent ||
                  '',
              ),
              firstTextNode: null,
            };
          }
          if (typeof Node === 'undefined') return { text: '', firstTextNode: null };
          const firstTextNode = Array.from(li.childNodes || []).find(
            (n) => n && n.nodeType === Node.TEXT_NODE && String(n.textContent || '').trim(),
          );
          return {
            text: stripSidebarEmoji(firstTextNode ? firstTextNode.textContent || '' : ''),
            firstTextNode: firstTextNode || null,
          };
        };

        const getGroupType = (text) => {
          const value = stripSidebarEmoji(text);
          if (value === 'Daily Papers') return 'daily-root';
          if (value === '本地 PDF 解析') return 'local-root';
          if (value === '精读区' || value === '速读区') return 'section';
          return '';
        };

        const getAncestorDayKey = (li) => {
          let current = li && li.parentElement ? li.parentElement.closest('li') : null;
          while (current) {
            if (current.dataset && current.dataset.dprDayKey) {
              return current.dataset.dprDayKey;
            }
            current =
              current.parentElement && current.parentElement.closest
                ? current.parentElement.closest('li')
                : null;
          }
          return '';
        };

        const setGroupCollapsed = (li, wrapper, collapsed, options = {}) => {
          const { animate = true } = options || {};
          const ul = li.querySelector(':scope > ul');
          if (!ul) return;
          ul.classList.add('dpr-sidebar-fold-content');
          li.classList.toggle('dpr-sidebar-group-collapsed', !!collapsed);
          wrapper.classList.toggle('is-open', !collapsed);
          wrapper.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
          const arrow = wrapper.querySelector('.dpr-sidebar-group-toggle-arrow');
          if (arrow) arrow.textContent = collapsed ? '\u25b8' : '\u25be';

          const doAnimate = animate && !prefersReducedMotion();
          if (!doAnimate) {
            ul.style.transition = 'none';
            ul.style.maxHeight = collapsed ? '0px' : 'none';
            ul.style.opacity = collapsed ? '0' : '1';
            requestAnimationFrame(() => {
              ul.style.transition = '';
              if (!collapsed) {
                unlockOpenFoldHeight(li);
              }
              refreshOpenFoldHeights(li.parentElement ? li.parentElement.closest('li') : null);
            });
            return;
          }

          if (collapsed) {
            ul.style.maxHeight = `${ul.scrollHeight}px`;
            ul.style.opacity = '0';
            requestAnimationFrame(() => {
              ul.style.maxHeight = '0px';
              refreshOpenFoldHeights(li.parentElement ? li.parentElement.closest('li') : null, {
                unlock: false,
              });
            });
          } else {
            ul.style.opacity = '1';
            ul.style.maxHeight = '0px';
            requestAnimationFrame(() => {
              ul.style.maxHeight = `${ul.scrollHeight}px`;
              refreshOpenFoldHeights(li.parentElement ? li.parentElement.closest('li') : null, {
                unlock: false,
              });
            });
          }

          setTimeout(() => {
            if (!li.classList.contains('dpr-sidebar-group-collapsed')) {
              unlockOpenFoldHeight(li);
            }
            refreshOpenFoldHeights(li.parentElement ? li.parentElement.closest('li') : null);
          }, DAY_ANIM_MS + 30);
        };

        Array.from(nav.querySelectorAll('li')).forEach((li) => {
          const childUl = li.querySelector(':scope > ul');
          const directLink = li.querySelector(':scope > a');
          if (!childUl || directLink || li.querySelector(':scope > .sidebar-day-toggle')) {
            return;
          }

          const { text: rawText, firstTextNode } = getGroupTextAndNode(li);
          const groupType = getGroupType(rawText);
          if (!groupType) return;

          const storageKey =
            groupType === 'daily-root'
              ? '__dailyRoot'
              : groupType === 'local-root'
                ? '__localPdfRoot'
                : `section:${getAncestorDayKey(li) || 'unknown'}:${rawText}`;
          let wrapper = li.querySelector(':scope > .dpr-sidebar-group-toggle');
          if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.className = `dpr-sidebar-group-toggle dpr-sidebar-fold-toggle dpr-sidebar-fold-toggle-${groupType}`;

            const labelSpan = document.createElement('span');
            labelSpan.className = 'dpr-sidebar-group-toggle-label';
            const arrowSpan = document.createElement('span');
            arrowSpan.className = 'dpr-sidebar-group-toggle-arrow';
            arrowSpan.textContent = '\u25be';

            wrapper.appendChild(labelSpan);
            wrapper.appendChild(arrowSpan);
            if (firstTextNode && firstTextNode.parentNode === li) {
              li.replaceChild(wrapper, firstTextNode);
            } else {
              li.insertBefore(wrapper, childUl);
            }
          }

          wrapper.classList.add('dpr-sidebar-fold-toggle');
          wrapper.dataset.dprFoldType = groupType;
          wrapper.setAttribute('role', 'button');
          wrapper.setAttribute('tabindex', '0');

          const labelSpan = wrapper.querySelector('.dpr-sidebar-group-toggle-label');
          if (labelSpan) {
            setSidebarLabelContent(labelSpan, groupType, rawText);
          }

          li.classList.toggle('dpr-sidebar-daily-root', groupType === 'daily-root');
          li.classList.toggle('dpr-sidebar-local-root', groupType === 'local-root');
          li.classList.toggle('dpr-sidebar-section', groupType === 'section');
          childUl.classList.add('dpr-sidebar-fold-content');

          const saved = state[storageKey];
          const collapsed = saved === 'closed' ? true : false;
          setGroupCollapsed(li, wrapper, collapsed, { animate: false });

          if (!wrapper.dataset.dprGroupToggleBound) {
            wrapper.dataset.dprGroupToggleBound = '1';
            const activateGroup = (e) => {
              e.preventDefault();
              e.stopPropagation();
              if (e.stopImmediatePropagation) e.stopImmediatePropagation();
              closeAllDayMenus();
              const nextCollapsed = !li.classList.contains('dpr-sidebar-group-collapsed')
                ? true
                : false;
              setGroupCollapsed(li, wrapper, nextCollapsed, { animate: true });
              state[storageKey] = nextCollapsed ? 'closed' : 'open';
              state.__latestDay = latestDay;
              ensureStateSaved();
              requestAnimationFrame(() => {
                syncSidebarActiveIndicator({ animate: false });
              });
              setTimeout(() => {
                syncSidebarActiveIndicator({ animate: false });
              }, DAY_ANIM_MS + 34);
            };
            wrapper.addEventListener('click', activateGroup, true);
            wrapper.addEventListener('keydown', (e) => {
              const keyName = e && (e.key || e.code);
              if (keyName !== 'Enter' && keyName !== ' ') return;
              activateGroup(e);
            });
          }
        });

        // 每次 doneEach 触发时都刷新一次“已展开分组”的 max-height：
        // 避免 active 项显示评价按钮等导致内容高度变化后被截断，从而出现“只有灰色高亮但看不到文字”的错觉。
        requestAnimationFrame(() => {
          try {
            nav
              .querySelectorAll(
                'li:not(.sidebar-day-collapsed) > ul.sidebar-day-content, li:not(.dpr-sidebar-group-collapsed) > ul.dpr-sidebar-fold-content',
              )
              .forEach((ul) => {
                // 仅做“静默修正”，避免因为 max-height 变化触发过渡，导致侧边栏看起来“滚动/刷新”一下
                const prevTransition = ul.style.transition;
                ul.style.transition = 'none';
                ul.style.maxHeight = 'none';
                ul.style.opacity = '1';
                requestAnimationFrame(() => {
                  ul.style.transition = prevTransition || '';
                });
              });
          } catch {
            // ignore
          }
        });
      };

      // 4. 论文“已阅读”状态管理（存储在 localStorage）
      const READ_STORAGE_KEY = 'dpr_read_papers_v1';
      const PAPER_REACTION_STORAGE_KEY = 'dpr_paper_reactions_v1';
      const MARKER_LABEL_STORAGE_KEY = 'dpr_paper_marker_labels_v1';
      const COLOR_MARKERS = [
        { key: 'good', label: 'Core', color: '#52c41a' },
        { key: 'blue', label: 'Novel', color: '#1890ff' },
        { key: 'orange', label: 'Useful', color: '#8a63d2' },
        { key: 'bad', label: 'Skim', color: '#f5222d' },
      ];
      const COLOR_MARKER_KEYS = COLOR_MARKERS.map((item) => item.key);
      const DEFAULT_MARKER_LABELS = COLOR_MARKERS.reduce((acc, item) => {
        acc[item.key] = item.label;
        return acc;
      }, {});

      const isColorMarkerKey = (value) => COLOR_MARKER_KEYS.includes(value);

      const normalizeReadStateObject = (obj) => {
        const normalized = {};
        if (!obj || typeof obj !== 'object') return normalized;
        Object.keys(obj).forEach((k) => {
          const v = obj[k];
          if (v === true || v === 'read') {
            normalized[k] = 'read';
          } else if (isColorMarkerKey(v)) {
            normalized[k] = v;
          }
        });
        return normalized;
      };

      const normalizePaperReactionState = (obj) => {
        const normalized = {};
        if (!obj || typeof obj !== 'object') return normalized;
        Object.keys(obj).forEach((k) => {
          const v = obj[k];
          if (v === 'favorite' || v === 'dislike') {
            normalized[k] = v;
          }
        });
        return normalized;
      };

      const loadReadState = () => {
        try {
          if (!window.localStorage) return {};
          const raw = window.localStorage.getItem(READ_STORAGE_KEY);
          if (!raw) return {};
          return normalizeReadStateObject(JSON.parse(raw));
        } catch {
          return {};
        }
      };

      const saveReadState = (state) => {
        try {
          if (!window.localStorage) return;
          window.localStorage.setItem(READ_STORAGE_KEY, JSON.stringify(state || {}));
        } catch {
          // ignore
        }
      };

      const loadPaperReactionState = () => {
        try {
          if (!window.localStorage) return {};
          const raw = window.localStorage.getItem(PAPER_REACTION_STORAGE_KEY);
          if (!raw) return {};
          return normalizePaperReactionState(JSON.parse(raw));
        } catch {
          return {};
        }
      };

      const savePaperReactionState = (state) => {
        try {
          if (!window.localStorage) return;
          window.localStorage.setItem(
            PAPER_REACTION_STORAGE_KEY,
            JSON.stringify(normalizePaperReactionState(state || {})),
          );
        } catch {
          // ignore
        }
      };

      const sanitizeMarkerLabel = (value, fallback) => {
        const text = String(value || '').trim();
        if (!text) return fallback;
        return text.split(/\s+/)[0].slice(0, 18) || fallback;
      };

      const getDefaultMarkerLabels = () => Object.assign({}, DEFAULT_MARKER_LABELS);

      const normalizeMarkerLabels = (labels) => {
        const normalized = getDefaultMarkerLabels();
        if (!labels || typeof labels !== 'object') return normalized;
        COLOR_MARKERS.forEach((item) => {
          normalized[item.key] = sanitizeMarkerLabel(labels[item.key], item.label);
        });
        return normalized;
      };

      const loadMarkerLabels = () => {
        try {
          if (!window.localStorage) return getDefaultMarkerLabels();
          const raw = window.localStorage.getItem(MARKER_LABEL_STORAGE_KEY);
          if (!raw) return getDefaultMarkerLabels();
          return normalizeMarkerLabels(JSON.parse(raw));
        } catch {
          return getDefaultMarkerLabels();
        }
      };

      const saveMarkerLabels = (labels) => {
        try {
          if (!window.localStorage) return;
          window.localStorage.setItem(
            MARKER_LABEL_STORAGE_KEY,
            JSON.stringify(normalizeMarkerLabels(labels)),
          );
        } catch {
          // ignore
        }
      };

      const togglePaperReactionState = (state, paperId, reaction) => {
        const next = normalizePaperReactionState(state || {});
        const id = String(paperId || '').trim();
        if (!id || (reaction !== 'favorite' && reaction !== 'dislike')) return next;
        if (next[id] === reaction) {
          delete next[id];
        } else {
          next[id] = reaction;
        }
        return next;
      };

      const setPaperColorMarkerState = (state, paperId, marker) => {
        const next = normalizeReadStateObject(state || {});
        const id = String(paperId || '').trim();
        if (!id || !isColorMarkerKey(marker)) return next;
        next[id] = next[id] === marker ? 'read' : marker;
        return next;
      };

      const buildPaperStateBadges = (status, reaction, labels) => {
        const badges = [];
        if (reaction === 'favorite' || reaction === 'dislike') {
          badges.push({
            type: 'reaction',
            key: reaction,
            className: reaction,
            title: reaction === 'favorite' ? 'Favorite' : 'Dislike',
          });
        }
        if (isColorMarkerKey(status)) {
          const marker = COLOR_MARKERS.find((item) => item.key === status);
          const markerLabels = normalizeMarkerLabels(labels || {});
          badges.push({
            type: 'marker',
            key: status,
            className: status,
            color: marker ? marker.color : '',
            label: markerLabels[status] || (marker ? marker.label : status),
            title: markerLabels[status] || (marker ? marker.label : status),
          });
        }
        return badges;
      };

      window.DPRPaperActions = Object.assign({}, window.DPRPaperActions || {}, {
        COLOR_MARKERS,
        buildPaperStateBadges,
        getDefaultMarkerLabels,
        normalizeMarkerLabels,
        normalizePaperReactionState,
        normalizeReadStateObject,
        setPaperColorMarkerState,
        togglePaperReactionState,
      });

      // ---------- Share to GitHub Gist ----------
      const loadGithubTokenForGist = () => {
        try {
          const secret = window.decoded_secret_private || {};
          if (secret.github && secret.github.token) {
            const t = String(secret.github.token || '').trim();
            if (t) return t;
          }
        } catch {
          // ignore
        }
        try {
          if (!window.localStorage) return null;
          const raw = window.localStorage.getItem('github_token_data');
          if (!raw) return null;
          const obj = JSON.parse(raw) || {};
          const t = String(obj.token || '').trim();
          return t || null;
        } catch {
          return null;
        }
      };

      const joinUrlPath = (a, b) => {
        const aa = String(a || '');
        const bb = String(b || '');
        if (!aa) return bb.replace(/^\/+/, '');
        if (!bb) return aa;
        const left = aa.endsWith('/') ? aa : `${aa}/`;
        const right = bb.replace(/^\/+/, '');
        return `${left}${right}`;
      };

      const getDocsifyBasePath = () => {
        const bp =
          window.$docsify && typeof window.$docsify.basePath === 'string'
            ? window.$docsify.basePath
            : 'docs/';
        return String(bp || 'docs/');
      };

      const buildDocsUrl = (rel) => {
        try {
          const baseHref = window.location.href.split('#')[0];
          return new URL(rel, baseHref).toString();
        } catch {
          return rel;
        }
      };

      const fetchPaperMarkdownById = async (paperId) => {
        const rel = joinUrlPath(getDocsifyBasePath(), `${paperId}.md`);
        const url = buildDocsUrl(rel);
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`无法读取文章 Markdown（HTTP ${res.status}）`);
        return await res.text();
      };

      const loadChatHistoryForPaper = async (paperId) => {
        if (!paperId) return [];
        // IndexedDB 优先：dpr_chat_db_v1 / paper_chats
        if (typeof indexedDB !== 'undefined') {
          try {
            const db = await new Promise((resolve) => {
              const req = indexedDB.open('dpr_chat_db_v1', 1);
              req.onupgradeneeded = (e) => {
                const d = e.target.result;
                if (!d.objectStoreNames.contains('paper_chats')) {
                  d.createObjectStore('paper_chats', { keyPath: 'paperId' });
                }
              };
              req.onsuccess = (e) => resolve(e.target.result);
              req.onerror = () => resolve(null);
            });
            if (db) {
              return await new Promise((resolve) => {
                try {
                  const tx = db.transaction('paper_chats', 'readonly');
                  const store = tx.objectStore('paper_chats');
                  const r = store.get(paperId);
                  r.onsuccess = () => {
                    const rec = r.result;
                    resolve(rec && Array.isArray(rec.messages) ? rec.messages : []);
                  };
                  r.onerror = () => resolve([]);
                } catch {
                  resolve([]);
                }
              });
            }
          } catch {
            // ignore
          }
        }
        // 兜底：旧版 localStorage
        try {
          if (!window.localStorage) return [];
          const raw = window.localStorage.getItem('dpr_chat_history_v1');
          if (!raw) return [];
          const obj = JSON.parse(raw) || {};
          const list = obj[paperId];
          return Array.isArray(list) ? list : [];
        } catch {
          return [];
        }
      };

      const buildShareMarkdown = (paperId, pageMd, chatMessages) => {
        const builder =
          window.DPRGistShareUtils &&
          typeof window.DPRGistShareUtils.buildShareMarkdown === 'function'
            ? window.DPRGistShareUtils.buildShareMarkdown
            : null;
        if (builder) {
          return builder({
            paperId,
            pageMd,
            chatMessages,
            origin: String(window.location.origin || ''),
            generatedAt: new Date().toISOString(),
          });
        }

        const parsed = parseFrontMatter(String(pageMd || ''));
        const safeMeta = parsed && parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
        const body = parsed && typeof parsed.body === 'string'
          ? parsed.body
          : String(pageMd || '').replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
        const heading = String(safeMeta.title_zh || safeMeta.title || paperId || 'Paper Share').trim();
        const subtitle = safeMeta.title_zh && safeMeta.title ? String(safeMeta.title).trim() : '';
        const tags = Array.isArray(safeMeta.tags) ? safeMeta.tags : [];
        const pageUrl = `${String(window.location.origin || '').replace(/\/+$/, '')}/#/${paperId}`;
        const parts = [];

        parts.push('<!-- Shared by Daily Paper Reader -->');
        parts.push('');
        parts.push(`# ${heading}`);
        if (subtitle) {
          parts.push('');
          parts.push(`_${subtitle}_`);
        }
        parts.push('');
        if (safeMeta.authors) parts.push(`- **Authors**: ${String(safeMeta.authors).trim()}`);
        if (safeMeta.source) parts.push(`- **Source**: ${String(safeMeta.source).trim()}`);
        if (safeMeta.date) parts.push(`- **Date**: ${String(safeMeta.date).trim()}`);
        if (safeMeta.pdf) parts.push(`- **PDF**: ${String(safeMeta.pdf).trim()}`);
        if (tags.length) parts.push(`- **Tags**: ${tags.join(', ')}`);
        if (safeMeta.evidence) parts.push(`- **Evidence**: ${String(safeMeta.evidence).trim()}`);
        if (safeMeta.tldr) parts.push(`- **TLDR**: ${String(safeMeta.tldr).trim()}`);
        parts.push(`- **原始页面**: ${pageUrl}`);
        parts.push(`- **生成时间**: ${new Date().toISOString()}`);
        parts.push('');
        parts.push('---');
        parts.push('');
        parts.push(body || String(pageMd || '').trim());
        parts.push('');
        parts.push('---');
        parts.push('');
        parts.push('## 💬 Chat History（本机记录）');
        parts.push('');
        if (!chatMessages || !chatMessages.length) {
          parts.push('暂无对话。');
          return parts.join('\n');
        }
        chatMessages.forEach((m) => {
          const role = m && m.role ? String(m.role) : 'unknown';
          const time = m && m.time ? String(m.time) : '';
          const content = m && m.content ? String(m.content) : '';
          if (role === 'thinking') {
            parts.push('<details>');
            parts.push(`<summary>🧠 思考过程 ${time ? `(${time})` : ''}</summary>`);
            parts.push('');
            parts.push('```');
            parts.push(content);
            parts.push('```');
            parts.push('</details>');
            parts.push('');
            return;
          }
          const label = role === 'ai' ? '🤖 AI' : role === 'user' ? '👤 你' : role;
          parts.push(`### ${label}${time ? ` (${time})` : ''}`);
          parts.push(content);
          parts.push('');
        });
        return parts.join('\n');
      };

      const ensureShareModal = () => {
        let overlay = document.getElementById('dpr-gist-share-overlay');
        if (overlay) return overlay;
        overlay = document.createElement('div');
        overlay.id = 'dpr-gist-share-overlay';
        overlay.innerHTML = `
          <div class="dpr-gist-share-modal" role="dialog" aria-modal="true">
            <div class="dpr-gist-share-title">分享链接</div>
            <div class="dpr-gist-share-row">
              <input class="dpr-gist-share-input" type="text" readonly />
              <button class="dpr-gist-share-copy" type="button">复制</button>
            </div>
            <div class="dpr-gist-share-hint"></div>
          </div>
        `;
        overlay.addEventListener('pointerdown', (e) => {
          // 点空白处关闭
          if (e && e.target === overlay) {
            overlay.classList.remove('show');
          }
        });
        document.addEventListener('keydown', (e) => {
          if (e && e.key === 'Escape') overlay.classList.remove('show');
        });
        document.body.appendChild(overlay);

        const copyBtn = overlay.querySelector('.dpr-gist-share-copy');
        if (copyBtn) {
          copyBtn.addEventListener('click', async () => {
            const input = overlay.querySelector('.dpr-gist-share-input');
            const v = input ? String(input.value || '') : '';
            if (!v) return;
            try {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(v);
              } else {
                input.focus();
                input.select();
                document.execCommand('copy');
              }
              const hint = overlay.querySelector('.dpr-gist-share-hint');
              if (hint) hint.textContent = '已复制';
            } catch {
              const hint = overlay.querySelector('.dpr-gist-share-hint');
              if (hint) hint.textContent = '复制失败，请手动复制';
            }
          });
        }
        return overlay;
      };

      const showShareModal = (url, hintText) => {
        const overlay = ensureShareModal();
        const input = overlay.querySelector('.dpr-gist-share-input');
        const hint = overlay.querySelector('.dpr-gist-share-hint');
        if (input) input.value = url || '';
        if (hint) hint.textContent = hintText || '';
        overlay.classList.add('show');
      };

      const createGist = async (token, filename, content) => {
        const res = await fetch('https://api.github.com/gists', {
          method: 'POST',
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            description: '论文分享（Daily Paper Reader）',
            public: false,
            files: {
              [filename]: { content },
            },
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = data && data.message ? String(data.message) : '';
          // GitHub 对不支持/无权限的 token（尤其是 fine-grained PAT 不支持 Gist）经常返回 404 Not Found
          if (res.status === 404) {
            throw new Error(
              'Not Found（常见原因：你用的是 Fine-grained PAT，GitHub Gist API 不支持；请改用 Classic PAT 并勾选 gist 权限）',
            );
          }
          if (res.status === 401) {
            throw new Error('未授权（Token 无效或已过期）');
          }
          if (res.status === 403) {
            throw new Error(
              `权限不足（需要 Classic PAT 勾选 gist 权限）。${msg ? `详情：${msg}` : ''}`.trim(),
            );
          }
          throw new Error(msg || `HTTP ${res.status}`);
        }
        return data;
      };

      const sharePaperToGist = async (paperId) => {
        const token = loadGithubTokenForGist();
        if (!token) {
          showShareModal('', '未检测到 GitHub Token，请先在首页配置 GitHub Token。');
          return;
        }
        const pageMd = await fetchPaperMarkdownById(paperId);
        const chat = await loadChatHistoryForPaper(paperId);
        const content = buildShareMarkdown(paperId, pageMd, chat);

        // 文件名：paperId 最后一段 + .md
        const slug = String(paperId || 'paper').split('/').slice(-1)[0] || 'paper';
        const filename = `${slug}.md`;
        const data = await createGist(token, filename, content);
        const url = data && data.html_url ? String(data.html_url) : '';
        const preview = data && data.id ? `https://gist.io/${data.id}` : '';
        showShareModal(url, preview ? `精美预览：${preview}` : '');
      };

      const PAPER_ACTIONS_STATE = {
        paperId: '',
        popover: '',
        editingMarkers: false,
      };

      const clearNode = (node) => {
        if (!node) return;
        while (node.firstChild) node.removeChild(node.firstChild);
      };

      const getDirectChildByClass = (parent, className) => {
        if (!parent || !parent.children) return null;
        return Array.from(parent.children).find(
          (child) => child.classList && child.classList.contains(className),
        ) || null;
      };

      const ensurePaperActionBackdrop = () => {
        let backdrop = document.getElementById('dpr-paper-actions-backdrop');
        if (!backdrop) {
          backdrop = document.createElement('div');
          backdrop.id = 'dpr-paper-actions-backdrop';
          backdrop.setAttribute('aria-hidden', 'true');
          backdrop.addEventListener('click', () => closePaperActionPopover());
          document.body.appendChild(backdrop);
        }
        return backdrop;
      };

      const getCurrentPaperPdfUrl = () => {
        try {
          let link = document.querySelector('a[href*="arxiv.org/pdf"]');
          if (!link) link = document.querySelector('a[href$=".pdf"]');
          if (!link || !link.href) return '';
          return new URL(link.href, window.location.href).href;
        } catch {
          return '';
        }
      };

      const getDailyReportIdForPaper = (paperId) => {
        const id = String(paperId || '').replace(/^\/+|\/+$/g, '');
        const dayMatch = id.match(/^(\d{6}\/\d{2})\//);
        if (dayMatch) return `${dayMatch[1]}/README`;
        const rangeMatch = id.match(/^(\d{8}-\d{8})\//);
        if (rangeMatch) return `${rangeMatch[1]}/README`;
        return '';
      };

      const downloadTextAsFile = (filename, content) => {
        const blob = new Blob([content || ''], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename || 'paper.md';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      };

      const openDownloadUrl = (url) => {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        document.body.appendChild(link);
        link.click();
        link.remove();
      };

      const setPaperActionPopoverHint = (text) => {
        const popover = document.querySelector('#dpr-paper-actions .dpr-paper-actions-popover');
        const hint = popover ? popover.querySelector('.dpr-paper-actions-popover-hint') : null;
        if (hint) hint.textContent = text || '';
      };

      const closePaperActionPopover = () => {
        const toolbar = document.getElementById('dpr-paper-actions');
        const backdrop = document.getElementById('dpr-paper-actions-backdrop');
        PAPER_ACTIONS_STATE.popover = '';
        PAPER_ACTIONS_STATE.editingMarkers = false;
        if (toolbar) {
          toolbar.classList.remove('is-popover-open');
          const popover = toolbar.querySelector('.dpr-paper-actions-popover');
          if (popover) {
            popover.classList.remove('is-open');
            popover.setAttribute('aria-hidden', 'true');
            clearNode(popover);
          }
        }
        if (backdrop) backdrop.classList.remove('is-open');
        document.body.classList.remove('dpr-paper-actions-popover-open');
      };

      const refreshPaperActionToolbarState = (paperId = PAPER_ACTIONS_STATE.paperId) => {
        const toolbar = document.getElementById('dpr-paper-actions');
        if (!toolbar || !paperId) return;
        const readState = loadReadState();
        const reactions = loadPaperReactionState();
        const marker = isColorMarkerKey(readState[paperId]) ? readState[paperId] : '';
        const reaction = reactions[paperId] || '';
        const labels = loadMarkerLabels();

        const favoriteBtn = toolbar.querySelector('[data-paper-action="favorite"]');
        const dislikeBtn = toolbar.querySelector('[data-paper-action="dislike"]');
        const markerBtn = toolbar.querySelector('[data-paper-action="marker"]');
        if (favoriteBtn) {
          favoriteBtn.classList.toggle('is-active', reaction === 'favorite');
          favoriteBtn.setAttribute('aria-pressed', reaction === 'favorite' ? 'true' : 'false');
          favoriteBtn.title = reaction === 'favorite' ? 'Unfavorite' : 'Favorite';
        }
        if (dislikeBtn) {
          dislikeBtn.classList.toggle('is-active', reaction === 'dislike');
          dislikeBtn.setAttribute('aria-pressed', reaction === 'dislike' ? 'true' : 'false');
          dislikeBtn.title = reaction === 'dislike' ? 'Remove dislike' : 'Dislike';
        }
        if (markerBtn) {
          COLOR_MARKER_KEYS.forEach((key) => markerBtn.classList.remove(`marker-${key}`));
          markerBtn.classList.toggle('is-active', !!marker);
          markerBtn.setAttribute('aria-pressed', marker ? 'true' : 'false');
          markerBtn.title = marker ? `Color mark: ${labels[marker] || marker}` : 'Color mark';
          if (marker) markerBtn.classList.add(`marker-${marker}`);
        }
      };

      const syncPaperStateDisplays = (paperId) => {
        refreshPaperActionToolbarState(paperId);
        markSidebarReadState(null);
        requestAnimationFrame(() => {
          syncSidebarActiveIndicator({ animate: false });
        });
      };

      const renderMarkerPopover = (popover) => {
        const paperId = PAPER_ACTIONS_STATE.paperId;
        const readState = loadReadState();
        const activeMarker = readState[paperId] || '';
        const labels = loadMarkerLabels();
        clearNode(popover);

        const header = document.createElement('div');
        header.className = 'dpr-paper-actions-popover-header';
        const title = document.createElement('div');
        title.className = 'dpr-paper-actions-popover-title';
        title.textContent = 'Color mark';
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'dpr-paper-actions-edit-btn';
        editBtn.textContent = PAPER_ACTIONS_STATE.editingMarkers ? 'Save' : 'Edit';
        editBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (PAPER_ACTIONS_STATE.editingMarkers) {
            const nextLabels = {};
            popover.querySelectorAll('.dpr-marker-label-input').forEach((input) => {
              nextLabels[input.dataset.markerKey] = input.value;
            });
            saveMarkerLabels(nextLabels);
            PAPER_ACTIONS_STATE.editingMarkers = false;
            renderMarkerPopover(popover);
            syncPaperStateDisplays(paperId);
          } else {
            PAPER_ACTIONS_STATE.editingMarkers = true;
            renderMarkerPopover(popover);
          }
        });
        header.appendChild(title);
        header.appendChild(editBtn);
        popover.appendChild(header);

        const list = document.createElement('div');
        list.className = 'dpr-paper-marker-list';
        COLOR_MARKERS.forEach((marker) => {
          const row = document.createElement(PAPER_ACTIONS_STATE.editingMarkers ? 'label' : 'button');
          row.className = `dpr-paper-marker-option marker-${marker.key}`;
          if (!PAPER_ACTIONS_STATE.editingMarkers) row.type = 'button';
          row.style.setProperty('--dpr-marker-color', marker.color);

          const swatch = document.createElement('span');
          swatch.className = 'dpr-paper-marker-swatch';
          row.appendChild(swatch);

          if (PAPER_ACTIONS_STATE.editingMarkers) {
            const input = document.createElement('input');
            input.className = 'dpr-marker-label-input';
            input.dataset.markerKey = marker.key;
            input.value = labels[marker.key] || marker.label;
            input.maxLength = 18;
            row.appendChild(input);
          } else {
            const text = document.createElement('span');
            text.className = 'dpr-paper-marker-label';
            text.textContent = labels[marker.key] || marker.label;
            row.appendChild(text);
            row.classList.toggle('is-active', activeMarker === marker.key);
            row.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              saveReadState(setPaperColorMarkerState(loadReadState(), paperId, marker.key));
              closePaperActionPopover();
              syncPaperStateDisplays(paperId);
            });
          }
          list.appendChild(row);
        });
        popover.appendChild(list);
      };

      const addDownloadOption = (list, { label, detail, disabled, onClick }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dpr-paper-download-option';
        btn.disabled = !!disabled;
        const labelEl = document.createElement('span');
        labelEl.className = 'dpr-paper-download-label';
        labelEl.textContent = label;
        const detailEl = document.createElement('span');
        detailEl.className = 'dpr-paper-download-detail';
        detailEl.textContent = detail || '';
        btn.appendChild(labelEl);
        btn.appendChild(detailEl);
        if (typeof onClick === 'function') {
          btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (btn.disabled) return;
            btn.disabled = true;
            try {
              await onClick();
            } catch (err) {
              const msg = String(err && err.message ? err.message : err || 'Action failed');
              setPaperActionPopoverHint(msg);
            } finally {
              btn.disabled = false;
            }
          });
        }
        list.appendChild(btn);
      };

      const renderDownloadPopover = (popover) => {
        const paperId = PAPER_ACTIONS_STATE.paperId;
        const pdfUrl = getCurrentPaperPdfUrl();
        clearNode(popover);
        const header = document.createElement('div');
        header.className = 'dpr-paper-actions-popover-header';
        const title = document.createElement('div');
        title.className = 'dpr-paper-actions-popover-title';
        title.textContent = 'Downloads';
        header.appendChild(title);
        popover.appendChild(header);

        const list = document.createElement('div');
        list.className = 'dpr-paper-download-list';
        addDownloadOption(list, {
          label: 'Gist Link',
          detail: '生成 Gist 分享链接',
          onClick: async () => {
            closePaperActionPopover();
            try {
              await sharePaperToGist(paperId);
            } catch (err) {
              const msg = String(err && err.message ? err.message : err);
              showShareModal('', `Upload failed: ${msg}`);
            }
          },
        });
        addDownloadOption(list, {
          label: 'Daily MD',
          detail: '下载当日日报 Markdown',
          onClick: async () => {
            const reportId = getDailyReportIdForPaper(paperId);
            if (!reportId) throw new Error('未找到当日日报路径。');
            const content = await fetchPaperMarkdownById(reportId);
            const slug = reportId.replace(/\//g, '-').replace(/-README$/i, '') || 'daily-report';
            downloadTextAsFile(`${slug}.md`, content || '');
            setPaperActionPopoverHint('已开始下载当日日报。');
          },
        });
        addDownloadOption(list, {
          label: 'Paper MD',
          detail: '下载当前论文 Markdown',
          onClick: async () => {
            const content = await fetchPaperMarkdownById(paperId);
            const slug = String(paperId || 'paper').split('/').slice(-1)[0] || 'paper';
            downloadTextAsFile(`${slug}.md`, content || '');
            setPaperActionPopoverHint('已开始下载当前论文。');
          },
        });
        addDownloadOption(list, {
          label: 'PDF',
          detail: pdfUrl ? '打开论文 PDF 链接' : '未找到 PDF 链接',
          disabled: !pdfUrl,
          onClick: async () => {
            openDownloadUrl(pdfUrl);
            setPaperActionPopoverHint('已打开 PDF 链接。');
          },
        });
        popover.appendChild(list);
        const hint = document.createElement('div');
        hint.className = 'dpr-paper-actions-popover-hint';
        popover.appendChild(hint);
      };

      const openPaperActionPopover = (type) => {
        const toolbar = document.getElementById('dpr-paper-actions');
        if (!toolbar || toolbar.hidden) return;
        const popover = toolbar.querySelector('.dpr-paper-actions-popover');
        const backdrop = ensurePaperActionBackdrop();
        if (!popover) return;
        PAPER_ACTIONS_STATE.popover = type;
        PAPER_ACTIONS_STATE.editingMarkers = false;
        if (type === 'marker') renderMarkerPopover(popover);
        if (type === 'download') renderDownloadPopover(popover);
        popover.classList.add('is-open');
        popover.setAttribute('aria-hidden', 'false');
        toolbar.classList.add('is-popover-open');
        backdrop.classList.add('is-open');
        document.body.classList.add('dpr-paper-actions-popover-open');
      };

      const togglePaperActionPopover = (type) => {
        if (PAPER_ACTIONS_STATE.popover === type) {
          closePaperActionPopover();
        } else {
          openPaperActionPopover(type);
        }
      };

      const ensurePaperActionToolbar = (paperId, isPaperPage) => {
        let toolbar = document.getElementById('dpr-paper-actions');
        if (!isPaperPage || !paperId) {
          closePaperActionPopover();
          if (toolbar) toolbar.hidden = true;
          return;
        }
        if (PAPER_ACTIONS_STATE.paperId && PAPER_ACTIONS_STATE.paperId !== paperId) {
          closePaperActionPopover();
        }
        if (!toolbar) {
          toolbar = document.createElement('div');
          toolbar.id = 'dpr-paper-actions';
          toolbar.innerHTML = `
            <div class="dpr-paper-actions-stack" role="toolbar" aria-label="Paper actions">
              <button type="button" class="dpr-paper-action-btn" data-paper-action="favorite" aria-label="Favorite" title="Favorite" aria-pressed="false"><svg class="dpr-paper-action-icon dpr-icon-favorite" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.4l2.65 5.36 5.92.86-4.28 4.17 1.01 5.9L12 16.9l-5.3 2.79 1.01-5.9-4.28-4.17 5.92-.86L12 3.4z"/></svg></button>
              <button type="button" class="dpr-paper-action-btn" data-paper-action="dislike" aria-label="Dislike" title="Dislike" aria-pressed="false"><svg class="dpr-paper-action-icon dpr-icon-dislike" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.4C7.8 16.62 5 14.07 5 10.95 5 8.4 6.98 6.5 9.52 6.5c1.43 0 2.81.67 3.48 1.72.67-1.05 2.05-1.72 3.48-1.72C19.02 6.5 21 8.4 21 10.95c0 3.12-2.8 5.67-9 9.45z"/><line x1="4.25" y1="20.25" x2="20.25" y2="4.25"/></svg></button>
              <button type="button" class="dpr-paper-action-btn" data-paper-action="marker" aria-label="Color mark" title="Color mark" aria-pressed="false"><span class="dpr-paper-action-icon dpr-icon-marker-grid" aria-hidden="true"><i></i><i></i><i></i><i></i></span></button>
              <button type="button" class="dpr-paper-action-btn" data-paper-action="download" aria-label="Downloads" title="Downloads"><svg class="dpr-paper-action-icon dpr-icon-download" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.75v10.2"/><path d="M7.9 10.05 12 14.15l4.1-4.1"/><path d="M5.25 15.75v2.6c0 .9.73 1.63 1.63 1.63h10.24c.9 0 1.63-.73 1.63-1.63v-2.6"/></svg></button>
            </div>
            <div class="dpr-paper-actions-popover" role="dialog" aria-hidden="true"></div>
          `;
          toolbar.addEventListener('click', (e) => {
            const btn = e.target && e.target.closest ? e.target.closest('[data-paper-action]') : null;
            if (!btn || !toolbar.contains(btn)) return;
            e.preventDefault();
            e.stopPropagation();
            const action = btn.getAttribute('data-paper-action');
            const currentPaperId = PAPER_ACTIONS_STATE.paperId;
            if (!currentPaperId) return;
            if (action === 'favorite' || action === 'dislike') {
              closePaperActionPopover();
              const next = togglePaperReactionState(
                loadPaperReactionState(),
                currentPaperId,
                action,
              );
              savePaperReactionState(next);
              syncPaperStateDisplays(currentPaperId);
              return;
            }
            if (action === 'marker') {
              togglePaperActionPopover('marker');
              return;
            }
            if (action === 'download') {
              togglePaperActionPopover('download');
            }
          });
          document.body.appendChild(toolbar);
        }
        PAPER_ACTIONS_STATE.paperId = paperId;
        toolbar.hidden = false;
        refreshPaperActionToolbarState(paperId);
      };

      const updateSidebarStateBadges = (li, status, reaction, labels) => {
        if (!li) return;
        const badges = buildPaperStateBadges(status, reaction, labels);
        li.classList.toggle('sidebar-paper-has-user-state', badges.length > 0);
        const staleWrap = getDirectChildByClass(li, 'sidebar-paper-state-badges');
        if (staleWrap && staleWrap.remove) staleWrap.remove();
        const metaLine = li.querySelector('.dpr-sidebar-meta-line');
        const metaTags = li.querySelector('.dpr-sidebar-meta-tags');
        const host = metaLine || metaTags || li;
        let wrap = getDirectChildByClass(host, 'sidebar-paper-state-badges');
        if (!badges.length) {
          if (wrap && wrap.remove) wrap.remove();
          return;
        }
        if (!wrap) {
          wrap = document.createElement('span');
          wrap.className = 'sidebar-paper-state-badges';
          host.appendChild(wrap);
        }
        clearNode(wrap);
        badges.forEach((badge) => {
          const el = document.createElement('span');
          el.className = `sidebar-paper-state-badge ${badge.type} ${badge.className}`;
          el.title = badge.title || '';
          el.setAttribute('aria-hidden', 'true');
          if (badge.color) el.style.setProperty('--dpr-sidebar-marker-color', badge.color);
          wrap.appendChild(el);
        });
      };

      const markSidebarReadState = (currentPaperId) => {
        const nav = document.querySelector('.sidebar-nav');
        if (!nav) return;

        const state = loadReadState();
        const reactions = loadPaperReactionState();
        const markerLabels = loadMarkerLabels();
        if (currentPaperId) {
          if (!state[currentPaperId]) {
            state[currentPaperId] = 'read';
          }
          saveReadState(state);
        }

        const applyLiState = (li, paperIdFromHref) => {
          const status = state[paperIdFromHref];
          li.classList.remove(
            'sidebar-paper-read',
            'sidebar-paper-good',
            'sidebar-paper-bad',
            'sidebar-paper-blue',
            'sidebar-paper-orange',
          );
          if (status === 'read') {
            li.classList.add('sidebar-paper-read');
          }
        };

        const links = nav.querySelectorAll('a[href*="#/"]');
        links.forEach((a) => {
          const href = a.getAttribute('href') || '';
          const m = href.match(/#\/(.+)$/);
          if (!m) return;
          const paperIdFromHref = m[1].replace(/\/$/, '');
          const li = a.closest('li');
          if (!li) return;
          if (
            a.classList.contains('dpr-sidebar-brief-link') ||
            /\/README$/i.test(paperIdFromHref) ||
            !/^(?:\d{6}\/\d{2}|\d{8}-\d{8}|local-pdf\/\d{8})\/(?!README$).+/i.test(paperIdFromHref)
          ) {
            li.classList.remove('sidebar-paper-item', 'sidebar-paper-has-user-state');
            const strayActions = li.querySelector('.sidebar-paper-rating-icons');
            const strayLeftActions = li.querySelector('.sidebar-paper-left-actions');
            const strayBadges = getDirectChildByClass(li, 'sidebar-paper-state-badges');
            const strayMetaBadges = li.querySelector('.dpr-sidebar-meta-tags > .sidebar-paper-state-badges, .dpr-sidebar-meta-line > .sidebar-paper-state-badges');
            if (strayActions && strayActions.remove) strayActions.remove();
            if (strayLeftActions && strayLeftActions.remove) strayLeftActions.remove();
            if (strayBadges && strayBadges.remove) strayBadges.remove();
            if (strayMetaBadges && strayMetaBadges.remove) strayMetaBadges.remove();
            return;
          }
          li.classList.add('sidebar-paper-item');

          const oldRatingActions = li.querySelector('.sidebar-paper-rating-icons');
          const oldLeftActions = li.querySelector('.sidebar-paper-left-actions');
          if (oldRatingActions && oldRatingActions.remove) oldRatingActions.remove();
          if (oldLeftActions && oldLeftActions.remove) oldLeftActions.remove();

          applyLiState(li, paperIdFromHref);
          updateSidebarStateBadges(
            li,
            state[paperIdFromHref],
            reactions[paperIdFromHref],
            markerLabels,
          );
        });
      };

      const normalizeSidebarDeleteHref = (href) =>
        normalizeHref(href)
          .replace(/\.md$/i, '')
          .replace(/\/$/, '');

      const isGuestAccessMode = () =>
        String(window.DPR_ACCESS_MODE || '').toLowerCase() === 'guest';

      const extractSidebarLineHref = (line) => {
        const m = String(line || '').match(/\bhref=(["'])(.*?)\1/i);
        return m ? normalizeSidebarDeleteHref(m[2]) : '';
      };

      const pruneEmptySidebarPaperSections = (lines) => {
        for (let i = 0; i < lines.length; i += 1) {
          const line = String(lines[i] || '');
          if (!/^\s*\*\s+(?:精读区|速读区)\s*$/.test(line.trim())) continue;
          const indent = (line.match(/^\s*/) || [''])[0].length;
          let hasPaperItem = false;
          for (let j = i + 1; j < lines.length; j += 1) {
            const next = String(lines[j] || '');
            if (!next.trim()) continue;
            const nextIndent = (next.match(/^\s*/) || [''])[0].length;
            if (nextIndent <= indent) break;
            if (next.includes('dpr-sidebar-item-link')) {
              hasPaperItem = true;
              break;
            }
          }
          if (!hasPaperItem) {
            lines.splice(i, 1);
            i -= 1;
          }
        }
        return lines;
      };

      const removeSidebarEntryFromContent = (content, href) => {
        const targetHref = normalizeSidebarDeleteHref(href);
        if (!targetHref) return String(content || '');

        const raw = String(content || '').replace(/\r\n/g, '\n');
        const hadTrailingNewline = raw.endsWith('\n');
        const lines = raw.split('\n');
        if (hadTrailingNewline) lines.pop();

        let removed = false;
        const filtered = lines.filter((line) => {
          const lineHref = extractSidebarLineHref(line);
          const matched = lineHref && lineHref === targetHref;
          if (matched) {
            removed = true;
            return false;
          }
          return true;
        });

        if (!removed) return raw;
        pruneEmptySidebarPaperSections(filtered);
        return filtered.join('\n') + (hadTrailingNewline ? '\n' : '');
      };

      const getPaperIdFromSidebarHref = (href) =>
        normalizeSidebarDeleteHref(href).replace(/^#\//, '').replace(/\/$/, '');

      const normalizeGeneratedAssetRepoPath = (value) => {
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
        if (docsIdx >= 0) {
          raw = raw.slice(docsIdx + 1);
        }
        raw = raw.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
        if (raw.startsWith('docs/')) return raw;
        if (raw.startsWith('assets/')) return `docs/${raw}`;
        return '';
      };

      const addRepoDeletePath = (set, value) => {
        const path = String(value || '').trim().replace(/^\/+/, '').replace(/\/{2,}/g, '/');
        if (path && path !== 'docs/_sidebar.md') set.add(path);
      };

      const collectSidebarEntryRelatedDeletePaths = async ({ api, href }) => {
        const paperId = getPaperIdFromSidebarHref(href);
        const paths = new Set();
        if (!paperId) return [];

        const mdPath = `docs/${paperId}.md`;
        const txtPath = `docs/${paperId}.txt`;
        addRepoDeletePath(paths, mdPath);
        addRepoDeletePath(paths, txtPath);

        let markdown = '';
        try {
          const paperFile = await api.loadRepoTextFile(mdPath, { requireWorkflow: false });
          markdown = String((paperFile && paperFile.content) || '');
        } catch (err) {
          if (!String((err && err.message) || '').includes('HTTP 404')) {
            throw err;
          }
        }

        if (!markdown) return Array.from(paths);

        const parsed = parseFrontMatter(markdown);
        const meta = parsed && parsed.meta ? parsed.meta : {};
        const pdfPath = normalizeGeneratedAssetRepoPath(meta.pdf || meta.PDF || '');
        addRepoDeletePath(paths, pdfPath);

        const figureDirs = new Set();
        parseFiguresMeta(meta).forEach((figure) => {
          const figurePath = normalizeGeneratedAssetRepoPath(figure && figure.url);
          if (!figurePath) return;
          addRepoDeletePath(paths, figurePath);
          const dir = figurePath.replace(/\/[^/]+$/, '');
          if (dir && dir !== figurePath) figureDirs.add(dir);
        });
        figureDirs.forEach((dir) => {
          addRepoDeletePath(paths, `${dir}/`);
        });

        return Array.from(paths);
      };

      const getSidebarEntryTitle = (link) => {
        if (!link) return '该条目';
        const titleEl = link.querySelector('.dpr-sidebar-title');
        const title =
          (titleEl && titleEl.textContent) ||
          link.getAttribute('title') ||
          link.textContent ||
          '';
        return String(title || '').replace(/\s+/g, ' ').trim() || '该条目';
      };

      const showSidebarDeleteConfirm = ({ title }) =>
        new Promise((resolve) => {
          const previousFocus = document.activeElement;
          const overlay = document.createElement('div');
          overlay.className = 'dpr-sidebar-delete-confirm-overlay';
          overlay.setAttribute('role', 'presentation');

          const dialog = document.createElement('div');
          dialog.className = 'dpr-sidebar-delete-confirm';
          dialog.setAttribute('role', 'dialog');
          dialog.setAttribute('aria-modal', 'true');
          dialog.setAttribute('aria-labelledby', 'dpr-sidebar-delete-confirm-title');
          dialog.setAttribute('aria-describedby', 'dpr-sidebar-delete-confirm-desc');

          const head = document.createElement('div');
          head.className = 'dpr-sidebar-delete-confirm-head';

          const icon = document.createElement('div');
          icon.className = 'dpr-sidebar-delete-confirm-icon';
          icon.setAttribute('aria-hidden', 'true');
          icon.innerHTML =
            '<svg viewBox="0 0 24 24">' +
            '<path d="M3 6h18"/>' +
            '<path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6"/>' +
            '<path d="M19 6l-.8 13.1A2 2 0 0 1 16.2 21H7.8a2 2 0 0 1-2-1.9L5 6"/>' +
            '<path d="M10 11v5"/>' +
            '<path d="M14 11v5"/>' +
            '</svg>';

          const titleWrap = document.createElement('div');
          const titleEl = document.createElement('div');
          titleEl.id = 'dpr-sidebar-delete-confirm-title';
          titleEl.className = 'dpr-sidebar-delete-confirm-title';
          titleEl.textContent = '移入回收站';
          const paperEl = document.createElement('div');
          paperEl.className = 'dpr-sidebar-delete-confirm-paper';
          paperEl.textContent = String(title || '该条目').trim() || '该条目';
          titleWrap.appendChild(titleEl);
          titleWrap.appendChild(paperEl);

          head.appendChild(icon);
          head.appendChild(titleWrap);

          const desc = document.createElement('p');
          desc.id = 'dpr-sidebar-delete-confirm-desc';
          desc.className = 'dpr-sidebar-delete-confirm-desc';
          desc.textContent =
            '确认后仅将该文献及相关 Markdown、TXT、PDF 与图片资源移入回收站；可在设置页回收站彻底删除或恢复。';

          const actions = document.createElement('div');
          actions.className = 'dpr-sidebar-delete-confirm-actions';
          const cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'dpr-sidebar-delete-confirm-btn secondary';
          cancelBtn.textContent = '取消';
          const deleteBtn = document.createElement('button');
          deleteBtn.type = 'button';
          deleteBtn.className = 'dpr-sidebar-delete-confirm-btn danger';
          deleteBtn.textContent = '确认删除';
          actions.appendChild(cancelBtn);
          actions.appendChild(deleteBtn);

          dialog.appendChild(head);
          dialog.appendChild(desc);
          dialog.appendChild(actions);
          overlay.appendChild(dialog);

          let settled = false;
          const cleanup = (value) => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKeydown, true);
            overlay.classList.remove('is-visible');
            window.setTimeout(() => {
              if (overlay.parentNode) overlay.remove();
              try {
                if (previousFocus && typeof previousFocus.focus === 'function') {
                  previousFocus.focus();
                }
              } catch {
                // ignore
              }
              resolve(value);
            }, 140);
          };

          const onKeydown = (event) => {
            const keyName = event && (event.key || event.code);
            if (keyName === 'Escape') {
              event.preventDefault();
              cleanup(false);
            }
          };

          overlay.addEventListener('click', (event) => {
            if (event.target === overlay) cleanup(false);
          });
          cancelBtn.addEventListener('click', () => cleanup(false));
          deleteBtn.addEventListener('click', () => cleanup(true));
          document.addEventListener('keydown', onKeydown, true);

          document.body.appendChild(overlay);
          requestAnimationFrame(() => {
            overlay.classList.add('is-visible');
            cancelBtn.focus();
          });
        });

      const findSidebarDeleteFallbackHref = (li) => {
        let current =
          li && li.parentElement && li.parentElement.closest
            ? li.parentElement.closest('li')
            : null;
        while (current) {
          const brief = current.querySelector(':scope > ul a.dpr-sidebar-brief-link[href]');
          if (brief) return normalizeHref(brief.getAttribute('href') || '');
          current =
            current.parentElement && current.parentElement.closest
              ? current.parentElement.closest('li')
              : null;
        }
        return '#/';
      };

      const removeSidebarLiAndEmptySection = (li) => {
        if (!li || !li.parentElement) return;
        const parentUl = li.parentElement;
        const sectionLi = parentUl.closest('li');
        li.remove();
        if (!sectionLi || !sectionLi.parentElement) return;
        const sectionLabel = sectionLi.querySelector(
          ':scope > .dpr-sidebar-group-toggle .dpr-sidebar-group-toggle-label',
        );
        const sectionText = stripSidebarEmoji(
          (sectionLabel &&
            ((sectionLabel.dataset && sectionLabel.dataset.dprRawLabel) ||
              sectionLabel.textContent)) ||
            Array.from(sectionLi.childNodes || [])
              .filter((node) => node && node.nodeType === Node.TEXT_NODE)
              .map((node) => node.textContent || '')
              .join(' '),
        );
        if (!/^(?:精读区|速读区)$/.test(sectionText)) return;
        if (parentUl.querySelector('a.dpr-sidebar-item-link')) return;
        sectionLi.remove();
      };

      const deleteSidebarEntryFromRepo = async ({ href, title }) => {
        const api = window.SubscriptionsGithubToken;
        const storageRuntime = window.DPRStorageManager && window.DPRStorageManager.__runtime;
        if (
          !api ||
          typeof api.loadRepoTextFile !== 'function' ||
          typeof api.moveRepoPathsToTrash !== 'function'
        ) {
          throw new Error('GitHub Token 模块尚未加载，无法写回仓库。');
        }
        if (
          !storageRuntime ||
          typeof storageRuntime.loadTrashManifest !== 'function' ||
          typeof storageRuntime.serializeTrashManifest !== 'function' ||
          typeof storageRuntime.buildSidebarTrashItem !== 'function'
        ) {
          throw new Error('运行态回收站模块尚未加载。');
        }
        const targetHref = normalizeSidebarDeleteHref(href);
        const sidebarFile = await api.loadRepoTextFile('docs/_sidebar.md', {
          requireWorkflow: false,
        });
        const nextSidebar = removeSidebarEntryFromContent(sidebarFile.content, targetHref);
        if (nextSidebar === sidebarFile.content) {
          throw new Error('未在 docs/_sidebar.md 中找到这个侧栏条目。');
        }
        const deletePaths = await collectSidebarEntryRelatedDeletePaths({ api, href: targetHref });
        const manifest = await storageRuntime.loadTrashManifest(api);
        const trashItem = storageRuntime.buildSidebarTrashItem({
          href: targetHref,
          title,
          paths: deletePaths,
          sidebar: sidebarFile.content,
        });
        const nextManifest = storageRuntime.normalizeTrashManifest(manifest);
        nextManifest.items.push(trashItem);
        const updates = [
          { path: 'docs/_sidebar.md', content: nextSidebar },
          {
            path: storageRuntime.TRASH_MANIFEST_PATH || 'trash/manifest.json',
            content: storageRuntime.serializeTrashManifest(nextManifest),
          },
        ];
        const result = await api.moveRepoPathsToTrash(
          {
            paths: deletePaths,
            updates,
          },
          `chore: move sidebar paper to trash: ${String(title || '').slice(0, 72)}`,
          { requireWorkflow: false },
        );
        return { ...result, paths: deletePaths, href: targetHref };
      };

      const ensureSidebarEntryDeleteButtons = () => {
        const nav = document.querySelector('.sidebar-nav');
        if (!nav) return;
        if (isGuestAccessMode()) {
          nav
            .querySelectorAll('.dpr-sidebar-entry-delete-btn')
            .forEach((btn) => btn.remove());
          return;
        }
        const links = nav.querySelectorAll('li.sidebar-paper-item > a.dpr-sidebar-item-link[href*="#/"]');
        links.forEach((link) => {
          const li = link.closest('li');
          if (!li || li.querySelector(':scope > .dpr-sidebar-entry-delete-btn')) return;
          const href = normalizeSidebarDeleteHref(link.getAttribute('href') || '');
          if (!href) return;

          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'dpr-sidebar-entry-delete-btn';
          btn.setAttribute('aria-label', '删除条目');
          btn.setAttribute('title', '删除条目');
          btn.innerHTML =
            '<svg viewBox="0 0 24 24" aria-hidden="true">' +
            '<path d="M3 6h18"/>' +
            '<path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6"/>' +
            '<path d="M19 6l-.8 13.1A2 2 0 0 1 16.2 21H7.8a2 2 0 0 1-2-1.9L5 6"/>' +
            '<path d="M10 11v5"/>' +
            '<path d="M14 11v5"/>' +
            '</svg>';
          btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
            if (btn.disabled) return;

            const title = getSidebarEntryTitle(link);
            if (isGuestAccessMode()) {
              window.alert('游客模式不能删除精读/速读条目。请先解锁密钥后再操作。');
              return;
            }
            const ok = await showSidebarDeleteConfirm({ title });
            if (!ok) return;

            const currentHref = normalizeSidebarDeleteHref(window.location.hash || '#/');
            const fallbackHref = findSidebarDeleteFallbackHref(li);
            btn.disabled = true;
            btn.classList.add('is-busy');
            li.classList.add('sidebar-paper-delete-busy');
            const storageRuntime = window.DPRStorageManager && window.DPRStorageManager.__runtime;
            const progress = storageRuntime && typeof storageRuntime.showBlockingProgress === 'function'
              ? storageRuntime.showBlockingProgress({
                title: '正在移入回收站',
                message: '正在准备删除计划...',
                tone: 'danger',
              })
              : null;
            try {
              if (progress) progress.setMessage('正在移动文件到回收站...');
              const result = await deleteSidebarEntryFromRepo({ href, title });
              removeSidebarLiAndEmptySection(li);
              updateNavState();
              const impacted = currentHref && (
                currentHref === normalizeSidebarDeleteHref(href) ||
                (storageRuntime && typeof storageRuntime.routeImpactedByPaths === 'function'
                  ? storageRuntime.routeImpactedByPaths(currentHref, (result && result.paths) || [])
                  : false)
              );
              if (impacted) {
                window.location.hash = fallbackHref || '#/';
              } else if (currentHref && currentHref === href) {
                window.location.hash = fallbackHref || '#/';
              }
              requestAnimationFrame(() => {
                syncSidebarActiveIndicator({ animate: false });
              });
              if (progress) {
                progress.setMessage('已移入回收站，可在设置页恢复或彻底删除。');
                progress.close();
              }
            } catch (err) {
              btn.disabled = false;
              btn.classList.remove('is-busy');
              li.classList.remove('sidebar-paper-delete-busy');
              if (progress) {
                progress.setError(`删除失败：${err && err.message ? err.message : err}`);
              } else {
                window.alert(`删除失败：${err && err.message ? err.message : err}`);
              }
            }
          });
          li.appendChild(btn);
        });
      };

      const parseScoreNumber = (scoreValue) => {
        const match = String(scoreValue || '').trim().match(/[-+]?\d+(?:\.\d+)?/);
        if (!match) return Number.NaN;
        return Number(match[0]);
      };

      const scoreToStarRating = (scoreValue) => {
        const score = parseScoreNumber(scoreValue);
        if (!Number.isFinite(score)) return 0;
        const clamped = Math.max(0, Math.min(10, score));
        return Math.floor(clamped + 0.5) / 2;
      };

      const buildSidebarStarsHtml = (scoreValue) => {
        const rating = scoreToStarRating(scoreValue);
        const scoreNum = parseScoreNumber(scoreValue);
        const scoreText = Number.isFinite(scoreNum) ? scoreNum.toFixed(1) : '';
        const scoreLabel = String(scoreValue || '')
          .replace(/^\s*[-+]?\d+(?:\.\d+)?\s*/, '')
          .trim();
        const title = scoreText
          ? `评分：${scoreText}/10${scoreLabel ? ` ${scoreLabel}` : ''}（${rating.toFixed(1)}/5）`
          : '评分：无';
        const pct = Math.max(0, Math.min(100, (rating / 5) * 100));
        return (
          `<span class="dpr-stars" title="${escapeHtml(title)}" aria-label="${rating.toFixed(1)} out of 5">` +
          '<span class="dpr-stars-bg">☆☆☆☆☆</span>' +
          `<span class="dpr-stars-fill" style="width:${pct.toFixed(0)}%">★★★★★</span>` +
          '</span>'
        );
      };

      const hydrateStructuredSidebarItems = () => {
        const nav = document.querySelector('.sidebar-nav');
        if (!nav) return;
        const links = nav.querySelectorAll('a.dpr-sidebar-item-link[href*="#/"]');
        links.forEach((a) => {
          if (a.dataset.sidebarStructuredHydrated === '1') return;
          const href = String(a.getAttribute('href') || '').trim();
          const routeMatch = href.match(/#\/(.+)$/);
          const routeId = routeMatch ? decodeURIComponent(routeMatch[1]).replace(/\/$/, '') : '';
          const arxivId = routeId ? routeId.split('/').slice(-1)[0] : '';
          const fallbackLink = arxivId ? `https://arxiv.org/abs/${arxivId}` : '';

          let payload = null;
          const raw = a.getAttribute('data-sidebar-item') || '';
          if (raw) {
            try {
              payload = JSON.parse(raw);
            } catch {
              payload = null;
            }
          }

          // 兼容历史 sidebar：从旧 DOM（title/tags/score）回填结构化数据
          if (!payload || typeof payload !== 'object') {
            const legacyTitle = String(
              (a.querySelector('.dpr-sidebar-title') && a.querySelector('.dpr-sidebar-title').textContent) ||
                a.textContent ||
                '',
            ).trim();
            const legacyScoreNode = a.querySelector('.dpr-sidebar-tag-score .dpr-stars');
            const legacyScoreTitle = String(
              (legacyScoreNode && legacyScoreNode.getAttribute('title')) || '',
            );
            const scoreMatch = legacyScoreTitle.match(/评分：\s*([0-9]+(?:\.[0-9]+)?)\s*\/10/);
            const legacyScore = scoreMatch ? scoreMatch[1] : '-';
            const legacyTags = [];
            const tagNodes = a.querySelectorAll('.dpr-sidebar-tag');
            tagNodes.forEach((node) => {
              if (node.classList.contains('dpr-sidebar-tag-score')) return;
              const label = String(node.textContent || '').trim();
              if (!label) return;
              let kind = 'other';
              if (node.classList.contains('dpr-sidebar-tag-keyword')) kind = 'keyword';
              if (node.classList.contains('dpr-sidebar-tag-query')) kind = 'query';
              if (node.classList.contains('dpr-sidebar-tag-paper')) kind = 'paper';
              legacyTags.push({ kind, label });
            });
            payload = {
              title: legacyTitle || routeId,
              link: fallbackLink || href,
              score: legacyScore,
              tags: legacyTags,
            };
          }

          if (!payload || typeof payload !== 'object') return;

          const title = String(payload.title || a.textContent || '').trim();
          const link = String(payload.link || fallbackLink || href || '').trim();
          const score = String(payload.score || '').trim();
          const isLocalPdfItem = /^#\/local-pdf\/\d{8}\//i.test(href);
          const evidence = String(
            (payload && payload.evidence) ||
              (isLocalPdfItem ? '本地上传 PDF，使用后端精读流程生成。' : ''),
          ).trim();
          const tags = Array.isArray(payload.tags) ? payload.tags : [];

          const scoreHtml =
            score && score !== '-'
              ? `<span class="dpr-sidebar-tag dpr-sidebar-tag-score">${buildSidebarStarsHtml(score)}</span>`
              : '<span class="dpr-sidebar-score-empty">-</span>';

          const tagsHtml = tags
            .map((item) => {
              const rawKind = String((item && item.kind) || 'other').trim().toLowerCase();
              const kind = /^(keyword|query|paper|other)$/.test(rawKind) ? rawKind : 'other';
              const label = String((item && item.label) || '').trim();
              if (!label) return '';
              return `<span class="dpr-sidebar-tag dpr-sidebar-tag-${kind}">${escapeHtml(label)}</span>`;
            })
            .filter(Boolean)
            .join(' ');

          a.innerHTML =
            `<div class="dpr-sidebar-title">${escapeHtml(title)}</div>` +
            `<div class="dpr-sidebar-link-line">${escapeHtml(evidence || '-')}</div>` +
            `<div class="dpr-sidebar-meta-line">` +
            `${scoreHtml}` +
            `<span class="dpr-sidebar-meta-tags">${tagsHtml || '<span class="dpr-sidebar-tag dpr-sidebar-tag-other">-</span>'}</span>` +
            `</div>`;
          a.dataset.sidebarStructuredHydrated = '1';
        });
      };

      const decorateSidebarStaticLinks = () => {
        const nav = document.querySelector('.sidebar-nav');
        if (!nav) return;
        const current = normalizeHref(window.location.hash || '#/');
        const stripEmoji = (value) =>
          String(value || '')
            .replace(/^(?:[\s\uFE0F\u200D]*(?:[\u2600-\u27BF]|[\u{1F300}-\u{1FAFF}])\uFE0F?\s*)+/u, '')
            .trim();
        const setLinkLabel = (a, emoji, rawText) => {
          if (!a) return;
          const raw = stripEmoji(rawText || '');
          a.dataset.dprRawLabel = raw;
          a.textContent = '';
          const wrap = document.createElement('span');
          wrap.className = 'dpr-sidebar-label-with-icon';
          const icon = document.createElement('span');
          icon.className = 'dpr-sidebar-label-icon';
          icon.textContent = emoji || '';
          const label = document.createElement('span');
          label.className = 'dpr-sidebar-label-text';
          label.textContent = raw;
          wrap.appendChild(icon);
          wrap.appendChild(label);
          a.appendChild(wrap);
        };
        const setJumpLinkActive = (a, isActive) => {
          if (!a) return;
          a.classList.toggle('dpr-sidebar-static-active', !!isActive);
          a.classList.toggle('active', !!isActive);
          a.classList.toggle('router-link-active', !!isActive);
          const li = a.closest('li');
          if (li) li.classList.toggle('active', !!isActive);
        };

        nav.querySelectorAll('a.dpr-sidebar-root-link').forEach((a) => {
          const raw = stripEmoji(a.dataset.dprRawLabel || a.textContent || '');
          if (!raw) return;
          const emoji = raw === '首页' ? '🏠' : raw === '使用教程' ? '📘' : '';
          if (emoji) setLinkLabel(a, emoji, raw);
          const href = a.getAttribute('data-dpr-hash') || a.getAttribute('href') || '';
          const target = normalizeHref(href);
          const isStaticActive = !!target && current === target;
          setJumpLinkActive(a, isStaticActive);
        });

        nav.querySelectorAll('a.dpr-sidebar-brief-link').forEach((a) => {
          const raw = stripEmoji(a.dataset.dprRawLabel || a.textContent || '今日简报');
          setLinkLabel(a, '📝', raw || '今日简报');
          const target = normalizeHref(a.getAttribute('href') || '');
          setJumpLinkActive(a, !!target && current === target);
        });
      };

      const neutralizeSidebarNoactiveLinks = () => {
        const nav = document.querySelector('.sidebar-nav');
        if (!nav) return;
        const links = nav.querySelectorAll('a.dpr-sidebar-noactive-link');
        links.forEach((a) => {
          const keepStaticActive = a.classList.contains('dpr-sidebar-static-active');
          try {
            if (!keepStaticActive) a.classList.remove('active', 'router-link-active');
          } catch {
            // ignore
          }
          try {
            const li = a.closest('li');
            if (li) {
              li.classList.toggle('active', keepStaticActive);
            }
          } catch {
            // ignore
          }
        });
      };

      const bindSidebarVirtualHashLinks = () => {
        const nav = document.querySelector('.sidebar-nav');
        if (!nav) return;
        const links = nav.querySelectorAll('a[data-dpr-hash]');
        links.forEach((a) => {
          if (a.dataset.dprHashBound === '1') return;
          a.dataset.dprHashBound = '1';
          a.addEventListener('click', (e) => {
            const target = normalizeHref(a.getAttribute('data-dpr-hash') || '');
            if (!target) return;
            e.preventDefault();
            DPR_NAV_STATE.lastNavSource = 'click';
            window.location.hash = target;
          });
        });
      };

      // 侧边栏/正文的论文页标题条：英文右侧，中文左侧，中间竖线
      const isPaperRouteFile = (file) => {
        const f = String(file || '');
        return /^(?:\d{6}\/\d{2}|\d{8}-\d{8}|local-pdf\/\d{8})\/(?!README\.md$).+\.md$/i.test(f);
      };

      const isReportRouteFile = (file) => {
        const f = String(file || '');
        return (
          /^(?:\d{6}\/\d{2}|\d{8}-\d{8})\/README\.md$/i.test(f) ||
          /^reports\/(?:weekly|monthly)(?:\/[^/]+)?\/README\.md$/i.test(f)
        );
      };

      const isPeriodicReportRouteFile = (file) => {
        const f = String(file || '');
        return /^reports\/(?:weekly|monthly)(?:\/[^/]+)?\/README\.md$/i.test(f);
      };

      const fitTextToBox = (el, minPx, maxPx) => {
        if (!el) return;
        let size = maxPx;
        el.style.fontSize = `${size}px`;
        // 逐步缩小直到不溢出或达到最小值
        // 注意：scrollHeight > clientHeight 表示溢出（包含被 line-clamp 截断的情况）
        while (size > minPx && el.scrollHeight > el.clientHeight + 1) {
          size -= 1;
          el.style.fontSize = `${size}px`;
        }
      };

      // 为切页动效准备一个“正文包装层”，避免把聊天浮层/白色遮罩一起做淡入淡出（否则会闪烁）
      const DPR_PAGE_CONTENT_CLASS = 'dpr-page-content';

      const ensurePageContentRoot = () => {
        const section = document.querySelector('.markdown-section');
        if (!section) return null;
        const existing = section.querySelector(
          `:scope > .${DPR_PAGE_CONTENT_CLASS}`,
        );
        if (existing) return existing;

        const root = document.createElement('div');
        root.className = DPR_PAGE_CONTENT_CLASS;
        // 将当前渲染出来的正文内容整体移入 root（此时 chat 模块尚未插入，避免把输入框一起移入）
        while (section.firstChild) {
          root.appendChild(section.firstChild);
        }
        section.appendChild(root);
        return root;
      };

      const getPageAnimEl = () => {
        const section = document.querySelector('.markdown-section');
        if (!section) return null;
        return (
          section.querySelector(`:scope > .${DPR_PAGE_CONTENT_CLASS}`) || section
        );
      };

      const syncPageTypeClasses = ({
        isHomePage = false,
        isReportPage = false,
        isPaperPage = false,
        isPeriodicReportPage = false,
      } = {}) => {
        const body = document.body;
        if (!body || !body.classList) return;
        body.classList.toggle('dpr-home-page', !!isHomePage);
        body.classList.toggle('dpr-report-page', !!isReportPage);
        body.classList.toggle('dpr-periodic-report-page', !!isPeriodicReportPage);
        body.classList.toggle('dpr-landing-page', !!(isHomePage || isReportPage));
        body.classList.toggle('dpr-paper-page', !!isPaperPage);
      };

      const bindPeriodicEvidenceToggles = (root) => {
        const scope = root || document;
        const buttons = scope.querySelectorAll(
          '.dpr-weekly-evidence-toggle:not([data-dpr-evidence-bound])',
        );
        buttons.forEach((button) => {
          button.dataset.dprEvidenceBound = '1';
          button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const strip = button.closest('[data-dpr-weekly-evidence]');
            const listId = button.getAttribute('aria-controls') || '';
            const list = listId
              ? document.getElementById(listId)
              : strip && strip.querySelector('.dpr-weekly-evidence-list');
            if (!strip || !list) return;
            const nextExpanded = button.getAttribute('aria-expanded') !== 'true';
            button.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
            button.textContent = nextExpanded ? '收起' : '展开';
            list.hidden = !nextExpanded;
            strip.classList.toggle('is-expanded', nextExpanded);
            strip.classList.toggle('is-collapsed', !nextExpanded);
          });
        });
      };

      const applyPaperTitleBar = () => {
        const file = vm && vm.route ? vm.route.file : '';
        if (!isPaperRouteFile(file)) {
          return;
        }

        const section = document.querySelector('.markdown-section');
        if (!section) return;
        const root =
          section.querySelector(`:scope > .${DPR_PAGE_CONTENT_CLASS}`) || section;

        // 防止重复插入
        const existing = root.querySelector('.dpr-title-bar');
        if (existing) existing.remove();
        const h1s = Array.from(root.querySelectorAll('h1'));
        if (!h1s.length) return;

        // 优先从带有 paper-title-zh / paper-title-en 类名的 h1 中获取标题（frontmatter 渲染）
        const paperTitleZh = root.querySelector('h1.paper-title-zh');
        const paperTitleEn = root.querySelector('h1.paper-title-en');

        let cnTitle = '';
        let enTitle = '';

        if (paperTitleZh || paperTitleEn) {
          // 新格式：从 frontmatter 渲染的带类名 h1 中获取
          cnTitle = paperTitleZh ? (paperTitleZh.textContent || '').trim() : '';
          enTitle = paperTitleEn ? (paperTitleEn.textContent || '').trim() : '';
        } else {
          // 旧格式兼容：如果有两个 h1，则第一个为英文、第二个为中文；
          // 如果只有一个 h1，则认为是"单标题"，放在左侧（cn 区）
          enTitle = (h1s[0].textContent || '').trim();
          cnTitle = (h1s[1] ? (h1s[1].textContent || '').trim() : '').trim();
          if (h1s.length === 1) {
            cnTitle = enTitle;
            enTitle = '';
          }
        }

        if (!cnTitle && !enTitle) return;

        // 隐藏原始 h1，但保留在 DOM 里供复制/SEO/元信息提取兜底
        h1s.forEach((h) => h.classList.add('dpr-title-hidden'));

        const bar = document.createElement('div');
        bar.className = 'dpr-title-bar';
        const titleLines = [];
        if (enTitle) {
          titleLines.push(`<div class="dpr-title-en">${escapeHtml(enTitle)}</div>`);
        }
        if (cnTitle) {
          titleLines.push(`<div class="dpr-title-cn">${escapeHtml(cnTitle)}</div>`);
        }
        bar.innerHTML = titleLines.join('\n');
        if (!cnTitle || !enTitle) {
          bar.classList.add('dpr-title-single');
        }

        const hero = root.querySelector('.paper-hero-card');
        if (hero) {
          const titleAnchor = hero.querySelector('.paper-title-row') || hero.firstChild;
          hero.insertBefore(bar, titleAnchor);
        } else {
          root.insertBefore(bar, root.firstChild);
        }

        // 字体自适应：让标题条高度稳定，长标题自动缩小
        requestAnimationFrame(() => {
          const cnEl = bar.querySelector('.dpr-title-cn');
          const enEl = bar.querySelector('.dpr-title-en');
          if (enEl && enTitle) fitTextToBox(enEl, 15, 24);
          if (cnEl && cnTitle) fitTextToBox(cnEl, 13, 19);
        });
      };

      const applyPaperAbstractFold = (root) => {
        if (!root || root.querySelector('.paper-abstract-fold')) return;

        const abstractHeading = Array.from(root.querySelectorAll('h2, h3')).find((heading) => (
          String(heading.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase() === 'abstract'
        ));
        if (!abstractHeading) return;

        const contentNodes = [];
        let cursor = abstractHeading.nextElementSibling;
        while (cursor) {
          const tag = String(cursor.tagName || '').toUpperCase();
          if (tag === 'H1' || tag === 'H2' || tag === 'HR') break;
          contentNodes.push(cursor);
          cursor = cursor.nextElementSibling;
        }
        if (!contentNodes.length) return;

        const wrapper = document.createElement('section');
        wrapper.className = 'paper-abstract-fold is-collapsed';
        wrapper.id = abstractHeading.id || 'abstract';

        const contentId = `paper-abstract-content-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const header = document.createElement('div');
        header.className = 'paper-abstract-fold-header';

        const title = document.createElement('div');
        title.className = 'paper-abstract-fold-title';
        title.innerHTML = '<span>Abstract</span><em>English original</em>';

        const toggle = document.createElement('button');
        toggle.className = 'paper-abstract-fold-toggle';
        toggle.type = 'button';
        toggle.setAttribute('aria-controls', contentId);
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = '展开';

        const content = document.createElement('div');
        content.id = contentId;
        content.className = 'paper-abstract-fold-content';
        content.setAttribute('aria-hidden', 'true');
        content.style.maxHeight = '0px';

        header.appendChild(title);
        header.appendChild(toggle);
        wrapper.appendChild(header);
        wrapper.appendChild(content);
        abstractHeading.replaceWith(wrapper);
        contentNodes.forEach((node) => content.appendChild(node));

        const setCollapsed = (collapsed) => {
          wrapper.classList.toggle('is-collapsed', collapsed);
          wrapper.classList.toggle('is-open', !collapsed);
          toggle.textContent = collapsed ? '展开' : '收起';
          toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
          content.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
          content.style.maxHeight = collapsed ? '0px' : `${content.scrollHeight}px`;
        };

        toggle.addEventListener('click', () => {
          setCollapsed(!wrapper.classList.contains('is-collapsed'));
        });
        window.addEventListener('resize', () => {
          if (wrapper.classList.contains('is-open')) {
            content.style.maxHeight = `${content.scrollHeight}px`;
          }
        });
      };

      // 研究价值卡片：兼容旧的 AI 输出，并统一前置为折叠卡片。

      const cleanResearchValueText = (value) =>
        String(value || '')
          .replace(/\s+/g, ' ')
          .replace(/^[-\u2022\s]+/, '')
          .trim();

      const relationTextFromNode = (node) => {
        const text = cleanResearchValueText(node && node.textContent);
        if (!text) return '';
        const match = text.match(/\u5173\u8054\u65b9\u5411\s*[\uFF1A:]\s*(.+)$/);
        return match ? match[1].trim() : text;
      };

      const findResearchRelationNode = (nodes) => {
        for (const node of nodes) {
          if (!node || node.nodeType !== 1) continue;
          const candidates = [];
          if (node.matches && node.matches('p, li')) candidates.push(node);
          if (node.querySelectorAll) {
            node.querySelectorAll('p, li').forEach((item) => candidates.push(item));
          }
          const found = candidates.find((item) => /\u5173\u8054\u65b9\u5411\s*[\uFF1A:]/.test(item.textContent || ''));
          if (found) return found;
        }
        return null;
      };

      const hasMeaningfulResearchNode = (node) =>
        !!(
          node &&
          (
            (node.nodeType === 1 && cleanResearchValueText(node.textContent)) ||
            (node.nodeType === 3 && cleanResearchValueText(node.textContent))
          )
        );

      const bindResearchValueCard = (card) => {
        if (!card || card.dataset.researchValueBound === '1') return;
        const toggle = card.querySelector('[data-research-value-toggle]');
        const body = card.querySelector('[data-research-value-body]');
        if (!toggle || !body) return;
        card.dataset.researchValueBound = '1';

        const openBodyMaxHeight = () => `${body.scrollHeight + 32}px`;
        const setCollapsed = (collapsed) => {
          card.classList.toggle('is-collapsed', collapsed);
          card.classList.toggle('is-open', !collapsed);
          toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
          toggle.textContent = collapsed ? '\u5c55\u5f00' : '\u6536\u8d77';
          body.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
          body.style.maxHeight = collapsed ? '0px' : openBodyMaxHeight();
        };

        toggle.addEventListener('click', () => {
          setCollapsed(!card.classList.contains('is-collapsed'));
        });
        window.addEventListener('resize', () => {
          if (card.classList.contains('is-open')) {
            body.style.maxHeight = openBodyMaxHeight();
          }
        });
        setCollapsed(true);
      };

      const createResearchValueCard = (contentNodes) => {
        const relationNode = findResearchRelationNode(contentNodes);
        const relationText = relationNode
          ? relationTextFromNode(relationNode)
          : '\u672a\u8bc6\u522b\u5230\u660e\u786e\u5173\u8054\u65b9\u5411\uff0c\u8bf7\u5c55\u5f00\u67e5\u770b\u4e0a\u4e0b\u6587\u3002';

        if (relationNode) {
          const parent = relationNode.parentElement;
          relationNode.remove();
          if (parent && /^(UL|OL)$/i.test(parent.tagName || '') && !parent.children.length) {
            parent.remove();
          }
        }

        const card = document.createElement('section');
        card.className = 'dpr-research-value-card is-collapsed';
        card.setAttribute('data-research-value-card', '1');

        const bodyId = `dpr-research-value-body-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const header = document.createElement('div');
        header.className = 'dpr-research-value-head';
        header.innerHTML =
          '<div>' +
          '<div class="dpr-research-value-kicker">Research Direction Insight</div>' +
          `<h2>${RESEARCH_VALUE_TITLE}</h2>` +
          '</div>';

        const toggle = document.createElement('button');
        toggle.className = 'dpr-research-value-toggle';
        toggle.type = 'button';
        toggle.setAttribute('aria-controls', bodyId);
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('data-research-value-toggle', '1');
        toggle.textContent = '\u5c55\u5f00';
        header.appendChild(toggle);

        const relation = document.createElement('div');
        relation.className = 'dpr-research-value-relation';
        relation.innerHTML =
          '<span>\u5173\u8054\u65b9\u5411</span>' +
          `<p>${escapeHtml(relationText)}</p>`;

        const body = document.createElement('div');
        body.id = bodyId;
        body.className = 'dpr-research-value-body';
        body.setAttribute('data-research-value-body', '1');
        body.setAttribute('aria-hidden', 'true');
        body.style.maxHeight = '0px';

        contentNodes.forEach((node) => {
          if (hasMeaningfulResearchNode(node)) body.appendChild(node);
        });

        card.appendChild(header);
        card.appendChild(relation);
        card.appendChild(body);
        return card;
      };

      const moveResearchValueCardAfterHero = (root, card) => {
        if (!root || !card) return;
        const hero = root.querySelector('.paper-hero-card');
        if (!hero || hero.nextSibling === card) return;
        root.insertBefore(card, hero.nextSibling);
      };

      const moveResearchFlowIntoValueCard = (root, card) => {
        if (!root || !card) return;
        const body = card.querySelector('[data-research-value-body]');
        if (!body) return;
        const flow = root.querySelector(':scope > .paper-flow-section');
        if (!flow || card.contains(flow)) return;
        body.appendChild(flow);
      };

      const isResearchValueBoundaryNode = (node) => {
        if (!node || node.nodeType !== 1) return false;
        const tag = String(node.tagName || '').toUpperCase();
        const text = cleanResearchValueText(node.textContent);
        if (/^H[1-3]$/.test(tag) || tag === 'HR' || /^\uFF08\u5B8C\uFF09$/.test(text)) {
          return true;
        }
        if (tag !== 'SECTION' || !node.classList) return false;
        return [
          'paper-flow-section',
          'paper-figure-section',
          'paper-abstract-fold',
          'paper-hero-card',
          'dpr-research-value-card',
        ].some((className) => node.classList.contains(className));
      };

      const applyPaperResearchValueCard = (root) => {
        if (!root) return;

        const existing = root.querySelector('.dpr-research-value-card');
        if (existing) {
          moveResearchValueCardAfterHero(root, existing);
          moveResearchFlowIntoValueCard(root, existing);
          bindResearchValueCard(existing);
          return;
        }

        const oldHtmlCard = root.querySelector('.dpr-research-insight-card');
        if (oldHtmlCard) {
          const contentNodes = Array.from(oldHtmlCard.childNodes).filter((node) => {
            if (node.nodeType !== 1) return hasMeaningfulResearchNode(node);
            if (node.classList && node.classList.contains('dpr-research-insight-kicker')) return false;
            if (/^H[1-6]$/i.test(node.tagName || '') && isResearchValueHeadingText(node.textContent)) return false;
            return hasMeaningfulResearchNode(node);
          });
          const card = createResearchValueCard(contentNodes);
          oldHtmlCard.replaceWith(card);
          moveResearchValueCardAfterHero(root, card);
          moveResearchFlowIntoValueCard(root, card);
          bindResearchValueCard(card);
          return;
        }

        const heading = Array.from(root.querySelectorAll('h2, h3')).find((item) =>
          isResearchValueHeadingText(item.textContent || ''),
        );
        if (!heading) return;

        const contentNodes = [];
        let cursor = heading.nextElementSibling;
        while (cursor) {
          if (isResearchValueBoundaryNode(cursor)) break;
          contentNodes.push(cursor);
          cursor = cursor.nextElementSibling;
        }
        if (!contentNodes.length) return;

        const card = createResearchValueCard(contentNodes);
        heading.replaceWith(card);
        moveResearchValueCardAfterHero(root, card);
        moveResearchFlowIntoValueCard(root, card);
        bindResearchValueCard(card);
      };

      // 论文页导航：左右滑动 / 键盘方向键切换论文
      const DPR_NAV_STATE = {
        paperHrefs: [],
        reportHrefs: [],
        currentHref: '',
        currentReportHref: '',
        lastNavTs: 0,
        lastNavSource: '', // 'click' | 'key' | 'wheel' | 'swipe' | ''
      };

      const DPR_SIDEBAR_CENTER_STATE = {
        lastHref: '',
        lastTs: 0,
      };

      const DPR_SIDEBAR_ACTIVE_INDICATOR = {
        el: null,
        parent: null,
        justMoved: false,
      };

      const getSidebarScrollEl = () => {
        const nav = document.querySelector('.sidebar-nav');
        if (!nav) return null;
        const candidates = [
          nav,
          nav.closest('.sidebar'),
          nav.parentElement,
          document.querySelector('.sidebar'),
        ].filter(Boolean);
        for (const el of candidates) {
          try {
            if (el.scrollHeight > el.clientHeight + 4) return el;
          } catch {
            // ignore
          }
        }
        return nav;
      };

      const ensureSidebarActiveIndicator = () => {
        const nav = document.querySelector('.sidebar-nav');
        if (!nav) return null;

        if (
          DPR_SIDEBAR_ACTIVE_INDICATOR.el &&
          DPR_SIDEBAR_ACTIVE_INDICATOR.parent === nav &&
          nav.contains(DPR_SIDEBAR_ACTIVE_INDICATOR.el)
        ) {
          return { el: DPR_SIDEBAR_ACTIVE_INDICATOR.el, newlyCreated: false };
        }

        // 清理旧的（例如热更新/重复初始化场景）
        try {
          if (DPR_SIDEBAR_ACTIVE_INDICATOR.el && DPR_SIDEBAR_ACTIVE_INDICATOR.el.remove) {
            DPR_SIDEBAR_ACTIVE_INDICATOR.el.remove();
          }
        } catch {
          // ignore
        }

        const indicator = document.createElement('div');
        indicator.className = 'dpr-sidebar-active-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        // 刚创建时先禁用 transition，避免出现“从 sidebar 顶部滑下来”的二次动效
        indicator.style.transition = 'none';
        // 放在最前面，确保在所有 li 下面
        nav.insertBefore(indicator, nav.firstChild);
        DPR_SIDEBAR_ACTIVE_INDICATOR.el = indicator;
        DPR_SIDEBAR_ACTIVE_INDICATOR.parent = nav;
        return { el: indicator, newlyCreated: true };
      };

      const hideSidebarActiveIndicator = () => {
        const ensured = ensureSidebarActiveIndicator();
        if (!ensured || !ensured.el) return;
        const indicator = ensured.el;
        indicator.style.opacity = '0';
        indicator.style.width = '0';
        indicator.style.height = '0';
      };

      const showSidebarActiveIndicator = () => {
        const ensured = ensureSidebarActiveIndicator();
        if (!ensured || !ensured.el) return;
        ensured.el.style.opacity = '1';
      };

      const isSidebarItemVisible = (el) => {
        try {
          if (!el) return false;
          // display:none / 被折叠时 offsetParent 会是 null
          if (el.offsetParent === null) return false;
          const rect = el.getBoundingClientRect();
          return rect && rect.width > 0 && rect.height > 0;
        } catch {
          return false;
        }
      };

      const moveSidebarActiveIndicatorToEl = (li, options = {}) => {
        if (!li) return;
        const { animate = true } = options || {};
        const ensured = ensureSidebarActiveIndicator();
        if (!ensured || !ensured.el) return;
        const indicator = ensured.el;
        const newlyCreated = ensured.newlyCreated;

        // 只对论文条目启用（避免日期分组标题等）
        if (!li.classList || !li.classList.contains('sidebar-paper-item')) return;
        // 若该条目在“折叠的日期”之下：隐藏高亮层，避免折叠后仍残留选中背景
        try {
          if (
            li.closest &&
            (li.closest('li.sidebar-day-collapsed') ||
              li.closest('li.dpr-sidebar-group-collapsed'))
          ) {
            hideSidebarActiveIndicator();
            return;
          }
        } catch {
          // ignore
        }
        if (!isSidebarItemVisible(li)) {
          hideSidebarActiveIndicator();
          return;
        }

        showSidebarActiveIndicator();

        // 不能用 offsetTop/offsetLeft：
        // 侧边栏是多层嵌套 li/ul，offset* 参照系会落在中间层，导致越往下选中偏移越明显。
        // 统一使用相对 .sidebar-nav 的几何坐标，保证展开多天后仍准确对齐。
        const nav = ensured.parent || (li.closest && li.closest('.sidebar-nav'));
        const navRect = nav ? nav.getBoundingClientRect() : null;
        const liRect = li.getBoundingClientRect();
        const x = navRect ? liRect.left - navRect.left + (nav.scrollLeft || 0) : li.offsetLeft;
        const y = navRect ? liRect.top - navRect.top + (nav.scrollTop || 0) : li.offsetTop;
        const w = liRect.width || li.offsetWidth;
        const h = liRect.height || li.offsetHeight;

        // 新建/或要求不动画时：先关 transition，直接定位到最终位置，再恢复 transition
        if (newlyCreated || !animate) {
          indicator.style.transition = 'none';
        }

        indicator.style.width = `${w}px`;
        indicator.style.height = `${h}px`;
        indicator.style.transform = `translate3d(${x}px, ${y}px, 0)`;

        if (newlyCreated || !animate) {
          requestAnimationFrame(() => {
            indicator.style.transition = '';
          });
        }
      };

      const moveSidebarActiveIndicatorToHref = (href, options = {}) => {
        const targetHref = normalizeHref(href);
        if (!targetHref) return;
        const nav = document.querySelector('.sidebar-nav');
        if (!nav) return;
        const link = nav.querySelector(`a[href="${targetHref}"]`);
        if (!link) return;
        const li = link.closest('li');
        moveSidebarActiveIndicatorToEl(li, options);
      };

      const syncSidebarActiveIndicator = (options = {}) => {
        const { animate = false } = options || {};
        const nav = document.querySelector('.sidebar-nav');
        if (!nav) return;

        // 1) 优先按“当前路由 href”精确匹配，避免 Docsify 多个 active 时命中错误项
        const routeHref = DPR_NAV_STATE.currentHref || '';
        if (routeHref) {
          const links = Array.from(nav.querySelectorAll('a[href]'));
          for (let i = 0; i < links.length; i += 1) {
            const a = links[i];
            const href = normalizeHref(a.getAttribute('href') || '');
            if (href !== routeHref) continue;
            const li = a.closest('li');
            if (li && li.classList && li.classList.contains('sidebar-paper-item')) {
              moveSidebarActiveIndicatorToEl(li, { animate });
              return;
            }
          }
        }

        // 2) 兜底：如果存在多个 active，取最后一个（通常是更深层、当前真正选中项）
        const activeLis = Array.from(
          nav.querySelectorAll('li.active.sidebar-paper-item'),
        );
        if (activeLis.length > 0) {
          moveSidebarActiveIndicatorToEl(activeLis[activeLis.length - 1], {
            animate,
          });
          return;
        }

        hideSidebarActiveIndicator();
      };

      // 暴露到全局，供 sidebar resize 时调用
      window.syncSidebarActiveIndicator = syncSidebarActiveIndicator;

      const DPR_TRANSITION = {
        // 'enter-from-left' | 'enter-from-right' | ''
        pendingEnter: '',
      };

      const decodeLegacyIdHash = (rawHash) => {
        const raw = String(rawHash || '').trim();
        if (!raw) return '';
        // 兼容 Docsify 旧式 hash：#/?id=%2f202602%2f06%2fxxx 或 #?id=/202602/06/xxx
        const m = raw.match(/^#\/?\?id=([^&]+)(?:&.*)?$/i);
        if (!m) return '';
        let decoded = '';
        try {
          decoded = decodeURIComponent(m[1] || '');
        } catch {
          decoded = m[1] || '';
        }
        decoded = String(decoded || '').trim();
        if (!decoded) return '';
        // 统一为无 .md 的路由形式
        decoded = decoded.replace(/\.md$/i, '');
        if (!decoded.startsWith('/')) decoded = '/' + decoded;
        return '#'+ decoded;
      };

      const normalizeHref = (href) => {
        const raw = String(href || '').trim();
        if (!raw) return '';
        const legacy = decodeLegacyIdHash(raw);
        if (legacy) return legacy;
        // 统一成 "#/xxxx" 形式
        if (raw.startsWith('#/')) return raw;
        if (raw.startsWith('#')) return '#/' + raw.slice(1).replace(/^\//, '');
        return '#/' + raw.replace(/^\//, '');
      };

      const isPaperHref = (href) => {
        const h = normalizeHref(href);
        // 匹配论文页：
        // - 传统路径：#/YYYYMM/DD/slug
        // - 区间路径：#/YYYYMMDD-YYYYMMDD/slug
        return /^#\/(?:\d{6}\/\d{2}|\d{8}-\d{8})\/(?!README$).+/i.test(h);
      };

      const isReportHref = (href) => {
        const h = normalizeHref(href);
        // 匹配日报页：
        // - 传统路径：#/YYYYMM/DD/README
        // - 区间路径：#/YYYYMMDD-YYYYMMDD/README
        return /^#\/(?:\d{6}\/\d{2}|\d{8}-\d{8})\/README$/i.test(h);
      };

      const isPaperHrefFallback = (href) => {
        const h = normalizeHref(href);
        return h.startsWith('#/') && h.includes('/') && !/\/README$/i.test(h);
      };

      const collectPaperHrefsFromSidebar = () => {
        const nav = document.querySelector('.sidebar-nav');
        if (!nav) return [];
        const links = Array.from(nav.querySelectorAll('a[href]'));
        const out = [];
        const seen = new Set();
        links.forEach((a) => {
          const href = a.getAttribute('href') || '';
          if (!isPaperHref(href)) return;
          const norm = normalizeHref(href);
          if (seen.has(norm)) return;
          seen.add(norm);
          out.push(norm);
        });
        return out;
      };

      const collectReportHrefsFromSidebar = () => {
        const links = [];
        const nav = document.querySelector('.sidebar-nav');
        if (nav) {
          links.push(...Array.from(nav.querySelectorAll('a[href]')));
        }
        const main = document.querySelector('.markdown-section');
        if (main) {
          links.push(...Array.from(main.querySelectorAll('a[href]')));
        }
        const out = [];
        const seen = new Set();
        links.forEach((a) => {
          const href = a.getAttribute('href') || '';
          if (!isReportHref(href)) return;
          const norm = normalizeHref(href);
          if (seen.has(norm)) return;
          seen.add(norm);
          out.push(norm);
        });
        return out;
      };

      const updateNavState = () => {
        DPR_NAV_STATE.paperHrefs = collectPaperHrefsFromSidebar();
        DPR_NAV_STATE.reportHrefs = collectReportHrefsFromSidebar();
        const file = vm && vm.route ? vm.route.file : '';
        if (file && isPaperRouteFile(file)) {
          DPR_NAV_STATE.currentHref = normalizeHref('#/' + String(file).replace(/\.md$/i, ''));
        } else {
          DPR_NAV_STATE.currentHref = '';
        }
        if (file && isReportRouteFile(file)) {
          DPR_NAV_STATE.currentReportHref = normalizeHref('#/' + String(file).replace(/\.md$/i, ''));
        } else {
          DPR_NAV_STATE.currentReportHref = '';
        }
      };

      const centerSidebarOnHref = (href) => {
        const targetHref = normalizeHref(href);
        if (!targetHref) return;
        if (targetHref === DPR_SIDEBAR_CENTER_STATE.lastHref) return;
        const nav = document.querySelector('.sidebar-nav');
        if (!nav) return;

        const link =
          nav.querySelector(`a[href="${targetHref}"]`) ||
          nav.querySelector(`a[href="${targetHref.replace(/^#\//, '#/')}"]`);
        if (!link) return;

        const item = link.closest('li') || link;
        const scrollEl = getSidebarScrollEl();
        if (!scrollEl || scrollEl.scrollHeight <= scrollEl.clientHeight + 4) {
          DPR_SIDEBAR_CENTER_STATE.lastHref = targetHref;
          return;
        }

        const scrollRect = scrollEl.getBoundingClientRect();
        const itemRect = item.getBoundingClientRect();

        const currentTop = scrollEl.scrollTop;
        const deltaTop = itemRect.top - scrollRect.top;
        const targetTop =
          currentTop + deltaTop - (scrollRect.height / 2 - itemRect.height / 2);

        const clamped = Math.max(
          0,
          Math.min(targetTop, scrollEl.scrollHeight - scrollEl.clientHeight),
        );

        DPR_SIDEBAR_CENTER_STATE.lastTs = Date.now();
        DPR_SIDEBAR_CENTER_STATE.lastHref = targetHref;

        // 居中时只需要“滚动”动画，不做额外高亮动画
        const duration = prefersReducedMotion() ? 0 : DPR_TRANSITION_MS;
        animateScrollTop(scrollEl, clamped, duration);
      };

      const centerSidebarOnCurrent = () => {
        // 优先跟随 Docsify 的“active”状态（这才是你看到的选中项）
        const nav = document.querySelector('.sidebar-nav');
        if (nav) {
          const activeLi = nav.querySelector('li.active');
          const activeLink = nav.querySelector('a.active');
          const el = activeLi || activeLink;
          if (el) {
            const href = (activeLink && activeLink.getAttribute('href')) || '';
            // 如果拿得到 href，就走 href 去重；否则用一个稳定的占位 key
            const key = href ? normalizeHref(href) : '__active__';
            if (key && key === DPR_SIDEBAR_CENTER_STATE.lastHref) return;

            const scrollEl = getSidebarScrollEl();
            if (!scrollEl) return;

            const scrollRect = scrollEl.getBoundingClientRect();
            const itemRect = el.getBoundingClientRect();

            const currentTop = scrollEl.scrollTop;
            const deltaTop = itemRect.top - scrollRect.top;
            const targetTop =
              currentTop +
              deltaTop -
              (scrollRect.height / 2 - itemRect.height / 2);

            const clamped = Math.max(
              0,
              Math.min(targetTop, scrollEl.scrollHeight - scrollEl.clientHeight),
            );

            DPR_SIDEBAR_CENTER_STATE.lastTs = Date.now();
            DPR_SIDEBAR_CENTER_STATE.lastHref = key;

            const duration = prefersReducedMotion() ? 0 : DPR_TRANSITION_MS;
            animateScrollTop(scrollEl, clamped, duration);
            return;
          }
        }

        // 兜底：按当前路由 href 匹配
        const href = DPR_NAV_STATE.currentHref || '';
        if (!href) return;
        centerSidebarOnHref(href);
      };

      const shouldIgnoreKeyNav = (event) => {
        if (!event) return true;
        if (event.defaultPrevented) return true;
        if (event.metaKey || event.ctrlKey || event.altKey) return true;
        const target = event.target;
        if (!target) return false;
        const tag = (target.tagName || '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (target.isContentEditable) return true;
        return false;
      };

      const navigateByDelta = (delta) => {
        const paperList = DPR_NAV_STATE.paperHrefs || [];
        const reportList = DPR_NAV_STATE.reportHrefs || [];
        const now = Date.now();
        if (now - (DPR_NAV_STATE.lastNavTs || 0) < 450) return;
        DPR_NAV_STATE.lastNavTs = now;

        const current = DPR_NAV_STATE.currentHref;
        const currentReport = DPR_NAV_STATE.currentReportHref;
        const isHome = !current && !currentReport;
        const reportMode = isHome || !!currentReport;
        const list = reportMode ? reportList : paperList;
        if (!list.length) return;

        // 首页：右键/左滑（delta=+1）跳到最新一天第一篇
        if (isHome) {
          if (delta > 0) {
            triggerPageNav(list[0], 'forward');
          }
          return;
        }

        const anchor = reportMode ? currentReport : current;
        const idx = list.indexOf(anchor);
        if (idx === -1) return;
        const nextIdx = idx + delta;
        if (nextIdx < 0 || nextIdx >= list.length) return;
        triggerPageNav(list[nextIdx], delta > 0 ? 'forward' : 'backward');
      };

      const prefersReducedMotion = () => {
        try {
          return (
            window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches
          );
        } catch {
          return false;
        }
      };

      // 统一“sidebar 居中滚动”和“页面切换”的动画时长，确保观感一致
      const DPR_TRANSITION_MS = 320;
      try {
        document.documentElement.style.setProperty(
          '--dpr-transition-ms',
          `${DPR_TRANSITION_MS}ms`,
        );
      } catch {
        // ignore
      }

      const DPR_SIDEBAR_SCROLL_ANIM = {
        rafId: 0,
      };

      const easeInOutCubic = (t) => {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      };

      const animateScrollTop = (el, targetTop, durationMs) => {
        if (!el) return;

        try {
          if (DPR_SIDEBAR_SCROLL_ANIM.rafId) {
            cancelAnimationFrame(DPR_SIDEBAR_SCROLL_ANIM.rafId);
            DPR_SIDEBAR_SCROLL_ANIM.rafId = 0;
          }
        } catch {
          // ignore
        }

        const to = Math.max(
          0,
          Math.min(targetTop, el.scrollHeight - el.clientHeight),
        );
        const from = el.scrollTop;
        const delta = to - from;
        if (Math.abs(delta) < 1 || !durationMs) {
          el.scrollTop = to;
          return;
        }

        const start =
          (window.performance && performance.now && performance.now()) ||
          Date.now();
        const step = (now) => {
          const t = Math.min(1, (now - start) / durationMs);
          const p = easeInOutCubic(t);
          el.scrollTop = from + delta * p;
          if (t < 1) {
            DPR_SIDEBAR_SCROLL_ANIM.rafId = requestAnimationFrame(step);
          } else {
            DPR_SIDEBAR_SCROLL_ANIM.rafId = 0;
          }
        };
        DPR_SIDEBAR_SCROLL_ANIM.rafId = requestAnimationFrame(step);
      };

      const triggerPageNav = (href, direction) => {
        const target = normalizeHref(href);
        if (!target) return;

        // 先把 sidebar 的“选中高亮层”滑动到目标条目，和页面切换同步
        moveSidebarActiveIndicatorToHref(target, { animate: true });
        DPR_SIDEBAR_ACTIVE_INDICATOR.justMoved = true;

        // 通过左右键/滑动切换时：提前把 sidebar 滚到目标项附近，提升“跟手”观感
        if (DPR_NAV_STATE.lastNavSource !== 'click') {
          centerSidebarOnHref(target);
        }

        // 决定入场方向：forward => 新页从右进；backward => 新页从左进
        DPR_TRANSITION.pendingEnter =
          direction === 'backward' ? 'enter-from-left' : 'enter-from-right';

        if (prefersReducedMotion()) {
          window.location.hash = target;
          return;
        }

        const animEl = getPageAnimEl();
        if (!animEl) {
          window.location.hash = target;
          return;
        }

        const exitClass =
          direction === 'backward' ? 'dpr-page-exit-right' : 'dpr-page-exit-left';

        animEl.classList.add('dpr-page-exit', exitClass);
        // 等退场动画结束后再切换路由
        setTimeout(() => {
          window.location.hash = target;
        }, DPR_TRANSITION_MS);
      };

      const PREFETCH_STATE = {
        cache: new Map(),
      };

      const hrefToMdUrl = (href) => {
        const h = normalizeHref(href);
        const m = h.match(/^#\/(.+)$/);
        if (!m) return '';
        const file = m[1].replace(/\/$/, '') + '.md';
        return 'docs/' + file;
      };

      const prefetchHref = async (href) => {
        const url = hrefToMdUrl(href);
        if (!url) return;
        const key = url;
        const now = Date.now();
        const prev = PREFETCH_STATE.cache.get(key);
        if (prev && now - prev.ts < 5 * 60 * 1000) return; // 5 分钟内不重复拉取
        try {
          const res = await fetch(url, { cache: 'force-cache' });
          if (!res.ok) return;
          // 读一下 body，确保写入浏览器缓存（同时做内存缓存兜底）
          const text = await res.text();
          PREFETCH_STATE.cache.set(key, { ts: now, len: text.length });
        } catch {
          // ignore
        }
      };

      const prefetchAdjacent = () => {
        const list = DPR_NAV_STATE.paperHrefs || [];
        if (!list.length) return;
        const current = DPR_NAV_STATE.currentHref;
        if (!current) {
          // 首页：预取最新一天第一篇
          prefetchHref(list[0]);
          return;
        }
        const idx = list.indexOf(current);
        if (idx === -1) return;
        const prev = idx > 0 ? list[idx - 1] : '';
        const next = idx + 1 < list.length ? list[idx + 1] : '';
        if (prev) prefetchHref(prev);
        if (next) prefetchHref(next);
      };

      const ensureNavHandlers = () => {
        if (window.__dprNavBound) return;
        window.__dprNavBound = true;

        // 禁用 Docsify 原生的标题锚点点击功能
        document.addEventListener('click', (e) => {
          try {
            if (!e || e.defaultPrevented) return;
            const target = e.target;
            // 检测是否点击了标题或标题内的锚点
            if (target && target.closest) {
              const heading = target.closest('h1, h2, h3, h4, h5, h6');
              if (heading && heading.closest('.markdown-section')) {
                const link = target.closest('a');
                if (link && link.hash && link.hash.startsWith('#') && !link.hash.startsWith('#/')) {
                  // 阻止标题锚点的默认跳转行为
                  e.preventDefault();
                  e.stopPropagation();
                  return false;
                }
              }
            }
          } catch {
            // ignore
          }
        }, true); // 使用捕获阶段，确保在 Docsify 之前拦截

        const toggleGoodForCurrent = () => {
          const current = DPR_NAV_STATE.currentHref || '';
          if (!current) return;
          const m = current.match(/^#\/(.+)$/);
          if (!m) return;
          const paperId = m[1];
          saveReadState(setPaperColorMarkerState(loadReadState(), paperId, 'good'));
          syncPaperStateDisplays(paperId);
        };

        // Number keys 1-4 toggle color markers.
        const toggleBookmarkForCurrent = (bookmarkType) => {
          const current = DPR_NAV_STATE.currentHref || '';
          if (!current) return;
          const m = current.match(/^#\/(.+)$/);
          if (!m) return;
          const paperId = m[1];
          saveReadState(setPaperColorMarkerState(loadReadState(), paperId, bookmarkType));
          syncPaperStateDisplays(paperId);
          if (document.activeElement && document.activeElement.blur) {
            document.activeElement.blur();
          }
        };

        window.addEventListener('keydown', (e) => {
          const key = e.key || '';
          if (shouldIgnoreKeyNav(e)) return;

          // 数字键 1234：绿蓝紫红书签
          if (key === '1') {
            e.preventDefault();
            toggleBookmarkForCurrent('good');   // 绿色
            return;
          }
          if (key === '2') {
            e.preventDefault();
            toggleBookmarkForCurrent('blue');   // 蓝色
            return;
          }
          if (key === '3') {
            e.preventDefault();
            toggleBookmarkForCurrent('orange'); // 紫色（橙色）
            return;
          }
          if (key === '4') {
            e.preventDefault();
            toggleBookmarkForCurrent('bad');    // 红色
            return;
          }

          if (key === ' ') {
            // 空格键：切换"不错（绿色勾）"
            e.preventDefault();
            toggleGoodForCurrent();
            return;
          }
          if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
          // 只在当前页面聚焦时工作：浏览器已聚焦窗口即可
          e.preventDefault();
          DPR_NAV_STATE.lastNavSource = 'key';
          navigateByDelta(key === 'ArrowRight' ? +1 : -1);
        });

        // 点击论文链接也走同一套“整页切换”动效（避免只有滑动/方向键有动画）
        document.addEventListener('click', (e) => {
          try {
            if (!e || e.defaultPrevented) return;
            // 仅拦截普通左键点击，避免影响新标签页/复制链接等行为
            if (typeof e.button === 'number' && e.button !== 0) return;
            if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

            const link = e.target && e.target.closest ? e.target.closest('a[href]') : null;
            if (!link) return;
            if (link.hasAttribute('download')) return;
            if (link.classList && link.classList.contains('dpr-sidebar-export-link')) return;
            const rawHref = String(link.getAttribute('href') || '').trim();
            if (rawHref.startsWith('blob:')) return;
            // 跳过外部链接（如 PDF 地址），让浏览器直接打开
            if (/^https?:\/\//i.test(rawHref)) return;
            const href = link.getAttribute('href') || '';
            const target = normalizeHref(href);
            if (!target || !isPaperHref(target) && !isPaperHrefFallback(target)) {
              return;
            }
            if (!target) return;
            if (target === (DPR_NAV_STATE.currentHref || '')) return;

            // 鼠标点击 sidebar：不触发“居中”逻辑
            DPR_NAV_STATE.lastNavSource = 'click';

            // 推断方向：按侧边栏顺序判断“前进/后退”
            let direction = 'forward';
            const list = DPR_NAV_STATE.paperHrefs || [];
            const cur = DPR_NAV_STATE.currentHref || '';
            if (list.length && cur) {
              const curIdx = list.indexOf(cur);
              const tgtIdx = list.indexOf(target);
              if (curIdx !== -1 && tgtIdx !== -1) {
                direction = tgtIdx < curIdx ? 'backward' : 'forward';
              }
            }

            // 只在论文页启用动效拦截，避免首页点击出现“无动画但有延迟”的体验
            if (document.body && document.body.classList.contains('dpr-paper-page') && !prefersReducedMotion()) {
              e.preventDefault();
              triggerPageNav(target, direction);
            }
          } catch {
            // ignore
          }
        });

        // 鼠标/触控板横向滚动：切换论文，并阻止浏览器的“整页滑动/回退动效”
        document.addEventListener(
          'wheel',
          (e) => {
            if (shouldIgnoreKeyNav(e)) return;
            const dx = e.deltaX || 0;
            const dy = e.deltaY || 0;
            if (Math.abs(dx) < 28) return;
            if (Math.abs(dx) < Math.abs(dy) * 1.2) return;
            e.preventDefault();
            // dx < 0：向左滑 => 下一篇
            // dx > 0：向右滑 => 上一篇
            DPR_NAV_STATE.lastNavSource = 'wheel';
            navigateByDelta(dx < 0 ? +1 : -1);
          },
          { passive: false },
        );

        // 触摸滑动：左右切换
        let startX = 0;
        let startY = 0;
        let startAt = 0;
        let lockHorizontal = false;
        const threshold = 60;

        const onTouchStart = (e) => {
          const t = e.touches && e.touches[0];
          if (!t) return;
          startX = t.clientX;
          startY = t.clientY;
          startAt = Date.now();
          lockHorizontal = false;
        };

        const onTouchMove = (e) => {
          const t = e.touches && e.touches[0];
          if (!t) return;
          const dx = t.clientX - startX;
          const dy = t.clientY - startY;
          if (Math.abs(dx) < 18) return;
          if (Math.abs(dx) > Math.abs(dy) * 1.2) {
            lockHorizontal = true;
          }
          if (lockHorizontal) {
            // 阻止浏览器的横向滑动/回退动效，让切换更“丝滑”
            if (e.cancelable) {
              e.preventDefault();
            }
          }
        };

        const onTouchEnd = (e) => {
          const t = e.changedTouches && e.changedTouches[0];
          if (!t) return;
          const dx = t.clientX - startX;
          const dy = t.clientY - startY;
          const dt = Date.now() - startAt;
          // 排除长按、轻微滑动、明显上下滚动
          if (dt > 900) return;
          if (Math.abs(dx) < threshold) return;
          if (Math.abs(dx) < Math.abs(dy) * 1.2) return;
          // dx < 0：向左滑 => 下一篇（相当于 ArrowRight）
          // dx > 0：向右滑 => 上一篇（相当于 ArrowLeft）
          DPR_NAV_STATE.lastNavSource = 'swipe';
          navigateByDelta(dx < 0 ? +1 : -1);
        };

        document.addEventListener('touchstart', onTouchStart, { passive: true });
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend', onTouchEnd, { passive: true });
      };

      // --- 解析 YAML front matter 并转换为 HTML ---
      const parseFrontMatter = (content) => {
        if (!content || !content.startsWith('---')) {
          return { meta: null, body: content };
        }
        const endIdx = content.indexOf('\n---', 3);
        if (endIdx === -1) {
          return { meta: null, body: content };
        }
        const yamlStr = content.slice(4, endIdx).trim();
        const body = content.slice(endIdx + 4).trim();

        const decodeYamlScalar = (rawValue) => {
          const text = String(rawValue || '').trim();
          if (text.length < 2) return text;
          const quote = text[0];
          if ((quote !== '"' && quote !== "'") || text[text.length - 1] !== quote) {
            return text;
          }
          const inner = text.slice(1, -1);
          if (quote === "'") return inner.replace(/''/g, "'");

          let out = '';
          let escaped = false;
          const escapeMap = {
            0: '\0',
            a: '\x07',
            b: '\b',
            t: '\t',
            n: '\n',
            v: '\v',
            f: '\f',
            r: '\r',
            e: '\x1b',
            '"': '"',
            '/': '/',
            '\\': '\\',
          };
          for (const ch of inner) {
            if (escaped) {
              out += Object.prototype.hasOwnProperty.call(escapeMap, ch)
                ? escapeMap[ch]
                : `\\${ch}`;
              escaped = false;
              continue;
            }
            if (ch === '\\') {
              escaped = true;
              continue;
            }
            out += ch;
          }
          if (escaped) out += '\\';
          return out;
        };

        // 简单解析 YAML（不依赖外部库）
        const meta = {};
        const lines = yamlStr.split('\n');
        for (const line of lines) {
          const colonIdx = line.indexOf(':');
          if (colonIdx === -1) continue;
          const key = line.slice(0, colonIdx).trim();
          let value = line.slice(colonIdx + 1).trim();

          // 处理数组格式 [a, b, c]
          if (value.startsWith('[') && value.endsWith(']')) {
            const inner = value.slice(1, -1);
            // 简单分割，处理引号内的逗号
            const items = [];
            let current = '';
            let inQuote = false;
            let quoteChar = '';
            for (let i = 0; i < inner.length; i++) {
              const c = inner[i];
              if (!inQuote && (c === '"' || c === "'")) {
                inQuote = true;
                quoteChar = c;
              } else if (inQuote && c === quoteChar) {
                inQuote = false;
              } else if (!inQuote && c === ',') {
                items.push(current.trim());
                current = '';
                continue;
              }
              current += c;
            }
            if (current.trim()) items.push(current.trim());
            // 去除引号
            meta[key] = items.map(s => decodeYamlScalar(s));
          } else {
            // 去除引号
            meta[key] = decodeYamlScalar(value);
          }
        }
        return { meta, body };
      };

      const escapePaperHtml = (s) => {
        if (!s) return '';
        return String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      };

      const parseFigureCaptionOrder = (caption) => {
        const match = String(caption || '')
          .trim()
          .match(/^(?:figure|fig|table|tab)\.?\s*([A-Za-z]*\d+(?:[.-]\d+)*[A-Za-z]?)/i);
        if (!match) return null;
        const parts = match[1].toLowerCase().match(/\d+|[a-z]+/g) || [];
        return parts.map((part) => (/^\d+$/.test(part)
          ? { type: 0, value: Number(part) }
          : { type: 1, value: part }));
      };

      const compareFigureCaptionOrder = (left, right) => {
        const maxLen = Math.max(left.length, right.length);
        for (let i = 0; i < maxLen; i++) {
          if (!left[i]) return -1;
          if (!right[i]) return 1;
          if (left[i].type !== right[i].type) return left[i].type - right[i].type;
          if (left[i].value < right[i].value) return -1;
          if (left[i].value > right[i].value) return 1;
        }
        return 0;
      };

      const compareFiguresByPdfOrder = (left, right) => {
        const leftPage = Number.isFinite(left.page) && left.page > 0 ? left.page : Number.MAX_SAFE_INTEGER;
        const rightPage = Number.isFinite(right.page) && right.page > 0 ? right.page : Number.MAX_SAFE_INTEGER;
        if (leftPage !== rightPage) return leftPage - rightPage;

        if (left.captionOrder && right.captionOrder) {
          const captionOrder = compareFigureCaptionOrder(left.captionOrder, right.captionOrder);
          if (captionOrder) return captionOrder;
        } else if (left.captionOrder || right.captionOrder) {
          return left.captionOrder ? -1 : 1;
        }

        const leftIndex = Number.isFinite(left.index) && left.index > 0 ? left.index : left.originalOrder;
        const rightIndex = Number.isFinite(right.index) && right.index > 0 ? right.index : right.originalOrder;
        if (leftIndex !== rightIndex) return leftIndex - rightIndex;
        return left.originalOrder - right.originalOrder;
      };

      const parseFiguresMeta = (meta) => {
        const raw = meta && typeof meta.figures_json === 'string' ? meta.figures_json.trim() : '';
        if (!raw) return [];
        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) return [];
          return parsed
            .filter((item) => item && typeof item === 'object')
            .map((item, index) => ({
              url: String(item.url || '').trim(),
              caption: String(item.caption || '').trim(),
              page: Number(item.page || 0),
              index: Number(item.index || index + 1),
              width: Number(item.width || 0),
              height: Number(item.height || 0),
              originalOrder: index + 1,
              captionOrder: parseFigureCaptionOrder(item.caption || ''),
            }))
            .filter((item) => item.url)
            .sort(compareFiguresByPdfOrder);
        } catch (_err) {
          return [];
        }
      };

      const resolveDocsAssetUrl = (value) => {
        const url = String(value || '').trim();
        if (!url) return '';
        if (/^(https?:)?\/\//i.test(url) || url.startsWith('data:')) return url;
        const basePath = (window.$docsify && window.$docsify.basePath) || 'docs/';
        const safeBase = /\/$/.test(basePath) ? basePath : `${basePath}/`;
        if (url.startsWith('docs/')) return url;
        return `${safeBase}${url.replace(/^\/+/, '')}`;
      };

      const renderFigureCarousel = (figures) => {
        if (!figures || !figures.length) return '';
        const slides = figures.map((figure, index) => {
          const pageText = figure.page ? `PDF p. ${figure.page}` : '';
          const captionText = String(figure.caption || '').trim();
          const longCaption = captionText.length > 220;
          const caption = captionText
            ? [
                `<div class="paper-figure-caption${longCaption ? ' is-collapsed' : ''}" data-figure-caption>${escapePaperHtml(captionText)}</div>`,
                longCaption
                  ? '<button class="paper-figure-caption-toggle" type="button" data-figure-caption-toggle>Expand caption</button>'
                  : '',
              ].join('')
            : '';
          const imageUrl = escapePaperHtml(resolveDocsAssetUrl(figure.url));
          return [
            `<div class="paper-figure-slide${index === 0 ? ' is-active' : ''}" data-figure-slide="${index}">`,
            `<button class="paper-figure-image-button" type="button" data-figure-lightbox="${index}" aria-label="Open Figure ${index + 1}">`,
            `<img class="paper-figure-image" src="${imageUrl}" alt="Paper Figure ${index + 1}" loading="lazy">`,
            '</button>',
            '<div class="paper-figure-meta">',
            `<div class="paper-figure-badge">Figure ${index + 1}${pageText ? ` / ${escapePaperHtml(pageText)}` : ''}</div>`,
            caption,
            '</div>',
            '</div>',
          ].join('');
        }).join('');

        const thumbs = figures.map((figure, index) => {
          const thumbPageText = figure.page ? ` / PDF p. ${figure.page}` : '';
          return [
            `<button class="paper-figure-thumb${index === 0 ? ' is-active' : ''}" type="button" data-figure-thumb="${index}" aria-label="Show Figure ${index + 1}">`,
            `<img class="paper-figure-thumb-image" src="${escapePaperHtml(resolveDocsAssetUrl(figure.url))}" alt="Thumbnail ${index + 1}" loading="lazy">`,
            `<span class="paper-figure-thumb-label">Figure ${index + 1}${thumbPageText ? escapePaperHtml(thumbPageText) : ''}</span>`,
            '</button>',
          ].join('');
        }).join('');

        return [
          '<div class="paper-figure-section" data-paper-figure-carousel>',
          '<div class="paper-figure-toolbar">',
          '<div class="paper-section-kicker">Figure Gallery</div>',
          `<div class="paper-figure-counter"><span data-figure-current>1</span> / ${figures.length}</div>`,
          '</div>',
          '<div class="paper-figure-stage">',
          figures.length > 1 ? '<button class="paper-figure-nav paper-figure-nav-prev" type="button" data-figure-prev aria-label="Previous">&lsaquo;</button>' : '',
          `<div class="paper-figure-viewport">${slides}</div>`,
          figures.length > 1 ? '<button class="paper-figure-nav paper-figure-nav-next" type="button" data-figure-next aria-label="Next">&rsaquo;</button>' : '',
          '</div>',
          figures.length > 1 ? `<div class="paper-figure-thumbs">${thumbs}</div>` : '',
          '</div>',
          '',
        ].join('');
      };

      const ensureFigureLightbox = () => {
        let overlay = document.getElementById('dpr-figure-lightbox');
        if (overlay) return overlay;
        overlay = document.createElement('div');
        overlay.id = 'dpr-figure-lightbox';
        overlay.setAttribute('aria-hidden', 'true');
        overlay.innerHTML = [
          '<div class="dpr-figure-lightbox-backdrop" data-figure-lightbox-backdrop></div>',
          '<div class="dpr-figure-lightbox-panel" role="dialog" aria-modal="true" aria-label="Figure preview">',
          '<button class="dpr-figure-lightbox-close" type="button" data-figure-lightbox-close aria-label="Close">&times;</button>',
          '<button class="dpr-figure-lightbox-nav is-prev" type="button" data-figure-lightbox-prev aria-label="Previous">&lsaquo;</button>',
          '<figure class="dpr-figure-lightbox-figure">',
          '<img class="dpr-figure-lightbox-image" alt="Expanded paper figure">',
          '<figcaption class="dpr-figure-lightbox-caption"><span data-figure-lightbox-count></span><div data-figure-lightbox-caption></div></figcaption>',
          '</figure>',
          '<button class="dpr-figure-lightbox-nav is-next" type="button" data-figure-lightbox-next aria-label="Next">&rsaquo;</button>',
          '</div>',
        ].join('');
        document.body.appendChild(overlay);
        return overlay;
      };

      const closeFigureLightbox = () => {
        const overlay = document.getElementById('dpr-figure-lightbox');
        if (!overlay) return;
        if (typeof overlay._dprCleanup === 'function') {
          overlay._dprCleanup();
          overlay._dprCleanup = null;
        }
        overlay.classList.remove('is-open');
        overlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('dpr-figure-lightbox-open');
      };

      const openFigureLightbox = (items, startIndex = 0) => {
        if (!items || !items.length) return;
        const overlay = ensureFigureLightbox();
        if (typeof overlay._dprCleanup === 'function') {
          overlay._dprCleanup();
          overlay._dprCleanup = null;
        }
        const img = overlay.querySelector('.dpr-figure-lightbox-image');
        const caption = overlay.querySelector('[data-figure-lightbox-caption]');
        const count = overlay.querySelector('[data-figure-lightbox-count]');
        const prev = overlay.querySelector('[data-figure-lightbox-prev]');
        const next = overlay.querySelector('[data-figure-lightbox-next]');
        const close = overlay.querySelector('[data-figure-lightbox-close]');
        const backdrop = overlay.querySelector('[data-figure-lightbox-backdrop]');
        let current = Math.max(0, Math.min(Number(startIndex) || 0, items.length - 1));

        const render = () => {
          const item = items[current] || items[0];
          if (img) img.src = item.src || '';
          if (caption) caption.textContent = item.caption || '';
          if (count) count.textContent = `${current + 1} / ${items.length}${item.label ? ` / ${item.label}` : ''}`;
          if (prev) prev.hidden = items.length <= 1;
          if (next) next.hidden = items.length <= 1;
        };
        const go = (delta) => {
          current = (current + delta + items.length) % items.length;
          render();
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') closeFigureLightbox();
          if (event.key === 'ArrowLeft') go(-1);
          if (event.key === 'ArrowRight') go(1);
        };

        if (prev) prev.onclick = () => go(-1);
        if (next) next.onclick = () => go(1);
        if (close) close.onclick = closeFigureLightbox;
        if (backdrop) backdrop.onclick = closeFigureLightbox;
        document.addEventListener('keydown', onKeyDown);
        overlay._dprCleanup = () => document.removeEventListener('keydown', onKeyDown);
        render();
        overlay.classList.add('is-open');
        overlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('dpr-figure-lightbox-open');
      };

      const bindPaperFigureCarousels = () => {
        document.querySelectorAll('[data-paper-figure-carousel]').forEach((root) => {
          if (root.dataset.bound === '1') return;
          root.dataset.bound = '1';

          const slides = Array.from(root.querySelectorAll('[data-figure-slide]'));
          const thumbs = Array.from(root.querySelectorAll('[data-figure-thumb]'));
          const prevBtn = root.querySelector('[data-figure-prev]');
          const nextBtn = root.querySelector('[data-figure-next]');
          const counter = root.querySelector('[data-figure-current]');
          if (!slides.length) return;

          let current = 0;
          const render = () => {
            slides.forEach((slide, index) => {
              slide.classList.toggle('is-active', index === current);
            });
            thumbs.forEach((thumb, index) => {
              thumb.classList.toggle('is-active', index === current);
            });
            if (counter) {
              counter.textContent = String(current + 1);
            }
            if (prevBtn) prevBtn.disabled = slides.length <= 1;
            if (nextBtn) nextBtn.disabled = slides.length <= 1;
          };

          if (prevBtn) {
            prevBtn.addEventListener('click', () => {
              current = (current - 1 + slides.length) % slides.length;
              render();
            });
          }
          if (nextBtn) {
            nextBtn.addEventListener('click', () => {
              current = (current + 1) % slides.length;
              render();
            });
          }
          thumbs.forEach((thumb, index) => {
            thumb.addEventListener('click', () => {
              current = index;
              render();
            });
          });

          const lightboxItems = slides.map((slide, index) => {
            const image = slide.querySelector('.paper-figure-image');
            const caption = slide.querySelector('[data-figure-caption]');
            const badge = slide.querySelector('.paper-figure-badge');
            return {
              src: image ? image.currentSrc || image.src || '' : '',
              caption: caption ? (caption.textContent || '').trim() : '',
              label: badge ? (badge.textContent || '').trim() : `Figure ${index + 1}`,
            };
          });
          root.querySelectorAll('[data-figure-lightbox]').forEach((btn) => {
            btn.addEventListener('click', () => {
              const index = Number(btn.getAttribute('data-figure-lightbox') || 0);
              openFigureLightbox(lightboxItems, index);
            });
          });
          root.querySelectorAll('[data-figure-caption-toggle]').forEach((btn) => {
            btn.addEventListener('click', () => {
              const caption = btn.parentElement ? btn.parentElement.querySelector('[data-figure-caption]') : null;
              if (!caption) return;
              const collapsed = caption.classList.toggle('is-collapsed');
              btn.textContent = collapsed ? 'Expand caption' : 'Collapse caption';
            });
          });

          render();
        });
      };

      const RESEARCH_VALUE_TITLE = '研究价值与阅读建议';
      const RESEARCH_VALUE_LEGACY_TITLE = '对读者研究方向的启发与意义';

      const normalizeResearchValueHeading = (value) =>
        String(value || '')
          .replace(/\s+/g, ' ')
          .replace(/^#+\s*/, '')
          .replace(/^[\s*_\-`]+|[\s*_\-`]+$/g, '')
          .replace(/^\d{1,2}\s*[.、]\s*/, '')
          .replace(/[：:]\s*$/, '')
          .trim();

      const isResearchValueHeadingText = (value) => {
        const title = normalizeResearchValueHeading(value);
        return title === RESEARCH_VALUE_TITLE || title === RESEARCH_VALUE_LEGACY_TITLE;
      };

      const isResearchValuePlainHeadingLine = (line) => {
        const text = String(line || '').trim();
        if (!text) return false;
        const markdownMatch = text.match(/^(#{1,6})\s+(.+)$/);
        if (markdownMatch) return isResearchValueHeadingText(markdownMatch[2]);
        return isResearchValueHeadingText(text);
      };

      const extractResearchValueSectionFromMarkdown = (markdown) => {
        const source = String(markdown || '').replace(/\r\n/g, '\n');
        const lines = source.split('\n');
        let start = -1;
        let level = 2;

        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          const heading = line.match(/^(#{1,6})\s+(.+)$/);
          if (heading && isResearchValueHeadingText(heading[2])) {
            start = i;
            level = heading[1].length;
            break;
          }
          if (!heading && isResearchValuePlainHeadingLine(line)) {
            start = i;
            level = 2;
            break;
          }
        }

        if (start < 0) {
          return { body: source, section: '' };
        }

        let end = lines.length;
        for (let i = start + 1; i < lines.length; i += 1) {
          const trimmed = lines[i].trim();
          if (/^（完）$/.test(trimmed)) {
            end = i;
            break;
          }
          const heading = lines[i].match(/^(#{1,6})\s+/);
          if (heading && heading[1].length <= level) {
            end = i;
            break;
          }
        }

        const sectionBody = lines.slice(start + 1, end).join('\n').trim();
        const before = lines.slice(0, start).join('\n').trimEnd();
        const after = lines.slice(end).join('\n').trimStart();
        const body = [before, after].filter(Boolean).join('\n\n');
        const section = sectionBody
          ? `## ${RESEARCH_VALUE_TITLE}\n\n${sectionBody}`
          : `## ${RESEARCH_VALUE_TITLE}`;

        return { body, section };
      };

      const renderPaperFromMeta = (meta, options = {}) => {
        if (!meta) return '';

        const renderTags = (tags) => {
          if (!tags || !tags.length) return '';
          return tags.map((tag) => {
            const [kind, label] = tag.includes(':') ? tag.split(':', 2) : ['other', tag];
            const css = { keyword: 'tag-green', query: 'tag-blue', paper: 'tag-pink' }[kind] || 'tag-pink';
            return `<span class="tag-label ${css}">${escapeHtml(label)}</span>`;
          }).join(' ');
        };

        const scoreValue = meta.score !== undefined && meta.score !== null
          ? String(meta.score).trim()
          : '';
        const scoreLabel = String(meta.score_label || '').trim();
        const scoreDisplay = scoreValue
          ? (scoreLabel && !scoreValue.includes(scoreLabel) ? `${scoreValue} ${scoreLabel}` : scoreValue)
          : '';
        const sourceDisplay = String(meta.source || meta.selection_source || '').trim();
        const tagHtml = renderTags(meta.tags || []);
        const lines = [];

        lines.push('<section class="paper-hero-card">');
        lines.push('<div class="paper-hero-kicker">Paper Brief</div>');
        lines.push('<div class="paper-title-row">');
        if (meta.title) {
          lines.push(`<h1 class="paper-title-en">${escapeHtml(meta.title)}</h1>`);
        }
        if (meta.title_zh) {
          lines.push(`<h1 class="paper-title-zh">${escapeHtml(meta.title_zh)}</h1>`);
        }
        lines.push('</div>');
        if (meta.tldr) {
          lines.push('<div class="paper-hero-tldr">');
          lines.push('<span>TLDR</span>');
          lines.push(`<p>${escapeHtml(meta.tldr)}</p>`);
          lines.push('</div>');
        }
        lines.push('<div class="paper-hero-meta">');
        if (scoreDisplay) {
          lines.push(`<span class="paper-meta-pill is-score"><strong>Score</strong>${escapeHtml(scoreDisplay)}</span>`);
        }
        if (sourceDisplay) {
          lines.push(`<span class="paper-meta-pill"><strong>Source</strong>${escapeHtml(sourceDisplay)}</span>`);
        }
        lines.push(`<span class="paper-meta-pill"><strong>Date</strong>${escapeHtml(meta.date || 'Unknown')}</span>`);
        if (meta.pdf) {
          lines.push(`<a class="paper-hero-link-btn" href="${escapeHtml(meta.pdf)}" target="_blank" rel="noopener">Open PDF</a>`);
        }
        lines.push('</div>');
        if (tagHtml) {
          lines.push(`<div class="paper-hero-tags">${tagHtml}</div>`);
        }
        if (meta.authors) {
          lines.push(`<div class="paper-author-line"><span>Authors</span>${escapeHtml(meta.authors || 'Unknown')}</div>`);
        }
        if (meta.evidence) {
          lines.push('<div class="paper-hero-evidence">');
          lines.push('<span>Evidence</span>');
          lines.push(`<p>${escapeHtml(meta.evidence)}</p>`);
          lines.push('</div>');
        }
        lines.push('</section>');
        lines.push('');

        if (options.researchValueMarkdown) {
          lines.push(options.researchValueMarkdown);
          lines.push('');
        }

        const flowItems = [
          { key: 'motivation', label: 'Motivation', index: '01' },
          { key: 'method', label: 'Method', index: '02' },
          { key: 'result', label: 'Result', index: '03' },
          { key: 'conclusion', label: 'Takeaway', index: '04' },
        ].filter((item) => String(meta[item.key] || '').trim());

        if (flowItems.length) {
          lines.push('<section class="paper-glance-section paper-flow-section">');
          lines.push('<div class="paper-section-kicker">Research Flow</div>');
          lines.push('<div class="paper-glance-row">');
          flowItems.forEach((item) => {
            lines.push('<article class="paper-glance-col">');
            lines.push(`<div class="paper-flow-index">${item.index}</div>`);
            lines.push(`<div class="paper-glance-label">${item.label}</div>`);
            lines.push(`<div class="paper-glance-content">${escapeHtml(meta[item.key] || '-')}</div>`);
            lines.push('</article>');
          });
          lines.push('</div>');
          lines.push('</section>');
          lines.push('');
        }

        const figures = parseFiguresMeta(meta);
        if (figures.length) {
          lines.push(renderFigureCarousel(figures));
        }

        lines.push('<hr>');
        lines.push('');
        lines.push('');

        return lines.join('\n');
      };

      window.DPRResearchValueCard = {
        extractResearchValueSectionFromMarkdown,
        isResearchValueHeadingText,
        isResearchValueBoundaryNode,
        moveResearchFlowIntoValueCard,
      };

      const DAILY_TEXT = {
        kicker: 'Daily Research Brief',
        reportPrefix: '\u65e5\u62a5',
        generatedAt: '\u751f\u6210\u65f6\u95f4',
        runStatus: '\u8fd0\u884c\u72b6\u6001',
        total: '\u603b\u6570',
        deepQuick: '\u7cbe\u8bfb / \u901f\u8bfb',
        success: '\u6210\u529f',
        oldTotal: '\u5f53\u6b21\u63a8\u8350\u603b\u6570',
        deep: '\u7cbe\u8bfb\u533a',
        quick: '\u901f\u8bfb\u533a',
        brief: '\u4eca\u65e5\u7b80\u62a5\uff08AI\uff09',
        route: '\u4eca\u65e5\u9605\u8bfb\u8def\u7ebf',
        topics: '\u4eca\u65e5\u4e3b\u9898',
        evidence: '\u63a8\u8350\u4f9d\u636e',
        noRoute: '\u6682\u65e0\u53ef\u63a8\u8350\u9605\u8bfb\u8def\u7ebf\u3002',
        noTopic: '\u6682\u65e0\u4e3b\u9898\u6807\u7b7e\u3002',
        deepEmpty: '\u672c\u6b21\u65e0\u7cbe\u8bfb\u63a8\u8350\u3002',
        quickEmpty: '\u672c\u6b21\u65e0\u901f\u8bfb\u63a8\u8350\u3002',
        keyboard: '\u4f7f\u7528\u952e\u76d8\u65b9\u5411\u952e\u53ef\u5728\u65e5\u62a5/\u8bba\u6587\u4e4b\u95f4\u5feb\u901f\u5207\u6362\u3002',
      };

      const normalizeDailyText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

      const shortDailyText = (value, limit = 150) => {
        const dailyText = normalizeDailyText(value);
        if (dailyText.length <= limit) return dailyText;
        return `${dailyText.slice(0, Math.max(0, limit - 1)).trim()}\u2026`;
      };

      const shortDailyGeneratedAt = (value) => {
        const dailyText = normalizeDailyText(value);
        const match = dailyText.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::\d{2})?\s*(.*)$/);
        if (!match) return dailyText;
        const suffix = match[6] ? ` ${match[6]}` : '';
        return `${match[1].slice(2)}-${match[2]}-${match[3]} ${match[4]}:${match[5]}${suffix}`.trim();
      };

      const routeIdFromHref = (href) => {
        let raw = String(href || '').trim();
        if (!raw) return '';
        try {
          const url = new URL(raw, window.location.href);
          raw = url.hash ? url.hash : url.pathname;
        } catch {
          // Keep raw href.
        }
        raw = raw.replace(/^#\/?/, '').replace(/^\/+/, '').replace(/\/$/, '');
        raw = raw.replace(/\.md$/i, '');
        return raw;
      };

      const hashHrefFromRouteId = (routeId) => {
        const id = String(routeId || '').replace(/^#\/?/, '').replace(/^\/+/, '').replace(/\/$/, '');
        return id ? `#/${escapeHtml(id)}` : '#/';
      };

      const cssKindFromTag = (kind) => (
        String(kind || 'other').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'other'
      );

      const getSidebarPayloadByRoute = () => {
        const result = {};
        const nav = document.querySelector('.sidebar-nav');
        if (!nav) return result;
        nav.querySelectorAll('a.dpr-sidebar-item-link[href*="#/"]').forEach((a) => {
          const routeId = routeIdFromHref(a.getAttribute('href') || '');
          if (!routeId) return;
          const raw = a.getAttribute('data-sidebar-item') || '';
          if (!raw) return;
          try {
            const payload = JSON.parse(raw);
            if (payload && typeof payload === 'object') result[routeId] = payload;
          } catch {
            // Ignore malformed legacy payload.
          }
        });
        return result;
      };

      const parseLegacyDailyMeta = (h1) => {
        const meta = { generatedAt: '', total: '', deepCount: '', quickCount: '', status: DAILY_TEXT.success };
        const list = h1 && h1.nextElementSibling && h1.nextElementSibling.tagName === 'UL'
          ? h1.nextElementSibling
          : null;
        if (!list) return meta;
        Array.from(list.querySelectorAll(':scope > li')).forEach((li) => {
          const lineText = normalizeDailyText(li.textContent || '');
          const valueAfter = (label) => lineText.slice(label.length).replace(/^[\uFF1A:\s-]+/, '').trim();
          if (lineText.startsWith(DAILY_TEXT.generatedAt)) meta.generatedAt = valueAfter(DAILY_TEXT.generatedAt);
          if (lineText.startsWith(DAILY_TEXT.oldTotal)) meta.total = valueAfter(DAILY_TEXT.oldTotal);
          if (lineText.startsWith(DAILY_TEXT.total)) meta.total = valueAfter(DAILY_TEXT.total);
          if (lineText.startsWith(DAILY_TEXT.deep)) meta.deepCount = valueAfter(DAILY_TEXT.deep);
          if (lineText.startsWith(DAILY_TEXT.quick)) meta.quickCount = valueAfter(DAILY_TEXT.quick);
        });
        return meta;
      };

      const findLegacyDailyHeading = (root, label) => (
        Array.from(root.querySelectorAll('h2')).find((h) => normalizeDailyText(h.textContent || '') === label) || null
      );

      const collectLegacyDailySummary = (heading) => {
        if (!heading) return [];
        const lines = [];
        let node = heading.nextElementSibling;
        while (node && !/^H[12]$/i.test(node.tagName || '') && node.tagName !== 'HR') {
          if (node.tagName === 'P') {
            const lineText = normalizeDailyText(node.textContent || '');
            if (lineText) lines.push(lineText);
          }
          node = node.nextElementSibling;
        }
        return lines;
      };

      const parseLegacyDailyEntries = (heading, payloadByRoute) => {
        if (!heading) return [];
        let list = heading.nextElementSibling;
        while (list && !/^(OL|UL)$/i.test(list.tagName || '') && !/^H[12]$/i.test(list.tagName || '')) {
          list = list.nextElementSibling;
        }
        if (!list || !/^(OL|UL)$/i.test(list.tagName || '')) return [];
        return Array.from(list.querySelectorAll(':scope > li')).map((li) => {
          const a = li.querySelector('a');
          const routeId = routeIdFromHref(a ? a.getAttribute('href') || '' : '');
          const payload = payloadByRoute[routeId] || {};
          const rawText = normalizeDailyText(li.textContent || '');
          const scoreMatch = rawText.match(/([0-9]+(?:\.[0-9]+)?)\s*\/\s*10/);
          const payloadScore = payload && payload.score !== undefined && payload.score !== null
            ? String(payload.score).trim()
            : '';
          const score = scoreMatch ? scoreMatch[1] : payloadScore.replace(/\s.*$/, '');
          const tags = Array.isArray(payload.tags) ? payload.tags : [];
          return {
            routeId,
            href: a ? a.getAttribute('href') || hashHrefFromRouteId(routeId) : hashHrefFromRouteId(routeId),
            title: normalizeDailyText((a && a.textContent) || (payload && payload.title) || routeId),
            titleZh: normalizeDailyText((payload && (payload.title_zh || payload.titleZh)) || ''),
            score,
            tags,
            evidence: normalizeDailyText((payload && payload.evidence) || ''),
          };
        }).filter((item) => item.title);
      };

      const dailyScoreNumber = (item) => {
        const n = parseFloat(String((item && item.score) || '').replace(/[^\d.+-].*$/, ''));
        return Number.isFinite(n) ? n : -1;
      };

      const dailyScoreText = (item) => {
        const n = dailyScoreNumber(item);
        if (!Number.isFinite(n) || n < 0) return '';
        return `${n.toFixed(1)}/10`;
      };

      const dailyTopicItems = (entries) => {
        const counts = {};
        entries.forEach((entry) => {
          (entry.tags || []).forEach((tag) => {
            const rawKind = String((tag && tag.kind) || 'other').trim();
            if (rawKind === 'score') return;
            const kind = rawKind === 'keyword' ? 'query' : rawKind;
            const label = String((tag && tag.label) || '').trim();
            if (!label) return;
            const key = label.toLowerCase();
            if (!counts[key]) counts[key] = { label, kind, count: 0 };
            counts[key].count += 1;
          });
        });
        return Object.values(counts).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 8);
      };

      const dailyRouteItems = (deepEntries, quickEntries, topics) => {
        const items = [];
        if (deepEntries.length) {
          const best = deepEntries.slice().sort((a, b) => dailyScoreNumber(b) - dailyScoreNumber(a))[0];
          const score = dailyScoreText(best);
          items.push(`\u5148\u770b\u7cbe\u8bfb\u533a\u300a${shortDailyText(best.title, 54)}\u300b${score ? `\uff08${score}\uff09` : ''}\uff0c\u5feb\u901f\u5efa\u7acb\u4eca\u5929\u7684\u6838\u5fc3\u95ee\u9898\u610f\u8bc6\u3002`);
        } else if (quickEntries.length) {
          items.push(`\u4eca\u5929\u6ca1\u6709\u7cbe\u8bfb\u63a8\u8350\uff0c\u53ef\u5148\u4ece\u901f\u8bfb\u533a\u300a${shortDailyText(quickEntries[0].title, 54)}\u300b\u5f00\u59cb\u626b\u8bfb\u3002`);
        }
        if (topics.length) {
          items.push(`\u6cbf\u7740 ${topics.slice(0, 3).map((item) => item.label).join(' / ')} \u8fd9\u51e0\u4e2a\u4e3b\u9898\u4e32\u8054\u9605\u8bfb\uff0c\u4f18\u5148\u770b\u540c\u4e3b\u9898\u4e0b\u5206\u6570\u66f4\u9ad8\u7684\u8bba\u6587\u3002`);
        }
        if (quickEntries.length) {
          items.push('\u6700\u540e\u7528\u901f\u8bfb\u533a\u8865\u9f50\u76f8\u90bb\u65b9\u5411\uff0c\u53ea\u4fdd\u7559\u503c\u5f97\u540e\u7eed\u6df1\u6316\u7684\u8bba\u6587\u3002');
        }
        return items;
      };

      const dailyTopicChipsHtml = (tags, limit = 5) => (tags || [])
        .filter((tag) => tag && String(tag.kind || '').trim() !== 'score' && String(tag.label || '').trim())
        .slice(0, limit)
        .map((tag) => {
          const kind = cssKindFromTag(tag.kind === 'keyword' ? 'query' : tag.kind);
          return `<span class="dpr-daily-topic-chip dpr-daily-topic-${kind}">${escapeHtml(tag.label)}</span>`;
        })
        .join('');

      const dailyPaperCardsHtml = (entries, section) => {
        if (!entries.length) {
          return `<div class="dpr-daily-empty-note">${escapeHtml(section === 'deep' ? DAILY_TEXT.deepEmpty : DAILY_TEXT.quickEmpty)}</div>`;
        }
        return entries.map((entry, index) => {
          const score = dailyScoreText(entry);
          const scoreHtml = score ? `<span class="dpr-daily-score-pill">${escapeHtml(score)}</span>` : '';
          const chips = dailyTopicChipsHtml(entry.tags, section === 'deep' ? 5 : 3);
          const evidence = shortDailyText(entry.evidence, 170);
          const titleZh = normalizeDailyText(entry.titleZh || entry.title_zh || '');
          const titleZhHtml = titleZh
            ? `<div class="dpr-daily-paper-title-zh">${escapeHtml(titleZh)}</div>`
            : '';
          const evidenceHtml = evidence
            ? `<div class="dpr-daily-paper-evidence"><span>${escapeHtml(DAILY_TEXT.evidence)}</span>${escapeHtml(evidence)}</div>`
            : '';
          return [
            `<article class="dpr-daily-paper-card is-${section}">`,
            `  <div class="dpr-daily-paper-index">${String(index + 1).padStart(2, '0')}</div>`,
            '  <div class="dpr-daily-paper-main">',
            `    <a class="dpr-daily-paper-title" href="${hashHrefFromRouteId(entry.routeId) || escapeHtml(entry.href)}">${escapeHtml(entry.title)}</a>`,
            titleZhHtml,
            `    <div class="dpr-daily-paper-meta">${scoreHtml}${chips}</div>`,
            `    ${evidenceHtml}`,
            '  </div>',
            '</article>',
          ].join('\n');
        }).join('\n');
      };

      const renderLegacyDailyReportHtml = ({ title, meta, summaryLines, deepEntries, quickEntries }) => {
        const total = deepEntries.length + quickEntries.length;
        const topics = dailyTopicItems(deepEntries.concat(quickEntries));
        const topicCloud = topics.map((item) => {
          const kind = cssKindFromTag(item.kind);
          return `<span class="dpr-daily-topic-pill dpr-daily-topic-${kind}">${escapeHtml(item.label)}<em>${item.count}</em></span>`;
        }).join('\n');
        const summaryHtml = summaryLines.slice(0, 3).map((line) => `<p>${escapeHtml(line)}</p>`).join('\n');
        const deepCount = meta.deepCount || String(deepEntries.length);
        const quickCount = meta.quickCount || String(quickEntries.length);
        return [
          '<section class="dpr-daily-report">',
          '  <div class="dpr-daily-hero">',
          `    <div class="dpr-daily-kicker">${escapeHtml(DAILY_TEXT.kicker)}</div>`,
          `    <h1>${escapeHtml(title)}</h1>`,
          `    <div class="dpr-daily-stats" aria-label="${escapeHtml(DAILY_TEXT.reportPrefix)}">`,
          `      <div class="dpr-daily-stat"><span>${escapeHtml(DAILY_TEXT.generatedAt)}</span><strong>${escapeHtml(shortDailyGeneratedAt(meta.generatedAt) || '-')}</strong></div>`,
          `      <div class="dpr-daily-stat"><span>${escapeHtml(DAILY_TEXT.runStatus)}</span><strong>${escapeHtml(meta.status || DAILY_TEXT.success)}</strong></div>`,
          `      <div class="dpr-daily-stat"><span>${escapeHtml(DAILY_TEXT.total)}</span><strong>${escapeHtml(meta.total || String(total))}</strong></div>`,
          `      <div class="dpr-daily-stat"><span>${escapeHtml(DAILY_TEXT.deepQuick)}</span><strong>${escapeHtml(`${deepCount} / ${quickCount}`)}</strong></div>`,
          `      <div class="dpr-daily-stat dpr-daily-topic-stat"><span>${escapeHtml(DAILY_TEXT.topics)}</span>${topicCloud ? `<div class="dpr-daily-topic-cloud">${topicCloud}</div>` : `<strong>${escapeHtml(DAILY_TEXT.noTopic)}</strong>`}</div>`,
          '    </div>',
          summaryHtml ? '    <div class="dpr-daily-brief-card">' : '',
          summaryHtml ? `      <span>${escapeHtml(DAILY_TEXT.brief)}</span>` : '',
          summaryHtml ? `      ${summaryHtml}` : '',
          summaryHtml ? '    </div>' : '',
          '  </div>',
          '  <section class="dpr-daily-paper-section is-deep">',
          `    <h2>${escapeHtml(DAILY_TEXT.deep)}</h2>`,
          `    <div class="dpr-daily-paper-grid">${dailyPaperCardsHtml(deepEntries, 'deep')}</div>`,
          '  </section>',
          '  <section class="dpr-daily-paper-section is-quick">',
          `    <h2>${escapeHtml(DAILY_TEXT.quick)}</h2>`,
          `    <div class="dpr-daily-paper-grid">${dailyPaperCardsHtml(quickEntries, 'quick')}</div>`,
          '  </section>',
          '</section>',
          '<hr>',
          `<div class="dpr-daily-keyboard-tip"><span>\u5feb\u6377\u5207\u6362</span><strong>${escapeHtml(DAILY_TEXT.keyboard)}</strong></div>`,
        ].filter(Boolean).join('\n');
      };

      const applyLegacyDailyReportCards = (root) => {
        if (!root || root.querySelector('.dpr-daily-report')) return;
        const h1 = root.querySelector(':scope > h1');
        const title = normalizeDailyText(h1 && h1.textContent ? h1.textContent : '');
        if (!title || !title.startsWith(DAILY_TEXT.reportPrefix)) return;
        const payloadByRoute = getSidebarPayloadByRoute();
        const deepHeading = findLegacyDailyHeading(root, DAILY_TEXT.deep);
        const quickHeading = findLegacyDailyHeading(root, DAILY_TEXT.quick);
        const summaryHeading = findLegacyDailyHeading(root, DAILY_TEXT.brief);
        const deepEntries = parseLegacyDailyEntries(deepHeading, payloadByRoute);
        const quickEntries = parseLegacyDailyEntries(quickHeading, payloadByRoute);
        if (!deepEntries.length && !quickEntries.length) return;
        const meta = parseLegacyDailyMeta(h1);
        const summaryLines = collectLegacyDailySummary(summaryHeading);
        root.innerHTML = renderLegacyDailyReportHtml({
          title,
          meta,
          summaryLines,
          deepEntries,
          quickEntries,
        });
      };

      // --- Docsify beforeEach 钩子：解析 front matter ---
      hook.beforeEach(function (content) {
        const file = vm && vm.route ? vm.route.file : '';
        const normalizedContent = normalizeMarkdownMathDelimiters(content || '');
        // 只对论文页面处理
        if (!isPaperRouteFile(file)) {
          latestPaperRawMarkdown = '';
          return protectMarkdownMathForDocsify(normalizedContent);
        }
        latestPaperRawMarkdown = normalizedContent || '';

        const { meta, body } = parseFrontMatter(normalizedContent);
        if (!meta) {
          return protectMarkdownMathForDocsify(normalizedContent);
        }

        // 生成论文页面 HTML + 正文
        const researchValue = extractResearchValueSectionFromMarkdown(body);
        const paperHtml = renderPaperFromMeta(meta, {
          researchValueMarkdown: researchValue.section,
        });
        return protectMarkdownMathForDocsify(paperHtml + researchValue.body);
      });

      // --- Docsify 生命周期钩子 ---
      hook.doneEach(function () {
        // 路由统一：将 #/?id=%2f... 自动规整为 #/...
        try {
          const canonical = decodeLegacyIdHash(window.location.hash || '');
          if (canonical && canonical !== window.location.hash) {
            window.location.replace(canonical);
            return;
          }
        } catch {
          // ignore
        }

        // 当前路由对应的“论文 ID”（简单用文件名去掉 .md）
        const paperId = getPaperId();
        const routePath = vm.route && vm.route.path ? vm.route.path : '';
        const lowerId = (paperId || '').toLowerCase();

        // 首页（如 README.md 或根路径）不展示研讨区，只做数学渲染和 Zotero 元数据更新
        const isHomePage =
          !paperId ||
          lowerId === 'readme' ||
          routePath === '/' ||
          routePath === '';
        const file = vm && vm.route ? vm.route.file : '';
        const isReportPage = isReportRouteFile(file);
        const isPeriodicReportPage = isPeriodicReportRouteFile(file);
        const isPaperPage = isPaperRouteFile(file);
        const isTutorialPage = /^tutorial(?:\/|$)/i.test(
          String(file || routePath || paperId || '').replace(/^\/+/, ''),
        );
        const normalizedLandingFile = String(file || routePath || paperId || '').replace(/^\/+/, '');
        const isLocalPdfToolPage = /^local-pdf(?:\.md)?$/i.test(normalizedLandingFile);
        const isLandingLikePage = isHomePage || isReportPage || isTutorialPage || isLocalPdfToolPage;
        syncPageTypeClasses({ isHomePage, isReportPage, isPaperPage, isPeriodicReportPage });

        // A. 对正文区域进行一次全局公式渲染（支持 $...$ / $$...$$）
        const mainContent = document.querySelector('.markdown-section');
        if (mainContent) {
          // 先创建正文包装层，避免后续切页动画影响聊天浮层
          const root = isPaperPage ? ensurePageContentRoot() : null;
          const mathRoot = root || mainContent;
          if (isReportPage && !isPeriodicReportPage) applyLegacyDailyReportCards(mathRoot);
          restoreMarkdownMathPlaceholdersInEl(mathRoot);
          renderMathInEl(mathRoot);
          if (isPaperPage) applyPaperAbstractFold(mathRoot);
          if (isPeriodicReportPage) bindPeriodicEvidenceToggles(mathRoot);
        }

        // 论文页标题条排版（只对 docs/YYYYMM/DD/*.md 生效）
        applyPaperTitleBar();
        if (isPaperPage && mainContent) {
          const paperRoot = mainContent.querySelector(`:scope > .${DPR_PAGE_CONTENT_CLASS}`) || mainContent;
          applyPaperResearchValueCard(paperRoot);
        }

        // 论文页左右切换：更新导航列表并绑定事件（只绑定一次）
        updateNavState();
        ensureNavHandlers();
        // 预取相邻论文的 Markdown（利用浏览器 cache，让切换更丝滑）
        prefetchAdjacent();

        // 页面入场动画：根据上一跳的方向做滑入
        const animEl = getPageAnimEl();
        if (animEl) {
          // 清理上一次退场残留（防止极端情况下没清掉）
          animEl.classList.remove(
            'dpr-page-exit',
            'dpr-page-exit-left',
            'dpr-page-exit-right',
              );
          const enter = DPR_TRANSITION.pendingEnter;
          DPR_TRANSITION.pendingEnter = '';
          if (enter && !prefersReducedMotion()) {
            animEl.classList.add('dpr-page-enter', enter);
            requestAnimationFrame(() => {
              // 触发 transition 到“静止态”
              animEl.classList.add('dpr-page-enter-active');
              setTimeout(() => {
                animEl.classList.remove(
                  'dpr-page-enter',
                  'dpr-page-enter-active',
                  'enter-from-left',
                  'enter-from-right',
                );
              }, DPR_TRANSITION_MS + 40);
            });
          }
        }

        if (!isLandingLikePage && window.PrivateDiscussionChat) {
          window.PrivateDiscussionChat.initForPage(paperId);
        } else if (
          window.PrivateDiscussionChat &&
          typeof window.PrivateDiscussionChat.destroyForPage === 'function'
        ) {
          window.PrivateDiscussionChat.destroyForPage();
        }

        bindPaperFigureCarousels();

        // ----------------------------------------------------
        // E. 小屏点击侧边栏条目后自动收起
        // ----------------------------------------------------
        setupMobileSidebarAutoCloseOnItemClick();

        // ----------------------------------------------------
        // F. 侧边栏按日期折叠
        // ----------------------------------------------------
        setupCollapsibleSidebarByDay();
        decorateSidebarStaticLinks();
        hydrateStructuredSidebarItems();
        bindSidebarVirtualHashLinks();
        neutralizeSidebarNoactiveLinks();

        // ----------------------------------------------------
        // G. 侧边栏已阅读论文状态高亮
        // ----------------------------------------------------
        if (!isLandingLikePage && paperId) {
          markSidebarReadState(paperId);
        } else {
          // 首页也需要应用已有的“已读高亮”，但不新增记录
          markSidebarReadState(null);
        }
        ensureSidebarEntryDeleteButtons();

        ensurePaperActionToolbar(paperId, isPaperPage);

        // 让滑动高亮层跟随当前 active 项（点击、路由变化后会更新 active 类）
        try {
          const movedByNavAnim = !!DPR_SIDEBAR_ACTIVE_INDICATOR.justMoved;
          if (!movedByNavAnim) {
            // 非“点击触发的预先滑动”场景：先立即贴齐一次
            syncSidebarActiveIndicator({ animate: false });
          }
          // 统一做一次延迟终态校准：
          // - 点击切页时避免“先对齐 -> 上跳 -> 再回位”的双重抖动
          // - 分组展开/收起有 max-height 过渡，布局稳定后再校准一次
          setTimeout(() => {
            try {
              requestAnimationFrame(() => {
                syncSidebarActiveIndicator({ animate: false });
              });
            } finally {
              DPR_SIDEBAR_ACTIVE_INDICATOR.justMoved = false;
            }
          }, movedByNavAnim ? 220 : 280);
        } catch {
          // ignore
          DPR_SIDEBAR_ACTIVE_INDICATOR.justMoved = false;
        }

        // 自动把当前论文在 sidebar 中滚动到居中位置，便于连续阅读
        if (DPR_NAV_STATE.lastNavSource !== 'click') {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              centerSidebarOnCurrent();
            });
          });
        }

        // 本次 doneEach 的来源只用于控制“是否居中”，用完即清理
        DPR_NAV_STATE.lastNavSource = '';

        // ----------------------------------------------------
        // H. Zotero 元数据注入逻辑 (带延时和唤醒)
        // ----------------------------------------------------
        setTimeout(() => {
          updateZoteroMetaFromPage(
            paperId,
            vm.route.file,
            latestPaperRawMarkdown,
          );
        }, 1); // 延迟执行，等待 DOM 渲染完毕
      });
      // ----------------------------------------------------
      // I. 响应式侧边栏：窄屏首次加载时确保收起（仅移除 close 类）
      // ----------------------------------------------------
      const SIDEBAR_AUTO_COLLAPSE_WIDTH = 1024;

      const ensureCollapsedOnNarrowScreen = () => {
        const windowWidth =
          window.innerWidth || document.documentElement.clientWidth || 0;
        if (windowWidth >= SIDEBAR_AUTO_COLLAPSE_WIDTH) return;

        const body = document.body;
        if (!body.classList) return;
        // 进入窄屏时使用 "默认不带 close" 的收起态，兼容 Docsify 的移动端语义
        body.classList.remove('close');
      };

      // 初始化时执行一次
      ensureCollapsedOnNarrowScreen();
    },
  ],
};
