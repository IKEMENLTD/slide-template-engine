/**
 * C段：写真の用意（REQUIREMENTS 7章C・10章）。
 *
 * 1. 写真の割り当て（AI 1回）：B段が書いた「どんな写真が合うか」と、支給の写真の説明を突き合わせ、
 *    写真の欄ごとに「支給の写真を使う」か「生成する（場面の説明）」を決める。資料全体の登場人物・服装・場所も決める。
 *    同じページで同じ写真を使わない・1枚を使う回数・生成する枚数の上限はコードで確かめる。
 * 2. 生成：足りない分を1枚ずつ作る。2枚目からは、それまでに作った写真を見本として渡し、人物・服装・場所をそろえる。
 *    作った写真はすぐ保存する（落ちても、作った分は払い直さない）。
 * 3. 加工：枠の縦横比に切り抜く（人の顔など目立つところを残す）→ モノクロ → 設定に応じて乗算（prepare.ts）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import type { Catalog } from '../catalog/build-catalog.js';
import type { TemplateConfig } from '../catalog/config.js';
import { callForJson, type AiContext } from '../ai/call-json.js';
import { manuscriptBlock } from '../plan/prompts.js';
import type { DeckPlan } from '../plan/schema.js';
import { photoPrompt, sizeFor, type ImageGenerator } from './openai-image.js';
import { loadPhotoLibrary, processPhoto, resolveColor, type PhotoEntry } from './prepare.js';

export type PhotoRequest = { id: string; page: number; slot: string; want: string; aspect: number };

export const PhotoAssignSchema = z.object({
  /** 資料全体の登場人物・服装・場所（英語。生成のプロンプトにそのまま入れる） */
  cast: z.string().trim().min(10),
  assignments: z.array(
    z.object({
      id: z.string(),
      /** 支給の写真のファイル名か、生成した写真の番号（"gen:1" など） */
      use: z.string(),
      /** 生成するときの場面（英語・1〜2文） */
      scene: z.string().trim().optional(),
    })
  ),
});
export type PhotoAssign = z.infer<typeof PhotoAssignSchema>;

export type PhotoRecord = {
  id: string;
  page: number;
  slot: string;
  source: 'supplied' | 'generated' | 'template';
  file: string | null;
  scene?: string;
};

export type GeneratedRecord = { key: string; file: string; scene: string; size: string; costUsd: number; ms: number; withReferences: number; usage: unknown };

export const ASSIGN_MAX_OUTPUT_TOKENS = 8000;

export function collectRequests(plan: DeckPlan, catalog: Catalog): PhotoRequest[] {
  const out: PhotoRequest[] = [];
  plan.pages.forEach((p, i) => {
    const t = catalog.types.find((x) => x.key === p.type)!;
    for (const s of t.slots.filter((x) => x.kind === 'img'))
      out.push({ id: `p${String(i + 1).padStart(2, '0')}/${s.name}`, page: i + 1, slot: s.name, want: p.photos?.[s.name] ?? '', aspect: s.aspect! });
  });
  return out;
}

/** 割り当ての決まりに合っているか。合っていなければ AI に返す理由 */
export function assignProblems(a: PhotoAssign, reqs: PhotoRequest[], lib: PhotoEntry[], cfg: TemplateConfig): string | null {
  const out: string[] = [];
  const files = new Set(lib.map((e) => e.file));
  const byId = new Map(a.assignments.map((x) => [x.id, x]));
  const missing = reqs.filter((r) => !byId.has(r.id)).map((r) => r.id);
  if (missing.length) out.push(`割り当てが無い欄: ${missing.join(', ')}`);
  const gens = new Set<string>();
  const uses = new Map<string, number>();
  const perPage = new Map<number, string[]>();
  for (const r of reqs) {
    const x = byId.get(r.id);
    if (!x) continue;
    const isGen = /^gen:\d+$/.test(x.use);
    if (!isGen && !files.has(x.use)) out.push(`${r.id}: "${x.use}" は支給の写真に無い（ファイル名か "gen:番号"）`);
    if (isGen) {
      if (!gens.has(x.use) && !x.scene) out.push(`${r.id}: ${x.use} を初めて使うところに scene が無い`);
      gens.add(x.use);
    }
    uses.set(x.use, (uses.get(x.use) ?? 0) + 1);
    const pg = perPage.get(r.page) ?? [];
    if (pg.includes(x.use)) out.push(`p${r.page}: 同じ写真 ${x.use} を同じページで2回使っている`);
    pg.push(x.use);
    perPage.set(r.page, pg);
  }
  if (gens.size > cfg.photos.maxGenerate) out.push(`生成が ${gens.size} 枚。${cfg.photos.maxGenerate} 枚以下にする（同じ生成写真を別のページで使い回してよい）`);
  for (const [u, n] of uses) if (n > cfg.photos.maxUsesPerFile) out.push(`${u} を ${n} 回使っている。1枚は ${cfg.photos.maxUsesPerFile} 回まで`);
  return out.length ? out.join('\n') : null;
}

