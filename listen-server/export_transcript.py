# 把 AI 聽寫做完的直播回放逐字稿（cache/<影片ID>.json）匯出成 .txt（做筆記、拿去給其他工具用）。
# 只用標準函式庫：任何 Python 3.9+ 都能跑。
# 用法：雙擊「匯出逐字稿.cmd」照提示選；或
#   python export_transcript.py --list
#   python export_transcript.py <影片ID或網址> [--range 10-25] [--no-open]
import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
CACHE = HERE / "cache"
OUT = APP / "transcripts"
TITLES = OUT / "titles.json"  # 查過的標題存在這裡，不寫進服務的 cache 資料夾
VID_RE = re.compile(r"(?:[?&]v=|youtu\.be/|/live/|/shorts/)([\w-]{11})")
LONG_CHARS = 30000  # 超過就建議只匯出一段：幾小時的雜談整份很難用


def clock(seconds):
    total = int(seconds)
    h, rest = divmod(total, 3600)
    m, s = divmod(rest, 60)
    return "{:d}:{:02d}:{:02d}".format(h, m, s) if h else "{:02d}:{:02d}".format(m, s)


def parse_time(text):
    """'25' = 第 25 分鐘；'12:30' = 12 分 30 秒；'1:02:00' = 1 小時 2 分"""
    text = text.strip()
    if not text:
        return None
    parts = [float(p) for p in text.split(":")]
    if len(parts) == 1:
        return parts[0] * 60
    secs = 0.0
    for p in parts:
        secs = secs * 60 + p
    return secs


def parse_range(text):
    if not text or not text.strip():
        return None, None
    m = re.fullmatch(r"\s*([\d:.]*)\s*[-~～－]\s*([\d:.]*)\s*", text)
    if not m:
        raise ValueError("範圍要寫成「開始-結束」，例如 10-25 或 1:02:00-1:15:00")
    a, b = parse_time(m.group(1)), parse_time(m.group(2))
    if a is not None and b is not None and b <= a:
        raise ValueError("結束時間要比開始時間晚")
    return a, b


def video_id(text):
    text = text.strip()
    if re.fullmatch(r"[\w-]{11}", text):
        return text
    m = VID_RE.search(text)
    return m.group(1) if m else None


def load_entries():
    entries = []
    for f in CACHE.glob("*.json"):
        if f.name.endswith(".song.json") or not re.fullmatch(r"[\w-]{11}", f.stem):
            continue  # 歌曲聽寫不是對話，跳過
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        segs = d.get("segments") if isinstance(d, dict) else None
        if not segs:
            continue
        entries.append({"vid": f.stem, "mtime": f.stat().st_mtime, "duration": d.get("duration") or 0,
                        "segments": segs})
    entries.sort(key=lambda e: e["mtime"], reverse=True)
    return entries


def load_titles():
    try:
        return json.loads(TITLES.read_text(encoding="utf-8"))
    except Exception:
        return {}


def fetch_title(vid):
    url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(
        "https://www.youtube.com/watch?v=" + vid, safe="")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=6) as r:
            d = json.loads(r.read().decode("utf-8"))
        return {"title": d.get("title") or vid, "author": d.get("author_name") or ""}
    except Exception:
        return None  # 會員限定、私人影片、沒網路：用影片 ID 代替，下次再查


def fill_titles(entries, titles):
    missing = [e["vid"] for e in entries if e["vid"] not in titles]
    if missing:
        with ThreadPoolExecutor(8) as pool:
            for vid, info in zip(missing, pool.map(fetch_title, missing)):
                if info:
                    titles[vid] = info
        OUT.mkdir(exist_ok=True)
        TITLES.write_text(json.dumps(titles, ensure_ascii=False, indent=1), encoding="utf-8")
    for e in entries:
        info = titles.get(e["vid"]) or {"title": e["vid"], "author": ""}
        e["title"], e["author"] = info["title"], info["author"]


def safe_name(text, limit=60):
    text = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", text).strip(" ._")
    return text[:limit] or "untitled"


