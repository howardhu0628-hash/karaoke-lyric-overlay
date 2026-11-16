// Service worker：負責跨網域請求（LRCLIB 歌詞、Google 翻譯），content script 透過 runtime 訊息呼叫。
// 日文斷詞（kuromoji）和歌詞對時放在 offscreen 文件裡跑（offscreen.html／offscreen.js）：
// 在 Edge 的擴充功能環境裡建字典要 5～7 秒的同步運算，放在這裡會讓背景其他請求全部卡住（實測 ping 等了 13 秒，被當成服務沒開）。
// 瀏覽器不支援 offscreen 時才退回在這裡算（lib/tokenize.js）。
const swBoot = Date.now();
importScripts('lib/xhr-shim.js', 'lib/shared.js', 'lib/furigana.js', 'lib/align.js', 'vendor/kuromoji/kuromoji.js', 'lib/tokenize.js');
const swImportMs = Date.now() - swBoot;
// 除錯：背景執行緒被卡住超過 0.4 秒的紀錄（當時正在處理哪些訊息），diag 會回報
const lagLog = [], inFlight = new Map();
let lagLast = Date.now();
setInterval(() => {
  const now = Date.now(), gap = now - lagLast;
  if (gap > 400) { lagLog.push({ at: now - swBoot, gap, busy: [...inFlight.values()].join(',') }); if (lagLog.length > 20) lagLog.shift(); }
  lagLast = now;
}, 100);
const F = self.YTLSFuri;
const T = self.YTLSTok;

