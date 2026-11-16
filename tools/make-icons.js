// 產生擴充功能圖示（橘色圓角方塊＋兩條字幕線＋音符點）。用法：node tools/make-icons.js
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (~c) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function shape(x, y) { // 0..1 座標 → [r,g,b,a]
  const rr = 0.22, inBox = (() => { const dx = Math.max(rr - x, 0, x - (1 - rr)), dy = Math.max(rr - y, 0, y - (1 - rr)); return dx * dx + dy * dy <= rr * rr; })();
  if (!inBox) return [0, 0, 0, 0];
  const bar = (x0, x1, y0, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  if (bar(0.18, 0.82, 0.60, 0.70) || bar(0.28, 0.72, 0.76, 0.85)) return [255, 255, 255, 255];
  // 音符
  const note = ((x - 0.40) ** 2) / 0.010 + ((y - 0.42) ** 2) / 0.006 <= 1 || bar(0.47, 0.53, 0.14, 0.42) || bar(0.47, 0.66, 0.14, 0.21);
  if (note) return [40, 30, 20, 255];
  return [255, 179, 71, 255];
}
for (const size of [16, 32, 48, 128]) {
  const ss = 4, raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const p = shape((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
        acc[0] += p[0] * p[3]; acc[1] += p[1] * p[3]; acc[2] += p[2] * p[3]; acc[3] += p[3];
      }
      const o = y * (size * 4 + 1) + 1 + x * 4, a = acc[3];
      raw[o] = a ? acc[0] / a : 0; raw[o + 1] = a ? acc[1] / a : 0; raw[o + 2] = a ? acc[2] / a : 0; raw[o + 3] = a / (ss * ss);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(path.join(__dirname, '..', 'icons', size + '.png'), png);
}
console.log('icons ok');
