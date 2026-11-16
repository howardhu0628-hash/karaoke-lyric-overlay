# YT 歌詞字幕：真‧卡拉 OK 伴奏（消掉原唱）
#
# 1) 先找「來源」：用 yt-dlp 搜 YouTube 上的官方伴奏／off vocal／カラオケ，下載音訊後跟原影片的聲音比對，
#    確認真的是同一份配樂（不是翻唱、重新編曲、變速版），並算出每一段要偏移多少秒（MV 常有前奏劇情、中間剪接）。
# 2) 找不到：用 GPT-SoVITS 內建的 UVR5 bs_roformer 把原影片的人聲分離掉，時間天生對齊。
#    去人聲跟 1) 同時做（原影片音訊一下載好就開始），模型在開始時先背景載入、做完留在顯示卡上 10 分鐘。
#
# 結果存在 cache/kara/<影片ID>.json（＋音檔），擴充功能播放伴奏、把原影片音量關小（導唱）。
# 命令列測試：python kara.py <影片ID> "<標題>" "<頻道>"   或   python kara.py --match <原曲音檔> <伴奏音檔>
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
KCACHE = HERE / "cache" / "kara"
KTMP = HERE / "tmp" / "kara"
sys.path.insert(0, str(HERE))
from paths import FFMPEG, NODE, ROFORMER, SEP_OK, UVR_CODE, YTDLP, busy, kill_tree, track  # noqa: E402  工具、模型放在哪（安裝版看 ytls-config.json）
NO_SEP_MSG = "這個安裝沒有 AI 去人聲（安裝時選了不含 AI 模型的那一級）"
NO_WINDOW = 0x08000000 if os.name == "nt" else 0
KEEP_SONGS = 60          # 伴奏快取最多留幾首（超過刪最舊的）
SR = 4000                # 細調用的取樣率（0.25 毫秒）；粗找先降到 1kHz，快很多
WIN, HOP = 10.0, 5.0     # 比對窗：10 秒一窗、每 5 秒一窗
MATCH_COEF = 0.30        # 一窗算「對上」的相關係數門檻（同一份配樂通常 0.5 以上；不同編曲 0.1 以下）
MIN_COVER = 0.60         # 原影片有聲音的窗至少六成對上，才採用這個來源

INST_RE = re.compile(r"(instrumental|\binst\b|\binst\.|off\s*vocal|オフボーカル|karaoke|カラオケ|ニコカラ|伴奏|backing\s*track|off\s*vo|"
                     r"去人声|去人聲|无人声|無人聲|消音|卡拉\s*ok)", re.I)
BAD_RE = re.compile(r"(cover|歌ってみた|うたってみた|翻唱|翻弹|翻彈|钢琴|鋼琴|改编|改編|八音盒|吉他|弾いてみた|叩いてみた|piano|ピアノ|guitar|ギター|オルゴール|music\s*box|8\s*bit|remix|"
                    r"arrange|アレンジ|lo-?fi|orchestra|オーケストラ|吹奏楽|acoustic|アコースティック|nightcore|sped\s*up|slowed|"
                    r"tutorial|drum|ドラム|bass|ベース|violin|バイオリン|ver\.|version|male|男性キー|女性キー|[+-]\d\s*key|キー[+-]|"
                    r"(?:^|[\s【\[（(])[+＋\-−]\s?\d{1,2}(?=\s|$|[】\]）)【\[（(]|off|key|キー))", re.I)  # ニコカラ常見的「-5 off vocal」變調版


def ytdlp_base():
    return [str(YTDLP), "--js-runtimes", "node:" + str(NODE), "--ffmpeg-location", str(FFMPEG.parent), "--no-progress"]


def run_cancellable(cmd, cancelled=None, timeout=None):
    """跟 subprocess.run 一樣（capture_output），但 cancelled() 為真時馬上結束子程序（不讓取消的工作繼續下載、寫檔）。
    回傳 (returncode, stdout bytes, stderr bytes)。"""
    p = track(subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=NO_WINDOW))
    out = {}
    readers = [threading.Thread(target=lambda k=k, s=s: out.__setitem__(k, s.read()), daemon=True)
               for k, s in (("o", p.stdout), ("e", p.stderr))]
    for t in readers:
        t.start()
    t0 = time.time()
    while p.poll() is None:
        if (cancelled and cancelled()) or (timeout and time.time() - t0 > timeout):
            kill_tree(p)  # 只 kill 的話 yt-dlp 真正下載的子程序會繼續跑（見 paths.kill_tree）
            p.wait()
            for t in readers:
                t.join(2)
            if cancelled and cancelled():
                raise RuntimeError("已取消")
            raise subprocess.TimeoutExpired(cmd, timeout)
        time.sleep(0.2)
    for t in readers:
        t.join(5)
    return p.returncode, out.get("o", b""), out.get("e", b"")


def run_capture(cmd, timeout):
    """subprocess.run(capture_output, timeout) 的替代：逾時時整棵程序樹一起結束。
    subprocess.run 逾時只 kill 啟動器，yt-dlp 真正的子程序還拿著輸出管線，run() 收尾時會一直等它跑完（逾時等於沒設）。"""
    rc, out, err = run_cancellable(cmd, timeout=timeout)
    return subprocess.CompletedProcess(cmd, rc, out, err)


def friendly_dl_error(stderr):
    """yt-dlp 的英文錯誤 → 給使用者看的中文（不附網址）。會員限定的字樣要保留「會員」，擴充功能靠它判斷改成邊播邊聽寫。"""
    s = stderr.decode("utf-8", "replace") if isinstance(stderr, bytes) else str(stderr or "")
    rules = [
        (r"confirm your age|age-restricted|inappropriate for some users", "這部影片有年齡限制，要登入才能看；本機服務不會用你的帳號登入，所以下載不了"),
        (r"members-only|channel's members|join this channel|メンバー限定", "會員限定影片，下載不了"),
        (r"not a bot", "YouTube 要求驗證不是機器人，暫時下載不了，過一陣子再試"),
        (r"Private video", "私人影片，下載不了"),
        (r"Premieres in|live event will begin|is_live", "還沒開始或正在直播的影片沒辦法整部下載"),
        (r"not available in your country|blocked it in your country|geo", "這部影片在這個地區看不了"),
        (r"blocked due to|copyright|claimed content", "這部影片因為版權被封鎖，下載不了"),
        (r"Video unavailable|This video is unavailable|has been removed", "影片已刪除或無法播放"),
        (r"HTTP Error 403", "YouTube 拒絕下載（403），稍後再試"),
        (r"HTTP Error 429|Too Many Requests", "下載太頻繁被暫時擋住（429），稍後再試"),
        (r"timed out|Unable to connect|getaddrinfo|Connection", "網路連不上，稍後再試"),
    ]
    for pat, msg in rules:
        if re.search(pat, s, re.I):
            return msg
    lines = [ln for ln in s.strip().splitlines() if ln.strip()]
    tail = re.sub(r"https?://\S+", "", lines[-1] if lines else "沒有下載到音訊").replace("ERROR:", "").strip()
    return tail[:160] or "沒有下載到音訊"


