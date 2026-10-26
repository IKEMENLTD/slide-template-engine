# 検査レポート 20261026-154839-manuscript-02-standard

- 原稿: manuscript-02-standard.md／テンプレート: templates/provisional.pptx／10 枚
- 結果: 止める指摘 0 件・注意 5 件
- AI: claude-cli・claude-sonnet-5-5・20 回（うちやり直し 3）・入力 159816 トークン（キャッシュ読み 79418）・出力 19184 トークン・概算 $0.4087
- 写真: 欄 16（支給 3・生成 13・見本のまま 0）・生成 11 枚 $0.3519（130.9秒）
- 実費の概算（文章＋写真）: $0.7606
- 時間: 合計 431.3秒（A段 15.9秒・B段 43.5秒・C段 160.5秒・D段 15.6秒・E段 描画 58.1秒・E段 採点 80.9秒・E段 作り直し 56.8秒）

## 止める指摘
なし

## 注意
- [NAME_NOT_IN_SOURCE] p4 txt.headline: txt.headline に原稿に無い語 スマホ がある（固有名詞なら要確認）
- [VISUAL_REVIEW] p5 num.value.2: num.value.2: 大きな数字が「3日」ですが、注記は「3日から半日に短縮」で、結果は半日です。大きな数字が短縮前の値になっていて、効果と合いません。「半日」にするか、数字を「0.5」にして単位を「日」にしてください。
- [VISUAL_REVIEW] p5 txt.note.1: txt.note.1: 強調の下線が注記の「月120件から月6件」に付いています。このページでいちばん見てほしいのは大きな数字(6件)の効果です。また、注記が折り返されて「減少」だけが2行目に残っています。「月120件から月6件に減少」のように短くまとめてください。
- [VISUAL_REVIEW] p5 txt.note.3: txt.note.3: 注記3つで言い回しと改行位置がそろっていません。「3日から半日に短縮」は改行なし、他の2つは改行ありです。表記を統一してください。
- [VISUAL_REVIEW] p5 txt.footnote: txt.footnote: 見出しの「営業部30名の試験導入」と同じ内容の繰り返しです。削るか、集計期間などの新しい情報に置き換えてください。

## ページ
| p | 型 | 書き直し | 型の替え | 見た目で作り直し | 丸め | 文節の改行 |
|---|---|---|---|---|---|---|
| 1 | cover | 0 |  |  |  | txt.point.1.main, txt.point.3.main, txt.headline, txt.subtitle |
| 2 | toc/4 | 0 |  |  |  |  |
| 3 | issues/4 | 0 |  |  |  | txt.item.3.title, txt.item.4.title |
| 4 | photo-text/b | 0 |  |  |  | txt.headline, txt.item.1, txt.item.2, txt.item.3 |
| 5 | numbers/3 | 5 |  | 2 |  | txt.note.1, txt.note.3 |
| 6 | section | 0 |  |  |  |  |
| 7 | steps/4 | 1 |  |  |  | txt.item.1.caption, txt.item.2.caption, txt.item.4.caption |
| 8 | attention | 0 |  |  |  |  |
| 9 | photo-text/a | 0 |  |  |  | txt.headline |
| 10 | collage | 3 |  | 2 |  | txt.subtitle |