// ---------- offscreen 文件（斷詞、對時）----------
let offCreating = null, offBroken = !(chrome.offscreen && chrome.offscreen.createDocument);
async function ensureOffscreen() {
  if (offBroken) throw new Error('offscreen 不能用');
  const has = chrome.runtime.getContexts
    ? (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0
    : false;
  if (has) return;
  if (!offCreating) {
    offCreating = chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['WORKERS'],
      justification: '日文斷詞字典（kuromoji）與歌詞對時，放在背景外面跑才不會卡住其他請求',
    }).catch((e) => { if (!/single offscreen|already/i.test(String(e && e.message))) { offBroken = true; throw e; } })
      .finally(() => { offCreating = null; });
  }
  await offCreating;
}
async function callOff(type, payload, ms) {
  await ensureOffscreen();
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await Promise.race([
        chrome.runtime.sendMessage({ target: 'ytls-offscreen', type, ...(payload || {}) }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('斷詞逾時')), ms)),
      ]);
      if (!res) throw new Error('斷詞沒有回應');
      if (!res.ok) throw new Error(res.error || '斷詞失敗');
      return res.data;
    } catch (e) {
      // 文件剛建好、腳本還沒載完：等一下再送
      if (attempt < 5 && /Receiving end does not exist|Could not establish connection|沒有回應/.test(String(e && e.message))) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

// 回傳 { ruby, roma }；不是日文或斷詞失敗時回傳 null（翻譯照常，只是沒有假名）
async function analyzeJapanese(lines) {
  if (!F.looksJapanese(lines)) return null;
  if (offBroken) return T.analyzeJapanese(lines);
  try { return await callOff('analyze', { lines }, 60000); } catch (e) {
    if (offBroken) return T.analyzeJapanese(lines);
    console.warn('[ytls] 斷詞失敗', e);
    return null;
  }
}

const LRC_HEADERS = { 'Lrclib-Client': 'yt-lyric-sub/0.1 (personal browser extension)' };

async function getJson(url, opts) {
  // 一律有逾時：網路卡住的請求以前會永遠等下去，翻譯、歌詞搜尋就一直停在「中…」
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), ...(opts || {}) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function slim(it) {
  return {
    id: it.id, trackName: it.trackName, artistName: it.artistName, albumName: it.albumName,
    duration: it.duration, instrumental: it.instrumental,
    syncedLyrics: it.syncedLyrics || null, plainLyrics: it.plainLyrics || null,
  };
}

// 雲端聽寫設定（擴充功能選項「AI 聽寫：雲端」＋ Groq 金鑰，存在 chrome.storage.local、不會同步到別台）：
// 開著而且有金鑰時，送給本機聽寫服務的請求加上 X-YTLS-Cloud 標頭（只送到 127.0.0.1，服務不存檔）
// 每次都直接讀（很快）：設定一改，下一個請求就照新的（回放工作的進度查詢也會帶，做到一半改設定，接下來的段落就照新的）
async function cloudHeaders() {
  const c = await chrome.storage.local.get({ listenEngine: 'local', groqKey: '' });
  const key = cleanKey(c.groqKey);
  return c.listenEngine === 'cloud' && key ? { 'X-YTLS-Cloud': key } : {};
}
// 貼上時常帶到空白、換行；格式跟服務收的一樣（英數字、_、-），不對就當沒填（服務照本機聽寫，設定頁會提示）
const cleanKey = (k) => { const s = String(k || '').replace(/\s+/g, ''); return /^[A-Za-z0-9_-]{8,200}$/.test(s) ? s : ''; };

let installInfoP = null;
function installInfo() {
  if (!installInfoP) {
    installInfoP = fetch(chrome.runtime.getURL('ytls-config.json'), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => ({ tier: c ? Math.min(4, Math.max(1, Number(c.tier) || 4)) : 4, installed: !!c }))
      .catch(() => ({ tier: 4, installed: false }));
  }
  return installInfoP;
}

const handlers = {
  // YouTube 分頁開著時每 25 秒叫一次：讓 service worker 不要閒置 30 秒就被收掉（收掉後下次要重載日文字典），
  // 順便在背景先把字典載好（第一次翻譯就不用等）
  async keepalive() { (offBroken ? T.getTokenizer() : callOff('warm', {}, 10000)).catch(() => {}); return true; },
  // 分級安裝：安裝程式寫在擴充功能資料夾的 ytls-config.json（tier 1～4；v1.0.56 以前裝的沒有 tier＝全部）。開發機沒有這個檔＝全部
  async installInfo() { return installInfo(); },
  // 面板上的「☁ 雲端聽寫設定」：打開擴充功能的設定小視窗；不行（Edge 實測不准擴充功能自己打開）就開成分頁，
  // 開在按的那個分頁旁邊（不指定的話會開到「最後用過的視窗」，可能是另一個視窗，看起來像沒反應）
  async openSettings(_msg, sender) {
    try { if (chrome.action && chrome.action.openPopup) { await chrome.action.openPopup(); return 'popup'; } } catch (e) { /* 改開分頁 */ }
    const t = sender && sender.tab;
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html'), ...(t ? { windowId: t.windowId, index: t.index + 1, openerTabId: t.id } : {}) });
    return 'tab';
  },
  async diag() {
    let off = null;
    if (!offBroken) { try { off = await callOff('diag', {}, 3000); } catch (e) { off = 'error ' + e.message; } }
    return { boot: swBoot, importMs: swImportMs, lag: lagLog, offBroken, off, localTok: T.diag, ocr: ocrDiag.last, ocrSum: ocrDiag.sum, prune: pruneDiag, tr: trDiag.last, cache: cache.size, disk: trdbDiag };
  },
  // queries: 字串陣列，平行搜尋後合併（排序交給 content script，因為它有影片資訊）
  async lyricsSearch({ queries }) {
    const results = await Promise.allSettled(
      (queries || []).slice(0, 6).map((q) =>
        getJson('https://lrclib.net/api/search?q=' + encodeURIComponent(q), { headers: LRC_HEADERS })),
    );
    const seen = new Map();
    for (const r of results) {
      if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
      for (const it of r.value) if (!seen.has(it.id)) seen.set(it.id, slim(it));
    }
    if (!seen.size && results.every((r) => r.status === 'rejected')) {
      throw new Error('LRCLIB 連線失敗：' + results[0]?.reason?.message);
    }
    return [...seen.values()];
  },

  async lyricsGet({ id }) {
    const it = await getJson('https://lrclib.net/api/get/' + encodeURIComponent(id), { headers: LRC_HEADERS });
    return it ? slim(it) : null;
  },

  // 本機 OCR 服務（ocr-server/ocr-server.ps1，Windows 內建日文 OCR）
  // 面板的「啟動本機服務」：透過 Edge 原生訊息小幫手（native-host/，要先雙擊 install.cmd 註冊）啟動工作排程器裡的服務
  async startServices({ which }) {
    try {
      return await chrome.runtime.sendNativeMessage('ytlyricsub.host', { action: 'start', which: which || ['ocr', 'listen'] });
    } catch (e) {
      return { ok: false, notInstalled: /not found|not registered|找不到|Specified native messaging host/i.test(String(e && e.message)), error: String(e && e.message) };
    }
  },

  // 顯示卡被其他程式（ComfyUI）佔滿時服務會回得慢：等久一點，免得把「忙碌」誤判成「沒開」
  async ocrPing() {
    try {
      const r = await fetch('http://localhost:8766/ping', { signal: AbortSignal.timeout(4000) });
      return r.ok;
    } catch (e) { return false; }
  },
  async ocr({ dataUrl }) {
    const t0 = Date.now(), d = { len: (dataUrl || '').length };
    ocrDiag.last = d;
    const blob = await (await fetch(dataUrl)).blob();
    d.decodeMs = Date.now() - t0;
    const r = await fetch('http://localhost:8766/ocr', {
      method: 'POST', headers: { 'X-YTLS': '1', 'content-type': 'image/jpeg' }, body: blob, signal: AbortSignal.timeout(25000),
    });
    d.postMs = Date.now() - t0 - d.decodeMs;
    // 503＋yield：顯示卡讓給別的程式（遊戲、ComfyUI 算圖）中，服務先不辨識；交給 content script 等它用完
    if (r.status === 503) { try { const j = await r.json(); if (j && j.yield) return j; } catch (e) { /* 照一般錯誤 */ } }
    if (!r.ok) throw new Error('OCR 服務回應 ' + r.status);
    const j = await r.json();
    d.totalMs = Date.now() - t0;
    const sm = ocrDiag.sum = ocrDiag.sum || { n: 0, decode: 0, post: 0, srv: 0 };
    sm.n++; sm.decode += d.decodeMs; sm.post += d.postMs; sm.srv += j.ms || 0;
    return j;
  },

  // 面板「這次照用」：兩個服務都先不讓顯示卡（對方結束後自動恢復成會讓）
  async gpuOverride() {
    const one = async (port) => {
      try {
        const r = await fetch('http://localhost:' + port + '/gpu/override', {
          method: 'POST', headers: { 'X-YTLS': '1', 'content-type': 'application/json' }, body: JSON.stringify({ on: true }), signal: AbortSignal.timeout(5000),
        });
        return r.ok ? await r.json() : null;
      } catch (e) { return null; }
    };
    const [ocr, listen] = await Promise.all([one(8766), one(8767)]);
    return { ok: true, ocr, listen };
  },

  // 本機 AI 聽寫服務（listen-server/listen-server.py，faster-whisper）
  async listenPing() {
    try {
      const r = await fetch('http://localhost:8767/ping', { signal: AbortSignal.timeout(4000) });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  },
  async listenVodStart({ videoId, from, song, hints }) {
    const r = await fetch('http://localhost:8767/vod/start', {
      method: 'POST', headers: { 'X-YTLS': '1', 'content-type': 'application/json', ...(await cloudHeaders()) },
      body: JSON.stringify({ videoId, from, song: !!song, hints: hints || '' }), signal: AbortSignal.timeout(15000),
    });
    return r.json();
  },
  // 使用者跳到還沒聽寫的地方：請服務先做那一段
  async listenVodFocus({ videoId, at, song }) {
    const r = await fetch('http://localhost:8767/vod/focus', {
      method: 'POST', headers: { 'X-YTLS': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ videoId, at, song: !!song }), signal: AbortSignal.timeout(5000),
    });
    return r.json();
  },
  async listenVodStatus({ videoId, since, song }) {
    const r = await fetch('http://localhost:8767/vod/status?videoId=' + encodeURIComponent(videoId) + '&since=' + (since || 0) + (song ? '&song=1' : ''), {
      headers: { 'X-YTLS': '1', ...(await cloudHeaders()) }, signal: AbortSignal.timeout(15000),
    });
    return r.json();
  },
  // 真‧卡拉 OK 伴奏（listen-server/kara.py）：找官方伴奏比對，沒有就 AI 去人聲
  async karaStart(p) {
    const body = { videoId: p.videoId, song: p.song || '', artist: p.artist || '', queries: p.queries || [], len: p.len || 0, mode: p.mode || 'auto', force: !!p.force };
    const r = await fetch('http://localhost:8767/kara/start', {
      method: 'POST', headers: { 'X-YTLS': '1', 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    return r.json();
  },
  // 打開音樂影片就先下載音訊、載模型（服務沒開就算了，不報錯）
  async karaPrep({ videoId }) {
    try {
      const r = await fetch('http://localhost:8767/kara/prep', {
        method: 'POST', headers: { 'X-YTLS': '1', 'content-type': 'application/json' }, body: JSON.stringify({ videoId }), signal: AbortSignal.timeout(5000),
      });
      return await r.json();
    } catch (e) { return null; }
  },
  async karaStatus({ videoId }) {
    const r = await fetch('http://localhost:8767/kara/status?videoId=' + encodeURIComponent(videoId), { headers: { 'X-YTLS': '1' }, signal: AbortSignal.timeout(10000) });
    return r.json();
  },
  // 音檔分段拿（每段 1MB，轉 base64 給 content script 組成 Blob）
  // 升降 Key：服務把伴奏變調（rubberband，不變速），做好才回（第一次約 10 秒，之後有快取）
  async karaKey({ videoId, key }) {
    const r = await fetch('http://localhost:8767/kara/key', {
      method: 'POST', headers: { 'X-YTLS': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ videoId, key: Number(key) || 0 }), signal: AbortSignal.timeout(90000),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '變調失敗');
    return j;
  },
  async karaAudio({ videoId, key, start, len }) {
    const r = await fetch('http://localhost:8767/kara/audio?videoId=' + encodeURIComponent(videoId) + '&key=' + (Number(key) || 0) + '&start=' + (start || 0) + '&len=' + (len || 1048576), {
      headers: { 'X-YTLS': '1' }, signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error('伴奏音檔讀取失敗（' + r.status + '）');
    const u8 = new Uint8Array(await r.arrayBuffer());
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return { data: btoa(bin), total: Number(r.headers.get('X-Total')) || u8.length, type: r.headers.get('X-Type') || 'audio/webm' };
  },
  // pcm：16kHz 單聲道 16-bit 的 base64
  async listenChunk({ t0, pcm, hints }) {
    const bytes = Uint8Array.from(atob(pcm), (c) => c.charCodeAt(0));
    const r = await fetch('http://localhost:8767/live/chunk?t0=' + Math.round(t0) + (hints ? '&hints=' + encodeURIComponent(hints) : ''), {
      method: 'POST', headers: { 'X-YTLS': '1', ...(await cloudHeaders()) }, body: bytes, signal: AbortSignal.timeout(60000),
    });
    return r.json();
  },
  // 設定頁「測試金鑰」：請本機聽寫服務問 Groq 這把金鑰能不能用
  async cloudTest({ key }) {
    if (!cleanKey(key)) return { valid: false, message: '金鑰格式不對：應該是 gsk_ 開頭的一長串英數字，重新複製一次' };
    let r;
    try {
      // 服務那邊問 Groq 最多等約 30 秒：這裡等久一點，免得 Groq 慢的時候被說成「服務沒開」
      r = await fetch('http://localhost:8767/cloud/test', {
        method: 'POST', headers: { 'X-YTLS': '1', 'X-YTLS-Cloud': cleanKey(key) }, signal: AbortSignal.timeout(40000),
      });
    } catch (e) {
      if (e && e.name === 'TimeoutError') return { valid: false, message: 'Groq 回應太慢，稍後再按一次測試' };
      return { valid: false, message: 'AI 聽寫服務沒開：雲端聽寫也要靠它下載音訊、送出去。先在影片面板按「▶ 啟動本機服務」' };
    }
    if (r.status === 404) return { valid: false, message: 'AI 聽寫服務是舊版：重新開機或重開服務後再試' };
    return r.json();
  },

  // 沒有時間軸的歌詞（說明欄、LRCLIB 純文字）對齊到自動字幕的逐詞時間
  // prior：參考時間（翻唱用原曲 LRC、YT Music 逐句時間），錨點之間按它的相對間距分配
  async alignLyrics(p) {
    const args = { lines: p.lines, para: p.para, words: p.words, spans: p.spans, durationMs: p.durationMs, prior: p.prior };
    if (offBroken) return T.alignLyrics(args);
    try { return await callOff('align', args, 90000); } catch (e) {
      if (offBroken) return T.alignLyrics(args);
      throw e;
    }
  },

  // lines: 字串陣列；回傳 { trans: [], roma: [], ruby: []|null, lang }，長度與 lines 相同
  // 日文行的拼音改用本機斷詞讀音（比 Google 準），其他語言才用 Google 的拼音
  async translate({ lines, tl, romaji, vid }) {
    lines = lines || [];
    const ja = await analyzeJapanese(lines);
    const skip = new Set();
    if (ja) ja.roma.forEach((r, i) => { if (r) skip.add(i); });
    // Google 翻譯失敗（限流、斷網）時，本機算的假名和拼音照樣回傳，content script 會稍後重試翻譯
    let res;
    try { res = await translateLines(lines, tl || 'zh-TW', !!romaji, skip, vid); }
    catch (e) { res = { ...((e && e.partial) || { trans: lines.map(() => ''), roma: lines.map(() => ''), lang: '' }), error: String((e && e.message) || e) }; }
    if (ja) ja.roma.forEach((r, i) => { if (r) res.roma[i] = r; });
    res.ruby = ja ? ja.ruby : null;
    return res;
  },
};

// 開發中自動更新：這是「載入未封裝」的擴充功能，檔案改了 Edge 不會自己重新載入。
// 每次 YouTube 頁面找背景做事時（最多 20 秒看一次），比對硬碟上 manifest.json 的版本和目前載入的版本，不一樣就重新載入自己。
// 已經開著的 YouTube 分頁要重新整理才會用新版（舊分頁的面板會提示）。
let updCheckAt = 0;
async function checkSelfUpdate() {
  if (self.location.protocol !== 'chrome-extension:' || Date.now() - updCheckAt < 20000) return;
  updCheckAt = Date.now();
  try {
    const disk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store', signal: AbortSignal.timeout(5000) })).json();
    if (disk.version && disk.version !== chrome.runtime.getManifest().version) {
      console.log('[ytls] 硬碟上是新版', disk.version, '，重新載入擴充功能');
      setTimeout(() => chrome.runtime.reload(), 500);
    }
  } catch (e) { /* manifest 正在存檔、格式不完整：下次再看 */ }
}

// ---------- 本機儲存空間（chrome.storage.local，Edge 給擴充功能的上限是 10 MB）----------
// 每部影片的設定（v:）、畫面字幕紀錄（ocr:）、邊播邊聽寫的結果（listen:）會一直累積；
// 超過 8 MB 就從最久沒看的影片開始整部刪掉，刪到 6 MB 以下（滿了之後新的紀錄會存不進去，而且不會報錯）
const STORE_MAX = 8 * 1024 * 1024, STORE_TARGET = 6 * 1024 * 1024;
let pruneTimer = null;
const pruneDiag = { runs: 0, lastMs: 0, used: 0 };
const utf8 = new TextEncoder();
let pruneFirst = 0;
async function pruneStorage(max = STORE_MAX, target = STORE_TARGET) {
  const tP = Date.now(); pruneDiag.runs++;
  const used = await chrome.storage.local.getBytesInUse(null);
  pruneDiag.used = used; pruneDiag.lastMs = Date.now() - tP;
  if (used <= max) return { used, removed: 0 };
  const all = await chrome.storage.local.get(null);
  const vids = new Map();
  for (const [k, v] of Object.entries(all)) {
    const m = /^(v|ocr|listen):(.+)$/.exec(k);
    if (!m) continue;
    const e = vids.get(m[2]) || { t: 0, keys: [], size: 0 };
    e.t = Math.max(e.t, Number(v && v.t) || 0);
    e.keys.push(k);
    e.size += utf8.encode(k + JSON.stringify(v)).length; // getBytesInUse 算的是 UTF-8 位元組（日文一個字 3 位元組）
    vids.set(m[2], e);
  }
  let over = used - target;
  const del = [];
  let n = 0;
  for (const e of [...vids.values()].sort((a, b) => a.t - b.t)) {
    if (over <= 0) break;
    del.push(...e.keys); over -= e.size; n++;
  }
  if (del.length) await chrome.storage.local.remove(del);
  console.log('[ytls] 儲存空間', (used / 1048576).toFixed(1), 'MB，刪掉最久沒看的', n, '部影片的紀錄');
  return { used, removed: n };
}
chrome.storage.onChanged.addListener((_ch, area) => {
  if (area !== 'local') return;
  // 停 5 秒沒有新的寫入才整理；但兩個分頁一直在存畫面字幕時永遠等不到，所以最多等 30 秒
  clearTimeout(pruneTimer);
  if (!pruneFirst) pruneFirst = Date.now();
  const run = () => { pruneFirst = 0; pruneStorage().catch(() => {}); };
  if (Date.now() - pruneFirst > 30000) run(); else pruneTimer = setTimeout(run, 5000);
});
chrome.runtime.onStartup.addListener(() => pruneStorage().catch(() => {}));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.target === 'ytls-offscreen') return false; // 給 offscreen 文件的
  checkSelfUpdate();
  const h = handlers[msg && msg.type];
  if (!h) return false;
  const opId = Math.random();
  inFlight.set(opId, msg.type);
  h(msg, sender).finally(() => inFlight.delete(opId)).then(
    (data) => sendResponse({ ok: true, data }),
    (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }),
  );
  return true;
});

// ---------- 翻譯 ----------
const cache = new Map(); // key: tl|romaji|text → {t, r}

async function gtx(text, tl, dts) {
  const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + encodeURIComponent(tl) +
    dts.map((d) => '&dt=' + d).join('') + '&q=' + encodeURIComponent(text);
  const j = await getJson(u);
  if (!j) throw new Error('翻譯服務沒有回應');
  const segs = Array.isArray(j[0]) ? j[0] : [];
  const trans = segs.filter((s) => s && s[0] != null).map((s) => s[0]).join('');
  const rmSeg = segs.find((s) => s && s[0] == null && s[3] != null);
  return { trans, roma: rmSeg ? String(rmSeg[3]) : '', lang: j[2] || '' };
}

function chunk(items, budget) {
  const out = [];
  let cur = [], len = 0;
  for (const it of items) {
    if (cur.length && len + it.text.length > budget) { out.push(cur); cur = []; len = 0; }
    cur.push(it); len += it.text.length + 1;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function pool(tasks, n) {
  const res = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) { const k = i++; res[k] = await tasks[k](); }
  }));
  return res;
}

