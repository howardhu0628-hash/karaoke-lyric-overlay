const DEFAULTS = { enabled: true, mode: 'auto', targetLang: 'zh-TW', layout: 'ktv', uiLang: 'auto' };

// ---------- 介面語言 ----------
// 簡體中文時把畫面上的字轉成簡體（lib/zhcn.js）；語言名稱（data-raw）不轉。程式後來改的字用 setText()，切換語言時才轉得回來
let uiCN = false;
const T = (s) => (uiCN && globalThis.YTLSZh ? YTLSZh.convert(s) : String(s));
const orig = new Map();
function wantCN(v) {
  if (v === 'zh-CN') return true;
  if (v === 'zh-TW') return false;
  const l = (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || navigator.language || '';
  return /^zh(-(cn|sg|hans).*)?$/i.test(l);
}
function setText(el, s) { el.dataset.src = s; el.textContent = T(s); }
function applyLang() {
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode());) {
    const p = n.parentElement;
    if (!p || p.closest('[data-raw], [data-src], script, style')) continue;
    if (!orig.has(n)) orig.set(n, n.nodeValue);
    n.nodeValue = T(orig.get(n));
  }
  for (const el of document.querySelectorAll('[data-src]')) el.textContent = T(el.dataset.src);
  for (const el of document.querySelectorAll('[placeholder]')) { if (!el.dataset.ph) el.dataset.ph = el.placeholder; el.placeholder = T(el.dataset.ph); }
  document.title = T('YT 歌詞字幕');
  document.documentElement.lang = uiCN ? 'zh-Hans' : 'zh-Hant';
}

(async () => {
  const saved = await chrome.storage.sync.get(null);
  const s = {};
  for (const k of Object.keys(DEFAULTS)) s[k] = k in saved ? saved[k] : DEFAULTS[k];
  // 升級前就在用的人（已經有設定）：照舊用繁體（跟 content.js 一樣）；全新安裝才跟著 Edge
  if (!('uiLang' in saved) && Object.keys(saved).length) { s.uiLang = 'zh-TW'; chrome.storage.sync.set({ uiLang: 'zh-TW' }); }
  uiCN = wantCN(s.uiLang);
  if (!('targetLang' in saved)) s.targetLang = uiCN ? 'zh-CN' : 'zh-TW'; // 沒自己選過翻譯語言：跟著介面（跟 content.js 一樣）
  applyLang();
  for (const [k, v] of Object.entries(s)) {
    const el = document.getElementById(k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    el.addEventListener('change', () => {
      chrome.storage.sync.set({ [k]: el.type === 'checkbox' ? el.checked : el.value });
      if (k === 'uiLang') { uiCN = wantCN(el.value); applyLang(); }
    });
  }
})();

// AI 聽寫：本機／雲端（Groq）。金鑰存在這台電腦（chrome.storage.local），不會同步到別台
(async () => {
  const eng = document.getElementById('listenEngine'), box = document.getElementById('cloudBox');
  const key = document.getElementById('groqKey'), btn = document.getElementById('testKey'), msg = document.getElementById('keyMsg');
  const c = await chrome.storage.local.get({ listenEngine: 'local', groqKey: '' });
  // 分級安裝：等級 1、2 沒有 AI 聽寫；等級 3 只有雲端（沒裝本機模型）
  let tier = 4;
  try { const r = await chrome.runtime.sendMessage({ type: 'installInfo' }); if (r && r.ok && r.data) tier = r.data.tier; } catch (e) { /* 當成全部都有 */ }
  if (tier < 3) {
    eng.closest('label').hidden = true;
    document.getElementById('noListen').hidden = false;
    return;
  }
  if (tier < 4) {
    const local = eng.querySelector('option[value="local"]');
    local.disabled = true; setText(local, '本機（這個安裝沒有）');
    setText(document.getElementById('fallbackNote'), '額度用完、沒網路 → 先暫停，恢復後自動繼續（這個安裝沒有本機聽寫）');
    if (c.listenEngine !== 'cloud') { c.listenEngine = 'cloud'; chrome.storage.local.set({ listenEngine: 'cloud' }); }
  }
  eng.value = c.listenEngine; key.value = c.groqKey;
  const show = (text, cls) => { setText(msg, text); msg.className = cls || ''; };
  const sync = () => {
    box.hidden = eng.value !== 'cloud';
    if (eng.value === 'cloud' && !key.value.trim()) show('還沒填金鑰：先照下面的步驟拿一組' + (tier < 4 ? '（這個安裝只有雲端聽寫，沒填就不能用）' : '，沒填會照常用本機聽寫'), 'bad');
  };
  sync();
  eng.addEventListener('change', () => { chrome.storage.local.set({ listenEngine: eng.value }); sync(); });
  const save = () => chrome.storage.local.set({ groqKey: key.value.replace(/\s+/g, '') });
  const okFormat = (v) => /^[A-Za-z0-9_-]{8,200}$/.test(v.replace(/\s+/g, ''));
  key.addEventListener('change', () => {
    save();
    if (key.value.trim() && !okFormat(key.value)) show('金鑰格式不對（多了引號、句點之類？）：重新複製一次 gsk_ 開頭那串', 'bad');
  });
  // 貼上後直接點別的地方關掉小視窗：不會有 change 事件，所以打字／貼上時就存（存在本機，沒有次數限制）
  key.addEventListener('input', () => { show(''); save(); });
  btn.addEventListener('click', async () => {
    await save();
    btn.disabled = true; show('測試中…');
    try {
      const r = await chrome.runtime.sendMessage({ type: 'cloudTest', key: key.value.replace(/\s+/g, '') });
      const d = r && r.ok ? r.data : { valid: false, message: (r && r.error) || '沒有回應' };
      show((d.valid ? '✓ ' : '✗ ') + d.message, d.valid ? 'ok' : 'bad');
    } catch (e) { show('✗ ' + e.message, 'bad'); } finally { btn.disabled = false; }
  });
  document.getElementById('groqLink').addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: e.currentTarget.href }); });
})();
