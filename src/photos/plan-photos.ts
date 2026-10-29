/**
 * C段：写真の用意（REQUIREMENTS 7章C・10章）。
 *
 * 1. 写真の割り当て（AI 1回）：B段が書いた「どんな写真が合うか」と、支給の写真の説明を突き合わせ、
 *    写真の欄ごとに「支給の写真を使う」か「生成する（場面の説明）」を決める。資料全体の登場人物・服装・場所も決める。
 *    同じページで同じ写真を使わない・1枚を使う回数・生成する枚数の上限はコードで確かめる。
 * 2. 生成：足りない分を1枚ずつ作る。2枚目からは、それまでに作った写真を見本として渡し、人物・服装・場所をそろえる。
 *    作った写真はすぐ保存する（落ちても、作った分は払い直さない）。
 * 3. 加工：枠の縦横比に切り抜く → モノクロ → 設定に応じて乗算（prepare.ts）。
 *    写真の上に図形が重なる欄では、顔が「見えている部分」に入る位置・拡大・（生成写真だけ）左右反転を選ぶ。
 *    それでも顔が隠れる生成写真は、人の位置を指定して作り直す（photos.maxRegenerate 枚まで）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import type { Catalog } from '../catalog/build-catalog.js';
import type { TemplateConfig } from '../catalog/config.js';
import { callForJson, type AiContext } from '../ai/call-json.js';
import { manuscriptBlock } from '../plan/prompts.js';
import type { DeckPlan } from '../plan/schema.js';
import { photoPrompt, sizeFor, type ImageGenerator } from './openai-image.js';
import { PEOPLE_RULE, type PhotoPeople } from '../plan/locale.js';
import { loadPhotoLibrary, processPhoto, resolveColor, type PhotoEntry, type PhotoFit } from './prepare.js';
import { NO_FACE_HINT, openAreaHint, visKey, type VisibilityMap } from './visibility.js';

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
export type { PhotoFit };

export function collectRequests(plan: DeckPlan, catalog: Catalog): PhotoRequest[] {
  const out: PhotoRequest[] = [];
  plan.pages.forEach((p, i) => {
    const t = catalog.types.find((x) => x.key === p.type)!;
    for (const s of t.slots.filter((x) => x.kind === 'img'))
      out.push({ id: `p${String(i + 1).padStart(2, '0')}/${s.name}`, page: i + 1, slot: s.name, want: p.photos?.[s.name] ?? '', aspect: s.aspect! });
  });
  return out;
}

/**
 * 人の顔を入れない欄か。設定 photos.faceless に書いた欄と、写真に色を重ねる（乗算する）欄。
 * 先方の見本 PDF でも、青く着色した写真は建物・街並みで、人の顔は入れていない（D-042）
 */
export const isFaceless = (cfg: TemplateConfig, type: string, slot: string) => !!cfg.photos.faceless[type]?.includes(slot) || !!cfg.images[slot]?.multiply;

/**
 * 割り当てが抜けた欄を、コードで埋める（20ページの資料で、AI が3回とも1欄だけ抜かして作成が止まった。2026-10-28）。
 * 同じ資料の生成写真のうち、使う回数に余りがあり、そのページでまだ使っていないものを使い回す。無ければ見本の写真のまま
 */
