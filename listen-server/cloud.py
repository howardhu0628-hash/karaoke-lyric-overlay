# YT 歌詞字幕：雲端聽寫（Groq 代跑的 Whisper large-v3-turbo，用使用者自己的金鑰）
# 擴充功能在請求標頭 X-YTLS-Cloud 帶金鑰（只送到本機服務；服務只放在記憶體、不存檔、不寫進記錄）。
# 這裡把音訊轉成 FLAC 送到 Groq，回傳和本機聽寫小程序（whisper_worker.py）一樣格式的句子；
# 失敗（金鑰錯、額度用完、連不上）丟 CloudError，呼叫的地方改用本機聽寫。
# Groq 的限制（2026-11 查）：免費方案每分鐘 20 次、每天 2000 次、每小時 7200 秒／每天 28800 秒音訊，
# 一次最多 25 MB，不到 10 秒的請求照 10 秒算；提示詞（prompt）最多 224 個 token。
import hashlib
import http.client
import io
import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
import wave

import numpy as np

from paths import FFMPEG, LOCAL_OK

BASE = (os.environ.get("YTLS_CLOUD_BASE") or "https://api.groq.com/openai/v1").rstrip("/")  # 測試時指到本機的假服務
MODEL = "whisper-large-v3-turbo"
MAX_UPLOAD = 24 * 1024 * 1024  # 免費方案上限 25 MB，留一點給表單欄位
NO_WINDOW = 0x08000000 if os.name == "nt" else 0
KEY_RE = re.compile(r"^[A-Za-z0-9_\-]{8,200}$")


TEST_KEY = os.environ.get("YTLS_CLOUD_TEST_KEY") or ""  # 只給測試用：配合 YTLS_CLOUD_BASE 指到假服務，沒帶金鑰的請求也當成有


def clean_key(k):
    """標頭裡的金鑰：去掉空白，格式不對（有怪字元）就當沒填。"""
    k = str(k or "").strip()
    return k if KEY_RE.match(k) else TEST_KEY


class CloudError(Exception):
    """kind：key（金鑰錯）、limit（額度用完；wait＝幾秒後可以再試）、net（連不上、逾時、伺服器出錯）、other"""

    def __init__(self, kind, msg, wait=0.0):
        super().__init__(msg)
        self.kind, self.wait = kind, float(wait or 0)


# 依金鑰（只記雜湊）記：被擋到什麼時候、原因。換了金鑰就重新試
_state = {"h": None, "until": 0.0, "kind": ""}
_lock = threading.Lock()
BLOCK_S = {"key": 600, "net": 30, "other": 30}


def _h(key):
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def note(kind, until=0.0):
    """給狀態列看的一句話（為什麼這次沒用雲端）。只裝雲端聽寫的安裝（沒有本機模型）：不會改用本機，等雲端恢復再繼續。"""
    left = max(1, round((until - time.time()) / 60)) if until else 0
    if not LOCAL_OK:
        if kind == "key":
            return "雲端金鑰無效：到擴充功能設定檢查金鑰（這個安裝沒有本機聽寫可以替代）"
        if kind == "limit":
            return "雲端免費額度暫時用完" + ("（約 %d 分鐘後恢復，到時自動繼續）" % left if left else "，恢復後自動繼續")
        if kind == "net":
            return "連不上雲端，等一下自動再試"
        return "雲端聽寫失敗，等一下自動再試"
    if kind == "key":
        return "雲端金鑰無效，改用本機聽寫（到擴充功能設定檢查金鑰）"
    if kind == "limit":
        return "雲端免費額度暫時用完，改用本機聽寫" + ("（約 %d 分鐘後恢復）" % left if left else "")
    if kind == "net":
        return "連不上雲端，改用本機聽寫"
    return "雲端聽寫失敗，改用本機聽寫"


def blocked(key):
    """這把金鑰現在先不要用 → 回傳原因；可以用 → 空字串。"""
    with _lock:
        if _state["h"] == _h(key) and time.time() < _state["until"]:
            return note(_state["kind"], _state["until"])
    return ""


def fail(key, e):
    """記下這次失敗（之後一段時間直接用本機，不要每段都去撞），回傳原因。
    同時有兩個請求失敗（回放＋直播）時，不要拿短的（連不上 30 秒）蓋掉長的（今天額度用完）。"""
    wait = min(24 * 3600, e.wait or 60) if e.kind == "limit" else BLOCK_S.get(e.kind, 30)
    until = time.time() + wait
    print("雲端聽寫失敗（%s）：%s" % (e.kind, e), flush=True)
    with _lock:
        if _state["h"] == _h(key) and _state["until"] > until:
            return note(_state["kind"], _state["until"])
        _state.update(h=_h(key), until=until, kind=e.kind)
    return note(e.kind, until)


def unblock(key):
    """金鑰測過可以用：之前因為金鑰錯、連不上而暫停的，馬上恢復（額度用完的照等）。"""
    with _lock:
        if _state["h"] == _h(key) and _state["kind"] != "limit":
            _state.update(h=None, until=0.0, kind="")


