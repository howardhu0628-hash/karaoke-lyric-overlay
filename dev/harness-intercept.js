// 測試頁 ?ix=1 時在 content.js 之前載入：攔截送給背景的訊息、記錄狀態變化（給自動化測試用）
//   __ix[type] = async (msg) => ({ ok, data })  攔下某種訊息（例如讓對時故意慢、假造聽寫失敗）
//   __cnt[type]  每種訊息送了幾次；__trace  來源／狀態列的變化；__state()  目前狀態（dbg 傾印）
// 伴奏（kara*）預設全部攔下：不要去下載真的影片、用顯示卡去人聲
(() => {
  if (window.__ytlsTest) return;
  const orig = chrome.runtime.sendMessage;
  window.__orig = orig; // 攔截函式裡要照常送出時用（例如等幾秒再送）
  window.__cnt = {}; window.__ix = {}; window.__trace = [];
  chrome.runtime.sendMessage = async (msg) => {
    __cnt[msg.type] = (__cnt[msg.type] || 0) + 1;
    const f = __ix[msg.type] || (/^kara/.test(msg.type) ? __ix.__kara : null);
    if (f) return await f(msg);
    return orig(msg);
  };
  __ix.__kara = async () => ({ ok: false, error: '測試中不做伴奏' });
  const qp = new URLSearchParams(location.search);
  // ?tier=1～4：假裝安裝等級（分級安裝：1 歌詞字幕、2 ＋OCR、3 ＋雲端聽寫＋官方伴奏、4 全部）
  if (qp.get('tier')) __ix.installInfo = async () => ({ ok: true, data: { tier: Number(qp.get('tier')), installed: true } });
  __ix.openSettings = async () => ({ ok: true, data: 'harness' }); // 測試頁沒有 chrome.action／tabs：只記次數
  // ?nolrc=1：不上網搜同步歌詞（測說明欄歌詞、OCR 的流程）
  if (qp.get('nolrc')) __ix.lyricsSearch = async () => ({ ok: true, data: [] });
  // ?nolisten=1：AI 聽寫不送到真的服務，假裝「服務有開、但這部下載不了」（不會去下載影片、用顯示卡）
  //   nolisten=毫秒：過這麼久才回「失敗」（測「狀態列先寫了聽寫中、之後才失敗」）
  //   chunkyield=1：直播片段一律回「顯示卡讓出中＋雲端額度用完」
  if (qp.get('nolisten')) {
    const late = Number(qp.get('nolisten')) > 1 ? Number(qp.get('nolisten')) : 0;
    __ix.listenPing = async () => ({ ok: true, data: true });
    __ix.listenVodStart = async () => ({ ok: true, data: { ok: true } });
    __ix.listenVodStatus = async () => {
      if (late) await new Promise((r) => setTimeout(r, late));
      return { ok: true, data: { ok: true, state: 'error', error: '會員限定（測試）', segments: [], total: 0 } };
    };
    __ix.listenChunk = qp.get('chunkyield')
      ? async () => ({ ok: true, data: { ok: false, yield: 'python', detail: '', segments: [], cloudNote: '雲端免費額度暫時用完，改用本機聽寫（約 10 分鐘後恢復）' } })
      : async () => ({ ok: false, error: '測試中不聽寫' });
  }
  // ?slowalign=毫秒：歌詞對時故意慢一點（測對時途中發生的事）
  if (qp.get('slowalign')) __ix.alignLyrics = async (m) => { await new Promise((r) => setTimeout(r, Number(qp.get('slowalign')))); return orig(m); };
  window.__state = () => {
    window.postMessage({ ns: 'ytls', dir: 'dbg' }, location.origin);
    return new Promise((r) => setTimeout(() => { try { r(JSON.parse(document.documentElement.dataset.ytlsState)); } catch (e) { r(null); } }, 60));
  };
  let last = '';
  window.__tracer = setInterval(async () => {
    const s = await __state();
    if (!s) return;
    const k = s.kind + '|' + s.label + '|' + s.status;
    if (k !== last) { last = k; __trace.push({ t: Math.round(performance.now() / 100) / 10, kind: s.kind, label: s.label, cues: s.cues, status: String(s.status).slice(0, 90) }); }
  }, 400);
  window.__ytlsTest = true;
})();
