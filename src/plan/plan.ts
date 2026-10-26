/**
 * B段：型の選択と流し込み（REQUIREMENTS 7章B）。
 *
 * 1. ページ割りを数ページずつに分けて、型と欄の文言を書かせる（下書き）
 * 2. ページごとに、文節の改行を入れ、実フォントで測り、決まりを検査する
 * 3. 入らない・決まりに反するページだけ、理由を添えて書き直させる（最大 ai.maxRewrites 回）
 * 4. それでも入らなければ、同じ役割の別の型で書き直させる（1回）
 * 5. 最後の手段：語の途中で切らない丸め（trimTo）で欄に入れ、TRIMMED として記録する
 *
 * 途中の結果は書き出し、落ちても続きから再開できる（原則6）。
 */
import type { Catalog, CatalogType } from '../catalog/build-catalog.js';
import { matchesAny, type TemplateConfig } from '../catalog/config.js';
import { callForJson, type AiContext } from '../ai/call-json.js';
import { trimTo } from '../ai/doc-policy.js';
import { restoreNumberNotation, type Issue } from '../check/content.js';
import { checkPage, checkTypeRuns, type SlotCheckContext } from '../check/slots.js';
import { fitSlot } from '../fit/fit-slot.js';
import { breakByPhrase } from '../fit/phrase-break.js';
import { describeType, imageSlots, textSlots } from './describe.js';
import { catalogBlock, manuscriptBlock, planInstruction, rewriteInstruction } from './prompts.js';
import { PlanPageSchema, PlanSchema, type DeckPlan, type Outline, type PlanPage } from './schema.js';

/** 1回の呼び出しで書かせるページ数。多いと出力が長くなり、途中で切れやすい */
export const PLAN_CHUNK_PAGES = 6;
export const PLAN_MAX_OUTPUT_TOKENS = 24000;
export const REWRITE_MAX_OUTPUT_TOKENS = 8000;

export type PlanStore = {
  /** 保存済みの値を読む（無ければ undefined） */
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
};

export type PlanArgs = {
  catalog: Catalog;
  cfg: TemplateConfig;
  manuscript: string;
  outline: Outline;
  check: SlotCheckContext;
  store: PlanStore;
  /** 同時に書き直させるページ数 */
  concurrency?: number;
  log?: (msg: string) => void;
};

type FinalPage = DeckPlan['pages'][number];

const findType = (cat: Catalog, key: string) => cat.types.find((t) => t.key === key);

/** 下書きの形の検査（型が無い・欄が足りない・ページ数が違う・同じ型が続く）。合っていなければ AI に返す理由 */
export function draftProblems(pages: PlanPage[], expect: number, cat: Catalog, cfg: TemplateConfig, before: string[]): string | null {
  const out: string[] = [];
  if (pages.length !== expect) out.push(`pages が ${pages.length} 件。${expect} 件にする`);
  pages.forEach((p, i) => {
    const t = findType(cat, p.type);
    if (!t) return out.push(`${i + 1}件目: 型 "${p.type}" は無い。<catalog> の key から選ぶ`);
    const missing = textSlots(t).filter((s) => !p.slots[s.name]?.trim()).map((s) => s.name);
    if (missing.length) out.push(`${i + 1}件目（${p.type}）: 欄 ${missing.join(', ')} が空`);
  });
  const runs = checkTypeRuns([...before, ...pages.map((p) => p.type)], cfg.deck.maxSameTypeInRow);
  if (runs.length && pages.every((p) => findType(cat, p.type))) out.push(`同じ型ID を ${cfg.deck.maxSameTypeInRow} 枚より多く続けている。別の型を選ぶ`);
  return out.length ? out.join('\n') : null;
}

/** 型にある欄だけを残し、文節の改行を入れる。改行が入ったなら、その欄の名前を返す */
function normalize(t: CatalogType, p: PlanPage, a: PlanArgs): { slots: Record<string, string>; broken: string[] } {
  const slots: Record<string, string> = {};
  const broken: string[] = [];
  for (const s of textSlots(t)) {
    let text = (p.slots[s.name] ?? '').trim();
    // AI に改行を入れさせない欄の改行は外す（文節の改行はこちらで入れる）
    if (s.name !== 'txt.eyebrow') text = text.replace(/\s*\n\s*/g, '');
    // 数字の表記（桁区切り）を原稿に合わせる
    text = restoreNumberNotation(text, a.manuscript);
    if (matchesAny(a.cfg.phraseBreak, s.name)) {
      const r = breakByPhrase(s, text, a.catalog.fit, a.check.resolveFile);
      text = r.text;
      if (r.applied) broken.push(s.name);
    }
    slots[s.name] = text;
  }
  return { slots, broken };
}