export function fillMissing(a: PhotoAssign, reqs: PhotoRequest[], cfg: TemplateConfig, faceless: (r: PhotoRequest) => boolean = () => false): PhotoAssign {
  const have = new Set(a.assignments.map((x) => x.id));
  const missing = reqs.filter((r) => !have.has(r.id));
  if (!missing.length) return a;
  const out = [...a.assignments];
  const uses = new Map<string, number>();
  const pageOf = new Map(reqs.map((r) => [r.id, r.page]));
  const reqOf = new Map(reqs.map((r) => [r.id, r]));
  for (const x of out) uses.set(x.use, (uses.get(x.use) ?? 0) + 1);
  // 顔を写さない欄には、顔を写さない欄で使っている写真だけを回す（逆も同じ）
  const sameKind = (u: string, r: PhotoRequest) => out.filter((x) => x.use === u).every((x) => { const q = reqOf.get(x.id); return !q || faceless(q) === faceless(r); });
  for (const r of missing) {
    const onPage = new Set(out.filter((x) => pageOf.get(x.id) === r.page).map((x) => x.use));
    const pick = [...uses.keys()].filter((u) => /^gen:\d+$/.test(u) && (uses.get(u) ?? 0) < cfg.photos.maxUsesPerFile && !onPage.has(u) && sameKind(u, r)).sort((x, y) => (uses.get(x) ?? 0) - (uses.get(y) ?? 0))[0];
    out.push({ id: r.id, use: pick ?? TEMPLATE_PHOTO });
    if (pick) uses.set(pick, (uses.get(pick) ?? 0) + 1);
  }
  return { ...a, assignments: sceneFirst(out.map((x) => ({ ...x })), reqs) };
}
/** 割り当てで「見本の写真のまま」を表す印 */
export const TEMPLATE_PHOTO = 'template';

/** 生成写真の場面（scene）を、その写真を最初に使う欄（資料の順）に置く。生成は最初に使う欄の場面で作るため */
function sceneFirst(out: PhotoAssign['assignments'], reqs: PhotoRequest[]): PhotoAssign['assignments'] {
  const order = new Map(reqs.map((r, i) => [r.id, i]));
  const sorted = [...out].sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0));
  for (const u of new Set(sorted.filter((x) => /^gen:\d+$/.test(x.use)).map((x) => x.use))) {
    const uses = sorted.filter((x) => x.use === u);
    const scene = uses.find((x) => x.scene)?.scene;
    uses.forEach((x, i) => {
      if (i === 0 && scene) x.scene = scene;
      else if (i > 0) delete x.scene;
    });
  }
  return out;
}

/**
 * 顔を写さない欄と写してよい欄で同じ生成写真を使っていたら、顔を写さない欄の側を別の写真に分ける
 * （AI に決まりを伝えても、3回とも使い回して作成が止まった。2026-10-28）。
 * 顔を写さない欄だけで使っている生成写真を回すか、新しく作る（場面は元の写真と同じ。生成で顔を写さないよう指示する）。場面が分からなければ見本の写真のまま
 */
