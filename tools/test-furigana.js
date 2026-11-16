// 假名標註／拼音的單元測試（不載入 kuromoji，用手寫的斷詞結果）：node tools/test-furigana.js
const F = require('../lib/furigana.js');
const assert = require('assert');

assert.strictEqual(F.hiraToRomaji('しゃしん'), 'shashin');
assert.strictEqual(F.hiraToRomaji('きって'), 'kitte');
assert.strictEqual(F.hiraToRomaji('まっちゃ'), 'matcha');
assert.strictEqual(F.hiraToRomaji('ファン'), 'fan');
assert.strictEqual(F.hiraToRomaji('パーティー'), 'paatii');
assert.strictEqual(F.hiraToRomaji('ウィンク'), 'winku');
assert.strictEqual(F.hiraToRomaji('きんようび'), "kin'youbi");
assert.deepStrictEqual(F.alignToken('引き換え', 'ひきかえ'), [{ t: '引', r: 'ひ' }, { t: 'き' }, { t: '換', r: 'か' }, { t: 'え' }]);
assert.deepStrictEqual(F.alignToken('溶け', 'とけ'), [{ t: '溶', r: 'と' }, { t: 'け' }]);

// kuromoji 斷詞結果的格式（日が昇り出した）
const tk = (surface_form, reading, pos, pos_detail_1 = '*') => ({ surface_form, reading, pos, pos_detail_1 });
const toks = [tk('日', 'ヒ', '名詞'), tk('が', 'ガ', '助詞', '格助詞'), tk('昇り', 'ノボリ', '動詞'), tk('出し', 'ダシ', '動詞'), tk('た', 'タ', '助動詞'), tk('空', 'ソラ', '名詞'), tk('と', 'ト', '助詞', '並立助詞'), tk('君', 'キミ', '名詞'), tk('は', 'ハ', '助詞', '係助詞'), tk('、', '、', '記号')];
assert.deepStrictEqual(F.toRuby(toks), [
  { t: '日', r: 'ひ' }, { t: 'が' }, { t: '昇', r: 'のぼ' }, { t: 'り' }, { t: '出', r: 'だ' }, { t: 'した' },
  { t: '空', r: 'そら' }, { t: 'と' }, { t: '君', r: 'きみ' }, { t: 'は、' },
]);
assert.strictEqual(F.toRomaji(toks), 'hi ga nobori dashita sora to kimi wa,');
// 促音跨詞、熟字訓、括號
const t2 = [tk('「', '「', '記号'), tk('ありがとう', 'アリガトウ', '感動詞'), tk('」', '」', '記号'), tk('だけ', 'ダケ', '助詞'), tk('だっ', 'ダッ', '助動詞'), tk('た', 'タ', '助動詞')];
assert.strictEqual(F.toRomaji(t2), '「arigatou」 dakedatta');
const t3 = [tk('二', 'ニ', '名詞', '数'), tk('人', 'ニン', '名詞', '接尾'), tk('だけ', 'ダケ', '助詞')];
assert.strictEqual(F.toRomaji(t3), 'futari dake');
assert.deepStrictEqual(F.toRuby(t3), [{ t: '二人', r: 'ふたり' }, { t: 'だけ' }]);
const t4 = [tk('し', 'シ', '動詞', '自立'), tk('て', 'テ', '動詞', '非自立'), tk('た', 'タ', '助動詞')];
assert.strictEqual(F.toRomaji(t4), 'shiteta');
assert.strictEqual(F.looksJapanese(['風に揺れる', '', '我愛你']), true);
assert.strictEqual(F.looksJapanese(['我愛你', '再見']), false);
console.log('假名／拼音單元測試全部通過');