function assignInstruction(cfg: TemplateConfig) {
  return `あなたは、資料の写真を選ぶ担当です。写真の欄ごとに、支給の写真を使うか、新しく生成するかを決めます。
決まり:
- 欄の「求めるもの」に合う支給の写真があれば、それを使う（use にファイル名）。合わなければ生成する（use に "gen:1" のような番号と、scene に場面）。
- 同じページで同じ写真を2回使わない。1枚の写真（支給・生成とも）を使うのは資料全体で ${cfg.photos.maxUsesPerFile} 回まで。
- 生成は ${cfg.photos.maxGenerate} 枚まで。同じ生成写真（同じ番号）を別のページで使い回してよい。2回目以降は scene を省く。
- 写真には文字・数字・ロゴ・看板を入れない。紙面・図・グラフを写真で作らない。
- cast には、資料全体で同じにする登場人物・服装・場所を英語で書く（原稿の業種に合わせる。例: 作業着の色と形、制服、職場の場所）。人物は日本人。
- scene は英語で1〜2文。その場面で人が実際に業務をしている様子を書く（カメラに向かってポーズをとらない）。
出力（JSON のみ）:
{"cast": "...", "assignments": [{"id": "欄のid", "use": "01.jpg か gen:1", "scene": "..."}]}`;
}

export type PhotoStageArgs = {
  plan: DeckPlan;
  catalog: Catalog;
  cfg: TemplateConfig;
  manuscript: string;
  library: string | null;
  dir: string;
  ai: AiContext;
  /** 無ければ生成しない（生成の割り当ては見本の写真のままにする） */
  generator: ImageGenerator | null;
  log?: (m: string) => void;
};

const readJson = <T>(p: string): T | undefined => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : undefined);

