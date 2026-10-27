# slide-template-engine

デザイナーが作った PowerPoint テンプレートに、AI が原稿を流し込んでスライドを自動生成する仕組み（内藤さんとの共同開発）。

- 要件定義書：[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)
- 判断の記録：[docs/DECISIONS.md](docs/DECISIONS.md)
- デザイナー向けのテンプレートの作り方：[docs/TEMPLATE_GUIDE.md](docs/TEMPLATE_GUIDE.md)
- 先方資料：`docs/source/`（デザインルール docx、テンプレート見本 PDF）

## 流れ

```
原稿 ─► A段 ページ割り（AI）─► B段 型の選択と欄の文言（AI＋実フォントで測る）─► 設計図 deck-plan.json
     ─► C段 写真（支給の写真を割り当て、足りない分を生成・モノクロ・乗算）
     ─► D段 組み立て（見本スライドを複製し、名前の付いた図形の文字と写真だけ差し替え）
     ─► E段 検査・描画・見た目の採点・指摘のあったページだけ作り直し
     ─► out/<実行ID>/deck.pptx・deck.pdf・pages/*.png・report.md・report.json
```

## 使い方

```bash
npm ci
docker build -f docker/render/Dockerfile -t slidegen-render:phase0 .   # 描画用（初回だけ）

# テンプレートから型カタログを作る（欄ごとに何字入るか）
npx tsx src/cli.ts catalog --template templates/provisional.pptx

# 原稿から資料を作る（--ai anthropic は ANTHROPIC_API_KEY、写真の生成は OPENAI_API_KEY を使う）
npx tsx src/cli.ts build --template templates/provisional.pptx --input samples/manuscript-02-standard.md --slides 10 --ai anthropic

npx tsx src/cli.ts build --resume out/<実行ID>     # 途中で止まったら続きから
npx tsx src/cli.ts check out/<実行ID>              # 検査だけやり直す

# 配色だけを差し替えたテンプレートを作る
npx tsx src/cli.ts theme --template templates/provisional.pptx --out templates/provisional-green.pptx --set accent1=1E8C4E,accent2=E5508A
```

- 設定は `templates/<名前>.config.json`（字体のファイル・強調の書式・写真の加工・AI のモデル・検査の決め）。
- 試験：`npx vitest run`（描画の試験には Docker が要る）／型：`npm run typecheck`

## アプリ（先方が使う画面）

```bash
npm run app:build      # 画面を組む（初回と画面を直したとき）
npm run app            # http://127.0.0.1:8787 を開く
```

- 「設定」で Claude の鍵（必須）と OpenAI の鍵（写真を作るとき）を入れる。資料・設定は `data/` に置く（版管理しない）。
- 箱で動かす：`docker build -f docker/app/Dockerfile -t slidegen-app .` → `docker run -p 8787:8787 -v slidegen-data:/data -e SLIDEGEN_PASSWORD=… -e SLIDEGEN_HOSTS=<公開に使う名前> slidegen-app`（パスワード無しでは起動しない。SLIDEGEN_HOSTS 以外の宛先と、別のサイトからの操作は断る）
- 作りの説明は docs/DECISIONS.md の D-038。
