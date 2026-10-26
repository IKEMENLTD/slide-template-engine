# Phase 5 の確認用ファイル（全型・別配色・手順書）

## 配色の差し替え（`palette/`）
- `compare-all.jpg`：15の型すべてを、左＝元の配色（青×黄）・右＝テーマ色だけ差し替えた配色（緑×ピンク）で並べたもの。`compare-NN-<型>.jpg` は1型ずつの拡大。
- `blue-yellow/gallery.pptx`・`green-pink/gallery.pptx`：同じ文言・同じ写真の資料。`pages/` は描いたページ。
- 差し替えたテンプレート：`provisional-green.pptx`（`slidegen theme --set accent1=1E8C4E,accent2=E5508A,accent3=A6D9B9,accent4=0F5A30,accent5=F9D7E4` で作成）。型と欄の上限は元と同じ（`provisional-green.catalog.json`）。
- 作り直し方：`npx tsx scripts/phase5/palette-gallery.ts`

## 20枚の資料（`final-20-pages/`）
- 工場のデジタル化計画（`samples/manuscript-03-long.md`）を最初から通したもの。20枚・止める指摘 0・同じ型の連続の注意 0・637秒・実費の概算 $1.04（文章 $0.65＋写真 $0.39）。
- `deck.pptx`・`contact-sheet.jpg`・`report.md`・`review/changes-*.json`（作り直したページ以外は変化 0）・`generated-sheet.jpg`（生成写真の一覧。文字が入っていないかの確認用）。
- 注意の「語の途中の改行」2件（p14「見える／化」・p19「平均45／分」）は、この実行の後に直した（DECISIONS D-031）。次の実行から出ない。

## 手順書の試し（`guide-dryrun/`）
- `docs/TEMPLATE_GUIDE.md` 11章の例「引用」の型を、手順書に書いてあることだけで足したもの（PowerPoint の操作の代わりに python-pptx。`scripts/phase5/guide-dryrun.py`）。
- `catalog.json`：型が 16 になり、`quote` の欄（`txt.quote` 最大60字×4行 など）が読めた。`pages/01.png`：その型で1ページ組み立てて描いたもの。
- **受け入れ条件「手順書だけを読んだ人が新しい型を1つ追加できる」は、佐藤さんが PowerPoint で試す必要がある**（当方の試しは代わりにならない）。