def download_audio(vid, out_dir, name, cancelled=None):
    """vid：YouTube 影片 ID，或完整網址（niconico／B 站候選）"""
    out_dir.mkdir(parents=True, exist_ok=True)
    url = vid if "://" in vid else "https://www.youtube.com/watch?v=" + vid
    cmd = ytdlp_base() + ["--no-playlist", "--match-filter", "!is_live", "-f", "bestaudio[ext=webm]/bestaudio",
                          "-o", str(out_dir / (name + ".%(ext)s")), url]
    for attempt in range(2):
        _, _, err = run_cancellable(cmd, cancelled)
        files = [f for f in out_dir.iterdir() if f.name.startswith(name + ".") and not f.name.endswith(".part")]
        # YouTube 偶爾對某次拿到的下載網址回 403，重新解析一次（會拿到新網址）通常就好；B 站的 403/567 是被擋，不重試
        if files or "://" in vid or b"HTTP Error 403" not in err:
            break
        for f in out_dir.glob(name + ".*"):
            f.unlink(missing_ok=True)
        time.sleep(2)
    if not files:
        msg = friendly_dl_error(err)
        if "://" in vid and re.search(rb"HTTP Error (412|403|567)", err):  # B 站被擋：呼叫端要看到原本的代碼
            msg += "（" + re.search(rb"HTTP Error \d+", err).group(0).decode() + "）"
        raise RuntimeError("下載失敗：" + msg)
    return files[0]


def write_json_atomic(path, obj):
    """先寫暫存檔再換名：服務在寫到一半被結束，也不會留下壞掉的 json"""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


VID_RE = re.compile(r"^[A-Za-z0-9_-]{1,20}$")


def valid_vid(vid):
    return bool(VID_RE.match(str(vid or "")))


def search(query, n=8):
    cmd = ytdlp_base() + ["ytsearch%d:%s" % (n, query), "--flat-playlist", "-J"]
    r = run_capture(cmd, timeout=30)
    try:
        return json.loads(r.stdout.decode("utf-8", "replace")).get("entries") or []
    except Exception:
        return []


# B 站擋了（不登入的搜尋回 412、影音伺服器回 567）就暫停用 B 站一小時，不繞過、也不浪費時間一直試
BILI = {"until": 0.0}


def bili_blocked():
    return time.time() < BILI["until"]


def block_bili(why):
    BILI["until"] = time.time() + 3600
    print("B 站暫停使用一小時：", why, flush=True)


def search_bili(query, n=6):
    """B 站搜尋（不登入）：先拿搜尋結果的影片網址（簡易搜尋），再一次讀這幾支的標題、長度、各 P。
    多 P 的影片（常見「P1 原唱、P2 伴奏」）每 P 各算一個候選。412 隔幾秒再試一次，還是被擋就暫停 B 站一小時。"""
    try:
        for attempt in range(2):  # B 站偶爾回 412，隔幾秒再試一次就好；還是不行就放棄
            r = run_capture(ytdlp_base() + ["bilisearch%d:%s" % (n, query), "--flat-playlist", "--print", "url"], timeout=25)
            urls =[u.strip() for u in r.stdout.decode("utf-8", "replace").splitlines() if "bilibili.com/video/" in u][:n]
            if urls or b"412" not in r.stderr:
                break
            time.sleep(4)
        if not urls and b"412" in r.stderr:
            block_bili("搜尋被擋（412）")
            return []
        if not urls:
            print("B 站搜尋沒有結果", query, r.stderr.decode("utf-8", "replace").strip().splitlines()[-1:], flush=True)
            return []
        r = run_capture(ytdlp_base() + urls + ["--skip-download", "-j", "--ignore-errors"], timeout=40)
    except subprocess.TimeoutExpired as e:  # B 站沒回應（多半是在擋）：跟 412 一樣先不用一小時
        block_bili("沒有回應（%d 秒）" % e.timeout)
        return []
    except Exception as e:
        print("B 站搜尋失敗", query, e, flush=True)
        return []
    out = []
    for line in r.stdout.decode("utf-8", "replace").splitlines():
        try:
            e = json.loads(line)
        except Exception:
            continue
        url = e.get("webpage_url") or e.get("original_url")
        if not url or "bilibili.com" not in url:
            continue
        title = str(e.get("title") or "")
        pt = str(e.get("playlist_title") or "")
        if pt and pt not in title:
            title = pt + " " + title
        out.append({"id": url, "title": title, "duration": e.get("duration") or 0, "channel": e.get("uploader") or ""})
    return out


NICO_API = "https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search"


def search_nico(query, n=10):
    """niconico 搜尋（官方 snapshot 搜尋 API，不用登入）：ニコカラ／off vocal 多半直接用 CD 的 off vocal 音軌，最常對得上。
    頻道欄位放標籤（ニコカラ的標題常常沒寫歌手，歌手名在標籤裡）"""
    import urllib.parse
    import urllib.request
    url = NICO_API + "?" + urllib.parse.urlencode({
        "q": query, "targets": "title,tags", "fields": "contentId,title,lengthSeconds,viewCounter,tags",
        "_sort": "-viewCounter", "_limit": n, "_context": "ytls-kara"})
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ytls-kara/1.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8")).get("data") or []
    except Exception as e:
        print("niconico 搜尋失敗", query, e, flush=True)
        return []
    return [{"id": "https://www.nicovideo.jp/watch/" + d["contentId"], "title": str(d.get("title") or ""),
             "duration": d.get("lengthSeconds") or 0, "channel": str(d.get("tags") or "")} for d in data if d.get("contentId")]


def norm(s):
    import unicodedata
    return re.sub(r"[\s\W_]+", "", unicodedata.normalize("NFKC", str(s or "")).lower())


