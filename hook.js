// 在頁面主世界（MAIN world）執行：
// 1) 攔截播放器自己發出的 /api/timedtext 請求，取得帶 pot 權杖的字幕網址（新版 YouTube 沒有它會回傳空白）。
// 2) 提供 player API 給 content script（讀字幕軌、暫時開啟字幕）。
(function () {
  'use strict';
  if (window.__ytlsHooked) return;
  window.__ytlsHooked = true;

  const NS = 'ytls';
  const report = (url) => {
    try {
      const abs = new URL(url, location.href).href;
      if (abs.includes('/api/timedtext')) window.postMessage({ ns: NS, dir: 'evt', type: 'timedtext', url: abs }, location.origin);
    } catch (e) { /* ignore */ }
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (typeof url === 'string' || url instanceof URL) report(String(url));
    return origOpen.apply(this, arguments);
  };
  const origFetch = window.fetch;
  window.fetch = function (input) {
    try { report(typeof input === 'string' ? input : (input && input.url) || String(input)); } catch (e) { /* ignore */ }
    return origFetch.apply(this, arguments);
  };

  // 3) 真‧卡拉 OK：content script 在影片元素上設 data-ytls-gain（導唱比例）時，YouTube 自己設 video.volume
  //    直接乘上這個比例，YouTube 想要的音量記在 data-ytls-want、讀回去也是它（YouTube 的音量條不會亂跳）。
  //    之前是 YouTube 改完音量、content script 收到 volumechange 才改回來，中間會漏出一瞬間的原唱。
  //    content script 在自己的世界用的是原生的 volume，不經過這裡。
  const vdesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  if (vdesc && vdesc.get && vdesc.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
      configurable: true, enumerable: vdesc.enumerable,
      get() {
        const d = this.dataset;
        return d && d.ytlsGain != null && d.ytlsWant != null ? Number(d.ytlsWant) : vdesc.get.call(this);
      },
      set(x) {
        const d = this.dataset, g = d && d.ytlsGain != null ? Number(d.ytlsGain) : NaN;
        const n = Number(x);
        if (!Number.isFinite(g) || !(n >= 0 && n <= 1)) return vdesc.set.call(this, x); // 不合法的值照原生行為丟錯
        d.ytlsWant = String(n);
        vdesc.set.call(this, Math.min(1, Math.max(0, n * g)));
      },
    });
    document.documentElement.dataset.ytlsVolHook = '1';
  }

  const player = () => document.getElementById('movie_player');

  const cmds = {
    // YouTube Music：換歌不一定換網址（逛別的頁面時也繼續播），直接問播放器目前是哪首
    vid() {
      const p = player();
      try { return (p && p.getVideoData && p.getVideoData().video_id) || null; } catch (e) { return null; }
    },
    info() {
      const p = player();
      let pr = p && p.getPlayerResponse && p.getPlayerResponse();
      if (!pr || !pr.videoDetails) pr = window.ytInitialPlayerResponse;
      if (!pr || !pr.videoDetails) return null;
      const vd = pr.videoDetails;
      const tracks = (((pr.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks || []).map((t) => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode,
        kind: t.kind || '',
        vssId: t.vssId || '',
        name: (t.name && (t.name.simpleText || (t.name.runs || []).map((r) => r.text).join(''))) || t.languageCode,
        isTranslatable: !!t.isTranslatable,
      }));
      // YouTube 分類（Music、Entertainment、Gaming…）：判斷是歌曲還是一般影片用
      const mf = (pr.microformat || {}).playerMicroformatRenderer || {};
      return {
        videoId: vd.videoId, title: vd.title, author: vd.author, description: vd.shortDescription || '',
        category: mf.category || '',
        isLive: !!vd.isLive, // 正在直播（回放不算）
        lengthSeconds: Number(vd.lengthSeconds) || 0, tracks,
        // getOption('captions','track') 在字幕關閉時也會回傳上次的軌，所以看 CC 按鈕狀態
        captionsOn: !!(p && p.querySelector('.ytp-subtitles-button[aria-pressed="true"]')),
      };
    },
    // 暫時開啟指定字幕軌，讓播放器發出帶 pot 的 timedtext 請求
    enableTrack({ languageCode, kind }) {
      const p = player();
      if (!p || !p.setOption) return false;
      // 字幕模組已載入時，切到同一軌不會重新發請求：先卸載再載入
      try { p.unloadModule && p.unloadModule('captions'); } catch (e) { /* ignore */ }
      try { p.loadModule && p.loadModule('captions'); } catch (e) { /* ignore */ }
      let list = [];
      // 只有自動字幕的影片，不加 includeAsr 會拿到空清單
      try { list = p.getOption('captions', 'tracklist', { includeAsr: true }) || []; } catch (e) { /* ignore */ }
      const want = list.find((t) => t.languageCode === languageCode && (kind === 'asr') === (t.kind === 'asr')) ||
        list.find((t) => t.languageCode === languageCode) || { languageCode };
      try { p.setOption('captions', 'track', want); } catch (e) { return false; }
      return true;
    },
    disableCaptions() {
      const p = player();
      try { p && p.unloadModule && p.unloadModule('captions'); } catch (e) { /* ignore */ }
      return true;
    },
  };

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.ns !== NS || d.dir !== 'req') return;
    let data = null, error = null;
    try { data = cmds[d.cmd] ? cmds[d.cmd](d.args || {}) : null; } catch (err) { error = String(err); }
    window.postMessage({ ns: NS, dir: 'res', id: d.id, data, error }, location.origin);
  });
})();
