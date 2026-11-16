// 產生 OCR 測試影片 dev/test-lyrics.mp4（畫面上燒錄歌詞＋常駐的頻道文字）
// 用法：node dev/make-ocr-video.js <ffmpeg.exe 路徑>
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const ffmpeg = process.argv[2] || 'ffmpeg';
const lines = [
  ['風の音が遠くで聞こえてる', 2, 7], ['二人で歩いた坂道の上で', 7.5, 12], ['「またね」と手を振った', 16, 19.5],
  ['その笑顔を覚えている', 19.5, 23], ['夕焼けの色が街を包む', 23, 27], ['線路の向こうに手を伸ばした', 27, 31],
  ['初めて会った日から', 33, 36], ['ずっと同じ空を見ていた', 36, 40],
];
const font = "fontfile='C\\:/Windows/Fonts/YuGothB.ttc'";
const parts = [`drawtext=${font}:text='チャンネル登録よろしく':fontsize=22:fontcolor=white:x=20:y=20`];
for (const [t, a, b] of lines) {
  parts.push(`drawtext=${font}:text='${t}':fontsize=44:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=h-120:enable='between(t,${a},${b})'`);
}
const filterFile = path.join(__dirname, 'ocr-filter.txt');
fs.writeFileSync(filterFile, parts.join(',\n'));
execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=size=1280x720:rate=10:duration=45:speed=0.02',
  '-/vf', filterFile, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-g', '20', '-pix_fmt', 'yuv420p',
  path.join(__dirname, 'test-lyrics.mp4')], { stdio: 'inherit' });
fs.writeFileSync(path.join(__dirname, 'fixtures', 'ocrtest.json'),
  JSON.stringify({ videoId: 'ocrtest', title: 'OCR テスト動画 (dev)', author: 'dev', lengthSeconds: 45, desc: '', asr: null }));
console.log('ok', lines.length, '行');
