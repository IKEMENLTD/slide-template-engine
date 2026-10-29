/**
 * A段・B段の出力の形（REQUIREMENTS 7章）。AI の出力は zod で検証し、未知の欄は捨てる。
 * ★色・位置・大きさ・字体の欄は作らない（17章「AI に色・位置・大きさ・フォントを決めさせない」）。
 */
import { z } from 'zod';
import type { DeckLanguage } from './locale.js';
import type { PhotoFit } from '../photos/prepare.js';

const str = z.string().trim();

export const OutlinePageSchema = z.object({
  /** このページで伝えること（内部用） */
  purpose: str.min(1),
  /** カタログにある役割から選ぶ */
  role: str.min(1),
  /** 最初に見せる情報（キャッチ・結論・重要な数値） */
  catch: str.min(1),
  /** 次に見せる情報 */
  body: str.optional(),
  /** 最後に読ませる情報（項目の並びもここ） */
  details: z.array(str).optional(),
  /** 原稿にある数字だけ */
  numbers: z.array(z.object({ value: str.min(1), label: str.min(1) })).optional(),
  /** アクセント色で強調する語（1〜2個） */
  emphasis: z.array(str).default([]),
  /** 根拠にした原稿の文（数字・固有名詞の照合に使う） */
  sourceQuotes: z.array(str).min(1),
});

export const OutlineSchema = z.object({
  deckTitle: str.min(1),
  pages: z.array(OutlinePageSchema).min(1),
});

export type Outline = z.infer<typeof OutlineSchema>;
export type OutlinePage = z.infer<typeof OutlinePageSchema>;

/** B段：ページごとの型と、欄ごとの文言。写真の欄は文言を持たない */
export const PlanPageSchema = z.object({
  /** 型ID か 型ID/変種（カタログの key） */
  type: str.min(1),
  /** 欄の名前 → 文言。強調語は [[語]]。改行は \n */
  slots: z.record(z.string(), z.string()),
  /** 写真の欄 → 写真に求めるもの（Phase 3 で写真を選ぶ・作るときに使う。日本語で短く） */
  photos: z.record(z.string(), str).default({}),
});

export const PlanSchema = z.object({ pages: z.array(PlanPageSchema).min(1) });

export type PlanPage = z.infer<typeof PlanPageSchema>;

/** 設計図（deck-plan.json）。AI の出力はここで止まり、以降はコードだけが動く（5章） */
export type DeckPlan = {
  version: 1;
  deckTitle: string;
  /** 資料の言語（D-043）。無ければ日本語（古い実行） */
  language?: DeckLanguage;
  template: { file: string; sha256: string };
  pages: Array<
    PlanPage & {
      /** A段のどのページか（1始まり） */
      outlinePage: number;
      /** 最後の手段で丸めた欄 */
      trimmed: string[];
      /** 文節で改行を入れた欄 */
      phraseBroken: string[];
      /** 欄に入れるまでに書き直させた回数 */
      rewrites: number;
      /** 別の型に替えたなら元の型 */
      retypedFrom?: string;
      /** 見た目の採点で作り直した回数 */
      revisedByReview?: number;
      /** 見た目の採点で作り直したが、決まりに反したので元に戻した回数 */
      revertedByReview?: number;
      /** 写真の欄 → 使う写真（リポジトリからの相対パス）。C段で入る */
      photoFiles?: Record<string, string>;
      /** 写真の欄 → 加工する前の写真（実行のフォルダからの相対パス）。仕上げで人が替えた・形を替えたときに入る */
      photoSources?: Record<string, string>;
      /** 写真の欄 → 切り抜きの結果（顔の数・見えている割合・反転）。FACE_COVERED の検査に使う */
      photoFit?: Record<string, PhotoFit>;
      /** ページを左右反転して組むか（D-042）。決めるのはコードの決まり（mirror-plan.ts）か、仕上げの画面で人 */
      mirrored?: boolean;
    }
  >;
};