const trDiag = { last: null };
const ocrDiag = { last: null };
// ---------- 翻譯存硬碟（IndexedDB）----------
// 每部影片（＋目標語言）一筆：{ 原句: [翻譯, 拼音] }。重看同一部影片、背景程式被 Edge 收掉再叫起來，翻譯都直接拿，不用再問 Google。
// 總量上限 20 MB（超過先刪最久沒看的影片）、30 天沒再看的刪掉；移除擴充功能時 Edge 會一起清掉。
// 'data' 放內容、'meta' 只放 {k, a: 最後使用時間, s: 大小}：清理時只讀 meta，不用把 20 MB 全部讀進來。
const TRDB_MAX = 20 * 1024 * 1024, TRDB_TTL = 30 * 86400000;
const trdbDiag = { hits: 0, saved: 0, pruned: 0, bytes: 0, err: '' };
let trdbP = null;
function trdb() {
  if (!trdbP) {
    trdbP = new Promise((res, rej) => {
      const r = indexedDB.open('ytls-tr', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('data', { keyPath: 'k' });
        r.result.createObjectStore('meta', { keyPath: 'k' }).createIndex('a', 'a');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    trdbP.catch((e) => { trdbP = null; trdbDiag.err = String(e); });
  }
  return trdbP;
}
const idbReq = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const idbDone = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });
const trVid = new Map(); // 最近用到的幾部影片：k → { k, lines, a, dirty }
const trVidLoading = new Map();
function trKey(vid, tl, romaji) {
  return typeof vid === 'string' && /^[\w-]{6,20}$/.test(vid) ? tl + '|' + (romaji ? 1 : 0) + '|' + vid : null;
}
async function trLoad(k) {
  if (trVid.has(k)) return trVid.get(k);
  if (!trVidLoading.has(k)) {
    trVidLoading.set(k, (async () => {
      let rec = null, meta = null;
      try {
        const tx = (await trdb()).transaction(['data', 'meta']);
        [rec, meta] = await Promise.all([idbReq(tx.objectStore('data').get(k)), idbReq(tx.objectStore('meta').get(k))]);
      } catch (e) { trdbDiag.err = String(e); }
      const e = { k, lines: (rec && rec.lines) || {}, a: (meta && meta.a) || 0, dirty: false };
      if (rec && Date.now() - e.a > 3600000) { e.dirty = true; trSaveSoon(); } // 更新最後使用時間（最多一小時寫一次）
      trVid.set(k, e);
      while (trVid.size > 6) { // 記憶體只留最近幾部；要丟的還沒存就先存
        const [ok, old] = trVid.entries().next().value;
        if (old.dirty) trSave([old]);
        trVid.delete(ok);
      }
      return e;
    })().finally(() => trVidLoading.delete(k)));
  }
  return trVidLoading.get(k);
}
let trSaveTimer = null, trPruneAt = 0;
function trSaveSoon() {
  clearTimeout(trSaveTimer);
  trSaveTimer = setTimeout(() => trSave([...trVid.values()].filter((e) => e.dirty)), 3000);
}
async function trSave(list) {
  if (!list.length) return;
  try {
    const tx = (await trdb()).transaction(['data', 'meta'], 'readwrite');
    const now = Date.now(), enc = new TextEncoder();
    for (const e of list) {
      e.dirty = false; e.a = now;
      const s = enc.encode(JSON.stringify(e.lines)).length + e.k.length;
      tx.objectStore('data').put({ k: e.k, lines: e.lines });
      tx.objectStore('meta').put({ k: e.k, a: now, s });
      trdbDiag.saved++;
    }
    await idbDone(tx);
  } catch (err) { trdbDiag.err = String(err); return; }
  if (Date.now() - trPruneAt > 600000) trPrune().catch((err) => { trdbDiag.err = String(err); });
}
async function trPrune() {
  trPruneAt = Date.now();
  const db = await trdb();
  const metas = await idbReq(db.transaction('meta').objectStore('meta').getAll());
  metas.sort((a, b) => b.a - a.a); // 最近用過的在前
  let total = 0;
  const del = [];
  for (const m of metas) {
    if (trVid.has(m.k)) { total += m.s; continue; } // 正在用的不刪
    if (Date.now() - m.a > TRDB_TTL || total + m.s > TRDB_MAX) del.push(m.k);
    else total += m.s;
  }
  trdbDiag.bytes = total;
  if (!del.length) return;
  const tx = db.transaction(['data', 'meta'], 'readwrite');
  for (const k of del) { tx.objectStore('data').delete(k); tx.objectStore('meta').delete(k); }
  await idbDone(tx);
  trdbDiag.pruned += del.length;
  console.log('[ytls] 翻譯快取刪掉', del.length, '部影片（超過 30 天或超過 20 MB）');
}
chrome.runtime.onStartup.addListener(() => setTimeout(() => trPrune().catch(() => {}), 10000));

async function translateLines(lines, tl, romaji, skipRoma = new Set(), vid = null) {
  const t0 = Date.now(), d = { lines: lines.length, chunks: 0, fallback: 0, romaFallback: 0, ms: 0, disk: 0 };
  trDiag.last = d;
  const trans = new Array(lines.length).fill('');
  const roma = new Array(lines.length).fill('');
  let lang = '';
  const todo = [];
  const hitR = [];
  // 拼音存 null＝「當時沒拿到」（本機斷詞產生的、Google 拼音失敗的）：之後這句要 Google 拼音時當作沒快取，重新拿
  const usable = (r, i) => !(romaji && r == null && !skipRoma.has(i));
  const k = trKey(vid, tl, romaji);
  const saved = k ? await trLoad(k).catch(() => null) : null;
  lines.forEach((text, i) => {
    const t = String(text || '').trim();
    if (!t) return;
    const hit = cache.get(tl + '|' + romaji + '|' + t);
    if (hit && usable(hit.r, i)) { trans[i] = hit.t; roma[i] = hit.r || ''; hitR[i] = hit.r; return; }
    const sv = saved && saved.lines[t];
    if (sv && sv[0] && usable(sv[1], i)) { trans[i] = sv[0]; roma[i] = sv[1] || ''; hitR[i] = sv[1]; d.disk++; trdbDiag.hits++; cache.set(tl + '|' + romaji + '|' + t, { t: sv[0], r: sv[1] }); return; }
    todo.push({ i, text: t });
  });
  // 從記憶體快取拿到的，這部影片的硬碟紀錄裡沒有：也補進去（例如同一首歌換了一部影片）
  if (saved) {
    let add = false;
    lines.forEach((text, i) => { const t = String(text || '').trim(); if (t && trans[i] && !saved.lines[t]) { saved.lines[t] = [trans[i], hitR[i] !== undefined ? hitR[i] : roma[i]]; add = true; } });
    if (add) { saved.dirty = true; trSaveSoon(); }
  }

  const romaFailed = new Set();
  for (const group of chunk(todo, 700)) {
    // 翻譯：用換行串接，Google 會保留行數
    let ok = false;
    try {
      const r = await gtx(group.map((g) => g.text).join('\n'), tl, ['t']);
      lang = lang || r.lang;
      const parts = r.trans.split('\n');
      if (parts.length === group.length) { group.forEach((g, k) => { trans[g.i] = parts[k].trim(); }); ok = true; }
    } catch (e) { /* 下方逐行補救 */ }
    d.chunks++;
    if (!ok) {
      d.fallback++;
      await pool(group.map((g) => async () => {
        try { const r = await gtx(g.text, tl, ['t']); trans[g.i] = r.trans.trim(); lang = lang || r.lang; } catch (e) { /* 留空 */ }
      }), 4);
    }

    // 羅馬拼音：換行會被吃掉，所以用「 | 」分隔再切回來（已由本機斷詞產生的行跳過）
    const romaGroup = group.filter((g) => !skipRoma.has(g.i));
    if (romaji && romaGroup.length) {
      const group = romaGroup; // 以下只處理需要 Google 拼音的行
      let rok = false;
      try {
        const r = await gtx(group.map((g) => g.text.replace(/\|/g, '/')).join(' | '), 'en', ['rm']);
        const parts = r.roma ? r.roma.split(/\s*\|\s*/) : [];
        if (parts.length === group.length) { group.forEach((g, k) => { roma[g.i] = parts[k].trim(); }); rok = true; }
        else if (!r.roma) rok = true; // 來源是拉丁字母語言，本來就沒有拼音
      } catch (e) { /* 下方逐行補救 */ }
      if (!rok) {
        d.romaFallback++;
        await pool(group.map((g) => async () => {
          try { roma[g.i] = (await gtx(g.text, 'en', ['rm'])).roma.trim(); } catch (e) { romaFailed.add(g.i); /* 留空，下次再拿 */ }
        }), 4);
      }
    }
    // 只快取翻譯成功的行：被限流（429）、斷網時的空結果以前也被存起來，那幾句之後就一直沒有中文
    for (const g of group) {
      if (!trans[g.i]) continue;
      const r = skipRoma.has(g.i) || romaFailed.has(g.i) ? null : roma[g.i];
      cache.set(tl + '|' + romaji + '|' + g.text, { t: trans[g.i], r });
      if (saved) { saved.lines[g.text] = [trans[g.i], r]; saved.dirty = true; }
    }
    if (saved && saved.dirty) trSaveSoon();
  }
  if (cache.size > 5000) cache.clear();
  d.ms = Date.now() - t0;
  // 整批一句都沒翻成功：當作失敗丟出去，content script 會等一下重試（以前回傳空字串當成功，不會重試）
  if (todo.length && todo.every((g) => !trans[g.i])) {
    // 沒命中快取的那幾句全部失敗：丟錯讓 content script 重試，但同一批從快取拿到的翻譯要一起帶出去，不要被清空
    const err = new Error('翻譯服務沒有回應（可能被暫時限流），稍後重試');
    err.partial = { trans, roma, lang };
    throw err;
  }
  return { trans, roma, lang };
}
