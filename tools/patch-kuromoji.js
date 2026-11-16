// 修補 vendor/kuromoji/kuromoji.js（從 npm 重新下載 kuromoji 0.1.2 之後要再跑一次）：
//   node tools/patch-kuromoji.js
// 原版用純 JavaScript 的 zlib.js 解壓 17MB 字典，在 service worker 裡要 20 秒以上，期間背景什麼請求都卡住
// （翻譯、OCR、伴奏、ping 全部排隊，ping 超過 4 秒就被當成「服務沒開」）。
// 修補後：background.js 先用瀏覽器內建的 DecompressionStream 解好（快上百倍、不佔住執行緒），
// kuromoji 收到的已經不是 gzip 就直接用；收到 gzip（沒經過我們的 XHR 替代品，例如 node）還是照舊用 zlib.js 解。
'use strict';
const fs = require('fs');
const path = require('path');
const f = path.join(__dirname, '..', 'vendor', 'kuromoji', 'kuromoji.js');
let s = fs.readFileSync(f, 'utf8');
const MARK = 'self.YTLS_KUROMOJI_RAW_OK = true;';
if (s.includes(MARK)) { console.log('已經修補過了'); process.exit(0); }
const old = '        var gz = new zlib.Zlib.Gunzip(new Uint8Array(arraybuffer));\n        var typed_array = gz.decompress();\n        callback(null, typed_array.buffer);';
if (!s.includes(old)) { console.error('找不到要修補的地方（kuromoji 版本不同？）'); process.exit(1); }
s = s.replace(old,
  '        var u8 = new Uint8Array(arraybuffer);\n' +
  '        // YTLS：已經用瀏覽器內建的 DecompressionStream 解好了就直接用；還是 gzip 才用 zlib.js 解\n' +
  '        var typed_array = (u8[0] === 0x1f && u8[1] === 0x8b) ? new zlib.Zlib.Gunzip(u8).decompress() : u8;\n' +
  '        callback(null, typed_array.buffer);');
s = '// YTLS 修補（tools/patch-kuromoji.js）：字典可以先在外面解壓\ntry { ' + MARK + ' } catch (e) { /* 沒有 self */ }\n' + s;
fs.writeFileSync(f, s, 'utf8');
console.log('kuromoji 修補完成');
