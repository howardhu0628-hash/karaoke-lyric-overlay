// YouTube 頁面上的主程式：選擇來源（同步歌詞／字幕軌）→ 翻譯 → 疊在影片上顯示。
// 注意：YouTube 啟用了 Trusted Types，全程不用 innerHTML，只用 DOM API 組畫面。
(() => {
  'use strict';
  if (window.__ytlsContent) return;
  window.__ytlsContent = true;

  const S = globalThis.YTLS;
  // YouTube Music：歌詞做成固定在畫面下方（播放列上面）的卡拉 OK 歌詞條，逛別的頁面時也看得到
  // （測試頁 localhost 加 ?ytm=1 也走 YouTube Music 的版面）
  const IS_YTM = location.hostname === 'music.youtube.com' || (location.hostname === 'localhost' && /[?&]ytm=1/.test(location.search));
  if (IS_YTM) document.documentElement.classList.add('ytls-ytm');
  const DEFAULTS = {
    enabled: true, targetLang: 'zh-TW', mode: 'auto',
    showOrig: true, showFurigana: true, showRoma: true, showTrans: true, showNext: true,
    hideNative: true, karaoke: false, fontScale: 1, bottom: 10, layout: 'ktv', ocr: true, talkView: true,
    kara: false, karaVol: 0.9, guideVol: 0, // 真‧卡拉 OK：伴奏開關、伴奏音量、原唱（導唱）音量
    vidView: 'zh', // 看影片／直播（日文字幕、AI 聽寫）：'zh' 只顯示中文、'both' 中日都顯示、'ja' 只顯示日文（有假名）
  };
  let settings = { ...DEFAULTS };
  // 字體大小、離底部距離：YouTube 與 YouTube Music 各記各的（Music 存成 ytm_fontScale / ytm_bottom）
  const SITE_KEYS = ['fontScale', 'bottom'];
  const storeKey = (k) => (IS_YTM && SITE_KEYS.includes(k) ? 'ytm_' + k : k);
  const RANGE_KEYS = SITE_KEYS.concat(['karaVol', 'guideVol']); // 拉桿：拖動時先套用，停下來才存

  // ---------- 小工具 ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
    return el;
  }
  const player = () => document.getElementById('movie_player');
  const video = () => document.querySelector('#movie_player video');
  const langKey = (l) => {
    l = String(l || '').toLowerCase();
    if (/^zh-(tw|hk|mo|hant)/.test(l)) return 'zh-TW';
    if (/^zh/.test(l)) return 'zh-CN';
    return l.split('-')[0];
  };

  // 背景的工作最多等多久（毫秒）：卡住的請求不會讓翻譯、伴奏一直停在「中…」
  const bgPending = new Map(); // 還在等背景回覆的呼叫（除錯用：頁面送 {ns:'ytls', dir:'dbg'} 可以看）
  let bgSeq = 0;
  const BG_TIMEOUT = { translate: 90000, lyricsSearch: 60000, lyricsGet: 30000, alignLyrics: 60000, listenPing: 10000, ocrPing: 10000 };
  async function bg(type, payload) {
    const id = ++bgSeq;
    bgPending.set(id, { type, at: Date.now() });
    try { return await bgCall(type, payload); } finally { bgPending.delete(id); }
  }
  async function bgCall(type, payload) {
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        const send = chrome.runtime.sendMessage({ type, ...payload });
        const ms = BG_TIMEOUT[type];
        res = ms ? await Promise.race([send, sleep(ms).then(() => { throw new Error('背景處理逾時（' + Math.round(ms / 1000) + ' 秒）'); })]) : await send;
        break;
      } catch (e) {
        const msg = String(e && e.message);
        // 擴充功能更新後（重新載入），這個分頁裡的舊版就連不到背景了
        if (/context invalidated/i.test(msg) || !extAlive()) {
          setStatus('擴充功能已經更新到新版：重新整理這個頁面（F5）就會用新版。');
          throw new Error('擴充功能已更新，請重新整理頁面');
        }
        // 背景（service worker）剛好在重開或被瀏覽器收掉：「Receiving end does not exist」「message channel closed」。
        // 以前直接當失敗，翻譯、伴奏就停在錯誤；等一下再送通常就好
        if (attempt < 3 && /Receiving end does not exist|Could not establish connection|message channel closed|message port closed/i.test(msg)) {
          await sleep(400 * (attempt + 1) * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
    if (!res || !res.ok) throw new Error((res && res.error) || '背景服務沒有回應');
    return res.data;
  }

  // ---------- 與主世界 hook.js 溝通 ----------
  let reqId = 0;
  const pending = new Map();
  const captured = new Map(); // videoId → 帶 pot 的 timedtext 網址
  let capWaiters = [];
  let dbgSerialScan = false, dbgNoSame = false; // 測試用開關（見下面 dbg）
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.ns !== 'ytls') return;
    if (d.dir === 'dbg') { // 測試用：把目前狀態寫到 <html data-ytls-state>（不含網址）
      if ('noSame' in d) dbgNoSame = !!d.noSame; // 測試用：快速掃描不跳過相同畫面（對照結果和速度）
      if ('serialScan' in d) dbgSerialScan = !!d.serialScan; // 測試用：快速掃描改回一張做完才做下一張（對照速度）
      if (d.audit) { // 測試用：本機存的紀錄總覽（找舊版留下的壞資料），寫到 <html data-ytls-audit>
        chrome.storage.local.get(null).then(async (all) => {
          const used = await chrome.storage.local.getBytesInUse(null).catch(() => -1);
          const ocr = [], prefs = {}, other = {};
          for (const [k, v] of Object.entries(all)) {
            if (k.startsWith('ocr:')) {
              const cues = (v && v.cues) || [];
              const last = cues.reduce((m, c) => Math.max(m, c.end || 0), 0);
              ocr.push({ vid: k.slice(4), n: cues.length, scanned: !!v.scanned, ranges: v.ranges || (v.scanTo ? [[0, v.scanTo]] : []), lastMin: Math.round(last / 6000) / 10, kb: Math.round(JSON.stringify(v).length / 1024), days: v.t ? Math.round((Date.now() - v.t) / 864e5) : null });
            } else if (k.startsWith('v:')) { for (const pk of Object.keys(v || {})) prefs[pk] = (prefs[pk] || 0) + 1; prefs._n = (prefs._n || 0) + 1; }
            else other[k.replace(/:.*/, ':*')] = (other[k.replace(/:.*/, ':*')] || 0) + 1;
          }
          document.documentElement.dataset.ytlsAudit = JSON.stringify({ used, ocr, prefs, other });
        }).catch((err) => { document.documentElement.dataset.ytlsAudit = 'error ' + err.message; });
      }
      try { document.documentElement.dataset.ytlsState = JSON.stringify({
        vid: st.vid, kind: st.kind, label: st.label, status: st.status, translating: st.translating, cues: st.cues.length,
        translated: st.cues.filter((c) => c.tr).length, ruby: st.cues.filter((c) => c.rb).length, kara: { state: kara.state, detail: kara.detail },
        pending: [...bgPending.values()].map((x) => x.type + ':' + Math.round((Date.now() - x.at) / 1000) + 's'),
        scan: st.scanStats || null, scanned: st.ocrScanned,
        near: (() => { const v = video(); const t = v ? v.currentTime * 1000 : 0; return st.cues.filter((c) => c.end > t - 20000 && c.start < t + 20000).slice(0, 12).map((c) => Math.round(c.start / 100) / 10 + '-' + Math.round(c.end / 100) / 10 + ' ' + String(c.text).slice(0, 14)); })(),
        span: st.cues.length ? [Math.round(st.cues[0].start / 1000), Math.round(st.cues[st.cues.length - 1].end / 1000)] : null,
        ocrMin: st.ocr ? st.ocr.all().reduce((m, c) => { const k = Math.floor(c.start / 60000); m[k] = (m[k] || 0) + 1; return m; }, {}) : null,
        listen: { ...listen.stats, stTok: st.token, audio: !!listen.audio, ctx: listen.audio ? listen.audio.ctx.state : '', ctxTime: listen.audio ? Math.round(listen.audio.ctx.currentTime) : 0 },
      }); } catch (err) { document.documentElement.dataset.ytlsState = 'error ' + err.message; }
      bg('diag', {}).then((r) => { document.documentElement.dataset.ytlsDiag = JSON.stringify(r); }, (err) => { document.documentElement.dataset.ytlsDiag = 'error ' + err.message; });
      return;
    }
    if (d.dir === 'res') {
      const cb = pending.get(d.id);
      if (cb) { pending.delete(d.id); cb(d); }
    } else if (d.dir === 'evt' && d.type === 'timedtext') {
      try {
        const u = new URL(d.url);
        const v = u.searchParams.get('v');
        if (!v) return;
        if (u.searchParams.get('pot') || !captured.has(v)) captured.set(v, d.url);
        // 只有帶 pot 權杖的請求才算等到：播放器也會發出不帶權杖的字幕請求，以前一攔到就當成等到了，
        // 25 毫秒就放棄日文軌、改用排後面的語言（實測選到英文、韓文）
        if (u.searchParams.get('pot')) capWaiters = capWaiters.filter((w) => (w.vid === v ? (w.resolve(d.url), false) : true));
      } catch (err) { /* ignore */ }
    }
  });
  function bridge(cmd, args, timeout = 3000) {
    return new Promise((resolve) => {
      const id = ++reqId;
      const t = setTimeout(() => { pending.delete(id); resolve(null); }, timeout);
      pending.set(id, (d) => { clearTimeout(t); resolve(d.data); });
      window.postMessage({ ns: 'ytls', dir: 'req', id, cmd, args }, location.origin);
    });
  }
  function waitCaptured(vid, ms) {
    return new Promise((resolve) => {
      const w = { vid, resolve };
      capWaiters.push(w);
      setTimeout(() => { capWaiters = capWaiters.filter((x) => x !== w); resolve(null); }, ms);
    });
  }

  // ---------- 狀態 ----------
  const st = {
    vid: null, info: null, token: 0,
    kind: null,            // 'lrc' | 'yt' | 'plain' | null
    label: '', cues: [], candidates: [], choice: null,
    offset: 0, srcLang: '', status: '', translating: false,
    cur: -2, next: -2,
  };

  function reset() {
    st.token++;
    // 存檔失敗（例如擴充功能剛更新、這個分頁的舊版連不到 chrome.storage，會直接丟錯）不能擋住清除：
    // 之前就是卡在這裡，換影片後上一部的字幕還留在畫面上
    try { saveOcr(true); } catch (e) { /* ignore */ }
    stopListen();
    Object.assign(st, {
      info: null, kind: null, label: '', cues: [], candidates: [], choice: null, offset: 0, srcLang: '', status: '', translating: false, cur: -2, next: -2,
      asrJson: undefined, descLines: undefined, aligned: null, isAsr: false, manual: false, ytm: undefined, ytmSearched: false, ytmLoading: false, talk: false,
      scene: 'song', sceneAuto: 'song', ocrGaveUp: false,
      ocr: null, ocrScanned: false, ocrRanges: [], ocrPlayed: 0, ocrSavedAt: 0, ocrAlignedCount: 0, ocrAlignedAt: 0, songJob: null,
    });
    renderAll();
  }

  async function getPref(vid) {
    const k = 'v:' + vid;
    const o = await chrome.storage.local.get([k, 'ocr:' + vid, 'listen:' + vid]);
    // 儲存空間滿了會先刪「最久沒看」的影片：打開時就更新時間（一天最多一次），不然常看但不再寫入的影片
    // （例如早就掃描完畫面字幕的）會被當成最舊的先刪掉
    const last = Math.max(...[o[k], o['ocr:' + vid], o['listen:' + vid]].map((x) => (x && Number(x.t)) || 0));
    if (last && Date.now() - last > 86400000) chrome.storage.local.set({ [k]: { ...(o[k] || {}), t: Date.now() } }).catch(() => {});
    return o[k] || {};
  }
  async function setPref(patch) {
    if (!st.vid) return;
    const k = 'v:' + st.vid;
    const cur = await getPref(st.vid);
    await chrome.storage.local.set({ [k]: { ...cur, ...patch, t: Date.now() } });
  }

  // 擴充功能更新後，這個分頁裡的舊版什麼都連不到：狀態一律顯示「要換新版」，不要誤報成服務沒開
  function setStatus(s) {
    let alive = true;
    try { alive = !!(chrome.runtime && chrome.runtime.id); } catch (e) { alive = false; }
    st.status = alive ? s : '擴充功能已經更新到新版：換一部影片或重新整理（F5）就會用新版。';
    renderStatus();
  }

  function renderAll() {
    renderStatus(); renderCands(); renderTracks(); renderFull(); renderOffset(); renderScene();
    applyNativeHide(); renderLine(true);
  }

  // ---------- 導覽（YouTube 是單頁應用）----------
  // 擴充功能更新（重新載入）後，已經開著的分頁裡還是舊版，舊版連不到背景、也存取不了 chrome.storage
  const extAlive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };

  // ---------- 分級安裝 ----------
  // 安裝程式把等級寫在 ytls-config.json：1 歌詞字幕、2 ＋畫面字幕 OCR、3 ＋雲端 AI 聽寫＋官方伴奏、4 全部（本機 AI 聽寫、AI 去人聲）。
  // 開發機沒有這個檔＝全部都有。沒裝的功能不去連服務，面板上寫「沒安裝：重跑安裝選幾」
  let inst = { tier: 4 };
  const instReady = bg('installInfo', {}).then((r) => { if (r && r.tier) inst = r; }, () => {});
  const HAS = { ocr: () => inst.tier >= 2, listen: () => inst.tier >= 3, local: () => inst.tier >= 4, sep: () => inst.tier >= 4 };
  const notInstalled = (what, tier) => what + '沒有安裝：再雙擊一次「安裝.cmd」，選 ' + tier + ' 以上就有';
  const NO_LOCAL_TEXT = '這個安裝只有雲端 AI 聽寫：點 Edge 工具列的擴充功能圖示，「AI 聽寫」選「雲端」並填 Groq 金鑰';
  // 有沒有開雲端聽寫（擴充功能設定裡選了雲端、金鑰格式對）：只裝雲端聽寫的話，沒開就不能聽寫
  let cloudOn = false;
  const refreshCloudOn = () => chrome.storage.local.get({ listenEngine: 'local', groqKey: '' }).then((c) => {
    cloudOn = c.listenEngine === 'cloud' && /^[A-Za-z0-9_-]{8,200}$/.test(String(c.groqKey || '').replace(/\s+/g, ''));
  }, () => {});
  refreshCloudOn();
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.listenEngine || ch.groqKey)) refreshCloudOn().then(() => renderTracks()); });
  const canListen = () => HAS.listen() && (HAS.local() || cloudOn);
  let orphanReloaded = false;
  function orphanNav() {
    // 一般 YouTube：換到影片頁時直接重新載入這個網址，新版就會接手（本來就在換影片，看起來只是載入久一點）
    if (!IS_YTM && location.pathname === '/watch' && !orphanReloaded) { orphanReloaded = true; location.reload(); return; }
    // YouTube Music 重新載入會打斷正在播的歌：只把舊版的字幕、伴奏、聽寫都收掉，等使用者自己重新整理
    st.token++;
    try { stopListen(); } catch (e) { /* ignore */ }
    try { removeUI(); } catch (e) { /* ignore */ }
    Object.assign(st, { vid: null, info: null, kind: null, cues: [] });
  }

  // 舊版被點到（面板上的按鈕、「詞」）：它已經存不了設定、送不出翻譯，按了只會沒反應。
  // 一般 YouTube 直接在目前秒數重新整理，讓新版接手；關閉鈕照常關。
  function orphanClick(e) {
    if (extAlive() || (e.target.closest && e.target.closest('.ytls-x'))) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (IS_YTM || location.pathname !== '/watch') { setStatus('擴充功能已經更新到新版：重新整理（F5）就會用新版。'); return; }
    const v = video(), u = new URL(location.href);
    if (v && v.currentTime > 1) u.searchParams.set('t', Math.floor(v.currentTime) + 's');
    location.replace(u.href);
  }

  // 面板角落的「↻」：這部影片從頭再來一次（重抓影片資訊、重選來源、重接服務），不用重新整理整個頁面。
  // 畫面字幕、翻譯都存在本機，重來時直接讀回來；正在快速掃描的話先停下來，已掃到的部分會存起來。
  // 擴充功能更新過、這個分頁還是舊版時，點下去會被 orphanClick 接走，改成整頁重新整理。
  let refreshing = false;
  // 正在快速掃描：先停下來、等它把已掃到的存好（同一部影片重來時才讀得到最新的；
  // 不等的話新的狀態先讀到舊存檔，之後邊播邊讀的存檔又把掃到一半的結果蓋回舊的）
  async function stopScan() {
    if (!st.scanning) return;
    st.scanCancel = true;
    for (let i = 0; i < 100 && st.scanning; i++) await sleep(100);
    await sleep(300);
  }

  async function refreshVideo() {
    if (refreshing) return;
    refreshing = true;
    try {
      await stopScan();
      setStatus('重新載入中…');
      st.vid = null;
      await onNav();
    } finally { refreshing = false; }
  }

  let navAt = 0;
  async function onNav() {
    if (!extAlive()) { orphanNav(); return; }
    navAt = Date.now();
    await instReady; // 先知道裝了哪些功能，再決定要不要連服務
    let vid = IS_YTM ? await bridge('vid') : location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
    // YouTube Music：換歌的瞬間、或頁面主執行緒很忙（bridge 逾時）會短暫拿到 null，不要因此把字幕和伴奏整個拆掉，隔一下再問一次
    if (IS_YTM && !vid && st.vid) { await sleep(1500); vid = await bridge('vid'); }
    if (vid === st.vid && st.info) return;
    reset();
    karaStop();
    st.vid = vid;
    if (!vid || !settings.enabled) { removeUI(); return; }
    const token = st.token;
    let info = null;
    for (let i = 0; i < 40 && token === st.token; i++) {
      info = await bridge('info');
      if (info && info.videoId === vid) break;
      info = null;
      await sleep(400);
    }
    if (!info || token !== st.token) return;
    st.info = info;
    // 情境：唱歌／看影片／直播。正在直播的一律是直播；其他自動判斷，或用面板上選過的（每部影片記住）
    const scenePref = (await getPref(vid)).scene;
    if (token !== st.token) return;
    st.sceneAuto = autoScene(info);
    st.scene = info.isLive || IS_YTM ? st.sceneAuto : scenePref === 'song' || scenePref === 'video' ? scenePref : st.sceneAuto;
    st.talk = st.scene !== 'song'; // 看影片、直播：說話內容的排版和來源順序
    ensureUI();
    applySettingsToUI(); // 情境列、字幕位置
    ui.q.value = S.buildQueries(info.title, info.author)[0] || info.title;
    renderTracks();
    const pref = await getPref(vid);
    const savedOcr = (await chrome.storage.local.get('ocr:' + vid))['ocr:' + vid];
    if (token !== st.token) return;
    st.ocr = new YTLSOcr.OcrTracker(savedOcr);
    st.ocrScanned = !!(savedOcr && savedOcr.scanned && savedOcr.cues && savedOcr.cues.length);
    // 快速掃描過的段落（中途停止的）：下次只掃還沒掃的；舊版只記「從頭掃到 scanTo」
    st.ocrRanges = st.ocrScanned || !savedOcr ? [] : mergeRanges(Array.isArray(savedOcr.ranges) ? savedOcr.ranges : Number(savedOcr.scanTo) > 5 ? [[0, Number(savedOcr.scanTo)]] : []);
    st.offset = Number(pref.offset) || 0;
    st.noLift = !!pref.noLift;
    renderOffset();
    st.manual = !!pref.choice; // 使用者自己選過的來源，不會被自動切換
    // 伴奏：等歌詞來源選好（知道歌名、歌手，搜官方伴奏比較準），最多等 8 秒。
    // 這段時間先叫服務下載原影片音訊、載入去人聲模型（兩者都不用知道歌名），開始做伴奏時就省掉這幾秒
    karaPrep(token);
    const kt = setTimeout(() => karaAuto(token), 8000);
    if (pref.choice && (await applyChoice(pref.choice, token))) { clearTimeout(kt); karaAuto(token); return; }
    st.manual = false;
    await autoPick(token);
    clearTimeout(kt); karaAuto(token);
  }

  // 自動判斷情境：超過 12 分鐘（直播回放、節目）、YouTube 分類不是音樂而且標題不像歌，或在小視窗選了「看影片／直播優先」→ 看影片；
  // 選「同步歌詞優先」的一律當唱歌
  function autoScene(info) {
    if (IS_YTM) return 'song';
    if (info.isLive) return 'live';
    const song = S.isSongVideo(info);
    return settings.mode === 'talk' || (info.lengthSeconds || 0) > 12 * 60 || (settings.mode !== 'lyrics' && song === false) ? 'video' : 'song';
  }

  // 面板上切換情境：記在這部影片，來源重新挑（換情境時上次手動選的來源不一定適用）
  async function setScene(scene) {
    if (!st.info || st.info.isLive || IS_YTM || scene === st.scene) return;
    await stopScan();
    await setPref({ scene: scene === st.sceneAuto ? null : scene, choice: null });
    st.vid = null;
    onNav();
  }

  async function applyChoice(choice, token) {
    try {
      if (choice.kind === 'off') { useOff(false); return true; }
      if (choice.kind === 'lrc') {
        const c = await bg('lyricsGet', { id: choice.id });
        if (token !== st.token) return true;
        if (c) { await useLyrics(c, token, false); return true; }
      }
      if (choice.kind === 'yt') {
        const t = st.info.tracks.find((x) => x.vssId === choice.vssId);
        if (t) return await useTrack(t, token, false);
      }
      if (choice.kind === 'desc') return await useDesc(token, false);
      if (choice.kind === 'ytm') {
        const r = await ytmLyricsFor(choice.videoId).catch(() => null);
        if (token !== st.token) return true;
        if (r) { st.ytm = { ...r, viaSearch: choice.videoId !== st.vid }; return await useYtm(token, false); }
      }
      if (choice.kind === 'ocr') return await useOcr(token, false);
      if (choice.kind === 'listen') return await useListen(token, false);
    } catch (e) { console.warn('[ytls] 套用上次選擇失敗', e); }
    return false;
  }

  async function autoPick(token) {
    const tracks = st.info.tracks;
    const asr = tracks.filter((t) => t.kind === 'asr');
    // 影片原本的語言：自動產生的字幕是照「說的語言」做的。原本是英文（等等）的影片，上傳者的日文字幕只是翻譯，
    // 不能當原文用（以前英文歌會顯示日文翻譯的歌詞，再把日文翻成中文）
    const orig = asr.length && !asr.some((t) => /^ja/i.test(t.languageCode)) ? langFam(asr[0].languageCode) : '';
    const isJa = orig ? (t) => langFam(t.languageCode) === orig : (t) => /^ja/i.test(t.languageCode);
    const manual = tracks.filter((t) => t.kind !== 'asr');
    const manualJa = manual.filter(isJa);
    const manualSorted = [...manualJa, ...manual.filter((t) => !isJa(t))];
    const asrSorted = [...asr.filter(isJa), ...asr.filter((t) => !isJa(t))];

    // LRCLIB 只搜一次，分成「長度吻合」與「其他確定的」兩階段使用
    let ranked = null;
    const search = async () => {
      if (ranked) return ranked;
      setStatus('搜尋同步歌詞中…');
      try { ranked = await searchLyrics(S.buildQueries(st.info.title, st.info.author)); } catch (e) { if (token === st.token) setStatus('歌詞搜尋失敗：' + e.message); ranked = []; }
      return ranked;
    };
    const tryLyrics = (exactOnly) => async () => {
      const list = await search();
      if (token !== st.token) return true;
      let best = list.find((c) => c.strong && (!exactOnly || c.durDiff <= 3));
      if (!best && !exactOnly && settings.mode === 'lyrics') best = list.find((c) => c.syncedLyrics && !c.instrumental && c.score >= 60);
      if (best) { await useLyrics(best, token, false); return true; }
      return false;
    };
    const hasPot = () => { const u = captured.get(st.vid); try { return !!(u && new URL(u).searchParams.get('pot')); } catch (e) { return false; } };
    const tryTracks = async (list) => {
      for (const t of list) {
        if (token !== st.token) return true;
        if (await useTrack(t, token, false)) return true;
        // 讀取失敗後才拿到權杖（播放器比較慢）：同一軌馬上再試一次，不要直接換成別的語言
        if (token === st.token && hasPot() && (await useTrack(t, token, false))) return true;
      }
      return false;
    };
    const tryDesc = () => useDesc(token, false, true);
    const tryYtm = () => useYtm(token, false, true, false);        // 這部影片本身在 YouTube Music 的官方歌詞
    const tryYtmSearch = () => useYtm(token, false, true, true);   // 翻唱：搜原曲的官方歌詞
    const tryOcr = () => useOcr(token, false, true);

    // 人工校對過的時間軸最準：上傳者字幕、長度吻合的 LRCLIB 先用；
    // 其次是說明欄歌詞（用自動字幕／畫面 OCR 對時間）；再來是畫面上的歌詞（OCR）；
    // 自動字幕在歌曲上常亂辨識，放最後
    const tryListen = () => useListen(token, false, true);
    let order;
    // 直播回放、節目：歌詞來源都跳過（直播畫面上的聊天室也會被 OCR 讀成雜訊），上傳者字幕 → AI 聽寫 → 自動字幕
    // 歌曲什麼歌詞都找不到：AI 聽寫整首（比自動字幕準很多）；畫面上讀到歌詞時會自動改用 OCR
    // 掃描過畫面歌詞的影片：畫面上的原文比 AI 聽寫準，排在聽寫前面（節目也一樣）
    const scanned = st.ocrScanned && st.ocr && st.ocr.all().length >= 3;
    const listenOrOcr = scanned ? [tryOcr, tryListen] : [tryListen, tryOcr];
    // YouTube Music：官方歌詞最優先（大多有逐句時間）；不做畫面 OCR（多半是專輯封面）
    if (IS_YTM) order = [tryYtm, () => tryTracks(manualJa), tryLyrics(true), tryDesc, tryYtmSearch, tryLyrics(false), tryListen, () => tryTracks(asrSorted)];
    else if (st.talk) order = [() => tryTracks(manualSorted), ...(scanned ? [tryOcr] : []), tryListen, () => tryTracks(asrSorted)];
    else if (settings.mode === 'captions') order = [() => tryTracks(manualSorted), tryYtm, tryLyrics(false), tryDesc, tryYtmSearch, ...listenOrOcr, () => tryTracks(asrSorted)];
    else if (settings.mode === 'lyrics') order = [tryLyrics(true), tryYtm, tryDesc, tryYtmSearch, tryLyrics(false), ...listenOrOcr, () => tryTracks(manualSorted), () => tryTracks(asrSorted)];
    else order = [() => tryTracks(manualJa), tryLyrics(true), tryYtm, tryDesc, tryYtmSearch, tryLyrics(false), () => tryTracks(manualSorted.filter((t) => !isJa(t))), ...listenOrOcr, () => tryTracks(asrSorted)];

    for (const step of order) {
      if (token !== st.token) return;
      if (await step()) return;
    }
    if (token !== st.token) return;
    if (st.talk) {
      // 節目：不去搜歌詞（只會冒出一堆同名的歌）；等 AI 聽寫服務回來會自動接上
      setStatus(!HAS.listen() ? '這部影片沒有字幕。（' + notInstalled('AI 聽寫', 3) + '）'
        : !canListen() ? '這部影片沒有字幕。要 AI 聽寫的話：' + NO_LOCAL_TEXT.replace(/^這個安裝只有雲端 AI 聽寫：/, '')
          : listenOk ? '這部影片沒有字幕。' : '這部影片沒有字幕，AI 聽寫服務也連不上：按面板上的「▶ 啟動本機服務」，開好後會自動接上。');
      return;
    }
    if (!st.candidates.length) { try { await searchLyrics(S.buildQueries(st.info.title, st.info.author)); } catch (e) { /* ignore */ } }
    if (token !== st.token) return; // 再搜一次最多 1 分鐘：途中換了影片，不要蓋掉新影片的狀態
    setStatus('找不到字幕或確定的同步歌詞。點右下「詞」→ 搜尋或從候選清單挑一個。');
  }

  // ---------- 來源：同步歌詞 ----------
  async function searchLyrics(queries) {
    const vid = st.vid;
    const res = await bg('lyricsSearch', { queries });
    if (vid !== st.vid || !st.info) return []; // 搜尋途中換了影片：結果是上一部的
    st.candidates = S.rankCandidates(res, { title: st.info.title, author: st.info.author, duration: st.info.lengthSeconds });
    renderCands();
    return st.candidates;
  }

  async function useLyrics(c, token, save = true) {
    if (save) st.manual = true; // 在面板上手動點的來源：之後不自動切換
    const label = (c.trackName || '?') + ' — ' + (c.artistName || '?');
    const ranked = st.info ? S.rankCandidates([c], { title: st.info.title, author: st.info.author, duration: st.info.lengthSeconds })[0] : c;
    const durDiff = st.info && c.duration ? Math.abs(c.duration - st.info.lengthSeconds) : 0;
    const otherVersion = durDiff > 3 || (st.info && S.isCoverTitle(st.info.title) && !ranked.artistMatch);
    if (c.syncedLyrics && otherVersion) {
      // 長度不同、或這部是翻唱而歌詞是別人唱的版本：時間軸只當參考，用這部影片的自動字幕＋畫面歌詞重新對時
      const cues = S.parseLrc(c.syncedLyrics).filter((x) => x.text);
      const lines = cues.map((x) => x.text);
      st.choice = { kind: 'lrc', id: c.id };
      st.manual = save;
      if (!st.candidates.some((x) => x.id === c.id)) st.candidates.unshift({ ...c, score: 0 });
      if (save) await setPref({ choice: st.choice });
      await usePlainLines(lines, label + '（依本影片重新對時）', token, false, cues.map((x) => x.start));
      renderCands();
      return;
    }
    if (c.syncedLyrics) {
      const cues = S.parseLrc(c.syncedLyrics);
      setCues(cues, 'lrc', label);
    } else if (c.plainLyrics) {
      // 沒有時間軸：拿影片的自動字幕來對時間
      const raw = c.plainLyrics.split(/\r?\n/).map((l) => l.trim());
      const lines = [], para = [];
      raw.forEach((l, i) => { if (l) { para.push(!lines.length || !raw[i - 1]); lines.push(l); } });
      lines.para = para;
      st.choice = { kind: 'lrc', id: c.id };
      if (save) await setPref({ choice: st.choice });
      await usePlainLines(lines, label + '（自動對時）', token);
      renderCands();
      return;
    } else { setStatus('這筆沒有歌詞內容。'); return; }
    st.choice = { kind: 'lrc', id: c.id };
    if (!st.candidates.some((x) => x.id === c.id)) st.candidates.unshift({ ...c, score: 0 });
    renderCands();
    if (save) await setPref({ choice: st.choice });
    await translateCues(token);
  }

  // ---------- 來源：YouTube 字幕軌 ----------
  async function fetchText(url) {
    try { const r = await fetch(url, { credentials: 'include' }); return r.ok ? await r.text() : ''; } catch (e) { return ''; }
  }

  async function getPotUrl(track) {
    const vid = st.vid; // 最多等 14 秒：途中換了影片就停，不要去開／關新影片的字幕，也不要拿新影片的 pot 給舊影片用
    const have = captured.get(vid);
    if (have && new URL(have).searchParams.get('pot')) return have;
    const wasOn = st.info.captionsOn;
    // 播放器剛載入、還在廣告或緩衝時，開字幕不一定馬上發出請求：6 秒沒等到就再開一次、多等 8 秒。
    // 以前只等一次，日文軌就被當成「讀取失敗」，改用排在後面的其他語言（實測選到韓文）
    let url = null;
    for (const ms of [6000, 8000]) {
      if (vid !== st.vid) return null;
      const wait = waitCaptured(vid, ms);
      await bridge('enableTrack', { languageCode: track.languageCode, kind: track.kind });
      url = await wait;
      if (url) break;
    }
    if (vid !== st.vid) return null;
    if (!wasOn) await bridge('disableCaptions');
    const got = url || captured.get(vid);
    return got && new URL(got).searchParams.get('pot') ? got : null;
  }

  // ---------- 顯示卡讓給別的程式（遊戲、ComfyUI 算圖）----------
  // 本機服務偵測到別的程式要用顯示卡時會先讓：卸掉模型、暫停工作，對方用完自動繼續。
  // 這裡記下「讓給誰」：狀態列說明、面板多一顆「這次照用」（硬用，對方可能會變慢）
  const gpuYield = { name: '', at: 0, overrideAt: 0, timer: null };
  function noteYield(name) {
    if (!name) return;
    // 剛按「這次照用」：按之前就送出去的進度查詢還會帶著「讓出中」回來，不要又把按鈕叫回來
    if (Date.now() - gpuYield.overrideAt < 5000) return;
    const was = yieldNow();  // 上一輪的名字可能還留著（過期了），要當成新的一輪重畫面板
    gpuYield.name = name; gpuYield.at = Date.now();
    if (!was) renderTracks();
    // 15 秒沒再聽到「讓出中」就算結束：重畫面板，把標籤和「這次照用」拿掉（不然要等別的事情觸發重畫）
    clearTimeout(gpuYield.timer);
    gpuYield.timer = setTimeout(() => { if (!yieldNow()) renderTracks(); }, 15500);
  }
  const yieldNow = () => (gpuYield.name && Date.now() - gpuYield.at < 15000 ? gpuYield.name : '');
  const yieldText = (name) => '顯示卡讓給 ' + name + ' 中，它用完會自動繼續（急的話到「來源」分頁按「這次照用」）';
  async function overrideYield() {
    try { await bg('gpuOverride', {}); } catch (e) { /* 服務沒開就算了 */ }
    gpuYield.name = ''; gpuYield.overrideAt = Date.now(); ocrBusyUntil = 0;
    renderTracks();
    setStatus('好，這次照用顯示卡（另一個程式可能會變慢一點）');
  }
  class GpuYieldError extends Error {
    constructor(name) { super('顯示卡讓給 ' + name); this.gpuYield = name; }
  }

  // ---------- 來源：AI 聽寫（本機 faster-whisper 服務，給直播回放、節目這類沒字幕的影片）----------
  // 回放：服務下載音訊從目前位置往後聽寫，邊做邊回傳；直播中：抓正在播的聲音，每幾秒送一段
  let listenPingAt = 0, listenOk = null, listenDown = false;
  async function pingListen(force) {
    await instReady;
    if (!HAS.listen()) { listenOk = false; return false; } // 沒裝 AI 聽寫服務：不用去連
    if (!force && Date.now() - listenPingAt < 20000) return listenOk;
    listenPingAt = Date.now();
    const wasDown = listenDown;
    try { listenOk = await bg('listenPing', {}); } catch (e) { listenOk = null; }
    listenDown = !listenOk;
    if (listenOk && listenOk.gpuYield && listenOk.gpuYield.yield && !listenOk.gpuYield.override) noteYield(listenOk.gpuYield.yield);
    renderTracks();
    // 之前確定連不上、所以退回自動字幕的節目：服務回來了就自動改用 AI 聽寫（第一次確認連線時不算）
    if (wasDown && listenOk && st.info && st.talk && !st.manual && (st.kind === null || (st.kind === 'yt' && st.isAsr))) useListen(st.token, false, true);
    return listenOk;
  }

  // 面板「▶ 啟動本機服務」：請 Edge 原生訊息小幫手啟動工作排程器裡的 OCR／AI 聽寫服務，等它們回應後重新挑來源
  let starting = false;
  async function startLocalServices() {
    if (starting) return;
    starting = true; renderTracks();
    const token = st.token;
    try {
      setStatus('正在啟動本機服務…');
      const r = await bg('startServices', { which: [...(HAS.ocr() ? ['ocr'] : []), ...(HAS.listen() ? ['listen'] : [])] });
      if (!r || !r.ok) {
        setStatus(r && r.notInstalled
          ? '啟動按鈕還沒註冊：請雙擊 native-host 資料夾裡的 install.cmd，再到 edge://extensions 重新載入擴充功能。'
          : '啟動失敗：' + ((r && r.error) || '沒有回應') + '（也可以雙擊 ocr-server／listen-server 裡的啟動檔）');
        return;
      }
      for (let i = 0; i < 30 && token === st.token; i++) {
        await sleep(1000);
        const [o, l] = await Promise.all([pingOcr(true), pingListen(true)]);
        if ((o || !HAS.ocr()) && (l || !HAS.listen())) break;
      }
      if (token !== st.token) return;
      setStatus((ocrOk || !HAS.ocr()) && (listenOk || !HAS.listen()) ? '本機服務都已啟動。' : '服務啟動中，模型第一次用到時才載入；稍後再試一次。');
      if (!st.manual) await autoPick(token);
    } finally { starting = false; renderTracks(); }
  }

  // gen：每次停止／重新開始就 +1，舊的輪詢看到不一樣就自己結束（避免同一句被加好幾次）
  const listen = { timer: null, since: 0, audio: null, busy: false, gen: 0, spans: [], stats: { sent: 0, dropped: 0, ok: 0, segs: 0, err: 0, ms: 0 } };
  // 雲端聽寫（擴充功能選項）：狀態列標出這次用的是雲端，或為什麼改回本機（服務回傳 engine／cloudNote）
  const engTag = (j) => (j && j.engine === 'cloud' ? '（雲端）' : '');
  const cloudNote = (j) => (j && j.cloudNote ? '；' + j.cloudNote : '');
  function stopListen() {
    listen.gen++;
    clearTimeout(listen.timer); listen.timer = null; listen.since = 0; listen.spans = []; listen.members = false; listen.runningText = null; listen.eng = null;
    clearTimeout(capSaveTimer); // spans 已經清空：還沒存的那次不要存（會存成「什麼都沒聽寫過」）
    stopCapture();
  }
  // 只拆掉擷取聲音的部分（AudioContext、監聽器），聽寫狀態留著
  function stopCapture() {
    if (listen.audio) {
      try { listen.audio.proc.disconnect(); listen.audio.src.disconnect(); if (listen.audio.ctx.state !== 'closed') listen.audio.ctx.close().catch(() => {}); } catch (e) { /* ignore */ }
      listen.audio = null;
    }
    for (const off of listen.cleanup || []) { try { off(); } catch (e) { /* ignore */ } }
    listen.cleanup = null;
  }

  async function useListen(token, save = true, auto = false) {
    if (save) st.manual = true;
    if (!HAS.listen()) { if (!auto) setStatus(notInstalled('AI 聽寫', 3)); return false; }
    if (!canListen()) { await refreshCloudOn(); if (!canListen()) { if (!auto) setStatus(NO_LOCAL_TEXT); return false; } }
    const ok = await pingListen(true);
    if (token !== st.token) return true;
    if (!ok) { if (!auto) setStatus('AI 聽寫服務連不上：按面板上的「▶ 啟動本機服務」，或雙擊 listen-server 裡的「啟動聽寫服務.cmd」。'); return false; }
    stopListen();
    const song = !st.talk && !st.info.isLive;
    setCues([], 'listen', song ? 'AI 聽寫（歌曲）' : 'AI 聽寫（Whisper）');
    st.choice = { kind: 'listen' };
    renderTracks();
    if (save) await setPref({ choice: st.choice });
    if (song) {
      // 歌曲：整首聽寫；之前為了對時已經聽寫好的部分直接拿來用
      const job = startSongListen(token);
      songListenStatus(job);
      await addListenSegments(job.segs.slice(), token);
      songListenStatus(job);
    } else if (st.info.isLive) startLive(token);
    else await startVod(token);
    return true;
  }

  // 歌曲的 AI 聽寫：整首一次做（關掉靜音過濾），結果同時用在
  // ①「AI 聽寫（歌曲）」來源（什麼歌詞都找不到時）②說明欄／YT Music 歌詞的對時依據（比自動字幕準）
  function startSongListen(token) {
    // 同一部影片已經在做（或做好了）就共用；上次失敗的（例如剛好逾時）重新來過，不要一直顯示同一個錯誤
    if (st.songJob && st.songJob.token === token && st.songJob.state !== 'error') return st.songJob;
    const job = st.songJob = { token, segs: [], since: 0, state: 'starting', progress: 0, done: false, error: '' };
    const vid = st.vid;
    job.promise = (async () => {
      const start = async () => {
        const r = await bg('listenVodStart', { videoId: vid, from: 0, song: true });
        if (!r || !r.ok) throw new Error((r && r.error) || 'AI 聽寫服務沒有回應');
      };
      try { await start(); }
      catch (e) { job.state = 'error'; job.error = e.message; songListenStatus(job); return null; }
      let restarts = 0;
      while (token === st.token) {
        let j = null;
        try { j = await bg('listenVodStatus', { videoId: vid, since: job.since, song: true }); } catch (e) { /* 下次再問 */ }
        if (token !== st.token) return null;
        // 服務重開過，工作不見了（404）／被取消：重新開始（最多 2 次），已經拿到的句子不重複加
        if (j && (j.state === 'none' || (j.state === 'error' && /已取消/.test(j.error || ''))) && restarts < 2) {
          restarts++;
          try { await start(); } catch (e) { job.state = 'error'; job.error = e.message; songListenStatus(job); return null; }
          job.since = 0; job.segs.length = 0;
          await sleep(1000);
          continue;
        }
        if (j && j.state === 'none') { // 重新開始 2 次後工作還是一直不見（服務一直重開）：停下來，不要永遠顯示「聽寫中」
          job.state = 'error'; job.error = j.error || '服務一直重開'; songListenStatus(job); return null;
        }
        if (j && j.ok) {
          const segs = j.segments || [];
          job.since = j.total; job.state = j.state; job.progress = j.progress || 0; job.paused = j.paused || '';
          job.engine = j.engine; job.cloudNote = j.cloudNote || '';
          if (j.paused) noteYield(j.paused);
          job.segs.push(...segs);
          if (st.kind === 'listen' && segs.length) await addListenSegments(segs, token);
          if (j.state === 'done') job.done = true;
          if (j.state === 'error') job.error = j.error || '失敗';
          songListenStatus(job);
          if (j.state === 'done') return job.segs;
          if (j.state === 'error') {
            // 下載不了（會員限定、地區限制…）：自動選的話改用畫面歌詞，再不行用自動字幕
            if (st.kind === 'listen' && !st.manual && !st.talk) {
              if (!(await useOcr(token, false, true))) {
                const asr = st.info.tracks.filter((x) => x.kind === 'asr');
                const tr = asr.find((x) => /^ja/i.test(x.languageCode)) || asr[0];
                if (tr) await useTrack(tr, token, false);
              }
            }
            return null;
          }
        }
        await sleep(2000);
      }
      return null;
    })();
    return job;
  }

  function songListenStatus(job) {
    if (st.kind !== 'listen' || st.talk || job !== st.songJob) return;
    if (job.state === 'error') setStatus('AI 聽寫失敗：' + job.error);
    else if (job.done) setStatus('使用中：AI 聽寫（歌曲）' + engTag(job) + '　共 ' + st.cues.length + ' 句；聽寫可能有錯字，畫面上有歌詞時會自動改用 OCR（下次打開直接有）' + cloudNote(job));
    else if (job.state === 'transcribing' && job.paused) setStatus('使用中：AI 聽寫（歌曲）　暫停：' + yieldText(job.paused) + cloudNote(job));
    else if (job.state === 'transcribing') setStatus('使用中：AI 聽寫（歌曲）' + engTag(job) + '　聽寫中…（一首約 10 秒）' + cloudNote(job));
    else setStatus('使用中：AI 聽寫（歌曲）　下載音訊中…（只抓聲音，聽寫完會自動刪掉）');
  }

  // 說明欄／YT Music 歌詞先用自動字幕對時；AI 聽寫服務有開就在背景整首聽寫，好了再用它重新對時
  const LISTEN_WAIT = '；AI 聽寫中，好了會自動重新對時';
  async function refineWithListen(token) {
    if (st.talk || (st.info && st.info.isLive) || !canListen()) return; // 沒裝 AI 聽寫、或只裝雲端卻沒開：用自動字幕／畫面歌詞對時就好
    // 這部影片的聽寫已經失敗過（會員限定、下載不了…）：不要每次用畫面歌詞重新對時就重開一次下載（每 15 秒一次、一直失敗）。
    // 要重試的話使用者自己選「AI 聽寫（歌曲）」
    if (st.songJob && st.songJob.token === token && st.songJob.state === 'error') return;
    // 已經有人在等這個聽寫工作（之前選的說明欄歌詞）就不用再等一次；工作是「AI 聽寫（歌曲）」來源開的話沒人在等，要接手
    const j0 = st.songJob && st.songJob.token === token ? st.songJob : null;
    if (j0 && j0.refining) return;
    if (!j0) {
      if (!(await pingListen())) return;
      if (token !== st.token) return;
    }
    const job = startSongListen(token);
    if (job.refining) return;
    job.refining = true;
    const segs = await job.promise;
    // 聽寫失敗（會員限定、下載不了…）：狀態列上的「AI 聽寫中，好了會自動重新對時」換成原因（以前一直寫在那裡）
    if (!segs && token === st.token && job.state === 'error' && st.status.includes(LISTEN_WAIT)) {
      setStatus(st.status.replace(LISTEN_WAIT, '；AI 聽寫沒辦法用（' + job.error + '），不會再自動重新對時'));
    }
    if (!segs || token !== st.token || !st.aligned || (st.kind !== 'lrc' && st.kind !== 'plain')) return;
    await usePlainLines(st.aligned.lines, st.aligned.label, token, true, st.aligned.prior);
  }

  // 新聽寫出來的句子加進字幕並翻譯（舊的保留翻譯結果）
  async function addListenSegments(segs, token, joinEdge = false) {
    if (!segs.length) return;
    // Whisper 偶爾也會吐出簡體字，用和 OCR 一樣的字表換回日文漢字（只換日文裡沒有的字）
    const fixK = (t) => (globalThis.YTLSKanji ? globalThis.YTLSKanji.fixKanji(t) : t);
    let add = segs.map((x) => ({ start: x.start, end: x.end, text: fixK(x.text) }));
    // 回放工作重新開始（服務重開過）時會從頭再拿一次：已經有的句子不要重複加
    // 同樣文字（去掉空白標點）、開始時間差 2 秒內就算同一句
    if (!joinEdge && st.cues.length) {
      const norm = (t) => String(t).replace(/[\s、。！？!?,.・…ー〜~]/g, '');
      const have = new Map();
      for (const c of st.cues) { const k = norm(c.text); (have.get(k) || have.set(k, []).get(k)).push(c.start); }
      add = add.filter((c) => !(have.get(norm(c.text)) || []).some((t) => Math.abs(t - c.start) < 2000));
      if (!add.length) return;
    }
    // 直播：每 6 秒錄一段送去聽寫，結果回來時那段話已經播完了，照原本時間會一句都顯示不出來。
    // 改成「回來就顯示」：整批往後移到現在，句子之間的間隔不變，每句多留 1.5 秒
    // 回放（會員限定等下載不了、只能邊播邊聽寫）：另外記住真正的時間（rs/re），
    // 倒帶、拖進度條之後改用真正的時間（聽過的部分就對準了），也存起來，下次打開直接對準
    if (joinEdge) {
      const v = video();
      const now = v ? v.currentTime * 1000 - st.offset : 0;
      const delay = Math.max(0, now - add[0].start);
      for (const c of add) {
        if (!st.info.isLive) { c.rs = c.start; c.re = c.end; }
        c.start += delay; c.end = Math.max(c.end + delay, c.start + 1200) + 1500;
      }
    }
    // 直播是每 6 秒切一段送去聽寫，句子常在切點被切斷：
    // 上一段最後一句跟這段第一句時間接得上、而且其中一句很短，就接回同一句（重新翻譯）
    if (joinEdge && st.cues.length) {
      const last = st.cues[st.cues.length - 1], first = add[0];
      const short = (t) => [...String(t).replace(/\s/g, '')].length <= 8;
      // 要真的是前一段的結尾：回放用真正的時間比（切點前後 1 秒內）；直播只有移過的時間，前一句結尾多留了 1.5 秒，
      // 所以可以重疊幾秒。以前沒有下限：回放倒帶到前面時會跟 30 分鐘後的句子接在一起（開始時間比結束晚，那句永遠不顯示）
      const real = first.rs !== undefined && last.rs !== undefined;
      const gap = real ? first.rs - last.re : first.start - last.end;
      if (gap >= (real ? -1000 : -4000) && gap <= 600 && (short(last.text) || short(first.text)) && !/[。！？!?]$/.test(last.text)) {
        st.cues.pop();
        add[0] = { start: last.start, end: first.end, text: last.text + first.text };
        if (first.rs !== undefined) { add[0].rs = last.rs !== undefined ? last.rs : last.start; add[0].re = first.re; }
      }
    }
    st.cues = st.cues.concat(add).sort((a, b) => a.start - b.start);
    st.nz = null; st.ktvKey = null;
    renderLine(true); renderFull();
    // 一次拿到很多句（回放聽寫的快取：3 小時約 4000 句）時，從正在看的位置往後先翻、再翻前面，
    // 每翻好一批就更新畫面；某一批失敗重試一次，還是不行就跳過，不連累後面（以前從頭依序翻，看到後段要等很久，一批出錯後面全沒中文）
    let order = add;
    if (add.length > 40) {
      const v = video();
      const now = v ? v.currentTime * 1000 - st.offset - 10000 : 0;
      const key = (c) => (c.start >= now ? c.start - now : 1e13 + (now - c.start));
      order = [...add].sort((a, b) => key(a) - key(b));
    }
    const missed = [];
    for (let i = 0; i < order.length; i += 40) {
      const part = order.slice(i, i + 40);
      let res = null;
      for (let tries = 0; tries < 2 && !res; tries++) {
        try { res = await bg('translate', { lines: part.map((c) => c.text), tl: settings.targetLang, romaji: true, vid: st.vid }); }
        catch (e) { if (/擴充功能已更新/.test(e.message)) return; await sleep(1500); }
        if (token !== st.token) return;
      }
      if (!res) { missed.push(...part); continue; } // 翻譯失敗不影響原文
      if (res.error) missed.push(...part); // 假名有了，翻譯稍後補
      part.forEach((c, k) => applyTr(c, res, k));
      if (!st.srcLang && res.lang) st.srcLang = res.lang;
      if (order.length > 40) renderLine(true);
    }
    if (missed.length) setTimeout(() => { const rest = missed.filter((c) => !c.tr); if (rest.length) translateList(rest, token); }, 30000);
    renderLine(true); renderFull();
    if (joinEdge && !st.info.isLive && st.kind === 'listen') saveCaptured();
  }

  // ---------- 回放邊播邊聽寫的結果：存在 chrome.storage.local（listen:<影片ID>），只存原文＋真正的時間 ----------
  // spans：已經聽寫過的時間範圍（毫秒），下次打開這些範圍不用再送去聽寫
  let capSaveTimer = null;
  function saveCaptured() {
    clearTimeout(capSaveTimer);
    const vid = st.vid, token = st.token;
    capSaveTimer = setTimeout(() => {
      // 1.5 秒內換了來源（改用字幕軌、OCR）或重新整理：這時的 st.cues 不是聽寫結果，存下去會蓋掉真正的聽寫紀錄
      if (vid !== st.vid || token !== st.token || st.kind !== 'listen') return;
      const cues = st.cues.map((c) => ({ start: c.rs !== undefined ? c.rs : c.start, end: c.re !== undefined ? c.re : c.end, text: c.text }));
      chrome.storage.local.set({ ['listen:' + vid]: { cues, spans: listen.spans, t: Date.now() } }).catch(() => {});
    }, 1500);
  }
  function addSpan(a, b) {
    const sp = listen.spans.concat([[a, b]]).sort((x, y) => x[0] - y[0]), out = [];
    for (const r of sp) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1] + 1000) last[1] = Math.max(last[1], r[1]); else out.push([r[0], r[1]]);
    }
    listen.spans = out;
  }
  const covered = (a, b) => listen.spans.some((r) => r[0] <= a + 500 && r[1] >= b - 500);
  async function loadCaptured(token) {
    const k = 'listen:' + st.vid;
    const saved = (await chrome.storage.local.get(k))[k];
    if (token !== st.token || !saved || !saved.cues || !saved.cues.length) return 0;
    listen.spans = saved.spans || [];
    await addListenSegments(saved.cues, token);
    return saved.cues.length;
  }
  // 拖進度條／倒帶後：把「回來就顯示」的句子改回真正的時間
  function restoreRealTimes() {
    let n = 0;
    for (const c of st.cues) if (c.rs !== undefined) { c.start = c.rs; c.end = c.re; delete c.rs; delete c.re; n++; }
    if (!n) return;
    st.cues.sort((a, b) => a.start - b.start);
    st.nz = null; st.ktvKey = null;
    renderLine(true); renderFull();
  }

  // ---------- 真‧卡拉 OK 伴奏 ----------
  // 本機服務（listen-server/kara.py）先找 YouTube 上的官方伴奏，跟這部影片的聲音比對（同一份配樂才用、算出每段偏移，
  // MV 有剪接也行）；找不到就用 AI 把這部影片的人聲去掉。這裡負責：把伴奏跟影片同步播放，
  // 對上的段落把影片音量關小成「導唱音量」（直接改 video.volume，不動 YouTube 自己記住的音量），沒對上的段落播原聲。
  const kara = { vid: null, gen: 0, state: '', detail: '', result: null, audio: null, url: null, segs: [], timer: null,
    base: null, lastSet: null, blocked: false, blockedAt: 0, hooked: null, key: 0, keyWant: 0, keyBusy: false, keyErr: '', keyTimer: null };
  // hook.js（頁面主世界）攔截 video.volume：設了 data-ytls-gain 的影片，YouTube 自己設音量時直接乘上這個比例，
  // 不會先用原音量播一瞬間才被改回來（之前 YouTube 偶爾重設音量，會漏出不到 0.3 秒的原唱）
  const volHooked = () => document.documentElement.dataset.ytlsVolHook === '1';
  // 放開影片音量：還原成 YouTube 想要的音量，拿掉比例
  function karaRelease(v) {
    if (!v || v.dataset.ytlsGain == null) return;
    const want = Number(v.dataset.ytlsWant);
    delete v.dataset.ytlsGain; delete v.dataset.ytlsWant;
    if (Number.isFinite(want) && Math.abs(v.volume - want) > 1e-6) v.volume = want;
  }
  const fmtKey = (k) => (k > 0 ? '+' + k : k < 0 ? '−' + -k : '原調');
  if (location.hostname === 'localhost') window.__ytlsKara = kara; // 測試頁量同步用

  function karaMeta() {
    const info = st.info || {};
    const cover = S.isCoverTitle(info.title);
    const c = st.choice && st.choice.kind === 'lrc' && (st.candidates || []).find((x) => x.id === st.choice.id);
    if (c && c.trackName) return { song: c.trackName, artist: c.artistName || (cover ? '' : S.cleanAuthor(info.author)) };
    if (IS_YTM) return { song: info.title || '', artist: S.cleanAuthor(info.author) };
    const t = String(info.title || '').normalize('NFKC');
    const q = t.match(/[「『“"](.+?)[」』”"]/);
    // 翻唱：頻道名是翻唱者，不拿來過濾官方伴奏
    if (q) return { song: q[1].trim(), artist: cover ? '' : S.cleanAuthor(info.author) };
    return { song: '', artist: '' };
  }

  function karaAuto(token) {
    if (!HAS.listen() || !settings.kara || token !== st.token || kara.vid === st.vid || !st.info || st.info.isLive || st.talk) return;
    karaStart();
  }

  function karaPrep(token) {
    const info = st.info;
    if (!HAS.listen() || !settings.kara || token !== st.token || !info || info.isLive || st.talk || !(info.lengthSeconds > 0 && info.lengthSeconds <= 900)) return;
    bg('karaPrep', { videoId: st.vid }).catch(() => {});
  }

  function karaStop() {
    kara.gen++;
    clearInterval(kara.timer);
    clearTimeout(kara.keyTimer);
    const v = video();
    if (v && v.dataset.ytlsGain != null) karaRelease(v);
    else if (v && kara.base !== null && kara.lastSet !== null && Math.abs(v.volume - kara.lastSet) < 1e-6) v.volume = kara.base; // 還原影片音量
    if (kara.hooked && kara.hooked !== v) karaRelease(kara.hooked);
    if (kara.audio) { try { kara.audio.pause(); kara.audio.removeAttribute('src'); kara.audio.load(); } catch (e) { /* ignore */ } }
    if (kara.url) URL.revokeObjectURL(kara.url);
    Object.assign(kara, { vid: null, state: '', detail: '', result: null, audio: null, url: null, segs: [], timer: null, base: null, lastSet: null,
      blocked: false, blockedAt: 0, key: 0, keyWant: 0, keyBusy: false, keyErr: '', keyTimer: null });
    renderKara();
  }

  async function karaStart(force = false, mode = 'auto') {
    if (!st.vid || !st.info) return;
    karaStop();
    if (!HAS.listen()) { kara.state = 'error'; kara.detail = notInstalled('伴奏', 3); renderKara(); return; }
    if (mode === 'ai' && !HAS.sep()) { kara.state = 'error'; kara.detail = notInstalled('AI 去人聲', 4); renderKara(); return; }
    if (st.info.isLive) { kara.state = 'error'; kara.detail = '直播中沒辦法做伴奏（要整首下載才能比對、去人聲）'; renderKara(); return; }
    const gen = kara.gen, vid = st.vid;
    const alive = () => gen === kara.gen && vid === st.vid;
    const fail = (msg) => { if (alive()) { kara.state = 'error'; kara.detail = msg; renderKara(); } };
    kara.vid = vid; kara.state = 'starting'; kara.detail = '連線本機服務'; renderKara();
    // 服務忙（例如正在變調、去人聲）時偶爾 4 秒內來不及回：多試幾次再說沒開
    let up = await pingListen(true);
    for (let i = 1; !up && i <= 3 && alive(); i++) {
      kara.detail = '連線本機服務（再試 ' + i + '）'; renderKara();
      await sleep(2000);
      up = await pingListen(true);
    }
    if (!up) return fail('伴奏是本機 AI 聽寫服務做的，它現在沒開：到「來源」分頁按「▶ 啟動本機服務」');
    if (!alive()) return;
    let j;
    const body = { videoId: vid, ...karaMeta(), queries: S.buildQueries(st.info.title, st.info.author).slice(0, 2), len: st.info.lengthSeconds, mode, force };
    try { j = await bg('karaStart', body); } catch (e) { return fail(e.message); }
    let restarts = 0, misses = 0;
    for (;;) {
      if (!alive()) return;
      // 服務重開過（工作不見了：none）：自動重新開始（最多 2 次），不要一直停在「準備中」。
      // 指定了「AI 去人聲」之類的種類，但服務重開後回報的是快取裡另一種：也重新做。
      // 被取消（「已取消」）是別的分頁開了新的伴奏工作（服務一次只做一首）：不要自動搶回來，兩邊會一直互相取消
      const wrongKind = j && j.ok && j.state === 'done' && mode !== 'auto' && j.result && j.result.kind !== mode;
      const lost = j && j.ok && (j.state === 'none' || wrongKind);
      if (lost && restarts < 2) {
        restarts++;
        try { j = await bg('karaStart', { ...body, force: !!wrongKind }); } catch (e) { return fail(e.message); }
        continue;
      }
      if (j && j.ok && j.state === 'error' && /已取消/.test(j.error || '')) {
        return fail('另一個分頁正在做伴奏（一次只能做一首），這首先停了；要這首就按「重新找伴奏」');
      }
      if (!j) { if (++misses >= 8) break; } else { misses = 0; if (!j.ok || j.state === 'done' || j.state === 'error' || j.state === 'none') break; }
      if (j) { kara.state = j.state; kara.detail = j.detail || ''; if (j.gpuYield) noteYield(j.gpuYield); renderKara(); }
      await sleep(1500);
      try { j = await bg('karaStatus', { videoId: vid }); } catch (e) { j = null; }
    }
    if (!alive()) return;
    if (!j || !j.ok || j.state !== 'done') return fail((j && j.error) || (j && j.state === 'none' ? '本機服務重開過，伴奏工作不見了：按「重新找伴奏」' : '本機服務沒有回應'));
    kara.state = 'loading'; kara.detail = '載入伴奏'; renderKara();
    // 這首歌上次調過 Key：直接載變調版（第一次做約 10 秒，之後有快取）
    let key = Number((await getPref(vid)).karaKey) || 0;
    if (!alive()) return;
    if (key) {
      kara.detail = '伴奏變調 ' + fmtKey(key) + '（第一次約 5～10 秒）'; renderKara();
      try { await bg('karaKey', { videoId: vid, key }); } catch (e) { key = 0; }
      if (!alive()) return;
    }
    let got;
    try { got = await karaLoad(vid, key, alive); } catch (e) { return fail(e.message); }
    if (!got) return;
    kara.url = got.url; kara.audio = got.a; kara.key = kara.keyWant = key;
    kara.result = j.result; kara.segs = j.result.segments || [];
    kara.state = 'on'; kara.detail = '';
    karaHookVideo();
    kara.timer = setInterval(karaTick, 100);
    karaTick(); renderKara();
  }

  // 分段從本機服務拿伴奏音檔（key ≠ 0：變調版），組成 Blob 給 <audio> 播
  async function karaLoad(vid, key, alive) {
    const parts = [];
    let start = 0, total = 1, type = 'audio/webm';
    while (start < total) {
      const r = await bg('karaAudio', { videoId: vid, key, start, len: 4 << 20 }); // 本機傳輸，一次 4MB（服務的上限），一首 2 次就好
      if (!alive()) return null;
      total = r.total; type = r.type;
      const bin = atob(r.data);
      if (!bin.length) break;
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      parts.push(u8); start += u8.length;
    }
    const url = URL.createObjectURL(new Blob(parts, { type }));
    const a = new Audio(url);
    a.preservesPitch = true; a.preload = 'auto';
    return { a, url };
  }

  // 升降 Key：連按時等停下來 0.35 秒才做；做好後新的伴奏跳到目前位置接手
  function karaSetKey(k) {
    if (kara.state !== 'on') return;
    kara.keyWant = Math.max(-12, Math.min(12, k));
    kara.keyErr = '';
    renderKara();
    clearTimeout(kara.keyTimer);
    kara.keyTimer = setTimeout(karaApplyKey, 350);
  }

  async function karaApplyKey() {
    if (kara.state !== 'on' || kara.keyBusy || kara.keyWant === kara.key) return;
    const k = kara.keyWant, gen = kara.gen, vid = kara.vid;
    const alive = () => gen === kara.gen && vid === st.vid && kara.state === 'on';
    kara.keyBusy = true; renderKara();
    try {
      await bg('karaKey', { videoId: vid, key: k });
      if (!alive()) return;
      const got = await karaLoad(vid, k, alive);
      if (!got) return;
      await new Promise((res) => { got.a.addEventListener('loadedmetadata', res, { once: true }); setTimeout(res, 3000); });
      if (!alive()) { URL.revokeObjectURL(got.url); return; }
      const old = kara.audio, oldUrl = kara.url;
      kara.audio = got.a; kara.url = got.url; kara.key = k;
      try { old.pause(); old.removeAttribute('src'); old.load(); } catch (e) { /* ignore */ }
      URL.revokeObjectURL(oldUrl);
      karaTick();
      setPref({ karaKey: k });
    } catch (e) {
      kara.keyErr = e.message; kara.keyWant = kara.key;
    } finally {
      if (gen === kara.gen) {
        kara.keyBusy = false; renderKara();
        if (alive() && kara.keyWant !== kara.key && !kara.keyErr) karaApplyKey();
      }
    }
  }

  // 影片元素的事件：拖進度條、暫停、變速時馬上同步；YouTube 自己改音量（使用者拉音量條、換影片）時記下新的基準音量
  function karaHookVideo() {
    const v = video();
    if (!v || kara.hooked === v) return;
    if (kara.hooked) karaRelease(kara.hooked);
    kara.hooked = v;
    for (const ev of ['seeking', 'seeked', 'play', 'pause', 'ratechange', 'waiting', 'playing']) v.addEventListener(ev, () => karaTick());
    v.addEventListener('volumechange', () => {
      if (!kara.audio) return;
      // 有主世界攔截時，YouTube 想要的音量在 data-ytls-want（karaTick 會讀）
      if (v.dataset.ytlsGain == null && (kara.lastSet === null || Math.abs(v.volume - kara.lastSet) > 1e-6)) kara.base = v.volume;
      karaTick();
    });
    if (!kara.gestureHooked) {
      kara.gestureHooked = true;
      const unblock = () => { if (kara.blocked) { kara.blocked = false; karaTick(); } };
      document.addEventListener('pointerdown', unblock, true);
      document.addEventListener('keydown', unblock, true);
    }
  }

  function karaTick() {
    const v = video(), a = kara.audio;
    if (!v || !a) return;
    // 換歌了（YouTube Music 的下一首要等每秒一次的檢查才換頁）：網址上的影片已經不是這首，伴奏馬上停，
    // 不然新歌會被當成這首消音、播上一首伴奏的開頭
    const urlVid = new URLSearchParams(location.search).get('v');
    if (urlVid && kara.vid && urlVid !== kara.vid) { karaStop(); return; }
    if (kara.hooked !== v) karaHookVideo(); // YouTube 換了影片元素
    if (kara.base === null) kara.base = v.volume;
    const p = player();
    const ad = !!(p && p.classList.contains('ad-showing'));
    const vt = v.currentTime;
    const seg = ad ? null : kara.segs.find((s) => vt >= s[0] && vt < s[1]);
    const at = seg ? vt - seg[2] : -1;
    const inRange = !!seg && at >= 0 && (!a.duration || at < a.duration - 0.05);
    // 音量：伴奏跟著 YouTube 的音量和靜音；對上的段落把影片關小成導唱音量（伴奏放不出來時不關，免得完全沒聲音）
    // 變調時原唱的音高對不上伴奏：導唱一律關掉
    const gain = inRange && !kara.blocked ? (kara.key ? 0 : settings.guideVol) : 1;
    if (volHooked()) {
      if (v.dataset.ytlsWant == null) v.dataset.ytlsWant = String(v.volume); // 還沒接手：目前的音量就是 YouTube 想要的
      kara.base = Number(v.dataset.ytlsWant);
      if (v.dataset.ytlsGain !== String(gain)) v.dataset.ytlsGain = String(gain);
    }
    const wantV = Math.min(1, kara.base * gain);
    kara.lastSet = wantV;
    if (Math.abs(v.volume - wantV) > 1e-6) v.volume = wantV;
    a.volume = Math.max(0, Math.min(1, kara.base * settings.karaVol));
    a.muted = v.muted;
    if (!inRange) { if (!a.paused) a.pause(); return; }
    const playing = !v.paused && !v.ended && v.readyState >= 3;
    const drift = a.currentTime - at;
    if (Math.abs(drift) > 0.25 || (!playing && Math.abs(drift) > 0.012)) {
      try { a.currentTime = at; } catch (e) { /* 還沒載入 */ }
      a.playbackRate = v.playbackRate;
    } else if (playing && Math.abs(drift) > 0.012) {
      // 差一點點：伴奏稍微加速或減速追上（最多 ±6%，聽不出來），不用跳
      a.playbackRate = v.playbackRate * (1 - Math.max(-0.06, Math.min(0.06, drift)));
    } else a.playbackRate = v.playbackRate;
    // 被瀏覽器擋（NotAllowedError）才算「不讓播」，每 3 秒再試一次；
    // 我們自己暫停打斷了 play()（AbortError，例如影片緩衝）不算，不然會一直開著原唱
    if (playing && a.paused && (!kara.blocked || Date.now() - kara.blockedAt > 3000)) {
      if (kara.blocked) kara.blockedAt = Date.now();
      a.play().then(() => { if (a === kara.audio && kara.blocked) { kara.blocked = false; karaTick(); } renderKara(); }).catch((e) => {
        if (a !== kara.audio || !e || e.name !== 'NotAllowedError') return;
        if (!kara.blocked) { kara.blocked = true; kara.blockedAt = Date.now(); karaTick(); renderKara(); }
      });
    } else if (!playing && !a.paused) a.pause();
  }

  function renderKara() {
    if (!ui.karaInfo) return;
    const r = kara.result;
    let text;
    if (!HAS.listen()) text = notInstalled('伴奏', 3) + '（找官方伴奏、升降 Key；AI 去人聲要選 4）。';
    else if (!settings.kara && !kara.state) text = '關閉中。打開後會先找 YouTube、niconico 和 B 站上的伴奏（跟這部影片比對，確定是同一份配樂、算好時間才用），' +
      (HAS.sep() ? '找不到就用 AI 把原唱去掉。' : '找不到就沒有伴奏（這個安裝沒有 AI 去人聲）。');
    else if (kara.state === 'on' && kara.blocked) text = '伴奏準備好了，但瀏覽器還不讓它播：點一下影片畫面。';
    else if (kara.state === 'on' && r) {
      const site = { bilibili: 'B 站', niconico: 'niconico' }[r.site] || 'YouTube';
      text = r.kind === 'source'
        ? '使用中：' + site + ' 上的伴奏「' + r.title + '」' + (r.channel && r.site !== 'niconico' ? '（' + r.channel + '）' : '') +
          (kara.segs.length > 1 ? '・影片有剪接，分 ' + kara.segs.length + ' 段對時' : '') +
          (r.coverage < 0.95 ? '・沒對上的段落（例如 MV 劇情）播原聲' : '')
        : '使用中：AI 去人聲（從這部影片的聲音分離出伴奏，偶爾殘留一點人聲或和聲）';
    } else if (kara.state === 'error') text = '伴奏失敗：' + kara.detail;
    else if (kara.state) text = '準備中：' + (kara.detail || kara.state) + '…';
    else text = '這部影片沒有開伴奏（節目、直播不會自動開）。按「重新找伴奏」可以手動開。';
    ui.karaInfo.textContent = text;
    const on = kara.state === 'on';
    ui.keyv.textContent = kara.keyBusy || kara.keyWant !== kara.key
      ? fmtKey(kara.key) + ' → ' + fmtKey(kara.keyWant) + (kara.keyBusy ? '　變調中…' : '')
      : fmtKey(kara.key);
    for (const b of ui.keyBtns) b.disabled = !on;
    ui.keyHint.textContent = kara.keyErr ? '變調失敗：' + kara.keyErr
      : !on ? '伴奏開好之後才能調 Key。'
        : kara.key ? '已變調：原唱（導唱）會自動關掉，音高才不會打架。這首歌會記住這個 Key。' : '變調不改變速度。第一次約 5～10 秒，做好會記住；調過之後相鄰的 ±1 會先在背景做好，再按幾乎馬上換。';
    ui.karaRetry.hidden = !HAS.listen() || (!settings.kara && !kara.state);
    ui.karaAi.hidden = !HAS.sep() || !(kara.state === 'on' && r && r.kind === 'source');
  }

  // 網址上的開始時間（&t=600、&t=600s、&t=1h2m3s）
  function urlStartSec() {
    const t = new URLSearchParams(location.search).get('t') || '';
    if (/^\d+s?$/.test(t)) return parseInt(t, 10);
    const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
  }

  async function startVod(token) {
    const v = video();
    const gen = listen.gen;
    const alive = () => token === st.token && st.kind === 'listen' && gen === listen.gen;
    let r;
    // 重新開始（服務重開、被取消）時沿用第一次的起點：服務切的聽寫視窗一樣，時間戳才對得上、不會重複。
    // 播放器還沒跳到網址上的時間（&t=，背景分頁常這樣）：用網址的時間，不然會從 0:00 開始做
    const tUrl = urlStartSec();
    const from0 = Math.max(0, (v && v.currentTime > 1 ? v.currentTime : tUrl) - 5);
    let focusAt = from0;
    const start = () => bg('listenVodStart', { videoId: st.vid, from: from0, hints: S.listenHints(st.info) });
    try { r = await start(); }
    catch (e) { setStatus('AI 聽寫啟動失敗：' + e.message); return; }
    if (!alive()) return;
    if (!r || !r.ok) { setStatus('AI 聽寫啟動失敗：' + ((r && r.error) || '服務沒有回應')); return; }
    let since = 0, restarts = 0;
    const poll = async () => {
      if (!alive()) return;
      let j;
      try { j = await bg('listenVodStatus', { videoId: st.vid, since }); } catch (e) { j = null; }
      if (!alive()) return;
      // 服務重開過（工作不見了），或被別的分頁的新工作取消：重新開始（最多 2 次）；已經顯示的句子會自動去重
      if (j && (j.state === 'none' || (j.state === 'error' && /已取消/.test(j.error || ''))) && restarts < 2) {
        restarts++; since = 0;
        try { await start(); } catch (e) { /* 下次再問 */ }
        listen.timer = setTimeout(poll, 2500);
        return;
      }
      if (j && j.state === 'none') { // 重新開始 2 次後工作還是一直不見：停下來，不要永遠顯示「聽寫中」
        setStatus('AI 聽寫失敗：' + (j.error || '服務一直重開') + '　可以在面板重新選 AI 聽寫');
        return;
      }
      if (j && j.ok) {
        since = j.total;
        await addListenSegments(j.segments || [], token);
        if (!alive()) return; // 翻譯途中換了來源（同一部影片）：不要再改狀態列、也不要接著改成邊播邊聽
        // 正在看的地方附近還沒有字幕（跳到後面、或一開始起點抓錯）：請服務先做這裡。
        // 同一個地方不重複要求（沒人說話的段落本來就沒字幕），離上次要求的位置超過 30 秒才再要
        const vv = video();
        if (vv && (j.state === 'downloading' || j.state === 'transcribing') && !vv.paused) {
          const now = vv.currentTime, ms = now * 1000;
          const covered = st.cues.some((c) => c.end >= ms - 15000 && c.start <= ms + 30000);
          if (!covered && Math.abs(now - focusAt) > 30) {
            focusAt = now;
            bg('listenVodFocus', { videoId: st.vid, at: Math.max(0, now - 5) }).catch(() => {});
          }
        }
        const pct = Math.round((j.progress || 0) * 100);
        // 邊下載邊聽寫：下載還沒完成時順便顯示下載進度
        const dl = j.downloaded != null && j.downloaded < 1 ? '，音訊下載 ' + Math.round(j.downloaded * 100) + '%' : '';
        if (j.paused) noteYield(j.paused);
        if (j.state === 'downloading') setStatus('使用中：AI 聽寫　下載音訊中…（只抓聲音，聽寫完會自動刪掉）');
        else if (j.state === 'transcribing' && j.paused) setStatus('使用中：AI 聽寫　暫停：' + yieldText(j.paused) + '；已有 ' + st.cues.length + ' 句' + cloudNote(j));
        else if (j.state === 'transcribing') setStatus('使用中：AI 聽寫' + engTag(j) + '　聽寫中 ' + pct + '%' + dl + '（從你看的位置往後做，再補前面）；已有 ' + st.cues.length + ' 句' + cloudNote(j));
        else if (j.state === 'done') { setStatus('使用中：AI 聽寫' + engTag(j) + '　完成，共 ' + st.cues.length + ' 句（下次打開直接有）' + cloudNote(j)); return; }
        else if (j.state === 'error') {
          if (/取消/.test(j.error)) { setStatus('AI 聽寫失敗：' + j.error); return; }
          setStatus('AI 聽寫失敗：' + j.error + (st.info.isLive ? '' : '　改用直接聽正在播的聲音'));
          // 下載不了（會員限定等）就改成邊播邊聽寫；之前看過、聽寫過的部分直接拿來用
          listen.members = /channel's members|members-only|メンバー限定|會員/i.test(j.error);
          await loadCaptured(token);
          if (alive()) startLive(token);
          return;
        }
      }
      listen.timer = setTimeout(poll, 2500);
    };
    poll();
  }

  // 直播中（或下載不了）：從影片元素擷取聲音，轉成 16kHz 單聲道，每 6 秒送一段去聽寫
  function startLive(token, tries = 0) {
    const v = video();
    if (!v) { // 播放器還沒建好：等一下再試（以前直接放棄，狀態卻顯示「使用中」）
      if (tries < 20) setTimeout(() => { if (token === st.token && st.kind === 'listen' && !listen.audio) startLive(token, tries + 1); }, 1000);
      return;
    }
    let stream;
    try { stream = (v.captureStream || v.mozCaptureStream).call(v); } catch (e) { setStatus('抓不到影片聲音：' + e.message); return; }
    const ctx = new AudioContext({ sampleRate: 16000 });
    // 這次加的監聽器和 AudioContext 都記在 listen.cleanup，停止聽寫時一起拿掉（以前每次開始都在同一個 <video> 上多加一批，
    // 還沒有聲音軌時建的 AudioContext 也關不到，換影片後還會被 addtrack 接上）
    const offs = [];
    const on = (t, ev, fn, opt) => { t.addEventListener(ev, fn, opt); offs.push(() => t.removeEventListener(ev, fn, opt)); };
    offs.push(() => { if (ctx.state !== 'closed') ctx.close().catch(() => {}); });
    listen.cleanup = offs;
    const myGen = listen.gen;
    listen.stats.liveTok = token; listen.stats.lives = (listen.stats.lives || 0) + 1;
    // 瀏覽器規定：頁面還沒被點過時 AudioContext 會停在 suspended，聲音進不來 → 試著恢復，不行就等使用者點一下
    const resume = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); };
    resume();
    const onGesture = () => { resume(); if (ctx.state !== 'suspended') { document.removeEventListener('pointerdown', onGesture, true); document.removeEventListener('keydown', onGesture, true); } };
    on(document, 'pointerdown', onGesture, true);
    on(document, 'keydown', onGesture, true);
    on(v, 'play', resume);
    setTimeout(() => {
      if (token === st.token && st.kind === 'listen' && ctx.state === 'suspended') {
        setStatus('使用中：AI 聽寫（直播）　瀏覽器還不讓擴充功能聽聲音：請點一下影片畫面（或按任一鍵），之後就會開始聽寫');
      }
    }, 1500);
    const replay = !st.info.isLive;
    const runningText = () => (replay
      ? '使用中：AI 聽寫（邊播邊聽）　' + (listen.members ? '會員限定影片' : '這部影片') + '下載不了，只能邊播邊聽寫，第一次看字幕會晚約 7 秒；'
        + '聽過的部分倒帶或下次再看就會對準（已有 ' + st.cues.length + ' 句）'
      : '使用中：AI 聽寫（直播）　邊播邊聽寫，每段約 6 秒，字幕會比說話晚幾秒')
      + (listen.eng && listen.eng.engine === 'cloud' ? '；用雲端聽寫' : '') + cloudNote(listen.eng);
    listen.runningText = runningText;
    ctx.onstatechange = () => {
      if (token === st.token && st.kind === 'listen' && ctx.state === 'running') setStatus(runningText());
    };
    if (replay) {
      const onSeek = () => { if (token !== st.token || st.kind !== 'listen') return; restoreRealTimes(); };
      on(v, 'seeked', onSeek);
    }
    // 收到一小段聲音（data：16kHz 單聲道；endMs：這段最後一個取樣對應的影片時間），湊滿 6 秒送去聽寫
    let buf = [], len = 0, t0 = null;
    const reset = () => { buf = []; len = 0; t0 = null; };
    const feed = (data, endMs) => {
      listen.stats.samples = (listen.stats.samples || 0) + data.length;
      const why = token !== st.token ? 'tok' : st.kind !== 'listen' ? 'kind' : v.paused ? 'paused' : !v.isConnected ? 'gone' : '';
      if (why) { listen.stats['skip_' + why] = (listen.stats['skip_' + why] || 0) + 1; reset(); return; }
      if (t0 === null) t0 = endMs - (data.length / 16000) * 1000;
      buf.push(data); len += data.length;
      if (len >= 16000 * 6) {
        const pcm = new Int16Array(len);
        let o = 0;
        for (const b of buf) { for (let i = 0; i < b.length; i++) pcm[o++] = Math.max(-32768, Math.min(32767, b[i] * 32768)); }
        const start = t0;
        reset();
        // 回放：這段之前已經聽寫過（上次看過）就不用再送
        if (!replay || !covered(start, start + (pcm.length / 16)))
          sendChunk(pcm, start, token);
      }
    };
    // 拖進度條：錄到一半的這段丟掉（不然前後兩個位置的聲音混在同一段、時間也對不上）
    on(v, 'seeking', reset);
    const connectScriptProcessor = (src) => {
      // 備援（AudioWorklet 載不起來時）：回呼在頁面主執行緒，忙的時候會掉聲音
      const proc = ctx.createScriptProcessor(16384, 1, 1);
      proc.onaudioprocess = (e) => feed(new Float32Array(e.inputBuffer.getChannelData(0)), v.currentTime * 1000);
      src.connect(proc); proc.connect(ctx.destination); // 輸出是靜音（沒寫入輸出緩衝），只為了讓處理持續跑
      return proc;
    };
    let connecting = false;
    const connect = () => {
      if (myGen !== listen.gen || connecting || listen.audio || !stream.getAudioTracks().length) return false; // 已經停止（換了影片／來源）就不要再接
      connecting = true;
      const src = ctx.createMediaStreamSource(stream);
      listen.audio = { ctx, src, proc: { disconnect() {} } };
      (async () => {
        let node = null;
        try {
          // AudioWorklet：在音訊執行緒收集，主執行緒忙（直播聊天室）也不會掉聲音
          await ctx.audioWorklet.addModule(chrome.runtime.getURL('lib/pcm-worklet.js'));
          if (myGen !== listen.gen) return;
          node = new AudioWorkletNode(ctx, 'ytls-pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
          node.port.onmessage = (e) => {
            // 收到時已經過了多久（主執行緒忙會晚到）：用同一個 AudioContext 時鐘算，換回影片時間
            const lag = Math.max(0, ctx.currentTime - e.data.ctxTime);
            feed(e.data.data, (v.currentTime - lag * (v.playbackRate || 1)) * 1000);
          };
          src.connect(node); node.connect(ctx.destination); // 輸出是靜音，只為了讓處理持續跑
          listen.stats.mode = 'worklet';
        } catch (err) {
          listen.stats.mode = 'sp:' + String(err && err.message).slice(0, 60);
          console.warn('[ytls] AudioWorklet 不能用，改用 ScriptProcessor', err);
          if (myGen !== listen.gen) return;
          node = connectScriptProcessor(src);
        }
        if (myGen === listen.gen && listen.audio) listen.audio.proc = node;
        else { try { node.disconnect(); } catch (e) { /* ignore */ } }
      })();
      return true;
    };
    if (!connect()) on(stream, 'addtrack', () => { if (!listen.audio) connect(); });
    // YouTube 有時在開始聽寫之後才把播放器的 <video> 換成另一個元素（看廣告、載入順序而定）：
    // 舊元素停在暫停狀態，聲音全被當成「暫停中」丟掉，畫面一直顯示「使用中」卻永遠沒有字幕（重新整理要看運氣）。
    // 每 2 秒看一次，換了元素就改接新的
    const watch = setInterval(() => {
      if (myGen !== listen.gen || token !== st.token || st.kind !== 'listen') return;
      const cur = video();
      if (cur && cur !== v) {
        listen.stats.swaps = (listen.stats.swaps || 0) + 1;
        listen.gen++;
        stopCapture();
        startLive(token);
      }
    }, 2000);
    offs.push(() => clearInterval(watch));
    setStatus(runningText());
  }

  // 一段一段排隊送；顯示卡忙到積了 3 段以上就丟最舊的（直播要跟得上現在）
  const chunkQueue = [];
  function sendChunk(pcm, t0, token) {
    for (let i = chunkQueue.length - 1; i >= 0; i--) if (chunkQueue[i].token !== token) chunkQueue.splice(i, 1); // 上一部影片還沒送的不要送了
    chunkQueue.push({ pcm, t0, token });
    while (chunkQueue.length > 3) { chunkQueue.shift(); listen.stats.dropped++; }
    pumpChunks();
  }
  async function pumpChunks() {
    if (listen.busy) return;
    let item = chunkQueue.shift();
    // 換了影片／來源：排著的舊片段直接丟掉（不然還會佔著聽寫、拖慢新直播的第一句；用雲端時還會花額度）
    while (item && (item.token !== st.token || st.kind !== 'listen')) item = chunkQueue.shift();
    if (!item) return;
    listen.busy = true;
    try {
      const u8 = new Uint8Array(item.pcm.buffer);
      let bin = '';
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      listen.stats.sent++;
      const tq = Date.now();
      const r = await bg('listenChunk', { t0: item.t0, pcm: btoa(bin), hints: S.listenHints(st.info) });
      listen.stats.ms = Date.now() - tq;
      if (r && r.yield) {
        noteYield(r.yield);
        // 有開雲端卻落到本機（額度用完、連不上…）又剛好讓出顯示卡：原因也寫出來，不然看起來像雲端也停了
        if (item.token === st.token && st.kind === 'listen') setStatus('AI 聽寫暫停：' + yieldText(r.yield) + (r.cloudNote ? '；' + r.cloudNote : ''));
      }
      // 只裝了雲端聽寫、這段雲端不能用（額度、連線、金鑰）：這段沒有字幕，寫出原因（雲端恢復後的下一段會自動換回「使用中」）
      if (r && r.noLocal && item.token === st.token && st.kind === 'listen') setStatus('AI 聽寫暫停：' + (r.error || NO_LOCAL_TEXT));
      if (r && r.ok) { listen.stats.ok++; listen.stats.segs += (r.segments || []).length; }
      if (item.token === st.token && st.kind === 'listen' && r && r.ok) {
        if (!st.info.isLive) addSpan(item.t0, item.t0 + item.pcm.length / 16);
        await addListenSegments(r.segments || [], item.token, true);
        if (!st.info.isLive && !(r.segments || []).length) saveCaptured();
        // 狀態列換回「使用中」：回放的進度說明會變，要更新；讓出顯示卡結束後（直播、回放都是）也要把「暫停」換掉；
        // 雲端／本機換了（額度用完改本機、恢復）也要更新
        // （上一段連不上之後、翻譯補好時狀態列被改成只寫來源名稱之後，也要換回完整的說明）
        listen.eng = { engine: r.engine, cloudNote: r.cloudNote || '' };
        if (listen.runningText && /^(AI 聽寫(暫停：|服務連不上)|使用中：AI 聽寫|好，這次照用顯示卡)/.test(st.status || '')) {
          const text = listen.runningText();
          if (text !== st.status) setStatus(text);
        }
      }
    } catch (e) {
      listen.stats.err++;
      if (item.token === st.token && st.kind === 'listen') setStatus('AI 聽寫服務連不上：' + e.message); // 舊影片的錯誤不要蓋掉新影片的狀態
    } finally { listen.busy = false; pumpChunks(); }
  }

  // ---------- 來源：YouTube Music 官方歌詞（LyricFind／Musixmatch 授權，部分有逐句時間）----------
  // 從 youtube.com 頁面直接呼叫 YouTube 自己的 InnerTube API（同網域；不帶登入 cookie）
  const YTM_WEB = { clientName: 'WEB_REMIX', clientVersion: '1.20251020.01.00', hl: 'ja', gl: 'JP' };
  const YTM_APP = { clientName: 'ANDROID_MUSIC', clientVersion: '7.27.52', androidSdkVersion: 30, hl: 'ja', gl: 'JP' };
  async function innertube(ep, body, client) {
    const r = await fetch('/youtubei/v1/' + ep + '?prettyPrint=false', {
      method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ context: { client }, ...body }),
    });
    if (!r.ok) throw new Error('YouTube Music 回應 ' + r.status);
    return r.json();
  }
  function deepFind(o, key, out = []) {
    if (o && typeof o === 'object') {
      if (key in o) out.push(o[key]);
      for (const v of Object.values(o)) deepFind(v, key, out);
    }
    return out;
  }
  const runsText = (x) => ((x && x.runs) || []).map((r) => r.text).join('');

  // 查某支影片在 YouTube Music 上的歌詞；沒有就回傳 null
  async function ytmLyricsFor(videoId) {
    const next = await innertube('next', { videoId }, YTM_WEB);
    const tab = deepFind(next, 'tabRenderer').find((t) => t.endpoint && t.endpoint.browseEndpoint && /^MPLY/.test(t.endpoint.browseEndpoint.browseId));
    if (!tab) return null;
    const browseId = tab.endpoint.browseEndpoint.browseId;
    const [web, app] = await Promise.all([
      innertube('browse', { browseId }, YTM_WEB),
      innertube('browse', { browseId }, YTM_APP).catch(() => null),
    ]);
    const shelf = deepFind(web, 'musicDescriptionShelfRenderer')[0];
    const timed = (deepFind(app, 'timedLyricsData')[0] || [])
      .map((x) => ({ start: Number(x.cueRange && x.cueRange.startTimeMilliseconds), text: String(x.lyricLine || '').trim() }))
      .filter((x) => x.text && x.text !== '♪' && Number.isFinite(x.start));
    const lines = timed.length ? timed.map((x) => x.text)
      : shelf ? runsText(shelf.description).split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
    if (!lines.length) return null;
    // 段落（空行）資訊：只有純文字版有
    if (!timed.length && shelf) {
      const raw = runsText(shelf.description).split(/\r?\n/).map((l) => l.trim());
      lines.para = []; raw.forEach((l, i) => { if (l) lines.para.push(lines.para.length === 0 || !raw[i - 1]); });
    }
    const item = deepFind(next, 'playlistPanelVideoRenderer').find((p) => p.videoId === videoId) || {};
    return {
      videoId, lines, prior: timed.length ? timed.map((x) => x.start) : null,
      source: shelf ? runsText(shelf.footer).replace(/^(提供元|Source)\s*[:：]\s*/i, '') : '',
      title: runsText(item.title), artist: runsText(item.shortBylineText || item.longBylineText).split('•')[0].trim(),
    };
  }

  // 這部影片本身沒有（翻唱、轉載）：用歌名搜 YouTube Music 上的原曲。
  // 同名歌很多，只接受「歌名完全一樣，而且原唱名字出現在這部影片的標題或說明欄」的結果
  async function ytmSearchOriginal() {
    const hay = S.norm((st.info.title || '') + ' ' + (st.info.description || ''));
    for (const q of S.buildQueries(st.info.title, st.info.author).slice(0, 2)) {
      const res = await innertube('search', { query: q, params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D' }, YTM_WEB); // 只搜歌曲
      for (const it of deepFind(res, 'musicResponsiveListItemRenderer').slice(0, 5)) {
        const cols = deepFind(it, 'musicResponsiveListItemFlexColumnRenderer').map((c) => runsText(c.text));
        const title = cols[0] || '', artist = (cols[1] || '').split('•')[0].trim();
        const vid = deepFind(it, 'videoId')[0];
        if (!vid || [...S.norm(title)].length < 2 || !artist) continue;
        if (!hay.includes(S.norm(title)) || !hay.includes(S.norm(artist))) continue;
        const r = await ytmLyricsFor(vid).catch(() => null);
        if (r) return { ...r, title, artist, viaSearch: true };
      }
    }
    return null;
  }

  // 先查這部影片本身；沒有再搜原曲（結果記在 st.ytm，面板也會列出來）
  async function findYtm(allowSearch) {
    const vid = st.vid;
    try {
      // 查詢途中換了影片：結果是上一部的，不能寫進新影片的狀態（st 是同一個物件）
      if (st.ytm === undefined) { const r = await ytmLyricsFor(vid); if (vid !== st.vid) return null; st.ytm = r; }
      if (!st.ytm && allowSearch && !st.ytmSearched) {
        st.ytmSearched = true;
        const r = await ytmSearchOriginal();
        if (vid !== st.vid) return null;
        st.ytm = r;
      }
    } catch (e) {
      console.warn('[ytls] YouTube Music 歌詞查詢失敗', e);
      if (vid !== st.vid) return null;
      if (st.ytm === undefined) st.ytm = null;
    }
    if (vid !== st.vid) return null;
    renderTracks();
    return st.ytm;
  }

  async function useYtm(token, save = true, auto = false, allowSearch = false) {
    if (save) st.manual = true;
    const r = await findYtm(allowSearch);
    if (token !== st.token) return true;
    if (!r) { if (!auto) setStatus('YouTube Music 上沒有這首歌的歌詞。'); return false; }
    st.choice = { kind: 'ytm', videoId: r.videoId };
    renderTracks();
    if (save) await setPref({ choice: st.choice });
    const label = 'YouTube Music 歌詞' + (r.viaSearch ? '（原曲 ' + r.title + ' / ' + r.artist + '）' : '') + (r.source ? '・' + r.source : '');
    // 有逐句時間：當參考時間，再用這部影片的自動字幕／畫面歌詞校正（MV 的前奏常和音源版不同）
    return usePlainLines(r.lines, label, token, false, r.prior);
  }

  // ---------- 來源：說明欄歌詞（或任何沒時間軸的歌詞）＋ 自動字幕對時 ----------
  function descLines() {
    if (st.descLines === undefined) st.descLines = S.extractDescLyrics(st.info && st.info.description) || null;
    return st.descLines;
  }

  // 取得自動字幕原始資料（對齊用）；優先日文自動字幕
  async function getAsrJson() {
    if (st.asrJson !== undefined) return st.asrJson;
    const asr = st.info.tracks.filter((t) => t.kind === 'asr');
    const t = asr.find((x) => /^ja/i.test(x.languageCode)) || asr[0];
    const vid = st.vid;
    const json = t ? await fetchTrackJson(t) : null;
    if (vid !== st.vid) return null; // 途中換了影片：不要把上一部的自動字幕存進新影片
    if (st.asrJson === undefined) st.asrJson = json ? { json, lang: t.languageCode } : null;
    return st.asrJson;
  }

  // 對時依據：自動字幕的逐詞時間＋畫面 OCR 讀到的歌詞（OCR 的文字就是歌詞本身，對得更準）
  // prior：參考時間（翻唱用原曲 LRC 的時間），有的話錨點之間按它的相對間距分配
  async function usePlainLines(lines, label, token, quiet = false, prior = null) {
    if (!quiet) setStatus('對齊歌詞時間中…（' + label + '）');
    // 對時要等自動字幕（最多約 14 秒）和對齊（最多 1 分鐘）：等的時候使用者改選了別的來源（或關掉字幕）就作罷，
    // 不要等它算完又蓋回去（每次選來源都會換一個新的 st.choice）。
    // 只有「使用者自己選的」才算（st.manual）：對時中 st.kind 還是空的，畫面上讀到兩句就會自動改用 OCR，
    // 那不能讓說明欄／YT Music 歌詞整個作廢（它們的優先順序比 OCR 高）——照樣算完、蓋回來
    const choice0 = st.choice;
    const stale = () => token !== st.token || (st.choice !== choice0 && st.manual);
    const reclaim = () => { if (st.choice !== choice0) { st.choice = choice0; renderTracks(); } };
    const asr = await getAsrJson();
    if (stale()) return true;
    reclaim();
    const ocrWords = st.ocr ? st.ocr.all().map((c) => ({ start: c.start, end: Math.min(c.end, c.start + 4000), text: c.text, conf: 255 })) : [];
    // 本機 AI 聽寫好了就用它（逐字時間、準很多），取代 YouTube 自動字幕
    const job = st.songJob && st.songJob.token === token && st.songJob.done ? st.songJob : null;
    const fixK = globalThis.YTLSKanji ? globalThis.YTLSKanji.fixKanji : null;
    const wWords = job ? S.whisperWords(job.segs, fixK) : [];
    const useW = wWords.length >= 10;
    const words = [...(useW ? wWords : asr ? S.asrWords(asr.json, asr.lang) : []), ...ocrWords].sort((a, b) => a.start - b.start);
    const durationMs = (st.info.lengthSeconds || 0) * 1000;
    const spans = useW ? S.whisperSpans(job.segs, durationMs) : asr ? S.asrMusicSpans(asr.json) : [];
    // 寫狀態列的那一刻才判斷（對時要等好幾秒，聽寫可能在這期間就失敗了：以前照樣寫「AI 聽寫中」）
    const listenNote = () => {
      const sj = st.songJob && st.songJob.token === token ? st.songJob : null;
      return useW ? '，用 AI 聽寫對時' : listenOk && canListen() && !st.talk && !st.info.isLive && !(sj && (sj.done || sj.error)) ? LISTEN_WAIT : '';
    };
    if (!useW) refineWithListen(token); // 背景整首聽寫，好了再重新對時（不等它）
    if (!words.length && prior) {
      // 沒有任何東西可以對時：先照參考時間放，播放時 OCR 讀到畫面歌詞會再修正
      setCues(lines.map((text, i) => ({ start: prior[i], end: prior[i + 1] != null ? prior[i + 1] : prior[i] + 8000, text })), 'lrc', label);
      st.aligned = { lines, label, prior };
      setStatus('使用中：' + label + '　還沒有可以對時的資料，先用原曲時間' + (listenNote() || '；' +
        (ocrReady() ? '播放時會讀畫面歌詞修正' : '不準可在「顯示設定」調偏移')));
      await translateCues(token);
      return true;
    }
    if (!words.length) {
      setCues(lines.map((text) => ({ start: -1, end: -1, text })), 'plain', label);
      st.aligned = { lines, label };
      setStatus('這部影片沒有自動字幕可以對時間，歌詞先放在「歌詞全文」分頁' + (listenNote() || '。' +
        (ocrReady() ? '播放時會讀取畫面上的歌詞來對時間。' : '')));
      await translateCues(token);
      return true;
    }
    let res;
    try {
      res = await bg('alignLyrics', { lines, para: lines.para || null, words, prior, spans, durationMs });
    } catch (e) { if (!quiet && !stale()) setStatus('歌詞對時失敗：' + e.message); return false; }
    if (stale()) return true;
    reclaim();
    // 重新對時時保留已經翻好的內容
    const old = new Map(st.cues.map((c) => [c.text, c]));
    setCues(res.cues.map((c) => {
      const o = old.get(c.text);
      return { start: c.start, end: c.end, text: c.text, tr: o && o.tr, ro: o && o.ro, rb: o && o.rb };
    }), 'lrc', label);
    st.aligned = { lines, label, prior };
    st.ocrAlignedCount = ocrWords.length;
    st.ocrAlignedAt = Date.now();
    const pct = Math.round((res.anchored / Math.max(1, res.total)) * 100);
    setStatus('使用中：' + label + '　自動對時（' + pct + '% 的行有直接對到' + listenNote() +
      (ocrWords.length ? '，含畫面歌詞 ' + ocrWords.length + ' 句' : '') + '；不準可在「顯示設定」調偏移）');
    if (st.cues.some((c) => c.text && !c.tr)) await translateCues(token);
    return true;
  }

  // ---------- 來源：畫面上的歌詞（本機 OCR 服務）----------
  let ocrPingAt = 0, ocrOk = false;
  async function pingOcr(force) {
    await instReady; // 頁面一打開就會問：先知道裝了哪些
    if (!HAS.ocr()) { ocrOk = false; return false; } // 沒裝 OCR 服務：不用去連
    if (!force && Date.now() - ocrPingAt < 20000) return ocrOk;
    ocrPingAt = Date.now();
    try { ocrOk = await bg('ocrPing', {}); } catch (e) { ocrOk = false; }
    renderTracks();
    return ocrOk;
  }
  const ocrReady = () => settings.ocr && ocrOk;

  async function useOcr(token, save = true, auto = false) {
    if (save) st.manual = true; // 在面板上手動點的來源：之後不自動切換
    if (IS_YTM) return false; // 以前在 YouTube Music 選過的話會被記住，但這裡不讀畫面：當作沒有這個來源
    if (!HAS.ocr()) { if (!auto) setStatus(notInstalled('畫面字幕（OCR）', 2)); return false; }
    if (!settings.ocr) { if (!auto) setStatus('OCR 已在「顯示設定」關閉。'); return false; }
    // 掃描過的影片：結果已經存在本機，OCR 服務沒開也能直接用
    const scanned = st.ocrScanned && st.ocr && st.ocr.all().length;
    if (!scanned && !(await pingOcr(true))) {
      if (!auto) setStatus('OCR 服務連不上：按面板上的「▶ 啟動本機服務」，或雙擊 ocr-server 裡的「啟動 OCR 服務.cmd」。');
      return false;
    }
    if (token !== st.token) return true;
    setCues(st.ocr.all(), 'ocr', st.talk ? '畫面字幕（OCR）' : '畫面歌詞（OCR）');
    st.choice = { kind: 'ocr' };
    applySettingsToUI(); // 看影片：避開影片自己的字幕
    renderTracks();
    if (save) await setPref({ choice: st.choice });
    setStatus(ocrUsingText());
    if (st.cues.length) await translateCues(token);
    return true;
  }
  function ocrWhat() { return st.talk ? '畫面字幕' : '畫面歌詞'; }
  function ocrUsingText() {
    return st.cues.length
      ? '使用中：' + ocrWhat() + '（OCR）　' + (st.ocrScanned ? '已掃描 ' + st.cues.length + ' 句（以後打開直接用）' : '已記錄 ' + st.cues.length + ' 句，播放時會繼續補齊')
      : '使用中：' + ocrWhat() + '（OCR）　播放時會讀取畫面上的' + (st.talk ? '字幕' : '歌詞') + '；看完一次後就有完整時間軸和下一句預告';
  }

  // OCR 需要跑的情況：目前用的不是人工校對的時間軸
  function ocrWanted() {
    // 已經完整掃描過的影片不用再讀（也避免把掃描結果蓋掉）
    // 看影片也讀（找影片自己燒在畫面上的日文字幕）；直播不讀（聊天室、遊戲畫面都是雜訊）
    return !IS_YTM && ocrReady() && st.info && (!st.talk || st.scene === 'video') && !st.ocrGaveUp && !st.ocrScanned && !(st.choice && st.choice.kind === 'off') && (st.kind === 'ocr' || st.aligned || st.kind === null || st.kind === 'plain' || st.kind === 'listen' || (st.kind === 'yt' && st.isAsr));
  }

  // 一張畫面做幾種版本（原圖、白字遮罩…）分別辨識再合併；座標統一成高 1080 的畫面
  // 先把各版本編成圖檔（畫面就定下來了），之後影片可以先去跳下一個位置，同時等辨識結果
  // 看影片：讀的是節目字幕（字大），原圖縮到 1280 寬、不做 MV 歌詞用的多種遮罩，快一倍以上
  function encodeFrame(v, mode, skip) {
    const talk = st.scene === 'video';
    return YTLSPrep.variants(v, talk ? 'live' : mode, skip, talk ? 1280 : 1920).map((x) => ({
      kind: x.kind, w: x.canvas.width, h: x.canvas.height,
      dataUrl: x.canvas.toDataURL(x.kind === 'orig' ? 'image/jpeg' : 'image/png', 0.9),
    }));
  }
  async function ocrEncoded(enc) {
    if (dbgSerialScan) {
      const rs = [];
      for (const x of enc) {
        const res = await bg('ocr', { dataUrl: x.dataUrl });
        if (res && res.yield) throw new GpuYieldError(res.yield);
        rs.push({ lines: res.lines || [], w: x.w, h: x.h, kind: x.kind });
      }
      return YTLSPrep.mergeResults(rs, YTLSOcr.alike);
    }
    // 幾個版本一起送：服務一次只辨識一張，但傳送、解碼可以和前一張的辨識重疊
    const results = await Promise.all(enc.map(async (x) => {
      const res = await bg('ocr', { dataUrl: x.dataUrl });
      if (res && res.yield) throw new GpuYieldError(res.yield);
      return { lines: res.lines || [], w: x.w, h: x.h, kind: x.kind };
    }));
    return YTLSPrep.mergeResults(results, YTLSOcr.alike);
  }
  const ocrFrame = (v, mode) => ocrEncoded(encodeFrame(v, mode));
  // 畫面寬（以高 1080 換算）：判斷彈幕從畫面邊緣進出場用
  const frameW = (v) => (v.videoWidth && v.videoHeight ? (1080 * v.videoWidth) / v.videoHeight : 0);

  // ---------- 快速掃描：靜音逐秒跳著看一遍整部影片，一次建好完整的畫面歌詞時間軸 ----------
  function seekVideo(v, t) {
    return new Promise((resolve) => {
      const done = () => { v.removeEventListener('seeked', done); clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, 5000);
      v.addEventListener('seeked', done);
      v.currentTime = t;
    });
  }

  // 快速掃描：跟上一張送去辨識的畫面幾乎一樣（字幕沒換、背景沒動）就不再辨識，直接沿用結果。
  // 比法：縮成 240×135 灰階，切成 15×15 的小格，任何一格平均差超過門檻就算不一樣（換一句字幕、多一個字都會讓某一格大變）；
  // 背景一直在動的 MV 每張都不一樣，照常每張辨識，結果不受影響
  const THUMB_W = 240, THUMB_H = 135, THUMB_BLOCK = 15, SAME_MAX = 6;
  let thumbCanvas = null;
  function frameThumb(v) {
    if (!thumbCanvas) { thumbCanvas = document.createElement('canvas'); thumbCanvas.width = THUMB_W; thumbCanvas.height = THUMB_H; }
    const g = thumbCanvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, 0, 0, THUMB_W, THUMB_H);
    const d = g.getImageData(0, 0, THUMB_W, THUMB_H).data;
    const out = new Uint8Array(THUMB_W * THUMB_H);
    for (let i = 0, k = 0; k < out.length; i += 4, k++) out[k] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    return out;
  }
  function sameFrame(a, b) {
    if (!a || !b) return false;
    const B = THUMB_BLOCK, n = B * B;
    for (let by = 0; by < THUMB_H; by += B) {
      for (let bx = 0; bx < THUMB_W; bx += B) {
        let sum = 0;
        for (let y = by; y < by + B; y++) for (let x = bx, i = y * THUMB_W + bx; x < bx + B; x++, i++) sum += Math.abs(a[i] - b[i]);
        if (sum > SAME_MAX * n) return false;
      }
    }
    return true;
  }

  // 快速掃描過的範圍（秒）[[a, b], …]：排好、相鄰的併起來
  function mergeRanges(rs) {
    const out = [];
    for (const [a, b] of (rs || []).filter((r) => Array.isArray(r) && r[1] > r[0]).map((r) => [+r[0], +r[1]]).sort((x, y) => x[0] - y[0])) {
      const last = out[out.length - 1];
      if (last && a <= last[1] + 2) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  }
  // 還沒掃的段落（3 秒以下的縫不算），照掃的順序：從 pos 開始掃到結尾，再回頭掃前面的
  function scanPlan(ranges, pos, dur) {
    const gaps = [];
    let at = 0;
    for (const [a, b] of mergeRanges(ranges)) { if (a - at >= 3) gaps.push([at, a]); at = Math.max(at, b); }
    if (dur - at >= 3) gaps.push([at, dur]);
    const after = [], before = [];
    for (const [a, b] of gaps) {
      if (b <= pos) before.push([a, b]);
      else if (a >= pos) after.push([a, b]);
      else { after.push([pos, b]); if (pos - a >= 3) before.push([a, pos]); }
    }
    return [...after, ...before];
  }
  const inRanges = (rs, t) => (rs || []).some(([a, b]) => t >= a && t <= b);
  // 按下快速掃描的話要掃多少秒影片：從目前位置往後（掃到結尾）、回頭掃前面的
  function scanLeft() {
    const v = video();
    if (!v || !v.duration || !isFinite(v.duration)) return { after: 0, before: 0 };
    const pos = v.currentTime || 0;
    let plan = scanPlan(st.ocrScanned ? [] : st.ocrRanges, pos, v.duration);
    if (!plan.length) plan = scanPlan([], pos, v.duration);
    const sum = (list) => list.reduce((s, [a, b]) => s + b - a, 0);
    return { after: sum(plan.filter(([a]) => a >= pos)), before: sum(plan.filter(([a]) => a < pos)) };
  }
  // 掃描按鈕旁邊的預計時間（從目前位置算；拖了進度條會跟著變，每秒更新一次）
  function scanEtaText() {
    const { after, before } = scanLeft();
    if (after >= 3) return '掃到結尾約 ' + scanEta(after) + (before >= 3 ? '，之後回頭掃前面' : '');
    return before >= 3 ? '前面還沒掃的約 ' + scanEta(before) : '約 ' + scanEta(after + before);
  }
  const fmtLeft = (sec) => (sec >= 90 ? Math.round(sec / 60) + ' 分鐘' : Math.max(1, Math.round(sec)) + ' 秒');

  // 快速掃描大概要多久（實測每秒影片約 0.25～0.4 秒；以前固定寫「1～3 分鐘」，兩小時的直播存檔其實要半小時以上）
  function scanEta(left) {
    if (!left) return '幾分鐘';
    const lo = Math.max(1, Math.round(left * 0.25 / 60)), hi = Math.max(lo + 1, Math.round(left * 0.4 / 60));
    return lo + '～' + hi + ' 分鐘';
  }
  const fmtClock = (sec) => Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
  // 快速掃描的單張辨識：服務一時忙不過來（顯示卡被別的程式佔用、回應逾時）就等一下重試，不要整個掃描中斷
  async function ocrRetry(enc, token) {
    for (let i = 0; ; i++) {
      try { return await ocrEncoded(enc); } catch (e) {
        if (e.gpuYield && token === st.token && !st.scanCancel) {
          noteYield(e.gpuYield);
          setStatus('掃描暫停：' + yieldText(e.gpuYield));
          await sleep(3000);
          i--; continue;
        }
        if (i >= 20 || token !== st.token || st.scanCancel) throw e;
        let alive = false;
        try { alive = await bg('ocrPing', {}); } catch (e2) { /* 當作沒開 */ }
        if (!alive && i >= 2) throw new Error('OCR 服務連不上');
        if (token === st.token) setStatus('OCR 服務在忙（顯示卡可能被其他程式佔用），等一下自動繼續掃描…');
        await sleep(alive ? 3000 : 5000);
      }
    }
  }

  async function scanOcr() {
    if (st.scanning) { st.scanCancel = true; return; }
    if (!(await pingOcr(true))) { setStatus('OCR 服務沒開：請雙擊 ocr-server 資料夾裡的「啟動 OCR 服務.cmd」。'); return; }
    const v = video();
    if (!v || !v.duration) return;
    const token = st.token;
    const wasPaused = v.paused, wasMuted = v.muted, pos = v.currentTime, rate = v.playbackRate, scanVid = st.vid;
    // 長度在開始時記下來：掃描途中插播廣告、元素卸載時 v.duration 會變（變短、NaN），迴圈提早結束卻被當成「掃完了」
    const dur = v.duration;
    // 從目前看的位置開始掃到結尾，再回頭掃前面；之前掃過的段落跳過（重新掃描整部的話全部重掃）。
    // 中途停止：掃到的那幾段換成新結果，其他地方保留原本的（邊播邊讀的、以前掃的），以後再按會接著掃還沒掃的
    const wasScanned = st.ocrScanned;
    const oldRanges = wasScanned ? [] : st.ocrRanges.slice();
    const plan = scanPlan(oldRanges, pos, dur);
    if (!plan.length) plan.push(...scanPlan([], pos, dur)); // 範圍其實都掃過了（只是沒標成完成）：整部重掃
    const total = Math.max(1, plan.reduce((s, [a, b]) => s + b - a, 0));
    const afterTotal = plan.filter(([a]) => a >= pos).reduce((s, [a, b]) => s + b - a, 0); // 先掃的：目前位置到結尾
    v.pause(); v.muted = true;
    st.scanning = true; st.scanCancel = false; renderTracks();
    const STEP = 1; // 秒；歌詞通常停留 2 秒以上
    const old = st.ocr ? st.ocr.save() : { cues: [], statics: [], chat: [] };
    const tracker = new YTLSOcr.OcrTracker({ statics: old.statics, chat: old.chat });
    const covered = []; // 這次真的掃到的範圍 [a, b]（秒）
    let reached = pos, failed = '', done = 0;
    const t0 = Date.now(); // 剩餘時間只用這次掃的部分估
    // 掃到的段落換成新結果、其他地方保留舊的
    // 一段掃描負責「開始時間在這段裡」的句子：每張畫面讀到的新句，開始時間記成那張的時間 −0.5 秒（取樣補償），
    // 所以範圍 [a, b] 對應開始時間 [a−0.5, b−0.5)。新舊用同一條線切：同一句不會兩邊都留、也不會兩邊都丟
    // （暖身那幾秒讀到的不收，那裡保留原本的；接著掃前面那段時，會由那段負責）
    const owns = (rs, c) => rs.some(([a, b]) => c.start >= a * 1000 - 500 && c.start < b * 1000 - 500);
    const merged = () => {
      const now = mergeRanges(covered);
      const keepOld = old.cues.filter((c) => !owns(now, c));
      const fresh = tracker.save();
      const keepNew = fresh.cues.filter((c) => owns(now, c));
      // 上次在一句字幕中途停下來的：那句被截在停止點；這次暖身時看到它還在，就把它延長
      for (const c of fresh.cues) {
        if (owns(now, c)) continue;
        const o = keepOld.find((x) => x.start < c.end && c.start < x.end + 1000 && YTLSOcr.sim(x.text, c.text) >= 0.8);
        if (o) o.end = Math.max(o.end, c.end);
      }
      return new YTLSOcr.OcrTracker({ cues: [...keepOld, ...keepNew].sort((x, y) => x.start - y.start), statics: fresh.statics, chat: fresh.chat });
    };
    // 整部都掃過了沒（重新掃描的話，原本就是完整的）
    const rangesAfter = () => mergeRanges([...(wasScanned ? [[0, dur]] : oldRanges), ...covered]);
    // 白字／暗字遮罩版本：看了 30 張都沒讀到原圖讀不到的字，就改成每 4 張才做一次（一讀到又恢復每張都做）
    const vstat = {};
    let frame = 0;
    const ss = st.scanStats = { frames: 0, calls: 0, same: 0, seekWait: 0, enc: 0, wait: 0, feed: 0 };
    let lastSent = null, lastThumb = null; // 上一張真的送去辨識的畫面（比對用）
    // 收下一張的辨識結果（照時間順序餵進 tracker）
    const finish = async (job) => {
      let tm = performance.now();
      const lines = await job.p;
      ss.wait += performance.now() - tm; tm = performance.now(); ss.frames++; ss.calls += job.enc.length;
      for (const x of job.enc) if (x.kind !== 'orig') (vstat[x.kind] = vstat[x.kind] || { tried: 0, won: 0 }).tried++;
      tracker.feed(job.t * 1000, lines, STEP * 500, frameW(v));
      reached = job.t;
      // 範圍只算到這張為止（不含這張剛冒出來的字：新字可能還要再看一張才確認，在這裡停下來的話交給下一次掃描）；暖身的幾張不算
      if (job.t >= job.cov[0]) { job.cov[1] = Math.min(job.end, job.t); done += STEP; }
      // 遮罩版本讀到、而且確定是字幕（不是彈幕）的才算幫上忙；彈幕多的影片白字遮罩會讀到一堆留言
      for (const l of lines) if (l.kind !== 'orig' && vstat[l.kind] && !YTLSOcr.isNoise(l.text, l.h) && tracker.isStill(l.text)) vstat[l.kind].won++;
      ss.feed += performance.now() - tm;
      if (token !== st.token) return;
      // 剩餘時間分兩段講：先掃的「目前位置到結尾」、之後回頭掃的前面（以前只講整份要多久，看起來像整部影片的時間）
      const perSec = (Date.now() - t0) / Math.max(1, done) / 1000;
      const what = '掃描畫面' + (st.talk ? '字幕' : '歌詞') + '中… 已掃到 ' + fmtClock(job.t);
      const stopHint = '再按一次「快速掃描」可停止，掃到的會保留';
      if (done < afterTotal && afterTotal < total) setStatus(what + '（掃到結尾約剩 ' + fmtLeft(perSec * (afterTotal - done)) + '，之後回頭掃前面約 ' + fmtLeft(perSec * (total - afterTotal)) + '；' + stopHint + '）');
      else setStatus(what + '（約剩 ' + fmtLeft(perSec * Math.max(0, total - done)) + '；' + stopHint + '）');
    };
    let prev = null;
    try {
     for (const [segA, segB] of plan) {
      if (st.scanCancel || token !== st.token || failed) break;
      const cov = [segA, segA];
      covered.push(cov);
      // 從影片中間開始的段落先往前多看 3 秒暖身（認出在移動的彈幕、留言欄），這幾秒讀到的不收（見 merged）
      const start = segA < 3.25 ? 0.25 : segA - 3;
      let seeking = seekVideo(v, start);
      for (let t = start; t < segB && !st.scanCancel && token === st.token; t += STEP, frame++) {
        let tm = performance.now();
        await seeking;
        for (let k = 0; k < 30 && v.readyState < 2; k++) await sleep(100);
        // 等的這幾秒內換了影片：不要再跳位置（YouTube 換影片沿用同一個 <video>，會把下一部影片跳到這裡）
        if (token !== st.token || st.scanCancel) break;
        // 插播廣告（長度變了）、播放器換了 <video>／卸載（NaN）：不要繼續在錯的影片上跳，也不要標成「掃完了」
        if (video() !== v || !(Math.abs(v.duration - dur) < 1)) { failed = '影片長度變了（可能插播廣告）'; break; }
        ss.seekWait += performance.now() - tm; tm = performance.now();
        const thumb = dbgNoSame ? null : frameThumb(v);
        const same = !!lastSent && sameFrame(lastThumb, thumb);
        const skip = new Set(frame % 4 ? Object.keys(vstat).filter((k) => vstat[k].tried >= 30 && !vstat[k].won) : []);
        const enc = same ? [] : encodeFrame(v, 'full', skip);
        ss.enc += performance.now() - tm;
        // 流水線：這張送去辨識後不等結果，影片直接去下一個位置、下一圈編下一張；
        // 等的是「上一張」的結果，所以截圖編碼、傳送和辨識是同時進行的（以前一張做完才開始下一張）
        seeking = t + STEP < segB ? seekVideo(v, t + STEP) : Promise.resolve();
        // 跟上一張送出的畫面一樣：沿用它的辨識結果（它可能還在辨識中，等一下一起等）
        const job = same ? { t, enc, p: lastSent.p, cov, end: segB } : { t, enc, p: ocrRetry(enc, token), cov, end: segB };
        if (same) ss.same++;
        else { lastSent = job; lastThumb = thumb; }
        job.p.catch(() => {}); // 等一下才 await；先接住免得被當成沒處理的錯誤
        if (dbgSerialScan) { await finish(job); continue; }
        if (prev) await finish(prev);
        prev = job;
      }
      // 這一段的最後一張收完再跳到下一段
      if (prev && token === st.token) await finish(prev);
      prev = null;
     }
    } catch (e) {
      failed = e.message || String(e); // 以前出錯後照樣標成「掃描完成」，後半部永遠沒字幕
    } finally {
      st.scanning = false;
      // 靜音、速度一律還原（掃描途中切了情境或換影片時，以前會一直靜音；YouTube 換影片也是同一個 <video>）；
      // 位置和播放只在還是同一部影片時還原
      v.muted = wasMuted; v.playbackRate = rate;
      if (token === st.token || st.vid === scanVid) { v.currentTime = pos; if (!wasPaused) v.play().catch(() => {}); }
    }
    if (token !== st.token) {
      // 掃描途中切了情境、重新整理、換了影片：已掃到的部分照樣存起來（存在原本那部影片底下），回來按「繼續掃描」接著做。
      // 以前直接丟掉（重新開始時 st.vid 已經清掉，reset 裡的存檔也存不到），掃到 60% 的兩小時存檔全部白做
      if (scanVid && covered.some(([a, b]) => b > a)) {
        const r = rangesAfter(), full = !scanPlan(r, 0, dur).length;
        chrome.storage.local.set({ ['ocr:' + scanVid]: { ...merged().save(), scanned: full, ranges: full ? [] : r, t: Date.now() } }).catch(() => {});
      }
      return;
    }
    const ranges = rangesAfter();
    const cancelled = !!scanPlan(ranges, 0, dur).length; // 還有沒掃到的段落（停止、出錯、長度變了）不算掃完
    const scannedSome = covered.some(([a, b]) => b > a);
    // 掃到的段落換成新結果，其他地方保留原本的
    const result = scannedSome ? merged() : st.ocr;
    const found = result ? result.all() : [];
    // 完整掃完的標成「已掃描」：之後打開這部影片直接用，不再邊播邊讀（邊播邊讀比較粗，會把掃描結果蓋掉）
    if (scannedSome && found.length) { st.ocr = result; st.ocrScanned = !cancelled; st.ocrRanges = cancelled ? ranges : []; saveOcr(true); }
    renderTracks();
    if (failed && !scannedSome) { setStatus('掃描中斷：' + failed); return; }
    if (!found.length) { setStatus(cancelled ? '掃描停止了，掃過的部分畫面上沒讀到' + (st.talk ? '字幕' : '歌詞') + '。' : '掃描完了，但畫面上沒讀到歌詞。'); return; }
    // 有說明欄／原曲歌詞時：用掃到的畫面歌詞重新對時；沒有的話直接用畫面歌詞
    if (st.aligned) await usePlainLines(st.aligned.lines, st.aligned.label, token, false, st.aligned.prior);
    else await useOcr(token, false, false);
    if (token !== st.token) return;
    // 記住這部影片用的來源，重新整理後一樣
    if (!cancelled && st.choice) await setPref({ choice: st.choice });
    if (failed) setStatus(st.status + '　（掃描在 ' + fmtClock(reached) + ' 中斷：' + failed + '；掃到的保留，再按「繼續掃描」會接著掃還沒掃的）');
    else setStatus(st.status + '　（掃描' + (cancelled ? '在 ' + fmtClock(reached) + ' 停止，掃過的部分已換成新結果；再按「繼續掃描」會接著掃還沒掃的；' : '完成，以後打開直接用，不用再掃；') + '共 ' + found.length + ' 句）');
  }

  let ocrBusy = false, ocrLastTick = 0, ocrBusyUntil = 0;
  async function ocrTick() {
    if (ocrBusy || !settings.enabled || st.scanning || Date.now() < ocrBusyUntil) return;
    if (!ocrWanted()) { if (settings.ocr && st.info && Date.now() - ocrPingAt > 20000) pingOcr(); return; }
    const v = video();
    if (!v || v.paused || v.ended || v.readyState < 2 || !v.videoWidth) return;
    // 快速掃描過的段落：掃描結果比邊播邊讀準，不要再疊一份上去
    if (inRanges(st.ocrRanges, v.currentTime)) return;
    const token = st.token, tracker = st.ocr;
    ocrBusy = true;
    try {
      const t = v.currentTime * 1000;
      const now = Date.now();
      if (ocrLastTick && now - ocrLastTick < 3000) st.ocrPlayed += now - ocrLastTick;
      ocrLastTick = now;
      // 原尺寸畫面（縮小會讀不到細字）＋白字遮罩（MV 副歌的大白字）
      const lines = await ocrFrame(v, 'live');
      if (token !== st.token || tracker !== st.ocr || st.scanning) return;
      // 又讀得到了（顯示卡讓完、服務不忙了）：把狀態列的「暫停」換回來
      if (st.kind === 'ocr' && /（OCR）　(暫停讀畫面|OCR 服務在忙)|^好，這次照用顯示卡|^OCR 服務連不上/.test(st.status || '')) setStatus(ocrUsingText());
      const changed = tracker.feed(t, lines, undefined, frameW(v));
      if (changed) onOcrChange(token);
      saveOcr(false);
      // 看影片：播了 90 秒都沒讀到像字幕的字（畫面下半部）就不讀了，省顯示卡
      if (st.scene === 'video' && st.kind !== 'ocr' && st.ocrPlayed > 90000 && tracker.all().filter(subLike).length < 2) st.ocrGaveUp = true;
      // 自動選到 OCR、播了 60 秒畫面上都沒有歌詞：退回自動字幕
      if (st.kind === 'ocr' && !st.manual && !tracker.all().length && st.ocrPlayed > 60000) {
        const asr = st.info.tracks.filter((x) => x.kind === 'asr');
        const tr = asr.find((x) => /^ja/i.test(x.languageCode)) || asr[0];
        if (tr) await useTrack(tr, token, false);
      }
    } catch (e) {
      if (e.gpuYield) {
        noteYield(e.gpuYield);
        ocrBusyUntil = Date.now() + 10000;
        if (st.kind === 'ocr') setStatus('使用中：' + ocrWhat() + '（OCR）　暫停讀畫面：' + yieldText(e.gpuYield));
        return;
      }
      // 回應太慢（顯示卡被 ComfyUI 之類佔滿）≠ 服務沒開：還 ping 得到就只是暫停一下，不標成「未啟動」
      let alive = false;
      try { alive = await bg('ocrPing', {}); } catch (e2) { /* 當作沒開 */ }
      ocrPingAt = Date.now();
      if (alive) {
        ocrBusyUntil = Date.now() + 8000;
        if (st.kind === 'ocr') setStatus('使用中：' + ocrWhat() + '（OCR）　OCR 服務在忙（顯示卡被其他程式佔用），稍後自動繼續');
      } else {
        ocrOk = false;
        if (st.kind === 'ocr') setStatus('OCR 服務連不上：可以在面板按「▶ 啟動本機服務」');
      }
      renderTracks();
    } finally { ocrBusy = false; }
  }

  async function onOcrChange(token) {
    if (st.kind === 'ocr') {
      // 沿用原本的句子物件（只更新時間、位置）：翻譯中的標記、正在翻的那批都還認得它們。以前每次都換成新物件，
      // 翻到一半的那批被當成「已經不用了」丟掉，沒有「翻譯中」標記的新物件又整批重送，同時好幾個整批請求
      const old = new Map(), trOf = new Map();
      for (const c of st.cues) { (old.get(c.text) || old.set(c.text, []).get(c.text)).push(c); if (c.tr) trOf.set(c.text, c); }
      const cues = st.ocr.all().map((c) => {
        const arr = old.get(c.text), o = arr && arr.shift();
        if (o) return Object.assign(o, c);
        const t = trOf.get(c.text); // 同一句又出現一次（副歌）：翻譯直接沿用
        return t ? { ...c, tr: t.tr, ro: t.ro, rb: t.rb } : c;
      });
      st.cues = cues; st.nz = null; st.ktvKey = null;
      renderFull(); renderLine(true);
      if (st.scene === 'video') applySettingsToUI(); // 影片字幕的位置可能更清楚了：重新避開
      setStatus('使用中：畫面' + (st.talk ? '字幕' : '歌詞') + '（OCR）　已記錄 ' + cues.length + ' 句');
      const todo = cues.filter((c) => !c.tr && !c.pending);
      if (todo.length) {
        todo.forEach((c) => { c.pending = true; });
        const tl = settings.targetLang;
        try {
          const res = await bg('translate', { lines: todo.map((c) => c.text), tl, romaji: true, vid: st.vid });
          if (token !== st.token || tl !== settings.targetLang) return; // 途中換了翻譯語言：舊語言的結果不要寫進去（之後就不會再翻）
          todo.forEach((c, k) => applyTr(c, res, k));
          if (!st.srcLang && res.lang) st.srcLang = res.lang;
          renderLine(true); renderFull();
        } catch (e) { /* 下次換句再試 */ } finally {
          todo.forEach((c) => { c.pending = false; }); // 以前失敗後一直標著「翻譯中」，那幾句永遠不會再翻
        }
      }
      return;
    }
    // 用畫面歌詞重新對時：多了 3 句以上、且距離上次 15 秒以上
    if (st.aligned && st.ocr.all().length - st.ocrAlignedCount >= 3 && Date.now() - st.ocrAlignedAt > 15000) {
      st.ocrAlignedAt = Date.now();
      await usePlainLines(st.aligned.lines, st.aligned.label, token, true, st.aligned.prior);
    }
    // 自動字幕或什麼都沒有時，畫面上一出現歌詞就改用 OCR；
    // AI 聽寫（歌曲）會有錯字，畫面上確實有歌詞（讀到 4 句以上）就改用畫面上的原文
    // （要跟聽寫內容對得上，避免把招牌、標題這類畫面文字當成歌詞）
    const O = globalThis.YTLSOcr;
    const matchListen = () => st.kind === 'listen' &&
      st.ocr.all().filter((o) => st.cues.some((c) => O.sim(o.text, c.text) >= 0.5 || O.contain(o.text, c.text) >= 0.7)).length >= 3;
    if (st.manual) return;
    if (st.scene === 'video') {
      // 看影片：影片自己有燒好的日文字幕（畫面下半部、跟 AI 聽寫的內容對得上，或已經讀到 6 句以上）→ 改用畫面字幕（人做的字幕比聽寫準）
      const low = st.ocr.all().filter(subLike).length;
      const weak = st.kind === null || st.kind === 'listen' || (st.kind === 'yt' && st.isAsr);
      // AI 聽寫正在用時一定要跟聽寫內容對得上才換（以前讀到 6 句就換：遊戲回放畫面下方的介面字、聊天訊息累積起來，
      // 把好好的 AI 聽寫換成一直沒字幕的畫面字幕）；沒有來源、只有自動字幕時讀到 6 句也算
      if (weak && low >= 3 && (matchListen() || (st.kind !== 'listen' && low >= 6))) {
        await useOcr(token, false, true);
        if (token === st.token && st.kind === 'ocr') setStatus(st.status + '　※ 偵測到影片自己有日文字幕，改用畫面字幕；想一次準備好整部可以按「⚡ 快速掃描」');
      }
      return;
    }
    if ((st.kind === null || (st.kind === 'yt' && st.isAsr) || (!st.talk && matchListen())) && st.ocr.all().length >= 2) {
      await useOcr(token, false, true);
    }
  }

  // 看起來像影片自己燒好的字幕：在畫面下半部，而且大致置中
  // （遊戲實況左下角的聊天訊息「○○がゲームに参加しました」、角落的介面文字也在下半部，但靠邊，不算）
  function subLike(c) {
    if (!(c.y >= 540)) return false;
    if (c.x0 == null || c.x1 == null) return true; // 舊版存的紀錄沒有左右範圍
    const v = video();
    const fw = v && v.videoHeight ? 1080 * v.videoWidth / v.videoHeight : 1920;
    return Math.abs((c.x0 + c.x1) / 2 - fw / 2) <= 0.12 * fw;
  }

  // OCR 結果存在本機，下次看同一部影片直接有完整時間軸
  function saveOcr(force) {
    if (!st.vid || !st.ocr) return;
    if (!force && Date.now() - st.ocrSavedAt < 5000) return;
    st.ocrSavedAt = Date.now();
    const data = { ...st.ocr.save(), scanned: !!st.ocrScanned, ranges: st.ocrScanned ? [] : st.ocrRanges, t: Date.now() }; // t：儲存空間滿了先刪最久沒看的
    if (data.cues.length) chrome.storage.local.set({ ['ocr:' + st.vid]: data }).catch(() => {});
  }

  async function useDesc(token, save = true, auto = false) {
    if (save) st.manual = true; // 在面板上手動點的來源：之後不自動切換
    const lines = descLines();
    if (!lines) { if (!auto) setStatus('說明欄裡找不到歌詞。'); return false; }
    st.choice = { kind: 'desc' };
    renderTracks();
    if (save) await setPref({ choice: st.choice });
    return usePlainLines(lines, '說明欄歌詞', token);
  }

  async function fetchTrackJson(track) {
    const u = new URL(track.baseUrl, location.origin);
    u.searchParams.set('fmt', 'json3');
    u.searchParams.delete('tlang');
    let txt = await fetchText(u.href);
    if (!txt) {
      const pot = await getPotUrl(track);
      if (pot) {
        for (const [k, v] of new URL(pot).searchParams) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
        u.searchParams.set('fmt', 'json3');
        u.searchParams.delete('tlang');
        txt = await fetchText(u.href);
      }
    }
    if (!txt) return null;
    try { return JSON.parse(txt); } catch (e) { return null; }
  }

  async function fetchTrack(track) {
    const vid = st.vid;
    const json = await fetchTrackJson(track);
    if (!json) return [];
    if (track.kind === 'asr' && vid === st.vid && st.asrJson === undefined) st.asrJson = { json, lang: track.languageCode };
    return S.parseJson3(json, { asr: track.kind === 'asr', lang: track.languageCode });
  }

  async function useTrack(track, token, save = true) {
    if (save) st.manual = true; // 在面板上手動點的來源：之後不自動切換
    setStatus('讀取字幕：' + track.name + '…');
    const cues = await fetchTrack(track);
    if (token !== st.token) return true;
    if (!cues.length) { setStatus('字幕「' + track.name + '」讀取失敗。'); return false; }
    const isAsr = track.kind === 'asr';
    setCues(cues, 'yt', track.name + (isAsr && !/自動|auto/i.test(track.name) ? '（自動產生）' : ''));
    st.isAsr = isAsr;
    if (isAsr) setStatus(st.status + '　※ 自動字幕在配樂段落常亂辨識，已過濾雜訊' + (ocrReady() && !st.talk ? '；畫面上出現歌詞時會改用 OCR' : ''));
    st.srcLang = track.languageCode;
    st.choice = { kind: 'yt', vssId: track.vssId };
    renderTracks();
    if (save) await setPref({ choice: st.choice });
    const nh = await humanTr(token);
    if (token !== st.token) return true;
    if (nh) { setStatus('使用中：' + st.label + '（' + (nh.n >= st.cues.length ? '全部用人工翻譯' : nh.n + ' 句用人工翻譯，其餘機器翻譯') + '）'); renderLine(true); }
    await translateCues(token);
    return true;
  }

  // 影片另外有上傳者提供的「翻譯語言」字幕（例如剪輯台自己做的繁中字幕）：日文照常顯示，中文那行優先用人工翻譯，
  // 對不到時間的句子才用機器翻譯（以前一律丟 Google，人工翻譯放著沒用）
  const langFam = (x) => { x = String(x || '').toLowerCase(); return /^zh-(tw|hk|mo|hant)/.test(x) ? 'zh-hant' : /^zh/.test(x) ? 'zh-hans' : x.split('-')[0]; };
  async function humanTr(token) {
    const tl = settings.targetLang;
    st.label = String(st.label || '').replace(/＋上傳者的.*$/, ''); // 換語言時先拿掉舊的標示
    if (!st.info || !st.srcLang || langFam(st.srcLang) === langFam(tl)) return null;
    const t = (st.info.tracks || []).find((x) => x.kind !== 'asr' && langFam(x.languageCode) === langFam(tl));
    if (!t) return null;
    const json = await fetchTrackJson(t).catch(() => null);
    if (!json || token !== st.token || tl !== settings.targetLang) return null;
    const hs = S.parseJson3(json, { asr: false, lang: t.languageCode }).filter((h) => h.text).sort((a, b) => a.start - b.start);
    let n = 0, j0 = 0;
    for (const c of st.cues) {
      const parts = [];
      while (j0 < hs.length && hs[j0].end <= c.start) j0++;
      for (let j = j0; j < hs.length && hs[j].start < c.end; j++) {
        const h = hs[j], ov = Math.min(c.end, h.end) - Math.max(c.start, h.start);
        if (ov >= 0.5 * Math.min(c.end - c.start, h.end - h.start) && !parts.includes(h.text)) parts.push(h.text);
      }
      if (parts.length) { c.trH = parts.join(' '); c.trHl = tl; c.tr = c.trH; n++; }
    }
    if (n) st.label += '＋上傳者的' + t.name;
    return n ? { n, name: t.name } : null;
  }

  function useOff(save = true) {
    if (save) st.manual = true; // 在面板上手動點的來源：之後不自動切換
    setCues([], null, '');
    st.choice = { kind: 'off' };
    setStatus('已關閉。');
    renderCands(); renderTracks();
    if (save) setPref({ choice: st.choice });
  }

  function setCues(cues, kind, label) {
    if (kind !== 'listen') stopListen(); // 換到別的來源就停止聽寫／擷取聲音
    st.cues = cues; st.kind = kind; st.label = label; st.cur = st.next = -2;
    st.nz = null; st.ktvKey = null; st.aligned = null; st.isAsr = false;
    st.srcLang = '';
    setStatus(label ? '使用中：' + label : '');
    renderFull(); applyNativeHide(); renderLine(true);
  }

  // ---------- 翻譯 ----------
  const TR_PARALLEL = 3; // 同時送幾批翻譯（再多容易被 Google 暫時限流）
  async function translateCues(token) {
    const cues = st.cues;
    if (!cues.length) return;
    st.translating = true; renderStatus();
    const tl = settings.targetLang;
    // 還在用這批句子嗎：換了來源（cues 換掉、裡面也沒有這些句子）、換了影片或翻譯語言就停。
    // AI 聽寫／OCR 加新句子時 st.cues 會換成新陣列，但舊句子還在裡面，要繼續翻（以前會提早結束，那些句子一直空白）
    const stillUsed = (part) => token === st.token && tl === settings.targetLang && (cues === st.cues || st.cues.includes(part[0]));
    let failed = 0, lastErr = '';
    // 句子多（節目字幕上千句）時，從正在看的位置往後先翻、再翻前面（以前從第 1 句翻起，看到第 15 分鐘要等前面全部翻完）
    let seq = cues;
    if (cues.length > 40) {
      const v = video();
      const now = v ? v.currentTime * 1000 - st.offset - 10000 : 0;
      const i0 = Math.max(0, cues.findIndex((c) => (c.end || c.start || 0) >= now));
      seq = i0 > 0 ? cues.slice(i0).concat(cues.slice(0, i0)) : cues;
    }
    const parts = [];
    for (let i = 0; i < seq.length; i += 40) parts.push(seq.slice(i, i + 40));
    let next = 0, stop = false;
    // 一次同時送 3 批（每批 40 句）：長節目全部翻完約快 2.5 倍。照順序領工作，正在看的那段還是最先開始翻
    const worker = async () => {
      while (!stop && next < parts.length) {
        const k = next++, part = parts[k];
        if (!stillUsed(part)) { stop = true; return; }
        // 每批最多試 3 次；還是不行就先跳過這批，不連累後面（以前一批失敗就全部放棄，連假名也沒了）
        let res = null;
        for (let tries = 0; tries < 3 && !stop; tries++) {
          try {
            res = await bg('translate', { lines: part.map((c) => c.text), tl, romaji: true, vid: st.vid });
            if (!res.error) break;
            lastErr = res.error; // 翻譯失敗但假名、拼音有回來：先用，翻譯再試
          } catch (e) { lastErr = e.message; if (/擴充功能已更新/.test(e.message)) { stop = true; return; } }
          if (tries < 2) await sleep(1000 * (tries + 1));
        }
        if (!stillUsed(part)) { stop = true; return; }
        if (!res) { failed += part.length; continue; }
        if (res.error) failed += part.length;
        part.forEach((c, j) => applyTr(c, res, j));
        if (!st.srcLang && res.lang) st.srcLang = res.lang;
        renderLine(true);
        if (k === 0) renderFull();
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(TR_PARALLEL, parts.length) }, worker));
      if (stop) return;
      renderFull();
      if (failed) {
        setStatus((st.label ? '使用中：' + st.label + '　' : '') + '有 ' + failed + ' 句翻譯失敗（' + lastErr + '），30 秒後自動再試');
        setTimeout(() => {
          if (token !== st.token || tl !== settings.targetLang) return;
          const rest = st.cues.filter((c) => c.text && !c.tr);
          if (rest.length) translateList(rest, token);
        }, 30000);
      }
    } finally {
      if (token === st.token) { st.translating = false; renderStatus(); }
    }
  }

  // 補翻一部分句子（前一次失敗跳過的）
  async function translateList(list, token, attempt = 0) {
    const tl = settings.targetLang;
    const later = (rest) => { // 還是沒翻好的：退避再試（30 秒、1、2、4 分鐘），不會只試一次就放棄
      if (attempt < 4 && rest.length) setTimeout(() => {
        if (token === st.token && tl === settings.targetLang) translateList(rest.filter((c) => !c.tr), token, attempt + 1);
      }, 30000 * 2 ** attempt);
    };
    const still = [];
    for (let i = 0; i < list.length; i += 40) {
      const part = list.slice(i, i + 40);
      let res = null;
      try { res = await bg('translate', { lines: part.map((c) => c.text), tl, romaji: true, vid: st.vid }); } catch (e) { res = null; }
      if (token !== st.token || tl !== settings.targetLang) return;
      if (!res || res.error) { later(list.slice(i)); return; }
      part.forEach((c, k) => applyTr(c, res, k));
      still.push(...part.filter((c) => !c.tr));
      renderLine(true);
    }
    renderFull();
    later(still);
    if (token === st.token && st.label && !still.length) setStatus('使用中：' + st.label);
  }

  // 翻譯結果寫回：這次沒拿到的（失敗、限流）保留原本已有的翻譯／假名，不要用空字串蓋掉
  function applyTr(c, res, k) {
    // 上傳者提供的人工翻譯優先（見 humanTr）；機器翻譯只補假名、拼音
    c.tr = (c.trH && c.trHl === settings.targetLang ? c.trH : '') || (res.trans && res.trans[k]) || c.tr || '';
    c.ro = (res.roma && res.roma[k]) || c.ro || '';
    c.rb = (res.ruby && res.ruby[k]) || c.rb || null;
  }

  // ---------- 畫面 ----------
  const ui = {};
  function removeUI() {
    karaStop();
    for (const k of ['overlay', 'panel', 'btn']) if (ui[k]) { ui[k].remove(); ui[k] = null; }
    document.documentElement.classList.remove('ytls-hide-native');
    // 面板開著時離開：播放器（換頁也不會重建）上的「面板開著」要拿掉，不然下一部影片的字幕一直縮在左邊
    const pl = player();
    if (pl) pl.classList.remove('ytls-panel-open');
    document.documentElement.classList.remove('ytls-panel-open');
  }

  // YouTube Music 的播放列（底部那條；頁面裡另有一個隱藏的同名元素）
  const ytmBar = () => document.querySelector('ytmusic-player-bar[slot="player-bar"]') || document.querySelector('ytmusic-player-bar');

  function ensureUI() {
    // 一般 YouTube：疊在播放器裡；YouTube Music：固定在整個畫面上（body）
    const p = IS_YTM ? document.body : player();
    if (!p || (IS_YTM && !player())) return;
    if (!ui.overlay || !p.contains(ui.overlay)) {
      ui.lines = {};
      const line = (cls) => {
        const r = h('div', { class: 'ytls-r' }), o = h('div', { class: 'ytls-o' }), t = h('div', { class: 'ytls-t' });
        ui.lines[cls] = { box: h('div', { class: 'ytls-line ytls-' + cls }, r, o, t), r, o, t };
        return ui.lines[cls].box;
      };
      ui.overlay = h('div', { class: 'ytls-overlay' }, line('cur'), line('next'), line('k0'), line('k1'));
      ui.ktv = [ui.lines.k0, ui.lines.k1];
      p.appendChild(ui.overlay);
      // 每次重建字幕層都加一個監聽器的話，來回換頁幾次後每次縮放都要重算好幾遍：只留一個
      if (IS_YTM) { if (!ui.resizeHooked) { window.addEventListener('resize', () => sizeOverlay()); ui.resizeHooked = true; } }
      else { if (ui.ro) ui.ro.disconnect(); ui.ro = new ResizeObserver(() => sizeOverlay()); ui.ro.observe(p); }
    }
    if (!ui.panel || !p.contains(ui.panel)) {
      buildPanel(p);
      const pc = IS_YTM ? document.documentElement : player();
      if (pc && ui.panel && ui.panel.hidden) pc.classList.remove('ytls-panel-open'); // 新面板是收起來的：字幕不用再讓位
    }
    const ctrls = IS_YTM ? (ytmBar() || document).querySelector('.right-controls-buttons') : p.querySelector('.ytp-right-controls');
    if (ctrls && (!ui.btn || !ctrls.contains(ui.btn))) {
      ui.btn = h('button', { class: 'ytp-button ytls-btn', title: '歌詞字幕（YT 歌詞字幕）', onclick: (e) => { e.stopPropagation(); togglePanel(); } }, '詞');
      ui.btn.addEventListener('click', orphanClick, true);
      ctrls.prepend(ui.btn);
    }
    sizeOverlay(); applySettingsToUI();
  }

  function sizeOverlay() {
    if (!ui.overlay) return;
    if (IS_YTM) { layoutYtm(); return; }
    const p = player();
    if (!p) return;
    const base = Math.max(12, p.clientHeight * 0.045);
    p.style.setProperty('--ytls-base', base + 'px');
  }

  // YouTube Music 的歌詞位置：
  // - 播放頁打開（看得到影片／封面）：像 YouTube 一樣疊在影片下緣，寬度跟著影片
  // - 在逛其他頁面：放在中間內容區（不壓到左側選單）、播放列上方
  // - 面板開著：歌詞右緣停在面板左邊
  const clamp = (a, x, b) => Math.max(a, Math.min(b, x));
  let ytmLayoutKey = '';
  function layoutYtm() {
    if (!IS_YTM || !ui.overlay) return;
    const bar = ytmBar();
    const barH = bar && bar.offsetHeight ? bar.offsetHeight : 72;
    const lay = document.querySelector('ytmusic-app-layout');
    const pl = document.querySelector('ytmusic-player#player') || document.querySelector('ytmusic-player');
    const pr = pl && pl.getBoundingClientRect();
    const open = lay ? lay.hasAttribute('player-page-open') : true;
    const lift = (settings.bottom || 0) / 100; // 「位置」設定：離底部多高
    let l, w, b, base;
    if (open && pr && pr.width >= 240 && pr.height >= 135 && pr.bottom > 60 && pr.top < innerHeight - barH) {
      l = pr.left; w = pr.width;
      b = Math.max(barH + 6, innerHeight - pr.bottom + pr.height * lift);
      base = clamp(14, pr.height * 0.05, 30);
    } else {
      let left = 0;
      for (const g of document.querySelectorAll('#guide-wrapper, #mini-guide')) {
        const r = g.getBoundingClientRect();
        if (r.width > 0 && r.left >= -1 && r.right <= innerWidth / 2) left = Math.max(left, r.right);
      }
      const avail = innerWidth - left;
      w = Math.min(960, avail * 0.9); l = left + (avail - w) / 2;
      b = barH + 8 + innerHeight * lift * 0.25;
      base = clamp(14, innerHeight * 0.028, 26);
    }
    if (ui.panel && !ui.panel.hidden) {
      const p = ui.panel.getBoundingClientRect();
      if (p.width && l + w > p.left - 12) w = Math.max(220, p.left - 12 - l);
    }
    const key = [l, w, b, base].map(Math.round).join(',');
    if (key === ytmLayoutKey) return;
    ytmLayoutKey = key;
    const de = document.documentElement.style;
    de.setProperty('--ytls-l', Math.round(l) + 'px');
    de.setProperty('--ytls-w', Math.round(w) + 'px');
    de.setProperty('--ytls-b', Math.round(b) + 'px');
    de.setProperty('--ytls-base', base.toFixed(1) + 'px');
  }

  function togglePanel(force) {
    if (!ui.panel) return;
    const show = force != null ? force : ui.panel.hidden;
    ui.panel.hidden = !show;
    // 面板開著時字幕縮到面板左邊，卡拉 OK 靠右的那一行才不會被面板蓋住
    const p = IS_YTM ? document.documentElement : player();
    if (p) p.classList.toggle('ytls-panel-open', show);
    if (IS_YTM) layoutYtm();
    if (show) { renderCands(); renderTracks(); renderFull(); }
  }

  function buildPanel(p) {
    const stop = (e) => e.stopPropagation();
    ui.status = h('div', { class: 'ytls-status' });
    ui.q = h('input', { class: 'ytls-q', type: 'text', placeholder: '歌名 歌手', onkeydown: (e) => { if (e.key === 'Enter') doSearch(); } });
    ui.cands = h('div', { class: 'ytls-list' });
    ui.tracks = h('div', { class: 'ytls-list' });
    ui.full = h('div', { class: 'ytls-full' });
    ui.offv = h('span', { class: 'ytls-offv' }, '0.0 秒');

    const tabBtn = (id, label) => h('button', { class: 'ytls-tab', dataset: { tab: id }, onclick: () => showTab(id) }, label);
    ui.scene = h('div', { class: 'ytls-scene' });
    ui.tabs = h('div', { class: 'ytls-tabs' }, tabBtn('src', '來源'), tabBtn('lyr', '歌詞全文'), tabBtn('kara', '伴奏'), tabBtn('set', '顯示設定'));

    const offBtn = (ms, label) => h('button', { onclick: () => changeOffset(ms) }, label);
    const chk = (key, label) => h('label', { class: 'ytls-chk' },
      h('input', { type: 'checkbox', dataset: { set: key }, onchange: (e) => saveSetting(key, e.target.checked) }), label);
    const range = (key, label, min, max, step) => h('label', { class: 'ytls-range' }, label,
      h('input', { type: 'range', min: String(min), max: String(max), step: String(step), dataset: { set: key }, oninput: (e) => saveSetting(key, Number(e.target.value)) }));
    const langSel = h('select', { dataset: { set: 'targetLang' }, onchange: (e) => saveSetting('targetLang', e.target.value) },
      h('option', { value: 'zh-TW' }, '繁體中文'), h('option', { value: 'zh-CN' }, '简体中文'),
      h('option', { value: 'ja' }, '日本語'), h('option', { value: 'en' }, 'English'));

    ui.panes = {
      src: h('section', { class: 'ytls-pane' },
        h('div', { class: 'ytls-row' }, ui.q, h('button', { class: 'ytls-primary', onclick: doSearch }, '搜尋歌詞')),
        h('div', { class: 'ytls-sub' }, '同步歌詞候選（LRCLIB）'), ui.cands,
        h('div', { class: 'ytls-sub' }, '影片自帶的歌詞／字幕'), ui.tracks,
        h('div', { class: 'ytls-row' }, h('button', { onclick: () => useOff(true) }, '關閉這部影片的字幕'))),
      lyr: h('section', { class: 'ytls-pane' }, ui.full),
      kara: h('section', { class: 'ytls-pane' },
        h('div', { class: 'ytls-sub' }, '真‧卡拉 OK：消掉原唱，只留伴奏'),
        chk('kara', '開啟（音樂影片會自動開；YouTube／niconico／B 站上的伴奏優先，找不到就 AI 去人聲）'),
        ui.karaInfo = h('div', { class: 'ytls-kinfo' }),
        h('div', { class: 'ytls-row' },
          ui.karaRetry = h('button', { onclick: () => karaStart(true, 'auto') }, '重新找伴奏'),
          ui.karaAi = h('button', { onclick: () => karaStart(true, 'ai') }, '改用 AI 去人聲')),
        h('div', { class: 'ytls-sub' }, '升降 Key（伴奏變調）'),
        h('div', { class: 'ytls-row ytls-off' }, ...(ui.keyBtns = [
          h('button', { onclick: () => karaSetKey(kara.keyWant - 1) }, '♭ −1'),
          ui.keyv = h('span', { class: 'ytls-offv' }, '原調'),
          h('button', { onclick: () => karaSetKey(kara.keyWant + 1) }, '♯ +1'),
          h('button', { onclick: () => karaSetKey(0) }, '原調'),
        ])),
        ui.keyHint = h('div', { class: 'ytls-hint' }),
        range('karaVol', '伴奏音量', 0, 1, 0.05),
        range('guideVol', '原唱音量（導唱，0 = 完全消掉）', 0, 1, 0.05),
        h('div', { class: 'ytls-hint' }, '伴奏跟著 YouTube 的音量和靜音走。第一次做一首歌約 30 秒～1 分鐘（下載、找官方伴奏和 AI 去人聲同時進行），做過的歌存起來，之後（包括重新整理）直接有。需要開著本機 AI 聽寫服務。')),
      set: h('section', { class: 'ytls-pane' },
        h('div', { class: 'ytls-sub' }, '時間偏移（這部影片）'),
        h('div', { class: 'ytls-row ytls-off' }, offBtn(-500, '−0.5'), offBtn(-100, '−0.1'), ui.offv, offBtn(100, '+0.1'), offBtn(500, '+0.5'), offBtn(0, '歸零')),
        h('div', { class: 'ytls-hint' }, '歌詞比歌聲早出現 → 按 +；晚出現 → 按 −'),
        h('div', { class: 'ytls-sub' }, '顯示'),
        chk('showOrig', '原文（日文）'), chk('showFurigana', '假名標註（漢字上方）'), chk('showRoma', '羅馬拼音'), chk('showTrans', '翻譯'),
        h('div', { class: 'ytls-row' }, '排版 ',
          h('select', { dataset: { set: 'layout' }, onchange: (e) => saveSetting('layout', e.target.value) },
            h('option', { value: 'ktv' }, '卡拉 OK（兩行交錯、逐字填色）'), h('option', { value: 'stack' }, '置中（目前句＋下一句）'))),
        chk('showNext', '預告下一句（置中排版）'), chk('karaoke', '填色（置中排版）'), chk('hideNative', '隱藏 YouTube 原本的字幕'),
        chk('talkView', '節目／直播自動切換顯示（照「字幕顯示」的選擇：只顯示中文／中日都顯示／只顯示日文，不顯示羅馬拼音）'),
        chk('ocr', '讀取畫面上的歌詞（OCR，需開本機 OCR 服務）'),
        h('div', { class: 'ytls-row' }, '翻譯成 ', langSel),
        range('fontScale', '字體大小', 0.6, 2, 0.1), range('bottom', '離底部距離', 2, 45, 1)),
    };
    ui.panel = h('div', { class: 'ytls-panel', hidden: true },
      h('div', { class: 'ytls-head' },
        h('b', null, 'YT 歌詞字幕 v' + ((chrome.runtime.getManifest && chrome.runtime.getManifest().version) || 'dev')),
        h('span', null,
          h('button', { class: 'ytls-x', title: '重新載入這部影片的字幕（已掃描的畫面字幕、翻譯都會保留，不用重掃）', onclick: () => refreshVideo() }, '↻'),
          h('button', { class: 'ytls-x', onclick: () => togglePanel(false) }, '✕'))),
      ui.scene, ui.status, ui.tabs, ...Object.values(ui.panes));
    for (const ev of ['click', 'dblclick', 'mousedown', 'mouseup', 'keydown', 'keyup', 'keypress', 'wheel', 'contextmenu']) ui.panel.addEventListener(ev, stop);
    ui.panel.addEventListener('click', orphanClick, true);
    p.appendChild(ui.panel);
    showTab('src');
    renderStatus(); renderOffset(); renderKara(); renderScene();
  }

  // 情境列：唱歌／看影片／直播（自動判斷，可以手動換；正在直播的固定是直播）
  function renderScene() {
    if (!ui.scene) return;
    ui.scene.hidden = IS_YTM || !st.info;
    if (ui.scene.hidden) return;
    const live = !!st.info.isLive;
    const chip = (id, label) => h('button', {
      class: 'ytls-chip' + (st.scene === id ? ' on' : ''), disabled: live ? id !== 'live' : id === 'live',
      title: id === 'live' ? '直播中的影片：AI 即時聽寫＋翻譯' : '', onclick: () => setScene(id),
    }, label + (st.scene === id && st.scene === st.sceneAuto ? '・自動' : ''));
    const rows = [h('div', { class: 'ytls-row' }, chip('song', '🎤 唱歌'), chip('video', '🎬 看影片'), chip('live', '📡 直播'))];
    if (st.scene === 'video' || st.scene === 'live') {
      const opt = (v, label) => h('button', { class: 'ytls-chip sm' + (settings.vidView === v ? ' on' : ''), onclick: () => saveSetting('vidView', v) }, label);
      rows.push(h('div', { class: 'ytls-row ytls-vv' }, h('span', null, '字幕顯示'), opt('zh', '只顯示中文'), opt('both', '中日都顯示'), opt('ja', '只顯示日文')));
    }
    ui.scene.replaceChildren(...rows);
  }

  function showTab(id) {
    ui.curTab = id;
    for (const [k, el] of Object.entries(ui.panes)) el.hidden = k !== id;
    for (const b of ui.tabs.children) b.classList.toggle('on', b.dataset.tab === id);
    if (id === 'lyr') renderFull(true);
  }

  async function doSearch() {
    const q = ui.q.value.trim();
    if (!q || !st.info) return;
    const token = st.token;
    setStatus('搜尋「' + q + '」…');
    try {
      const r = await searchLyrics([q]);
      if (token !== st.token) return;
      setStatus(r.length ? '找到 ' + r.length + ' 筆，點一筆來套用。' : '沒找到，換個寫法試試（例如只打歌名，或用日文原名）。');
    } catch (e) { setStatus('搜尋失敗：' + e.message); }
  }

  function renderStatus() {
    if (!ui.status) return;
    ui.status.textContent = st.status + (st.translating ? '　翻譯中…' : '');
  }

  function renderCands() {
    if (!ui.cands) return;
    ui.cands.replaceChildren(...(st.candidates.length ? st.candidates.slice(0, 20).map((c) => {
      const on = st.choice && st.choice.kind === 'lrc' && st.choice.id === c.id;
      const tags = [];
      tags.push(c.syncedLyrics ? '同步' : c.plainLyrics ? '無時間軸' : '無歌詞');
      if (c.instrumental) tags.push('伴奏');
      if (st.info && c.duration) {
        const d = Math.round(c.duration - st.info.lengthSeconds);
        tags.push(S.fmtTime(c.duration) + (Math.abs(d) <= 2 ? '' : '（' + (d > 0 ? '+' : '') + d + 's）'));
      }
      return h('button', { class: 'ytls-item' + (on ? ' on' : ''), title: c.albumName || '', onclick: () => pickCand(c) },
        h('span', { class: 'ytls-name' }, (c.trackName || '?') + ' — ' + (c.artistName || '?')),
        h('span', { class: 'ytls-tag' }, tags.join(' · ')));
    }) : [h('div', { class: 'ytls-empty' }, '（還沒有候選）')]));
  }

  async function pickCand(c) {
    const token = st.token;
    await useLyrics(c, token, true);
  }

  function renderTracks() {
    if (!ui.tracks || !st.info) return;
    const list = st.info.tracks;
    const items = [];
    // YouTube Music 官方歌詞：面板第一次打開時順便查（查過就記住）
    if (st.ytm === undefined && !st.ytmLoading) { st.ytmLoading = true; findYtm(false).finally(() => { st.ytmLoading = false; }); }
    if (st.ytm) {
      const on = st.choice && st.choice.kind === 'ytm';
      items.push(h('button', { class: 'ytls-item' + (on ? ' on' : ''), onclick: () => useYtm(st.token, true) },
        h('span', { class: 'ytls-name' }, 'YouTube Music 歌詞（' + st.ytm.lines.length + ' 行）' + (st.ytm.viaSearch ? '・原曲' : '')),
        h('span', { class: 'ytls-tag' }, (st.ytm.prior ? '逐句時間' : '自動對時') + (st.ytm.source ? '・' + st.ytm.source : ''))));
    } else if (st.ytm === null && !st.ytmSearched) {
      items.push(h('button', { class: 'ytls-item', onclick: () => useYtm(st.token, true, false, true) },
        h('span', { class: 'ytls-name' }, 'YouTube Music 搜原曲歌詞'), h('span', { class: 'ytls-tag' }, '翻唱用')));
    }
    const desc = descLines();
    if (desc) {
      const on = st.choice && st.choice.kind === 'desc';
      items.push(h('button', { class: 'ytls-item' + (on ? ' on' : ''), onclick: () => useDesc(st.token, true) },
        h('span', { class: 'ytls-name' }, '說明欄歌詞（' + desc.length + ' 行）'), h('span', { class: 'ytls-tag' }, '自動對時')));
    }
    if (!IS_YTM && !HAS.ocr()) { // 沒安裝：留一行讓人知道有這個功能、怎麼加
      items.push(h('button', { class: 'ytls-item', onclick: () => setStatus(notInstalled('畫面字幕（OCR）', 2)) },
        h('span', { class: 'ytls-name' }, '畫面上的' + (st.talk ? '字幕' : '歌詞') + '（OCR）'), h('span', { class: 'ytls-tag' }, '沒安裝')));
    } else if (!IS_YTM) { // YouTube Music 不讀畫面（ocrWanted 也排除了），不要放一個選了也不會動的來源
      const on = st.kind === 'ocr';
      const n = st.ocr ? st.ocr.all().length : 0;
      items.push(h('button', { class: 'ytls-item' + (on ? ' on' : ''), onclick: () => useOcr(st.token, true) },
        h('span', { class: 'ytls-name' }, '畫面上的歌詞（OCR）' + (n ? '・已記錄 ' + n + ' 句' : '')),
        h('span', { class: 'ytls-tag' }, !settings.ocr ? '已關閉' : !ocrOk ? '服務未連上' : yieldNow() ? '暫停（顯示卡讓給 ' + yieldNow() + '）' : Date.now() < ocrBusyUntil ? '忙碌中（顯示卡被佔用）' : '服務已連線')));
      if (settings.ocr && (ocrOk || st.ocrScanned)) {
        items.push(h('button', { class: 'ytls-item ytls-scan' + (st.scanning ? ' on' : ''), onclick: () => scanOcr() },
          h('span', { class: 'ytls-name' }, st.scanning ? '■ 停止掃描' : st.ocrScanned ? '✓ 已掃描過（' + n + ' 句）・從目前位置重新掃描' : st.ocrRanges.length ? '⚡ 繼續掃描（從目前位置，掃過的跳過）' : '⚡ 快速掃描畫面' + (st.talk ? '字幕' : '歌詞') + '（從目前位置開始）'),
          h('span', { class: 'ytls-tag ytls-scan-eta' }, st.scanning ? '掃描中…' : scanEtaText())));
      }
    }
    {
      // AI 聽寫：直播回放、節目這類沒字幕的影片
      if (HAS.listen() && listenOk === null && Date.now() - listenPingAt > 20000) pingListen();
      const on = st.kind === 'listen';
      items.push(h('button', { class: 'ytls-item' + (on ? ' on' : ''), onclick: () => useListen(st.token, true) },
        h('span', { class: 'ytls-name' }, 'AI 聽寫（Whisper）' + (st.info && st.info.isLive ? '・直播中' : st.talk ? '' : '・歌曲')),
        h('span', { class: 'ytls-tag' }, !HAS.listen() ? '沒安裝' : !canListen() ? '要開雲端聽寫' : listenOk ? '服務已連線' : '服務未連上')));
      // 雲端聽寫的設定（選雲端、填 Groq 金鑰）在工具列的擴充功能小視窗裡，不好找：面板上放一個入口
      if (HAS.listen()) {
        items.push(h('button', { class: 'ytls-item ytls-scan', onclick: () => bg('openSettings', {}).then(
          (how) => { if (how === 'tab') setStatus('雲端聽寫設定開在新分頁了：「AI 聽寫」選「雲端」，照上面的步驟填金鑰'); },
          (e) => setStatus('打不開設定：' + e.message + '（點 Edge 工具列的擴充功能圖示 → YT 歌詞字幕）')) },
          h('span', { class: 'ytls-name' }, '☁ 雲端聽寫設定'),
          h('span', { class: 'ytls-tag' }, cloudOn ? '使用中（Groq）' : HAS.local() ? '不用顯示卡，填免費金鑰就能用' : '要填免費金鑰')));
      }
      // 顯示卡讓給別的程式中：可以硬用（這一輪不讓，對方結束後恢復）
      const gy = yieldNow();
      if (gy) {
        items.push(h('button', { class: 'ytls-item ytls-scan', onclick: () => overrideYield() },
          h('span', { class: 'ytls-name' }, '⏸ 顯示卡讓給 ' + gy + ' 中・這次照用'),
          h('span', { class: 'ytls-tag' }, '不按也會在它用完後自動繼續')));
      }
      // 任何一個服務連不上：放一顆啟動鈕（OCR 在設定裡關掉的、沒安裝的不算）
      if ((HAS.ocr() && settings.ocr && !ocrOk) || (HAS.listen() && !listenOk)) {
        items.push(h('button', { class: 'ytls-item ytls-scan' + (starting ? ' on' : ''), onclick: () => startLocalServices() },
          h('span', { class: 'ytls-name' }, starting ? '啟動中…' : '▶ 啟動本機服務（' + (HAS.listen() ? 'OCR＋AI 聽寫' : 'OCR') + '）'),
          h('span', { class: 'ytls-tag' }, '在背景開，約 5 秒')));
      }
    }
    for (const t of list) {
      const on = st.choice && st.choice.kind === 'yt' && st.choice.vssId === t.vssId;
      items.push(h('button', { class: 'ytls-item' + (on ? ' on' : ''), onclick: () => useTrack(t, st.token, true) },
        h('span', { class: 'ytls-name' }, t.name), h('span', { class: 'ytls-tag' }, t.kind === 'asr' ? '自動產生' : '上傳者提供')));
    }
    ui.tracks.replaceChildren(...(items.length ? items : [h('div', { class: 'ytls-empty' }, '（這部影片沒有字幕軌）')]));
  }

  function renderFull(scroll) {
    if (!ui.full) return;
    if (ui.panel && ui.panel.hidden) return;
    if (!st.cues.length) { ui.full.replaceChildren(h('div', { class: 'ytls-empty' }, '（目前沒有歌詞／字幕）')); return; }
    ui.fullRows = st.cues.map((c, i) => {
      if (!c.text) return h('div', { class: 'ytls-gap' }, '♪');
      const row = h('div', { class: 'ytls-fl', onclick: () => seekTo(i) },
        settings.showRoma && showRomaFor(c) ? h('div', { class: 'ytls-fr' }, c.ro) : null,
        h('div', { class: 'ytls-fo' }, origNodes(c)),
        c.tr && !sameText(c.tr, c.text) ? h('div', { class: 'ytls-ft' }, c.tr) : null);
      return row;
    });
    ui.full.replaceChildren(...ui.fullRows);
    highlightFull(scroll);
  }

  function highlightFull(scroll) {
    if (!ui.fullRows || !ui.panel || ui.panel.hidden || ui.curTab !== 'lyr') return;
    ui.fullRows.forEach((r, i) => r.classList.toggle('on', i === st.cur));
    const row = ui.fullRows[st.cur];
    if (row) {
      const box = ui.panes.lyr; // 真正會捲動的是分頁容器
      const top = row.offsetTop - box.offsetTop - box.clientHeight / 2 + row.clientHeight / 2;
      box.scrollTo({ top, behavior: scroll ? 'auto' : 'smooth' });
    }
  }

  function seekTo(i) {
    const c = st.cues[i], v = video();
    if (!c || !v || c.start < 0) return;
    v.currentTime = Math.max(0, (c.start + st.offset) / 1000);
  }

  function sameText(a, b) { return S.norm(a) === S.norm(b); }
  function showRomaFor(c) {
    if (!c.ro || sameText(c.ro, c.text)) return false;
    const l = langKey(st.srcLang);
    return l === 'ja' || l === 'ko' || (!st.srcLang && /[぀-ヿ]/.test(c.text));
  }

  async function changeOffset(ms) {
    st.offset = ms === 0 ? 0 : st.offset + ms;
    renderOffset(); renderLine(true);
    await setPref({ offset: st.offset });
  }
  function renderOffset() {
    if (ui.offv) ui.offv.textContent = (st.offset >= 0 ? '+' : '') + (st.offset / 1000).toFixed(1) + ' 秒';
  }

  function applyNativeHide() {
    const on = settings.enabled && settings.hideNative && (st.kind === 'lrc' || st.kind === 'yt' || st.kind === 'ocr' || st.kind === 'listen');
    document.documentElement.classList.toggle('ytls-hide-native', on);
  }

  function applySettingsToUI() {
    renderScene();
    const p = IS_YTM ? document.documentElement : player();
    if (p) {
      p.style.setProperty('--ytls-scale', settings.fontScale);
      if (IS_YTM) { ytmLayoutKey = ''; layoutYtm(); } // YouTube Music 的位置由 layoutYtm() 算
      else p.style.setProperty('--ytls-bottom', Math.max(settings.bottom, burnedLift()) + '%');
    }
    if (ui.panel) {
      for (const el of ui.panel.querySelectorAll('[data-set]')) {
        const v = settings[el.dataset.set];
        if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
      }
    }
    applyNativeHide();
    renderLine(true);
  }

  // 拉桿拖動時每一格都會觸發：畫面馬上套用，存檔等放手（停 0.4 秒）再寫一次。
  // 以前每格都直接寫 chrome.storage.sync，超過每分鐘 120 次的寫入上限後會被拒絕，最後的值就沒存到。
  const saveTimers = {};
  function saveSetting(key, value) {
    const write = () => chrome.storage.sync.set({ [storeKey(key)]: value }).catch((e) => console.warn('[ytls] 設定沒存到', key, e));
    if (!RANGE_KEYS.includes(key)) return write();
    // 自動避開影片字幕時拉「離底部距離」：這部影片改聽使用者的（以前取兩者較大的，往下拉沒反應）
    if (key === 'bottom' && !IS_YTM && !st.noLift && burnedLift() > 0) { st.noLift = true; setPref({ noLift: true }); }
    settings[key] = value; applySettingsToUI(); karaTick();
    clearTimeout(saveTimers[key]);
    saveTimers[key] = setTimeout(write, 400);
  }

  // 原文：有假名資料就用 <ruby> 把讀音標在漢字上方
  function origNodes(c) {
    if (!settings.showFurigana || !c.rb || !c.rb.length) return [c.text];
    return c.rb.map((s) => (s.r ? h('ruby', null, s.t, h('rt', null, s.r)) : s.t));
  }

  // 要顯示哪幾行：唱歌照「顯示設定」；看影片／直播自動決定
  // - 影片本來就有字幕（字幕軌、畫面上燒好的字幕）：照「看影片」的選擇，只顯示中文或中日都顯示
  // - 沒字幕、靠 AI 聽寫：日文＋中文（不顯示羅馬拼音）
  function lineView(c) {
    const base = { orig: settings.showOrig, roma: settings.showRoma, trans: settings.showTrans };
    if (!st.talk || !settings.talkView) return base;
    const hasTr = c && c.tr && !sameText(c.tr, c.text);
    if ((st.kind === 'yt' || st.kind === 'ocr' || st.kind === 'listen') && settings.vidView === 'ja') return { orig: true, roma: false, trans: false };
    if (st.kind === 'yt' || st.kind === 'ocr') {
      if (settings.vidView === 'both') return { orig: true, roma: false, trans: true };
      // 只顯示中文：翻譯還沒好時，字幕軌先顯示原文；畫面上燒好的字幕本來就看得到，先不顯示
      return hasTr ? { orig: false, roma: false, trans: true } : { orig: st.kind === 'yt', roma: false, trans: false };
    }
    if (st.kind === 'listen') {
      // AI 聽寫（v1.0.5 起也照「只顯示中文／中日都顯示」）：翻譯還沒好時先顯示日文
      if (settings.vidView === 'both') return { orig: true, roma: false, trans: true };
      return hasTr ? { orig: false, roma: false, trans: true } : { orig: true, roma: false, trans: false };
    }
    return base;
  }

  // 看影片時影片自己燒在畫面下方的字幕：把我們的字幕抬到它上面，不要蓋住（回傳離底部的百分比，0 = 不用抬）
  // 只有字幕集中在畫面下方同一條帶子時才抬：遊戲直播畫面中間常有一堆遊戲文字（記分板、物品名稱），
  // 以前取「偏高的那 20%」，字幕會被抬到快一半高。使用者自己拉過「離底部距離」的影片不再自動抬。
  function burnedLift() {
    if (st.scene !== 'video' || st.kind !== 'ocr' || !st.ocr || st.noLift) return 0;
    const ys = st.ocr.all().filter((c) => subLike(c) && c.h).map((c) => c.y).sort((a, b) => a - b);
    if (ys.length < 5) return 0;
    // 找 160px 高、裝最多句的帶子
    let best = 0, bi = 0;
    for (let i = 0, j = 0; i < ys.length; i++) {
      while (ys[j] < ys[i] - 160) j++;
      if (i - j + 1 > best) { best = i - j + 1; bi = j; }
    }
    const top = ys[bi];
    if (best < ys.length * 0.5 || top < 760) return 0; // 字幕位置不集中，或不在下方 30%：不是燒好的字幕
    return Math.min(35, ((1080 - top) / 1080) * 100 + 2);
  }

  // ---------- 疊字幕 ----------
  function fillLine(L, c, isNext) {
    if (!c || !c.text) { L.box.hidden = true; return; }
    L.box.hidden = false;
    const view = lineView(c);
    const roma = view.roma && showRomaFor(c) ? c.ro : '';
    const tr = view.trans && c.tr && !sameText(c.tr, c.text) ? c.tr : '';
    L.r.textContent = isNext ? '' : roma;
    // 預告行：只顯示中文的模式就預告中文，其他預告原文
    const nextOnlyTrans = isNext && !view.orig && tr;
    L.o.replaceChildren(...(nextOnlyTrans ? [tr] : (view.orig || isNext) ? origNodes(c) : []));
    L.t.textContent = isNext ? '' : tr;
    L.r.hidden = !L.r.textContent; L.o.hidden = !L.o.textContent; L.t.hidden = !L.t.textContent;
  }

  // 一句的填色時間：整句時間通常包含句尾間隔，用字數估一個上限
  function fillProgress(c, t) {
    const chars = [...String(c.text || '').replace(/\s/g, '')].length || 1;
    const dur = Math.max(600, Math.min(c.end - c.start, chars * 330 + 900));
    return Math.min(1, Math.max(0, (t - c.start) / dur));
  }

  // 卡拉 OK 排版：上行靠左、下行靠右，兩行交替；正在唱的那行逐字填色，另一行預告下一句
  function renderKtv(t, i, cur, force) {
    if (!st.nz) {
      st.nz = []; st.rank = new Map();
      st.cues.forEach((c, k) => { if (c.text) { st.rank.set(k, st.nz.length); st.nz.push(k); } });
    }
    let ref = cur;
    if (ref < 0) {
      for (let k = i + 1; k < st.cues.length; k++) if (st.cues[k].text) { ref = k; break; }
      if (ref >= 0 && st.cues[ref].start - t > 6000) ref = -1; // 間奏太長就先收起來
    }
    const slots = [-1, -1];
    if (ref >= 0) {
      const ord = st.rank.get(ref);
      slots[ord % 2] = ref;
      slots[(ord + 1) % 2] = ord + 1 < st.nz.length ? st.nz[ord + 1] : -1;
    }
    const key = slots.join(',');
    if (force || key !== st.ktvKey) {
      st.ktvKey = key;
      ui.ktv.forEach((L, s) => fillLine(L, st.cues[slots[s]], false));
      highlightFull(false);
    }
    ui.ktv.forEach((L, s) => {
      const p = slots[s] >= 0 && slots[s] === cur ? fillProgress(st.cues[cur], t) : 0;
      L.o.style.setProperty('--ytls-p', (p * 100).toFixed(1) + '%');
    });
  }

  function renderLine(force) {
    if (!ui.overlay) return;
    const v = video();
    const timed = st.kind === 'lrc' || st.kind === 'yt' || st.kind === 'ocr' || st.kind === 'listen';
    if (!settings.enabled || !timed || !v || !st.cues.length) {
      ui.overlay.hidden = true; st.cur = st.next = -2; return;
    }
    ui.overlay.hidden = false;
    const t = v.currentTime * 1000 - st.offset;
    const i = S.findIndex(st.cues, t);
    let cur = i >= 0 && t < st.cues[i].end && st.cues[i].text ? i : -1;
    // 最新開始的那句已經結束、但前面還有沒結束的（時間重疊：短的一句插在長句中間）：照樣顯示那句。
    // 以前只看最新那句，它一結束畫面就空了，前面那句明明還在（字幕出現一下就不見）
    if (cur < 0 && i > 0) for (let k = i - 1; k >= Math.max(0, i - 4); k--) if (t < st.cues[k].end && st.cues[k].text) { cur = k; break; }
    const ktv = settings.layout === 'ktv' && !st.talk; // 說話內容用置中排版
    ui.overlay.classList.toggle('ytls-ktv', ktv);
    if (ktv) {
      if (cur !== st.cur) { st.cur = cur; highlightFull(false); }
      renderKtv(t, i, cur, force);
      return;
    }
    let next = -1;
    if (settings.showNext && (st.kind === 'lrc' || st.kind === 'ocr' || (st.kind === 'listen' && !st.info.isLive))) {
      for (let k = i + 1; k < st.cues.length; k++) if (st.cues[k].text) { next = k; break; }
      if (next >= 0 && cur < 0 && st.cues[next].start - t > 6000) next = -1; // 間奏太長就先不預告
    }
    if (force || cur !== st.cur || next !== st.next) {
      st.cur = cur; st.next = next;
      fillLine(ui.lines.cur, st.cues[cur], false);
      fillLine(ui.lines.next, st.cues[next], true);
      ui.overlay.classList.toggle('ytls-k', !!settings.karaoke && st.kind === 'lrc');
      highlightFull(false);
    }
    if (settings.karaoke && cur >= 0) {
      ui.lines.cur.o.style.setProperty('--ytls-p', (fillProgress(st.cues[cur], t) * 100).toFixed(1) + '%');
    }
  }

  let lastFrame = 0;
  function loop() {
    lastFrame = Date.now();
    try { renderLine(false); } catch (e) { /* 單幀錯誤不影響下一幀 */ }
    requestAnimationFrame(loop);
  }
  // 備援：動畫幀停掉時（例如瀏覽器節流）仍每 0.2 秒更新字幕
  setInterval(() => { if (Date.now() - lastFrame > 400) { try { renderLine(false); } catch (e) { /* ignore */ } } }, 200);

  // ---------- 設定 ----------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const before = { ...settings };
    for (const k of Object.keys(DEFAULTS)) {
      const ch = changes[storeKey(k)];
      if (ch) settings[k] = ch.newValue === undefined ? DEFAULTS[k] : ch.newValue;
    }
    if (before.enabled !== settings.enabled) { st.vid = null; onNav(); return; }
    if (before.kara !== settings.kara) { if (settings.kara) karaStart(); else karaStop(); }
    applySettingsToUI();
    renderFull();
    if (before.vidView !== settings.vidView) renderLine(true);
    if (before.targetLang !== settings.targetLang && st.cues.length) {
      st.cues.forEach((c) => { c.tr = ''; c.ro = ''; c.trH = ''; });
      // 換了翻譯語言：影片有上傳者提供的新語言字幕就改用那份人工翻譯（見 humanTr）
      const token = st.token;
      (st.kind === 'yt' ? humanTr(token).catch(() => null) : Promise.resolve(null)).then(() => { if (token === st.token) translateCues(token); });
    }
  });

  async function init() {
    const saved = await chrome.storage.sync.get(null);
    settings = { ...DEFAULTS };
    // Music 還沒自己調過時，先沿用 YouTube 的值
    for (const k of Object.keys(DEFAULTS)) if (storeKey(k) in saved) settings[k] = saved[storeKey(k)]; else if (k in saved) settings[k] = saved[k];
    document.addEventListener('yt-navigate-finish', () => onNav());
    window.addEventListener('popstate', () => setTimeout(onNav, 300));
    // 播放器 DOM 偶爾會被重建，定期確認按鈕與疊層還在
    setInterval(() => {
      // 上次換頁沒拿到影片資訊（播放器很慢、分頁在背景被節流）就一直沒有按鈕和字幕：過 20 秒再試一次
      if (!st.info && settings.enabled && extAlive() && Date.now() - navAt > 20000 && (IS_YTM || location.pathname === '/watch')) { st.vid = null; onNav(); return; }
      if (!st.info || !settings.enabled) return;
      ensureUI();
      // AI 聽寫服務連不上時每 20 秒再問一次（開機後才啟動、或剛好在忙），回來了面板與來源會自動更新
      if (!listenOk && Date.now() - listenPingAt > 20000) pingListen();
    }, 3000);
    setInterval(ocrTick, 700); // 畫面歌詞 OCR：約每 0.7 秒讀一張
    // 掃描按鈕的預計時間跟著目前位置變（面板開著才有這個元素）
    setInterval(() => {
      const el = !st.scanning && document.querySelector('.ytls-scan-eta');
      if (el) { const t = scanEtaText(); if (el.textContent !== t) el.textContent = t; }
    }, 1000);
    // 背景（service worker）閒置 30 秒會被瀏覽器收掉，下次要重載日文字典：有在用的 YouTube 分頁每 25 秒叫它一次
    const keep = () => { if (settings.enabled && st.vid && extAlive() && document.visibilityState === 'visible') bg('keepalive', {}).catch(() => {}); };
    setInterval(keep, 25000);
    setTimeout(keep, 1500); // 一打開就先在背景載字典
    if (IS_YTM) {
      // YouTube Music 換歌（自動播下一首、佇列）不一定觸發換頁事件：每秒問播放器現在是哪首
      let asking = false;
      setInterval(async () => {
        if (asking || !settings.enabled) return;
        asking = true;
        try { const v = await bridge('vid', null, 1500); if (v && v !== st.vid && (st.vid || extAlive())) onNav(); } finally { asking = false; }
      }, 1000);
      // 播放頁開關、視窗縮放、側欄收合：每 0.4 秒重算歌詞位置（沒變就不動）
      setInterval(() => { try { layoutYtm(); } catch (e) { /* ignore */ } }, 400);
    } else pingOcr(true);
    requestAnimationFrame(loop);
    onNav();
  }
  init();
})();
