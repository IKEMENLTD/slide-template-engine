/**
 * JSON を返させる AI 呼び出し（REQUIREMENTS 9章）。段（A・B）はすべてここを通す。
 *
 * 考え方は IKEMENLTD/airlog@105d8ed src/lib/ai/slides/deck-design.ts の callForJson から移植した:
 *   - 予算（壁時計）に収まる出力量まで max_tokens を削る（maxTokensWithin。モデルの速度の関数）
 *   - 出力の上限を **常に** プロンプトで伝える（伝えないと長く書いて途中で切れる。9-3）
 *   - stop_reason が max_tokens の出力は保存せず、理由の分かる例外にする。ただし終端にしない（9-4）
 *   - 材料 → 段ごとの指示 の順に system を並べる（キャッシュの効き方が順序で決まる。9-6）
 * 本件で足したもの:
 *   - zod で検証し、足りない・形が違うときは理由を添えて作り直させる（9-5）。未知の欄は zod が捨てる
 *   - 使用量を毎回記録する（9-8）
 */
import type { z } from 'zod';
import { maxTokensWithin } from './time-budget.js';
import type { AiTransport, CompleteResult, SystemBlock } from './transport.js';
import type { AiUsage } from './model-failover.js';

/** これ未満の出力しか許されないなら、そのモデルでは時間内に書き切れない */
export const MIN_USABLE_OUTPUT_TOKENS = 1500;

export class AiBudgetError extends Error {}
/** 出力が上限で切れた（長さの問題なので、やり直しは可） */
export class AiTruncatedError extends Error {}
/** 何度やり直しても JSON の形にならない */
export class AiInvalidOutputError extends Error {}
export class AiRefusalError extends Error {}

export type AiCallRecord = AiUsage & { ms: number; stopReason: string; attempt: number; ok: boolean; error?: string };

export type AiContext = {
  transport: AiTransport;
  modelId: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 呼び出しの記録先（report.json に載せる） */
  record: (r: AiCallRecord) => void;
};

export function extractJson(text: string): string {
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return t;
}

/** AI が明示的に null を返すことがあるため undefined に正規化し zod の default を効かせる（AirLog の stripNulls） */
export function stripNulls(v: unknown): unknown {
  if (v === null) return undefined;
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = stripNulls(val);
    return o;
  }
  return v;
}

function zodSummary(err: z.ZodError): string {
  return err.issues
    .slice(0, 12)
    .map((i) => `- ${i.path.join('.') || '(全体)'}: ${i.message}`)
    .join('\n');
}

export async function callForJson<S extends z.ZodTypeAny>(
  ctx: AiContext,
  opts: {
    stage: string;
    /** 段をまたいで同じ材料（原稿・カタログ）。キャッシュに載せる */
    materials: string[];
    /** 段ごとの指示（system の最後） */
    instruction: string;
    user: string;
    schema: S;
    maxTokens: number;
    budgetMs: number;
    /** 形が違ったときに作り直させる回数（最初の1回を含まない） */
    retries?: number;
    /** 形は合っているが中身の決まりに反するときの検査。理由の文を返すと作り直させる */
    validate?: (v: z.infer<S>) => string | null;
  }
): Promise<z.infer<S>> {
  const system: SystemBlock[] = [...opts.materials.map((text) => ({ text, cache: true })), { text: opts.instruction, cache: false }];
  const inputChars = system.reduce((n, b) => n + b.text.length, 0) + opts.user.length;
  const allowed = Math.min(opts.maxTokens, maxTokensWithin({ modelId: ctx.modelId, budgetMs: opts.budgetMs, inputChars }));
  if (allowed < MIN_USABLE_OUTPUT_TOKENS) throw new AiBudgetError(`${opts.stage}: 時間の予算（${opts.budgetMs}ms）では、このモデルで書き切れない`);

  const retries = opts.retries ?? 2;
  let feedback = '';
  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    // ★上限は常に伝える（削ったときだけにすると、満額のときに書き続けて切れる）
    const user =
      opts.user +
      feedback +
      `\n\n出力は JSON のみとし、${Math.floor(allowed * 0.8)} トークン以内で必ず閉じてください。途中で切れると全部無駄になります。収まらない場合は各項目の記述を短くしてください（項目自体は省かない）。`;
    let res: CompleteResult;
    try {
      res = await ctx.transport.complete({ feature: opts.stage, modelId: ctx.modelId, system, user, maxTokens: allowed, remainingMs: opts.budgetMs, effort: ctx.effort });
    } catch (e) {
      ctx.record({ feature: opts.stage, model: ctx.modelId, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheDeclared: false, cacheHit: false, cacheIneffective: false, ms: 0, stopReason: 'error', attempt, ok: false, error: (e as Error).message });
      throw e;
    }
    const rec = (ok: boolean, error?: string) => ctx.record({ ...res.usage, ms: res.ms, stopReason: res.stopReason, attempt, ok, error });
    if (res.stopReason === 'refusal') {
      rec(false, 'refusal');
      throw new AiRefusalError(`${opts.stage}: AI が応答を断った`);
    }
    if (res.stopReason === 'max_tokens') {
      // ★保存しない。長さの問題なのでやり直しは可（終端にしない）
      lastError = `出力が上限（${allowed} トークン）に達し、JSON が途中で切れた`;
      rec(false, lastError);
      feedback = `\n\n【前回の出力は上限で途中で切れました。各項目をもっと短くしてください】`;
      if (attempt === retries) throw new AiTruncatedError(`${opts.stage}: ${lastError}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = stripNulls(JSON.parse(extractJson(res.text)));
    } catch {
      lastError = 'JSON として読めない';
      rec(false, lastError);
      feedback = `\n\n【前回の出力は JSON として読めませんでした。JSON だけを返してください】`;
      continue;
    }
    const v = opts.schema.safeParse(parsed);
    if (!v.success) {
      lastError = `形が違う:\n${zodSummary(v.error)}`;
      rec(false, lastError);
      feedback = `\n\n【前回の出力は次の点で形が違いました。直して全体を出し直してください】\n${zodSummary(v.error)}`;
      continue;
    }
    const problem = opts.validate?.(v.data);
    if (problem) {
      lastError = problem;
      rec(false, problem);
      feedback = `\n\n【前回の出力には次の問題がありました。直して全体を出し直してください】\n${problem}`;
      continue;
    }
    rec(true);
    return v.data;
  }
  throw new AiInvalidOutputError(`${opts.stage}: ${retries + 1}回とも使える出力にならなかった（${lastError.split('\n')[0]}）`);
}
