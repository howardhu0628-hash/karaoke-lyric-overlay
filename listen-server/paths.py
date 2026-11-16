# YT 歌詞字幕：本機服務用到的外部工具和模型放在哪裡。
# 安裝程式（installer/install.ps1）會在擴充功能資料夾寫一個 ytls-config.json；沒有這個檔案時用開發機（桌機）的路徑。
import json
import os
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
CONFIG_FILE = APP / "ytls-config.json"

try:
    CFG = json.loads(CONFIG_FILE.read_text(encoding="utf-8-sig")) if CONFIG_FILE.exists() else {}
except Exception as e:  # 設定檔壞掉：照預設跑，並在記錄裡留下原因
    print("ytls-config.json 讀取失敗，改用預設路徑：", e, flush=True)
    CFG = {}

# 開發機（沒有 ytls-config.json）：yt-dlp／node／ffmpeg 先找 PATH，找不到就到環境變數 YTLS_TOOLS 指的資料夾（預設 C:\tools）；
# Whisper 和去人聲模型沿用 GPT-SoVITS 整合包裡的（環境變數 YTLS_SOVITS，預設 <YTLS_TOOLS>\GPT-SoVITS）
TOOLS = Path(os.environ.get("YTLS_TOOLS") or r"C:\tools")
SOVITS = Path(os.environ.get("YTLS_SOVITS") or TOOLS / "GPT-SoVITS")


INSTALLED = bool(CFG)  # 安裝版（有 ytls-config.json）


def _p(key, default):
    """安裝版：設定檔裡沒寫的＝這一級沒裝（分級安裝，例如只裝雲端聽寫就沒有 Whisper 模型）→ None。開發機：用預設路徑。"""
    v = CFG.get(key)
    if v:
        return Path(v)
    return None if INSTALLED else Path(default)


def _has(mod):
    try:
        import importlib.util
        return importlib.util.find_spec(mod) is not None
    except Exception:
        return False


YTDLP = _p("ytdlp", shutil.which("yt-dlp") or TOOLS / "yt-dlp" / "yt-dlp.exe")
NODE = _p("node", shutil.which("node") or TOOLS / "nodejs" / "node.exe")
FFMPEG = _p("ffmpeg", shutil.which("ffmpeg") or TOOLS / "ffmpeg" / "bin" / "ffmpeg.exe")
WHISPER = _p("whisper", SOVITS / "tools" / "asr" / "models" / "faster-whisper-large-v3-turbo")
ROFORMER = _p("roformer", SOVITS / "tools" / "uvr5" / "uvr5_weights" / "model_bs_roformer_ep_317_sdr_12.9755.ckpt")
UVR_CODE = HERE / "uvr"  # 去人聲模型的程式（從 GPT-SoVITS 複製，MIT 授權）
# 這次安裝有沒有本機 AI 聽寫、AI 去人聲（安裝時選「雲端聽寫＋官方伴奏」那一級就沒有：不裝 PyTorch、Whisper、去人聲模型）
LOCAL_OK = bool(WHISPER and (WHISPER / "model.bin").exists() and _has("faster_whisper"))
SEP_OK = bool(ROFORMER and ROFORMER.exists() and _has("torch"))


def setup_dll_path():
    """CTranslate2（faster-whisper）在 Windows 上要找得到 CUDA 的 DLL（cublas、cudnn）：PyTorch 自帶一份，
    把它的 lib 資料夾和 ffmpeg 加進搜尋路徑（librosa 讀不了的格式也會找 PATH 上的 ffmpeg）。"""
    prefix = Path(sys.prefix)
    dirs = [prefix, prefix / "Lib" / "site-packages" / "torch" / "lib"] + ([FFMPEG.parent] if FFMPEG else [])
    os.environ["PATH"] = os.pathsep.join([str(d) for d in dirs] + [os.environ.get("PATH", "")])
    for d in dirs:
        if d.is_dir() and hasattr(os, "add_dll_directory"):
            try:
                os.add_dll_directory(str(d))
            except OSError:
                pass


# ---------- 有工作時暫時提高優先權 ----------
# 服務平常用「低於標準」優先權跑（閒著時不影響遊戲、其他程式），但真正在做事時被 Edge 這些一般優先權的程式擠到很慢：
# 實測 Whisper 模型載入 11 秒 → 98 秒、一首歌聽寫 4.9 秒 → 13.7 秒（有時一首要好幾分鐘）。
# 所以有工作（載模型、聽寫、去人聲、下載、變調）在跑時整個程序升到「標準」，全部做完再降回去。
# 期間開的 yt-dlp／ffmpeg 子程序也會繼承標準優先權。
import threading as _threading
_busy = {"n": 0}
_busy_lock = _threading.Lock()
_NORMAL, _BELOW_NORMAL = 0x20, 0x4000


def _set_priority(cls):
    if os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes
        k = ctypes.windll.kernel32
        # 64 位元的 handle 要宣告型別，不然被當成 32 位元整數傳進去，呼叫會失敗
        k.GetCurrentProcess.restype = wintypes.HANDLE
        k.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k.SetPriorityClass(k.GetCurrentProcess(), cls)
    except Exception:
        pass
    set_io_memory_priority(cls == _NORMAL)


