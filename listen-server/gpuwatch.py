# YT 歌詞字幕：其他程式要用顯示卡時（遊戲、ComfyUI 算圖、別的 AI 程式），兩個本機服務先讓出來。
# 讓 = 立刻把模型從顯示卡卸掉、暫停需要顯示卡的工作；服務程式本身不關（空著的服務幾乎不占顯示卡，
# 重開整個服務冷啟動要 12 秒以上，留著的話對方用完後重新載入模型只要 2～4 秒），對方用完自動恢復。
# OCR 服務（另一個 Python）從 ../listen-server 匯入這個檔，所以只能用 Python 3.9 也能跑的語法。
# 偵測方式沿用 APEIRIA 的 voice/server.py：Windows 的 GPU 效能計數器（nvidia-smi 在 Windows 上看不到各程式用量）。
import ctypes
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

HEAVY_GB = 2.5   # 單一程式占這麼多顯示記憶體才算「大程式」；桌面、Edge、Wallpaper Engine 都在 1 GB 以下
BUSY_PCT = 25.0  # 大程式的顯示卡使用率超過這個才算「正在用」（遊戲、算圖）；只是把模型留在記憶體裡不算
NEED_GB = 3.0    # 我們自己的模型大約要這麼多（Whisper 約 1.6 GB＋去人聲 1.6 GB）：剩下的記憶體不夠也讓
EVERY_S = 3.0    # 多久看一次
START_N = 2      # 連續幾次判定「要讓」才開始讓（避免一瞬間的尖峰）
END_S = 20.0     # 連續這麼久都不用讓才恢復
IGNORED = {"dwm.exe", "csrss.exe"}  # 桌面合成器的計數器會把共用畫面算進去（16 GB 的卡顯示 8 GB），不能信
COMFY = "http://127.0.0.1:8188/queue"
PID_DIR = Path(tempfile.gettempdir()) / "ytls-gpu"  # 兩個服務各自登記自己的程序編號，互相不當成「別的程式」
NO_WINDOW = 0x08000000 if os.name == "nt" else 0

_LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 不經過系統代理


class GpuYield(Exception):
    """顯示卡讓給別的程式中；args[0] 是對方的名字。"""


def pretty(name):
    n = (name or "").strip()
    return n[:-4] if n.lower().endswith(".exe") else n or "其他程式"


def register(pid=None):
    """登記這個程序（聽寫小程序也會登記自己）；兩個服務看到就不會把我們當成要讓的對象。"""
    try:
        PID_DIR.mkdir(exist_ok=True)
        (PID_DIR / str(pid or os.getpid())).write_text("", encoding="utf-8")
    except OSError:
        pass


def unregister(pid):
    """程序結束了：刪掉登記（不然編號被別的程式重用時會被誤當成自己人）。"""
    try:
        (PID_DIR / str(pid)).unlink()
    except OSError:
        pass


def own_pids(alive):
    out = {os.getpid()}
    if not alive:  # 程序快照失敗：不知道誰還活著，不要把別人的登記刪掉
        return out
    try:
        for f in PID_DIR.iterdir():
            if f.name.isdigit():
                if int(f.name) in alive:
                    out.add(int(f.name))
                else:
                    try:
                        f.unlink()  # 已經結束的舊程序
                    except OSError:
                        pass
    except OSError:
        pass
    return out


def comfy_busy():
    """ComfyUI 有正在算或排隊中的圖 → True；ComfyUI 有開著 → 'idle'；沒開 → None。"""
    try:
        with _LOCAL.open(COMFY, timeout=0.5) as r:
            q = json.load(r)
        return True if (q.get("queue_running") or q.get("queue_pending")) else "idle"
    except (OSError, ValueError):
        return None


def free_gb():
    """整張顯示卡還剩多少記憶體（GB）；讀不到（不是 NVIDIA、沒有 nvidia-smi）回傳 None。"""
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
                             capture_output=True, timeout=5, creationflags=NO_WINDOW).stdout.decode()
        used, total = [float(x) for x in out.splitlines()[0].split(",")]
        return (total - used) / 1024
    except Exception:
        return None


def process_names():
    """每個程序的執行檔名稱（game.exe）；用程序快照，連 dwm 這種打不開的系統程序也拿得到名字。"""
    if sys.platform != "win32":
        return {}
    from ctypes import wintypes

    class Entry(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD),
                    ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
                    ("pcPriClassBase", wintypes.LONG), ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260)]

    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k.Process32FirstW.argtypes = k.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    snap = k.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if not snap or snap == wintypes.HANDLE(-1).value:
        return {}
    names, e = {}, Entry()
    e.dwSize = ctypes.sizeof(Entry)
    try:
        more = k.Process32FirstW(snap, ctypes.byref(e))
        while more:
            names[e.th32ProcessID] = e.szExeFile
            more = k.Process32NextW(snap, ctypes.byref(e))
    finally:
        k.CloseHandle(snap)
    return names


