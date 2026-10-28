/**
 * テンプレートの設定ファイル（templates/<名前>.config.json）。REQUIREMENTS 6-3。
 * 値を変えるだけで振る舞いを変えられるものは、すべてここに置く（REQUIREMENTS 0章4・2-3 原則7）。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const SlotOverride = z.object({ maxChars: z.number().int().positive().optional(), maxLines: z.number().int().positive().optional() }).strict();

export const ConfigSchema = z
  .object({
    /** 字体の名前 → 文字幅を測る実フォントのファイル（リポジトリからの相対パス）。太字は「名前:bold」 */
    fonts: z.record(z.string(), z.string()),
    /** 強調語の書式（D-009）。underline はテーマ色の名前 */
    emphasis: z.object({ underline: z.string(), bold: z.boolean(), maxPerSlide: z.number().int().nonnegative() }).strict(),
    /** 大見出し（D-008）。mincho は先方確認事項3 */
    headline: z.object({ maxLines: z.number().int().positive(), mincho: z.boolean() }).strict(),
    /** 写真枠ごとの加工（7章C） */
    images: z.record(z.string(), z.object({ mono: z.boolean(), multiply: z.string().nullable() }).strict()),
    /** 欄の測定値の上書き。キーは「型ID」か「型ID/変種」、中のキーは欄の名前（* は任意の文字列） */
    slots: z.record(z.string(), z.record(z.string(), SlotOverride)),
    /** 文字幅の判定（D-006） */
    fit: z
      .object({
        autospaceEm: z.number().nonnegative(),
        hangingPunct: z.boolean(),
        /** 枠の幅のうち、余裕として使わない割合 */
        slackRatio: z.number().min(0).max(0.5),
        /** 行間の指定が倍率・無指定のときの、1行の高さ（字の大きさに掛ける）。PowerPoint の既定に近い値 */
        defaultLineHeight: z.number().positive(),
      })
      .strict(),
    deck: z.object({ maxSameTypeInRow: z.number().int().positive(), minSlides: z.number().int().positive(), maxSlides: z.number().int().positive() }).strict(),
    /**
     * 白と黒の面積比（ルール 4-6「白：黒＝3：2」）。「黒」の定義が未確定（16章 #4）なので既定は無効。
     * 明るさ（0〜1）が darkBelow 未満の画素を「黒」、それ以外を「白」と数え、白÷黒 が target±tolerance から外れたら注意
     */
    lightDarkRatio: z.object({ enabled: z.boolean(), target: z.number(), tolerance: z.number(), darkBelow: z.number().min(0).max(1).default(0.5) }).strict(),
    /** AI の呼び出し（9章）。model は models.ts にあるもの */
    ai: z
      .object({
        model: z.string(),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
        /** 安全の判定で断られたときに、サーバー側で別のモデルにやり直させる */
        refusalFallback: z.boolean(),
        /** 欄に入らないときに書き直させる回数（7章B-3：最大2回） */
        maxRewrites: z.number().int().nonnegative(),
        /** 1回の呼び出しに使える壁時計（ms） */
        callBudgetMs: z.number().int().positive(),
      })
      .strict()
      .default({ model: 'claude-sonnet-5-5', effort: 'medium', refusalFallback: true, maxRewrites: 2, callBudgetMs: 600000 }),
    /**
     * 文節（budoux）の切れ目で改行を入れる欄（7章B-4）。PowerPoint は語の途中で折り返すため。
     * 本文のように長く流れる欄は入れない（後で人が直すとき、固定の改行が邪魔になる）
     */
    phraseBreak: z.array(z.string()).default(['txt.headline', 'txt.subtitle', 'txt.*.title', 'txt.*.lead', 'txt.*.main', 'txt.*.caption', 'txt.item.*', 'txt.note.*']),
    /** 写真（7章C・10章） */
    photos: z
      .object({
        /** 1枚の写真（支給・生成とも）を資料全体で使う回数の上限 */
        maxUsesPerFile: z.number().int().positive(),
        /** 1資料で生成する写真の上限 */
        maxGenerate: z.number().int().nonnegative(),
        model: z.string(),
        quality: z.enum(['low', 'medium', 'high']),
        /** 写真の欄で、人の顔がこの割合より図形に隠れていたら注意（FACE_COVERED）。生成した写真なら作り直す */
        minFaceVisible: z.number().min(0).max(1).default(0.6),
        /** 顔が隠れる生成写真を、構図を指定して作り直す回数の上限（1資料あたり） */
        maxRegenerate: z.number().int().nonnegative().default(4),
      })
      .strict()
      .default({ maxUsesPerFile: 2, maxGenerate: 12, model: 'gpt-image-2.5-flare', quality: 'medium', minFaceVisible: 0.6, maxRegenerate: 4 }),
    /** 見た目の採点と作り直し（11章 VISUAL_REVIEW・7章E） */
    review: z
      .object({
        enabled: z.boolean(),
        /** 作り直しの回数（1ページ最大2回。7章E） */
        maxRounds: z.number().int().nonnegative(),
        /** 1回の呼び出しで見せるページ数 */
        pagesPerCall: z.number().int().positive(),
        /** 描画の解像度（dpi）。96 で 1280x720 */
        dpi: z.number().int().positive(),
      })
      .strict()
      .default({ enabled: true, maxRounds: 2, pagesPerCall: 5, dpi: 96 }),
    /** 検査（11章）の細かい決め。 */
    // 旧い名前（noNumberSlots。Phase 2 の実行の設定に残っている）も読めるようにする
    checks: z.preprocess(
      (v) => (v && typeof v === 'object' && 'noNumberSlots' in v ? (({ noNumberSlots, ...rest }) => ({ unitSlots: noNumberSlots, ...rest }))(v as Record<string, unknown>) : v),
      z
      .object({
        /** 固有名詞らしき語を調べない欄（英字の飾りの見出しなど） */
        nameIgnoreSlots: z.array(z.string()),
        /** 単位の欄（単位だけを入れる。数字は num.*、説明は txt.note.* へ） */
        unitSlots: z.array(z.string()).default(['txt.unit.*']),
      })
      .strict()
      .default({ nameIgnoreSlots: ['txt.eyebrow'], unitSlots: ['txt.unit.*'] })
    ),
  })
  .strict();