def set_io_memory_priority(normal):
    """工作排程器開的服務（優先順序 7）連記憶體優先權（2）和磁碟優先權（1）都是「低」，子程序也會繼承：
    讀 1.6 GB 的模型檔時被別的程式擠到後面，載入要 20 秒以上（一般優先權約 8 秒，2026-11-15 實測）。
    工作時調回一般（記憶體 5、磁碟 2），閒著再調低。"""
    if os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes
        k = ctypes.windll.kernel32
        k.GetCurrentProcess.restype = wintypes.HANDLE
        h = k.GetCurrentProcess()
        mem = wintypes.ULONG(5 if normal else 2)
        k.SetProcessInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        k.SetProcessInformation(h, 0, ctypes.byref(mem), 4)  # ProcessMemoryPriority
        io = wintypes.ULONG(2 if normal else 1)
        nt = ctypes.windll.ntdll
        nt.NtSetInformationProcess.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.ULONG]
        nt.NtSetInformationProcess(h, 33, ctypes.byref(io), 4)  # ProcessIoPriority

    except Exception:
        pass


def no_power_throttling():
    """關掉 Windows 11 的效率模式（EcoQoS）：沒有視窗的低優先權程式會被系統排到小核心低頻跑，子程序也繼承。
    實測 OCR 每張 235 → 50 ms、聽寫模型冷啟動 29 → 14 秒。只在工作時關、閒著交回系統的話，每次開始工作都要重新
    拉起來，連續辨識還是慢一倍；服務閒著本來就不用 CPU，效率模式也省不到電，所以啟動時就永久關掉。"""
    if os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes
        k = ctypes.windll.kernel32
        k.GetCurrentProcess.restype = wintypes.HANDLE
        k.SetProcessInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]

        class PT(ctypes.Structure):
            _fields_ = [("Version", wintypes.ULONG), ("ControlMask", wintypes.ULONG), ("StateMask", wintypes.ULONG)]
        pt = PT(1, 1, 0)  # 控制「執行速度降速」這一項，狀態＝不降速
        k.SetProcessInformation(k.GetCurrentProcess(), 4, ctypes.byref(pt), ctypes.sizeof(pt))  # ProcessPowerThrottling
    except Exception:
        pass


class _Job:
    """Windows 的「工作物件」：放進去的程序之後開的子程序也會自動在裡面，結束工作物件就整組一起結束。"""
    _k = None

    def __init__(self, p):
        import ctypes
        from ctypes import wintypes
        if _Job._k is None:
            k = ctypes.WinDLL("kernel32", use_last_error=True)  # 自己的一份：不要改到別處 windll.kernel32 宣告的型別
            k.CreateJobObjectW.restype = wintypes.HANDLE
            k.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
            k.AssignProcessToJobObject.restype = wintypes.BOOL
            k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            k.TerminateJobObject.restype = wintypes.BOOL
            k.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
            k.CloseHandle.argtypes = [wintypes.HANDLE]
            _Job._k = k
        self.h = _Job._k.CreateJobObjectW(None, None)
        if not self.h or not _Job._k.AssignProcessToJobObject(self.h, int(p._handle)):
            self.close()
            raise OSError("AssignProcessToJobObject 失敗")

    def terminate(self):
        return bool(self.h) and bool(_Job._k.TerminateJobObject(self.h, 1))

    def close(self):
        if self.h:
            _Job._k.CloseHandle(self.h)
            self.h = None

    def __del__(self):  # 程序物件不用了就放掉控制代碼（不會結束裡面的程序）
        try:
            self.close()
        except Exception:
            pass


def track(p):
    """剛開的子程序（yt-dlp）放進自己的工作物件，之後 kill_tree 結束整組。
    以前用 taskkill /T：它照「父程序 PID」找子程序，PID 被重複使用時，可能連不相干、剛好記著同一個父 PID 的程式一起殺掉。
    放不進去（很舊的 Windows、權限問題）就照舊用 taskkill /T。回傳 p，方便直接包住 Popen(...)。"""
    if os.name == "nt":
        try:
            p._ytls_job = _Job(p)
        except Exception:
            pass
    return p


def kill_tree(p):
    """結束子程序連同它開的子程序。yt-dlp.exe 是 PyInstaller 打包的：p.kill() 只結束外層的啟動程式，
    真正在下載的那個還會一直跑完（取消的下載照樣抓幾百 MB、還在寫已經刪掉的資料夾）。
    有用 track() 放進工作物件的：結束整個工作物件（外層已經結束、裡面還有東西在跑也收得到）。
    沒有的：taskkill /T（要在外層還活著時叫）。"""
    job = getattr(p, "_ytls_job", None)
    if job is not None:
        try:
            if job.terminate():
                try:
                    p.wait(5)
                except Exception:
                    pass
                return
        except Exception:
            pass
    if p.poll() is not None:
        return
    if os.name == "nt":
        try:
            import subprocess
            subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True, creationflags=0x08000000, timeout=10)
        except Exception:
            pass
    try:
        p.kill()
    except OSError:
        pass


class busy:
    """with busy(): ...  —— 這段期間程序用標準優先權（可以巢狀、多個執行緒同時用）"""
    def __enter__(self):
        with _busy_lock:
            _busy["n"] += 1
            if _busy["n"] == 1:
                _set_priority(_NORMAL)
        return self

    def __exit__(self, *exc):
        with _busy_lock:
            _busy["n"] -= 1
            if _busy["n"] == 0:
                _set_priority(_BELOW_NORMAL)
        return False
