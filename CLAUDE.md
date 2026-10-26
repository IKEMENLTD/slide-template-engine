# このリポジトリの約束

正は `docs/REQUIREMENTS.md`。決めたこと・要件定義書と違う判断は `docs/DECISIONS.md` に書く。

## 動かし方

```bash
npm ci
npx vitest run                                    # テスト
docker build -f docker/render/Dockerfile -t slidegen-render:phase0 .   # 描画用イメージ（初回だけ）
python3 scripts/phase0/render.py <in.pptx> <出力dir>                    # PDF と PNG
npm run typecheck                                                       # 型の検査
python3 scripts/build-provisional-template.py                           # 仮テンプレートを作り直す
npx tsx src/cli.ts catalog --template templates/provisional.pptx        # 型カタログ（out/catalog/）
npx tsx scripts/phase0/check-structure.ts <a.pptx>                      # PPTX_REPAIR の構造検査
```

Python 側は `python-pptx`・`PyMuPDF`・`Pillow` を使う（テンプレート生成と PDF の読み取り）。

## 守ること（実測で分かったこと）

- **automizer の出力は必ず `sanitizePptx` と `checkPptxStructure` を通す。**そのままだと、外した見本スライド・宙に浮いた画像の関係・型の YAML のノートが残る（D-004）。
- 孤立部品は「ルートからたどれるか」で数える。互いに参照し合う輪が残るので、「誰からも参照されていないか」では見つからない。
- **JSZip の `remove(フォルダ名)` は中身ごと消す。**ディレクトリ項目を消そうとして写真を全部消しかけた。
- 写真の切り抜きは sharp で先に済ませる。automizer の `setRelationTargetCover` は平行四辺形で失敗する（D-003）。
- フォントは静的フォント（`fonts/`）だけを使う。可変フォントは既定が Thin で、PowerPoint の書式は太字しか持たない。Medium は `Noto Sans JP Medium` という名前で指定する（D-005）。
- 有償フォント（DIN・リュウミン・太ゴB101）と API キーはリポジトリに入れない。リポジトリは公開（D-001）。
- 文字幅の判定は「予測では入るのに実物ではあふれる」を 0 にする側に倒す（3% の余裕。D-006）。
- gpt-image-2.5-flare に `input_fidelity` を送ると 400 になる（D-007）。
- 検査は両側のテストを持つ（違反で落ちる／正しいものは通る）。足したら、わざと壊して落ちることを一度確かめる。
- AirLog（IKEMENLTD/airlog）は読むだけ。書き込まない。
- 先方 PDF は Illustrator でカナを詰めて組んである（palt）。PowerPoint は詰めないので 5〜14% 広くなる。PDF の字幅を正にして枠を決めない（D-015）。
- 文字の欄は `p:txBody`（presentationml の名前空間）。`a:` で探すと見つからない。
- 行間はテンプレートで固定値（pt）にする。行数の計算がそれで決まる（D-013）。
