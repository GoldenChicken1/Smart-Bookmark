console.log('[智能书签] Service Worker 已启动 v1.1.0 (toast build)');

const DEFAULT_CONFIG = {
  apiKey: '',
  model: 'moonshot-v1-8k',
  baseUrl: 'https://api.moonshot.cn/v1',
  enabled: true,
  respectManual: true,
  allowCreateFolder: true,
  showToast: true,
  manualEditWindowMs: 1500,
  systemPrompt: `你是一个书签整理助手。根据用户给出的网页信息和现有书签文件夹结构，返回 JSON：
- name: 简洁的书签名称（去除站点后缀、冗余信息，保留核心主题，15字以内，中文优先）
- folderPath: 最合适的文件夹路径（使用 / 分隔，如 "书签栏/购物"），必须非空

规则：
1. 优先复用已有文件夹（精确匹配已有路径）。
2. 若现有文件夹都不合适，必须新建一个具体分类，常见如：购物、开发、AI工具、阅读、影音、社交、效率工具、金融理财、学习、工作、设计、资讯。
3. 禁止只返回 "其他书签" 或 "书签栏" 这种泛用容器 — 必须至少有一层具体子分类。
4. 新建分类默认放在 "书签栏/" 下，常用二级分类直接放一级（如 "书签栏/购物"，不要 "书签栏/生活/购物"）。

仅返回 JSON，不要任何解释：{"name": "...", "folderPath": "..."}`
};

const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);
const CONFIG_VERSION = 1;

chrome.runtime.onInstalled.addListener(async (details) => {
  const existing = await chrome.storage.local.get([...CONFIG_KEYS, '_configVersion']);
  const toSet = {};
  for (const k of CONFIG_KEYS) {
    if (existing[k] === undefined) toSet[k] = DEFAULT_CONFIG[k];
  }
  if ((existing._configVersion || 0) < CONFIG_VERSION) {
    toSet._configVersion = CONFIG_VERSION;
  }
  if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);

  // 首次安装时自动打开设置页，引导用户填写 API Key
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

const pending = new Map();

chrome.bookmarks.onCreated.addListener(async (id, bookmark) => {
  if (!bookmark.url) return;
  const { enabled, manualEditWindowMs } = await chrome.storage.local.get(['enabled', 'manualEditWindowMs']);
  if (enabled === false) return;
  const entry = { edited: false };
  entry.timerId = setTimeout(() => processBookmark(id), manualEditWindowMs || 1500);
  pending.set(id, entry);
});

chrome.bookmarks.onChanged.addListener((id) => {
  const entry = pending.get(id);
  if (entry) entry.edited = true;
});

chrome.bookmarks.onMoved.addListener((id) => {
  const entry = pending.get(id);
  if (entry) entry.edited = true;
});

chrome.bookmarks.onRemoved.addListener((id) => {
  const entry = pending.get(id);
  if (entry) {
    clearTimeout(entry.timerId);
    pending.delete(id);
  }
});

async function processBookmark(id) {
  const entry = pending.get(id);
  pending.delete(id);

  const cfg = await chrome.storage.local.get(CONFIG_KEYS);
  if (entry?.edited && cfg.respectManual) {
    await appendHistory({ id, skipped: true, reason: 'manual', ts: Date.now() });
    return;
  }

  try {
    const nodes = await chrome.bookmarks.get(id).catch(() => []);
    const bm = nodes[0];
    if (!bm || !bm.url) return;

    const pageMeta = await extractPageMeta(bm.url);
    const tree = await chrome.bookmarks.getTree();
    const folderList = flattenFolders(tree);

    console.log('[智能书签] 页面信息:', pageMeta);
    console.log('[智能书签] 现有文件夹:', folderList.map(f => f.path));

    const result = await callKimi(cfg, bm, pageMeta, folderList);
    console.log('[智能书签] LLM 返回:', result);
    if (!result) return;
    const { name, folderPath } = result;

    let newTitle = bm.title;
    if (name && name !== bm.title) {
      await chrome.bookmarks.update(id, { title: name });
      newTitle = name;
      console.log(`[智能书签] 已重命名: ${bm.title} → ${name}`);
    }

    let movedTo = null;
    let moveNote = null;
    if (folderPath) {
      const targetFolderId = await ensureFolderPath(folderPath, cfg.allowCreateFolder);
      if (!targetFolderId) {
        moveNote = `未能定位/创建文件夹 "${folderPath}"`;
      } else if (targetFolderId === bm.parentId) {
        moveNote = `目标文件夹与当前一致 (${folderPath})`;
      } else {
        await chrome.bookmarks.move(id, { parentId: targetFolderId });
        movedTo = folderPath;
        console.log(`[智能书签] 已移动到: ${folderPath}`);
      }
    } else {
      moveNote = 'LLM 未返回 folderPath';
    }
    if (moveNote) console.log('[智能书签]', moveNote);

    const didRename = newTitle !== bm.title;
    const didMove = !!movedTo;
    console.log('[智能书签] Toast 条件:', { showToast: cfg.showToast, didRename, didMove });
    if (cfg.showToast && (didRename || didMove)) {
      showToast({
        name: newTitle,
        folderPath: movedTo || '(原位置)',
        didMove
      });
    }

    await appendHistory({
      id,
      originalTitle: bm.title,
      newTitle,
      folderPath: movedTo,
      moveNote,
      url: bm.url,
      ts: Date.now()
    });
  } catch (e) {
    console.error('[智能书签] 处理失败', e);
    await appendHistory({ id, error: String(e?.message || e), ts: Date.now() });
  }
}

async function extractPageMeta(url) {
  let tab = null;
  try {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTabs[0]?.url === url) tab = activeTabs[0];
  } catch {}
  if (!tab) {
    try {
      const all = await chrome.tabs.query({});
      tab = all.find(t => t.url === url) || null;
    } catch {}
  }
  if (!tab) return { url };
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const get = (sel, attr = 'content') => document.querySelector(sel)?.getAttribute(attr) || '';
        return {
          title: document.title || '',
          ogTitle: get('meta[property="og:title"]'),
          description: get('meta[name="description"]'),
          ogDescription: get('meta[property="og:description"]'),
          keywords: get('meta[name="keywords"]'),
          h1: document.querySelector('h1')?.innerText?.slice(0, 200) || '',
          bodySnippet: document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 500) || ''
        };
      }
    });
    return { url, ...(res?.result || {}) };
  } catch {
    return { url };
  }
}

