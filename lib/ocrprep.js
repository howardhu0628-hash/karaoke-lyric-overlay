// OCR 前的影像處理：同一張畫面做出幾種版本分別辨識，再把結果合併。
// - 原圖（一般字幕、細小的主歌歌詞）
// - 白字遮罩：只留「很亮又沒有顏色」的像素（白色歌詞），加粗筆畫再縮小 → 讀得到 MV 副歌那種超大、超細、壓在天空花海上的白字
// - 暗字遮罩：同理處理黑色大字
// content script 與測試頁共用；只用 canvas，沒有外部套件。
(function (root) {
  'use strict';

  function drawScaled(src, srcW, srcH, w) {
    const h = Math.round((srcH * w) / srcW);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0, w, h);
    return c;
  }

  // pick(r,g,b) 為 true 的像素當成文字，加粗 rad 像素，輸出白底黑字並縮到 outW 寬
  function maskCanvas(base, pick, rad, outW) {
    const w = base.width, h = base.height;
    const g = base.getContext('2d', { willReadFrequently: true });
    const src = g.getImageData(0, 0, w, h).data;
    const on = new Uint8Array(w * h);
    let count = 0;
    for (let i = 0, k = 0; i < src.length; i += 4, k++) if (pick(src[i], src[i + 1], src[i + 2])) { on[k] = 1; count++; }
    // 文字像素太少（沒字）或太多（整片天空、白光畫面）就不值得送去辨識
    const ratio = count / (w * h);
    if (ratio < 0.002 || ratio > 0.35) return null;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const og = out.getContext('2d');
    const img = og.createImageData(w, h);
    const p = img.data;
    p.fill(255);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!on[y * w + x]) continue;
        for (let dy = -rad; dy <= rad; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -rad; dx <= rad; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = (yy * w + xx) * 4;
            p[j] = p[j + 1] = p[j + 2] = 0;
          }
        }
      }
    }
    og.putImageData(img, 0, 0);
    if (outW >= w) return out;
    const small = document.createElement('canvas');
    small.width = outW; small.height = Math.round((h * outW) / w);
    const sg = small.getContext('2d');
    sg.imageSmoothingQuality = 'high';
    sg.drawImage(out, 0, 0, small.width, small.height);
    return small;
  }

  const white = (minV, sat) => (r, g, b) => { const mn = Math.min(r, g, b); return mn >= minV && Math.max(r, g, b) - mn <= sat; };
  const dark = (maxV, sat) => (r, g, b) => { const mx = Math.max(r, g, b); return mx <= maxV && mx - Math.min(r, g, b) <= sat; };

  /**
   * src：video 或 image；mode：'live'（播放中，省資源）或 'full'（快速掃描，盡量讀）；skip：這次不做的版本（Set）
   * maxW：原圖最寬多少（預設 1920；節目字幕字很大，用 1280 辨識快一倍、讀到的一樣）
   * 回傳 [{ canvas, kind }]；辨識結果的座標要依 canvas 尺寸換算回原畫面
   */
  function variants(src, mode, skip, maxW = 1920) {
    const sw = src.videoWidth || src.naturalWidth || src.width, sh = src.videoHeight || src.naturalHeight || src.height;
    if (!sw || !sh) return [];
    const out = [{ canvas: drawScaled(src, sw, sh, Math.min(maxW, sw)), kind: 'orig' }];
    const base = drawScaled(src, sw, sh, 960);
    const want = (kind) => !(skip && skip.has(kind));
    const add = (kind, make) => { if (!want(kind)) return; const c = make(); if (c) out.push({ canvas: c, kind }); };
    add('white1', () => maskCanvas(base, white(215, 20), 1, 640));
    if (mode === 'full') {
      add('white2', () => maskCanvas(base, white(215, 20), 2, 480));
      add('dark1', () => maskCanvas(base, dark(60, 40), 1, 640));
    }
    return out;
  }

  const JP = /[぀-ヿ㐀-鿿]/g;
  // 一行辨識結果的「乾淨程度」：日文字越多越好，亂碼符號扣分
  function quality(text) {
    const s = String(text || '').replace(/\s/g, '');
    const jp = (s.match(JP) || []).length;
    const other = [...s].length - jp;
    return jp - 2 * other - (/^[ー一ーｰ\-・/]/.test(s) ? 2 : 0);
  }

  // 兩個框重疊的比例（以較小的框為準）
  function overlapRatio(a, b) {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const small = Math.max(1, Math.min(a.w * a.h, b.w * b.h));
    return (ix * iy) / small;
  }

  // 把幾個版本的辨識結果合併：座標統一換算成「高 1080 的畫面」。
  // 同一個位置（框重疊一半以上）或文字很像的，視為同一段，只留最乾淨的那個版本（kind 記下是哪個版本讀到的）
  function mergeResults(results, alike) {
    const all = [];
    for (const { lines, w, h, kind } of results) {
      const k = 1080 / h;
      for (const l of lines || []) all.push({ text: l.text, x: l.x * k, y: l.y * k, w: l.w * k, h: l.h * k, q: quality(l.text), kind });
    }
    all.sort((a, b) => b.q - a.q);
    const kept = [];
    for (const l of all) {
      if (kept.some((k) => overlapRatio(k, l) >= 0.5 || alike(k.text, l.text))) continue;
      kept.push(l);
    }
    return kept;
  }

  const api = { variants, mergeResults, quality, maskCanvas, white, dark };
  root.YTLSPrep = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
