# YT 歌詞字幕：本機 AI 聽寫服務（faster-whisper large-v3-turbo；開發機沿用 GPT-SoVITS 的環境與模型，安裝版見 paths.py）
# 給直播回放、日語節目這類「沒有字幕」的影片產生日文字幕。只聽 localhost:8767，只接受擴充功能的請求。
#
# 回放：POST /vod/start {videoId, from, song}  → 用 yt-dlp 只下載音訊，從觀看位置開始往後聽寫，再補前面；
#       GET  /vod/status?videoId=&since=&song=  → 進度與新的句子。聽寫完刪掉音檔，只留字幕（cache/<videoId>[.song].json）
#       song=1（歌曲）：整首一次做、不用靜音過濾、附逐字時間 words:[[開始, 結束, 字]]
# 伴奏：POST /kara/start {videoId, song, artist, queries, len, mode, force} → 找官方伴奏比對，沒有就 AI 去人聲（見 kara.py）
#       GET  /kara/status?videoId=  /kara/audio?videoId=&key=&start=&len=（分段拿音檔；key ≠ 0 是變調版）
#       POST /kara/key {videoId, key} → 伴奏變調（rubberband，不變速），做好才回
# 直播：POST /live/chunk?t0=<毫秒>        → 內容是 16kHz 單聲道 16-bit PCM，回傳這段的句子（時間已加上 t0）
#
# 用法：<Python>\pythonw.exe listen-server.py（開發機：GPT-SoVITS 整合包的 runtime；安裝版：安裝資料夾\py-listen\Scripts）
#      （先開看門程序，服務當掉會自動重開；除錯時加 --child 直接跑服務本體、看錯誤訊息）
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("YTLS_LISTEN_PORT") or 8767)  # 測試時可以另開一個
ALLOWED = ("chrome-extension://", "extension://", "http://localhost:8765")
HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
TMP = HERE / "tmp"
sys.path.insert(0, str(HERE))  # 內嵌版 Python 不會自動把程式所在資料夾加進搜尋路徑
from paths import FFMPEG, NODE, YTDLP, busy, setup_dll_path  # noqa: E402
from paths import kill_tree, no_power_throttling, track  # noqa: E402
from paths import LOCAL_OK, SEP_OK  # noqa: E402  分級安裝：這次有沒有裝本機 AI 聽寫、AI 去人聲

no_power_throttling()  # 效率模式會把服務排到小核心低頻跑（見 paths.py）
from paths import WHISPER as MODEL_DIR  # noqa: E402
HOTWORDS = [HERE / "hotwords.txt"]
IDLE_UNLOAD_S = 15 * 60  # 15 分鐘沒用就把模型從顯示卡記憶體卸掉（ComfyUI 也要用顯示卡）
NO_WINDOW = 0x08000000 if os.name == "nt" else 0


# ---------- 看門程序：服務當掉（例如顯示卡驅動出錯）就自動重開 ----------
# 排程工作啟動的是這個看門程序，它再開一個 --child 子程序跑真正的服務；子程序異常結束 5 秒後重開，
# 10 分鐘內當掉 5 次就放棄（避免無限重開）。子程序的輸出記在 tmp/server.log，方便查當機原因。
# 看門程序用 Windows「工作物件」綁住子程序：排程工作被停止（看門程序被結束）時，子程序跟著結束，不會殘留佔著 8767。
EXIT_PORT_BUSY = 3  # 子程序：8767 已經有人在用（服務本來就在跑）→ 不重開


