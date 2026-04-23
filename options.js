const KEYS = ['apiKey', 'model', 'baseUrl', 'enabled', 'respectManual', 'allowCreateFolder', 'manualEditWindowMs', 'systemPrompt'];

async function load() {
  const cfg = await chrome.storage.local.get(KEYS);
  for (const k of KEYS) {
    const el = document.getElementById(k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!cfg[k];
    else el.value = cfg[k] ?? '';
  }
}

async function save() {
  const out = {};
  for (const k of KEYS) {
    const el = document.getElementById(k);
    if (!el) continue;
    if (el.type === 'checkbox') out[k] = el.checked;
    else if (k === 'manualEditWindowMs') out[k] = parseInt(el.value, 10) || 1500;
    else out[k] = el.value;
  }
  await chrome.storage.local.set(out);
  const s = document.getElementById('status');
  s.textContent = '已保存 ✓';
  setTimeout(() => (s.textContent = ''), 2000);
}

document.getElementById('save').addEventListener('click', save);
load();
