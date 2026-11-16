// 彈幕測試：把 dev/pipeline-ocr.py danmaku 的結果餵進時間軸（lib/ocr.js），和字幕答案比對；彈幕混進來的句子算雜訊
// 用法：node dev/danmaku-track.js [--list] [--live]（--live：只用原圖＋白字1，模擬邊播邊讀）
const fs = require('fs'), path = require('path');
const S = require('../lib/shared.js');
const O = require('../lib/ocr.js');
const P = require('../lib/ocrprep.js');
const fx = path.join(__dirname, 'fixtures');
const pipe = JSON.parse(fs.readFileSync(path.join(fx, 'danmaku-pipe.json'), 'utf8'));
const subs = JSON.parse(fs.readFileSync(path.join(fx, 'danmaku-answer.json'), 'utf8'));
const live = process.argv.includes('--live');
const tracker = new O.OcrTracker();
for (const f of pipe) {
  const rs = live ? f.results.filter((r) => r.kind === 'orig' || r.kind === 'white1') : f.results;
  const W = 1080 * (rs[0].w / rs[0].h);
  tracker.feed(f.t * 1000, P.mergeResults(rs, O.alike), 500, W);
}
const cues = tracker.all();
function lcs(a, b) {
  a = [...a]; b = [...b];
  let p = new Uint16Array(b.length + 1), c = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) { for (let j = 1; j <= b.length; j++) c[j] = a[i - 1] === b[j - 1] ? p[j - 1] + 1 : Math.max(p[j], c[j - 1]); [p, c] = [c, p]; }
  return p[b.length];
}
let noise = 0, dirty = 0;
const rows = cues.map((c) => {
  const cn = S.norm(c.text);
  const hit = subs.map((s, i) => ({ i, r: lcs(S.norm(s[0]), cn) / [...S.norm(s[0])].length })).sort((a, b) => b.r - a.r)[0];
  const ok = hit && hit.r >= 0.6;
  if (!ok) noise++;
  else if ([...cn].length > [...S.norm(subs[hit.i][0])].length * 1.3) dirty++; // 字幕裡混了彈幕的字
  return { c, ok, i: hit && hit.i };
});
let found = 0, dStart = 0, dEnd = 0;
subs.forEach((s, i) => {
  const r = rows.filter((x) => x.ok && x.i === i);
  if (!r.length) return;
  found++;
  dStart += Math.abs(r[0].c.start / 1000 - s[1]); dEnd += Math.abs(r[r.length - 1].c.end / 1000 - s[2]);
});
console.log(`${live ? '邊播邊讀' : '快速掃描'}：${cues.length} 句｜字幕 ${subs.length} 句找到 ${found}｜彈幕雜訊句 ${noise}｜字幕混到彈幕 ${dirty}｜平均時間誤差 開始 ${(dStart / Math.max(1, found)).toFixed(2)}s 結束 ${(dEnd / Math.max(1, found)).toFixed(2)}s`);
if (process.argv.includes('--list')) for (const r of rows) console.log(`${(r.c.start / 1000).toFixed(1).padStart(6)}–${(r.c.end / 1000).toFixed(1).padStart(5)}s ${r.ok ? '      ' : '【雜】'} ${r.c.text.slice(0, 50)}`);
