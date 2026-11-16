// offscreen 文件：只處理 service worker 轉來、target 是 'ytls-offscreen' 的訊息（content script 的訊息也會廣播到這裡，一律不理）。
// kuromoji 的字典處理和斷詞在 Edge 的擴充功能環境裡很慢（建字典約 5～7 秒、全是同步運算），
// 放在 service worker 會讓背景其他請求（翻譯、OCR、伴奏、ping）全部卡住；搬到這裡之後背景隨時都能回應，
// 而且 service worker 被瀏覽器收掉時字典還留在這裡，不用每次重載。
const T = self.YTLSTok;
const offHandlers = {
  async warm() { T.getTokenizer().catch(() => {}); return true; },
  async analyze({ lines }) { return T.analyzeJapanese(lines || []); },
  async align(p) { return T.alignLyrics(p); },
  async diag() { return { tok: T.diag, files: self.YTLS_TOK_FILES || {} }; },
};
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'ytls-offscreen') return false;
  const h = offHandlers[msg.type];
  if (!h) return false;
  h(msg).then(
    (data) => sendResponse({ ok: true, data }),
    (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }),
  );
  return true;
});
