# YT 歌詞字幕：本機 OCR 服務（PaddleOCR 模型，經 RapidOCR + onnxruntime；有顯示卡就用 DirectML 加速）
# 和 ocr-server.ps1（Windows 內建 OCR）介面相同：GET /ping、POST /ocr（要帶 X-YTLS: 1），只聽 localhost:8766，
# 只接受擴充功能（chrome-extension://）與開發測試頁的請求。
# 用法：<OCR 的 Python 環境>\Scripts\pythonw.exe ocr-server-paddle.py
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "listen-server"))
from gpuwatch import GpuWatch, GpuYield  # noqa: E402  其他程式（遊戲、ComfyUI）要用顯示卡時先讓
from paths import no_power_throttling, set_io_memory_priority  # noqa: E402  工作時記憶體／磁碟優先權也調回一般

no_power_throttling()  # 效率模式會把服務排到小核心低頻跑（見 listen-server/paths.py）

PORT = 8766
ALLOWED = ("chrome-extension://", "extension://", "http://localhost:8765")
IDLE_UNLOAD_S = 15 * 60  # 15 分鐘沒用就卸載模型，釋放記憶體與顯示卡

if sys.stdout:
    sys.stdout.reconfigure(encoding="utf-8")

# 開機自動啟動時只開一個空的伺服器；模型（和 OpenCV、onnxruntime）第一次真的要辨識時才載入
LOCK = threading.Lock()  # 一次只跑一張，避免多執行緒同時用同一個模型
STATE = {"engine": None, "gpu": None, "last": 0.0}
EXTRA = {}  # 除錯：POST /debug/engine 換 RapidOCR 設定做對照（服務重開就回到預設）


def engine():
    if STATE["engine"] is None:
        from rapidocr import RapidOCR
        # 偵測時不把小圖放大：RapidOCR 預設把短邊小於 736 的圖放大到 736 再偵測，640×360 的遮罩圖其實被放大成約
        # 1308×736，一張空白遮罩也要約 80 ms。改成只縮不放（上限 1920，原圖本來就不超過），遮罩 98 → 53 ms；
        # 2026-11-15 實測：兩首 MV 的結果一首 49 句完全一樣、一首一樣或略好（多讀到 3 句副歌），掃描 76.8 → 68.6 秒。
        # （偵測縮到 1280 更快，但有些細字副歌讀不到，不用）
        params = {"Det.limit_type": "max", "Det.limit_side_len": 1920}
        try:
            import onnxruntime as ort
            if "DmlExecutionProvider" in ort.get_available_providers():
                params["EngineConfig.onnxruntime.use_dml"] = True
        except Exception:
            pass
        params.update(EXTRA)
        STATE["engine"] = RapidOCR(params=params)
        STATE["gpu"] = params.get("EngineConfig.onnxruntime.use_dml", False)
    STATE["last"] = time.time()
    return STATE["engine"]


def unload_now(name):
    """開始讓出顯示卡：馬上卸掉模型（正在辨識的那張做完才卸）。"""
    def go():
        with LOCK:
            if STATE["engine"] is not None:
                STATE["engine"] = None
                import gc
                gc.collect()
                print("顯示卡讓給 %s：已卸載 OCR 模型" % name, flush=True)
    threading.Thread(target=go, daemon=True).start()


GW = GpuWatch(on_yield=unload_now, log=lambda m: print(m, flush=True))


def unloader():
    while True:
        time.sleep(60)
        with LOCK:
            if STATE["engine"] is not None and time.time() - STATE["last"] > IDLE_UNLOAD_S:
                STATE["engine"] = None
                import gc
                gc.collect()


# 服務平常是「低於標準」優先權（閒著時不影響其他程式）；辨識時暫時升到標準，不然影片播放中常被擠到很慢（見 listen-server/paths.py 的 busy）
_busy = {"n": 0}
_busy_lock = threading.Lock()


def _set_priority(cls):
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
    set_io_memory_priority(cls == 0x20)


class busy:
    def __enter__(self):
        with _busy_lock:
            _busy["n"] += 1
            if _busy["n"] == 1:
                _set_priority(0x20)  # NORMAL
        return self

    def __exit__(self, *exc):
        with _busy_lock:
            _busy["n"] -= 1
            if _busy["n"] == 0:
                _set_priority(0x4000)  # BELOW_NORMAL
        return False


