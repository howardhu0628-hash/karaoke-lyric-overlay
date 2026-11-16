// 日文假名標註與羅馬拼音：輸入 kuromoji 的斷詞結果，輸出 ruby 片段與拼音字串。
// background、測試頁與 node 測試共用。
(function (root) {
  'use strict';

  const KANJI = /[㐀-䶿一-鿿豈-﫿々〆ヶ]/;
  const KANA = /[ぁ-ゖァ-ヺー]/;

  function kataToHira(s) {
    return String(s || '').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  }
  const hasKanji = (s) => KANJI.test(s);
  const hasKana = (s) => KANA.test(s);
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 把一個詞的表記與讀音對齊：送り仮名不標，只標漢字部分。
  // 例：溶け/とけ → [溶(と)][け]；引き換え/ひきかえ → [引(ひ)][き][換(か)][え]
  function alignToken(surface, readingHira) {
    const runs = surface.match(new RegExp('(' + KANJI.source + ')+|[^' + KANJI.source.slice(1, -1) + ']+', 'g')) || [surface];
    const re = new RegExp('^' + runs.map((r) => (hasKanji(r) ? '(.+?)' : '(' + escapeRe(kataToHira(r)) + ')')).join('') + '$');
    const m = readingHira.match(re);
    if (!m) return [{ t: surface, r: readingHira }];
    return runs.map((r, i) => (hasKanji(r) ? { t: r, r: m[i + 1] } : { t: r }));
  }

  function toRuby(tokens) {
    const out = [];
    const push = (seg) => {
      const last = out[out.length - 1];
      if (!seg.r && last && !last.r) last.t += seg.t; else out.push({ ...seg });
    };
    for (const tk of applyOverrides(tokens)) {
      const s = tk.surface_form;
      const reading = tk.reading && tk.reading !== '*' ? kataToHira(tk.reading) : '';
      if (!hasKanji(s) || !reading || reading === kataToHira(s)) { push({ t: s }); continue; }
      for (const seg of alignToken(s, reading)) push(seg);
    }
    return out;
  }

  // ---------- 平假名 → 羅馬拼音（平文式，長音直接寫出母音，例如 よう → you）----------
  const BASE = {
    あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o', か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
    さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so', た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
    な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no', は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
    ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo', や: 'ya', ゆ: 'yu', よ: 'yo',
    ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro', わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n',
    が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go', ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
    だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do', ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
    ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po', ゔ: 'vu',
    ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa',
  };
  const SMALL_Y = { ゃ: 'a', ゅ: 'u', ょ: 'o' };
  const SMALL_V = { ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o' };

  function hiraToRomaji(h) {
    const chars = [...kataToHira(h)];
    let out = '';
    let sokuon = false;
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i], n = chars[i + 1];
      if (c === 'っ') { sokuon = true; continue; }
      if (c === 'ー') { const v = out.match(/[aiueo]$/); if (v) out += v[0]; continue; }
      let r = BASE[c];
      if (r == null) { out += c; sokuon = false; continue; }
      if (n && SMALL_Y[n] && /i$/.test(r) && r.length > 1) {
        const stem = r.slice(0, -1);
        r = (/^(sh|ch|j)$/.test(stem) ? stem : stem + 'y') + SMALL_Y[n];
        i++;
      } else if (n && SMALL_V[n] && (r.length > 1 || c === 'う')) {
        // ファ→fa、ティ→ti、シェ→she、ツァ→tsa、ウィ→wi
        r = (c === 'う' ? 'w' : r.replace(/[aiueo]$/, '')) + SMALL_V[n];
        i++;
      }
      if (sokuon) { out += r.startsWith('ch') ? 't' : r[0]; sokuon = false; }
      if (c === 'ん' && n && /^[あいうえおやゆよ]/.test(n)) r = "n'";
      out += r;
    }
    return out;
  }

  // kuromoji（IPADIC）會讀錯的常見熟字訓：相鄰詞拼起來符合就合併成一個詞
  const OVERRIDES = {
    二人: 'ふたり', 一人: 'ひとり', 一人一人: 'ひとりひとり', 今日: 'きょう', 明日: 'あした', 昨日: 'きのう',
    大人: 'おとな', 今年: 'ことし', 一日: 'いちにち', 七夕: 'たなばた', 眼鏡: 'めがね', 素人: 'しろうと',
  };
  function applyOverrides(tokens) {
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      let merged = null;
      for (let n = 3; n >= 1 && !merged; n--) {
        if (i + n > tokens.length) continue;
        const s = tokens.slice(i, i + n).map((t) => t.surface_form).join('');
        if (OVERRIDES[s] && (n > 1 || kataToHira(tokens[i].reading || '') !== OVERRIDES[s])) {
          merged = { ...tokens[i], surface_form: s, reading: OVERRIDES[s], pos: '名詞', pos_detail_1: '一般' };
          i += n - 1;
        }
      }
      out.push(merged || tokens[i]);
    }
    return out;
  }

  const OPEN = /^[「『（(【〈《［\[“"]+$/;
  const CLOSE_PUNCT = /^[」』）)】〉》］\]”"、。，．,.！？!?…‥・〜～]+$/;

  // 先把讀音（假名）組成「詞」再整詞轉拼音，促音跨詞（だっ＋た）才不會遺失。
  // 助動詞、接續助詞、接尾詞、非自立動詞接在前一個詞後面，其他詞用空白分開。
  function toRomaji(tokens) {
    const words = [];
    let prefix = '';
    for (const tk of applyOverrides(tokens)) {
      const s = tk.surface_form;
      if (tk.pos === '記号' || (!hasKana(s) && !hasKanji(s))) {
        if (OPEN.test(s)) { prefix += s; continue; }
        if (words.length && CLOSE_PUNCT.test(s)) { words[words.length - 1] += s.replace(/[、，]/g, ',').replace(/[。．]/g, '.').replace(/・/g, ''); continue; }
        words.push(prefix + s); prefix = '';
        continue;
      }
      let kana;
      if (tk.pos === '助詞' && s === 'は') kana = 'わ';
      else if (tk.pos === '助詞' && s === 'へ') kana = 'え';
      else kana = kataToHira(tk.reading && tk.reading !== '*' ? tk.reading : s);
      const last = words[words.length - 1];
      const attach = words.length && !prefix && (
        tk.pos === '助動詞' || tk.pos_detail_1 === '接続助詞' || tk.pos_detail_1 === '接尾' ||
        (tk.pos === '動詞' && tk.pos_detail_1 === '非自立') || /っ$/.test(last));
      if (attach) words[words.length - 1] += kana; else { words.push(prefix + kana); prefix = ''; }
    }
    if (prefix) words.push(prefix);
    return words.map(hiraToRomaji).join(' ').replace(/\s+/g, ' ').trim();
  }

  // 整批歌詞是否是日文：超過三成的行含假名
  function looksJapanese(lines) {
    const ne = lines.filter((l) => String(l || '').trim());
    if (!ne.length) return false;
    return ne.filter(hasKana).length / ne.length >= 0.3;
  }

  // 整串讀音（平假名），給歌詞對齊用
  function toKana(tokens) {
    return applyOverrides(tokens).map((tk) => kataToHira(tk.reading && tk.reading !== '*' ? tk.reading : tk.surface_form)).join('');
  }

  const api = { toKana, kataToHira, hiraToRomaji, alignToken, toRuby, toRomaji, looksJapanese, hasKanji, hasKana };
  root.YTLSFuri = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
