// OCR 時間軸整理的單元測試：node tools/test-ocr.js
const { OcrTracker, sim } = require('../lib/ocr.js');
const assert = require('assert');

const L = (text, y = 600, x = 300) => ({ text, x, y, w: 400, h: 50 });
const logo = L('チャンネル登録よろしく', 20, 20);
const tr = new OcrTracker();
let t = 0;
const step = (lines, n = 1) => { for (let i = 0; i < n; i++) { tr.feed(t, lines); t += 700; } };

step([logo], 3);                                   // 只有常駐文字（還沒滿 25 秒，會被當成一句）
step([logo, L('風の音が遠くで聞こえてる')], 5);
step([logo, L('風の音が遠くで聞こえでる')], 2);    // OCR 小錯誤 → 同一句
step([logo, L('二人で歩いた坂道の上で')], 5);
step([logo], 3);                                    // 間奏
for (let i = 0; i < 40; i++) step([logo]);          // 常駐超過 25 秒
step([logo, L('「またね」と手を振った'), L('その笑顔を覚えている', 660)], 4); // 兩行同時出現
step([], 3);

// 常駐的 logo 文字在撐過兩次換句後被認出來，並從所有句子裡清掉
const cues = tr.all();
assert.deepStrictEqual(cues.map((c) => c.text), [
  '風の音が遠くで聞こえてる', '二人で歩いた坂道の上で', '「またね」と手を振った その笑顔を覚えている',
]);
assert(cues[0].start === 1800 && cues[1].start === 6700, '換句時間（含 0.3 秒取樣補償）：' + cues.map((c) => c.start));
// 拖回前面：常駐文字仍然記得，不會混進歌詞
tr.feed(3000, [logo, L('ニ人で歩いた坂道の上で')]); tr.feed(3700, [logo, L('二人で歩いた坂道の上で')]);
assert(!tr.all().some((c) => c.text.includes('チャンネル')), '拖動後混入常駐文字');
assert.strictEqual(new OcrTracker(tr.save()).statics.size, 1);
// OCR 混淆修正
const { fixOcr } = require('../lib/ocr.js');
assert.strictEqual(fixOcr('ニ人で歩いた'), '二人で歩いた');
assert.strictEqual(fixOcr('ニャンコ'), 'ニャンコ');
assert.strictEqual(fixOcr('入ロ'), '入口');
// 簡體字 → 日文漢字；日文本來就有的字不能動
assert.strictEqual(fixOcr('装饰された梦'), '装飾された夢');
assert.strictEqual(fixOcr('时间が止まる风'), '時間が止まる風');
assert.strictEqual(fixOcr('叶わない恋 机の上 尽きる 泪'), '叶わない恋 机の上 尽きる 泪');
assert.strictEqual(fixOcr('櫻の花'), '櫻の花');
assert.strictEqual(fixOcr('前发が揺れる'), '前髪が揺れる');
assert.strictEqual(fixOcr('发が揺れる'), '髪が揺れる');
assert.strictEqual(fixOcr('出发する'), '出発する');
assert.strictEqual(fixOcr('后悔'), '後悔');
// 職員表不是歌詞（MV 片頭常見的格式，OCR 讀到一半的也要認得）
const t6 = new OcrTracker();
t6.feed(0, [L('星の降る町で'), L('作詞作曲 : や', 660)]); t6.feed(700, [L('星の降る町で'), L('作詞作曲 : 山田', 660), L('アレンジ：田中', 700)]);
assert.deepStrictEqual(t6.all().map((c) => c.text), ['星の降る町で']);
assert(sim('風の音が遠く', '風の音で遠く') > 0.6 && sim('風の音が遠く', '二人で歩いた') < 0.3);

// 兩行歌詞輪流換（上一行留著、下一行換新）：留著的那行不會被誤判成常駐文字
const t5 = new OcrTracker();
let u = 0;
const s5 = (lines, n = 2) => { for (let i = 0; i < n; i++) { t5.feed(u, lines); u += 700; } };
s5([L('夜明けを待っている')]);
s5([L('夜明けを待っている'), L('小さな声で名前を呼んだ', 660)]);
s5([L('窓の外は雨模様')]);
s5([L('夜明けを待っている')]); // 副歌重複
// 第二行出現時視為同一句長大（開始時間沿用第一行出現的時間）
assert.deepStrictEqual(t5.all().map((c) => c.text), ['夜明けを待っている 小さな声で名前を呼んだ', '窓の外は雨模様', '夜明けを待っている']);