def find_candidates(queries, song_len, own_id, song="", artist=""):
    """搜官方伴奏：YouTube（instrumental／off vocal）＋niconico（ニコカラ／off vocal）＋B 站（伴奏），三邊同時搜。
    標題要有 instrumental／off vocal／カラオケ／伴奏 之類的字，排除翻唱、改編、變調、變速。
    知道歌名、歌手時：標題要有歌名，標題或頻道要有歌手名（同名不同歌很多），不符的不下載。"""
    ns, na = norm(song), norm(artist)
    if ns:
        queries = [(song + " " + artist).strip(), song]
    queries = [q for q in queries if q][:2]
    if not queries:
        return []
    bili = {}
    th = threading.Thread(target=lambda: bili.__setitem__("r", [] if bili_blocked() else _try(lambda: search_bili(queries[0] + " 伴奏"))), daemon=True)
    th.start()
    nico = {}
    th_n = threading.Thread(target=lambda: nico.__setitem__("r", _try(lambda: search_nico(queries[0] + " off vocal") + search_nico(queries[0] + " ニコカラ"))), daemon=True)
    th_n.start()

    def accept(e, seen, site):
        vid, title, dur = e.get("id"), str(e.get("title") or ""), e.get("duration") or 0
        if not vid or vid in seen or vid == own_id:
            return None
        seen.add(vid)
        t = title.replace("　", " ")
        if not INST_RE.search(t) or BAD_RE.search(t):
            return None
        if song_len and dur and not (0.5 * song_len <= dur <= 1.5 * song_len):
            return None
        if ns and ns not in norm(t):
            return None
        if na and na not in norm(t) + norm(e.get("channel")):
            return None
        # 不知道歌名（翻唱等）：搜尋字的每個詞都要出現在標題或頻道名（不然會搜到別首歌的伴奏）
        if not ns and not all(norm(w) in norm(t) + norm(e.get("channel")) for w in queries[0].split() if len(norm(w)) >= 2):
            return None
        score = 0
        if re.search(r"official|官方", t, re.I) or str(e.get("channel") or "").endswith("- Topic"):
            score += 2
        if re.search(r"instrumental|off\s*vocal|オフボーカル|伴奏", t, re.I):
            score += 1
        # B 站多 P：「原唱」那一 P 往後排（標題最後是各 P 的名字）
        if site == "bilibili" and re.search(r"on\s*vocal|原唱|原版|人声版|人聲版", t[-16:], re.I):
            score -= 3
        # ニコカラ也有「on vocal」（有人聲的卡拉 OK 字幕版）：沒寫 off vocal 的往後排
        if re.search(r"on\s*vocal", t, re.I) and not re.search(r"off\s*vocal|オフボーカル", t, re.I):
            score -= 3
        if re.search(r"原キー", t):
            score += 1
        return {"id": vid, "title": title, "channel": e.get("channel") or "", "duration": dur, "score": score, "site": site}

    # YouTube 的幾個搜尋同時跑（一個約 4 秒；以前一個一個來）
    yq = [q + " " + suffix for q in queries for suffix in ("instrumental", "off vocal")]
    yres = {}
    ths = [threading.Thread(target=lambda q=q: yres.__setitem__(q, _try(lambda: search(q))), daemon=True) for q in yq]
    for t in ths:
        t.start()
    for t in ths:
        t.join(35)
    seen, yt = set(), []
    for i, q in enumerate(yq):
        if i == 2 and len(yt) >= 3:  # 第一組搜尋字已經夠多候選：第二組的結果不用
            break
        r = yres.get(q)
        for e in (r if isinstance(r, list) else []):
            c = accept(e, seen, "youtube")
            if c:
                yt.append(c)
    th_n.join(30)
    r = nico.get("r")
    nc = [c for c in (accept(e, seen, "niconico") for e in (r if isinstance(r, list) else [])) if c]
    th.join(45)
    r = bili.get("r")
    bl = [c for c in (accept(e, seen, "bilibili") for e in (r if isinstance(r, list) else [])) if c]
    for lst in (yt, nc, bl):
        lst.sort(key=lambda c: -c["score"])
    # 三邊輪流排（YouTube → niconico → B 站），最多 5 個（每個候選要下載 10～30 秒）
    out = []
    for i in range(3):
        out += yt[i:i + 1] + nc[i:i + 1] + bl[i:i + 1]
    return out[:5]