class _Counters:
    """一直開著的 PDH 查詢：各程序的專用顯示記憶體（GB）和顯示卡引擎使用率（%，要兩次取樣才有值）。"""

    def __init__(self):
        from ctypes import wintypes
        self.w = wintypes

        class Value(ctypes.Structure):
            class U(ctypes.Union):
                _fields_ = [("large", ctypes.c_longlong), ("dbl", ctypes.c_double)]
            _fields_ = [("status", wintypes.DWORD), ("u", U)]

        class Item(ctypes.Structure):
            _fields_ = [("name", wintypes.LPWSTR), ("value", Value)]

        self.Item = Item
        pdh = self.pdh = ctypes.WinDLL("pdh")
        pdh.PdhOpenQueryW.argtypes = [wintypes.LPCWSTR, ctypes.c_size_t, ctypes.POINTER(wintypes.HANDLE)]
        pdh.PdhAddEnglishCounterW.argtypes = [wintypes.HANDLE, wintypes.LPCWSTR, ctypes.c_size_t, ctypes.POINTER(wintypes.HANDLE)]
        pdh.PdhCollectQueryData.argtypes = [wintypes.HANDLE]
        pdh.PdhGetFormattedCounterArrayW.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
                                                     ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
        pdh.PdhCloseQuery.argtypes = [wintypes.HANDLE]
        for fn in ("PdhOpenQueryW", "PdhAddEnglishCounterW", "PdhCollectQueryData", "PdhGetFormattedCounterArrayW", "PdhCloseQuery"):
            getattr(pdh, fn).restype = wintypes.DWORD
        self.q, self.mem, self.eng = wintypes.HANDLE(), wintypes.HANDLE(), wintypes.HANDLE()
        if pdh.PdhOpenQueryW(None, 0, ctypes.byref(self.q)):
            raise OSError("PdhOpenQuery")
        if pdh.PdhAddEnglishCounterW(self.q, r"\GPU Process Memory(*)\Dedicated Usage", 0, ctypes.byref(self.mem)):
            self.close()
            raise OSError("GPU Process Memory 計數器")
        if pdh.PdhAddEnglishCounterW(self.q, r"\GPU Engine(*)\Utilization Percentage", 0, ctypes.byref(self.eng)):
            self.close()
            raise OSError("GPU Engine 計數器")

    def close(self):
        if self.q:
            self.pdh.PdhCloseQuery(self.q)
            self.q = self.w.HANDLE()

    def _array(self, counter, fmt):
        w = self.w
        size, count = w.DWORD(0), w.DWORD(0)
        st = self.pdh.PdhGetFormattedCounterArrayW(counter, fmt, ctypes.byref(size), ctypes.byref(count), None)
        if st != 0x800007D2:  # PDH_MORE_DATA；其他代碼＝這次沒有資料（例如第一次取樣的使用率）
            return []
        buf = ctypes.create_string_buffer(size.value)
        if self.pdh.PdhGetFormattedCounterArrayW(counter, fmt, ctypes.byref(size), ctypes.byref(count), buf):
            return []
        return [(it.name or "", it.value) for it in ctypes.cast(buf, ctypes.POINTER(self.Item))[:count.value] if it.value.status in (0, 1)]

    def sample(self):
        if self.pdh.PdhCollectQueryData(self.q):
            raise OSError("PdhCollectQueryData")
        mem, util = {}, {}
        for name, v in self._array(self.mem, 0x400):  # PDH_FMT_LARGE
            p = name.split("_")  # pid_1234_luid_0x..._0x..._phys_0
            if len(p) > 1 and p[0] == "pid" and p[1].isdigit():
                mem[int(p[1])] = mem.get(int(p[1]), 0.0) + v.u.large / 2 ** 30
        for name, v in self._array(self.eng, 0x200 | 0x8000):  # PDH_FMT_DOUBLE | PDH_FMT_NOCAP100
            p = name.split("_")  # pid_1234_luid_..._phys_0_eng_0_engtype_3D
            et = name.rsplit("engtype_", 1)[-1].lower()
            if len(p) > 1 and p[0] == "pid" and p[1].isdigit() and not et.startswith(("copy", "video", "legacyoverlay", "security")):
                util[int(p[1])] = util.get(int(p[1]), 0.0) + v.u.dbl
        return mem, util


