# 產生「繁體（台灣）→ 簡體（大陸用語）」轉換表：lib/zhcn.json（安裝程式、打包用）＋ lib/zhcn.js（擴充功能用）
# 用法：<有裝 opencc 套件的 python> tools/make-zhcn.py
# 跟 OpenCC 的 tw2sp 一樣分兩輪：① 台灣用語 → 大陸用語（TWPhrasesRev、TWVariantsRevPhrases、TWVariantsRev）
#                                  ② 繁 → 簡（TSPhrases、TSCharacters）；每輪都是從左到右、最長的詞優先。
# 介面用語另外指定（OVERRIDE，最優先）。產生後會拿專案裡所有中文字串跟 OpenCC 原版比對，不一樣的列出來。
import json
import re
import sys
from pathlib import Path

import opencc

ROOT = Path(__file__).resolve().parent.parent
DICT = Path(opencc.__file__).parent / "dictionary"

# 介面用語：OpenCC 的轉法不像軟體介面（預設→缺省、介面→接口、擴充功能→扩充功能）
OVERRIDE = {
    "擴充功能": "扩展",
    "預設": "默认",
    "介面": "界面",
    "訊息": "信息",
    "影片": "视频",
    "已連線": "已连接",
    "連線": "连接",
    "筆電": "笔记本",
    "網址列": "地址栏",
    "工具列": "工具栏",
    "分頁": "标签页",
    "複製": "复制",
    "帳號": "账号",
    "紀錄": "记录",
    "剪貼簿": "剪贴板",
    # OpenCC 的台灣用語表把「文字」對到「文本」，「日文字幕」會被切成「日文本幕」：用比較長的詞先擋住
    "文字幕": "文字幕",
    "文字體": "文字体",
    "文字串": "文字串",
}


def load(name):
    out = {}
    for line in (DICT / name).read_text(encoding="utf-8").splitlines():
        if "\t" not in line:
            continue
        k, v = line.split("\t", 1)
        out.setdefault(k, v.split(" ")[0])
    return out


def build():
    r1 = {}
    for n in ("TWVariantsRev.txt", "TWVariantsRevPhrases.txt", "TWPhrasesRev.txt"):
        r1.update(load(n))
    r2 = {}
    for n in ("TSCharacters.txt", "TSPhrases.txt"):
        r2.update(load(n))
    # 介面用語跟台灣用語放同一輪、而且優先：分開兩輪的話，第一輪留下的「文字幕」第二輪又會被切成「文本幕」
    r1.update(OVERRIDE)
    return [r1, r2]


# 檔名不轉：說明裡的「安裝.cmd」變成「安装.cmd」的話，照著找會找不到檔案（lib/zhcn.js、lib/zhcn.ps1、build-package.py 同一條規則）
FILE_RE = r"(「[^」\n]*\.(?:cmd|txt|ps1|log)」|[^\s「」（）()，。、：:；;]+\.(?:cmd|txt|ps1|log)\b)"


def convert(s, rounds):
    """跟 lib/zhcn.js 一樣的演算法：每輪從左到右，最長的詞優先；\\uE000…\\uE001 之間的、檔名不轉（並拿掉標記）。"""
    out = []
    for seg in re.split(r"([^]*)", s):
        if seg.startswith(""):
            out.append(seg[1:-1])
            continue
        parts = re.split(FILE_RE, seg)
        out.append("".join(p if i % 2 else convert_plain(p, rounds) for i, p in enumerate(parts)))
    return "".join(out)


def convert_plain(seg, rounds):
    for table in rounds:
            maxlen = max(map(len, table)) if table else 1
            res, i = [], 0
            while i < len(seg):
                for L in range(min(maxlen, len(seg) - i), 0, -1):
                    v = table.get(seg[i:i + L])
                    if v is not None:
                        res.append(v)
                        i += L
                        break
                else:
                    res.append(seg[i])
                    i += 1
            seg = "".join(res)
    return seg


