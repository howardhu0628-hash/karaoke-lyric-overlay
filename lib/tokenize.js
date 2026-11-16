// 日文斷詞（kuromoji）與歌詞對時：offscreen 文件裡用（service worker 用不了 offscreen 時也直接用這份）。
// 需要先載入 lib/xhr-shim.js、lib/shared.js、lib/furigana.js、lib/align.js、vendor/kuromoji/kuromoji.js。
(function () {
  const F = self.YTLSFuri;
  let tokenizerP = null; // 載好的字典（之後一直用這個）
  let building = null, buildAt = 0;
  const diag = { tries: 0, ok: 0, lastMs: 0, lastErr: '' };

  function getTokenizer() {
    if (tokenizerP) return tokenizerP;
    // 字典載入每個呼叫最多等 30 秒（以前會永遠等下去，之後所有翻譯連假名都卡住）。逾時的只是這次不等，載入照樣繼續，
    // 載好了下次直接用；以前逾時就丟掉、下次從頭再載一份，CPU 很忙時兩份搶同一個執行緒，可能永遠載不好。
    // 真的卡住（2 分鐘還沒好）才重新開始
    if (!building || Date.now() - buildAt > 120000) {
      diag.tries++;
      const t0 = buildAt = Date.now();
      const p = building = new Promise((resolve, reject) => {
        try {
          self.kuromoji.builder({ dicPath: 'vendor/kuromoji/dict/' }).build((err, tk) => {
            diag.lastMs = Date.now() - t0;
            if (err) reject(err); else { diag.ok++; resolve(tk); }
          });
        } catch (e) { reject(e); }
      });
      p.then((tk) => { tokenizerP = Promise.resolve(tk); if (building === p) building = null; },
        (e) => { diag.lastErr = String((e && e.message) || e); if (building === p) building = null; });
    }
    const p = building;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { diag.lastErr = 'timeout'; reject(new Error('日文字典載入逾時')); }, 30000);
      p.then((tk) => { clearTimeout(timer); resolve(tk); }, (e) => { clearTimeout(timer); reject(e); });
    });
  }

  // 回傳 { ruby: [片段陣列|null], roma: [字串] }；不是日文或字典載入失敗時回傳 null
  async function analyzeJapanese(lines) {
    if (!F.looksJapanese(lines)) return null;
    let tk;
    try { tk = await getTokenizer(); } catch (e) { console.warn('[ytls] 日文字典載入失敗', e); return null; }
    const ruby = [], roma = [];
    lines.forEach((l, i) => {
      const s = String(l || '').trim();
      if (!s || !(F.hasKana(s) || F.hasKanji(s))) { ruby[i] = null; roma[i] = ''; return; }
      const toks = tk.tokenize(s);
      ruby[i] = F.toRuby(toks);
      roma[i] = F.toRomaji(toks);
    });
    return { ruby, roma };
  }

  // 沒有時間軸的歌詞對齊到自動字幕的逐詞時間（見 lib/align.js）
  async function alignLyrics({ lines, para, words, spans, durationMs, prior }) {
    const tk = await getTokenizer();
    const kana = (s) => F.toKana(tk.tokenize(String(s || '')));
    const w = (words || []).map((x) => ({ ...x, kana: kana(x.text) }));
    return self.YTLSAlign.alignLyrics(lines, lines.map(kana), w, spans || [], durationMs || 0, para, prior || null);
  }

  self.YTLSTok = { getTokenizer, analyzeJapanese, alignLyrics, diag };
})();
