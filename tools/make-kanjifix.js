// 產生 lib/kanjifix.js：PaddleOCR 是中文模型，會把日文漢字讀成簡體字（飾→饰、語→语）。
// 規則：日文（JIS X 0208 / Windows-31J）裡沒有的字，才依 OpenCC 字表「簡→繁→日本新字體」換掉；
// 日文本來就有的字（叶う、机、后…）一律不動，避免把正確的日文改壞。
// 用法：node tools/make-kanjifix.js <OpenCC dictionary 資料夾>
//   例：node tools/make-kanjifix.js <Python>/Lib/site-packages/opencc/dictionary
// 字表來源 OpenCC（Apache-2.0）的 STCharacters.txt 與 JPVariants.txt。
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) { console.error('需要 OpenCC dictionary 資料夾路徑'); process.exit(1); }
const read = (f) => {
  const m = new Map();
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) {
    const [k, v] = line.split('\t');
    if (k && v && [...k].length === 1) m.set(k, v.split(' ').filter(Boolean));
  }
  return m;
};
const ST = read('STCharacters.txt');
const JPV = read('JPVariants.txt');

// Windows-31J 能表示的所有字 = 日文裡「合法」的漢字
const JIS = new Set();
const dec = new TextDecoder('shift_jis');
for (let a = 0x81; a <= 0xfc; a++) {
  if (a > 0x9f && a < 0xe0) continue;
  for (let b = 0x40; b <= 0xfc; b++) {
    if (b === 0x7f) continue;
    const c = dec.decode(new Uint8Array([a, b]));
    if ([...c].length === 1 && c !== '\ufffd') JIS.add(c);
  }
}
if (!JIS.has('飾') || JIS.has('饰')) throw new Error('shift_jis 解碼不對（node 需要完整 ICU）');

const toJp = (t) => (JPV.get(t) || [t])[0];
const map = new Map();
const keep = []; // 日文裡也有、但中文意思不同的簡體字（列出來人工看）
for (const c of new Set([...ST.keys(), ...JPV.keys()])) {
  const cands = ST.get(c) || [c];
  let best = null;
  for (const t of cands) { const j = toJp(t); if (j !== c && JIS.has(j)) { best = j; break; } }
  if (!best) continue;
  if (JIS.has(c)) { keep.push(c + best); continue; }
  map.set(c, best);
}

// JIS 裡有、但日文幾乎只當簡體字用的字形：還是要換。
// 刻意不列：叶（叶う）机 尽 干 里 只 台 芸 泪 遥 凄 准 厨 据 游… 這些在日文裡是常用的正字。
// 舊字體（戀 櫻 龍…）也是合法日文，畫面上寫什麼就照抄，不轉。
const FORCE = {
  '广': '広', '个': '個', '从': '従', '无': '無', '梦': '夢', '气': '気', '后': '後',
  '听': '聴', '云': '雲', '于': '於', '儿': '児', '几': '幾', '夸': '誇', '冲': '衝', '决': '決',
  '况': '況', '凉': '涼', '卷': '巻', '咏': '詠', '坏': '壊', '并': '並', '弃': '棄', '愿': '願',
  '挂': '掛', '搜': '捜', '杰': '傑', '烟': '煙', '犹': '猶', '盖': '蓋', '粮': '糧', '网': '網',
  '羡': '羨', '耻': '恥', '脉': '脈', '舍': '舎', '范': '範', '荐': '薦', '迹': '跡', '韵': '韻',
};
for (const [k, v] of Object.entries(FORCE)) if (JIS.has(v)) map.set(k, v);

const pairs = [...map].map(([k, v]) => k + v).join('');
const out = `// 自動產生（tools/make-kanjifix.js），不要手動改。字表來源：OpenCC STCharacters + JPVariants（Apache-2.0）
// 只收「日文裡沒有」的簡體／繁體字 → 日本新字體，共 ${map.size} 個。
(function (root) {
  'use strict';
  const PAIRS = ${JSON.stringify(pairs)};
  const MAP = new Map();
  { const a = [...PAIRS]; for (let i = 0; i + 1 < a.length; i += 2) MAP.set(a[i], a[i + 1]); }
  // 一個簡體字對應好幾個日文字時，看前後字決定
  // 发：「髪が／髪を／前髪」→ 髪，「発する／発車」→ 発
  const HAIR = /[头頭黒金長前白銀茶短乱洗染髪毛]./;
  const CTX = {
    '发': [{ test: (n) => HAIR.test(n) || /^.[がをにのはもと]/.test(n) }, '髪', '発'],
    '复': [/[杂雑数製合写]/, '複', '復'],
    '历': [/[日旧西和暦]/, '暦', '歴'],
  };
  function fixKanji(s) {
    const a = [...String(s || '')];
    let changed = false;
    for (let i = 0; i < a.length; i++) {
      const c = a[i];
      const ctx = CTX[c];
      let r;
      if (ctx) {
        const near = (a[i - 1] || ' ') + (a[i + 1] || ' ');
        r = ctx[0].test(near) ? ctx[1] : ctx[2];
        if (r === c) r = MAP.get(c);
      } else r = MAP.get(c);
      if (r && r !== c) { a[i] = r; changed = true; }
    }
    return changed ? a.join('') : String(s || '');
  }
  const api = { fixKanji, size: MAP.size };
  root.YTLSKanji = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
`;
fs.writeFileSync(path.join(__dirname, '..', 'lib', 'kanjifix.js'), out, 'utf8');
console.log('對照表', map.size, '個字；JIS 裡也有所以不動的', keep.length, '個：');
console.log(keep.join(' '));