def load_mono(path, sr=SR):
    cmd = [str(FFMPEG), "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, creationflags=NO_WINDOW).stdout
    return np.frombuffer(raw, np.float32).astype(np.float64)


def match(mix4k, inst4k):
    """比對原影片和伴奏（都是 4kHz 單聲道）。先在 1kHz 粗找每一窗的偏移，再回 4kHz 在附近細調。
    回傳 {coverage, segments:[[影片起點秒, 影片終點秒, 偏移秒]], residual, windows}；伴奏時間 = 影片時間 - 偏移。"""
    from scipy.signal import resample_poly
    m = _match(resample_poly(mix4k, 1, 4), resample_poly(inst4k, 1, 4), 1000)
    for seg in m["segments"]:
        seg[2] = refine(mix4k, inst4k, seg, SR)
    segs = m["segments"]
    for a, b in zip(segs, segs[1:]):
        if abs(a[1] - b[0]) < 0.01:
            a[1] = b[0] = cut_point(mix4k, inst4k, a[1], a[2], b[2], SR)
    if segs:  # 比對窗是 10 秒一格：頭尾各往外延伸最多 5 秒（不超過伴奏本身的範圍和影片長度）
        mix_end, inst_len = len(mix4k) / SR, len(inst4k) / SR
        segs[0][0] = round(max(0.0, segs[0][2], segs[0][0] - (WIN - HOP)), 2)
        segs[-1][1] = round(min(mix_end, inst_len + segs[-1][2], segs[-1][1] + (WIN - HOP)), 2)
        # 頭尾那幾窗只是太安靜（淡入淡出、尾奏），沒有對到別的偏移：直接延伸到影片開頭／結尾
        wins = m.get("windows") or []
        # （有聲音但沒對上的窗不算安靜，例如 MV 片頭的劇情：那段要播原聲，不能延伸）
        other = lambda w, off: w[1] is not None and not (w[2] >= MATCH_COEF and abs(w[1] - off) < 0.03)
        if not any(other(w, segs[-1][2]) for w in wins if w[0] >= segs[-1][1] - WIN):
            segs[-1][1] = round(min(mix_end, inst_len + segs[-1][2]), 2)
        if not any(other(w, segs[0][2]) for w in wins if w[0] + WIN <= segs[0][0] + WIN):
            segs[0][0] = round(max(0.0, segs[0][2]), 2)
    m["residual"] = residual(mix4k, inst4k, segs, SR)
    return m


def cut_point(mix, inst, guess, off_a, off_b, sr, step=0.25, size=1.0):
    """兩段的交界（MV 剪接點）：在估計值前後 6 秒內，每 0.25 秒比較這一小段比較像前一段還是後一段的偏移。"""
    n = int(size * sr)

    def coef(t, off):
        i0 = int(t * sr); j0 = i0 - int(round(off * sr))
        if i0 < 0 or j0 < 0 or i0 + n > len(mix) or j0 + n > len(inst):
            return -1.0
        w, x = mix[i0:i0 + n], inst[j0:j0 + n]
        return float(np.dot(w, x) / max(np.linalg.norm(w) * np.linalg.norm(x), 1e-12))
    ts = np.arange(max(0.0, guess - 6), guess + 6, step)
    diff = np.array([coef(t, off_b) - coef(t, off_a) for t in ts])
    # 交界 = 讓「之前偏 A、之後偏 B」最成立的位置
    best_t, best_s = guess, -1e9
    for i in range(1, len(ts)):
        s = -diff[:i].sum() + diff[i:].sum()
        if s > best_s:
            best_s, best_t = s, ts[i]
    return round(float(best_t), 2)


def refine(mix, inst, seg, sr, span=0.004):
    """在粗找的偏移附近 ±4 毫秒，用這段中間 10 秒逐點找相關最高的位置。"""
    a, b, off = seg
    mid = (a + b) / 2
    i0 = int(max(a, mid - WIN / 2) * sr); i1 = min(len(mix), i0 + int(WIN * sr))
    w = mix[i0:i1]
    best, best_off = -2.0, off
    for d in range(-int(span * sr), int(span * sr) + 1):
        o = off + d / sr
        j0 = i0 - int(round(o * sr))
        if j0 < 0 or j0 + len(w) > len(inst):
            continue
        x = inst[j0:j0 + len(w)]
        c = float(np.dot(w, x) / max(np.linalg.norm(w) * np.linalg.norm(x), 1e-12))
        if c > best:
            best, best_off = c, o
    return round(best_off, 4)


def residual(mix, inst, segs, sr):
    """伴奏如果其實是有人聲的原曲（標題亂標），扣掉伴奏後幾乎沒剩東西 → 殘差很小（真伴奏約 0.4，原曲約 0.2）"""
    if not segs:
        return 1.0
    a, b, off = max(segs, key=lambda s: s[1] - s[0])
    i0, i1 = int(a * sr), int(b * sr)
    j0 = i0 - int(round(off * sr))
    if j0 < 0:
        i0 -= j0; j0 = 0
    i1 = min(i1, len(mix), i0 + len(inst) - j0)
    if i1 - i0 < sr:
        return 1.0
    mm, x = mix[i0:i1], inst[j0:j0 + (i1 - i0)]
    g = float(np.dot(mm, x) / max(np.dot(x, x), 1e-12))
    return round(float(np.linalg.norm(mm - g * x) / max(np.linalg.norm(mm), 1e-12)), 3)


def _match(mix, inst, sr):
    n, L = int(WIN * sr), len(inst)
    if len(mix) < n or L < n:
        return {"coverage": 0.0, "segments": [], "residual": 1.0, "windows": []}
    N = 1 << int(np.ceil(np.log2(L + n)))
    R = np.fft.rfft(inst, N)
    e2 = np.concatenate([[0.0], np.cumsum(inst * inst)])  # 伴奏各位置的能量（正規化用）
    starts = np.arange(0, len(mix) - n + 1, int(HOP * sr))
    rms = np.array([np.sqrt(np.mean(mix[s:s + n] ** 2)) for s in starts])
    active = rms > max(1e-4, 0.25 * np.median(rms))
    wins = []
    for s, act in zip(starts, active):
        w = mix[s:s + n] - mix[s:s + n].mean()
        if not act:
            wins.append((s / sr, None, 0.0, False)); continue
        c = np.fft.irfft(R * np.conj(np.fft.rfft(w, N)), N)[:L - n + 1]
        energy = np.sqrt(np.maximum(e2[n:L + 1] - e2[:L - n + 1], 1e-12)) * np.linalg.norm(w)
        coef = c / energy
        k = int(np.argmax(coef))
        wins.append((s / sr, (s - k) / sr, float(coef[k]), True))
    # 歌曲的副歌會重複：某一窗可能剛好跟「另一次副歌」更像，偏移就跳到別處。
    # 先找出很多窗都同意的偏移（主要偏移），每一窗只要在主要偏移上也夠像（最高值的 85% 以上）就用主要偏移
    offs = [o for t, o, c, a in wins if a and c >= MATCH_COEF]
    if offs:
        groups = {}
        for o in offs:  # 0.02 秒內的算同一組；代表值用組內實際偏移的中位數（差幾毫秒相關就掉很多）
            groups.setdefault(round(o / 0.02), []).append(o)
        dominant = [float(np.median(g)) for g in sorted(groups.values(), key=len, reverse=True) if len(g) >= 3][:3]
        fixed = []
        for t, off, coef, act in wins:
            if act and dominant:
                s0 = int(round(t * sr)); w = mix[s0:s0 + n] - mix[s0:s0 + n].mean()
                best = None
                for d in dominant:
                    j0 = s0 - int(round(d * sr))
                    if 0 <= j0 and j0 + n <= L:
                        x = inst[j0:j0 + n]
                        c = float(np.dot(w, x) / max(np.linalg.norm(w) * np.linalg.norm(x), 1e-12))
                        if best is None or c > best[1]:
                            best = (d, c)
                if best and best[1] >= MATCH_COEF and best[1] >= 0.85 * coef:
                    fixed.append((t, best[0], best[1], act)); continue
            fixed.append((t, off, coef, act))
        wins = fixed
    # 連續、偏移一致（差 30 毫秒內）的對上窗組成一段
    segs = []
    for t, off, coef, act in wins:
        if not act or coef < MATCH_COEF:
            continue
        if segs and abs(segs[-1]["offs"][-1] - off) < 0.03 and t - segs[-1]["to"] <= HOP * 2 + 0.01:
            segs[-1]["to"] = t + WIN; segs[-1]["offs"].append(off)
        else:
            segs.append({"from": t, "to": t + WIN, "offs": [off]})
    segs = [s for s in segs if len(s["offs"]) >= 2]  # 只有一窗對上的多半是巧合
    matched = sum(len(s["offs"]) for s in segs)
    n_act = int(active.sum()) or 1
    out = [[round(s["from"], 2), round(s["to"], 2), round(float(np.median(s["offs"])), 4)] for s in segs]
    for a, b in zip(out, out[1:]):  # 相鄰兩段的窗會重疊 5 秒：交界放在重疊的中間
        if a[1] > b[0]:
            a[1] = b[0] = round((a[1] + b[0]) / 2, 2)
    return {"coverage": round(matched / n_act, 3), "segments": out, "residual": 1.0,
            "windows": [[round(t, 1), None if o is None else round(o, 3), round(c, 3)] for t, o, c, _ in wins]}


# ---------- 去人聲（UVR5 bs_roformer）----------
# 模型載入（import torch＋讀 ckpt＋搬上顯示卡）約 20 秒：開始做伴奏時就在背景先載，做完留在顯示卡上，
# 閒置 SEP_IDLE_S 才卸掉（連續換歌時不用每首重載；ComfyUI 等也要用顯示卡，所以不永久佔著）
SEP_IDLE_S = 10 * 60
SEP_BATCH = 2            # 一次送幾段 8 秒的音訊進模型（RTX 40 系列實測 2／4／8 都是 5 分鐘的歌約 25 秒，2 最省顯存）
_sep = {"rl": None, "dev": None, "last": 0.0, "unloader": False}
GPU = None  # listen-server 設定的 GpuWatch：其他程式要用顯示卡時，去人聲先暫停、模型卸掉
_sep_lock = threading.Lock()       # 同一時間只跑一首
_sep_load_lock = threading.Lock()  # 只載一次


def _sep_model():
    if GPU:
        GPU.check()
    with _sep_load_lock:
        if _sep["rl"] is None:
            if str(UVR_CODE) not in sys.path:
                sys.path.insert(0, str(UVR_CODE))
            import torch
            from bsroformer import Roformer_Loader
            t0 = time.time()
            dev = "cuda" if torch.cuda.is_available() else "cpu"
            rl = Roformer_Loader(model_path=str(ROFORMER), config_path=str(ROFORMER.with_suffix(".yaml")), device=dev, is_half=(dev == "cuda"))
            rl.model.eval()
            _sep["rl"], _sep["dev"] = rl, dev
            print("去人聲模型載入 %.1f 秒（%s）" % (time.time() - t0, dev), flush=True)
            if not _sep["unloader"]:
                _sep["unloader"] = True
                threading.Thread(target=_sep_unloader, daemon=True).start()
        _sep["last"] = time.time()
        return _sep["rl"], _sep["dev"]


def _sep_unloader():
    while True:
        time.sleep(30)
        if _sep["rl"] is None or time.time() - _sep["last"] < SEP_IDLE_S:
            continue
        if not _sep_lock.acquire(blocking=False):  # 正在用
            continue
        try:
            with _sep_load_lock:
                if _sep["rl"] is not None and time.time() - _sep["last"] >= SEP_IDLE_S:
                    dev = _sep["dev"]
                    _sep["rl"] = None
                    import gc
                    gc.collect()
                    if dev == "cuda":
                        import torch
                        torch.cuda.empty_cache()
                    print("去人聲模型閒置太久，已卸載", flush=True)
        finally:
            _sep_lock.release()


def unload_sep(note=""):
    """馬上卸掉去人聲模型（讓出顯示卡用）。正在去人聲的那首會在下一小段中斷（見 separate），所以最多等幾秒。"""
    with _sep_lock:
        with _sep_load_lock:
            if _sep["rl"] is None:
                return
            dev = _sep["dev"]
            _sep["rl"] = None
            import gc
            gc.collect()
            if dev == "cuda":
                import torch
                torch.cuda.empty_cache()
            print((note or "已卸載") + "：已卸載去人聲模型", flush=True)


def preload_sep():
    """背景先把去人聲模型載好（已經載好就只是更新最後使用時間）"""
    if not SEP_OK or (GPU and GPU.active()):
        return
    threading.Thread(target=lambda: _try(_sep_model), daemon=True).start()


def separate(src, out_wav, progress=None, cancelled=None, paused=None):
    """把 src 的人聲去掉，伴奏寫到 out_wav。progress(0～1) 回報進度；cancelled() 為真就中途停（丟 RuntimeError）。
    其他程式要用顯示卡時（GPU.active()）先停下來、等對方用完再從頭做；paused(名字／None) 回報暫停狀態。"""
    from gpuwatch import GpuYield
    while True:
        if GPU and GPU.active():
            if paused:
                paused(GPU.active())
            print("去人聲暫停（顯示卡讓給 %s）" % GPU.active(), flush=True)
            GPU.wait(cancelled or (lambda: False))
            if paused:
                paused(None)
            if cancelled and cancelled():
                raise RuntimeError("已取消")
        try:
            return _separate(src, out_wav, progress, cancelled)
        except GpuYield:
            continue


def _separate(src, out_wav, progress=None, cancelled=None):
    with _sep_lock:
        rl, dev = _sep_model()
        import bsroformer

        class Bar:  # 取代 bsroformer 裡的 tqdm：把進度回報給工作，順便檢查要不要取消
            def __init__(self, total=1, **kw):
                self.total, self.n = max(1, total or 1), 0

            def update(self, k=1):
                self.n += k
                if cancelled and cancelled():
                    raise RuntimeError("已取消")
                if GPU and GPU.active():
                    from gpuwatch import GpuYield
                    raise GpuYield(GPU.active())
                if progress:
                    progress(min(1.0, self.n / self.total))

            def close(self):
                pass
        old_bar = bsroformer.tqdm
        bsroformer.tqdm = Bar
        rl.config["inference"]["batch_size"] = SEP_BATCH if dev == "cuda" else 1
        work = out_wav.parent / "sep"
        try:
            shutil.rmtree(work, ignore_errors=True)
            work.mkdir(parents=True)
            # 先轉成 wav：librosa 讀不了 webm／m4a 時會去找 PATH 上的 ffmpeg，安裝版不一定找得到
            wav_in = work / "mix.wav"
            subprocess.run([str(FFMPEG), "-v", "error", "-y", "-i", str(src), "-vn", "-ac", "2", "-ar", "44100", str(wav_in)],
                           capture_output=True, creationflags=NO_WINDOW, check=True)
            try:
                rl._path_audio_(str(wav_in), str(work / "inst"), str(work / "voc"), "wav")
            except Exception as e:  # 顯示卡記憶體不夠（小顯卡、或同時開著別的 AI）：一次一段再試
                if "out of memory" not in str(e).lower() or rl.config["inference"]["batch_size"] <= 1:
                    raise
                import torch
                torch.cuda.empty_cache()
                print("去人聲顯存不夠，改成一次一段再試", flush=True)
                rl.config["inference"]["batch_size"] = 1
                rl._path_audio_(str(wav_in), str(work / "inst"), str(work / "voc"), "wav")
            inst = next((work / "inst").iterdir(), None)
            if inst is None:
                raise RuntimeError("AI 去人聲沒有產生結果（讀不了音檔）")
            shutil.move(str(inst), str(out_wav))
        finally:
            bsroformer.tqdm = old_bar
            shutil.rmtree(work, ignore_errors=True)
            _sep["last"] = time.time()
            if dev == "cuda":
                import torch
                torch.cuda.empty_cache()  # 中間結果的暫存放掉，模型留著


def encode(src, dst):
    cmd = [str(FFMPEG), "-v", "error", "-y", "-i", str(src), "-vn", "-c:a", "libopus", "-b:a", "160k", str(dst)]
    subprocess.run(cmd, capture_output=True, creationflags=NO_WINDOW, check=True)


def prune():
    metas = sorted(KCACHE.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for m in metas[KEEP_SONGS:]:
        vid = m.stem
        for f in KCACHE.glob(vid + ".*"):
            f.unlink(missing_ok=True)


# ---------- 工作 ----------
def _try(fn):
    try:
        return fn()
    except Exception as e:
        return e


KJOBS = {}
KJOBS_LOCK = threading.Lock()


def clean_stale_tmp(age=600):
    """取消、失敗的工作留下的暫存（當時還有程序開著檔案刪不掉）：超過 10 分鐘的刪掉"""
    if not KTMP.exists():
        return
    now = time.time()
    for d in KTMP.iterdir():
        try:
            if now - d.stat().st_mtime > age:
                shutil.rmtree(d, ignore_errors=True) if d.is_dir() else d.unlink(missing_ok=True)
        except OSError:
            pass


# 先下載：音樂影片一打開，擴充功能就叫服務先下載原影片音訊、載入去人聲模型（POST /kara/prep），
# 不用等歌詞來源選好（最多 8 秒）才開始。之後真的開始做伴奏時，直接拿這份音訊。一次只先下載一首，換歌就停掉舊的。
PRE = {"vid": None, "dir": None, "file": None, "err": None, "cancel": False, "thread": None, "owner": None}
PRE_LOCK = threading.Lock()


def _pre_dl(st):
    cancelled = lambda: st["cancel"] or (st["owner"] is not None and st["owner"].stopped())
    with busy():  # 跟正式工作一樣用標準優先權（服務平常是低優先權，yt-dlp 會跟著變慢）
        r = _try(lambda: download_audio(st["vid"], st["dir"], "mv", cancelled))
    if isinstance(r, Exception):
        st["err"] = r
        shutil.rmtree(st["dir"], ignore_errors=True)
    else:
        st["file"] = r


def kara_prep(vid):
    global PRE
    if not valid_vid(vid):
        return {"ok": False, "error": "影片 ID 不對"}
    meta = read_json(KCACHE / (vid + ".json"))
    if meta and meta.get("file") and (KCACHE / Path(meta["file"]).name).exists():
        return {"ok": True, "state": "cached"}
    with KJOBS_LOCK:
        j = KJOBS.get(vid)
        if j and j.state not in ("done", "error") and not j.cancel:
            return {"ok": True, "state": "running"}
    with PRE_LOCK:
        if PRE["vid"] == vid and PRE["err"] is None and not PRE["cancel"]:
            return {"ok": True, "state": "prefetching" if PRE["file"] is None else "ready"}
        old = PRE["dir"]
        if PRE["owner"] is None:  # 換歌了：停掉上一首的先下載（已經被伴奏工作接手的不停，由那個工作決定）
            PRE["cancel"] = True
            if old:
                threading.Thread(target=lambda: (time.sleep(3), shutil.rmtree(old, ignore_errors=True)), daemon=True).start()
        st = {"vid": vid, "dir": KTMP / ("pre-%s-%d" % (vid, int(time.time() * 1000))), "file": None, "err": None,
              "cancel": False, "thread": None, "owner": None}
        st["thread"] = threading.Thread(target=_pre_dl, args=(st,), daemon=True)
        PRE = st
        st["thread"].start()
    def load():
        with busy():
            _try(_sep_model)
    if SEP_OK:  # 去人聲模型也先載（第一次 7～12 秒；閒置 10 分鐘會自己卸載）
        threading.Thread(target=load, daemon=True).start()
    return {"ok": True, "state": "prefetching"}


def take_prefetched(vid, job, work):
    """KaraJob 用：同一首已經在先下載就等它（不重新下載），拿到檔案搬進工作資料夾；沒有或失敗回 None"""
    with PRE_LOCK:
        st = PRE
        if st["vid"] != vid or st["cancel"] or st["err"] is not None:
            return None
        st["owner"] = job
    t0 = time.time()
    while st["thread"].is_alive():
        st["thread"].join(0.3)
        if job.cancel:
            raise RuntimeError("已取消")
    f = st["file"]
    if not f or not f.exists():
        return None
    dst = work / f.name
    try:
        shutil.move(str(f), str(dst))
    except OSError:
        return None
    shutil.rmtree(st["dir"], ignore_errors=True)
    with PRE_LOCK:
        if PRE is st:
            PRE["vid"] = None
    print("伴奏用先下載好的音訊", vid, "（多等 %.1f 秒）" % (time.time() - t0), flush=True)
    return dst


class KaraJob:
    def __init__(self, vid, queries, song_len, mode, song="", artist=""):
        self.vid, self.queries, self.song_len = vid, [str(q) for q in (queries or []) if str(q).strip()][:3], float(song_len or 0)
        self.song, self.artist = str(song or "")[:100], str(artist or "")[:100]
        self.mode = mode if mode in ("auto", "source", "ai") else "auto"
        self.state, self.detail, self.error, self.result = "starting", "", "", None
        self.cancel = False
        self.sep_pct, self.sep_stop, self.finished = None, False, False
        self.gpu_wait = None  # 顯示卡讓給別的程式中（對方名字）

    def stopped(self):  # 下載用：取消、或工作已經結束（用了官方伴奏／失敗）就停掉還在跑的 yt-dlp
        return self.cancel or self.finished

    def status(self):
        d = self.detail
        if self.gpu_wait:
            d = "AI 去人聲暫停：顯示卡讓給 %s 中，它用完會自動繼續" % self.gpu_wait
        elif self.sep_pct is not None and self.state in ("downloading", "matching"):
            d += "（同時 AI 去人聲 %d%%）" % int(self.sep_pct * 100)
        return {"ok": True, "state": self.state, "detail": d, "error": self.error, "result": self.result, "gpuYield": self.gpu_wait}

    def _sep_progress(self, p):
        self.sep_pct = p
        if self.state == "separating":
            self.detail = "AI 去人聲中 %d%%" % int(p * 100)

    def step(self, state, detail=""):
        if self.cancel:
            raise RuntimeError("已取消")
        self.state, self.detail = state, detail

    def wait(self, th):
        while th.is_alive():
            th.join(0.3)
            if self.cancel:
                raise RuntimeError("已取消")

    def run(self):
        with busy():  # 有工作時用標準優先權（見 paths.busy）
            self._run()

    def _run(self):
        # 每個工作自己的暫存資料夾：同一首按「重新找伴奏」時，舊工作的下載還沒停完也不會跟新工作搶同一個檔
        work = KTMP / ("%s-%d" % (self.vid, int(time.time() * 1000)))
        try:
            clean_stale_tmp()
            work.mkdir(parents=True, exist_ok=True)
            # 全部能同時做的都同時做：原影片音訊下載、搜尋官方伴奏、載入去人聲模型 →
            # 伴奏候選一起下載（最多 3 個同時）、原影片一下載好就開始 AI 去人聲，同時比對候選。
            # 有候選對上就用官方伴奏（停掉 AI）；都對不上時 AI 版通常已經好了或快好了。
            if self.mode == "ai" and not SEP_OK:
                raise RuntimeError(NO_SEP_MSG)
            use_ai = self.mode in ("auto", "ai") and SEP_OK  # 沒裝去人聲：只找官方伴奏
            if use_ai:
                preload_sep()
            self.step("downloading", "下載原影片音訊、搜尋官方伴奏")
            got = {}
            bg = lambda key, fn: threading.Thread(target=lambda: got.__setitem__(key, _try(fn)), daemon=True)
            # 打開影片時已經先下載（kara_prep）的就直接用；沒有、失敗才自己下載
            t_mv = bg("mv", lambda: take_prefetched(self.vid, self, work) or download_audio(self.vid, work, "mv", self.stopped)); t_mv.start()
            sem = threading.Semaphore(3)

            def dl(i, c):
                with sem:
                    if self.stopped() or self.sep_stop:
                        raise RuntimeError("略過")
                    return download_audio(c["id"], work, "c%d" % i, lambda: self.stopped() or self.sep_stop)
            cands, t_c = [], []

            def find_and_dl():  # 搜到候選就馬上開始下載，不等原影片音訊
                cs = find_candidates(self.queries, self.song_len, self.vid, self.song, self.artist)
                cs = [c for c in cs if not (c.get("site") == "bilibili" and bili_blocked())]
                for i, c in enumerate(cs):
                    t = bg("c%d" % i, lambda i=i, c=c: dl(i, c)); t.start(); t_c.append(t)
                cands.extend(cs)
            t_find = None
            if self.mode in ("auto", "source") and (self.queries or self.song):
                t_find = bg("find", find_and_dl); t_find.start()
            self.wait(t_mv)
            mv = got["mv"]
            if isinstance(mv, Exception):
                raise mv
            wav = work / "inst.wav"
            t_sep = None
            if use_ai:  # 原影片一下載好就開始去人聲（搜尋、候選下載還在跑也沒關係）
                t_sep = bg("sep", lambda: separate(mv, wav, self._sep_progress, lambda: self.cancel or self.sep_stop,
                                                    lambda r: setattr(self, "gpu_wait", r)))
                t_sep.start()
            if t_find:
                self.step("downloading", "搜尋官方伴奏")
                self.wait(t_find)
                if isinstance(got.get("find"), Exception):
                    print("伴奏搜尋失敗", self.vid, got["find"], flush=True)
            sep_ready_at = [None]

            def sep_ready():  # AI 版做好了：還沒下載完的候選最多再等 15 秒（官方伴奏音質比較好，但不值得讓人一直等）
                if t_sep is None or t_sep.is_alive() or isinstance(got.get("sep"), Exception):
                    return False
                sep_ready_at[0] = sep_ready_at[0] or time.time()
                return time.time() - sep_ready_at[0] > 15
            result = None
            if cands:
                mix = load_mono(mv)
                for i, c in enumerate(cands):
                    if c.get("site") == "bilibili" and bili_blocked():
                        continue
                    self.step("matching", "比對伴奏 %d/%d：%s" % (i + 1, len(cands), c["title"][:60]))
                    while t_c[i].is_alive() and not sep_ready():
                        t_c[i].join(0.3)
                        if self.cancel:
                            raise RuntimeError("已取消")
                    if t_c[i].is_alive():
                        print("伴奏 AI 版已經好了，不再等其餘候選下載", self.vid, flush=True)
                        break
                    f = got.get("c%d" % i)
                    if isinstance(f, Exception):
                        print("伴奏下載失敗", c["id"], f, flush=True)
                        if c.get("site") == "bilibili" and re.search(r"HTTP Error (412|403|567)", str(f)):
                            block_bili("下載被擋：" + str(f)[-60:])
                        continue
                    m = match(mix, load_mono(f))
                    print("伴奏比對", self.vid, c["id"], c["title"], "覆蓋", m["coverage"], "殘差", m["residual"], m["segments"], flush=True)
                    if m["coverage"] >= MIN_COVER and m["residual"] > 0.3:
                        # 每次用新的檔名（不覆蓋舊伴奏）：先寫好新檔和紀錄，再刪舊的。以前直接蓋掉舊檔，
                        # 中途失敗（磁碟滿、服務重開）時紀錄還指著被蓋了一半的檔案，壞掉的伴奏會一直被當成快取
                        dst = KCACHE / ("%s.s%d%s" % (self.vid, int(time.time()), f.suffix))
                        KCACHE.mkdir(parents=True, exist_ok=True)
                        shutil.move(str(f), str(dst))
                        result = {"kind": "source", "file": dst.name, "sourceId": c["id"], "title": c["title"], "site": c.get("site", "youtube"),
                                  "channel": c["channel"], "coverage": m["coverage"], "segments": m["segments"]}
                        break
            if result is None:
                if self.mode == "source":
                    raise RuntimeError("找不到能對上這部影片的官方伴奏")
                if not use_ai:
                    raise RuntimeError("找不到能對上這部影片的官方伴奏（" + NO_SEP_MSG + "）")
                self.step("separating", "AI 去人聲中 %d%%" % int(self.sep_pct * 100) if self.sep_pct is not None else "AI 去人聲中（載入模型）")
                self.wait(t_sep)
                if isinstance(got.get("sep"), Exception):
                    raise got["sep"]
                self.step("encoding", "壓縮伴奏")
                KCACHE.mkdir(parents=True, exist_ok=True)
                dst = KCACHE / ("%s.a%d.webm" % (self.vid, int(time.time())))
                encode(wav, dst)
                dur = len(load_mono(dst, 1000)) / 1000.0
                result = {"kind": "ai", "file": dst.name, "title": "", "coverage": 1.0, "segments": [[0.0, round(dur, 2), 0.0]]}
            result["t"] = int(time.time())
            write_json_atomic(KCACHE / (self.vid + ".json"), result)
            # 紀錄寫好之後才刪舊伴奏（副檔名可能不同，例如 AI 版 .webm → B 站 .m4a）和它的變調版；
            # 正在被讀（播放中的分段請求、變調中）刪不掉的，服務下次啟動時清
            for old in KCACHE.glob(self.vid + ".*"):
                if old.name != result["file"] and old.suffix != ".json":
                    try:
                        old.unlink(missing_ok=True)
                    except OSError as e:
                        print("舊伴奏暫時刪不掉，下次啟動再清：", old.name, e, flush=True)
            prune()
            self.result, self.state, self.detail = result, "done", ""
        except Exception as e:
            self.state, self.error = "error", str(e)
            print("伴奏失敗", self.vid, e, flush=True)
        finally:
            self.sep_stop = self.finished = True  # 用了官方伴奏、或失敗：還在跑的 AI 去人聲、下載都停掉
            shutil.rmtree(work, ignore_errors=True)  # 還有程序開著檔案刪不掉的，下一個工作開始時再清


def kara_start(vid, queries, song_len, mode="auto", force=False, song="", artist=""):
    with KJOBS_LOCK:
        # 這首正在重做（按了「重新找伴奏」「改用 AI 去人聲」）時，別的分頁、重新整理來問：給它正在做的工作，
        # 不要拿舊快取把它從清單裡換掉（換掉後之後就取消不到，兩個工作會同時下載、去人聲）
        j = KJOBS.get(vid)
        if j and j.state not in ("done", "error") and not j.cancel and not force:
            return j
        meta = KCACHE / (vid + ".json")
        res = read_json(meta) if meta.exists() and not force else None
        if res and res.get("file"):
            if (KCACHE / Path(res["file"]).name).exists() and (mode == "auto" or res.get("kind") == mode):
                j = KaraJob(vid, [], 0, mode); j.state, j.result = "done", res
                KJOBS[vid] = j
                os.utime(meta)  # 最近用過的不會被清掉
                return j
        j = KJOBS.get(vid)
        if j and j.state not in ("done", "error") and not j.cancel and not force:
            return j
        for other in KJOBS.values():  # 一次只做一首
            if other.state not in ("done", "error"):
                other.cancel = True
        j = KaraJob(vid, queries, song_len, mode, song, artist)
        KJOBS[vid] = j
        threading.Thread(target=j.run, daemon=True).start()
        return j


def kara_status(vid):
    j = KJOBS.get(vid)
    if j:
        return j.status()
    # 服務重開過（工作清單是空的）：做好的伴奏還在快取裡就直接回報做好了；不然回 none，擴充功能會重新開始
    res = read_json(KCACHE / (vid + ".json")) if valid_vid(vid) else None
    if res and res.get("file") and (KCACHE / Path(res["file"]).name).exists():
        return {"ok": True, "state": "done", "detail": "", "error": "", "result": res}
    return {"ok": True, "state": "none"}


def kara_file(vid, key=0):
    if not valid_vid(vid):
        return None
    meta = KCACHE / (vid + ".json")
    res = read_json(meta) if meta.exists() else None
    if not res or not res.get("file"):
        return None
    f = KCACHE / Path(res["file"]).name
    if f.exists() and key:
        k = KCACHE / ("%s.k%+d.webm" % (vid, key))
        return k if k.exists() else None
    return f if f.exists() else None


# ---------- 升降 Key ----------
# 伴奏變調（不變速）：ffmpeg 的 rubberband，切成很多段同時做，4 分鐘的歌約 2～3 秒。做好的存成 <影片ID>.k+2.webm，下次直接用。
# 使用者調過 Key 之後，背景（低優先權）先把 ±1 也做好，下一次按 ♯／♭ 幾乎馬上換好。
SHIFT_PARTS = 12  # 最多切幾段同時做（rubberband 一段只用一個 CPU 核心；另外不超過 CPU 執行緒數的一半）
MAX_KEY = 12
KEEP_KEYS = 6     # 每首歌最多留幾個變調版（最近用過的優先留）
BELOW_NORMAL = 0x00004000
_key_jobs = {}    # 做到一半的變調檔名 → threading.Event（同一個檔不會同時做兩次，後來的等前面的做完）
_key_jobs_lock = threading.Lock()
_prefetch = {"vid": None, "keys": []}
_prefetch_lock = threading.Lock()


def _ff(cmd, low=False):
    r = subprocess.run([str(FFMPEG), "-v", "error", "-y"] + cmd, capture_output=True,
                       creationflags=NO_WINDOW | (BELOW_NORMAL if low else 0))
    if r.returncode:
        raise RuntimeError("變調失敗：" + r.stderr.decode("utf-8", "replace").strip()[-200:])


def probe_seconds(path):
    """從檔頭讀長度（不用整首解碼）"""
    err = subprocess.run([str(FFMPEG), "-hide_banner", "-i", str(path)], capture_output=True, creationflags=NO_WINDOW).stderr
    m = re.search(rb"Duration:\s*(\d+):(\d+):([\d.]+)", err)
    if m:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    return len(load_mono(path, 1000)) / 1000.0


def _shift(src, dst, ratio, work, pad=1.0, xf=0.1, max_parts=None, low=False):
    """切成幾段同時做，每段前後多做 1 秒（避開段頭的暖身），剪掉多的部分後用 0.1 秒交叉淡化接回去，總長度、時間點都不變。"""
    work.mkdir(parents=True, exist_ok=True)
    dur = probe_seconds(src)
    n = max(1, min(max_parts or SHIFT_PARTS, (os.cpu_count() or 2) // 2 or 1, int(dur // 15)))
    # 變調會讓波形的尖峰變高：原本就做得很大聲的伴奏（例如 −0.2 dB）變調後會衝過上限，播放時被硬切成「炸麥」的爆音。
    # 後面接限幅器壓在 −1 dB（latency=1：補回限幅器預讀造成的延遲，時間點不變）
    af = "rubberband=pitch=%.6f:pitchq=quality,alimiter=limit=0.891:attack=5:release=50:level=disabled:latency=1" % ratio
    enc = ["-c:a", "libopus", "-b:a", "160k", "-compression_level", "5"]  # 壓縮快一點（聽不出差別）
    if n == 1:
        return _ff(["-i", str(src), "-vn", "-af", af] + enc + [str(dst)], low)
    bounds = [dur * i / n for i in range(n + 1)]
    parts = [work / ("p%d.wav" % i) for i in range(n)]

    def job(i):
        a, b = bounds[i], bounds[i + 1]
        s0 = max(0.0, a - pad)
        lo = a - s0 - (xf / 2 if i > 0 else 0)
        hi = b - s0 + (xf / 2 if i < n - 1 else 0)
        _ff(["-ss", "%.4f" % s0, "-t", "%.4f" % (b + pad - s0), "-i", str(src), "-vn",
             "-af", af + ",atrim=start=%.4f:end=%.4f,asetpts=PTS-STARTPTS" % (lo, hi), "-c:a", "pcm_f32le", str(parts[i])], low)
    res = [None] * n
    ths = [threading.Thread(target=lambda i=i: res.__setitem__(i, _try(lambda: job(i)))) for i in range(n)]
    for t in ths:
        t.start()
    for t in ths:
        t.join()
    for r in res:
        if isinstance(r, Exception):
            raise r
    chain, last = [], "[0:a]"
    for i in range(1, n):
        out = "[x%d]" % i
        chain.append("%s[%d:a]acrossfade=d=%s:c1=tri:c2=tri%s" % (last, i, xf, out))
        last = out
    cmd = []
    for f in parts:
        cmd += ["-i", str(f)]
    _ff(cmd + ["-filter_complex", ";".join(chain), "-map", last] + enc + [str(dst)], low)


def _key_path(vid, key):
    return KCACHE / ("%s.k%+d.webm" % (vid, key))


def _trim_keys(vid, keep):
    """每首歌最多留 KEEP_KEYS 個變調版：刪最久沒用的（keep 這個不刪）"""
    ks = sorted((f for f in KCACHE.glob(vid + ".k*.webm") if ".part." not in f.name), key=lambda f: f.stat().st_mtime, reverse=True)
    for f in ks[KEEP_KEYS:]:
        if f.name != keep.name:
            f.unlink(missing_ok=True)


def _build_key(vid, key, src, low=False):
    dst = _key_path(vid, key)
    with _key_jobs_lock:
        if dst.exists():
            os.utime(dst)  # 最近用過，不會先被清掉
            return dst
        ev = _key_jobs.get(dst.name)
        mine = ev is None
        if mine:
            ev = _key_jobs[dst.name] = threading.Event()
    if not mine:  # 背景已經在做這個 Key：等它做完就好
        ev.wait(180)
        if dst.exists():
            return dst
        raise RuntimeError("變調失敗")
    t0 = time.time()
    tmp = dst.with_name(dst.stem + ".part.webm")
    work = KTMP / ("key-%s%+d" % (vid, key))
    try:
        _shift(src, tmp, 2 ** (key / 12.0), work, low=low)
        tmp.replace(dst)
        print("伴奏變調", vid, "%+d" % key, "（背景預做）" if low else "", "%.1f 秒" % (time.time() - t0), flush=True)
        _trim_keys(vid, dst)
        return dst
    finally:
        tmp.unlink(missing_ok=True)
        shutil.rmtree(work, ignore_errors=True)
        with _key_jobs_lock:
            _key_jobs.pop(dst.name, None)
        ev.set()


def _prefetch_worker():
    while True:
        with _prefetch_lock:
            if not _prefetch["keys"]:
                _prefetch["running"] = False
                return
            vid, key = _prefetch["vid"], _prefetch["keys"].pop(0)
        src = kara_file(vid)
        if src and not _key_path(vid, key).exists():
            r = _try(lambda: _build_key(vid, key, src, low=True))
            if isinstance(r, Exception):
                print("背景預做變調失敗", vid, key, r, flush=True)


def _queue_prefetch(vid, key):
    """背景先做 key±1（0 就是原調，不用做）。換了別首歌或 Key，排隊中的舊工作直接換掉"""
    want = [k for k in (key + 1, key - 1) if k and -MAX_KEY <= k <= MAX_KEY and not _key_path(vid, k).exists()]
    with _prefetch_lock:
        _prefetch["vid"], _prefetch["keys"] = vid, want
        if want and not _prefetch.get("running"):
            _prefetch["running"] = True
            threading.Thread(target=_prefetch_worker, daemon=True).start()


def kara_key(vid, key):
    key = int(key)
    if not -MAX_KEY <= key <= MAX_KEY:
        raise ValueError("Key 只能在 ±%d 之間" % MAX_KEY)
    src = kara_file(vid)
    if not src:
        raise RuntimeError("這部影片還沒有伴奏")
    if key:
        with busy():  # 使用者在等的變調用標準優先權（背景預做的維持低優先權）
            _build_key(vid, key, src)
    _queue_prefetch(vid, key)
    return {"ok": True, "key": key}


if __name__ == "__main__":
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8", errors="replace")
    if sys.argv[1] == "--match":
        t0 = time.time()
        m = match(load_mono(sys.argv[2]), load_mono(sys.argv[3]))
        m["sec"] = round(time.time() - t0, 2)
        print(json.dumps({k: v for k, v in m.items() if k != "windows"}, ensure_ascii=False))
        print("窗：", m["windows"])
    else:
        vid, title, author = sys.argv[1], sys.argv[2], sys.argv[3]
        j = KaraJob(vid, [], float(sys.argv[4]) if len(sys.argv) > 4 else 0, sys.argv[5] if len(sys.argv) > 5 else "auto", title, author)
        t0 = time.time()
        th = threading.Thread(target=j.run); th.start()
        last = None
        while th.is_alive():
            st = (j.state, j.detail)
            if st != last:
                print("%5.1fs %s %s" % (time.time() - t0, *st), flush=True); last = st
            time.sleep(0.2)
        print("%5.1fs" % (time.time() - t0), json.dumps(j.status(), ensure_ascii=False))