export async function preparePhotos(a: PhotoStageArgs): Promise<{ records: PhotoRecord[]; generated: GeneratedRecord[] }> {
  const log = a.log ?? (() => {});
  const photoDir = path.join(a.dir, 'photos');
  const genDir = path.join(photoDir, 'generated');
  mkdirSync(genDir, { recursive: true });
  const lib = a.library ? loadPhotoLibrary(a.library) : [];
  const reqs = collectRequests(a.plan, a.catalog);
  if (!reqs.length) return { records: [], generated: [] };

  // 1. 割り当て
  const assignPath = path.join(photoDir, 'assign.json');
  let assign = readJson<PhotoAssign>(assignPath);
  if (!assign) {
    log('C段 写真の割り当て');
    assign = await callForJson(a.ai, {
      stage: 'C段 写真の割り当て',
      materials: [manuscriptBlock(a.manuscript)],
      instruction: assignInstruction(a.cfg),
      user:
        `支給の写真（${lib.length}枚）:\n${lib.map((e) => `- ${e.file}: ${e.description || '（説明なし）'}`).join('\n') || '（なし）'}\n\n` +
        `写真の欄（${reqs.length}個。aspect は幅÷高さ）:\n${reqs.map((r) => `- id=${r.id} aspect=${r.aspect} 求めるもの: ${r.want || '（指定なし）'}`).join('\n')}`,
      schema: PhotoAssignSchema,
      maxTokens: ASSIGN_MAX_OUTPUT_TOKENS,
      budgetMs: a.cfg.ai.callBudgetMs,
      validate: (v) => assignProblems(v, reqs, lib, a.cfg),
    });
    writeFileSync(assignPath, JSON.stringify(assign, null, 2) + '\n');
  }
  const byId = new Map(assign.assignments.map((x) => [x.id, x]));

  // 2. 生成（1枚ずつ。作ったらすぐ保存）
  const genPath = path.join(photoDir, 'generated.json');
  const generated: GeneratedRecord[] = readJson<GeneratedRecord[]>(genPath) ?? [];
  const order = [...new Set(reqs.map((r) => byId.get(r.id)!.use).filter((u) => u.startsWith('gen:')))];
  if (order.length && a.generator) {
    for (const key of order) {
      if (generated.some((g) => g.key === key)) continue;
      const first = reqs.find((r) => byId.get(r.id)!.use === key)!;
      const scene = byId.get(first.id)!.scene ?? first.want;
      const size = sizeFor(first.aspect);
      // 見本は、最初に作った写真と直前に作った写真（人物・服装・場所をそろえる。10章）
      const refs = [...new Set([generated[0], generated[generated.length - 1]].filter(Boolean).map((g) => g!.file))].map((f) => readFileSync(path.join(photoDir, f)));
      log(`C段 写真の生成 ${key}（${size}・見本 ${refs.length}枚）: ${scene}`);
      const img = await a.generator({ prompt: photoPrompt(assign.cast, scene, refs.length > 0), size, references: refs });
      const file = `generated/${key.replace(':', '-')}.jpg`;
      writeFileSync(path.join(photoDir, file), img.jpeg);
      generated.push({ key, file, scene, size, costUsd: img.costUsd, ms: img.ms, withReferences: img.withReferences, usage: img.usage });
      writeFileSync(genPath, JSON.stringify(generated, null, 2) + '\n');
    }
  }

  // 3. 加工して設計図に書く
  const records: PhotoRecord[] = [];
  for (const r of reqs) {
    const x = byId.get(r.id)!;
    const page = a.plan.pages[r.page - 1];
    page.photoFiles ??= {};
    let src: string | null = null;
    let source: PhotoRecord['source'] = 'template';
    if (x.use.startsWith('gen:')) {
      const g = generated.find((y) => y.key === x.use);
      if (g) {
        src = path.join(photoDir, g.file);
        source = 'generated';
      }
    } else {
      const e = lib.find((y) => y.file === x.use);
      if (e) {
        src = e.path;
        source = 'supplied';
      }
    }
    if (!src) {
      // 生成しない設定（--no-generate）では、見本の写真のまま
      delete page.photoFiles[r.slot];
      records.push({ id: r.id, page: r.page, slot: r.slot, source, file: null });
      continue;
    }
    const proc = a.catalog.types.find((t) => t.key === page.type)!.slots.find((s) => s.name === r.slot)!.process ?? { mono: true, multiply: null };
    const name = `p${String(r.page).padStart(2, '0')}-${r.slot.replace(/[^\w.-]/g, '_')}.jpg`;
    await processPhoto(src, path.join(photoDir, name), r.aspect, proc, resolveColor(proc.multiply, a.catalog.theme.colors));
    page.photoFiles[r.slot] = name;
    records.push({ id: r.id, page: r.page, slot: r.slot, source, file: x.use, ...(x.scene ? { scene: x.scene } : {}) });
  }

  // 人が「文字が入っていないか」を見る一覧（生成した写真を加工前の色のまま並べる。15章 Phase 3）
  if (generated.length) await contactSheet(generated.map((g) => path.join(photoDir, g.file)), path.join(photoDir, 'generated-sheet.jpg'));
  return { records, generated };
}

export async function contactSheet(files: string[], out: string, tile = 480) {
  const cols = Math.min(4, files.length);
  const rows = Math.ceil(files.length / cols);
  const tiles = await Promise.all(files.map((f) => sharp(f).resize(tile, tile, { fit: 'contain', background: '#ffffff' }).jpeg().toBuffer()));
  await sharp({ create: { width: cols * tile + (cols - 1) * 8, height: rows * tile + (rows - 1) * 8, channels: 3, background: '#cccccc' } })
    .composite(tiles.map((t, i) => ({ input: t, left: (i % cols) * (tile + 8), top: Math.floor(i / cols) * (tile + 8) })))
    .jpeg({ quality: 85 })
    .toFile(out);
}
