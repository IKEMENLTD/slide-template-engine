# Phase 0 の確認用ファイル（PowerPoint で開いて確かめるもの）

LibreOffice での確認は当方で済ませています。PowerPoint でしか分からない点だけを、次の 2 つでお願いします。所要時間は 10 分ほどです。

## 1. 差し替えの結果を開く（2 ファイル）

| ファイル | 確かめること |
|---|---|
| `automizer/probe-out.pptx` | ① 開いたときに「修復」のメッセージが出ないか ② 3 枚とも見出し・項目・本文・数字が日本語で入っていて、文字をクリックして直せるか ③ 1・2 枚目の左の写真が平行四辺形に切り抜かれているか、写真をクリックすると「図」として選べるか ④ 「限界」「難しそう」に黄色の下線と太字が付いているか |
| `automizer/probe-out-green.pptx` | ① 同じく「修復」が出ないか ② 青だったところが緑、黄色だったところが橙になっているか（テーマ色の差し替えで全体の色が変わるかの確認） |

LibreOffice で描いた見た目は `automizer/render/*.png` にあります。PowerPoint で開いた見た目と大きく違うところがあれば教えてください。

## 2. 折り返しの確認（1 ファイル・書き出すだけ）

`wrap/wrap.pptx` を PowerPoint で開き、何も変えずに「ファイル → エクスポート → PDF」で、**`wrap/powerpoint.pdf` という名前で同じフォルダに保存**してください。

保存していただければ、PowerPoint での折り返し位置を当方の予測と機械で突き合わせます。

```bash
python3 scripts/phase0/extract_lines.py out/phase0/wrap/powerpoint.pdf out/phase0/wrap/cases.json out/phase0/wrap/actual-powerpoint.json
npx tsx scripts/phase0/measure-wrap.ts out/phase0/wrap actual-powerpoint.json compare-powerpoint.json
```

注意：このファイルは Noto Sans JP（Regular / Medium / Bold）と Noto Serif JP を使います。お使いの PC に入っていないと別の字体で描かれ、比べられません。リポジトリの `fonts/` にある `.otf` を先にインストールしてください。Windows に標準で入っている Noto Sans JP は可変フォントで、太さの指定が効かないことがあります（docs/DECISIONS.md D-005）。

## 中身の一覧

- `automizer/`：検証①②④（複製・日本語の差し替え・平行四辺形の写真・テーマ色）。`probe-out.raw.pptx` は掃除する前の出力で、構造の問題が 8 件あります（比較用。PowerPoint で開く必要はありません）。`evidence.json` は機械で数えた結果です。
- `images/`：検証③（写真の生成）。`contact-sheet.jpg` が 3 枚の一覧、`result.json` に所要時間と実費があります。
- `wrap/`：検証④（文字幅と折り返し）。`compare.json` が LibreOffice との突き合わせ結果です。