/** 強調を設定の数まで減らす（先頭から数えて超えた分の印を外す）。超えたまま出さないため */
function capEmphasis(slots: Record<string, string>, max: number, order: string[]) {
  let n = 0;
  for (const name of order) {
    if (slots[name] == null) continue;
    slots[name] = slots[name].replace(/\[\[([^[\]]*)\]\]/g, (m, w) => (++n <= max ? m : w));
  }
}

/** 最後の手段：欄に入るまで、語の途中で切らずに丸める（trimTo）。強調の印は外す */
function trimToFit(t: CatalogType, slots: Record<string, string>, a: PlanArgs): string[] {
  const trimmed: string[] = [];
  for (const s of textSlots(t)) {
    const text = slots[s.name];
    if (text == null || fitSlot(s, text, a.catalog.fit, a.check.resolveFile).ok) continue;
    const plain = text.replace(/\[\[|\]\]/g, '').replace(/\n/g, '');
    let max = [...plain].length;
    let cand = plain;
    while (max > 1) {
      max--;
      cand = trimTo(plain, max);
      if (fitSlot(s, cand, a.catalog.fit, a.check.resolveFile).ok) break;
    }
    slots[s.name] = cand;
    trimmed.push(s.name);
  }
  return trimmed;
}

/** 書き直させる指摘：止める指摘と、欄の使い方の決まり */
const fixable = (issues: Issue[]) => issues.filter((i) => i.level === 'error' || i.code === 'SLOT_RULE');

function pageBrief(outline: Outline, n: number) {
  return `<outline>\n${JSON.stringify(outline.pages[n - 1], null, 1)}\n</outline>`;
}

function rewriteUser(n: number, t: CatalogType, slots: Record<string, string>, problems: Issue[], outline: Outline, candidates?: CatalogType[]) {
  const head = candidates
    ? `p${n} は型 ${t.key} では欄に収まりませんでした。次の型のどれかに替えて、1ページ分を書き直してください。\n${candidates.map(describeType).join('\n')}`
    : `p${n}（型 ${t.key}）の文言を直してください。型は替えない。\n${describeType(t)}`;
  return (
    `${head}\n\nこのページのページ割り:\n${pageBrief(outline, n)}\n\n今の文言:\n<page>\n${JSON.stringify(slots, null, 1)}\n</page>\n\n指摘:\n` +
    problems.map((p) => `- ${p.message}`).join('\n')
  );
}

export async function planDeck(ctx: AiContext, a: PlanArgs): Promise<DeckPlan['pages']> {
  const { catalog, cfg, outline, store } = a;
  const log = a.log ?? (() => {});
  const materials = [manuscriptBlock(a.manuscript), catalogBlock(catalog)];
  const total = outline.pages.length;

  // 1. 下書き（数ページずつ）
  const drafts: PlanPage[] = [];
  for (let from = 1; from <= total; from += PLAN_CHUNK_PAGES) {
    const to = Math.min(total, from + PLAN_CHUNK_PAGES - 1);
    const key = `plan/draft-${String(from).padStart(2, '0')}`;
    let chunk = store.get<PlanPage[]>(key);
    if (!chunk) {
      log(`B段 下書き p${from}〜p${to}`);
      const before = drafts.slice(-cfg.deck.maxSameTypeInRow).map((p) => p.type);
      const res = await callForJson(ctx, {
        stage: `B段 下書き p${from}-${to}`,
        materials,
        instruction: planInstruction(catalog, cfg),
        user:
          `資料の題: ${outline.deckTitle}\n全 ${total} ページのうち、p${from}〜p${to} の ${to - from + 1} ページ分を書いてください（pages は ${to - from + 1} 件）。\n` +
          (before.length ? `直前のページの型: ${before.join(' → ')}（同じ型ID の連続に数える）\n` : '') +
          `\n<outline>\n${JSON.stringify({ deckTitle: outline.deckTitle, pages: outline.pages.slice(from - 1, to).map((p, i) => ({ page: from + i, ...p })) }, null, 1)}\n</outline>`,
        schema: PlanSchema,
        maxTokens: PLAN_MAX_OUTPUT_TOKENS,
        budgetMs: cfg.ai.callBudgetMs,
        validate: (v) => draftProblems(v.pages, to - from + 1, catalog, cfg, before),
      });
      chunk = res.pages;
      store.set(key, chunk);
    }
    drafts.push(...chunk);
  }

  // 2〜5. ページごとに測って直す
  const results: FinalPage[] = new Array(total);
  const work = drafts.map((d, i) => async () => {
    const n = i + 1;
    const key = `plan/page-${String(n).padStart(2, '0')}`;
    const saved = store.get<FinalPage>(key);
    if (saved) return (results[i] = saved);
    const final = await fixPage(ctx, a, n, d, { allowRetype: true, stage: 'B段' });
    store.set(key, final);
    results[i] = final;
  });
  await runLimited(work, a.concurrency ?? 3);
  return results;
}

