# 第三方元件

## 放在這個 repo 裡的

| 元件 | 位置 | 授權 |
|---|---|---|
| [kuromoji.js](https://github.com/takuyaa/kuromoji.js)（已修改，見 `tools/patch-kuromoji.js`） | `vendor/kuromoji/` | Apache-2.0，見 `vendor/kuromoji/LICENSE-2.0.txt` |
| mecab-ipadic 2.7.0（kuromoji 的字典資料） | `vendor/kuromoji/dict/` | 見 `vendor/kuromoji/NOTICE.md` |
| BS-RoFormer 推論程式（從 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 的 `tools/uvr5` 複製，未修改） | `listen-server/uvr/` | MIT，見 `listen-server/uvr/LICENSE-GPT-SoVITS.txt` |

## 安裝時才從官方來源下載的

這些**不在** repo 和安裝包裡，是安裝程式在你的電腦上下載的。授權以各自官方頁面為準。

| 元件 | 來源 | 授權 |
|---|---|---|
| uv、Python 3.12 | github.com/astral-sh/uv、python-build-standalone | MIT／Apache-2.0、PSF |
| PyTorch | download.pytorch.org | BSD-3-Clause |
| faster-whisper、CTranslate2 | PyPI | MIT |
| Whisper large-v3-turbo（CTranslate2 格式） | Hugging Face `mobiuslabsgmbh/faster-whisper-large-v3-turbo` | MIT |
| RapidOCR、onnxruntime-directml | PyPI | Apache-2.0、MIT |
| librosa、numpy、scipy 等 | PyPI | 各自授權（ISC、BSD） |
| BS-RoFormer 去人聲模型權重 | UVR 公開模型庫（github.com/TRvlvr/model_repo） | 見原始專案 |
| yt-dlp | github.com/yt-dlp/yt-dlp | Unlicense |
| Node.js | nodejs.org | MIT |
| ffmpeg（BtbN 的 GPL 版） | github.com/BtbN/FFmpeg-Builds | GPL-3.0 |
