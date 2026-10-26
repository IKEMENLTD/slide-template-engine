/**
 * A段：原稿の構造化（REQUIREMENTS 7章A。AI 1回）。
 */
import type { Catalog } from '../catalog/build-catalog.js';
import type { TemplateConfig } from '../catalog/config.js';
import { callForJson, type AiContext } from '../ai/call-json.js';
import { numbersNotIn, sourceNumbers } from '../check/content.js';
import { catalogBlock, manuscriptBlock, outlineInstruction, slideRange } from './prompts.js';
import { OutlineSchema, type Outline } from './schema.js';

/** A段の出力上限（トークン）。20枚で 1万字ほどになる */
export const OUTLINE_MAX_OUTPUT_TOKENS = 24000;

/** A段の出力が決まりに合っているか。合っていなければ AI に返す理由の文 */
export function outlineProblems(o: Outline, cat: Catalog, cfg: TemplateConfig, manuscript: string, target?: number): string | null {
  const out: string[] = [];
  const [lo, hi] = slideRange(cfg, target);
  if (o.pages.length < lo || o.pages.length > hi) out.push(`ページ数が ${o.pages.length} 枚。${lo}〜${hi} 枚にする（足りないときは、原稿の内容を分けてページを増やす。原稿に無い内容を足さない）`);
  const src = sourceNumbers(manuscript);
  o.pages.forEach((p, i) => {
    const n = i + 1;
    if (!cat.roles.includes(p.role)) out.push(`p${n}: role "${p.role}" は一覧に無い（${cat.roles.join(', ')} から選ぶ）`);
    const texts = [p.catch, p.body ?? '', ...(p.details ?? []), ...(p.numbers ?? []).map((x) => x.value)];
    const bad = [...new Set(texts.flatMap((t) => numbersNotIn(t, src)))];
    if (bad.length) out.push(`p${n}: 原稿に無い数字 ${bad.join(', ')} を使っている。原稿にある数字だけにする`);
  });
  if (o.pages[0] && o.pages[0].role !== 'cover' && cat.roles.includes('cover')) out.push('1枚目は role "cover" にする');
  return out.length ? out.join('\n') : null;
}

export async function makeOutline(
  ctx: AiContext,
  args: { catalog: Catalog; cfg: TemplateConfig; manuscript: string; targetSlides?: number }
): Promise<Outline> {
  const { catalog, cfg, manuscript } = args;
  return callForJson(ctx, {
    stage: 'A段 原稿の構造化',
    materials: [manuscriptBlock(manuscript), catalogBlock(catalog)],
    instruction: outlineInstruction(catalog, cfg, args.targetSlides),
    user: '原稿からページ割りを作ってください。',
    schema: OutlineSchema,
    maxTokens: OUTLINE_MAX_OUTPUT_TOKENS,
    budgetMs: cfg.ai.callBudgetMs,
    validate: (o) => outlineProblems(o, catalog, cfg, manuscript, args.targetSlides),
  });
}
