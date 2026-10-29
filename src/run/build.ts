/**
 * slidegen build の本体（REQUIREMENTS 5章・12章）。
 * 段ごとの結果を out/<実行ID>/ に保存し、落ちても --resume で続きから再開できる（原則6）。
 *
 *   run.json            何を・どの設定で作っているか
 *   input.md            原稿の写し
 *   template.pptx       テンプレートの写し（途中でテンプレートが変わっても混ざらない）
 *   catalog.json        型カタログ
 *   config.json         設定の写し
 *   outline.json        A段の結果
 *   plan/               B段の途中の結果（下書き・ページごと）
 *   deck-plan.json      B段の結果（設計図）
 *   photos/             加工済みの写真
 *   deck.pptx           成果物
 *   ai-calls.jsonl      AI の呼び出しごとの使用量（1行1回。落ちても残る）
 *   report.json / .md   検査結果・使用トークン・実費の概算
 */
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildCatalog, type Catalog } from '../catalog/build-catalog.js';
import { ConfigSchema, type TemplateConfig } from '../catalog/config.js';
import { readTemplate } from '../catalog/read-template.js';
import type { AiCallRecord, AiContext } from '../ai/call-json.js';
import { costUsd } from '../ai/models.js';
import type { AiTransport } from '../ai/transport.js';
import { assembleDeck } from '../assemble/build-deck.js';
import { issue, type Issue } from '../check/content.js';
import { checkLightDark } from '../check/light-dark.js';
import { renderDeck, renderIssues, type RenderResult } from '../render/render.js';
import { latestReview, pagesToRedo, reviewIssues, reviewPages, type PageReview } from '../review/visual.js';
import JSZip from 'jszip';
import { checkDeck } from '../check/deck-check.js';
import { checkPage, type SlotCheckContext } from '../check/slots.js';
import { sourceNumbers } from '../check/content.js';
import { makeOutline } from '../plan/outline.js';
import { fixPage, planDeck, type PlanStore } from '../plan/plan.js';
import type { DeckPlan, Outline } from '../plan/schema.js';
import { isFaceProblem, preparePhotos, redoPhotosForReview, type GeneratedRecord, type PhotoRecord } from '../photos/plan-photos.js';
import { ensureVisibility } from '../photos/visibility.js';
import { chooseMirrors } from '../plan/mirror-plan.js';
import { localeOf, type DeckLanguage, type DeckLocale, type PhotoPeople } from '../plan/locale.js';
import type { ImageGenerator } from '../photos/openai-image.js';

export type RunInfo = {
  id: string;
  createdAt: string;
  input: string;
  template: string;
  photos: string | null;
  targetSlides?: number;
  transport: string;
  model: string;
  /** 資料の言語と写真の人物（D-043）。無ければ日本語・日本人 */
  language?: DeckLanguage;
  people?: PhotoPeople;
};

/** 進み具合の段（画面に出す）。done は検査まで終わったとき */
export type BuildStep = 'outline' | 'plan' | 'photos' | 'assemble' | 'render' | 'review' | 'redo' | 'check' | 'done';