def export(entry, a=None, b=None):
    a_ms = 0 if a is None else a * 1000
    b_ms = float("inf") if b is None else b * 1000
    segs = [s for s in entry["segments"] if a_ms <= s["start"] < b_ms and str(s.get("text", "")).strip()]
    if not segs:
        raise ValueError("這個範圍內沒有聽寫到任何句子")
    start_s = segs[0]["start"] / 1000
    end_s = (b if b is not None else max(s["end"] for s in segs) / 1000)
    head = [
        "# 影片：" + entry["title"],
        "# 頻道：" + (entry["author"] or "（未知）"),
        "# 網址：https://www.youtube.com/watch?v={}&t={}s".format(entry["vid"], int(start_s)),
        "# 範圍：{}–{}（本機 AI 聽寫的日文逐字稿，可能有錯字，人名和梗尤其容易錯）".format(
            clock(a or 0), clock(end_s)),
        "",
    ]
    body = ["[{}] {}".format(clock(s["start"] / 1000), str(s["text"]).strip()) for s in segs]
    text = "\n".join(head + body) + "\n"

    part = "" if a is None and b is None else " ({}-{})".format(
        clock(a or 0).replace(":", "."), clock(end_s).replace(":", "."))
    OUT.mkdir(exist_ok=True)
    path = OUT / "{} [{}]{}.txt".format(safe_name(entry["title"]), entry["vid"], part)
    path.write_text(text, encoding="utf-8")
    return path, len(body), len(text)


def print_list(entries):
    if not entries:
        print("還沒有任何完整的 AI 聽寫逐字稿。")
        print("先在 Edge 播放直播回放，等擴充面板顯示 AI 聽寫完成後再來匯出。")
        return
    print("AI 聽寫完成的影片（新的在前）：\n")
    for i, e in enumerate(entries, 1):
        when = datetime.fromtimestamp(e["mtime"]).strftime("%m/%d %H:%M")
        who = "  ／ " + e["author"] if e["author"] else ""
        print("{:>3}. {}{}".format(i, e["title"], who))
        print("     長度 {}，{} 句，聽寫於 {}".format(clock(e["duration"]), len(e["segments"]), when))


def report(path, lines, chars):
    print("\n已匯出 {} 句（{} 字）：".format(lines, chars))
    print(path)
    if chars > LONG_CHARS:
        print("\n內容很長。建議只匯出 5～15 分鐘的範圍，比較好用。")


def pick(entries, answer):
    answer = answer.strip()
    if answer.isdigit() and 1 <= int(answer) <= len(entries):
        return entries[int(answer) - 1]
    vid = video_id(answer)
    if vid:
        for e in entries:
            if e["vid"] == vid:
                return e
        raise ValueError("這部影片還沒有完整的 AI 聽寫逐字稿：先在 Edge 播放它，等 AI 聽寫跑完再匯出。")
    raise ValueError("看不懂這個輸入：請輸入清單上的編號，或貼上 YouTube 網址")


def interactive(entries, open_folder):
    print_list(entries)
    if not entries:
        return 1
    try:
        entry = pick(entries, input("\n輸入編號（或貼上影片網址）："))
        print("\n" + entry["title"] + "（長度 " + clock(entry["duration"]) + "）")
        a, b = parse_range(input("要匯出的範圍，例如 10-25 表示第 10～25 分鐘（直接按 Enter = 全部）："))
        path, lines, chars = export(entry, a, b)
    except (ValueError, EOFError) as err:
        print("\n" + (str(err) or "已取消"))
        return 1
    report(path, lines, chars)
    if open_folder:
        os.system('explorer /select,"{}"'.format(path))
    return 0


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="匯出 AI 聽寫逐字稿")
    ap.add_argument("video", nargs="?", help="影片 ID 或網址；省略時互動選擇")
    ap.add_argument("--range", default="", help="例如 10-25（分鐘）或 1:02:00-1:15:00")
    ap.add_argument("--list", action="store_true", help="只列出有逐字稿的影片")
    ap.add_argument("--no-open", action="store_true", help="匯出後不開資料夾")
    args = ap.parse_args()

    entries = load_entries()
    fill_titles(entries, load_titles())
    if args.list:
        print_list(entries)
        return 0
    if not args.video:
        return interactive(entries, not args.no_open)
    try:
        entry = pick(entries, args.video)
        a, b = parse_range(args.range)
        path, lines, chars = export(entry, a, b)
    except ValueError as err:
        print(err)
        return 1
    report(path, lines, chars)
    if not args.no_open:
        os.system('explorer /select,"{}"'.format(path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
