# Phase 2 の確認用ファイル（原稿から PPTX まで）

| フォルダ | 原稿 | 枚数 | 止める指摘 | 開いて見るもの |
|---|---|---|---|---|
| `01-short/` | `samples/manuscript-01-short.md`（業務自動化サービスの案内） | 5 | 0 | `deck.pptx`・`contact-sheet.jpg` |
| `02-standard/` | `samples/manuscript-02-standard.md`（勤怠管理の社内説明会） | 9 | 0（注意3） | 同上 |
| `03-long/` | `samples/manuscript-03-long.md`（工場のデジタル化計画） | 20 | 0 | 同上 |
| `03-long-killed-and-resumed/` | 同上（別の実行。B段の途中で強制終了して再開） | 16 | 0 | `1-killed.log`・`2-resumed.log`・`ai-calls.jsonl` |

- 各フォルダ：`outline.json`（A段）・`deck-plan.json`（B段の設計図）・`deck.pptx`・`report.md`（検査）・`ai-calls.jsonl`（AI の呼び出しごとの使用量）・`render/`（LibreOffice で描いた PDF と PNG）。
- 写真は支給の固定画像（`assets/photos/`。Phase 0 で生成した3枚）を順に割り当てたもの。写真の選び方と生成は Phase 3。
- AI は `claude -p`（Sonnet 5.5）経由で呼んだ（この案件用の API の鍵が届くまでの検証。DECISIONS D-019）。
- 作り直し方：`npx tsx src/cli.ts build --template templates/provisional.pptx --input samples/manuscript-03-long.md --slides 20 --ai claude-cli`