function flattenFolders(tree) {
  const out = [];
  function walk(node, path) {
    if (node.url) return;
    const here = node.title ? (path ? `${path}/${node.title}` : node.title) : path;
    if (node.title) out.push({ id: node.id, path: here });
    for (const c of node.children || []) walk(c, here);
  }
  for (const n of tree) walk(n, '');
  return out;
}

async function callKimi(cfg, bm, pageMeta, folderList) {
  if (!cfg.apiKey) throw new Error('未配置 API Key：请点击扩展图标 → 设置');

  const foldersText = folderList.length
    ? folderList.map(f => '- ' + f.path).join('\n')
    : '(暂无文件夹)';

  const userMsg = `网页信息：
- URL: ${bm.url}
- 原始标题: ${pageMeta.title || bm.title || ''}
- og:title: ${pageMeta.ogTitle || ''}
- 描述: ${pageMeta.description || pageMeta.ogDescription || ''}
- 关键词: ${pageMeta.keywords || ''}
- H1: ${pageMeta.h1 || ''}
- 正文片段: ${pageMeta.bodySnippet || ''}

现有文件夹：
${foldersText}

请输出 JSON。`;

  const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: cfg.systemPrompt },
        { role: 'user', content: userMsg }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    })
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Kimi API ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Kimi 返回为空');

  try {
    return JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Kimi 返回非 JSON: ' + content);
  }
}

async function ensureFolderPath(path, allowCreate) {
  const parts = path.split('/').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;

  const tree = await chrome.bookmarks.getTree();
  const root = tree[0];
  const rootChildren = root.children || [];

  let currentId, currentChildren, startIdx;
  const firstMatch = rootChildren.find(c => !c.url && c.title === parts[0]);
  if (firstMatch) {
    currentId = firstMatch.id;
    currentChildren = firstMatch.children || [];
    startIdx = 1;
  } else {
    const other = rootChildren.find(c => c.id === '2') || rootChildren[1] || rootChildren[0];
    if (!other) return null;
    currentId = other.id;
    currentChildren = other.children || [];
    startIdx = 0;
  }

  for (let i = startIdx; i < parts.length; i++) {
    const name = parts[i];
    let next = currentChildren.find(c => !c.url && c.title === name);
    if (!next) {
      if (!allowCreate) return currentId;
      next = await chrome.bookmarks.create({ parentId: currentId, title: name });
    }
    currentId = next.id;
    const sub = await chrome.bookmarks.getSubTree(currentId);
    currentChildren = sub[0]?.children || [];
  }
  return currentId;
}

