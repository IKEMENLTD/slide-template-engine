# Phase 1 の確認用ファイル

| ファイル | 見るところ |
|---|---|
| `compare/compare-p1-slide1.png` ほか2枚 | 左＝先方 PDF、右＝仮テンプレート（ダミー文言）。構図・色・図形の形 |
| `compare-filled/compare-p1-slide1.png` ほか2枚 | 左＝先方 PDF、右＝仮テンプレートに先方の文言を流し込んだもの。字の大きさと配置の比べ |
| `render/provisional-02.png`・`-03.png` | 課題提示の2件・3件の型（PDF に見本が無いので当方で作った） |
| `filled.pptx` | 先方の文言を流し込んだ PowerPoint。開いて文字が直せるか |
| `provisional.catalog.json` | 型カタログ（5型・58欄）。欄ごとの最大字数・最大行数 |
| `source-fit.json` | 先方 PDF の文言 33欄が、欄に収まるかを測った結果（すべて収まる） |

テンプレート本体は `templates/provisional.pptx`、作るスクリプトは `scripts/build-provisional-template.py`。
比較画像の描画は LibreOffice です。和文と英数字の間に少し空きが入るのは LibreOffice の描き方で、PowerPoint では入りません（D-006）。