export type BuildOptions = {
  root: string;
  outDir: string;
  /** 新しく作るとき */
  input?: string;
  template?: string;
  config?: string;
  photos?: string | null;
  targetSlides?: number;
  /** 資料の言語と写真の人物（D-043）。新しく作るときだけ使う（再開は run.json の記録に従う） */
  locale?: Partial<DeckLocale>;
  /** 続きから再開するとき（out/<実行ID>） */
  resume?: string;
  transport: AiTransport;
  /** 設定の ai.model を上書きする */
  model?: string;
  /** 写真を生成する口。null なら生成しない（生成を割り当てた欄は見本の写真のまま） */
  imageGenerator: ImageGenerator | null;
  log?: (m: string) => void;
  /** 段に入るたびに呼ぶ（画面の進み具合。detail は「2回目・5ページ」など） */
  progress?: (step: BuildStep, detail?: string) => void;
  /** 実行ID を決めたときに呼ぶ（画面が作成中の資料を開けるように） */
  onRunId?: (id: string, dir: string) => void;
  /** 新しく作るときの実行ID（画面が先に決めて渡す。無ければ原稿の名前と時刻から作る） */
  runId?: string;
  /** false なら描画しない（描画・見た目の採点・明暗の比を飛ばす。試験用） */
  render?: boolean;
  /** テンプレートごとに測った値（写真の欄の見えている部分）を保存する場所。無ければ <root>/.cache */
  cacheDir?: string;
  /** 試験用：指定した段が終わったところで止める */
  stopAfter?: 'outline' | 'plan' | 'photos' | 'assemble';
};

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const writeJson = (p: string, v: unknown) => {
  mkdirSync(path.dirname(p), { recursive: true });
  // 書きかけのファイルを残さない（途中で落ちても、前の版か新しい版のどちらか）
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  renameSync(tmp, p);
};

