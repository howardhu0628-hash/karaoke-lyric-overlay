// 共用工具：LRC 解析、YouTube json3 字幕解析、標題清理與歌詞候選排序。
// 同時給 content script、background service worker 與 node 測試使用。
(function (root) {
  'use strict';

  // ---------- LRC ----------
  // 回傳依時間排序的 [{start, end, text}]（毫秒）。空白行代表間奏，會保留成空字串讓畫面清空。
  function parseLrc(lrc) {
    if (!lrc) return [];
    let offset = 0;
    const out = [];
    for (const raw of String(lrc).split(/\r?\n/)) {
      const off = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
      if (off) { offset = parseInt(off[1], 10) || 0; continue; }
      const stamps = [];
      let rest = raw;
      let m;
      const re = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
      while ((m = rest.match(re))) {
        const frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
        stamps.push(parseInt(m[1], 10) * 60000 + parseInt(m[2], 10) * 1000 + frac);
        rest = rest.slice(m[0].length);
      }
      if (!stamps.length) continue;
      // 去掉逐字時間標記 <mm:ss.xx>
      const text = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
      for (const s of stamps) out.push({ start: s - offset, text });
    }
    out.sort((a, b) => a.start - b.start);
    for (let i = 0; i < out.length; i++) {
      const next = out[i + 1];
      out[i].end = next ? next.start : out[i].start + 8000;
    }
    return out;
  }

  // ---------- YouTube json3 ----------
  // 自動字幕在配樂段落會亂辨識（ana、me、can can、ええええ）：用信心度與規則過濾
  const ASR_TAG = /\[[^\]]{1,12}\]/g;                 // [音楽] [拍手]
  const LATIN_ONLY = /^[\sA-Za-z'’.,!?-]+$/;
  const FILLER_ONLY = /^[\sんンえエぇェあアぁァうウぅゥおオぉォーっッ～〜…・、。!?！？]+$/;
  function cleanAsrSegs(segs, lang) {
    const ja = /^(ja|zh|ko)/i.test(lang || '');
    return segs.filter((s) => {
      const t = (s.utf8 || '').replace(ASR_TAG, '');
      if (!t.trim()) return false;
      const conf = s.acAsrConf == null ? 255 : s.acAsrConf;
      if (conf < 90) return false;
      // 日文軌裡的拉丁字母（ana、me、boku ni…）幾乎都是配樂被誤判，除非信心很高且是長單字
      if (ja && LATIN_ONLY.test(t) && (conf < 230 || t.replace(/[^A-Za-z]/g, '').length <= 3)) return false;
      return true;
    }).map((s) => ({ ...s, utf8: (s.utf8 || '').replace(ASR_TAG, '') }));
  }
  function isJunkLine(text, segs) {
    const t = text.replace(/\s+/g, '');
    if (t.length <= 1) return true;
    if (FILLER_ONLY.test(t)) return true;
    if (segs && segs.length) {
      const confs = segs.map((s) => (s.acAsrConf == null ? 255 : s.acAsrConf));
      const avg = confs.reduce((a, b) => a + b, 0) / confs.length;
      if (avg < 130) return true;
    }
    return false;
  }

  // opts.asr：自動字幕 → 過濾雜訊；opts.lang：字幕語言
  function parseJson3(json, opts) {
    opts = opts || {};
    const events = (json && json.events) || [];
    const out = [];
    for (const ev of events) {
      if (!ev.segs || ev.aAppend) continue;
      const segs = opts.asr ? cleanAsrSegs(ev.segs, opts.lang) : ev.segs;
      // 上傳者字幕常夾零寬空白（U+200B 等）：不拿掉的話整行看起來是空的也會顯示，翻譯快取也對不上
      const text = segs.map((s) => s.utf8 || '').join('').replace(/[​-‍⁠﻿]/g, '').replace(/\s*\n\s*/g, ' ').trim();
      if (!text) continue;
      if (opts.asr && isJunkLine(text, segs)) continue;
      const start = ev.tStartMs || 0;
      const end = start + (ev.dDurationMs || 3000);
      out.push({ start, end, text });
    }
    out.sort((a, b) => a.start - b.start);
    // 自動字幕是「滾動式」，每段都會延續到下一段之後；截斷到下一段開始，畫面只顯示最新一句。
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i].end > out[i + 1].start) out[i].end = Math.max(out[i + 1].start, out[i].start + 300);
    }
    return out;
  }

  // 自動字幕的逐詞時間（給歌詞對齊用）：[{start, end, text, conf}]
  function asrWords(json, lang) {
    const events = (json && json.events) || [];
    const words = [];
    for (const ev of events) {
      if (!ev.segs || ev.aAppend) continue;
      const base = ev.tStartMs || 0;
      for (const s of cleanAsrSegs(ev.segs, lang)) {
        const text = (s.utf8 || '').replace(/\s+/g, '');
        if (!text) continue;
        words.push({ start: base + (s.tOffsetMs || 0), text, conf: s.acAsrConf == null ? 255 : s.acAsrConf });
      }
    }
    words.sort((a, b) => a.start - b.start);
    for (let i = 0; i < words.length; i++) {
      const next = words[i + 1];
      words[i].end = next ? Math.min(next.start, words[i].start + 1500) : words[i].start + 800;
    }
    return words;
  }

  // 推定的純配樂區間：只信標成 [音楽]／[拍手] 的段落。
  // （雜訊 ana、me 不能當證據：有人唱但沒辨識出來時也會出現）
  function asrMusicSpans(json) {
    const spans = [];
    const evs = ((json && json.events) || []).filter((ev) => ev.segs && !ev.aAppend);
    evs.forEach((ev, k) => {
      const raw = ev.segs.map((s) => s.utf8 || '').join('').trim();
      if (!/^(\[[^\]]{1,12}\]\s*)+$/.test(raw)) return;
      const start = ev.tStartMs || 0;
      const next = evs[k + 1];
      const end = Math.min(start + (ev.dDurationMs || 3000), next ? next.tStartMs : Infinity);
      spans.push({ start, end });
    });
    // 合併相近的區間（間隔 6 秒內，中間常夾著一小段雜訊辨識）
    spans.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s.start - last.end <= 6000) last.end = Math.max(last.end, s.end); else merged.push({ ...s });
    }
    return merged.filter((s) => s.end - s.start >= 2000);
  }

  // ---------- 說明欄歌詞 ----------
  const CREDIT = /^(作詞|作曲|編曲|作編曲|詞|曲|歌|唄|vocal|vo\.?|music|lyrics?|arrange(ment)?|arranger|mix(ing)?|master(ing)?|illust(ration)?|イラスト|movie|動画|映像|guitar|bass|drums?|piano|keyboard|chorus|コーラス|原曲|本家|inst|original|composer|director|監督|編集|ギター|ベース|ドラム|ピアノ|mv|pv|thumbnail|サムネ|translation|翻訳|romaji|字幕)\s*[:：\/／]/i;
  const HEADER = /^[\s【\[■◆●◇○☆★♪♫\-=─━『「]*(歌詞|lyrics?|リリック)[\s】\]\-=─━』」:：]*$/i;
  const NOT_LYRIC = /(https?:\/\/|www\.|[#＃]\S|@\S|チャンネル登録|subscribe|お問い合わせ|twitter|instagram|tiktok|spotify|apple music|配信|販売|発売|CD|ダウンロード|official|©)/i;

  // 回傳歌詞行陣列（去掉空行）或 null；陣列附帶 .para：每行是否是新段落開頭（空行後），對齊時用來判斷間奏位置
  function extractDescLyrics(desc) {
    if (!desc) return null;
    const lines = String(desc).normalize('NFKC').split(/\r?\n/).map((l) => l.trim());
    // 清單、商品資訊、曲目表不是歌詞：項目符號／編號開頭、有冒號、價格、日期、發行資訊用語
    const LISTY = /^\s*([・●○■□◆◇▼▲►※＊*•\-–—]|\d{1,2}\s*[:：.、)）]|\d{2}\s)|[:：]|[¥￥]|\btax\b|\d{4}[./年]\d{1,2}|リリース|収録|商品|限定|通常盤|グッズ|特典|ALBUM|E\.P\.|Instrumental|Arrangement|feat\.|ver\.|ファンクラブ|入会|チケット|公演/i;
    const isLyric = (l) => l && !NOT_LYRIC.test(l) && !CREDIT.test(l) && !LISTY.test(l) && l.length <= 60 && /[぀-ヿ㐀-鿿A-Za-z]/.test(l);

    // 從 start 往後收集歌詞區塊；碰到非歌詞行或連續 3 個空行就停
    const collect = (start) => {
      const out = [];
      out.para = [];
      let blanks = 0;
      for (let i = start; i < lines.length; i++) {
        const l = lines[i];
        if (!l) { if (++blanks >= 3 && out.length) break; continue; }
        if (!isLyric(l)) { if (out.length) break; else continue; }
        out.para.push(out.length === 0 || blanks > 0);
        blanks = 0;
        out.push(l);
      }
      return out;
    };
    const kanaRatio = (arr) => arr.filter((l) => /[぀-ヿ]/.test(l)).length / (arr.length || 1);

    let best = [];
    const header = lines.findIndex((l) => HEADER.test(l));
    if (header >= 0) best = collect(header + 1);
    if (best.length < 8) {
      // 沒有標題：找最長的日文行區塊
      for (let i = 0; i < lines.length; i++) {
        if (!isLyric(lines[i]) || (i > 0 && isLyric(lines[i - 1]))) continue;
        const blk = collect(i);
        if (blk.length > best.length && kanaRatio(blk) >= 0.4) best = blk;
      }
    }
    return best.length >= 8 ? best : null;
  }

  // ---------- 時間查找 ----------
  // 回傳 start <= t 的最後一個索引（沒有則 -1）
  function findIndex(cues, t) {
    let lo = 0, hi = cues.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // ---------- 標題清理 ----------
  const NOISE = [
    'official music video', 'official video', 'official mv', 'official audio', 'official lyric video',
    'music video', 'lyric video', 'lyrics video', 'lyrics', 'audio', 'full ver', 'full version', 'short ver',
    'mv', 'pv', 'm/v', 'official', 'live', 'hd', '4k', 'video', 'full',
    '歌ってみた', '歌わせていただきました', 'うたってみた', 'cover', 'covered', 'covered by', '試著唱了', '试着唱了', '翻唱',
    '踊ってみた', '弾いてみた', 'オリジナル曲', 'オリジナル', 'original song', 'original',
    '中文字幕', '中字', '歌詞付き', '歌詞', '字幕', '翻譯', '日文', 'romaji', 'karaoke', 'カラオケ', 'off vocal',
  ];
  const TAG_RE = new RegExp('(' + NOISE.map(escapeRe).join('|') + ')', 'i');

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); }

  function norm(s) {
    return String(s || '').normalize('NFKC').toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '');
  }

  function cleanAuthor(a) {
    return String(a || '')
      .replace(/\s*-\s*topic$/i, '')
      .replace(/\b(official|channel|ch\.?|music)\b/gi, '')
      .replace(/(公式|オフィシャル|チャンネル)/g, '')
      .replace(/[\/|｜].*$/, '')
      .replace(/\s+/g, ' ').trim();
  }

  // 翻唱／自彈自唱／不同編曲：時間軸和原曲不同
  const COVER_RE = /(cover|歌ってみた|うたってみた|試著唱|试着唱|翻唱|弾き語り|弾いてみた|acoustic|アコースティック|piano\s*ver|ピアノ|remix|arrange|アレンジ|ver\.)/i;
  function isCoverTitle(title) { return COVER_RE.test(String(title || '').normalize('NFKC')); }

  function stripNoise(s) {
    let t = String(s || '').normalize('NFKC');
    // 「acoustic cover.鹿乃」「covered by xxx」「cover by xxx」：cover 之後多半是翻唱者名字，整段拿掉
    t = t.replace(/\s*(acoustic\s+|piano\s+)?(covered|cover)\b[\s.:：\-–—]*(by\s+)?.*$/i, ' ');
    t = t.replace(/\b(acoustic|piano)\s+(ver(sion)?\.?|arrange)\b\.?/gi, ' ');
    // 括號內若是雜訊就整段拿掉
    t = t.replace(/[\(\[（【〔](.*?)[\)\]）】〕]/g, (m, inner) => (TAG_RE.test(inner) || /^\s*$/.test(inner) ? ' ' : m));
    // 剩下的雜訊字
    for (const n of NOISE.slice().sort((a, b) => b.length - a.length)) {
      t = t.replace(new RegExp('(^|[\\s\\-_/|｜])' + escapeRe(n) + '(?=$|[\\s\\-_/|｜])', 'gi'), ' ');
    }
    return t.replace(/[#＃]\S+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s\-–—|｜/／:：]+|[\s\-–—|｜/／:：]+$/g, '').trim();
  }

  // 由影片標題與頻道名產生 LRCLIB 搜尋字串（最多 5 個，由精到粗）
  function buildQueries(title, author) {
    const t = String(title || '').normalize('NFKC');
    const qs = [];
    const add = (s) => { s = String(s || '').replace(/\s+/g, ' ').trim(); if (s && !qs.includes(s)) qs.push(s); };
    const artist = cleanAuthor(author);

    // 1) 「曲名」『曲名』
    const quoted = t.match(/[「『“"](.+?)[」』”"]/);
    // 2) 【xxx】 若不是標籤，多半是歌手名
    const bracket = [...t.matchAll(/【(.+?)】/g)].map((m) => m[1]).find((s) => !TAG_RE.test(s));

    if (quoted) {
      const song = stripNoise(quoted[1]);
      const outside = stripNoise(t.replace(quoted[0], ' ').replace(/【.+?】/g, ' '));
      add(song + ' ' + (bracket || outside || artist));
      add(song + ' ' + artist);
      add(song);
    }

    const cleaned = stripNoise(t.replace(/【(.+?)】/g, (m, inner) => (TAG_RE.test(inner) ? ' ' : ' ' + inner + ' ')));
    const parts = cleaned.split(/\s+[\/\-–—|｜]\s+|\s*[／｜]\s*|\s+\/|\/\s+/).map((s) => s.trim()).filter(Boolean);
    add(cleaned);
    if (parts.length >= 2) {
      add(parts[0] + ' ' + parts[1]);
      add(parts[1] + ' ' + parts[0]);
    }
    if (parts.length === 1 && artist && !norm(cleaned).includes(norm(artist))) add(cleaned + ' ' + artist);
    // 只取標題裡最長的一段日文（通常就是歌名）
    const jp = (t.match(/[぀-ヿ㐀-鿿々〆ー・、！？!?]{3,}/g) || [])
      .filter((s) => !TAG_RE.test(s)).sort((a, b) => b.length - a.length)[0];
    if (jp) add(jp);
    return qs.slice(0, 6);
  }

  // ---------- 候選排序 ----------
  function rankCandidates(list, ctx) {
    const titleN = norm(ctx.title);
    const authorN = norm(cleanAuthor(ctx.author));
    const dur = Number(ctx.duration) || 0;
    const scored = (list || []).map((c) => {
      const trackN = norm(c.trackName);
      const artistN = norm(c.artistName);
      const synced = !!c.syncedLyrics;
      const diff = dur && c.duration ? Math.abs(c.duration - dur) : 999;
      let s = 0;
      if (synced) s += 30;
      if (diff <= 2) s += 30; else if (diff <= 5) s += 22; else if (diff <= 10) s += 12; else if (diff <= 30) s += 4;
      const nameMatch = trackN.length >= 1 && titleN.includes(trackN);
      if (nameMatch) s += 30;
      const artistMatch = !!artistN && (titleN.includes(artistN) || (authorN && (authorN.includes(artistN) || artistN.includes(authorN))));
      if (artistMatch) s += 10;
      if (c.instrumental) s -= 60;
      if (/(inst|instrumental|off\s*vocal|karaoke)/i.test(c.trackName || '') && !/(inst|off\s*vocal|karaoke)/i.test(ctx.title || '')) s -= 25;
      const strong = synced && !c.instrumental && nameMatch && (diff <= 10 || artistMatch);
      return { ...c, score: s, durDiff: diff, strong, artistMatch };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  // 這部是不是歌曲？（不是的話就當一般影片／節目：不找歌詞、字幕顯示日文＋中文）
  // 實測：官方 MV、翻唱、VTuber 原創曲、歌詞影片的分類都是 Music；日本節目、vlog 多半是 Entertainment／People／Gaming。
  // VTuber 的翻唱有時分在 Entertainment，所以標題像歌也算。拿不到分類（舊資料）時回傳 null，照長度判斷。
  const SONG_TITLE = /歌ってみた|歌ってみました|歌いました|歌わせていただきました|唄ってみた|うたってみた|弾き語り|(^|[\s【\[(（|｜/／])(MV|PV)([\s】\])）|｜/／]|$)|music\s*video|official\s*(audio|video)|lyric\s*video|リリックビデオ|歌詞付き|cover(ed)?\b|カバー|オリジナル曲|original\s*song|feat\.|ft\./i;
  function isSongVideo(info) {
    if (!info) return null;
    if (SONG_TITLE.test(info.title || '') || /Provided to YouTube by/.test(info.description || '')) return true;
    // 翻唱、原創曲的說明欄幾乎都會列製作名單（作詞／作曲／Vocal／Mix…）；分類常被設成「遊戲」「娛樂」
    const credits = (String(info.description || '').match(/(作詞|作曲|編曲|歌唱|ボーカル|Vocal|Mix(ing)?|Mastering|Illust(ration)?|イラスト|動画|Movie|Lyrics|Music)\s*[:：]/gi) || []).length;
    if (credits >= 2 && (info.lengthSeconds || 0) > 0 && info.lengthSeconds <= 9 * 60) return true;
    if (!info.category) return null;
    return /^(Music|音楽)$/i.test(info.category);
  }

  // Whisper 的人名提示：標題【】裡的名字、頻道名、標題裡的專有名詞（減少把主持人名字聽錯）
  function listenHints(info) {
    if (!info) return '';
    const out = [];
    const add = (s) => {
      s = String(s || '').trim();
      if ([...s].length >= 2 && [...s].length <= 20 && /[぀-ヿ㐀-鿿A-Za-z]/.test(s) && !out.includes(s)) out.push(s);
    };
    add(String(info.author || '').replace(/\s*(Ch\.|channel|チャンネル|公式|official).*$/i, '').replace(/\s*-\s*Topic$/i, ''));
    add(info.author);
    String(info.title || '').split(/[【】\[\]「」『』()（）|｜/／・,、！!？?#＃\s]+/).forEach(add);
    return out.slice(0, 12).join(' ');
  }

  // 本機 Whisper（歌曲模式）的逐字時間 → 對齊用的詞：[{start, end, text, conf}]
  // segs：[{start, end, text, words: [[開始, 結束, 字], …]}]；沒有逐字時間的段落整段當一個詞
  function whisperWords(segs, fix) {
    const f = fix || ((t) => t);
    const out = [];
    for (const s of segs || []) {
      const ws = s.words && s.words.length ? s.words : [[s.start, s.end, s.text]];
      for (const [a, b, t] of ws) {
        const text = f(String(t || '')).replace(/\s+/g, '');
        if (text) out.push({ start: a, end: Math.max(a + 50, b), text, conf: 230 });
      }
    }
    return out.sort((x, y) => x.start - y.start);
  }
  // Whisper 段落之間超過 8 秒的空白 = 純配樂（前奏、間奏、尾奏）
  function whisperSpans(segs, durationMs) {
    const s = [...(segs || [])].sort((a, b) => a.start - b.start);
    const spans = [];
    let prev = 0;
    for (const x of s) { if (x.start - prev >= 8000) spans.push({ start: prev, end: x.start }); prev = Math.max(prev, x.end); }
    if (durationMs && durationMs - prev >= 8000) spans.push({ start: prev, end: durationMs });
    return spans;
  }

  const api = { isCoverTitle, parseLrc, parseJson3, asrWords, asrMusicSpans, whisperWords, whisperSpans, isSongVideo, listenHints, extractDescLyrics, findIndex, buildQueries, rankCandidates, stripNoise, cleanAuthor, norm, fmtTime };
  root.YTLS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
