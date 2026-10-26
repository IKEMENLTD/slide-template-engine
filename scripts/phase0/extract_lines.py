"""描画された PDF から、各枠に入った行を取り出す（measure-wrap.ts の比較相手）。
使い方: python3 scripts/phase0/extract_lines.py <wrap.pdf> <cases.json> <actual.json>
PPTX の 1pt と PDF の 1pt は同じ（スライド 960x540pt）。"""
import json, sys
import fitz

doc = fitz.open(sys.argv[1])
cases = json.load(open(sys.argv[2], encoding="utf-8"))
out = {}
for c in cases:
    page = doc[c["slide"] - 1]
    lines = {}
    for b in page.get_text("rawdict", flags=0)["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                # 合字（ffi など）は同じ位置に複数の文字が出るので、スパンの中は元の順番を保つ
                x0, y0, x1, y1 = s["bbox"]
                cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
                if c["x"] - 2 <= x0 and x0 < c["x"] + c["width"] and c["y"] - 2 <= cy <= c["y"] + c["height"]:
                    lines.setdefault(round(s["origin"][1], 1), []).append((x0, "".join(ch["c"] for ch in s["chars"])))
    out[c["name"]] = ["".join(ch for _, ch in sorted(v)) for _, v in sorted(lines.items())]
json.dump(out, open(sys.argv[3], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(len(out), "cases")