function newRunId(input: string) {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${path.basename(input).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_')}`;
}

export type BuildResult = { dir: string; issues: Issue[]; errors: number; warnings: number; stoppedAfter?: string };

export async function build(o: BuildOptions): Promise<BuildResult> {
  const log = o.log ?? ((m) => console.log(m));
  const progress = o.progress ?? (() => {});
  const resolveRepo = (p: string) => (path.isAbsolute(p) ? p : path.join(o.root, p));

  // ---- 実行のフォルダ
  let dir: string;
  let info: RunInfo;
  if (o.resume) {
    dir = path.resolve(o.resume);
    if (!existsSync(path.join(dir, 'run.json'))) throw new Error(`${dir} に run.json が無い（続きから再開できない）`);
    info = readJson<RunInfo>(path.join(dir, 'run.json'));
    log(`続きから再開: ${path.relative(o.root, dir)}`);
  } else {
    if (!o.input || !o.template) throw new Error('--input と --template が要る');
    const id = o.runId ?? newRunId(o.input);
    dir = path.join(o.outDir, id);
    mkdirSync(dir, { recursive: true });
    copyFileSync(o.input, path.join(dir, 'input.md'));
    copyFileSync(o.template, path.join(dir, 'template.pptx'));
    const cfgPath = o.config ?? o.template.replace(/\.pptx$/i, '.config.json');
    const cfg = ConfigSchema.parse(readJson(cfgPath));
    if (o.model) cfg.ai.model = o.model;
    writeJson(path.join(dir, 'config.json'), cfg);
    const buf = readFileSync(o.template);
    const { catalog, problems } = buildCatalog(await readTemplate(buf), cfg, {
      file: path.relative(o.root, o.template),
      sha256: createHash('sha256').update(buf).digest('hex'),
      resolveFile: resolveRepo,
    });
    const errs = problems.filter((p) => p.level === 'error');
    if (errs.length) throw new Error(`型カタログに止める問題がある:\n${errs.map((p) => `${p.where}: ${p.message}`).join('\n')}`);
    writeJson(path.join(dir, 'catalog.json'), catalog);
    info = {
      id,
      createdAt: new Date().toISOString(),
      input: path.resolve(o.input),
      template: path.relative(o.root, o.template),
      photos: o.photos === null ? null : path.resolve(o.photos ?? path.join(o.root, 'assets/photos')),
      ...(o.targetSlides ? { targetSlides: o.targetSlides } : {}),
      transport: o.transport.name,
      model: cfg.ai.model,
      ...localeOf(o.locale),
    };
    writeJson(path.join(dir, 'run.json'), info);
    log(`実行ID: ${id}`);
    o.onRunId?.(id, dir);
  }
  const cfg = ConfigSchema.parse(readJson(path.join(dir, 'config.json')));
  const catalog = readJson<Catalog>(path.join(dir, 'catalog.json'));
  const manuscript = readFileSync(path.join(dir, 'input.md'), 'utf8');
  const locale = localeOf(info);

  const callsFile = path.join(dir, 'ai-calls.jsonl');
  const ctx: AiContext = {
    transport: o.transport,
    modelId: cfg.ai.model,
    effort: cfg.ai.effort,
    record: (r: AiCallRecord) => appendFileSync(callsFile, JSON.stringify({ at: new Date().toISOString(), transport: o.transport.name, ...r }) + '\n'),
  };
  const store: PlanStore = {
    get: <T>(key: string) => (existsSync(path.join(dir, `${key}.json`)) ? readJson<T>(path.join(dir, `${key}.json`)) : undefined),
    set: (key, v) => writeJson(path.join(dir, `${key}.json`), v),
  };
  const timings: Record<string, number> = existsSync(path.join(dir, 'timings.json')) ? readJson(path.join(dir, 'timings.json')) : {};
  const timed = async <T>(name: string, fn: () => Promise<T>) => {
    const t0 = Date.now();
    const r = await fn();
    timings[name] = (timings[name] ?? 0) + (Date.now() - t0);
    writeJson(path.join(dir, 'timings.json'), timings);
    return r;
  };

  // ---- A段
  const outlinePath = path.join(dir, 'outline.json');
  let outline: Outline;
  if (existsSync(outlinePath)) outline = readJson<Outline>(outlinePath);
  else {
    log('A段 原稿の構造化');
    progress('outline');
    outline = await timed('A段', () => makeOutline(ctx, { catalog, cfg, manuscript, targetSlides: info.targetSlides, language: locale.language }));
    writeJson(outlinePath, outline);
  }
  log(`  ページ割り ${outline.pages.length} 枚: ${outline.pages.map((p) => p.role).join(' / ')}`);
  if (o.stopAfter === 'outline') return { dir, issues: [], errors: 0, warnings: 0, stoppedAfter: 'outline' };

  // ---- B段
  const check: SlotCheckContext = {
    catalog,
    headlineMaxLines: cfg.headline.maxLines,
    manuscript,
    sourceNumbers: sourceNumbers(manuscript),
    nameIgnoreSlots: cfg.checks.nameIgnoreSlots,
    unitSlots: cfg.checks.unitSlots,
    resolveFile: resolveRepo,
    language: locale.language,
  };
  const planPath = path.join(dir, 'deck-plan.json');
  let plan: DeckPlan;
  if (existsSync(planPath)) plan = readJson<DeckPlan>(planPath);
  else {
    log('B段 型の選択と流し込み');
    progress('plan');
    const pages = await timed('B段', () => planDeck(ctx, { catalog, cfg, manuscript, outline, check, store, log: (m) => log(`  ${m}`) }));
    plan = { version: 1, deckTitle: outline.deckTitle, language: locale.language, template: { file: catalog.template.file, sha256: catalog.template.sha256 }, pages };
    // 左右の向き（D-042）。写真の寄る側を交互にする決まりで、コードが決める
    chooseMirrors(plan, catalog, cfg);
    writeJson(planPath, plan);
  }
  log(`  設計図: ${plan.pages.map((p) => p.type).join(' / ')}`);
  if (o.stopAfter === 'plan') return { dir, issues: [], errors: 0, warnings: 0, stoppedAfter: 'plan' };

  // ---- C段（写真の割り当て・生成・加工）
  const photosDone = path.join(dir, 'photos/done.json');
  if (!existsSync(photosDone)) {
    log('C段 写真の用意');
    progress('photos');
    // 写真の上に図形が重なる欄の「見えている部分」を測る（テンプレートごとに1回だけ描画する）。測れなくても写真は用意する
    const visibility =
      o.render === false
        ? null
        : await ensureVisibility(path.join(dir, 'template.pptx'), catalog, o.cacheDir ?? path.join(o.root, '.cache'), cfg.mirror).catch((e: Error) => {
            log(`  写真の欄の見えている部分を測れなかった（顔の位置は考えずに切り抜く）: ${e.message.split('\n')[0]}`);
            return null;
          });
    const res = await timed('C段', () =>
      preparePhotos({ plan, catalog, cfg, manuscript, library: info.photos, dir, ai: ctx, generator: o.imageGenerator, visibility, people: locale.people, log: (m) => log(`  ${m}`) })
    );
    writeJson(planPath, plan);
    writeJson(photosDone, { at: new Date().toISOString(), records: res.records, ...(res.generationError ? { generationError: res.generationError } : {}) });
  }
  if (o.stopAfter === 'photos') return { dir, issues: [], errors: 0, warnings: 0, stoppedAfter: 'photos' };

  // ---- D段
  const deckPath = path.join(dir, 'deck.pptx');
  const assemble = () => assembleDeck({ templatePath: path.join(dir, 'template.pptx'), catalog, cfg, plan, photoDir: path.join(dir, 'photos'), outFile: deckPath });
  log('D段 組み立て');
  progress('assemble');
  let { buffer } = await timed('D段', assemble);
  if (o.stopAfter === 'assemble') return { dir, issues: [], errors: 0, warnings: 0, stoppedAfter: 'assemble' };

  // ---- E段：測定の検査 → 描画 → 見た目の採点 → 指摘のあったページだけ B段の直し方で作り直す（最大 review.maxRounds 回）
  const planArgs = { catalog, cfg, manuscript, outline, check, store, log: (m: string) => log(`  ${m}`) };
  const reviewDir = path.join(dir, 'review');
  let render: RenderResult | null = null;
  let lastReview: PageReview[] = [];
  const doRender = async () => {
    if (o.render === false) return null;
    log('E段 描画');
    progress('render');
    const r = await timed('E段 描画', () => renderDeck(buffer, dir, { dpi: cfg.review.dpi }));
    writeJson(path.join(dir, 'render.json'), { engine: r.engine, fonts: r.fonts, pages: r.pages.map((p) => path.relative(dir, p)), ms: r.ms });
    return r;
  };
  render = await doRender();
  if (render && cfg.review.enabled) {
    let targets = plan.pages.map((_, i) => i + 1);
    for (let round = 1; round <= cfg.review.maxRounds + 1 && targets.length; round++) {
      const rPath = path.join(reviewDir, `round-${round}.json`);
      let reviewed = existsSync(rPath) ? readJson<{ pages: number[]; review: PageReview[] }>(rPath) : undefined;
      if (!reviewed) {
        log(`E段 見た目の採点（${round}回目・${targets.length}ページ）`);
        progress('review', `${round}回目・${targets.length}ページ`);
        // 採点は仕上げの品質を上げるためのもの。採点ができなくても、資料は止めずに仕上げる（それまでの採点の結果で注意を出す）
        let review: PageReview[];
        try {
          review = await timed('E段 採点', () => reviewPages(ctx, { plan, catalog, cfg, pages: targets, pngs: render!.pages, round, language: locale.language }));
        } catch (e) {
          log(`  見た目の採点ができなかったので、ここで作り直しを終える: ${(e as Error).message.split('\n')[0]}`);
          break;
        }
        reviewed = { pages: targets, review };
        writeJson(rPath, reviewed);
      }
      // 採点の結果は、そのページの最新の結果で上書きして持つ
      lastReview = [...lastReview.filter((x) => !reviewed!.pages.includes(x.page)), ...reviewed.review].sort((x, y) => x.page - y.page);
      const redo = pagesToRedo(reviewed.review);
      // 写真の指摘で、人の顔・頭が隠れる・切れるもの（顔の検出が見逃す横顔など）。生成した写真を作り直す
      const facePhotos = o.imageGenerator
        ? reviewed.review.flatMap((p) => p.problems.filter((x) => x.kind === 'photo' && isFaceProblem(x.message)).map((x) => ({ page: p.page, slot: x.slot })))
        : [];
      const photoPages = [...new Set(facePhotos.map((x) => x.page))];
      if ((!redo.length && !photoPages.length) || round > cfg.review.maxRounds) break;
      const touched = [...new Set([...redo, ...photoPages])].sort((x, y) => x - y);
      log(`E段 作り直し（${round}回目）: p${touched.join(', p')}`);
      progress('redo', `${touched.length}ページ`);
      const before = await slideHashes(buffer);
      await timed('E段 作り直し', async () => {
        for (const n of redo) {
          const key = `review/page-${String(n).padStart(2, '0')}-r${round}`;
          let fixed = store.get<DeckPlan['pages'][number]>(key);
          if (!fixed) {
            const cur = plan.pages[n - 1];
            const forced = reviewed!.review
              .find((x) => x.page === n)!
              .problems.filter((x) => x.kind === 'text')
              .map((x) => issue('VISUAL_REVIEW', `${x.slot ? `${x.slot}: ` : ''}${x.message}`, { page: n, slot: x.slot }));
            fixed = await fixPage(ctx, planArgs, n, { type: cur.type, slots: cur.slots, photos: cur.photos }, { allowRetype: false, stage: 'E段', forced });
            store.set(key, fixed);
          }
          const cur = plan.pages[n - 1];
          // 作り直した結果が止める決まりに反するなら、元の版を残す（見た目の指摘を直して、測定の決まりを壊さない）
          const t = catalog.types.find((x) => x.key === fixed!.type)!;
          const broken = checkPage(n, t, fixed.slots, check).filter((x) => x.level === 'error');
          if (broken.length || fixed.trimmed.length) {
            log(`  p${n} は作り直しで決まりに反したので元の版に戻した: ${[...broken.map((x) => x.message), ...fixed.trimmed.map((x) => `${x} を丸めた`)].join(' / ')}`);
            plan.pages[n - 1] = { ...cur, revertedByReview: (cur.revertedByReview ?? 0) + 1 };
            continue;
          }
          // 文言だけの作り直し（型は替えない）なので、写真とその切り抜きの記録はそのまま引き継ぐ
          plan.pages[n - 1] = { ...fixed, rewrites: cur.rewrites + fixed.rewrites, photoFiles: cur.photoFiles, photoSources: cur.photoSources, photoFit: cur.photoFit, mirrored: cur.mirrored, revisedByReview: (cur.revisedByReview ?? 0) + 1 };
        }
        // 写真の作り直し（再開したときに二重に作らないよう、回ごとに記録を残す）
        const photoDone = path.join(reviewDir, `photo-redo-${round}.json`);
        if (photoPages.length && !existsSync(photoDone)) {
          const visibility = await ensureVisibility(path.join(dir, 'template.pptx'), catalog, o.cacheDir ?? path.join(o.root, '.cache'), cfg.mirror).catch(() => null);
          const redone: Array<{ page: number; slots: string[] }> = [];
          for (const n of photoPages) {
            const slots = await redoPhotosForReview({ plan, catalog, cfg, dir, generator: o.imageGenerator ?? null, visibility, people: locale.people, log: (m) => log(`  ${m}`) }, n, facePhotos.find((x) => x.page === n && x.slot)?.slot);
            redone.push({ page: n, slots });
          }
          writeJson(photoDone, redone);
        }
      });
      writeJson(planPath, plan);
      ({ buffer } = await timed('D段', assemble));
      // 作り直したページ以外は、スライドの中身が1バイトも変わっていないことを確かめて残す（15章 Phase 4）
      const after = await slideHashes(buffer);
      const changed = after.map((h, i) => (h !== before[i] ? i + 1 : 0)).filter(Boolean);
      const unexpected = changed.filter((n) => !touched.includes(n));
      writeJson(path.join(reviewDir, `changes-${round}.json`), { redo: touched, changed, unexpected });
      if (unexpected.length) log(`  注意: 作り直していないページ p${unexpected.join(', p')} の中身が変わった`);
      render = await doRender();
      targets = touched;
    }
  }

  progress('check');
  const issues = await checkDeck(buffer, plan, catalog, check, cfg.deck.maxSameTypeInRow, cfg.photos.minFaceVisible);
  issues.push(...photoStageIssues(dir));
  if (render) {
    issues.push(...(await checkLightDark(render.pages, cfg.lightDarkRatio)));
    issues.push(...renderIssues(render, plan.pages.length));
  }
  issues.push(...reviewIssues(lastReview));
  const res = writeReport({ dir, info, plan, issues, timings, root: o.root });
  progress('done');
  return res;
}

export function readCalls(dir: string): Array<AiCallRecord & { transport: string }> {
  const f = path.join(dir, 'ai-calls.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function photoSummary(dir: string) {
  const done = path.join(dir, 'photos/done.json');
  const gen = path.join(dir, 'photos/generated.json');
  const records: PhotoRecord[] = existsSync(done) ? (readJson<{ records?: PhotoRecord[] }>(done).records ?? []) : [];
  const generated: GeneratedRecord[] = existsSync(gen) ? readJson<GeneratedRecord[]>(gen) : [];
  return {
    slots: records.length,
    supplied: records.filter((r) => r.source === 'supplied').length,
    generatedUses: records.filter((r) => r.source === 'generated').length,
    templateLeft: records.filter((r) => r.source === 'template').length,
    generated: generated.length,
    generationCostUsd: Math.round(generated.reduce((n, g) => n + g.costUsd, 0) * 10000) / 10000,
    generationMs: generated.reduce((n, g) => n + g.ms, 0),
    records,
  };
}

export function writeReport(a: { dir: string; info: RunInfo; plan: DeckPlan; issues: Issue[]; timings: Record<string, number>; root: string }): BuildResult {
  const calls = readCalls(a.dir);
  const photos = photoSummary(a.dir);
  const sum = (k: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens') => calls.reduce((n, c) => n + (c[k] ?? 0), 0);
  const usage = { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cacheReadTokens: sum('cacheReadTokens'), cacheWriteTokens: sum('cacheWriteTokens') };
  const cost = calls.reduce((n, c) => {
    try {
      return n + costUsd(a.info.model, c);
    } catch {
      return n;
    }
  }, 0);
  const errors = a.issues.filter((i) => i.level === 'error').length;
  const warnings = a.issues.length - errors;
  const byCode: Record<string, number> = {};
  for (const i of a.issues) byCode[i.code] = (byCode[i.code] ?? 0) + 1;
  const report = {
    run: a.info,
    finishedAt: new Date().toISOString(),
    slides: a.plan.pages.length,
    ok: errors === 0,
    errors,
    warnings,
    byCode,
    issues: a.issues,
    ai: {
      transport: a.info.transport,
      model: a.info.model,
      calls: calls.length,
      failedAttempts: calls.filter((c) => !c.ok).length,
      ...usage,
      // 公式の単価（models.ts）で計算した概算。claude-cli 経由では Claude Code の分が上乗せされるので目安
      costUsdEstimate: Math.round(cost * 10000) / 10000,
      byStage: Object.entries(
        calls.reduce<Record<string, { calls: number; inputTokens: number; outputTokens: number; ms: number }>>((m, c) => {
          const k = c.feature.replace(/ p\d+(-\d+)?$/, '');
          m[k] ??= { calls: 0, inputTokens: 0, outputTokens: 0, ms: 0 };
          m[k].calls++;
          m[k].inputTokens += c.inputTokens + c.cacheReadTokens + c.cacheWriteTokens;
          m[k].outputTokens += c.outputTokens;
          m[k].ms += c.ms;
          return m;
        }, {})
      ).map(([stage, v]) => ({ stage, ...v })),
    },
    photos,
    /** AI（文章）と写真の生成を合わせた概算 */
    totalCostUsdEstimate: Math.round((cost + photos.generationCostUsd) * 10000) / 10000,
    timingsMs: a.timings,
    /** 段ごとの時間の合計（再開したときは、それぞれの実行の分を足したもの） */
    totalMs: Object.values(a.timings).reduce((n, v) => n + v, 0),
    pages: a.plan.pages.map((p, i) => ({ page: i + 1, type: p.type, rewrites: p.rewrites, retypedFrom: p.retypedFrom ?? null, revisedByReview: p.revisedByReview ?? 0, trimmed: p.trimmed, phraseBroken: p.phraseBroken })),
  };
  writeJson(path.join(a.dir, 'report.json'), report);
  const lines = [
    `# 検査レポート ${a.info.id}`,
    '',
    `- 原稿: ${path.basename(a.info.input)}／テンプレート: ${a.info.template}／${a.plan.pages.length} 枚`,
    `- 結果: ${errors === 0 ? '止める指摘 0 件' : `**止める指摘 ${errors} 件**（完成扱いにしない）`}・注意 ${warnings} 件`,
    `- AI: ${report.ai.transport}・${report.ai.model}・${report.ai.calls} 回（うちやり直し ${report.ai.failedAttempts}）・入力 ${usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens} トークン（キャッシュ読み ${usage.cacheReadTokens}）・出力 ${usage.outputTokens} トークン・概算 $${report.ai.costUsdEstimate}`,
    `- 写真: 欄 ${photos.slots}（支給 ${photos.supplied}・生成 ${photos.generatedUses}・見本のまま ${photos.templateLeft}）・生成 ${photos.generated} 枚 $${photos.generationCostUsd}（${(photos.generationMs / 1000).toFixed(1)}秒）`,
    `- 実費の概算（文章＋写真）: $${report.totalCostUsdEstimate}`,
    `- 時間: 合計 ${(report.totalMs / 1000).toFixed(1)}秒（${Object.entries(a.timings).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}秒`).join('・')}）`,
    '',
    '## 止める指摘',
    ...(errors ? a.issues.filter((i) => i.level === 'error').map(fmt) : ['なし']),
    '',
    '## 注意',
    ...(warnings ? a.issues.filter((i) => i.level === 'warning').map(fmt) : ['なし']),
    '',
    '## ページ',
    '| p | 型 | 書き直し | 型の替え | 見た目で作り直し | 丸め | 文節の改行 |',
    '|---|---|---|---|---|---|---|',
    ...report.pages.map((p) => `| ${p.page} | ${p.type} | ${p.rewrites} | ${p.retypedFrom ?? ''} | ${p.revisedByReview || ''} | ${p.trimmed.join(', ')} | ${p.phraseBroken.join(', ')} |`),
    '',
  ];
  writeFileSync(path.join(a.dir, 'report.md'), lines.join('\n'));
  return { dir: a.dir, issues: a.issues, errors, warnings };
}

const fmt = (i: Issue) => `- [${i.code}]${i.page ? ` p${i.page}` : ''}${i.slot ? ` ${i.slot}` : ''}: ${i.message}`;

/** check だけをやり直す（slidegen check） */
export async function recheck(dirArg: string, root: string): Promise<BuildResult> {
  const dir = path.resolve(dirArg);
  const info = readJson<RunInfo>(path.join(dir, 'run.json'));
  const cfg: TemplateConfig = ConfigSchema.parse(readJson(path.join(dir, 'config.json')));
  const catalog = readJson<Catalog>(path.join(dir, 'catalog.json'));
  const plan = readJson<DeckPlan>(path.join(dir, 'deck-plan.json'));
  const manuscript = readFileSync(path.join(dir, 'input.md'), 'utf8');
  const buf = readFileSync(path.join(dir, 'deck.pptx'));
  const issues = await checkDeck(buf, plan, catalog, {
    catalog,
    headlineMaxLines: cfg.headline.maxLines,
    manuscript,
    sourceNumbers: sourceNumbers(manuscript),
    nameIgnoreSlots: cfg.checks.nameIgnoreSlots,
    unitSlots: cfg.checks.unitSlots,
    resolveFile: (p) => (path.isAbsolute(p) ? p : path.join(root, p)),
    // 仕上げで直したあとの検査も、資料の言語で（英語の資料の普通の英単語を「原稿に無い語」にしない。2026-10-29 実例）
    language: plan.language ?? localeOf(info).language,
  }, cfg.deck.maxSameTypeInRow, cfg.photos.minFaceVisible);
  issues.push(...photoStageIssues(dir));
  // 描画と見た目の採点は、保存してある結果を読む（check は AI も描画も呼ばない）
  const pngs = existsSync(path.join(dir, 'render.json')) ? readJson<{ pages: string[] }>(path.join(dir, 'render.json')).pages.map((p) => path.join(dir, p)) : [];
  if (pngs.length) issues.push(...(await checkLightDark(pngs, cfg.lightDarkRatio)));
  const rd = path.join(dir, 'review');
  const rounds = existsSync(rd)
    ? readdirSync(rd)
        .filter((f) => /^round-\d+\.json$/.test(f))
        .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
        .map((f) => readJson<{ pages: number[]; review: PageReview[] }>(path.join(rd, f)))
    : [];
  issues.push(...reviewIssues(latestReview(rounds)));
  const timings = existsSync(path.join(dir, 'timings.json')) ? readJson<Record<string, number>>(path.join(dir, 'timings.json')) : {};
  return writeReport({ dir, info, plan, issues, timings, root });
}

/** スライドごとの中身（slideN.xml と、その関係ファイル）の指紋。作り直していないページが変わっていないかを確かめる */
export async function slideHashes(buf: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf);
  const pres = await zip.file('ppt/presentation.xml')!.async('string');
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
  const ids = [...pres.matchAll(/<p:sldId [^>]*r:id="([^"]+)"/g)].map((m) => m[1]);
  const target = new Map([...rels.matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const out: string[] = [];
  for (const id of ids) {
    const part = path.posix.join('ppt', target.get(id)!);
    const xml = await zip.file(part)!.async('string');
    // 画像の中身も含める（関係の付け替えで別の画像を指すようになったら気づくため）
    const relXml = (await zip.file(part.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'))?.async('string')) ?? '';
    const media = await Promise.all(
      [...relXml.matchAll(/Target="\.\.\/media\/([^"]+)"/g)].map(async (m) => createHash('sha256').update((await zip.file(`ppt/media/${m[1]}`)?.async('nodebuffer')) ?? Buffer.alloc(0)).digest('hex'))
    );
    out.push(createHash('sha256').update(xml).update(media.join(',')).digest('hex'));
  }
  return out;
}

/** C段で写真を作れなかった欄（done.json に残した理由と、見本のままの欄）。PHOTO_NOT_GENERATED */
function photoStageIssues(dir: string): Issue[] {
  const f = path.join(dir, 'photos/done.json');
  if (!existsSync(f)) return [];
  const d = readJson<{ generationError?: string; records: Array<{ page: number; slot: string; source: string; file: string | null }> }>(f);
  if (!d.generationError) return [];
  return d.records
    .filter((r) => r.file === null || r.source === 'template')
    .map((r) => issue('PHOTO_NOT_GENERATED', `${r.slot}: 写真を作れなかったので見本の写真のまま（${d.generationError}）`, { page: r.page, slot: r.slot }, `${r.slot}: the photo could not be created, so the template's sample photo is kept`));
}