def ui_strings():
    """專案裡所有含中文、不含假名的字串（拿來比對；註解也算，越多越好）"""
    han, kana = re.compile(r"[一-鿿]"), re.compile(r"[぀-ヿ]")
    pats = ["*.js", "*.html", "lib/*.js", "listen-server/*.py", "ocr-server/*.py", "installer/*.ps1", "installer/*.txt",
            "native-host/*.ps1", "ocr-server/*.ps1", "listen-server/*.ps1"]
    seen = set()
    for pat in pats:
        for p in ROOT.glob(pat):
            if p.name in ("zhcn.js", "kanjifix.js"):
                continue
            for piece in re.split(r"['\"`\n]", p.read_text(encoding="utf-8-sig")):
                piece = piece.strip()
                if han.search(piece) and not kana.search(piece) and len(piece) < 300:
                    seen.add(piece)
    return sorted(seen)


def main():
    rounds = build()
    data = {"rounds": rounds}
    (ROOT / "lib" / "zhcn.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    js = (
        "// 繁體（台灣）→ 簡體（大陸用語）轉換。由 tools/make-zhcn.py 從 OpenCC 的字典產生，不要手改。\n"
        "// YTLSZh.convert(s)：每輪從左到右、最長的詞優先；\\uE000…\\uE001 之間的（歌名、標題這些資料）不轉，標記會拿掉。\n"
        "(function (root) {\n"
        "  const ROUNDS = " + json.dumps(rounds, ensure_ascii=False, separators=(",", ":")) + ";\n"
        "  const maps = ROUNDS.map((t) => ({ map: new Map(Object.entries(t)), max: Math.max(1, ...Object.keys(t).map((k) => k.length)) }));\n"
        "  function round(s, { map, max }) {\n"
        "    let out = '';\n"
        "    for (let i = 0; i < s.length;) {\n"
        "      let hit = false;\n"
        "      for (let L = Math.min(max, s.length - i); L > 0; L--) {\n"
        "        const v = map.get(s.substr(i, L));\n"
        "        if (v !== undefined) { out += v; i += L; hit = true; break; }\n"
        "      }\n"
        "      if (!hit) { out += s[i]; i++; }\n"
        "    }\n"
        "    return out;\n"
        "  }\n"
        "  const strip = (s) => String(s).replace(/[\\uE000\\uE001]/g, '');\n"
        "  // 檔名不轉：說明裡的「安裝.cmd」變成「安装.cmd」的話，照著找會找不到檔案\n"
        "  const FILE_RE = /" + FILE_RE.replace("\\b", "\\b") + "/;\n"
        "  const plain = (seg) => seg.split(FILE_RE).map((p, i) => (i % 2 ? p : maps.reduce(round, p))).join('');\n"
        "  function convert(s) {\n"
        "    return String(s).split(/(\\uE000[^\\uE001]*\\uE001)/).map((seg) => (seg[0] === '\\uE000' ? seg.slice(1, -1) : plain(seg))).join('');\n"
        "  }\n"
        "  const api = { convert, strip, protect: (x) => '\\uE000' + strip(x) + '\\uE001' };\n"
        "  root.YTLSZh = api;\n"
        "  if (typeof module !== 'undefined' && module.exports) module.exports = api;\n"
        "})(typeof globalThis !== 'undefined' ? globalThis : this);\n"
    )
    (ROOT / "lib" / "zhcn.js").write_text(js, encoding="utf-8")
    # 比對：先套介面用語，再交給 OpenCC tw2sp，應該跟自己的轉法一樣
    cc = opencc.OpenCC("tw2sp")
    diffs = []
    for s in ui_strings():
        if re.search(FILE_RE, s):
            continue  # 有檔名的句子：檔名故意不轉，跟 OpenCC 一定不一樣（另外用 node 測）
        mine = convert(s, rounds)
        ref = s
        for k in sorted(OVERRIDE, key=len, reverse=True):
            ref = ref.replace(k, "" + OVERRIDE[k] + "")
        ref = "".join(cc.convert(p) if not p.startswith("") else p[1:-1] for p in re.split(r"([^]*)", ref))
        if mine != ref:
            diffs.append((s, mine, ref))
    n = len(ui_strings())
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    report = [f"{len(diffs)} / {n} 句跟 OpenCC 不一樣"] + [f"原文 {a}\n自己 {b}\nOpenCC {c}\n" for a, b, c in diffs[:40]]
    if out:
        out.write_text("\n".join(report), encoding="utf-8")
    print(report[0], "；zhcn.js", round((ROOT / "lib" / "zhcn.js").stat().st_size / 1024), "KB")


if __name__ == "__main__":
    main()
