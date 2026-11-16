// 把「沒有時間軸的歌詞」對齊到自動字幕的時間上。
// 輸入都已轉成平假名讀音（由 background 用 kuromoji 產生），這裡只做純計算，方便測試。
(function (root) {
  'use strict';

  const CHAR_MS = 220;     // 推估：唱一個假名大約 0.22 秒
  const MATCH = 3, MISMATCH = -1, GAP = -1;

  // 把常見的聽寫差異正規化（小字→大字、長音、濁音不分），讓比對寬鬆一點
  const SMALL = { ぁ: 'あ', ぃ: 'い', ぅ: 'う', ぇ: 'え', ぉ: 'お', っ: 'つ', ゃ: 'や', ゅ: 'ゆ', ょ: 'よ', ゎ: 'わ' };
  const DAKU = 'がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ';
  const SEI = 'かきくけこさしすせそたちつてとはひふへほはひふへほ';
  function normKana(s) {
    let out = '';
    for (const c of String(s || '')) {
      if (c === 'ー' || c === '〜' || c === '～') continue;
      if (!/[ぁ-ゖ]/.test(c)) continue;
      const d = DAKU.indexOf(c);
      out += SMALL[c] || (d >= 0 ? SEI[d] : c);
    }
    return out;
  }

  // 半全域比對（兩端的空缺不扣分），回傳 A 中每個 L 字元對到的索引（-1 表示沒對到）
  function alignSeq(L, A) {
    const n = L.length, m = A.length;
    const dir = new Uint8Array((n + 1) * (m + 1)); // 0=斜 1=上(跳過 L) 2=左(跳過 A)
    let prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
    for (let i = 1; i <= n; i++) {
      cur[0] = prev[0] + GAP; dir[i * (m + 1)] = 1;
      for (let j = 1; j <= m; j++) {
        const diag = prev[j - 1] + (L[i - 1] === A[j - 1] ? MATCH : MISMATCH);
        const up = prev[j] + GAP;
        const left = cur[j - 1] + (i === n ? 0 : GAP); // 歌詞結束後的 A 不扣分
        let best = diag, d = 0;
        if (up > best) { best = up; d = 1; }
        if (left > best) { best = left; d = 2; }
        cur[j] = best; dir[i * (m + 1) + j] = d;
      }
      [prev, cur] = [cur, prev];
    }
    // 第一列（歌詞開始前的 A）也不扣分：prev 初始全 0 已經處理
    const map = new Int32Array(n).fill(-1);
    let i = n, j = m;
    while (i > 0 && j > 0) {
      const d = dir[i * (m + 1) + j];
      if (d === 0) { if (L[i - 1] === A[j - 1]) map[i - 1] = j - 1; i--; j--; }
      else if (d === 1) i--;
      else j--;
    }
    return map;
  }

  // 最長遞增子序列（依時間），用來丟掉順序錯亂的錨點
  function lisKeep(items) {
    const n = items.length;
    const best = new Array(n).fill(0), prevIx = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      best[i] = items[i].w;
      for (let k = 0; k < i; k++) {
        if (items[k].t < items[i].t && best[k] + items[i].w > best[i]) { best[i] = best[k] + items[i].w; prevIx[i] = k; }
      }
    }
    let end = -1;
    for (let i = 0; i < n; i++) if (end < 0 || best[i] > best[end]) end = i;
    const keep = new Set();
    for (let i = end; i >= 0; i = prevIx[i]) keep.add(items[i].line);
    return keep;
  }

  // 時間軸上扣掉純配樂區間：live(t) 為「有人聲的時間」累計
  function makeLiveClock(spans) {
    const s = (spans || []).filter((x) => x.end > x.start).sort((a, b) => a.start - b.start);
    const toLive = (t) => { let d = 0; for (const x of s) { if (x.start >= t) break; d += Math.min(t, x.end) - x.start; } return t - d; };
    const fromLive = (lv, lo, hi) => { // 在 [lo, hi] 內二分搜尋
      for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (toLive(mid) < lv) lo = mid; else hi = mid; }
      return hi;
    };
    return { toLive, fromLive };
  }

  function overlap(a0, a1, spans) {
    let s = 0;
    for (const x of spans || []) s += Math.max(0, Math.min(a1, x.end) - Math.max(a0, x.start));
    return s;
  }

  /**
   * lines: 歌詞原文陣列；lineKana: 每行讀音；words: [{start,end,kana}]；spans: [音楽] 區間；durationMs: 影片長度
   * para: 每行是否是新段落開頭（說明欄的空行），間奏通常在段落之間
   * 回傳 { cues: [{start,end,text}], anchored, total }
   */
  // prior：參考時間（例如原曲的 LRC 時間軸，翻唱版用）。有的話，錨點之間依參考時間的相對間距分配，比猜段落準
  function alignLyrics(lines, lineKana, words, spans, durationMs, para, prior) {
    para = para || lines.map(() => false);
    if (prior && prior.length !== lines.length) prior = null;
    const L = [], Lline = [], Lpos = [];
    const lineLen = lineKana.map((k) => normKana(k).length);
    lineKana.forEach((k, li) => { [...normKana(k)].forEach((c, p) => { L.push(c); Lline.push(li); Lpos.push(p); }); });
    const A = [], At = [];
    for (const w of words) {
      const chars = [...normKana(w.kana)];
      const dur = Math.max(1, (w.end || w.start + 300) - w.start);
      chars.forEach((c, k) => { A.push(c); At.push(w.start + (dur * k) / chars.length); });
    }
    const map = L.length && A.length ? alignSeq(L, A) : new Int32Array(L.length).fill(-1);

    // 每行的錨點：對到的字夠多、時間集中
    const anchors = [];
    for (let li = 0; li < lines.length; li++) {
      const hits = [];
      for (let x = 0; x < L.length; x++) if (Lline[x] === li && map[x] >= 0) hits.push({ pos: Lpos[x], t: At[map[x]] });
      const len = lineLen[li] || 1;
      if (hits.length < Math.max(2, Math.ceil(len * 0.2))) continue;
      hits.sort((a, b) => a.t - b.t);
      const span = hits[hits.length - 1].t - hits[0].t;
      if (span > len * CHAR_MS * 2.5 + 3000) continue; // 散落各處的巧合比對
      const first = hits.reduce((a, b) => (a.pos <= b.pos ? a : b));
      anchors.push({ line: li, t: Math.max(0, first.t - first.pos * CHAR_MS), w: hits.length });
    }
    const keep = lisKeep(anchors);
    const start = new Array(lines.length).fill(null);
    for (const a of anchors) if (keep.has(a.line)) start[a.line] = a.t;

    // 沒有錨點的行：在前後錨點之間按字數分配「有人聲的時間」
    const total = Math.max(durationMs || 0, ...words.map((w) => w.end || 0), 1);
    const idx = start.map((s, i) => (s != null ? i : -1)).filter((i) => i >= 0);
    const weight = (i) => Math.max(2, lineLen[i] || 2);
    // [音楽] 標記也會錯：錨點行開始後幾秒內確定有人在唱，從配樂區間扣掉
    let music = (spans || []).map((x) => ({ ...x }));
    for (const i of idx) {
      const v0 = start[i] - 500, v1 = start[i] + weight(i) * CHAR_MS + 500;
      music = music.flatMap((x) => (x.end <= v0 || x.start >= v1 ? [x]
        : [{ start: x.start, end: v0 }, { start: v1, end: x.end }].filter((y) => y.end - y.start > 1500)));
    }
    spans = music;
    const clock = makeLiveClock(spans);
    if (prior) {
      if (!idx.length) {
        // 沒有任何錨點：直接用參考時間
        for (let i = 0; i < lines.length; i++) start[i] = prior[i];
      } else {
        const f = idx[0], l = idx[idx.length - 1];
        // 整體速度比（翻唱可能比原曲快或慢）：錨點橫跨 20 秒以上才估
        let scale = 1;
        if (start[l] - start[f] > 20000 && prior[l] - prior[f] > 20000) scale = Math.min(1.5, Math.max(0.67, (start[l] - start[f]) / (prior[l] - prior[f])));
        for (let i = 0; i < f; i++) start[i] = Math.max(0, start[f] + (prior[i] - prior[f]) * scale);
        for (let i = l + 1; i < lines.length; i++) start[i] = Math.min(total - 500, start[l] + (prior[i] - prior[l]) * scale);
        for (let k = 0; k + 1 < idx.length; k++) {
          const a = idx[k], b = idx[k + 1], pa = prior[a], pb = prior[b];
          for (let i = a + 1; i < b; i++) {
            start[i] = pb > pa ? start[a] + ((prior[i] - pa) * (start[b] - start[a])) / (pb - pa)
              : start[a] + ((start[b] - start[a]) * (i - a)) / (b - a);
          }
        }
      }
    } else if (!idx.length) {
      // 完全沒錨點：整首平均鋪在有人聲的時間上
      const liveTotal = clock.toLive(total);
      const sum = lines.reduce((a, _, i) => a + weight(i), 0);
      let acc = 0;
      // +1：fromLive 回傳「累計人聲時間到達這個值」最早的時刻，0 的話是前奏開頭；要的是前奏結束、開始唱的時候
      for (let i = 0; i < lines.length; i++) { start[i] = clock.fromLive((acc / sum) * liveTotal + 1, 0, total); acc += weight(i); }
    } else {
      // 這首歌的演唱速度（每個假名幾毫秒，含句尾拉長音）：用相鄰兩個錨點行估算
      const rates = [];
      for (let k = 0; k + 1 < idx.length; k++) {
        const a = idx[k], b = idx[k + 1], dt = start[b] - start[a];
        if (b === a + 1 && dt > 800 && dt < 10000) rates.push(dt / weight(a));
      }
      rates.sort((x, y) => x - y);
      const pace = rates.length >= 2 ? Math.min(450, Math.max(150, rates[rates.length >> 1])) : 270;
      const nat = (i) => weight(i) * pace;

      // 第一個錨點之前、最後一個之後：照演唱速度往外推，段落交界多停 2 秒
      const PARA_PAUSE = 2000;
      for (let i = idx[0] - 1; i >= 0; i--) start[i] = Math.max(0, start[i + 1] - nat(i) - (para[i + 1] ? PARA_PAUSE : 0));
      for (let i = idx[idx.length - 1] + 1; i < lines.length; i++) start[i] = Math.min(total - 500, start[i - 1] + nat(i - 1) + (para[i] ? PARA_PAUSE : 0));

      for (let k = 0; k + 1 < idx.length; k++) {
        const a = idx[k], b = idx[k + 1];
        if (b - a < 2) continue;
        let need = 0; for (let i = a; i < b; i++) need += nat(i);
        const slack = start[b] - start[a] - need;
        const bounds = [];
        for (let i = a + 1; i <= b; i++) if (para[i]) bounds.push(i);
        // 間隔裡最大的一段配樂
        let big = null;
        for (const x of spans) {
          const s0 = Math.max(x.start, start[a] + 1000), s1 = Math.min(x.end, start[b] - 500);
          if (s1 - s0 >= 3000 && (!big || s1 - s0 > big.end - big.start)) big = { start: s0, end: s1 };
        }
        // 1) 有段落資訊又有配樂：選一個段落交界當切點，切點前的行唱到配樂開始，切點後的行從配樂結束接到下一個錨點
        if (big && bounds.length) {
          let bestB = bounds[0], bestScore = Infinity;
          for (const bi of bounds) {
            let before = 0; for (let i = a; i < bi; i++) before += nat(i);
            let after = 0; for (let i = bi; i < b; i++) after += nat(i);
            const score = Math.abs(before - (big.start - start[a])) + Math.abs(after - (start[b] - big.end));
            if (score < bestScore) { bestScore = score; bestB = bi; }
          }
          // 切點前：在 [錨點 a, 配樂開始] 內按字數比例
          let sumB = 0; for (let i = a; i < bestB; i++) sumB += nat(i);
          let acc = nat(a);
          for (let i = a + 1; i < bestB; i++) { start[i] = start[a] + ((big.start - start[a]) * acc) / sumB; acc += nat(i); }
          // 切點後：從錨點 b 往回照演唱速度排，不早於配樂結束；放不下就在 [配樂結束, b] 內按比例
          let sumA = 0; for (let i = bestB; i < b; i++) sumA += nat(i);
          if (sumA <= start[b] - big.end) {
            let t = start[b];
            for (let i = b - 1; i >= bestB; i--) { t -= nat(i); start[i] = t; }
          } else {
            let acc2 = 0;
            for (let i = bestB; i < b; i++) { start[i] = big.end + ((start[b] - big.end) * acc2) / sumA; acc2 += nat(i); }
          }
          continue;
        }
        // 2) 時間比預估還短（唱得快）、或沒有段落資訊：用「扣掉純配樂」的時間按字數比例分配
        if (slack <= 0 || big || !bounds.length) {
          const la = clock.toLive(start[a]), lb = clock.toLive(start[b]);
          let acc = nat(a);
          for (let i = a + 1; i < b; i++) { start[i] = clock.fromLive(la + ((lb - la) * acc) / need, start[a], start[b]); acc += nat(i); }
          continue;
        }
        // 3) 沒有配樂標記：多出來的時間是間奏，平均放在段落交界（說明欄的空行）
        const share = new Map();
        for (const bi of bounds) share.set(bi, slack / bounds.length);
        let t = start[a];
        for (let i = a + 1; i < b; i++) { t += nat(i - 1) + (share.get(i) || 0); start[i] = t; }
      }
    }
    const cues = lines.map((text, i) => {
      const next = start[i + 1] != null ? start[i + 1] : total;
      const end = Math.min(next, start[i] + weight(i) * CHAR_MS * 2 + 2500);
      return { start: Math.round(start[i]), end: Math.round(Math.max(end, start[i] + 800)), text, anchored: keep.has(i) };
    });
    return { cues, anchored: keep.size, total: lines.length };
  }

  const api = { normKana, alignSeq, alignLyrics, makeLiveClock };
  root.YTLSAlign = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
