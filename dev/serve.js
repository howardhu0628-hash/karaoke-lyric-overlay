// 開發用測試頁伺服器：模擬 YouTube 的 /watch 網址，載入真正的 content.js / overlay.css。
// 用法：node dev/serve.js  → http://localhost:8765/watch?v=test
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4', '.png': 'image/png', '.json': 'application/json' };
const CORS = {
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Private-Network': 'true',
};
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  // 開發用：把 YouTube 頁面抓到的資料存成測試素材 dev/fixtures/<name>.json
  if (req.method === 'POST' && url.pathname === '/save') {
    const name = (url.searchParams.get('name') || '').replace(/[^\w.-]/g, '');
    if (!name) { res.writeHead(400, CORS); return res.end('bad name'); }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      fs.mkdirSync(path.join(__dirname, 'fixtures'), { recursive: true });
      let body = Buffer.concat(chunks).toString('utf8');
      // 也接受表單送出（data=...），因為 YouTube 頁面的 CSP 擋 fetch 到本機
      if (/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) body = new URLSearchParams(body).get('data') || '';
      fs.writeFileSync(path.join(__dirname, 'fixtures', name + '.json'), body);
      res.writeHead(200, CORS); res.end('ok');
    });
    return;
  }
  // 開發用：存一張影片畫面（OCR 實驗用）到 dev/frames/<name>，不進備份，用完就刪
  if (req.method === 'POST' && url.pathname === '/save-frame') {
    const name = (url.searchParams.get('name') || '').replace(/[^\w.-]/g, '');
    if (!/\.(jpg|png)$/.test(name)) { res.writeHead(400, CORS); return res.end('bad name'); }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      fs.mkdirSync(path.join(__dirname, 'frames'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, 'frames', name), Buffer.concat(chunks));
      res.writeHead(200, CORS); res.end('ok');
    });
    return;
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/watch' || p === '/') p = '/dev/harness.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('404'); }
  const stat = fs.statSync(f), type = types[path.extname(f)] || 'application/octet-stream';
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = Number(range[1] || 0), end = range[2] ? Number(range[2]) : stat.size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    return fs.createReadStream(f, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(8765, '127.0.0.1', () => console.log('harness: http://localhost:8765/watch?v=test'));
