// 產生「背景有彈幕」的 OCR 測試影片 dev/test-danmaku.mp4：底部燒錄字幕（節目／切片那種）＋半透明、從右往左捲的留言彈幕＋常駐文字
// 用法：node dev/make-danmaku-video.js <ffmpeg.exe 路徑>
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const ffmpeg = process.argv[2] || 'ffmpeg';
const DUR = 60;
// 字幕（自己編的對話）：[文字, 開始, 結束]
const subs = [
  ['今日はみんなで新しいゲームをやります', 2, 6], ['まずは操作の練習からですね', 6.5, 10], ['ちょっと難しそうだけど頑張ります', 11, 15],
  ['あれ、これどうやって進むの', 15.5, 19], ['右の扉が開いてるみたいです', 20, 24], ['やった、最初のステージ突破', 25, 29],
  ['次は宝箱を探しに行きます', 30, 34], ['敵がいっぱい出てきた', 35, 38.5], ['回復アイテムを使いましょう', 39, 43],
  ['ボスの部屋に着いたかも', 44, 48], ['みんな応援ありがとう', 49, 53], ['今日はここまでにします', 54, 58],
];
// 彈幕（自己編的留言）：[文字, 出現時間, y, 速度 px/s]
const words = ['初見です', 'かわいい', 'がんばれ', 'それは草', 'ナイス判断', 'もう少しで行ける', '右だよ右', '待ってました',
  '神回きた', '天才すぎる', '落ち着いて', 'おつかれさま', 'すごい上手', 'その装備強い', 'わかる', '今の見た？'];
const dm = [];
for (let i = 0; i < 70; i++) dm.push([words[i % words.length], Math.round(((i * 0.83) % (DUR - 4)) * 100) / 100, 40 + ((i * 97) % 480), 160 + ((i * 53) % 140)]);
const font = "fontfile='C\\:/Windows/Fonts/YuGothB.ttc'";
const parts = [`drawtext=${font}:text='テスト配信アーカイブ':fontsize=26:fontcolor=white:x=24:y=20`];
for (const [t, a, y, v] of dm) {
  parts.push(`drawtext=${font}:text='${t}':fontsize=46:fontcolor=white@0.55:borderw=2:bordercolor=gray@0.4:x=w-(t-${a})*${v}:y=${y}:enable='between(t,${a},${a + 12})'`);
}
for (const [t, a, b] of subs) {
  parts.push(`drawtext=${font}:text='${t}':fontsize=50:fontcolor=0x2aa8ff:borderw=6:bordercolor=white:x=(w-text_w)/2:y=h-110:enable='between(t,${a},${b})'`);
}
const filterFile = path.join(__dirname, 'danmaku-filter.txt');
fs.writeFileSync(filterFile, parts.join(',\n'));
execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `gradients=size=1280x720:rate=15:duration=${DUR}:speed=0.01:c0=0xd8d0f0:c1=0xf4f0ff`,
  '-/vf', filterFile, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-g', '30', '-pix_fmt', 'yuv420p',
  path.join(__dirname, 'test-danmaku.mp4')], { stdio: 'inherit' });
fs.unlinkSync(filterFile);
fs.writeFileSync(path.join(__dirname, 'fixtures', 'danmaku.json'),
  JSON.stringify({ videoId: 'danmaku', title: '【雑談】彈幕テスト (dev)', author: 'dev', lengthSeconds: DUR, desc: '', asr: null }));
fs.writeFileSync(path.join(__dirname, 'fixtures', 'danmaku-answer.json'), JSON.stringify(subs));
console.log('ok', subs.length, '句字幕,', dm.length, '條彈幕');
