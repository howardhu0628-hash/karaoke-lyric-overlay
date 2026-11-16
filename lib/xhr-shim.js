// kuromoji 用 XMLHttpRequest 讀字典。service worker 沒有 XHR；offscreen 文件有，但原生 XHR 拿到的是 gzip，
// kuromoji 會用純 JS 的 zlib.js 解壓（Edge 的擴充功能環境裡 17MB 要 20 秒以上）。
// 這裡用 fetch＋瀏覽器內建的 DecompressionStream（原生、非同步）先解好，kuromoji 修補過（tools/patch-kuromoji.js）就直接用。
// 只有 service worker 和 offscreen 文件會載入這支；offscreen（有 document）即使有原生 XHR 也換掉。
(function () {
  if (typeof XMLHttpRequest !== 'undefined' && typeof document === 'undefined') return;
  self.YTLS_TOK_FILES = {}; // 除錯：每個字典檔花多久
  self.XMLHttpRequest = class {
    open(_method, url) { this.url = url; }
    send() {
      // 讀檔、解壓縮、onload 裡的處理任何一步出錯都要回報 onerror，不然 kuromoji 永遠等不到回呼
      let done = false;
      const fail = (e) => { if (!done) { done = true; this.onerror && this.onerror(e); } };
      const t0 = Date.now(), name = String(this.url).split('/').pop();
      const note = (k) => { self.YTLS_TOK_FILES[name] = k + ' ' + (Date.now() - t0) + 'ms'; };
      fetch(this.url, { signal: AbortSignal.timeout(30000) }).then(async (r) => {
        this.status = r.status; this.statusText = r.statusText;
        let buf = await r.arrayBuffer();
        const h = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
        if (self.YTLS_KUROMOJI_RAW_OK && typeof DecompressionStream !== 'undefined' && h[0] === 0x1f && h[1] === 0x8b) {
          buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
        }
        this.response = buf;
        if (done) return;
        const tS = Date.now();
        try { this.onload && this.onload.call(this); done = true; note('ok sync' + (Date.now() - tS)); } catch (e) { note('ERR ' + e.message); fail(e); }
      }).catch((e) => { note('FAIL ' + e.message); fail(e); });
    }
  };
})();