def ocr(data: bytes, scale: float):
    with busy():
        return _ocr(data, scale)


# 除錯：最近 300 次辨識的時間拆解（GET /stats 看）：排隊等鎖、解碼、辨識各花多久
STATS = []


def _ocr(data: bytes, scale: float):
    import cv2
    import numpy as np
    t0 = time.time()
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("無法解碼圖片")
    if scale != 1:
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)
    t1 = time.time()
    with LOCK:
        # 快速掃描會同時送好幾張：排隊等鎖的時候開始讓出顯示卡（模型剛被卸掉），這裡不要又把模型載回來
        GW.check()
        t2 = time.time()
        r = engine()(img)
        t3 = time.time()
    STATS.append({"bytes": len(data), "w": int(img.shape[1]), "h": int(img.shape[0]), "decode": round((t1 - t0) * 1000),
                  "wait": round((t2 - t1) * 1000), "infer": round((t3 - t2) * 1000), "n": len(r.txts or []), "at": round(t3, 2)})
    del STATS[:-300]
    lines = []
    for txt, box, score in zip(r.txts or [], r.boxes if r.boxes is not None else [], r.scores or []):
        xs = [p[0] for p in box]; ys = [p[1] for p in box]
        lines.append({"text": txt, "x": int(min(xs) / scale), "y": int(min(ys) / scale),
                      "w": int((max(xs) - min(xs)) / scale), "h": int((max(ys) - min(ys)) / scale), "score": round(float(score), 3)})
    return lines


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _origin_ok(self):
        origin = self.headers.get("Origin")
        # Host 也要是本機（擋 DNS rebinding）
        host_ok = self.headers.get("Host", "").lower() in ("127.0.0.1:8766", "localhost:8766")
        return host_ok and ((not origin) or origin.startswith(ALLOWED)), origin

    def _send(self, code, obj=None, origin=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8") if obj is not None else b""
        self.send_response(code)
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "content-type, x-ytls")
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
        ok, origin = self._origin_ok()
        self._send(204 if ok else 403, None, origin if ok else None)

    def do_GET(self):
        ok, origin = self._origin_ok()
        if not ok:
            return self._send(403)
        if self.path.startswith("/stats"):
            return self._send(200, {"ok": True, "stats": STATS}, origin)
        if self.path.startswith("/ping"):
            return self._send(200, {"ok": True, "lang": "ja", "engine": "paddle", "loaded": STATE["engine"] is not None, "gpu": STATE["gpu"],
                                    "gpuYield": GW.status()}, origin)
        self._send(404, None, origin)

    def do_POST(self):
        ok, origin = self._origin_ok()
        if not ok:
            return self._send(403)
        if self.headers.get("X-YTLS") != "1":
            return self._send(404, None, origin)
        if self.path.startswith("/debug/engine"):
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8") or "{}")
            except ValueError:
                body = {}
            with LOCK:
                EXTRA.clear()
                EXTRA.update({str(k): v for k, v in body.items()})
                STATE["engine"] = None
                del STATS[:]
            return self._send(200, {"ok": True, "extra": EXTRA}, origin)
        if self.path.startswith("/gpu/override"):
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8") or "{}")
            except ValueError:
                body = {}
            return self._send(200, dict(GW.set_override(bool(body.get("on", True))), ok=True), origin)
        if not self.path.startswith("/ocr"):
            return self._send(404, None, origin)
        try:
            data = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            if GW.active():  # 顯示卡讓給別的程式中：不辨識（擴充功能會等它用完再繼續掃）
                return self._send(503, {"ok": False, "yield": GW.active(), "detail": GW.detail}, origin)
            scale = 1.0
            if "scale=" in self.path:
                scale = max(0.25, min(3.0, float(self.path.split("scale=")[1].split("&")[0])))
            t0 = time.time()
            lines = ocr(data, scale)
            self._send(200, {"ok": True, "ms": round((time.time() - t0) * 1000), "lines": lines}, origin)
        except GpuYield as e:
            self._send(503, {"ok": False, "yield": str(e), "detail": GW.detail}, origin)
        except Exception as e:
            self._send(500, {"ok": False, "error": str(e)}, origin)


if __name__ == "__main__":
    threading.Thread(target=unloader, daemon=True).start()
    GW.start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"YT 歌詞字幕 OCR 服務（Paddle 模型，用到時才載入）已啟動：http://localhost:{PORT}", flush=True)
    srv.serve_forever()
