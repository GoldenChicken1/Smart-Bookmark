const DEFAULT_CONFIG = {
  apiKey: '',
  model: 'moonshot-v1-8k',
  baseUrl: 'https://api.moonshot.cn/v1',
  enabled: true,
  respectManual: true,
  allowCreateFolder: true,
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
