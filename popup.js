function escapeHtml(s) {
  return String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function hostname(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

async function render() {
  const { enabled = true, history = [] } = await chrome.storage.local.get(['enabled', 'history']);
  document.getElementById('enabled').checked = enabled;
  const box = document.getElementById('history');
  if (!history.length) {
    box.innerHTML = '<div class="empty">暂无处理记录</div>';
    return;
  }
  box.innerHTML = history.slice(0, 20).map(h => {
    if (h.error) {
      return `<div class="item"><div class="title" style="color:#c33">处理失败</div><div class="meta">${escapeHtml(h.error)}</div></div>`;
    }
    if (h.skipped) {
      return `<div class="item"><div class="title" style="color:#888">已跳过（用户手动修改）</div></div>`;
    }
    const loc = h.folderPath || (h.moveNote ? `未移动: ${h.moveNote}` : '原位置');
    return `<div class="item">
      <div class="title">${escapeHtml(h.newTitle || '(无)')}</div>
      <div class="meta">${escapeHtml(loc)} · ${escapeHtml(hostname(h.url))}</div>
    </div>`;
  }).join('');
}

document.getElementById('enabled').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
});
document.getElementById('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('clearHistory').addEventListener('click', async () => {
  await chrome.storage.local.set({ history: [] });
  render();
});

render();
