"""先方 PDF のページと、仮テンプレートを描いたページを左右に並べた比較画像を作る（Phase 1 の受け入れ条件）。
使い方: python3 scripts/compare-pages.py <テンプレートを描いたPDF> <出力dir> 1:1 2:4 3:5
  「先方PDFのページ:テンプレートのページ」を並べる（1始まり）。"""
import sys
from pathlib import Path
import fitz
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
src = fitz.open(ROOT / "docs/source/0925_資料.pdf")
tpl = fitz.open(sys.argv[1])
out = Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)

def img(page, width=960):
    zoom = width / page.rect.width
    pm = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
    return Image.frombytes("RGB", (pm.width, pm.height), pm.samples)

for pair in sys.argv[3:]:
    a, b = (int(x) for x in pair.split(":"))
    left, right = img(src[a - 1]), img(tpl[b - 1])
    w, h = left.size
    sheet = Image.new("RGB", (w * 2 + 30, h + 40), "white")
    sheet.paste(left, (0, 40)); sheet.paste(right, (w + 30, 40))
    d = ImageDraw.Draw(sheet)
    font = ImageFont.truetype(str(ROOT / "fonts/NotoSansJP-Regular.otf"), 18)
    d.text((10, 12), f"先方 PDF p{a}", fill="black", font=font); d.text((w + 40, 12), f"仮テンプレート スライド{b}", fill="black", font=font)
    p = out / f"compare-p{a}-slide{b}.png"
    sheet.save(p); print(p)