// 副歌大字一塊一塊出現：拼成一整句，開始時間是第一塊出現的時候
const t7 = new OcrTracker();
let w = 10000;
for (const lines of [[L('もう')], [L('もう一度')], [L('もう一度'), L('だけ', 600, 600)], [L('もう一度だけ')], [L('一度だけ')], [L('光る硝子の街')], [L('光る硝子の街')]]) { t7.feed(w, lines); w += 700; }
assert.deepStrictEqual(t7.all().map((c) => [c.start, c.text]), [[9700, 'もう一度だけ'], [13200, '光る硝子の街']]);

// 開頭一樣但不同的兩句（今日もまた…）不能被併成一句
const t8 = new OcrTracker();
for (const [k, x] of [[0, '今日もまた眠れないんだって'], [700, '今日もまた眠れないんだって'], [1400, '今日もまた眠れないよなんて'], [2100, '今日もまた眠れないよなんて']]) t8.feed(k, [L(x)]);
assert.strictEqual(t8.all().length, 2);

// 拖動進度條：往回跳不會把兩段接在一起
const t2 = new OcrTracker();
t2.feed(50000, [L('明日は晴れるといいな')]); t2.feed(50700, [L('明日は晴れるといいな')]);
t2.feed(10000, [L('風の音が遠くで聞こえてる')]); t2.feed(10700, [L('風の音が遠くで聞こえてる')]); t2.feed(11400, []); t2.feed(12100, []);
assert.deepStrictEqual(t2.all().map((c) => [c.start, c.text]), [[9700, '風の音が遠くで聞こえてる'], [49700, '明日は晴れるといいな']]);

// 舊句留在畫面上、新句一行行加上去（直書的 MV）：每一行各自是一句，不會黏在一起
const V = (text, x) => ({ text, x, y: 330, w: 60, h: 700 });
const t9 = new OcrTracker();
const L1 = V('遠い記憶をたどっていくの', 180), L2 = V('冷たい風が頬をなでていく', 1640), L3 = V('白い息を重ねて', 1800);
let z = 0;
const s9 = (lines, n) => { for (let i = 0; i < n; i++) { t9.feed(z, lines); z += 700; } };
s9([L1], 6); s9([L1, L2], 6); s9([L1, L2, L3], 6); s9([], 3); s9([V('ほどけた糸を結び直す', 900)], 4);
assert.deepStrictEqual(t9.all().map((c) => [c.start, c.text]), [
  [0, '遠い記憶をたどっていくの'], [3900, '冷たい風が頬をなでていく'], [8100, '白い息を重ねて'], [14400, 'ほどけた糸を結び直す'],
]);
// 前一句在新句出現時結束（卡拉 OK 才會換行）
assert.strictEqual(t9.all()[0].end, 4200);

// 彈幕：從右往左捲的留言不收進字幕，靜止的字幕照常（每秒一張，畫面寬 1920）
const td = new OcrTracker();
const box = (text, x, y, w) => ({ text, x, y, w, h: 70 });
for (let k = 0; k < 12; k++) {
  const lines = [box('初見ですよろしく', 1700 - 250 * k, 100, 400), box('がんばってください', 1900 - 300 * (k - 3), 400, 450)];
  if (k >= 2 && k < 6) lines.push(box('今日はゲームをやります', 500, 950, 900));
  if (k >= 7 && k < 11) lines.push(box('次は宝箱を探します', 520, 950, 860));
  td.feed(k * 1000, lines.filter((l) => l.x < 1920 && l.x + l.w > 0), 500, 1920);
}
assert.deepStrictEqual(td.all().map((c) => [c.start, c.text]), [[1500, '今日はゲームをやります'], [6500, '次は宝箱を探します']]);

// 存檔後重建
const t3 = new OcrTracker(tr.save());
assert.strictEqual(t3.all().length, tr.all().length);
console.log('OCR 時間軸單元測試全部通過');
