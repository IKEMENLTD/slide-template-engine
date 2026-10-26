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
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildCatalog, type Catalog } from '../catalog/build-catalog.js';
import { ConfigSchema, type TemplateConfig } from '../catalog/config.js';
import { readTemplate } from '../catalog/read-template.js';
import type { AiCallRecord, AiContext } from '../ai/call-json.js';
import { costUsd } from '../ai/models.js';
import type { AiTransport } from '../ai/transport.js';
import { assembleDeck } from '../assemble/build-deck.js';
import type { Issue } from '../check/content.js';
import { checkDeck } from '../check/deck-check.js';
import type { SlotCheckContext } from '../check/slots.js';
import { sourceNumbers } from '../check/content.js';
import { makeOutline } from '../plan/outline.js';
import { planDeck, type PlanStore } from '../plan/plan.js';
import type { DeckPlan, Outline } from '../plan/schema.js';
import { preparePhotos, type GeneratedRecord, type PhotoRecord } from '../photos/plan-photos.js';
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
};

export type BuildOptions = {
  root: string;
  outDir: string;
  /** 新しく作るとき */
  input?: string;
  template?: string;
  config?: string;
  photos?: string | null;
  targetSlides?: number;
  /** 続きから再開するとき（out/<実行ID>） */
  resume?: string;
  transport: AiTransport;
  /** 設定の ai.model を上書きする */
  model?: string;
  /** 写真を生成する口。null なら生成しない（生成を割り当てた欄は見本の写真のまま） */
  imageGenerator: ImageGenerator | null;
  log?: (m: string) => void;
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
    const id = newRunId(o.input);
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
    };
    writeJson(path.join(dir, 'run.json'), info);
    log(`実行ID: ${id}`);
  }
  const cfg = ConfigSchema.parse(readJson(path.join(dir, 'config.json')));
  const catalog = readJson<Catalog>(path.join(dir, 'catalog.json'));
  const manuscript = readFileSync(path.join(dir, 'input.md'), 'utf8');

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
    outline = await timed('A段', () => makeOutline(ctx, { catalog, cfg, manuscript, targetSlides: info.targetSlides }));
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
    noNumberSlots: cfg.checks.noNumberSlots,
    resolveFile: resolveRepo,
  };
  const planPath = path.join(dir, 'deck-plan.json');
  let plan: DeckPlan;
  if (existsSync(planPath)) plan = readJson<DeckPlan>(planPath);
  else {
    log('B段 型の選択と流し込み');
    const pages = await timed('B段', () => planDeck(ctx, { catalog, cfg, manuscript, outline, check, store, log: (m) => log(`  ${m}`) }));
    plan = { version: 1, deckTitle: outline.deckTitle, template: { file: catalog.template.file, sha256: catalog.template.sha256 }, pages };
    writeJson(planPath, plan);
  }
  log(`  設計図: ${plan.pages.map((p) => p.type).join(' / ')}`);
  if (o.stopAfter === 'plan') return { dir, issues: [], errors: 0, warnings: 0, stoppedAfter: 'plan' };

  // ---- C段（写真の割り当て・生成・加工）
  const photosDone = path.join(dir, 'photos/done.json');
  if (!existsSync(photosDone)) {
    log('C段 写真の用意');
    const res = await timed('C段', () =>
      preparePhotos({ plan, catalog, cfg, manuscript, library: info.photos, dir, ai: ctx, generator: o.imageGenerator, log: (m) => log(`  ${m}`) })
    );
    writeJson(planPath, plan);
    writeJson(photosDone, { at: new Date().toISOString(), records: res.records });
  }
  if (o.stopAfter === 'photos') return { dir, issues: [], errors: 0, warnings: 0, stoppedAfter: 'photos' };

  // ---- D段
  const deckPath = path.join(dir, 'deck.pptx');
  log('D段 組み立て');
  const { buffer } = await timed('D段', () =>
    assembleDeck({ templatePath: path.join(dir, 'template.pptx'), catalog, cfg, plan, photoDir: path.join(dir, 'photos'), outFile: deckPath })
  );
  if (o.stopAfter === 'assemble') return { dir, issues: [], errors: 0, warnings: 0, stoppedAfter: 'assemble' };

  // ---- 検査（Phase 4 で描画・見た目の採点・作り直しを足す）
  const issues = await checkDeck(buffer, plan, catalog, check, cfg.deck.maxSameTypeInRow);
  return writeReport({ dir, info, plan, issues, timings, root: o.root });
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
    pages: a.plan.pages.map((p, i) => ({ page: i + 1, type: p.type, rewrites: p.rewrites, retypedFrom: p.retypedFrom ?? null, trimmed: p.trimmed, phraseBroken: p.phraseBroken })),
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
    `- 時間: ${Object.entries(a.timings).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}秒`).join('・')}`,
    '',
    '## 止める指摘',
    ...(errors ? a.issues.filter((i) => i.level === 'error').map(fmt) : ['なし']),
    '',
    '## 注意',
    ...(warnings ? a.issues.filter((i) => i.level === 'warning').map(fmt) : ['なし']),
    '',
    '## ページ',
    '| p | 型 | 書き直し | 型の替え | 丸め | 文節の改行 |',
    '|---|---|---|---|---|---|',
    ...report.pages.map((p) => `| ${p.page} | ${p.type} | ${p.rewrites} | ${p.retypedFrom ?? ''} | ${p.trimmed.join(', ')} | ${p.phraseBroken.join(', ')} |`),
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
    noNumberSlots: cfg.checks.noNumberSlots,
    resolveFile: (p) => (path.isAbsolute(p) ? p : path.join(root, p)),
  }, cfg.deck.maxSameTypeInRow);
  const timings = existsSync(path.join(dir, 'timings.json')) ? readJson<Record<string, number>>(path.join(dir, 'timings.json')) : {};
  return writeReport({ dir, info, plan, issues, timings, root });
}