export type TemplateConfig = z.infer<typeof ConfigSchema>;

/** 欄の名前のパターン（* は任意の文字列）に当たるか */
export const slotPattern = (g: string) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
export const matchesAny = (patterns: string[], name: string) => patterns.some((p) => slotPattern(p).test(name));

export const configPathFor = (templatePath: string) => templatePath.replace(/\.pptx$/i, '.config.json');

export function loadConfig(file: string): TemplateConfig {
  return ConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/**
 * 設定の雛形を作る（REQUIREMENTS 6-3「初回はエンジンが雛形を自動生成し、人が直す」）。
 * 字体は、テンプレートで使われている名前を fonts/ の中のファイルと名前表で突き合わせる。
 */
export function scaffoldConfig(opts: {
  typefaces: Array<{ name: string; bold: boolean }>;
  imageSlots: string[];
  fontFiles: Array<{ file: string; family: string; legacyFamily: string; subfamily: string }>;
}): { config: TemplateConfig; unresolved: string[] } {
  const fonts: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const t of opts.typefaces) {
    const key = t.bold ? `${t.name}:bold` : t.name;
    if (fonts[key] || unresolved.includes(key)) continue;
    const want = t.bold ? 'Bold' : 'Regular';
    // 旧来の家族名で一致するもの（例：Noto Sans JP Medium）を優先し、無ければ家族名＋太さで探す
    const hit =
      opts.fontFiles.find((f) => f.legacyFamily === t.name && (t.bold ? f.subfamily === 'Bold' : f.subfamily !== 'Bold')) ??
      opts.fontFiles.find((f) => f.family === t.name && f.subfamily === want);
    if (hit) fonts[key] = hit.file;
    else unresolved.push(key);
  }
  const images: TemplateConfig['images'] = {};
  for (const s of opts.imageSlots) images[s] = { mono: true, multiply: null };
  return {
    config: {
      fonts,
      emphasis: { underline: 'accent2', bold: true, maxPerSlide: 2 },
      headline: { maxLines: 2, mincho: true },
      images,
      slots: {},
      fit: { autospaceEm: 0.25, hangingPunct: true, slackRatio: 0.03, defaultLineHeight: 1.2 },
      deck: { maxSameTypeInRow: 2, minSlides: 4, maxSlides: 20 },
      lightDarkRatio: { enabled: false, target: 1.5, tolerance: 0.3, darkBelow: 0.5 },
      ai: { model: 'claude-sonnet-5-5', effort: 'medium', refusalFallback: true, maxRewrites: 2, callBudgetMs: 600000 },
      phraseBreak: ['txt.headline', 'txt.subtitle', 'txt.*.title', 'txt.*.lead', 'txt.*.main', 'txt.*.caption', 'txt.item.*', 'txt.note.*'],
      photos: { maxUsesPerFile: 2, maxGenerate: 12, model: 'gpt-image-2.5-flare', quality: 'medium', minFaceVisible: 0.6, maxRegenerate: 4 },
      review: { enabled: true, maxRounds: 2, pagesPerCall: 5, dpi: 96 },
      checks: { nameIgnoreSlots: ['txt.eyebrow'], unitSlots: ['txt.unit.*'] },
    },
    unresolved,
  };
}

export const repoPath = (root: string, p: string) => (path.isAbsolute(p) ? p : path.join(root, p));
export const configExists = (p: string) => existsSync(p);
