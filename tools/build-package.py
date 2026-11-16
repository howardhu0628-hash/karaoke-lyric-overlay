# 打包安裝包：dist/YTLyricSub-v<版本>/（安裝.cmd、install.ps1、解除安裝、說明、app/）＋同名 .zip
# 用法：python tools/build-package.py [輸出 zip 要另外複製到的資料夾]
# app/ 只放執行要用的檔案：擴充功能本體、兩個本機服務的程式。不放開發測試（dev/、tools/）、快取、暫存。
import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
NAME = "YTLyricSub-v" + VERSION
OUT = ROOT / "dist" / NAME

APP_FILES = ["manifest.json", "background.js", "content.js", "hook.js", "offscreen.html", "offscreen.js", "popup.html", "popup.js", "overlay.css", "README.md"]
APP_DIRS = ["icons", "lib", "vendor", "native-host", "ocr-server", "listen-server"]
SKIP_DIRS = {"cache", "tmp", "__pycache__", "node_modules"}
SKIP_FILES = {"ytlyricsub.host.json", "com.claude.ytls.json"}  # 安裝時依筆電上的擴充功能 ID 重新產生
SKIP_SUFFIXES = {".pyc", ".pyo", ".log"}


def copy_tree(src, dst):
    for p in src.rglob("*"):
        rel = p.relative_to(src)
        if any(part in SKIP_DIRS for part in rel.parts) or p.name in SKIP_FILES or p.suffix in SKIP_SUFFIXES:
            continue
        if p.is_file():
            (dst / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, dst / rel)


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    app = OUT / "app"
    app.mkdir(parents=True)
    for f in APP_FILES:
        shutil.copy2(ROOT / f, app / f)
    for d in APP_DIRS:
        copy_tree(ROOT / d, app / d)
    for f in (ROOT / "installer").iterdir():
        shutil.copy2(f, OUT / f.name)
    zpath = OUT.parent / (NAME + ".zip")  # 不能用 with_suffix：版本號 1.0 的「.0」會被當成副檔名
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted(OUT.rglob("*")):
            if p.is_file():
                z.write(p, Path(NAME) / p.relative_to(OUT))
    n = sum(1 for p in OUT.rglob("*") if p.is_file())
    print("安裝包：%s（%d 個檔案，zip %.1f MB）" % (zpath, n, zpath.stat().st_size / 1048576))
    if len(sys.argv) > 1:
        dest = Path(sys.argv[1])
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copy2(zpath, dest / zpath.name)
        print("已複製到", dest / zpath.name)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