class GpuWatch:
    """背景每 3 秒看一次誰在用顯示卡。on_yield(名字) 在開始讓的時候呼叫一次（卸載模型），on_resume() 在恢復時呼叫。"""

    def __init__(self, on_yield=None, on_resume=None, log=print):
        self.on_yield, self.on_resume, self.log = on_yield, on_resume, log
        self.reason = None       # 正在讓給誰（None＝沒有在讓）
        self.override = False    # 使用者按了「這次照用」：這一輪不讓，等對方結束才清掉
        self.detail = ""
        self._hits, self._last_want = 0, 0.0
        self._armed = 0.0        # 按「這次照用」時這個服務還沒開始讓：這個時間之前開始讓的，也算照用
        self._lock = threading.Lock()
        self._counters = None

    # ---- 給服務用 ----
    def active(self):
        """現在要讓的對象（字串），不用讓就是 None。"""
        return None if self.override else self.reason

    def check(self):
        r = self.active()
        if r:
            raise GpuYield(r)

    def wait(self, cancelled=lambda: False):
        """讓出期間一直等；對方用完（或使用者按了照用、工作被取消）才回來。"""
        while self.active() and not cancelled():
            time.sleep(1.0)

    def set_override(self, on=True):
        with self._lock:
            self.override = bool(on) and self.reason is not None
            # 兩個服務各自每 3 秒看一次、連續兩次才讓，按鈕出現時另一個可能還沒開始讓：先記著，30 秒內開始讓也照用
            self._armed = time.time() + 30 if on and self.reason is None else 0.0
        return self.status()

    def status(self):
        return {"yield": self.reason, "override": self.override, "detail": self.detail}

    def start(self):
        register()
        threading.Thread(target=self._loop, daemon=True, name="gpuwatch").start()
        return self

    # ---- 判斷 ----
    def decide(self):
        """要讓給誰（名字）或 None。規則：ComfyUI 在算圖；別的大程式（≥2.5 GB）正在用顯示卡（遊戲、算圖）；
        或大程式把記憶體占到我們的模型放不下。只是開著、把模型放在記憶體裡沒在算的，不讓。"""
        comfy = comfy_busy()
        if comfy is True:
            self.detail = "ComfyUI 正在算圖"
            return "ComfyUI"
        if sys.platform != "win32":
            return None
        if self._counters is None:
            self._counters = _Counters()
        mem, util = self._counters.sample()
        names = process_names()
        own = own_pids(set(names))
        self.last = (mem, util, names, own)
        heavy = sorted(((gb, pid) for pid, gb in mem.items()
                        if gb >= HEAVY_GB and pid not in own and (names.get(pid) or "").lower() not in IGNORED), reverse=True)
        label = lambda pid: "ComfyUI" if comfy and (names.get(pid) or "").lower() in ("python.exe", "pythonw.exe") else pretty(names.get(pid))
        for gb, pid in heavy:
            if util.get(pid, 0.0) >= BUSY_PCT:
                self.detail = "%s 正在用顯示卡（%.1f GB、%d%%）" % (label(pid), gb, util[pid])
                return label(pid)
        if heavy:
            free = free_gb()
            if free is not None:
                free += sum(mem.get(p, 0.0) for p in own)  # 我們自己占的不算在「不夠」裡
                if free < NEED_GB:
                    gb, pid = heavy[0]
                    self.detail = "%s 占了 %.1f GB，顯示卡記憶體只剩 %.1f GB" % (label(pid), gb, free)
                    return label(pid)
        return None

    def _loop(self):
        fails = 0
        while True:
            time.sleep(EVERY_S if fails <= 3 else 60)  # 一直讀不到（沒有這些計數器的電腦）就少試一點
            try:
                want = self.decide()
                fails = 0
            except Exception as e:  # 讀不到計數器：不讓（照舊運作），記一次就好
                fails += 1
                if fails == 1:
                    self.log("讀不到顯示卡使用狀況：%s" % e)
                if fails > 3 and self._counters is not None:
                    self._counters.close()  # 重開一個查詢
                    self._counters = None
                want = None
            now = time.time()
            start = end = None
            with self._lock:
                if want:
                    self._hits += 1
                    self._last_want = now
                    if self.reason is None and self._hits >= START_N:
                        self.reason = start = want
                        if now < self._armed:
                            self.override = True
                    elif self.reason is not None:
                        self.reason = want
                else:
                    self._hits = 0
                    if self.reason is not None and now - self._last_want >= END_S:
                        end, self.reason, self.override, self._armed = self.reason, None, False, 0.0
                        self.detail = ""
            if start:
                self.log("顯示卡讓給 %s（%s）" % (start, self.detail))
                if self.on_yield and not self.override:
                    try:
                        self.on_yield(start)
                    except Exception as e:
                        self.log("讓出顯示卡時出錯：%s" % e)
            if end:
                self.log("%s 用完了，恢復使用顯示卡" % end)
                if self.on_resume:
                    try:
                        self.on_resume()
                    except Exception as e:
                        self.log("恢復時出錯：%s" % e)


if __name__ == "__main__":  # 手動檢查：python gpuwatch.py → 印出現在的判斷
    for s in (sys.stdout,):
        if s:
            s.reconfigure(encoding="utf-8", errors="replace")
    g = GpuWatch()
    for i in range(3):
        r = g.decide()
        mem, util, names, own = g.last
        top = sorted(mem.items(), key=lambda x: -x[1])[:6]
        print("判斷：", r, g.detail if r else "")
        for pid, gb in top:
            print("   %6.2f GB  %5.1f%%  %s%s" % (gb, util.get(pid, 0.0), names.get(pid), "（自己）" if pid in own else ""))
        time.sleep(2)
