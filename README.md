繁體中文 | [简体中文](README.zh-CN.md)

# YT 歌詞字幕

Edge 擴充功能。在 YouTube、YouTube Music 上疊一層卡拉 OK 字幕：

- 日文原文，漢字上方標假名
- 羅馬拼音
- 中文翻譯

逐字填色，聽歌時可以跟著唱。

> 個人興趣做的學習用工具，跟 YouTube／Google 沒有任何關係。程式裡不附任何歌詞；歌詞和字幕都是在你的電腦上即時取得。

**介面語言**：繁體中文、簡體中文。擴充功能跟著 Edge 的語言自動選（面板「顯示設定」可以手動換），安裝程式跟著 Windows 的語言。

## 功能

**歌詞和字幕來源**：自動挑最合適的，也可以在面板手動換。
- YouTube Music 官方歌詞、上傳者字幕、[LRCLIB](https://lrclib.net)、說明欄裡的歌詞、自動字幕
- **畫面字幕（OCR）**：讀影片畫面上燒好的歌詞或字幕。會自動略過彈幕、直播聊天室。
- **AI 聽寫**：沒有字幕的直播回放、節目、歌曲，用 Whisper 聽寫成日文字幕。可以用自己的 NVIDIA 顯示卡跑，也可以用雲端（Groq，有免費額度）。

**唱歌用**
- 卡拉 OK 伴奏：先找官方伴奏（YouTube、niconico、Bilibili），找不到就用 AI 把原唱去掉
- 升降 Key

**三種模式**：🎤 唱歌、🎬 看影片、📡 直播。

## 安裝（一般使用者）

**需要**：Windows 10／11、Microsoft Edge。

1. 到 [Releases](../../releases) 下載最新的 `YTLyricSub-v*.zip`，**整個解壓縮**出來。
2. 打開裡面的 `先看我.txt`，照著做。

大致流程：
- 雙擊「安裝.cmd」，選要裝哪一級。安裝程式會看你的顯示卡建議一級。

  | 等級 | 功能 | 下載 |
  |---|---|---|
  | 1 | 歌詞、字幕、翻譯、假名 | 不用 |
  | 2 | ＋畫面字幕 OCR | 約 0.2 GB |
  | 3 | ＋雲端 AI 聽寫、官方伴奏、升降 Key | 約 0.5 GB |
  | 4 | 全部：＋本機 AI 聽寫、AI 去人聲（建議 NVIDIA RTX、顯存 6 GB 以上） | 約 5 GB |

- 最後在 Edge 的擴充功能頁打開「開發人員模式」，「載入解壓縮」選安裝資料夾裡的 `app`。
- 裝好後，YouTube 播放器右下角會多一個「詞」按鈕。

**安裝程式做的事**
- 只裝在你選的資料夾（預設 `%LOCALAPPDATA%\YTLyricSub`），不需要系統管理員權限。
- 其他元件都從官方來源下載，見「[第三方元件](THIRD-PARTY-NOTICES.md)」。
- 建立兩個登入後自動啟動的排程工作，就是下面講的本機服務。
- 「解除安裝.cmd」只會刪掉它自己裝的東西。

## 更新、加功能、解除安裝

- **更新到新版**：到 [Releases](../../releases) 下載新版 zip、解壓縮，再雙擊一次裡面的「安裝.cmd」。
  - 會裝到原本的資料夾、照原本的等級，已經下載的東西（模型、工具）不會重抓，快取都保留。
  - 裝好後開著的 YouTube 分頁按 F5 就會換成新版，Edge 的擴充功能不用重新載入。
  - 想知道有沒有新版：在這個頁面右上角按「Watch」→「Custom」→ 勾「Releases」，發新版時 GitHub 會通知你。
- **想加功能（升級等級）**：再雙擊一次「安裝.cmd」，選比較大的數字，只會補下載缺的部分。
  等級不能往下降：要變小請先解除安裝再重裝。
- **解除安裝**：雙擊安裝資料夾裡的「解除安裝.cmd」（只刪它自己裝的東西），再到 Edge 的擴充功能頁把它移除。

## 資料會送到哪裡

| 送到 | 送什麼 | 什麼時候 |
|---|---|---|
| lrclib.net | 歌名、歌手 | 找歌詞時 |
| translate.googleapis.com | 要翻譯的歌詞／字幕文字 | 顯示翻譯時 |
| YouTube | 下載影片音訊（yt-dlp） | AI 聽寫回放、做伴奏時 |
| niconico、Bilibili | 搜尋官方伴奏 | 找伴奏時 |
| Groq | 影片聲音 | **只有**你自己填了金鑰、選了雲端聽寫時 |

- 兩個本機服務（OCR `127.0.0.1:8766`、AI 聽寫 `127.0.0.1:8767`）只在你自己的電腦上，只接受這個擴充功能的請求。
- 金鑰只存在你的電腦上。
- 沒有任何統計或追蹤。

## 注意事項

- 下載 YouTube 音訊、使用 YouTube Music 歌詞，可能不符合 YouTube 的使用條款。請只用在個人學習和欣賞，自行負責。
- **翻譯是 Google 翻譯的機器翻譯**，可能不準。用的是 Google 翻譯網頁版的免費介面（不是官方付費的 Cloud Translation API），Google 隨時可能限制或停用；要翻譯的歌詞、字幕文字會送到 Google。
- 同步歌詞來自 [LRCLIB](https://lrclib.net)（社群整理的公開歌詞資料庫）；AI 聽寫的雲端選項由 [Groq](https://groq.com) 提供。
- 會員限定、需要登入的影片下載不了，會改成邊播邊聽寫。
- 目前只支援 Windows＋Edge。Chrome 理論上能載入，但沒測過，安裝程式也只註冊 Edge。

## 開發

```
manifest.json, background.js, content.js, hook.js   擴充功能本體
lib/                  共用程式：對時、假名、OCR 追蹤、簡繁漢字修正…
ocr-server/           畫面字幕 OCR 服務（RapidOCR＋onnxruntime-directml，127.0.0.1:8766）
listen-server/        AI 聽寫、伴奏服務（faster-whisper、BS-RoFormer、yt-dlp，127.0.0.1:8767）
native-host/          「▶ 啟動本機服務」按鈕用的小幫手（Native Messaging）
installer/            安裝、解除安裝程式
vendor/kuromoji/      日文斷詞（Apache-2.0）
tools/                打包、測試、產生資料表的小工具
dev/                  開發測試頁、測試腳本
```

**只改擴充功能**
- `edge://extensions` → 開發人員模式 → 載入解壓縮，選這個資料夾。
- 改完按擴充功能的「重新載入」，再重新整理 YouTube。

**要用本機服務**
1. 打包：`python tools/build-package.py`，產生 `dist/YTLyricSub-v<版本>.zip`。
2. 用裡面的「安裝.cmd」裝一次，就有 Python 環境、模型和排程工作。

**不用安裝程式、直接跑服務**
- 沒有 `ytls-config.json` 時，服務先從 PATH 找 yt-dlp／node／ffmpeg，找不到就到環境變數 `YTLS_TOOLS` 指的資料夾找。
- Whisper 和去人聲模型的位置用環境變數 `YTLS_SOVITS` 指定。
- 細節見 `listen-server/paths.py`。

**測試**
- `node tools/test-shared.js`、`node tools/test-furigana.js`、`node tools/test-ocr.js`
- `node dev/danmaku-track.js`：用自製的彈幕測試影片資料跑畫面字幕時間軸。
- 不用連 YouTube 的測試頁：先 `node dev/make-ocr-video.js <ffmpeg 路徑>` 產生測試影片，再 `node dev/serve.js`，
  打開 `http://localhost:8765/watch?v=ocrtest&fx=ocrtest&video=/dev/test-lyrics.mp4`。

## 授權

- 本專案：[MIT](LICENSE)。
- 第三方元件各自的授權：見 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