def encode(audio):
    """16kHz 單聲道 float32 → (檔案內容, 檔名, MIME)。FLAC（無損，約 WAV 的一半）；太大改 Opus；沒有 ffmpeg 用 WAV。"""
    pcm = (np.clip(np.asarray(audio, np.float32), -1.0, 1.0) * 32767).astype("<i2").tobytes()

    def ff(args):
        try:
            r = subprocess.run([str(FFMPEG), "-v", "error", "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "-"] + args + ["-"],
                               input=pcm, capture_output=True, creationflags=NO_WINDOW, timeout=180)
            return r.stdout if r.returncode == 0 and r.stdout and len(r.stdout) <= MAX_UPLOAD else None
        except (OSError, subprocess.SubprocessError):
            return None

    data = ff(["-c:a", "flac", "-f", "flac"])
    if data:
        return data, "audio.flac", "audio/flac"
    data = ff(["-c:a", "libopus", "-b:a", "48k", "-f", "ogg"])
    if data:
        return data, "audio.ogg", "audio/ogg"
    if len(pcm) + 44 <= MAX_UPLOAD:
        b = io.BytesIO()
        with wave.open(b, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(pcm)
        return b.getvalue(), "audio.wav", "audio/wav"
    raise CloudError("other", "音訊太長，雲端一次收不下")


def _multipart(fields, name, mime, data):
    b = uuid.uuid4().hex
    out = []
    for k, v in fields:
        out.append(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (b, k, v)).encode("utf-8"))
    out.append(('--%s\r\nContent-Disposition: form-data; name="file"; filename="%s"\r\nContent-Type: %s\r\n\r\n' % (b, name, mime)).encode("utf-8"))
    out.append(data)
    out.append(("\r\n--%s--\r\n" % b).encode("utf-8"))
    return b"".join(out), "multipart/form-data; boundary=" + b


def _retry_after(headers):
    try:
        return max(1.0, float(headers.get("retry-after") or 60))
    except (TypeError, ValueError):
        return 60.0


def _request(key, path, body=None, ctype=None, timeout=30):
    headers = {"Authorization": "Bearer " + key, "User-Agent": "ytls-listen/1"}
    if ctype:
        headers["Content-Type"] = ctype
    req = urllib.request.Request(BASE + path, data=body, headers=headers, method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise CloudError("key", "金鑰無效或被停用（%d）" % e.code)
        if e.code == 429:
            raise CloudError("limit", "額度用完（429）", _retry_after(e.headers))
        if e.code >= 500:
            raise CloudError("net", "雲端服務回應 %d" % e.code)
        # 其他 4xx（模型改名、參數不對、音檔太大）：不是連不上，把對方的說明記下來
        try:
            msg = str(json.loads(e.read().decode("utf-8", "replace"))["error"]["message"])[:160]
        except Exception:
            msg = ""
        raise CloudError("other", "雲端回應 %d：%s" % (e.code, msg))
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as e:
        # 連不上、逾時（TimeoutError 是 OSError）、回到一半斷線（IncompleteRead 是 HTTPException）、回傳不是 JSON
        raise CloudError("net", "連不上雲端服務：%s" % (getattr(e, "reason", None) or e or type(e).__name__))


def transcribe(audio, key, song=False, prompt=None, timeout=None):
    """回傳 [{start, end, text, avg_logprob, no_speech_prob, compression_ratio, words}]（秒，從這段開頭算）。
    timeout：直播用短的（失敗後還要改用本機、可能要冷啟動模型，整段要在擴充功能的 60 秒內回完）。"""
    sec = len(audio) / 16000
    data, name, mime = encode(audio)
    fields = [("model", MODEL), ("language", "ja"), ("response_format", "verbose_json"), ("temperature", "0"),
              ("timestamp_granularities[]", "segment")]
    if song:
        fields.append(("timestamp_granularities[]", "word"))  # 歌曲要逐字時間（卡拉 OK 填色、歌詞對時）
    if prompt:
        fields.append(("prompt", prompt[:150]))  # 上限 224 token：日文一個字約 1.2 個 token（模型的 tokenizer 實測）
    body, ctype = _multipart(fields, name, mime, data)
    j = _request(key, "/audio/transcriptions", body, ctype, timeout=timeout or (30 + sec * 0.3))
    if not isinstance(j, dict):
        raise CloudError("other", "雲端回傳的格式不對")
    segs = []
    for s in j.get("segments") or []:
        try:
            segs.append({"start": float(s.get("start", 0)), "end": float(s.get("end", 0)), "text": str(s.get("text") or ""),
                         "avg_logprob": float(s.get("avg_logprob", 0) or 0), "no_speech_prob": float(s.get("no_speech_prob", 0) or 0),
                         "compression_ratio": float(s.get("compression_ratio", 1) or 1), "words": []})
        except (TypeError, ValueError, AttributeError):
            continue
    # 逐字時間是整段一個清單（不像本機分在每句裡）：照開始時間分回所在的句子（落在句子之間的給最近的那句）
    if segs:
        for w in j.get("words") or []:
            try:
                w0, w1, txt = float(w["start"]), float(w["end"]), str(w["word"])
            except (KeyError, TypeError, ValueError):
                continue
            # 包含它的句子優先（剛好在交界的字算下一句的開頭），都不包含才找距離最近的
            best = min(segs, key=lambda s: (0, 0) if s["start"] <= w0 < s["end"] else (1, min(abs(w0 - s["start"]), abs(w0 - s["end"]))))
            best["words"].append([w0, w1, txt])
    return segs


def check(key):
    """面板「測試金鑰」：查一下模型清單（不花額度）。回傳 (能不能用, 說明)。"""
    try:
        _request(key, "/models", timeout=15)
    except CloudError as e:
        if e.kind == "limit":
            return True, "金鑰可以用，但現在額度用完了，稍後會自動恢復"
        return False, {"key": "金鑰無效或被停用：請重新複製一次（gsk_ 開頭）", "net": "連不上 Groq：檢查網路"}.get(e.kind, str(e))
    unblock(key)
    return True, "金鑰可以用"