/**
 * 1ページを、欄に収まり決まりに合うまで直す（B段の 2〜5。E段の作り直しも同じものを使う）。
 * @param forced 最初に必ず直させる指摘（E段：見た目の採点の指摘）。測定の検査の指摘に加えて渡す
 */
export async function fixPage(
  ctx: AiContext,
  a: PlanArgs,
  n: number,
  draft: PlanPage,
  opts: { allowRetype: boolean; stage: 'B段' | 'E段'; forced?: Issue[] }
): Promise<FinalPage> {
  const { catalog, cfg, outline } = a;
  const log = a.log ?? (() => {});
  const materials = [manuscriptBlock(a.manuscript), catalogBlock(catalog)];
  let page: PlanPage = draft;
  let t = findType(catalog, page.type)!;
  let { slots, broken } = normalize(t, page, a);
  let problems = [...(opts.forced ?? []), ...fixable(checkPage(n, t, slots, a.check))];
  let rewrites = 0;
  let retypedFrom: string | undefined;
  const rewrite = async (candidates?: CatalogType[]) => {
    const res = await callForJson(ctx, {
      stage: `${opts.stage} ${candidates ? '型の替え' : '書き直し'} p${n}`,
      materials,
      instruction: rewriteInstruction(catalog, cfg),
      user: rewriteUser(n, t, slots, problems, outline, candidates),
      schema: PlanPageSchema,
      maxTokens: REWRITE_MAX_OUTPUT_TOKENS,
      budgetMs: cfg.ai.callBudgetMs,
      validate: (v) => {
        const allowed = candidates ? candidates.map((c) => c.key) : [t.key];
        if (!allowed.includes(v.type)) return `type は ${allowed.join(' か ')} にする`;
        return draftProblems([v], 1, catalog, { ...cfg, deck: { ...cfg.deck, maxSameTypeInRow: Number.MAX_SAFE_INTEGER } }, []);
      },
    });
    page = res;
    t = findType(catalog, page.type)!;
    ({ slots, broken } = normalize(t, page, a));
    // 2回目からは測定の検査の指摘だけで判断する（見た目の指摘は1回の書き直しで渡し終えている）
    problems = fixable(checkPage(n, t, slots, a.check));
  };
  while (problems.length && rewrites < cfg.ai.maxRewrites) {
    rewrites++;
    log(`${opts.stage} 書き直し p${n}（${rewrites}回目）: ${problems.map((p) => p.message).join(' / ')}`);
    await rewrite();
  }
  if (opts.allowRetype && problems.some((p) => p.code === 'OVERFLOW' || p.code === 'HEADLINE_LINES')) {
    const role = outline.pages[n - 1].role;
    const candidates = catalog.types.filter((c) => c.key !== t.key && c.role.includes(role));
    if (candidates.length) {
      retypedFrom = t.key;
      log(`${opts.stage} 型の替え p${n}: ${t.key} → 候補 ${candidates.map((c) => c.key).join(', ')}`);
      await rewrite(candidates);
      if (problems.length) {
        rewrites++;
        await rewrite();
      }
    }
  }
  capEmphasis(slots, catalog.emphasis.maxPerSlide, textSlots(t).map((s) => s.name));
  const trimmed = trimToFit(t, slots, a);
  return {
    type: t.key,
    slots,
    photos: Object.fromEntries(imageSlots(t).map((s) => [s.name, page.photos[s.name] ?? ''])),
    outlinePage: n,
    trimmed,
    phraseBroken: broken.filter((b) => !trimmed.includes(b)),
    rewrites,
    ...(retypedFrom ? { retypedFrom } : {}),
  };
}

async function runLimited(tasks: Array<() => Promise<unknown>>, limit: number) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      await tasks[i]();
    }
  });
  await Promise.all(workers);
}