export function separateFaceless(a: PhotoAssign, reqs: PhotoRequest[], cfg: TemplateConfig, faceless: (r: PhotoRequest) => boolean): PhotoAssign {
  const reqOf = new Map(reqs.map((r) => [r.id, r]));
  const out = a.assignments.map((x) => ({ ...x }));
  const isGen = (u: string) => /^gen:\d+$/.test(u);
  const kinds = (u: string) => new Set(out.filter((x) => x.use === u && reqOf.get(x.id)).map((x) => faceless(reqOf.get(x.id)!)));
  const sceneOf = (u: string) => out.find((x) => x.use === u && x.scene)?.scene;
  const gens = () => new Set(out.filter((x) => isGen(x.use)).map((x) => x.use));
  for (const x of out) {
    const r = reqOf.get(x.id);
    if (!r || !isGen(x.use) || !faceless(r) || kinds(x.use).size < 2) continue;
    const scene = sceneOf(x.use);
    const onPage = new Set(out.filter((y) => reqOf.get(y.id)?.page === r.page && y !== x).map((y) => y.use));
    const reuse = [...gens()].find((u) => u !== x.use && !onPage.has(u) && [...kinds(u)].every(Boolean) && out.filter((y) => y.use === u).length < cfg.photos.maxUsesPerFile);
    if (reuse) {
      x.use = reuse;
      delete x.scene;
    } else if (scene) {
      // 生成の上限（maxGenerate）は AI の選び方への決まり。分けるための生成は、顔を写さない欄の数までに収まるので上限の外で作る
      // （上限で止めて見本の写真に戻すと、工場の資料にオフィスの見本写真が入った。2026-10-28）
      const n = Math.max(0, ...[...gens()].map((u) => Number(u.slice(4)))) + 1;
      x.use = `gen:${n}`;
      x.scene = scene;
    } else {
      x.use = TEMPLATE_PHOTO;
      delete x.scene;
    }
  }
  return { ...a, assignments: sceneFirst(out, reqs) };
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
    if (x.use === TEMPLATE_PHOTO) continue;
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

function assignInstruction(cfg: TemplateConfig, people: PhotoPeople) {
  return `あなたは、資料の写真を選ぶ担当です。写真の欄ごとに、支給の写真を使うか、新しく生成するかを決めます。
決まり:
- 欄の「求めるもの」に合う支給の写真があれば、それを使う（use にファイル名）。合わなければ生成する（use に "gen:1" のような番号と、scene に場面）。
- 同じページで同じ写真を2回使わない。1枚の写真（支給・生成とも）を使うのは資料全体で ${cfg.photos.maxUsesPerFile} 回まで。
- 生成は ${cfg.photos.maxGenerate} 枚まで。同じ生成写真（同じ番号）を別のページで使い回してよい。2回目以降は scene を省く。
- 写真には文字・数字・ロゴ・看板を入れない。紙面・図・グラフを写真で作らない。
- cast には、資料全体で同じにする登場人物・服装・場所を英語で書く（原稿の業種に合わせる。例: 作業着の色と形、制服、職場の場所）。${PEOPLE_RULE[people]}
- scene は英語で1〜2文。その場面で人が実際に業務をしている様子を書く（カメラに向かってポーズをとらない）。
- 「顔を写さない」と書いた欄は、人の顔が写らない場面にする（職場・機械・物・手元・後ろ姿・遠景）。顔の写る写真をその欄に使わない。
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
  /** 欄ごとの「図形に隠れず見えている部分」（visibility.ts）。無ければ顔を枠に残すことだけを考える */
  visibility?: VisibilityMap | null;
  /** 写真に写る人物（D-043）。無ければ日本人 */
  people?: PhotoPeople;
  log?: (m: string) => void;
};

const readJson = <T>(p: string): T | undefined => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : undefined);

export async function preparePhotos(a: PhotoStageArgs): Promise<{ records: PhotoRecord[]; generated: GeneratedRecord[]; generationError?: string }> {
  const log = a.log ?? (() => {});
  const photoDir = path.join(a.dir, 'photos');
  const genDir = path.join(photoDir, 'generated');
  mkdirSync(genDir, { recursive: true });
  const lib = a.library ? loadPhotoLibrary(a.library) : [];
  const reqs = collectRequests(a.plan, a.catalog);
  if (!reqs.length) return { records: [], generated: [] };

  const facelessReq = (r: PhotoRequest) => isFaceless(a.cfg, a.plan.pages[r.page - 1].type, r.slot);
  // 1. 割り当て
  const assignPath = path.join(photoDir, 'assign.json');
  let assign = readJson<PhotoAssign>(assignPath);
  if (!assign) {
    log('C段 写真の割り当て');
    assign = await callForJson(a.ai, {
      stage: 'C段 写真の割り当て',
      materials: [manuscriptBlock(a.manuscript)],
      instruction: assignInstruction(a.cfg, a.people ?? 'japanese'),
      user:
        `支給の写真（${lib.length}枚）:\n${lib.map((e) => `- ${e.file}: ${e.description || '（説明なし）'}`).join('\n') || '（なし）'}\n\n` +
        `写真の欄（${reqs.length}個。aspect は幅÷高さ）:\n${reqs.map((r) => `- id=${r.id} aspect=${r.aspect}${isFaceless(a.cfg, a.plan.pages[r.page - 1].type, r.slot) ? ' 顔を写さない' : ''} 求めるもの: ${r.want || '（指定なし）'}`).join('\n')}`,
      schema: PhotoAssignSchema,
      maxTokens: ASSIGN_MAX_OUTPUT_TOKENS,
      budgetMs: a.cfg.ai.callBudgetMs,
      // 欄の抜けと、顔を写さない欄の写真の分けはコードで直すので、AI にはやり直させない
      validate: (v) => assignProblems(fillMissing(v, reqs, a.cfg, facelessReq), reqs, lib, a.cfg),
    });
    const filled = separateFaceless(fillMissing(assign, reqs, a.cfg, facelessReq), reqs, a.cfg, facelessReq);
    const changed = filled.assignments.filter((x) => assign!.assignments.find((y) => y.id === x.id)?.use !== x.use);
    if (changed.length) log(`C段 割り当てをコードで直した（抜けた欄・顔を写さない欄の分け）: ${changed.map((x) => `${x.id}=${x.use}`).join(', ')}`);
    assign = filled;
    writeFileSync(assignPath, JSON.stringify(assign, null, 2) + '\n');
  }
  const byId = new Map(assign.assignments.map((x) => [x.id, x]));

  // 2. 生成（1枚ずつ。作ったらすぐ保存）
  const genPath = path.join(photoDir, 'generated.json');
  let generationError: string | undefined;
  const generated: GeneratedRecord[] = readJson<GeneratedRecord[]>(genPath) ?? [];
  const order = [...new Set(reqs.map((r) => byId.get(r.id)!.use).filter((u) => u.startsWith('gen:')))];
  if (order.length && a.generator) {
    for (const key of order) {
      if (generated.some((g) => g.key === key)) continue;
      const first = reqs.find((r) => byId.get(r.id)!.use === key)!;
      const scene = byId.get(first.id)!.scene ?? first.want;
      const size = sizeFor(first.aspect);
      const firstPage = a.plan.pages[first.page - 1];
      const grid = a.visibility?.[visKey(firstPage)]?.[first.slot];
      // 見本は、最初に作った写真と直前に作った写真（人物・服装・場所をそろえる。10章）
      const refs = [...new Set([generated[0], generated[generated.length - 1]].filter(Boolean).map((g) => g!.file))].map((f) => readFileSync(path.join(photoDir, f)));
      log(`C段 写真の生成 ${key}（${size}・見本 ${refs.length}枚）: ${scene}`);
      let img: Awaited<ReturnType<ImageGenerator>>;
      try {
        const composition = isFaceless(a.cfg, firstPage.type, first.slot) ? NO_FACE_HINT : grid ? openAreaHint(grid) : null;
        img = await a.generator({ prompt: photoPrompt(assign.cast, scene, refs.length > 0, composition, a.people), size, references: refs });
      } catch (e) {
        // 生成できない（残高切れ・鍵の誤り・通信）ときも資料は仕上げる。残りの欄は見本の写真のまま、注意 PHOTO_NOT_GENERATED で知らせる
        generationError = genErrorText(e);
        log(`C段 写真の生成ができなかった。残りの写真は見本のまま: ${generationError}`);
        break;
      }
      const file = `generated/${key.replace(':', '-')}.jpg`;
      writeFileSync(path.join(photoDir, file), img.jpeg);
      generated.push({ key, file, scene, size, costUsd: img.costUsd, ms: img.ms, withReferences: img.withReferences, usage: img.usage });
      writeFileSync(genPath, JSON.stringify(generated, null, 2) + '\n');
    }
  }

  // 3. 加工して設計図に書く
  const records: PhotoRecord[] = [];
  let regenerated = generated.filter((g) => /-fix\d+$/.test(g.key)).length;
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
    const slot = a.catalog.types.find((t) => t.key === page.type)!.slots.find((s) => s.name === r.slot)!;
    const proc = slot.process ?? { mono: true, multiply: null };
    const name = `p${String(r.page).padStart(2, '0')}-${r.slot.replace(/[^\w.-]/g, '_')}.jpg`;
    const grid = a.visibility?.[visKey(page)]?.[r.slot] ?? null;
    // 描いたときに 96dpi を下回るほどは拡大しない（欄の幅は pt）
    const fitOpts = { grid, allowFlip: source === 'generated', minCropWidth: (slot.box.w * 96) / 72 };
    const color = resolveColor(proc.multiply, a.catalog.theme.colors);
    let { fit } = await processPhoto(src, path.join(photoDir, name), r.aspect, proc, color, 1600, fitOpts);
    // 生成した写真で顔が隠れるなら、人の位置を指定して作り直す（良くなったときだけ差し替える）
    // 1つの欄で2回まで（1回目で直らない写真がある。2026-10-27 実例 0 → 0.35）
    // 顔を入れない欄（photos.faceless）は、顔が1つでも写れば作り直す
    const base = source === 'generated' ? generated.find((g) => g.key === x.use)! : null;
    const faceless = isFaceless(a.cfg, page.type, r.slot);
    const score = (f: PhotoFit) => (faceless ? (f.faces === 0 ? 1 : 0) : (f.faceVisible ?? 1));
    const bad = (f: PhotoFit) => (faceless ? f.faces > 0 : !!grid && f.faceVisible !== null && f.faceVisible < a.cfg.photos.minFaceVisible);
    for (let tries = 0; base && a.generator && bad(fit) && tries < 2 && regenerated < a.cfg.photos.maxRegenerate; tries++) {
      regenerated++;
      const key = `${x.use}-fix${regenerated}`;
      // 作り直すときは、欄の広さに関係なく顔を1人にする（何人もの顔があると、どこかが図形に入る）
      const hint = faceless ? NO_FACE_HINT : openAreaHint(grid!, { oneFace: true });
      log(`C段 写真の作り直し ${key}（${r.id}・${faceless ? `顔を入れない欄に顔が ${fit.faces}つ` : `顔の見えている割合 ${fit.faceVisible}`}）`);
      const refs = [readFileSync(path.join(photoDir, base.file))];
      let img: Awaited<ReturnType<ImageGenerator>>;
      try {
        img = await a.generator({ prompt: photoPrompt(assign.cast, base.scene, true, hint, a.people), size: base.size, references: refs });
      } catch (e) {
        generationError ??= genErrorText(e);
        log(`C段 写真の作り直しができなかった。いまの写真のまま: ${generationError}`);
        break;
      }
      const file = `generated/${key.replace(':', '-')}.jpg`;
      writeFileSync(path.join(photoDir, file), img.jpeg);
      generated.push({ key, file, scene: base.scene, size: base.size, costUsd: img.costUsd, ms: img.ms, withReferences: img.withReferences, usage: img.usage });
      writeFileSync(genPath, JSON.stringify(generated, null, 2) + '\n');
      const tryName = name.replace(/\.jpg$/, '-fix.jpg');
      const retry = await processPhoto(path.join(photoDir, file), path.join(photoDir, tryName), r.aspect, proc, color, 1600, fitOpts);
      if (score(retry.fit) > score(fit)) {
        renameSync(path.join(photoDir, tryName), path.join(photoDir, name));
        fit = retry.fit;
        x.use = key;
      } else rmSync(path.join(photoDir, tryName), { force: true });
    }
    page.photoFiles[r.slot] = name;
    (page.photoFit ??= {})[r.slot] = fit;
    records.push({ id: r.id, page: r.page, slot: r.slot, source, file: x.use, ...(x.scene ? { scene: x.scene } : {}) });
  }

  // 人が「文字が入っていないか」を見る一覧（生成した写真を加工前の色のまま並べる。15章 Phase 3）
  if (generated.length) await contactSheet(generated.map((g) => path.join(photoDir, g.file)), path.join(photoDir, 'generated-sheet.jpg'));
  return { records, generated, ...(generationError ? { generationError } : {}) };
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

/** 生成の失敗を1行に（OpenAI の返す message を取り出す。鍵らしき文字列は伏せる） */
export function genErrorText(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  const head = m.split('\n')[0].replace(/[:：]\s*\{\s*$/, '');
  const msg = m.match(/"message"\s*:\s*"([^"]*)"/)?.[1];
  return `${head}${msg ? `: ${msg}` : ''}`.replace(/sk-[\w*-]{6,}/g, 'sk-…').slice(0, 300);
}

/** 見た目の採点の写真の指摘のうち、人の顔・頭が隠れる・切れるもの（顔の検出が横顔やうつむいた顔を見逃すときの受け皿） */
export const isFaceProblem = (message: string) => /顔|頭|\bfaces?\b|\bheads?\b/i.test(message);

/**
 * 見た目の採点で「顔が隠れている」と指摘されたページの写真を作り直す（E段・D-042）。
 * 顔の検出は横顔・うつむいた顔を見逃す（2026-10-28 表紙の実例）ので、描いた画面を見た採点の指摘を使う。
 * 作り直せるのは、この資料のために生成した写真だけ（支給の写真は変えない）。結果は次の回の採点で確かめる。
 * 作り直した欄の名前を返す
 */
export async function redoPhotosForReview(
  a: { plan: DeckPlan; catalog: Catalog; cfg: TemplateConfig; dir: string; generator: ImageGenerator | null; visibility: VisibilityMap | null; people?: PhotoPeople; log?: (m: string) => void },
  pageNo: number,
  slot: string | undefined
): Promise<string[]> {
  const log = a.log ?? (() => {});
  const photoDir = path.join(a.dir, 'photos');
  const genPath = path.join(photoDir, 'generated.json');
  const donePath = path.join(photoDir, 'done.json');
  const assign = readJson<PhotoAssign>(path.join(photoDir, 'assign.json'));
  const generated = readJson<GeneratedRecord[]>(genPath) ?? [];
  const done = readJson<{ records: PhotoRecord[] } & Record<string, unknown>>(donePath);
  if (!a.generator || !assign || !done) return [];
  const page = a.plan.pages[pageNo - 1];
  const t = a.catalog.types.find((x) => x.key === page.type);
  if (!t) return [];
  const slots = t.slots.filter((s) => s.kind === 'img' && (!slot || s.name === slot || !t.slots.some((x) => x.name === slot)));
  const out: string[] = [];
  for (const s of slots) {
    const used = generated.filter((g) => /-(fix|rv)\d+$/.test(g.key)).length;
    if (used >= a.cfg.photos.maxRegenerate) break;
    const rec = done.records.find((r) => r.page === pageNo && r.slot === s.name);
    const base = rec?.source === 'generated' ? generated.find((g) => g.key === rec.file) : undefined;
    if (!rec || !base) continue;
    const key = `${rec.file}-rv${used + 1}`;
    const faceless = isFaceless(a.cfg, page.type, s.name);
    const grid = a.visibility?.[visKey(page)]?.[s.name] ?? null;
    const hint = faceless ? NO_FACE_HINT : grid ? openAreaHint(grid, { oneFace: true }) : null;
    log(`E段 写真の作り直し ${key}（p${pageNo}/${s.name}・見た目の採点で顔の指摘）`);
    let img: Awaited<ReturnType<ImageGenerator>>;
    try {
      img = await a.generator({ prompt: photoPrompt(assign.cast, base.scene, true, hint, a.people), size: base.size, references: [readFileSync(path.join(photoDir, base.file))] });
    } catch (e) {
      log(`E段 写真の作り直しができなかった。いまの写真のまま: ${genErrorText(e)}`);
      break;
    }
    const file = `generated/${key.replace(':', '-')}.jpg`;
    writeFileSync(path.join(photoDir, file), img.jpeg);
    generated.push({ key, file, scene: base.scene, size: base.size, costUsd: img.costUsd, ms: img.ms, withReferences: img.withReferences, usage: img.usage });
    writeFileSync(genPath, JSON.stringify(generated, null, 2) + '\n');
    const proc = s.process ?? { mono: true, multiply: null };
    const name = `p${String(pageNo).padStart(2, '0')}-${s.name.replace(/[^\w.-]/g, '_')}-rv${used + 1}.jpg`;
    const { fit } = await processPhoto(path.join(photoDir, file), path.join(photoDir, name), s.aspect!, proc, resolveColor(proc.multiply, a.catalog.theme.colors), 1600, {
      grid,
      allowFlip: true,
      minCropWidth: (s.box.w * 96) / 72,
    });
    (page.photoFiles ??= {})[s.name] = name;
    (page.photoFit ??= {})[s.name] = fit;
    rec.file = key;
    writeFileSync(donePath, JSON.stringify(done, null, 2) + '\n');
    out.push(s.name);
  }
  return out;
}
