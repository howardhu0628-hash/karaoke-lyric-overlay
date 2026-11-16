# YT 歌詞字幕：Whisper 聽寫的小程序（由 listen-server.py 開，不要自己執行）。
# 為什麼分開：在服務裡把 faster-whisper 模型丟掉（閒置卸載、讓出顯示卡）時，若剛好有別的執行緒在開新執行緒
# （HTTP 請求、ffmpeg），CTranslate2 會讓整個程序中止（Fatal Python error: Aborted，2026-11-15 重現；以前閒置 15 分鐘
# 卸載後偶爾當掉也是這個）。放在獨立程序裡，卸載＝直接結束這個程序，主服務和進行中的工作都不受影響。
# 協定（stdin／stdout 二進位）：
#   開好後送一行 {"ready": true, "device": "cuda", "sec": 2.0}
#   請求：一行 JSON {"n": 樣本數, "opts": {...}} 接著 n 個 float32（16 kHz 單聲道）
#   回應：一行 JSON {"ok": true, "segments": [{start, end, text, avg_logprob, no_speech_prob, compression_ratio, words}]}
import json
import os
import sys
import time

T_START = time.time()
proto_in = os.fdopen(os.dup(0), "rb")
proto_out = os.fdopen(os.dup(1), "wb")
os.dup2(2, 1)  # 函式庫印到 stdout 的東西改到 stderr（記錄檔），不要混進協定
sys.stdout = sys.stderr

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paths import no_power_throttling, set_io_memory_priority, setup_dll_path  # noqa: E402
from gpuwatch import register  # noqa: E402

register()  # 登記自己：兩個服務「要不要讓顯示卡」的判斷才不會把我們自己的模型（2～3 GB、算的時候很忙）當成別的程式
no_power_throttling()
set_io_memory_priority(True)  # 服務是低優先權開的，這裡會繼承到；只在要用時才存在，所以用一般優先權
setup_dll_path()
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
os.environ["HF_HUB_OFFLINE"] = "1"

import numpy as np  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402


def send(obj):
    proto_out.write(json.dumps(obj, ensure_ascii=False).encode("utf-8") + b"\n")
    proto_out.flush()


def main():
    model_dir = sys.argv[1]
    t0 = time.time()
    t_import = t0 - T_START
    try:
        model, device = WhisperModel(model_dir, device="cuda", compute_type="float16"), "cuda"
    except Exception as e:  # 沒有顯示卡可用就用 CPU（慢很多）
        print("GPU 不能用，改用 CPU：", e, flush=True)
        model, device = WhisperModel(model_dir, device="cpu", compute_type="int8", cpu_threads=max(1, (os.cpu_count() or 4) // 2)), "cpu"
    send({"ready": True, "device": device, "sec": round(time.time() - t0, 1), "import": round(t_import, 1)})
    while True:
        line = proto_in.readline()
        if not line:
            return  # 主服務關掉了
        try:
            req = json.loads(line)
            n = int(req["n"])
            buf = proto_in.read(n * 4)
            if len(buf) != n * 4:
                return
            audio = np.frombuffer(buf, np.float32)
            o = req.get("opts") or {}
            segs, _ = model.transcribe(audio, **o)
            out = []
            for s in segs:
                out.append({"start": s.start, "end": s.end, "text": s.text, "avg_logprob": s.avg_logprob,
                            "no_speech_prob": s.no_speech_prob, "compression_ratio": s.compression_ratio,
                            "words": [[w.start, w.end, w.word] for w in (s.words or [])]})
            send({"ok": True, "segments": out})
        except Exception as e:
            send({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
    os._exit(0)  # 不跑模型的解構（正是會中止的那一步）
