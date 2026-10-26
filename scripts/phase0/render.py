"""PPTX を LibreOffice で PDF にし、ページごとの PNG を作る（Phase 0 の暫定版）。

本来の描画は docker/render（LibreOffice＋Noto＋pdftoppm）で固定する（14-1）。
Phase 0 では検証機の LibreOffice（Windows 版 soffice.exe）か Docker のどちらかを使い、
どちらで描画したかを出力の横に書き残す。PNG 化は pdftoppm の代わりに PyMuPDF を使う。

使い方: python3 scripts/phase0/render.py <in.pptx> <出力ディレクトリ> [--engine windows|docker]
"""

import argparse
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import fitz

WIN_SOFFICE = "/mnt/c/Program Files/LibreOffice/program/soffice.exe"
WIN_TMP = Path("/mnt/c/Users/music-020/AppData/Local/Temp/slidegen")


def to_win(p: Path) -> str:
    return subprocess.check_output(["wslpath", "-w", str(p)], text=True).strip()


def render_windows(src: Path, outdir: Path):
    work = WIN_TMP / uuid.uuid4().hex
    work.mkdir(parents=True)
    try:
        local = work / src.name
        shutil.copy(src, local)
        # 別プロファイルにして、手元で開いている LibreOffice と干渉させない
        profile = "file:///" + to_win(work / "profile").replace("\\", "/")
        r = subprocess.run(
            [WIN_SOFFICE, f"-env:UserInstallation={profile}", "--headless", "--convert-to", "pdf", "--outdir", to_win(work), to_win(local)],
            capture_output=True, text=True, timeout=180,
        )
        pdf = work / (src.stem + ".pdf")
        if not pdf.exists():
            raise SystemExit(f"PDF が作られなかった: exit={r.returncode}\n{r.stdout}\n{r.stderr}")
        dst = outdir / pdf.name
        shutil.copy(pdf, dst)
        return dst, "windows soffice.exe（版は --version が応答しないため未取得）"
    finally:
        shutil.rmtree(work, ignore_errors=True)


def render_docker(src: Path, outdir: Path):
    """標準入出力で受け渡す（Windows 側の docker CLI からは WSL のパスを bind できないため）。"""
    image = os.environ.get("SLIDEGEN_RENDER_IMAGE", "slidegen-render:phase0")
    script = (
        "cat > /work/in.pptx && "
        "HOME=/tmp soffice --headless --convert-to pdf --outdir /work /work/in.pptx >/work/log 2>&1; "
        "if [ -f /work/in.pdf ]; then cat /work/in.pdf; else cat /work/log >&2; exit 3; fi"
    )
    r = subprocess.run(["docker", "run", "-i", "--rm", image, "sh", "-c", script],
                       input=src.read_bytes(), capture_output=True, timeout=300)
    if r.returncode != 0 or not r.stdout.startswith(b"%PDF"):
        raise SystemExit(f"PDF が作られなかった: exit={r.returncode}\n{r.stderr.decode(errors='replace')}")
    pdf = outdir / (src.stem + ".pdf")
    pdf.write_bytes(r.stdout)
    ver = subprocess.run(["docker", "run", "--rm", image, "sh", "-c", "HOME=/tmp soffice --version"],
                         capture_output=True, text=True, timeout=120).stdout.strip()
    return pdf, f"docker {image}: {ver}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pptx")
    ap.add_argument("outdir")
    ap.add_argument("--engine", choices=["windows", "docker"], default="docker")
    ap.add_argument("--dpi", type=int, default=96)
    a = ap.parse_args()
    src = Path(a.pptx)
    outdir = Path(a.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    pdf, engine = (render_windows if a.engine == "windows" else render_docker)(src, outdir)
    doc = fitz.open(pdf)
    names = []
    for i, page in enumerate(doc, 1):
        png = outdir / f"{src.stem}-{i:02d}.png"
        page.get_pixmap(dpi=a.dpi).save(png)
        names.append(png.name)
    fonts = sorted({f[3].split("+")[-1] for p in doc for f in p.get_fonts()})
    (outdir / f"{src.stem}.render.txt").write_text(
        f"engine: {engine}\npages: {doc.page_count}\nembedded_fonts: {', '.join(fonts)}\n", encoding="utf-8"
    )
    print(pdf, doc.page_count, "pages", fonts, file=sys.stdout)


if __name__ == "__main__":
    main()