async function appendHistory(entry) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift(entry);
  if (history.length > 50) history.length = 50;
  await chrome.storage.local.set({ history });
}

async function showToast(payload) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    console.log('[智能书签] Toast 目标标签:', tab?.url);
    if (!tab?.id) { console.log('[智能书签] Toast 跳过: 无活动标签'); return; }
    const url = tab.url || '';
    if (/^(chrome|edge|about|chrome-extension|chrome-search|devtools):/i.test(url)) {
      console.log('[智能书签] Toast 跳过: 受限页面', url);
      return;
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: renderToastInPage,
      args: [payload]
    });
    console.log('[智能书签] Toast 注入成功');
  } catch (e) {
    console.warn('[智能书签] Toast 注入失败:', e.message);
  }
}

// 注入到页面的函数 — 必须自包含，不能引用外部变量
function renderToastInPage(data) {
  const existing = document.getElementById('__smart_bookmark_toast__');
  if (existing) existing.remove();

  const host = document.createElement('div');
  host.id = '__smart_bookmark_toast__';
  host.style.cssText = 'position:fixed;top:0;right:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    .wrap {
      position: fixed; top: 20px; right: 20px;
      pointer-events: auto;
      animation: bmSlide 0.55s cubic-bezier(0.34, 1.56, 0.64, 1);
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
    }
    @keyframes bmSlide {
      from { transform: translateX(130%) scale(0.8); opacity: 0; }
      to { transform: translateX(0) scale(1); opacity: 1; }
    }
    @keyframes bmSlideOut {
      from { transform: translateX(0) scale(1); opacity: 1; }
      to { transform: translateX(130%) scale(0.9); opacity: 0; }
    }
    .card {
      display: flex; align-items: center; gap: 14px;
      padding: 14px 20px 14px 14px;
      background: linear-gradient(135deg, rgba(255,255,255,0.98), rgba(255,248,243,0.98));
      backdrop-filter: blur(10px);
      border: 1px solid rgba(217, 119, 87, 0.15);
      border-radius: 16px;
      box-shadow:
        0 14px 40px rgba(217, 119, 87, 0.18),
        0 4px 12px rgba(0,0,0,0.06),
        inset 0 1px 0 rgba(255,255,255,0.9);
      min-width: 260px;
      max-width: 360px;
    }
    .pet-box {
      width: 58px; height: 52px;
      position: relative;
      flex-shrink: 0;
    }
    .pet-shadow {
      position: absolute; left: 50%; bottom: 1px;
      width: 42px; height: 4px;
      transform: translateX(-50%);
      background: radial-gradient(ellipse at center, rgba(90, 40, 22, 0.32), transparent 70%);
      animation: bmShadow 0.5s ease-in-out infinite;
      pointer-events: none;
    }
    @keyframes bmShadow {
      0%, 100% { transform: translateX(-50%) scaleX(1); opacity: 0.55; }
      50%     { transform: translateX(-50%) scaleX(0.72); opacity: 0.28; }
    }
    .pet {
      width: 58px; height: 44px;
      shape-rendering: crispEdges;
      display: block;
      animation: bmHop 0.6s cubic-bezier(0.25, 1.6, 0.4, 1) both;
    }
    @keyframes bmHop {
      0%   { transform: translate(24px, -4px) scale(0.6); opacity: 0; }
      60%  { transform: translate(0, -5px) scale(1.08); opacity: 1; }
      100% { transform: translate(0, 0) scale(1); opacity: 1; }
    }
    .leg-a { animation: bmLegA 0.5s ease-in-out infinite 0.6s; }
    .leg-b { animation: bmLegB 0.5s ease-in-out infinite 0.6s; }
    @keyframes bmLegA {
      0%, 100% { transform: translateY(0); }
      50%      { transform: translateY(-3px); }
    }
    @keyframes bmLegB {
      0%, 100% { transform: translateY(-3px); }
      50%      { transform: translateY(0); }
    }
    .arm {
      transform-box: fill-box;
      transform-origin: center;
      animation: bmArm 1s ease-in-out infinite 0.6s;
    }
    @keyframes bmArm {
      0%, 100% { transform: translateY(0) rotate(0deg); }
      50%      { transform: translateY(-1px) rotate(-6deg); }
    }
    .eye {
      transform-box: fill-box;
      transform-origin: center;
      animation: bmBlink 3.5s ease-in-out infinite 1.5s;
    }
    @keyframes bmBlink {
      0%, 88%, 100% { transform: scaleY(1); }
      93%, 97%      { transform: scaleY(0.15); }
    }
    .sparkle {
      position: absolute;
      animation: bmSparkle 1.8s ease-in-out infinite;
      opacity: 0;
      pointer-events: none;
    }
    .sparkle.s1 { top: 2px; right: -2px; animation-delay: 0.8s; }
    .sparkle.s2 { top: 26px; left: -4px; animation-delay: 1.5s; }
    @keyframes bmSparkle {
      0%, 100% { opacity: 0; transform: scale(0.3) rotate(0deg); }
      40%      { opacity: 1; transform: scale(1) rotate(180deg); }
      70%      { opacity: 0; transform: scale(0.4) rotate(360deg); }
    }
    .text { flex: 1; min-width: 0; }
    .title {
      font-size: 11px; font-weight: 600;
      color: #D97757; letter-spacing: 0.8px;
      margin-bottom: 4px;
      text-transform: uppercase;
    }
    .name {
      font-size: 14px; font-weight: 600;
      color: #2B1810;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      margin-bottom: 3px;
      line-height: 1.3;
    }
    .folder {
      font-size: 12px; color: #8A4A2D;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      display: flex; align-items: center; gap: 4px;
    }
    .folder-icon { flex-shrink: 0; opacity: 0.7; }
    .leaving { animation: bmSlideOut 0.4s ease-in forwards; }
    .close {
      background: none; border: none; cursor: pointer;
      padding: 2px; margin: -6px -8px -6px 4px;
      color: #bbb; font-size: 16px; line-height: 1;
      border-radius: 4px; transition: all 0.15s;
    }
    .close:hover { color: #666; background: rgba(0,0,0,0.05); }
  `;

  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.innerHTML = `
    <div class="card">
      <div class="pet-box">
        <svg class="pet" viewBox="0 0 64 48" xmlns="http://www.w3.org/2000/svg">
          <g class="body">
            <rect class="arm" x="0" y="16" width="8" height="8" fill="#C76848"/>
            <rect class="arm" x="56" y="16" width="8" height="8" fill="#C76848"/>
            <rect x="12" y="0" width="40" height="4" fill="#C76848"/>
            <rect x="8" y="4" width="48" height="32" fill="#C76848"/>
            <rect x="48" y="4" width="4" height="32" fill="#A8513B" opacity="0.45"/>
            <rect x="8" y="32" width="48" height="4" fill="#A8513B" opacity="0.35"/>
            <rect class="eye" x="20" y="12" width="8" height="8" fill="#1a1110"/>
            <rect class="eye" x="36" y="12" width="8" height="8" fill="#1a1110"/>
            <rect x="22" y="14" width="2" height="2" fill="#fff"/>
            <rect x="38" y="14" width="2" height="2" fill="#fff"/>
          </g>
          <rect class="leg-a" x="8" y="36" width="8" height="8" fill="#C76848"/>
          <rect class="leg-b" x="20" y="36" width="8" height="8" fill="#C76848"/>
          <rect class="leg-b" x="36" y="36" width="8" height="8" fill="#C76848"/>
          <rect class="leg-a" x="48" y="36" width="8" height="8" fill="#C76848"/>
        </svg>
        <div class="pet-shadow"></div>
        <svg class="sparkle s1" width="10" height="10" viewBox="0 0 10 10">
          <path d="M 5 0 L 6 4 L 10 5 L 6 6 L 5 10 L 4 6 L 0 5 L 4 4 Z" fill="#FFD27D"/>
        </svg>
        <svg class="sparkle s2" width="8" height="8" viewBox="0 0 10 10">
          <path d="M 5 0 L 6 4 L 10 5 L 6 6 L 5 10 L 4 6 L 0 5 L 4 4 Z" fill="#FFA56A"/>
        </svg>
      </div>
      <div class="text">
        <div class="title">已智能整理</div>
        <div class="name"></div>
        <div class="folder">
          <svg class="folder-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.5L8 3.5h5A1.5 1.5 0 0 1 14.5 5v7A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V3.5z"/>
          </svg>
          <span class="folder-text"></span>
        </div>
      </div>
      <button class="close" aria-label="关闭">×</button>
    </div>
  `;

  wrap.querySelector('.name').textContent = data.name || '';
  wrap.querySelector('.folder-text').textContent = data.folderPath || '';

  const dismiss = () => {
    wrap.classList.add('leaving');
    setTimeout(() => host.remove(), 420);
  };
  wrap.querySelector('.close').addEventListener('click', dismiss);

  shadow.appendChild(style);
  shadow.appendChild(wrap);
  document.documentElement.appendChild(host);

  setTimeout(dismiss, 3800);
}