def supervise():
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]

    class Basic(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

    class Extended(ctypes.Structure):
        _fields_ = [("Basic", Basic), ("Io", ctypes.c_ulonglong * 6), ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    job = k32.CreateJobObjectW(None, None)
    info = Extended()
    info.Basic.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    job_ok = bool(job) and bool(k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)))

    tmp = Path(__file__).resolve().parent / "tmp"
    tmp.mkdir(exist_ok=True)
    log = tmp / "server.log"
    note = lambda lf, msg: (lf.write(("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)).encode("utf-8")), lf.flush())
    fails = []
    while True:
        if log.exists() and log.stat().st_size > 1_000_000:
            log.replace(tmp / "server.old.log")
        with open(log, "ab") as lf:
            note(lf, "看門程序：啟動服務" + ("" if job_ok else "（工作物件建立失敗，停止時子程序可能殘留）"))
            p = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--child"], cwd=str(tmp.parent),
                                 stdout=lf, stderr=subprocess.STDOUT, creationflags=NO_WINDOW)
            if job_ok:
                k32.AssignProcessToJobObject(job, int(p._handle))
            code = p.wait() & 0xFFFFFFFF
            note(lf, "看門程序：服務結束，代碼 0x%08X" % code)
            if code in (0, EXIT_PORT_BUSY):
                return 0
            now = time.time()
            fails = [t for t in fails if now - t < 600] + [now]
            if len(fails) >= 5:
                note(lf, "看門程序：10 分鐘內當掉 5 次，不再自動重開")
                return 1
            note(lf, "看門程序：5 秒後重開")
        time.sleep(5)


if __name__ == "__main__" and os.name == "nt" and "--child" not in sys.argv and os.environ.get("YTLS_NO_SUPERVISOR") != "1":
    sys.exit(supervise())

for s in (sys.stdout, sys.stderr):
    if s:
        s.reconfigure(encoding="utf-8", errors="replace")
setup_dll_path()
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
os.environ["HF_HUB_OFFLINE"] = "1"
CACHE.mkdir(exist_ok=True)
TMP.mkdir(exist_ok=True)

import numpy as np  # noqa: E402
import cloud  # noqa: E402  雲端聽寫（Groq，使用者自己的金鑰；失敗就改用本機）
import kara  # noqa: E402  真‧卡拉 OK 伴奏（官方伴奏比對／AI 去人聲）
from gpuwatch import GpuWatch, GpuYield, unregister  # noqa: E402  其他程式要用顯示卡時先讓

# ---------- 模型（用到才載入、閒置就卸載）----------
# 模型放在獨立的小程序（whisper_worker.py）裡：在這個程序裡丟掉模型會讓整個服務中止（見那個檔案開頭的說明），
# 卸載＝結束小程序。MODEL_LOCK 讓同一時間只有一個工作在用它。
MODEL_LOCK = threading.Lock()
_model = {"p": None, "device": None, "last": 0.0}


def hotwords(hints=""):
    """提示詞：這部影片的標題／頻道名（擴充功能送來的 hints）放前面，再加 hotwords.txt 裡的常用名字。"""
    words = [w for w in str(hints or "").split() if 2 <= len(w) <= 20][:12]
    for f in HOTWORDS:
        if f.exists():
            words += [w.strip() for w in f.read_text(encoding="utf-8-sig").splitlines() if w.strip() and not w.strip().startswith("#")]
    return " ".join(dict.fromkeys(words)) or None


LOAD_TIMEOUT_S = 180  # 冷啟動實測 5～29 秒（沒顯示卡改用 CPU 也在 1 分鐘內）


@contextmanager
def watchdog(p, seconds):
    """等小程序回話時的保險：超過 seconds 秒還沒等到就結束它（等的那一行會讀到結尾，當成「意外結束」處理）。"""
    t = threading.Timer(seconds, lambda: p.poll() is None and (print("聽寫程序 %d 秒沒有回應，結束它" % seconds, flush=True), p.kill()))
    t.daemon = True
    t.start()
    try:
        yield
    finally:
        t.cancel()


def model_loaded():
    p = _model["p"]
    return p is not None and p.poll() is None


def get_model():
    """確定聽寫小程序開著（要在 MODEL_LOCK 裡呼叫）。顯示卡讓給別的程式中 → 丟 GpuYield。"""
    GW.check()
    if not model_loaded():
        _model["p"] = None
        t0 = time.time()
        p = subprocess.Popen([sys.executable, str(Path(__file__).resolve().parent / "whisper_worker.py"), str(MODEL_DIR)],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, creationflags=NO_WINDOW)
        with watchdog(p, LOAD_TIMEOUT_S):  # 卡在載入（顯示卡驅動出錯之類）就結束它，不要一直佔著 MODEL_LOCK
            line = p.stdout.readline()
        try:
            info = json.loads(line)
        except ValueError:
            info = {}
        if not info.get("ready"):
            p.kill()
            p.wait(5)
            raise RuntimeError("聽寫模型載入失敗（詳見 tmp/server.log）")
        _model["p"], _model["device"] = p, info.get("device")
        print("聽寫模型載入 %.1f 秒（%s；程式庫 %s 秒、模型 %s 秒）" % (time.time() - t0, _model["device"], info.get("import"), info.get("sec")), flush=True)
    _model["last"] = time.time()
    return _model["p"]


def run_model(audio, opts, retry=True):
    """送一段音訊給聽寫小程序，回傳原始句子（dict）。小程序意外結束（例如顯示卡驅動出錯）就重開再試一次。"""
    p = get_model()
    a = np.ascontiguousarray(audio, dtype=np.float32)
    try:
        # 直播一段 6 秒、回放一段最多約 3 分鐘、歌曲整首最多 15 分鐘。顯示卡上 3 分鐘約 3～6 秒做完，CPU 慢很多（可能比即時還慢）；
        # 超過很多就是卡住了（顯示卡驅動出錯之類）：結束它，下面會重開再試。顯示卡：3 分鐘的段落 2.5 分鐘、6 秒的段落 1 分鐘
        sec = a.size / 16000
        with watchdog(p, 60 + 0.5 * sec if _model["device"] == "cuda" else 120 + 4 * sec):
            p.stdin.write(json.dumps({"n": int(a.size), "opts": opts}).encode("utf-8") + b"\n")
            p.stdin.write(a.tobytes())
            p.stdin.flush()
            line = p.stdout.readline()
    except OSError:
        line = b""
    if not line:
        stop_model()
        if retry:
            print("聽寫程序意外結束，重開再試一次", flush=True)
            return run_model(a, opts, False)
        raise RuntimeError("聽寫程序意外結束")
    r = json.loads(line)
    if not r.get("ok"):
        raise RuntimeError(r.get("error") or "聽寫失敗")
    _model["last"] = time.time()
    return r["segments"]


def stop_model():
    """結束聽寫小程序（＝把模型從顯示卡卸掉）。要在 MODEL_LOCK 裡呼叫。"""
    p, _model["p"], _model["device"] = _model["p"], None, None
    if p is None:
        return False
    try:
        p.stdin.close()  # 小程序讀到結尾會自己結束
        p.wait(3)
    except Exception:
        pass
    try:
        if p.poll() is None:
            p.kill()
            p.wait(5)
    except Exception:  # 結束不了也不要讓呼叫的執行緒（閒置卸載、讓出顯示卡）跟著死掉
        pass
    unregister(p.pid)
    return True


def preload_model():
    """回放一開始、下載音訊的同時先把模型載好（2～12 秒）。讓出顯示卡中就不載。"""
    if GW.active():
        return
    try:
        with MODEL_LOCK:
            get_model()
    except Exception:
        pass


def unload_all(name):
    """開始讓出顯示卡：馬上卸掉聽寫和去人聲模型（正在做的那一段做完才卸，最多幾秒）。"""
    def whisper():
        with MODEL_LOCK:  # 正在聽寫的那一段（整首歌一次做時最多十幾秒）做完才拿得到
            if stop_model():
                print("顯示卡讓給 %s：已卸載聽寫模型" % name, flush=True)
    # 分開卸：去人聲模型不用等聽寫那一段做完
    threading.Thread(target=whisper, daemon=True).start()
    threading.Thread(target=kara.unload_sep, args=("顯示卡讓給 %s" % name,), daemon=True).start()


GW = GpuWatch(on_yield=unload_all, log=lambda m: print(m, flush=True))
kara.GPU = GW


def unloader():
    while True:
        time.sleep(60)
        try:
            with MODEL_LOCK:
                if model_loaded() and time.time() - _model["last"] > IDLE_UNLOAD_S:
                    stop_model()
                    print("閒置太久，已卸載模型", flush=True)
        except Exception as e:  # 這條執行緒死掉的話就再也不會閒置卸載
            print("閒置卸載出錯：", e, flush=True)


# Whisper 在純配樂段落的經典幻聽（訓練資料裡 YouTube 片尾的字幕）
HALLU = re.compile(r"ご(視聴|清聴)ありがとうございま|チャンネル登録|高評価|最後までご覧|字幕(は|by|：|:)|提供[:：]")


JA_CHAR = re.compile(r"[぀-ヿ一-鿿]")


def is_hallu(s, text):
    """不用 VAD 時，待機畫面、純配樂會被聽成固定句子或亂碼英文。實測的樣子：
    「ご視聴ありがとうございました」整整 30 秒一句、平均信心 avg_logprob ≈ -2.7 的英文、同一句一直重複。"""
    if HALLU.search(text):
        return True
    if s.end - s.start >= 25 and len(text) <= 20:  # 一個 30 秒視窗只聽出一小句：多半是配樂
        return True
    # 信心是整個 30 秒視窗一起算的：比賽尖叫混著說話的視窗約 -1.7～-1.9 還有不少真的句子，亂碼視窗是 -2.0 以下
    if s.avg_logprob < -2.0 or (s.no_speech_prob > 0.6 and s.avg_logprob < -0.8):
        return True
    if s.avg_logprob < -1.0 and not JA_CHAR.search(text):  # 信心不高又沒有半個假名漢字：「oomg」「Klein」之類
        return True
    return s.compression_ratio > 2.6  # 重複到不正常（Whisper 自己的門檻是 2.4，這裡放寬一點，「えええ」之類照留）


def run_cloud(audio, key, song, hints, max_wait, cancelled=None, timeout=None):
    """用雲端聽寫；回傳 (原始句子 或 None, 沒用雲端的原因)。None＝這次改用本機。
    額度暫時用完（每分鐘次數）而且 max_wait 秒內會恢復：等一下再送（回放在背景做，等得起；直播 max_wait=0 不等）。
    等的時候工作被取消就丟「已取消」（跟回放工作其他地方一樣）。"""
    for attempt in range(3):
        why = cloud.blocked(key)  # 等的期間別的請求可能已經知道今天額度用完了
        if why:
            return None, why
        try:
            with busy():
                return cloud.transcribe(audio, key, song, None if song else hotwords(hints), timeout), ""
        except cloud.CloudError as e:
            if e.kind == "limit" and e.wait <= max_wait and attempt < 2:
                end = time.time() + e.wait + 0.5
                while time.time() < end:
                    if cancelled and cancelled():
                        raise RuntimeError("已取消")
                    time.sleep(0.5)
                continue
            return None, cloud.fail(key, e)
        except Exception as e:  # 沒想到的錯誤也不要讓整個回放工作失敗：這次改用本機
            return None, cloud.fail(key, cloud.CloudError("other", "%s：%s" % (type(e).__name__, e)))
    return None, cloud.note("limit")


NO_LOCAL_MSG = "這個安裝只有雲端 AI 聽寫：點 Edge 工具列的擴充功能圖示，「AI 聽寫」選「雲端」並填 Groq 金鑰"


class NoLocal(RuntimeError):
    """只裝了雲端聽寫（沒有本機 Whisper），而這次雲端不能用。cloud_note：雲端為什麼不能用（沒開雲端就是空的）。"""

    def __init__(self, msg, cloud_note=""):
        super().__init__(msg)
        self.cloud_note = cloud_note


def transcribe_array(audio, offset_s, song=False, hints="", vad=True, cloud_key="", max_wait=0, cancelled=None, cloud_timeout=None):
    """audio：16kHz 單聲道 float32；回傳 ([{start, end, text}]（毫秒，已加上 offset）, {"engine", "cloudNote"})。
    song=True（歌曲）：關掉靜音過濾（VAD 會把歌聲當雜音整段丟掉，實測只剩 3% 歌詞；關掉後 84～89%），
    附逐字時間（給歌詞對時用），並去掉配樂段落的幻聽。
    vad=False（回放聽寫）：VAD 也會把「背景音樂很大聲時的說話」整段丟掉（遊戲比賽回放實測 170 秒只剩 1 句，
    關掉後 84 句），所以回放不用 VAD，改成事後去掉幻聽。直播的短片段還是用 VAD（安靜時比較不會亂聽）。
    cloud_key：有就先用雲端（不用顯示卡、不用讓）；金鑰錯、額度用完、連不上就改用本機，原因放在 cloudNote。"""
    info = {"engine": "local"}
    if len(audio) < 1600:  # 不到 0.1 秒（影片實際比標示的短，最後一段讀不到聲音）：沒東西可聽，也不要拿去撞雲端（會回 400）
        why = cloud.blocked(cloud_key) if cloud_key else ""  # 原因照樣帶著：最後一小段不要把「為什麼沒用雲端」洗掉
        return [], dict({"engine": "local" if why or not cloud_key else "cloud"}, **({"cloudNote": why} if why else {}))
    raw = None
    if cloud_key:
        raw, why = run_cloud(audio, cloud_key, song, hints, max_wait, cancelled, cloud_timeout)
        if raw is not None:
            info["engine"] = "cloud"
            vad = False  # 雲端沒有靜音過濾：跟回放一樣事後去掉幻聽
        else:
            info["cloudNote"] = why
    if raw is None and not LOCAL_OK:
        raise NoLocal(info.get("cloudNote") or NO_LOCAL_MSG, info.get("cloudNote", ""))
    if raw is None:
        try:
            with busy(), MODEL_LOCK:
                if song:
                    opts = dict(language="ja", beam_size=5, vad_filter=False, condition_on_previous_text=False, word_timestamps=True)
                else:
                    opts = dict(language="ja", beam_size=5, vad_filter=vad,
                                vad_parameters={"min_silence_duration_ms": 500} if vad else None,
                                condition_on_previous_text=False,  # 長時間閒聊時延續上文容易無限重複
                                hotwords=hotwords(hints))
                raw = run_model(audio, opts)
                _model["last"] = time.time()
        except GpuYield as e:
            # 雲端剛失敗、改用本機時又遇到顯示卡讓出：「為什麼沒用雲端」要跟著暫停狀態一起顯示（以前留著上一段的舊原因或空白）
            e.cloud_note = info.get("cloudNote", "")
            raise
    from types import SimpleNamespace
    segs = [SimpleNamespace(**d) for d in raw]
    out = []
    ms = lambda t: int((offset_s + t) * 1000)
    for s in segs:
        text = s.text.strip()
        if not text:
            continue
        if song and (HALLU.search(text) or (s.no_speech_prob > 0.8 and s.avg_logprob < -1.0)):
            continue
        if not song and not vad and is_hallu(s, text):
            continue
        seg = {"start": ms(s.start), "end": ms(s.end), "text": text}
        if song and s.words:
            seg["words"] = [[ms(w0), ms(w1), w.strip()] for w0, w1, w in s.words if w.strip()]
        out.append(seg)
    return out, info


def read_window(path, start_s, dur_s):
    """用 ffmpeg 讀出音檔的一段，轉成 16kHz 單聲道 float32。"""
    cmd = [str(FFMPEG), "-v", "error", "-ss", str(start_s), "-t", str(dur_s), "-i", str(path), "-ac", "1", "-ar", "16000", "-f", "s16le", "-"]
    raw = subprocess.run(cmd, capture_output=True, creationflags=NO_WINDOW).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0


def probe_duration(path):
    cmd = [str(FFMPEG), "-i", str(path)]
    err = subprocess.run(cmd, capture_output=True, creationflags=NO_WINDOW).stderr.decode("utf-8", "replace")
    for line in err.splitlines():
        if "Duration:" in line:
            h, m, s = line.split("Duration:")[1].split(",")[0].strip().split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
    return 0.0


# ---------- 回放：下載音訊→分段聽寫 ----------
VOD_CACHE_V = 2  # 2：回放聽寫不用 VAD（v1.0.1）。舊快取打開時會自動重做
JOBS = {}
JOBS_LOCK = threading.Lock()


def job_key(vid, song):
    return vid + (".song" if song else "")


class Job:
    def __init__(self, vid, start_from, song=False, hints="", cloud_key=""):
        self.vid, self.start_from, self.song = vid, max(0.0, float(start_from or 0)), bool(song)
        self.hints = str(hints or "")[:300]
        self.cloud_key = cloud_key  # 有金鑰就用雲端聽寫（擴充功能每次 /vod/start 都會帶最新的設定）
        self.engine, self.cloud_note = None, ""  # 最近一段用的是 cloud／local，沒用雲端的原因
        self.key = job_key(vid, self.song)
        self.state, self.error = "downloading", ""
        self.duration, self.done_s = 0.0, 0.0
        self.segments = []
        self.cancel = False
        self.focus = None  # 使用者跳到的位置（秒）：還沒做的那一段先做（見 /vod/focus）
        self.paused = None  # 顯示卡讓給別的程式中（對方的名字）：工作暫停，對方用完自動繼續
        self.dl = None
        self.polled = time.time()  # 擴充功能最後一次來問進度的時間：很久沒人問的工作才會被新工作取消

    def to_status(self, since):
        dl = self.dl
        return {"ok": True, "state": self.state, "error": self.error, "duration": self.duration,
                "progress": round(self.done_s / self.duration, 3) if self.duration else 0,
                "downloaded": round(min(1.0, dl.seconds() / self.duration), 3) if dl and self.duration and self.state == "transcribing" else None,
                "paused": self.paused, "engine": self.engine, "cloudNote": self.cloud_note,
                "total": len(self.segments), "segments": self.segments[since:]}

    def run(self):
        with busy():  # 有工作時用標準優先權（見 paths.busy）
            self._run()

    def _run(self):
        work = TMP / ("%s-%d" % (self.key, int(time.time() * 1000)))
        dl = None
        try:
            work.mkdir(parents=True, exist_ok=True)
            cmd = [str(YTDLP), "--no-playlist", "--match-filter", "!is_live", "-f", "bestaudio[ext=webm]/bestaudio",
                   "--js-runtimes", "node:" + str(NODE), "--ffmpeg-location", str(FFMPEG.parent),
                   # 開始下載前先印出檔案大小和長度（約 4 秒），拿來估計「已經下載到第幾秒」：邊下載邊聽寫。
                   # （只抓一段的 --download-sections 會被 YouTube 限速到 1.7 倍速，比整段下載還慢，所以不用）
                   "-O", "before_dl:%(filesize,filesize_approx)s %(duration)s", "--no-simulate",
                   # 下載中會用 ffmpeg 讀 .part（邊下載邊聽寫），ffmpeg 開著時 Windows 不准改檔名（實測 WinError 32），
                   # 下載完剛好撞上的話，預設只重試 3 次 × 0.01 秒就放棄（整個工作變成下載失敗）：改成最多等 10 秒
                   "--file-access-retries", "40", "--retry-sleep", "file_access:0.25",
                   "--no-progress", "-o", str(work / "audio.%(ext)s"), "https://www.youtube.com/watch?v=" + self.vid]
            dl = self.dl = Download(cmd, work, lambda: self.cancel)
            if LOCAL_OK and not (self.cloud_key and not cloud.blocked(self.cloud_key)):  # 用雲端（或沒裝本機模型）的話不用載
                threading.Thread(target=preload_model, daemon=True).start()  # 下載的同時先把模型載好
            while not dl.done() and not dl.info:
                if self.cancel:
                    raise RuntimeError("已取消")
                time.sleep(0.2)
            if not dl.info:  # 不知道檔案大小（少見）：整段下載完再做
                dl.join(lambda: self.cancel)
            if dl.done() and not dl.file(final=True):
                raise RuntimeError("下載失敗：" + kara.friendly_dl_error(dl.err()))
            self.duration = dl.info[1] if dl.info else probe_duration(dl.file(final=True))
            self.state = "transcribing"
            # 從觀看位置開始：先 1 分鐘（快點有字幕），之後每段 3 分鐘；後面做完再補前面
            win = []
            if self.song and self.duration <= 15 * 60:
                win = [(0.0, self.duration)]  # 一首歌整首一次做完（4 分鐘的歌約 3～6 秒），不會在切點斷句
            else:
                a, step = min(self.start_from, max(0.0, self.duration - 1)), 60.0
                self.start_from = a
                while a < self.duration:
                    win.append((a, min(self.duration, a + step))); a += step; step = 180.0
                a = 0.0
                while a < self.start_from:
                    b = min(self.start_from, a + 180.0); win.append((a, b)); a = b
            OVER = 3.0  # 每段多讀 3 秒，句子才不會在邊界被切斷
            # 照「接下來要看的位置」挑下一段：平常就是照順序；使用者跳到還沒做的地方（/vod/focus）就先做那裡，
            # 接著從那裡往後（以前一律照開始時排好的順序，往後跳一小時要等前面全部做完）
            remaining, cursor = list(win), self.start_from
            while remaining:
                if self.cancel:
                    raise RuntimeError("已取消")
                if dl.done() and not dl.file(final=True):
                    raise RuntimeError("下載失敗：" + kara.friendly_dl_error(dl.err()))
                f, self.focus = self.focus, None
                if f is not None:
                    hit = [w for w in remaining if w[0] <= f < w[1]]
                    cursor = hit[0][0] if hit else f
                after = [w for w in remaining if w[0] >= cursor]
                target = min(after) if after else min(remaining)
                main = True
                audio = self._ready(dl, target, OVER)
                if audio is None:
                    # 要做的那段還沒下載到：還要等很久的話，先做已經下載好的段落（通常是觀看位置前面要補的）
                    if dl.eta(min(self.duration, target[1] + OVER)) > 8:
                        for w in sorted(remaining):
                            if w != target and (audio := self._ready(dl, w, OVER)) is not None:
                                target, main = w, False
                                break
                    if audio is None:
                        time.sleep(0.5)
                        continue
                a, b = target
                try:
                    segs, info = transcribe_array(audio, a, self.song, self.hints, vad=False, cloud_key=self.cloud_key, max_wait=30,
                                                  cancelled=lambda: self.cancel)
                    self.engine, self.cloud_note = info["engine"], info.get("cloudNote", "")
                except GpuYield as e:
                    self.engine, self.cloud_note = "local", getattr(e, "cloud_note", "")
                    self.paused = str(e)
                    print("回放聽寫暫停（顯示卡讓給 %s）" % e, self.vid, flush=True)
                    # 有開雲端、只是剛好暫時不能用（連不上 30 秒、每分鐘次數用完）才輪到本機：雲端恢復就繼續，不用等遊戲關掉
                    GW.wait(lambda: self.cancel or bool(self.cloud_key and not cloud.blocked(self.cloud_key)))
                    self.paused = None
                    continue  # 這一段重做
                except NoLocal as e:
                    # 只裝了雲端聽寫：雲端暫時不能用（額度、連線、金鑰錯）就等它恢復——使用者在設定改好金鑰，下次查進度就帶新的來；
                    # 根本沒開雲端（或做到一半改回「本機」）就沒辦法了
                    if not self.cloud_key:
                        raise RuntimeError(NO_LOCAL_MSG)
                    self.engine, self.cloud_note = "cloud", e.cloud_note
                    print("回放聽寫等雲端恢復：", e.cloud_note, self.vid, flush=True)
                    while not self.cancel and self.cloud_key and cloud.blocked(self.cloud_key):
                        time.sleep(1)
                    continue  # 這一段重做
                remaining.remove(target)
                if main:
                    cursor = b
                keep = [s for s in segs if a * 1000 <= s["start"] < b * 1000]
                with JOBS_LOCK:
                    self.segments += keep
                self.done_s += b - a
            # 不在原地排序（擴充功能用「已拿到幾句」增量取，順序變了會漏）；存檔用排好的副本
            self.state = "done"
            ordered = sorted(self.segments, key=lambda s: s["start"])
            kara.write_json_atomic(CACHE / (self.key + ".json"), {"v": VOD_CACHE_V, "duration": self.duration, "segments": ordered})
        except Exception as e:
            self.state, self.error = "error", str(e)
            print("聽寫失敗", self.vid, e, flush=True)
        finally:
            if dl:
                dl.kill()
            self.paused = None
            self.dl = None  # 工作會一直留在 JOBS 裡（給擴充功能拿結果），下載的程序／管線不用留著
            shutil.rmtree(work, ignore_errors=True)  # 音檔用完就刪

    def _ready(self, dl, w, over):
        """w 這段（多讀 over 秒）的音訊已經下載到了就讀出來，還沒就回傳 None。"""
        a, b = w
        end = min(self.duration, b + over)
        finished = dl.done()
        if not finished and end > dl.seconds() * 0.97 - 3:  # 估計值留一點餘裕（Opus 是變動位元率）
            return None
        f = dl.file()
        if f is None:
            return None
        audio = read_window(f, a, end - a)
        if not finished and len(audio) < (end - a) * 16000 * 0.98:  # 其實還沒下載到（讀到檔尾）
            return None
        return audio


class Download:
    """yt-dlp 在背景下載音訊。info＝(檔案位元組數, 長度秒)，開始下載前就會有；file() 是目前的音檔（下載中是 .part）。"""

    def __init__(self, cmd, work, cancelled):
        self.work, self.cancelled = work, cancelled
        self.info, self._err, self.rc = None, b"", None
        self.t0 = time.time()
        self.p = track(subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=NO_WINDOW))
        threading.Thread(target=self._read_out, daemon=True).start()
        threading.Thread(target=self._read_err, daemon=True).start()
        threading.Thread(target=self._watch, daemon=True).start()

    def _read_out(self):
        with self.p.stdout:
            for line in self.p.stdout:
                try:
                    size, dur = line.decode("utf-8", "replace").split()[:2]
                    if int(float(size)) > 0 and float(dur) > 0:
                        self.info = (int(float(size)), float(dur))
                        self.t0 = time.time()
                except (ValueError, IndexError):
                    pass

    def _read_err(self):
        with self.p.stderr:
            self._err = self.p.stderr.read()

    def _watch(self):
        while self.p.poll() is None:
            if self.cancelled():
                self.kill()
            time.sleep(0.2)
        time.sleep(0.3)  # 讓讀錯誤訊息的執行緒讀完
        self.rc = self.p.returncode

    def kill(self):
        kill_tree(self.p)  # 只 kill 的話 yt-dlp 真正下載的子程序會繼續跑（見 paths.kill_tree）

    def done(self):
        return self.rc is not None

    def err(self):
        return self._err

    def join(self, cancelled):
        while not self.done():
            if cancelled():
                self.kill()
                raise RuntimeError("已取消")
            time.sleep(0.2)

    def file(self, final=False):
        try:
            names = [f for f in self.work.iterdir() if f.name.startswith("audio.")]
        except OSError:
            return None
        done = [f for f in names if not f.name.endswith((".part", ".ytdl"))]
        if done or final:
            return done[0] if done else None
        part = [f for f in names if f.name.endswith(".part")]
        return part[0] if part else None

    def seconds(self):
        """大概已經下載到影片的第幾秒。"""
        if self.done():
            return float("inf") if self.file(final=True) else 0.0
        f = self.file()
        if not f or not self.info:
            return 0.0
        try:
            return self.info[1] * min(1.0, f.stat().st_size / self.info[0])
        except OSError:
            return 0.0

    def eta(self, sec):
        """下載到第 sec 秒大概還要幾秒。"""
        have = self.seconds()
        if have >= sec:
            return 0.0
        rate = have / max(0.5, time.time() - self.t0)
        return (sec - have) / rate if rate > 0 else 999.0


def vod_focus(vid, at, song=False):
    """使用者跳到 at 秒：還在下載就改起點，聽寫中就把那一段排到最前面。"""
    with JOBS_LOCK:
        j = JOBS.get(job_key(vid, song))
        if not j or j.state not in ("downloading", "transcribing") or j.cancel:
            return {"ok": False}
        at = max(0.0, float(at or 0))
        if j.state == "downloading":
            j.start_from = at
        else:
            j.focus = at
        j.polled = time.time()
        return {"ok": True}


def vod_start(vid, start_from, song=False, hints="", cloud_key=""):
    key = job_key(vid, song)
    with JOBS_LOCK:
        cached = CACHE / (key + ".json")
        d = kara.read_json(cached) if cached.exists() else None  # 壞掉的快取當作沒有，重做
        if d and not song and d.get("v", 1) < VOD_CACHE_V:
            d = None  # 舊版（有 VAD）做的回放聽寫會漏掉配樂底下的說話：重做一次
        if d and "segments" in d:
            j = Job(vid, 0, song); j.state, j.duration, j.done_s, j.segments = "done", d.get("duration", 0), d.get("duration", 0), d["segments"]
            JOBS[key] = j
            return j
        j = JOBS.get(key)
        if j and j.state in ("downloading", "transcribing") and not j.cancel:
            j.polled = time.time()
            j.cloud_key = cloud_key  # 做到一半改了設定（開／關雲端、換金鑰）：接下來的段落照新的
            return j
        # 換影片就取消前一部，但只取消 20 秒沒人來問進度的（別的分頁還在看的回放、YouTube Music 的歌曲聽寫可以同時做，
        # 模型有鎖，會輪流用顯示卡）
        if not LOCAL_OK and not cloud_key:
            # 只裝了雲端聽寫、又沒開雲端：不用下載音訊了，直接告訴使用者怎麼開（之後填好金鑰再來就會重新開始）
            j = Job(vid, start_from, song, hints)
            j.state, j.error = "error", NO_LOCAL_MSG
            JOBS[key] = j
            return j
        for other in JOBS.values():
            if other.state in ("downloading", "transcribing") and time.time() - other.polled > 20:
                other.cancel = True
        j = Job(vid, start_from, song, hints, cloud_key)
        JOBS[key] = j
        threading.Thread(target=j.run, daemon=True).start()
        return j


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _origin(self):
        o = self.headers.get("Origin")
        # Host 也要是本機（擋 DNS rebinding：別的網站把自己的網域指到 127.0.0.1，就能用同源請求讀這個服務）
        host_ok = self.headers.get("Host", "").lower() in ("127.0.0.1:%d" % PORT, "localhost:%d" % PORT)
        return host_ok and ((not o) or o.startswith(ALLOWED)), o

    def _send(self, code, obj=None, origin=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8") if obj is not None else b""
        self.send_response(code)
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "content-type, x-ytls, x-ytls-cloud")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        if obj is not None:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        try:
            self.end_headers()
            self.wfile.write(body)
        except ConnectionError:  # 擴充功能等太久先斷線了（逾時、換影片）：不用回，也不要再回一次 500
            self.close_connection = True

    def do_OPTIONS(self):
        ok, o = self._origin()
        self._send(204 if ok else 403, None, o if ok else None)

    def do_GET(self):
        ok, o = self._origin()
        if not ok:
            return self._send(403)
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/ping":
            # local／sep：這次安裝有沒有本機 AI 聽寫、AI 去人聲（分級安裝的「雲端＋官方伴奏」那一級沒有）
            return self._send(200, {"ok": True, "engine": "whisper", "loaded": model_loaded(), "device": _model["device"],
                                    "ytdlp": bool(YTDLP and YTDLP.exists()), "gpuYield": GW.status(), "cloud": 1,
                                    "local": LOCAL_OK, "sep": SEP_OK}, o)
        if u.path == "/debug/stacks" and self.headers.get("X-YTLS") == "1":
            # 除錯：所有執行緒目前卡在哪一行（服務沒當掉但工作不動時用）
            import traceback
            names = {t.ident: t.name for t in threading.enumerate()}
            out = {}
            for ident, frame in sys._current_frames().items():
                out[names.get(ident, str(ident))] = traceback.format_stack(frame)[-6:]
            return self._send(200, {"ok": True, "lock_held": MODEL_LOCK.locked(), "model": model_loaded(), "stacks": out}, o)
        if u.path == "/vod/status" and self.headers.get("X-YTLS") == "1":
            vid = (q.get("videoId") or [""])[0]
            j = JOBS.get(job_key(vid, (q.get("song") or ["0"])[0] == "1"))
            if not j:
                return self._send(404, {"ok": False, "state": "none", "error": "沒有這個工作（服務重開過）"}, o)
            j.polled = time.time()
            if j.state in ("downloading", "transcribing"):
                j.cloud_key = cloud.clean_key(self.headers.get("X-YTLS-Cloud"))  # 做到一半在設定改了本機／雲端、換了金鑰：接下來的段落照新的
            try:
                since = max(0, int((q.get("since") or ["0"])[0]))
            except ValueError:
                since = 0
            return self._send(200, j.to_status(since), o)
        if u.path in ("/vod/status", "/kara/status", "/kara/audio") and not kara.valid_vid((q.get("videoId") or [""])[0]):
            return self._send(400, {"ok": False, "error": "影片 ID 不對"}, o)
        if u.path == "/kara/status" and self.headers.get("X-YTLS") == "1":
            return self._send(200, kara.kara_status((q.get("videoId") or [""])[0]), o)
        if u.path == "/kara/audio" and self.headers.get("X-YTLS") == "1":
            # 伴奏音檔分段給（擴充功能在背景頁一段一段拿，組成 Blob 播放）
            try:
                key = int((q.get("key") or ["0"])[0])
            except ValueError:
                key = 0
            f = kara.kara_file((q.get("videoId") or [""])[0], key)
            if not f:
                return self._send(404, {"ok": False, "error": "沒有伴奏"}, o)
            try:
                start = max(0, int((q.get("start") or ["0"])[0])); length = min(4 << 20, max(1, int((q.get("len") or [str(1 << 20)])[0])))
            except ValueError:
                return self._send(400, {"ok": False, "error": "參數不對"}, o)
            total = f.stat().st_size
            with open(f, "rb") as fh:
                fh.seek(start); body = fh.read(length)
            self.send_response(200)
            if o:
                self.send_header("Access-Control-Allow-Origin", o)
                self.send_header("Access-Control-Expose-Headers", "X-Total, X-Type")
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("X-Total", str(total))
            self.send_header("X-Type", "audio/mp4" if f.suffix in (".m4a", ".mp4") else "audio/webm")
            self.send_header("Content-Length", str(len(body)))
            try:
                self.end_headers()
                self.wfile.write(body)
            except ConnectionError:
                self.close_connection = True
            return
        self._send(404, None, o)

    def do_POST(self):
        ok, o = self._origin()
        if not ok:
            return self._send(403)
        if self.headers.get("X-YTLS") != "1":
            return self._send(404, None, o)
        u = urlparse(self.path)
        q = parse_qs(u.query)
        data = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        try:
            if u.path == "/vod/start":
                body = json.loads(data.decode("utf-8") or "{}")
                vid = str(body.get("videoId") or "")
                if not vid or not all(c.isalnum() or c in "-_" for c in vid) or len(vid) > 20:
                    return self._send(400, {"ok": False, "error": "影片 ID 不對"}, o)
                return self._send(200, vod_start(vid, body.get("from", 0), bool(body.get("song")), body.get("hints", ""),
                                                 cloud.clean_key(self.headers.get("X-YTLS-Cloud"))).to_status(0), o)
            if u.path == "/vod/focus":
                body = json.loads(data.decode("utf-8") or "{}")
                return self._send(200, vod_focus(str(body.get("videoId") or ""), body.get("at", 0), bool(body.get("song"))), o)
            if u.path == "/kara/start":
                body = json.loads(data.decode("utf-8") or "{}")
                vid = str(body.get("videoId") or "")
                if not vid or not all(c.isalnum() or c in "-_" for c in vid) or len(vid) > 20:
                    return self._send(400, {"ok": False, "error": "影片 ID 不對"}, o)
                j = kara.kara_start(vid, body.get("queries") or [], body.get("len") or 0, str(body.get("mode") or "auto"),
                                    bool(body.get("force")), str(body.get("song") or ""), str(body.get("artist") or ""))
                return self._send(200, j.status(), o)
            if u.path == "/kara/prep":
                # 音樂影片一打開就先下載原影片音訊、載入去人聲模型（不等歌詞來源選好），見 kara.kara_prep
                body = json.loads(data.decode("utf-8") or "{}")
                return self._send(200, kara.kara_prep(str(body.get("videoId") or "")), o)
            if u.path == "/kara/key":
                # 升降 Key：伴奏變調（第一次約 10 秒，做好才回）
                body = json.loads(data.decode("utf-8") or "{}")
                vid = str(body.get("videoId") or "")
                if not vid or not all(c.isalnum() or c in "-_" for c in vid) or len(vid) > 20:
                    return self._send(400, {"ok": False, "error": "影片 ID 不對"}, o)
                try:
                    return self._send(200, kara.kara_key(vid, int(body.get("key") or 0)), o)
                except Exception as e:
                    return self._send(200, {"ok": False, "error": str(e)}, o)
            if u.path == "/gpu/override":
                # 使用者在面板按「這次照用」：這一輪不讓（對方結束後自動清掉）
                body = json.loads(data.decode("utf-8") or "{}")
                return self._send(200, dict(GW.set_override(bool(body.get("on", True))), ok=True), o)
            if u.path == "/live/chunk":
                t0 = float((q.get("t0") or ["0"])[0]) / 1000.0
                audio = np.frombuffer(data, np.int16).astype(np.float32) / 32768.0
                hints = (q.get("hints") or [""])[0][:300]
                try:
                    # 雲端逾時用短的：失敗後還要改用本機（模型可能要冷啟動 5～30 秒），整段要在擴充功能等的 60 秒內回完
                    segs, info = transcribe_array(audio, t0, False, hints, cloud_key=cloud.clean_key(self.headers.get("X-YTLS-Cloud")),
                                                  cloud_timeout=15)
                    return self._send(200, dict(info, ok=True, segments=segs), o)
                except GpuYield as e:  # 直播沒辦法事後補：這一段就不聽了，擴充功能顯示「讓給誰」
                    return self._send(200, {"ok": False, "yield": str(e), "detail": GW.detail, "segments": [],
                                            "cloudNote": getattr(e, "cloud_note", "")}, o)
                except NoLocal as e:  # 只裝了雲端聽寫、這一段雲端不能用：這段就沒有字幕，原因給擴充功能顯示
                    return self._send(200, {"ok": False, "noLocal": True, "error": str(e), "cloudNote": e.cloud_note, "segments": []}, o)
            if u.path == "/cloud/test":
                # 設定頁「測試金鑰」：問一下 Groq 這把金鑰能不能用（查模型清單，不花額度）
                key = cloud.clean_key(self.headers.get("X-YTLS-Cloud"))
                if not key:
                    return self._send(200, {"ok": True, "valid": False, "message": "金鑰格式不對：應該是 gsk_ 開頭的一長串英數字"}, o)
                valid, msg = cloud.check(key)
                return self._send(200, {"ok": True, "valid": valid, "message": msg}, o)
            self._send(404, None, o)
        except Exception as e:
            self._send(500, {"ok": False, "error": str(e)}, o)


def clean_leftovers():
    """上次服務當掉、被強制結束時，做到一半的工作來不及刪暫存音檔（一部影片的音訊可能上百 MB）。
    確定拿到連接埠（沒有別的服務在跑）之後才清：tmp 底下的資料夾全刪（server.log 留著），伴奏快取裡用不到的音檔也刪。"""
    freed = 0
    for d in TMP.iterdir():
        if d.is_dir():
            freed += sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
            shutil.rmtree(d, ignore_errors=True)
    kc = CACHE / "kara"
    keep = set()
    for m in kc.glob("*.json"):
        try:
            keep.add(json.loads(m.read_text(encoding="utf-8"))["file"])
        except Exception:
            continue
    for f in kc.glob("*.*"):
        vid = f.name.split(".")[0]
        # 伴奏快取裡只留：紀錄檔、紀錄指到的音檔、它的變調版（<影片ID>.k+2.webm）；沒做完的、換來源後沒刪到的舊音檔都清掉
        ok = f.suffix == ".json" or f.name in keep or (re.fullmatch(r"[\w-]+\.k[+-]\d+\.webm", f.name) and any(k.startswith(vid + ".") for k in keep))
        if not ok:
            freed += f.stat().st_size
            f.unlink(missing_ok=True)
    if freed:
        print("清掉上次留下的暫存檔 %.1f MB" % (freed / 1048576), flush=True)


if __name__ == "__main__":
    threading.Thread(target=unloader, daemon=True).start()
    GW.start()
    print("YT 歌詞字幕 AI 聽寫服務已啟動：http://localhost:%d" % PORT, flush=True)
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as e:  # 8767 已被佔用：服務本來就在跑
        print("連接埠 %d 已被使用：" % PORT, e, flush=True)
        sys.exit(EXIT_PORT_BUSY)
    clean_leftovers()
    httpd.serve_forever()
