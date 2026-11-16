// 把一連串「畫面 OCR 結果」整理成歌詞時間軸。純計算，content script 與 node 測試共用。
(function (root) {
  'use strict';

  const JP = /[぀-ヿ㐀-鿿]/;
  const SAME = 0.6;        // 相似度 ≥ 0.6 視為同一句（OCR 每次會有些微差異）
  const GONE_MS = 3000;     // 消失超過 3 秒就忘掉（副歌重複出現時不會被當成常駐文字）

  function norm(s) { return String(s || '').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, ''); }

  // 字元多重集合的 Dice 相似度
  function sim(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    const m = new Map();
    for (const c of a) m.set(c, (m.get(c) || 0) + 1);
    let common = 0;
    for (const c of b) { const k = m.get(c); if (k) { common++; m.set(c, k - 1); } }
    return (2 * common) / ([...a].length + [...b].length);
  }

  // 包含度：較短的那段有多少按順序出現在較長的那段裡（最長共同子序列／較短長度）
  // 副歌大字常一塊一塊出現（「もう」→「もう一度」→「もう一度だけ」），包含度高就是同一句在長大或消失
  function contain(a, b) {
    a = [...norm(a)]; b = [...norm(b)];
    if (a.length < 2 || b.length < 2) return 0;
    let prev = new Uint16Array(b.length + 1), cur = new Uint16Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      [prev, cur] = [cur, prev];
    }
    return prev[b.length] / Math.min(a.length, b.length);
  }
  // 一行的「乾淨程度」：日文字越多越好，亂碼符號扣分
  const JP_ALL = /[぀-ヿ㐀-鿿]/g;
  function quality(text) {
    const t = String(text || '').replace(/\s/g, '');
    const jp = (t.match(JP_ALL) || []).length;
    return jp - 2 * ([...t].length - jp) - (/^[ー一ｰ\-・/]/.test(t) ? 2 : 0);
  }
  // 角落的小字（HUD、時間、頻道名）和大半是亂碼的行不當歌詞；座標以高 1080 的畫面為準
  function isNoise(text, h) {
    const t = String(text || '').replace(/\s/g, '');
    const jp = (t.match(JP_ALL) || []).length;
    // 括號、引號、羅馬數字這類符號在歌詞 OCR 裡幾乎都是把背景誤認成字
    const junk = (t.match(/[()（）"“”~～ⅰ-ⅻ\[\]|=+\\]/g) || []).length;
    return (h != null && h > 0 && h < 16) || jp < 2 || jp / [...t].length < 0.6 || junk >= 2 || quality(text) < 2;
  }
  const alike = (a, b) => sim(a, b) >= SAME || contain(a, b) >= 0.9;

  // 接起多塊文字：兩邊都是日文字就直接接，否則中間留空白
  const CJK = /[぀-ヿ㐀-鿿々ー]/;
  // 同一列（y 接近）的日文片段直接接起來；不同列或非日文中間留空白
  const compose = (parts) => parts.reduce((acc, p, i) => {
    const t = String(p.text).trim();
    if (!acc) return t;
    const q = parts[i - 1];
    const sameRow = q && p.y != null && q.y != null && Math.abs(p.y - q.y) <= Math.max(p.h || 0, q.h || 0, 10) * 0.6;
    return acc + (sameRow && CJK.test(acc.slice(-1)) && CJK.test(t[0] || '') ? '' : ' ') + t;
  }, '');
  // 職員表（作詞作曲：○○、Vocal：○○、イラスト：…）不是歌詞
  const CREDIT = /^\s*(作詞|作曲|編曲|作編曲|作詞作曲|作詞・作曲|歌|唄|vocal|vo\.?|music|lyrics?|arrange|mix|mastering|illust|イラスト|絵|movie|動画|映像|編集|guitar|bass|drums?|piano|ギター|ベース|ドラム|ピアノ|アレンジ|原曲|本家|cover|thumbnail|サムネ|翻訳|字幕)\s*[:：\/／]/i;
  const LAG_MS = 300; // 取樣間隔造成的延遲：句子實際出現時間大約早 0.3 秒

  // OCR 常見混淆：漢字旁邊的片假名「ニ」「ロ」幾乎都是漢字「二」「口」；
  // PaddleOCR 是中文模型，簡體字（饰、语）換回日文漢字（lib/kanjifix.js）
  const KANJI = /[㐀-鿿]/;
  const KF = root.YTLSKanji || (typeof require === 'function' ? require('./kanjifix.js') : null);
  function fixOcr(s) {
    if (KF) s = KF.fixKanji(s);
    const a = [...String(s || '')];
    return a.map((c, i) => {
      if (c !== 'ニ' && c !== 'ロ') return c;
      const prev = a[i - 1] || '', next = a[i + 1] || '';
      const kata = /[ァ-ヺー]/;
      if ((KANJI.test(prev) || KANJI.test(next)) && !kata.test(prev) && !kata.test(next)) return c === 'ニ' ? '二' : '口';
      return c;
    }).join('');
  }

  const STATIC_MS = 25000;  // 同一塊文字連續出現超過 25 秒 → 常駐的 logo／credit
  const ATTACH_MS = 2000;   // 2 秒內、緊鄰目前這句冒出來的文字塊 → 同一句的後半（副歌大字一塊塊出現）

  // 兩個文字框是否緊鄰（框各往外擴「字的粗細」的 0.8 倍後有重疊）
  function adjacent(a, b) {
    const m = 0.8 * Math.max(Math.min(a.w || 0, a.h || 0), Math.min(b.w || 0, b.h || 0), 10);
    return a.x - m < b.x + b.w && b.x - m < a.x + a.w && a.y - m < b.y + b.h && b.y - m < a.y + a.h;
  }

  // 彈幕（會左右捲動的留言）：同一塊文字前後兩張的位置比較。左右兩邊一起往同一方向移動，
  // 或一邊貼著畫面邊緣、另一邊在移動（正在進場／出場），就是在捲動。回傳 1 = 移動、0 = 沒動、-1 = 對不上（跳到別列）
  function motion(o, p, W) {
    const h = Math.max(10, Math.min(o.h || 0, p.h || 0) || o.h || p.h || 0);
    if (Math.abs((p.y || 0) - (o.y || 0)) > 0.6 * h) return -1;
    const thr = Math.max(15, 0.5 * h);
    const dl = p.x - o.x, dr = (p.x + p.w) - (o.x + o.w);
    if ((dl < -thr && dr < -thr) || (dl > thr && dr > thr)) return 1;
    const edge = W ? 0.012 * W : 12;
    const atL = o.x <= edge && p.x <= edge;
    const atR = W ? o.x + o.w >= W - edge && p.x + p.w >= W - edge : false;
    if ((atR && Math.abs(dl) > thr) || (atL && Math.abs(dr) > thr)) return 1;
    return 0;
  }

  // 觀察期的塊是否「沒在動」：至少一邊（左、右或中心）幾乎沒動，另一邊的變化不超過一個字寬（OCR 偶爾多讀、少讀一個字）。
  // 正在進場的彈幕兩邊都會變很多
  function steady(o, p) {
    const h = Math.max(10, Math.min(o.h || 0, p.h || 0) || o.h || p.h || 0);
    if (Math.abs((p.y || 0) - (o.y || 0)) > 0.6 * h) return false;
    const dl = Math.abs(p.x - o.x), dr = Math.abs((p.x + p.w) - (o.x + o.w)), dc = Math.abs((p.x + p.w / 2) - (o.x + o.w / 2));
    const tight = 0.35 * h, loose = 1.3 * h;
    return (dl <= tight && dr <= loose) || (dr <= tight && dl <= loose) || (dc <= tight && dl <= loose && dr <= loose);
  }

  // 聊天室（直播存檔畫面旁邊的留言欄）：每一行是「@帳號：留言」，左邊對齊成一欄、一直往上捲。
  // 歌詞、字幕不會用 @ 開頭；同一張畫面裡有 3 行以上 @ 開頭、左邊對齊、在不同列的，就是聊天室那一欄
  const CHAT_AT = /^\s*[@＠]/;
  const CHAT_ANY = /[@＠][^\s:：]{1,40}\s*[:：]/; // 舊紀錄裡混進去的留言（「@帳號：…」出現在句子任何地方）
  function chatColumns(lines) {
    const ats = (lines || []).filter((l) => CHAT_AT.test(String(l.text)) && l.h > 0);
    const out = [];
    for (const a of ats) {
      const tol = Math.max(12, 0.8 * a.h);
      const g = ats.filter((b) => Math.abs(b.x - a.x) <= tol && b.h >= 0.6 * a.h && b.h <= 1.6 * a.h);
      // 不同列：每兩行上下差超過半行
      const ys = [...new Set(g.map((b) => Math.round(b.y)))].sort((p, q) => p - q);
      let rows = ys.length ? 1 : 0;
      for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] >= 0.5 * a.h) rows++;
      if (rows < 3) continue;
      const hs = g.map((b) => b.h).sort((p, q) => p - q), xs = g.map((b) => b.x).sort((p, q) => p - q);
      out.push({ x: xs[xs.length >> 1], x1: Math.max(...g.map((b) => b.x + (b.w || 0))), h: hs[hs.length >> 1], y0: Math.min(...g.map((b) => b.y)), y1: Math.max(...g.map((b) => b.y + b.h)) });
    }
    return out;
  }

  // 一句的文字：依出現順序接起各塊；被別塊包含的（同一塊的舊片段）拿掉
  function composeBlocks(blocks) {
    const bs = blocks.filter((b) => b.n && b.text && !b.moving && !b.label);
    const keep = bs.filter((b) => !bs.some((o) => o !== b && [...o.n].length > [...b.n].length && contain(o.n, b.n) >= 0.9));
    keep.sort((a, b) => (a.t0 - b.t0) || (Math.abs(a.y - b.y) > 10 ? a.y - b.y : a.x - b.x));
    return compose(keep);
  }

  // 每一塊畫面文字分開追蹤：新冒出來的塊才是新的一句；舊句留在畫面上（有些 MV 會一句句累積）不會被重複算進去
  class OcrTracker {
    constructor(saved) {
      this.chat = ((saved && saved.chat) || []).map((c) => ({ ...c })); // 認出來的聊天室欄位 {x, h, y0, y1}（高 1080 的座標）
      // 舊版存的紀錄可能混著聊天室留言：@帳號：… 的句子、落在聊天室欄位裡的句子不要
      const keep = (c) => !CHAT_ANY.test(c.text || '') && !CHAT_AT.test(c.text || '') &&
        !(c.x0 != null && this.inChat({ x: c.x0, y: c.y || 0, h: c.h || 0 }));
      this.cues = ((saved && saved.cues) || []).filter(keep).map((c) => ({
        start: c.start, end: c.end, blocks: [{ n: norm(c.text), text: c.text, t0: c.start, x: c.x0 || 0, y: c.y || 0, w: (c.x1 || 0) - (c.x0 || 0), h: c.h || 0, nox: c.x0 == null }],
      }));
      this.statics = new Set((saved && saved.statics) || []); // 已認定的常駐文字（拖動進度條也不會忘）
      this.active = [];  // 目前畫面上的文字塊
      this.open = null;  // 目前這一句 {start, end, blocks, lastGrow, miss}
      this.lastT = null;
      this.epoch = 1;    // 每拖動一次進度條 +1；載入的舊紀錄是 0
      this.danmaku = 0;  // 認出來的彈幕數；有彈幕的影片，新冒出來的字要多看一張確定沒在動才收進歌詞
      this.placed = [];  // 最近確定是字幕的塊的位置 {y, h, cx}：學「字幕通常出現在哪一帶」
      this.spots = [];   // 短字（3 個字以內）出現過的位置 {cx, cy, h, texts}：同一個位置一直冒出不同的短字 → 人名小標籤
    }

    // 這塊字落在已認出的聊天室欄位裡（左邊對齊那一欄、上下範圍內）。多行的句子用整塊的高度判斷，不會因為高過一行就漏掉
    inChat(b) {
      // 左邊從欄位左緣到右緣之間開始的都算（帳號開頭被頭像蓋住、讀漏時，留言會從欄位中間開始）
      return this.chat.some((c) => b.x >= c.x - Math.max(12, 1.2 * c.h) && b.x <= Math.max(c.x + Math.max(12, 1.2 * c.h), (c.x1 || 0) - 2 * c.h) &&
        b.y + (b.h || 0) >= c.y0 - c.h && b.y <= c.y1 + c.h);
    }

    // 從這張畫面學聊天室欄位；新認出（或範圍變大）時，已收錄的句子裡落在欄位裡的塊拿掉。回傳有沒有變
    learnChat(lines, t) {
      let grew = false;
      for (const col of chatColumns(lines)) {
        const old = this.chat.find((c) => Math.abs(c.x - col.x) <= Math.max(12, 0.8 * Math.max(c.h, col.h)));
        if (!old) { this.chat.push(col); grew = true; continue; }
        if (col.y0 < old.y0 - 2 || col.y1 > old.y1 + 2 || col.x1 > (old.x1 || 0) + 2) { old.y0 = Math.min(old.y0, col.y0); old.y1 = Math.max(old.y1, col.y1); old.x1 = Math.max(old.x1 || 0, col.x1); grew = true; }
      }
      if (this.chat.length > 4) this.chat.splice(0, this.chat.length - 4);
      if (!grew) return false;
      const bad = new Set();
      for (const c of [...this.cues, ...(this.open ? [this.open] : [])]) for (const x of c.blocks) if (!x.nox && (this.inChat(x) || CHAT_AT.test(x.text))) bad.add(x);
      for (const x of bad) this.dropMoving(x, t);
      this.active = this.active.filter((b) => !this.inChat(b));
      return bad.size > 0;
    }

    place(b) {
      this.placed.push({ y: b.y, h: b.h, cx: b.x + b.w / 2 });
      if (this.placed.length > 30) this.placed.shift();
    }

    // 字幕帶：最近確定的字幕塊裡，跟這塊高度差不多、位置差不多的有 3 個以上
    inBand(b) {
      const cx = b.x + b.w / 2;
      const near = this.placed.filter((q) => Math.abs(q.y - b.y) <= 0.6 * Math.max(q.h, b.h) && Math.abs(q.cx - cx) <= 1.5 * Math.max(q.h, b.h) &&
        b.h >= 0.7 * q.h && b.h <= 1.4 * q.h);
      return near.length >= 3;
    }

    // 認定是彈幕的塊：從已收錄的句子拿掉；目前這句因此空了的話，接回上一句（彈幕冒出來時被提早收尾、但其實還在畫面上的那句）
    // 人名小標籤（例如字幕旁邊的「宙科」，OCR 每次讀成雷科、菌科、魚科…）：同一個位置出現 3 種以上不同的短字就是標籤，
    // 那個位置的短字都不收（已收的也拿掉）。回傳這塊是不是標籤
    noteSpot(b, t) {
      if ([...b.n].length > 3 || !b.h) return false;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const at = (q) => Math.abs(q.cx - cx) <= 0.8 * q.h && Math.abs(q.cy - cy) <= 0.6 * q.h && b.h >= 0.7 * q.h && b.h <= 1.4 * q.h;
      let sp = this.spots.find(at);
      if (!sp) { sp = { cx, cy, h: b.h, texts: new Set() }; this.spots.push(sp); if (this.spots.length > 40) this.spots.shift(); }
      sp.texts.add(b.n);
      if (sp.texts.size < 3) return false;
      if (!sp.label) {
        sp.label = true;
        const inSpot = (x) => x !== b && !x.label && x.h && [...x.n].length <= 3 && at({ cx: x.x + x.w / 2, cy: x.y + x.h / 2, h: x.h }) ;
        const olds = new Set();
        for (const c of [...this.cues, ...(this.open ? [this.open] : [])]) for (const x of c.blocks) if (inSpot(x)) olds.add(x);
        for (const x of olds) { x.label = true; this.dropMoving(x, t); }
      }
      b.label = true;
      return true;
    }

    dropMoving(b, t) {
      const strip = (c) => {
        c.blocks = c.blocks.filter((x) => x !== b);
        if (c.blocks.length) c.start = Math.min(...c.blocks.map((x) => x.t0));
      };
      this.cues.forEach(strip);
      this.cues = this.cues.filter((c) => c.blocks.length);
      if (this.open) { strip(this.open); if (!this.open.blocks.length) this.open = null; }
      if (!this.open && this.cues.length) {
        const last = this.cues[this.cues.length - 1];
        if (last.blocks.some((x) => x.last === t && !x.moving && this.active.includes(x))) {
          this.cues.pop();
          this.open = last;
          last.lastGrow = last.lastGrow || t;
          last.end = t + 700;
        }
      }
    }

    markStatic(n) {
      this.statics.add(n);
      // 回頭把已收錄句子裡的這段常駐文字拿掉；開始時間改成剩下那幾塊最早出現的時間
      const strip = (c) => {
        c.blocks = c.blocks.filter((b) => b.n !== n);
        if (c.blocks.length) c.start = Math.min(...c.blocks.map((b) => b.t0));
      };
      this.cues.forEach(strip);
      this.cues = this.cues.filter((c) => c.blocks.length);
      if (this.open) { strip(this.open); if (!this.open.blocks.length) this.open = null; }
      this.active = this.active.filter((b) => b.n !== n);
    }

    // t：影片時間（毫秒）；lines：OCR 結果 [{text, x, y, w, h}]（座標以高 1080 的畫面為準）。回傳畫面歌詞是否有變化
    // lag：取樣間隔造成的延遲（快速掃描時間隔較大，傳入間隔的一半）；W：畫面寬（同樣以高 1080 換算，判斷彈幕進出場用）
    feed(t, lines, lag = LAG_MS, W = 0) {
      // 拖動進度條：目前這句在原本的位置收尾，畫面上的文字塊重新認
      if (this.lastT != null && (t < this.lastT - 500 || t - this.lastT > GONE_MS)) {
        if (this.open) this.close(this.open.end);
        this.epoch++;
        this.active = [];
      }
      this.lastT = t;
      // 聊天室：用這張全部的辨識結果學欄位（帳號多半是英數字，要在日文過濾之前看）
      let changed = this.learnChat(lines, t);

      const parts = [];
      for (const l of lines || []) {
        const text = fixOcr(String(l.text).trim());
        const n = norm(text);
        if ([...n].length < 2 || !JP.test(n) || CREDIT.test(text) || isNoise(text, l.h) || this.statics.has(n)) continue;
        if (CHAT_AT.test(text) || this.inChat({ x: l.x || 0, y: l.y || 0, h: l.h || 0 })) continue; // 聊天室留言
        parts.push({ text, n, x: l.x || 0, y: l.y || 0, w: l.w || 0, h: l.h || 0 });
      }

      // 1) 對應到畫面上已有的塊（文字相像就是同一塊；OCR 每次讀的會有些微差異）
      const fresh = [];
      const seen = new Set();
      const flagged = [], graduated = [], released = [];
      for (const p of parts) {
        let best = null, bestScore = 0;
        for (const b of this.active) {
          if (seen.has(b)) continue;
          const sc = p.n === b.n ? 2 : alike(p.text, b.text) ? 1 + sim(p.text, b.text) * 0.5 : 0;
          if (sc > bestScore) { bestScore = sc; best = b; }
        }
        if (!best) { fresh.push(p); continue; }
        seen.add(best);
        const mv = motion(best, p, W);
        const still = best.prob && steady(best, p);
        Object.assign(best, { x: p.x, y: p.y, w: p.w, h: p.h, last: t, miss: 0 });
        // 先等等看的新塊（見 3）：第二張還在 → 真的是新的一句
        if (best.hold) { best.hold = false; best.held = true; released.push(best); }
        if (!best.moving) {
          // 連續兩次都在移動才算彈幕（MV 歌詞偶爾會滑進來一下就停住）
          best.mv = mv === 1 ? (best.mv || 0) + 1 : 0;
          if (best.mv >= 2) { best.moving = true; best.prob = false; flagged.push(best); }
          // 觀察期過了：位置沒變（正在進場的彈幕兩邊都在變），是字幕
          else if (best.prob && mv === 0 && still) { best.prob = false; graduated.push(best); this.place(best); }
        }
        if (best.moving) continue; // 彈幕：只追蹤位置，不收進歌詞
        if (p.n === best.n) { best.pend = null; continue; }
        const grows = contain(p.text, best.text) >= 0.9;
        if (grows) {
          // 同一塊長大／縮小，或讀得更乾淨：留最乾淨的版本（一樣乾淨就留長的）
          const qn = quality(p.text), qo = quality(best.text);
          if (qn > qo || (qn === qo && [...p.n].length > [...best.n].length)) { best.text = p.text; best.n = p.n; changed = true; }
          best.pend = null;
          continue;
        }
        // 很像但不一樣（例如「眠れないんだって」→「眠れないよなんて」）：可能是 OCR 小錯，也可能真的換句。
        // 靜止畫面的 OCR 錯誤會從頭錯到尾或來回跳；中途換成另一個版本並連續兩張都是它，就是換了新的一塊
        if (best.pend && best.pend.n === p.n) {
          if (++best.pend.count >= 2) {
            this.active = this.active.filter((b) => b !== best);
            fresh.push({ ...p, t0: best.pend.t0, held: true }); // 已經連續兩張確認過，換句不用再等一張（見 3）
          }
        } else {
          best.pend = { n: p.n, t0: Math.max(0, t - lag), count: 1 };
        }
      }

      // 2) 沒看到的塊：連續兩張沒出現就算消失；連續出現太久的是常駐文字（彈幕不算：同一句留言可能一直重複出現）
      for (const b of this.active) if (!seen.has(b) && b.last !== t) b.miss = (b.miss || 0) + 1;
      // 只看到一次就消失的觀察期塊（字幕只停留 1 秒多，每秒一張的掃描只拍到一次）：在平常出現字幕的那一帶、位置也對，就收
      // （4 個字以上；字幕旁邊的人名小標籤每次讀得不一樣，不收）
      for (const b of this.active) {
        if (b.prob && b.first === b.last && [...b.n].length >= 4 && !(b.miss < 2 && t - b.last <= GONE_MS) && this.inBand(b)) {
          this.cues.push({ start: b.t0, end: b.last + 700, blocks: [b], epoch: this.epoch });
          this.cues.sort((a, c) => a.start - c.start);
          b.prob = false;
          changed = true;
        }
      }
      this.active = this.active.filter((b) => b.miss < 2 && t - b.last <= GONE_MS);
      for (const b of flagged) { this.danmaku++; this.dropMoving(b, t); changed = true; }
      for (const b of [...this.active]) if (!b.moving && !b.prob && b.last - b.first > STATIC_MS) { this.markStatic(b.n); changed = true; }

      // 3) 新冒出來的塊：緊鄰目前這句、2 秒內、目前這句還在畫面上 → 同一句的後半；否則是新的一句
      //    有彈幕的影片：新的塊先觀察一張（下一張位置沒變才算字幕，開始時間仍用第一次看到的時間）
      const probation = this.danmaku >= 2;
      const created = fresh.map((p) => ({ ...p, t0: p.t0 != null ? p.t0 : Math.max(0, t - lag), first: t, last: t, miss: 0, mv: 0, prob: probation }));
      this.active.push(...created);
      const blocks = [...created.filter((b) => !b.prob), ...graduated.filter((b) => this.active.includes(b)), ...released.filter((b) => this.active.includes(b))]
        .filter((b) => !(b.label || this.noteSpot(b, t)));
      // 目前這句「這一張」還看得到（只算這張實際讀到的塊；剛消失的不算）
      const openOnScreen = this.open && this.open.blocks.some((b) => b.last === t && !blocks.includes(b));
      if (blocks.length) {
        const attach = this.open && openOnScreen && t - this.open.lastGrow <= ATTACH_MS &&
          blocks.every((nb) => this.open.blocks.some((b) => b.last === t && !blocks.includes(b) && adjacent(b, nb)));
        if (attach) {
          this.open.blocks.push(...blocks);
          this.open.lastGrow = t;
          this.open.end = t + 700;
        } else if (openOnScreen && blocks.every((b) => b.first === t && !b.held)) {
          // 目前這句還在畫面上，新冒出來的塊這張才第一次看到：先等下一張再換句。
          // 一閃而過的殘字、讀錯的片段、卡拉 OK 歌詞變色時讀歪的版本，以前會把還在畫面上的字幕擠掉（字幕出現一下就不見）
          for (const b of blocks) b.hold = true;
          this.open.end = t + 700;
          return changed;
        } else {
          // 等過一張才換句的：上一句在新句第一次出現的那張就收尾（時間軸跟不等的時候一樣）
          if (this.open) this.close(Math.min(t, ...blocks.map((b) => (b.held ? b.first : t))));
          this.open = { start: Math.min(...blocks.map((b) => b.t0)), end: t + 700, blocks, lastGrow: t, epoch: this.epoch };
        }
        return true;
      }
      if (this.open) {
        if (openOnScreen) { this.open.end = t + 700; return changed; }
        this.close(t);
        return true;
      }
      return changed;
    }

    close(t) {
      const c = this.open;
      this.open = null;
      if (!c) return;
      c.end = Math.max(c.start + 300, Math.min(t, c.end + 700));
      if (c.end - c.start < 500) return; // 一閃而過的雜訊
      // 取代時間重疊的舊紀錄（重看一次時，新結果覆蓋舊的）
      // 有彈幕的影片：同一輪連續看下來的句子互不取代（新句的開始時間會往前補，可能和上一句重疊）
      this.cues = this.cues.filter((x) => {
        if (this.danmaku >= 2 && x.epoch === c.epoch) return true;
        const ov = Math.min(x.end, c.end) - Math.max(x.start, c.start);
        return ov <= 0.5 * Math.min(x.end - x.start, c.end - c.start);
      });
      this.cues.push(c);
      this.cues.sort((a, b) => a.start - b.start);
    }

    // 這段字目前是畫面上「確定沒在動」的字（不是彈幕、也過了觀察期）：快速掃描用來判斷遮罩版本有沒有幫上忙
    isStill(text) {
      const t = fixOcr(String(text || '').trim()), n = norm(t);
      return this.active.some((b) => !b.moving && !b.prob && (b.n === n || alike(b.text, t)));
    }

    all() {
      // y、h：這句在畫面上的位置（高 1080 的座標；最上面那塊的頂端、到最下面那塊底部的高度），用來避開影片自己的字幕
      const pos = (c) => {
        const bs = c.blocks.filter((b) => !b.moving && b.h);
        if (!bs.length) return {};
        const y = Math.min(...bs.map((b) => b.y));
        // x0、x1：左右範圍（同樣是高 1080 的座標），用來分辨置中的字幕和靠邊的遊戲聊天、介面文字
        const out = { y: Math.round(y), h: Math.round(Math.max(...bs.map((b) => b.y + b.h)) - y) };
        if (!bs.some((b) => b.nox)) { // 舊版存的紀錄沒有左右範圍
          out.x0 = Math.round(Math.min(...bs.map((b) => b.x)));
          out.x1 = Math.round(Math.max(...bs.map((b) => b.x + (b.w || 0))));
        }
        return out;
      };
      const list = this.cues.map((c) => ({ start: c.start, end: c.end, text: composeBlocks(c.blocks), ...pos(c) }));
      if (this.open) list.push({ start: this.open.start, end: this.open.end, text: composeBlocks(this.open.blocks), ...pos(this.open) });
      return list.filter((c) => c.text).sort((a, b) => a.start - b.start);
    }

    save() {
      return {
        cues: this.all().map((c) => ({ start: Math.round(c.start), end: Math.round(c.end), text: c.text, y: c.y, h: c.h, x0: c.x0, x1: c.x1 })),
        statics: [...this.statics],
        chat: this.chat.map((c) => ({ x: Math.round(c.x), x1: Math.round(c.x1 || 0), h: Math.round(c.h), y0: Math.round(c.y0), y1: Math.round(c.y1) })),
      };
    }
  }

  const api = { OcrTracker, sim, norm, fixOcr, contain, alike, quality, isNoise, motion };
  root.YTLSOcr = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
