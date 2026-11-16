// 掃描存下來的 OCR 結果，列出簡體字修正前後（node dev/kanji-scan.js <json>...）
const fs = require('fs');
const { fixKanji } = require('../lib/kanjifix.js');
const seen = new Map();
const walk = (v) => {
  if (typeof v === 'string') { const f = fixKanji(v); if (f !== v) seen.set(v, f); }
  else if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === 'object') Object.values(v).forEach(walk);
};
for (const f of process.argv.slice(2)) walk(JSON.parse(fs.readFileSync(f, 'utf8')));
for (const [a, b] of seen) console.log(a, '→', b);
console.log('改了', seen.size, '種字串');
