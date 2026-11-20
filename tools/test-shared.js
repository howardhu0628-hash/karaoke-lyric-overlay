// 離線測試：node tools/test-shared.js（LRCLIB 線上搜尋另外在 tools/test-lrclib.js）
const S = require('../lib/shared.js');
const assert = require('assert');

// 歌曲還是一般影片（分類 + 標題）
{
  const song = (title, category, description) => S.isSongVideo({ title, category, description });
  assert.strictEqual(song('ミライトレイン「星のかけら」 Official Music Video', 'Music'), true);
  assert.strictEqual(song('海辺の手紙', 'Music'), true);
  assert.strictEqual(song('夏の終わり 歌ってみた【星野ミナ】', 'Entertainment'), true);
  assert.strictEqual(song('【MV】ゆめうつつ / かげろう', 'Gaming'), true);
  assert.strictEqual(song('【雑談】今日は久しぶりにゆっくり話す', 'Entertainment'), false);
  assert.strictEqual(song('【切り抜き】星野ミナが爆笑した瞬間', 'Entertainment'), false);
  assert.strictEqual(song('東京で一人暮らしvlog｜休日の過ごし方', 'People & Blogs'), false);
  assert.strictEqual(song('MVPを取った試合', 'Gaming'), false); // MV が単語の一部
  assert.strictEqual(song('なにか', ''), null); // 分類が取れない → 長さで判断
  assert.strictEqual(song('なにか', '', 'Provided to YouTube by Sony Music'), true);
  const hints = S.listenHints({ title: '【切り抜き】星野ミナと月城ユイの雑談', author: 'ミナ切り抜きch' }).split(' ');
  assert.ok(hints.includes('星野ミナと月城ユイの雑談') || hints.some((h) => h.includes('星野ミナ')));
  assert.ok(hints.includes('ミナ切り抜きch'));
}

// 本機 Whisper 歌曲聽寫 → 對齊用的詞、純配樂區間
{
  const segs = [
    { start: 12000, end: 15000, text: '風に揺れる', words: [[12000, 12500, '風'], [12500, 12800, 'に'], [12800, 15000, ' 揺れる']] },
    { start: 16000, end: 18000, text: '静かな夜に' }, // 沒有逐字時間 → 整段當一個詞
    { start: 40000, end: 42000, text: '消えてゆく', words: [[40000, 42000, '消えてゆく']] },
  ];
  const w = S.whisperWords(segs);
  assert.deepStrictEqual(w.map((x) => x.text), ['風', 'に', '揺れる', '静かな夜に', '消えてゆく']);
  assert.strictEqual(w[3].start, 16000);
  assert.deepStrictEqual(S.whisperSpans(segs, 60000), [{ start: 0, end: 12000 }, { start: 18000, end: 40000 }, { start: 42000, end: 60000 }]);
  assert.strictEqual(S.whisperWords([{ start: 0, end: 1, text: '饰', words: [[0, 1, '饰']] }], (t) => t.replace('饰', '飾'))[0].text, '飾');
}
// LRC
const c = S.parseLrc('[offset:+100]\n[00:01.50]あ\n[00:03.00][00:10.00]い\n[00:05.123]\n[ar:x]');
assert.deepStrictEqual(c.map(x => [x.start, x.text]), [[1400, 'あ'], [2900, 'い'], [5023, ''], [9900, 'い']]);
assert.strictEqual(c[0].end, 2900);
assert.strictEqual(S.findIndex(c, 0), -1); assert.strictEqual(S.findIndex(c, 3000), 1); assert.strictEqual(S.findIndex(c, 99999), 3);
// json3
const j = S.parseJson3({ events: [{ tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: 'こんにちは' }] }, { tStartMs: 2000, aAppend: 1, segs: [{ utf8: '\n' }] }, { tStartMs: 3000, dDurationMs: 2000, segs: [{ utf8: '世界' }, { utf8: '\n次' }] }] });
assert.deepStrictEqual(j.map(x => [x.start, x.end, x.text]), [[0, 3000, 'こんにちは'], [3000, 5000, '世界 次']]);
// 翻唱：搜尋詞不帶翻唱者（標題裡 Cover 前那段、頻道名）
assert.deepStrictEqual(S.buildQueries('トウキョウ・シャンディ・ランデヴ / 緑仙 Cover', '緑仙 / Ryushen'), ['トウキョウ・シャンディ・ランデヴ']);
assert.deepStrictEqual(S.buildQueries('夜に駆ける / 星街すいせい(cover)', 'Suisei Channel'), ['夜に駆ける']);
assert.strictEqual(S.buildQueries('ダンスロボットダンス / ナユタン星人 feat.初音ミク', 'ナユタン星人')[0], 'ダンスロボットダンス / ナユタン星人 feat.初音ミク');
assert.deepStrictEqual(S.buildQueries('【Ado】BRAIN 歌いました', 'Ado'), ['BRAIN']);
assert.deepStrictEqual(S.buildQueries('ロキ 歌ってみた ver.まふまふ', 'まふまふちゃんねる'), ['ロキ']);
assert.deepStrictEqual(S.buildQueries('シャルル (cover) / 天月', 'x'), ['シャルル']);
assert.deepStrictEqual(S.buildQueries('【Ado】うっせぇわ', 'Ado'), ['Ado うっせぇわ', 'うっせぇわ']);
console.log('offline ok');
