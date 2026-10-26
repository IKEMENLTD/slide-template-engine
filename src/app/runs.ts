/**
 * 資料（実行）の作成・一覧・状態。作成は1件ずつ順番に行う（同時に動かすと AI と描画が取り合って遅くなる）。
 * 状態は data/runs/<実行ID>/status.json に書く。アプリを止めても、作りかけの資料は「続きから」で再開できる
 * （build の --resume と同じ。段ごとの結果が残っている）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigSchema } from '../catalog/config.js';
import type { Issue } from '../check/content.js';
import type { DeckPlan } from '../plan/schema.js';
import { costUsd } from '../ai/models.js';
import { build, readCalls, type BuildStep, type RunInfo } from '../run/build.js';
import { AppError, aiTransport, imageGenerator, readSettings, ROOT, RUNS } from './settings.js';
import { getTemplate } from './templates.js';
import { ISSUE_WORDS, LEVEL_WORDS, plainText, slotLabel, STEP_ORDER, STEP_WORDS } from './words.js';

export type RunState = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

export type Status = {
  state: RunState;
  step: BuildStep | null;
  detail?: string;
  title: string;
  template: string;
  targetSlides: number | null;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** 段に入った時刻（進み具合と残り時間の目安に使う） */
  stepStartedAt?: string;
};

const ID = /^[\w.-]+$/;
export function runDir(id: string): string {
  if (!ID.test(id)) throw new AppError('資料の ID が正しくありません', 404);
  const d = path.join(RUNS, id);
  if (!existsSync(path.join(d, 'status.json'))) throw new AppError('その資料は見つかりません', 404);
  return d;
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
export function writeJson(p: string, v: unknown) {
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  renameSync(tmp, p);
}
const readStatus = (dir: string) => readJson<Status>(path.join(dir, 'status.json'));
function patchStatus(dir: string, patch: Partial<Status>) {
  writeJson(path.join(dir, 'status.json'), { ...readStatus(dir), ...patch });
}

// ---------------------------------------------------------------- 作成の順番待ち

const queue: string[] = [];
let current: string | null = null;

/** 原稿の長さから、おすすめの枚数（実測：527字→5枚・1,005字→10枚・1,592字→20枚で作った） */
export function recommendedSlides(text: string, min = 4, max = 20): number {
  const n = [...text.replace(/\s/g, '')].length;
  return Math.max(min, Math.min(max, Math.round(n / 85)));
}

/** 作成にかかる時間の目安（秒）。実測：5枚 250秒・10枚 431〜569秒・20枚 554〜637秒（少し長めに出す） */
export const estimateSeconds = (slides: number) => 200 + 22 * slides;
/** 費用の目安（ドル）。実測：5枚 $0.35・10枚 $0.76・20枚 $0.88（写真の生成を含む） */
export const estimateUsd = (slides: number, generate: boolean) => (generate ? 0.25 + 0.035 * slides : 0.12 + 0.025 * slides);

export type NewRun = {
  title: string;
  manuscript: string;
  template: string;
  targetSlides: number | null;
  generatePhotos: boolean;
  photos: Array<{ name: string; data: Buffer; description: string }>;
};

function newId(title: string) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  let id = stamp;
  for (let i = 2; existsSync(path.join(RUNS, id)); i++) id = `${stamp}-${i}`;
  void title;
  return id;
}

export async function createRun(r: NewRun): Promise<string> {
  if (!r.manuscript.trim()) throw new AppError('原稿が空です');
  aiTransport(); // 鍵が無ければここで止める（順番待ちに入れてから失敗させない）
  checkBudget();
  const tpl = await getTemplate(r.template);
  const id = newId(r.title);
  const dir = path.join(RUNS, id);
  mkdirSync(path.join(dir, 'source'), { recursive: true });
  writeFileSync(path.join(dir, 'source', 'manuscript.md'), r.manuscript.trim() + '\n');
  if (r.photos.length) {
    const up = path.join(dir, 'uploads');
    mkdirSync(up, { recursive: true });
    const lib = r.photos.map((ph, i) => {
      const ext = (path.extname(ph.name).toLowerCase().match(/^\.(jpe?g|png|webp)$/) ?? ['.jpg'])[0];
      const file = `photo-${String(i + 1).padStart(2, '0')}${ext}`;
      writeFileSync(path.join(up, file), ph.data);
      return { file, description: ph.description.trim(), generated: false };
    });
    writeJson(path.join(up, 'photos.json'), lib);
  }
  writeJson(path.join(dir, 'request.json'), { template: r.template, templateSha256: tpl.sha256, targetSlides: r.targetSlides, generatePhotos: r.generatePhotos, photos: r.photos.length });
  writeJson(path.join(dir, 'status.json'), {
    state: 'queued',
    step: null,
    title: r.title.trim() || firstLine(r.manuscript),
    template: tpl.name,
    targetSlides: r.targetSlides,
    createdAt: new Date().toISOString(),
  } satisfies Status);
  enqueue(id);
  return id;
}

const firstLine = (s: string) => (s.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '無題の資料').slice(0, 40);

function enqueue(id: string) {
  if (!queue.includes(id) && current !== id) queue.push(id);
  void pump();
}

async function pump() {
  if (current) return;
  const id = queue.shift();
  if (!id) return;
  current = id;
  try {
    await runOne(id);
  } finally {
    current = null;
    void pump();
  }
}

async function runOne(id: string) {
  const dir = path.join(RUNS, id);
  const req = readJson<{ template: string; targetSlides: number | null; generatePhotos: boolean }>(path.join(dir, 'request.json'));
  const resume = existsSync(path.join(dir, 'run.json'));
  patchStatus(dir, { state: 'running', startedAt: readStatus(dir).startedAt ?? new Date().toISOString(), error: undefined });
  const logFile = path.join(dir, 'log.txt');
  try {
    const tpl = await getTemplate(req.template);
    const cfg = resume ? ConfigSchema.parse(readJson(path.join(dir, 'config.json'))) : tpl.cfg;
    await build({
      root: ROOT,
      outDir: RUNS,
      runId: id,
      ...(resume
        ? { resume: dir }
        : {
            input: path.join(dir, 'source', 'manuscript.md'),
            template: tpl.file,
            photos: existsSync(path.join(dir, 'uploads')) ? path.join(dir, 'uploads') : null,
            targetSlides: req.targetSlides ?? undefined,
          }),
      transport: aiTransport(),
      imageGenerator: req.generatePhotos ? imageGenerator(cfg) : null,
      log: (m) => appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`),
      progress: (step, detail) => patchStatus(dir, { step, detail, stepStartedAt: new Date().toISOString() }),
    });
    patchStatus(dir, { state: 'done', finishedAt: new Date().toISOString() });
  } catch (e) {
    appendFileSync(logFile, `${new Date().toISOString()} 失敗: ${(e as Error).stack ?? e}\n`);
    patchStatus(dir, { state: 'failed', error: (e as Error).message, finishedAt: new Date().toISOString() });
  }
}

/** アプリを起動したとき：作りかけだった資料は「止まった」にする（続きから再開できる） */
export function recoverOnBoot() {
  if (!existsSync(RUNS)) return;
  for (const id of readdirSync(RUNS)) {
    const f = path.join(RUNS, id, 'status.json');
    if (!existsSync(f)) continue;
    const s = readJson<Status>(f);
    if (s.state === 'running' || s.state === 'queued') patchStatus(path.join(RUNS, id), { state: 'stopped', error: 'アプリが止まったため、作成が途中で止まりました。' });
  }
}

export function resumeRun(id: string) {
  const dir = runDir(id);
  const s = readStatus(dir);
  if (s.state !== 'failed' && s.state !== 'stopped') throw new AppError('この資料は再開できる状態ではありません');
  aiTransport();
  checkBudget();
  patchStatus(dir, { state: 'queued', error: undefined });
  enqueue(id);
}

export function deleteRun(id: string) {
  const dir = runDir(id);
  if (current === id) throw new AppError('作成中の資料は消せません。終わってから消してください');
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 費用

/** その資料でかかった費用（文章の AI＋写真の生成）。ドル */
export function runCostUsd(dir: string): number {
  let usd = 0;
  const info = existsSync(path.join(dir, 'run.json')) ? readJson<RunInfo>(path.join(dir, 'run.json')) : null;
  for (const c of readCalls(dir)) {
    try {
      usd += costUsd(info?.model ?? c.model, c);
    } catch {
      /* 単価の分からないモデルは数えない */
    }
  }
  const gen = path.join(dir, 'photos', 'generated.json');
  if (existsSync(gen)) usd += readJson<Array<{ costUsd: number }>>(gen).reduce((n, g) => n + g.costUsd, 0);
  return Math.round(usd * 10000) / 10000;
}

export function monthCostUsd(now = new Date()): number {
  if (!existsSync(RUNS)) return 0;
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  return Math.round(
    readdirSync(RUNS)
      .filter((id) => id.startsWith(ym))
      .reduce((n, id) => n + runCostUsd(path.join(RUNS, id)), 0) * 10000
  ) / 10000;
}

export function checkBudget() {
  const cap = readSettings().monthlyBudgetUsd ?? 0;
  if (cap > 0 && monthCostUsd() >= cap) throw new AppError(`今月の費用が上限（$${cap}）に達しました。「設定」で上限を上げるか、来月までお待ちください。`, 409);
}

// ---------------------------------------------------------------- 画面に返す形

export type PresentedIssue = {
  level: Issue['level'];
  levelText: string;
  page: number | null;
  slot: string | null;
  slotLabel: string | null;
  title: string;
  action: string;
  detail: string;
};

/** 人が直したページ（見た目の採点の指摘は、直す前の絵についてのものなので出さない） */
export function editedPages(dir: string): number[] {
  const f = path.join(dir, 'edited.json');
  return existsSync(f) ? readJson<number[]>(f) : [];
}

export function presentIssues(issues: Issue[], edited: number[]): PresentedIssue[] {
  return issues
    .filter((i) => !(i.code === 'VISUAL_REVIEW' && i.page && edited.includes(i.page)))
    .map((i) => ({
      level: i.level,
      levelText: LEVEL_WORDS[i.level],
      page: i.page ?? null,
      slot: i.slot ?? null,
      slotLabel: i.slot ? slotLabel(i.slot) : null,
      title: ISSUE_WORDS[i.code].title,
      action: ISSUE_WORDS[i.code].action,
      // 欄の名前は slotLabel に出すので、文の頭の「欄の名前:」は外す
      detail: plainText(i.message).replace(/^「[^」]+」\s*[:：]\s*/, ''),
    }))
    .sort((a, b) => (a.level === b.level ? (a.page ?? 0) - (b.page ?? 0) : a.level === 'error' ? -1 : 1));
}

const mtime = (f: string) => (existsSync(f) ? statSync(f).mtimeMs : 0);

export function runView(id: string) {
  const dir = runDir(id);
  const s = readStatus(dir);
  const plan = existsSync(path.join(dir, 'deck-plan.json')) ? readJson<DeckPlan>(path.join(dir, 'deck-plan.json')) : null;
  const report = s.state === 'done' && existsSync(path.join(dir, 'report.json')) ? readJson<{ issues: Issue[]; slides: number }>(path.join(dir, 'report.json')) : null;
  const issues = report ? presentIssues(report.issues, editedPages(dir)) : [];
  const settings = readSettings();
  const slides = plan?.pages.length ?? s.targetSlides ?? null;
  // 進み具合：終わった段の重み＋いまの段の半分
  let percent = 0;
  if (s.state === 'done') percent = 100;
  else if (s.step && s.step !== 'done') {
    const total = STEP_ORDER.reduce((n, k) => n + STEP_WORDS[k].weight, 0);
    const i = STEP_ORDER.indexOf(s.step);
    percent = Math.round(((STEP_ORDER.slice(0, i).reduce((n, k) => n + STEP_WORDS[k].weight, 0) + STEP_WORDS[s.step].weight / 2) / total) * 100);
  }
  const estimate = estimateSeconds(slides ?? 10);
  const elapsed = s.startedAt ? Math.round(((s.finishedAt ? Date.parse(s.finishedAt) : Date.now()) - Date.parse(s.startedAt)) / 1000) : 0;
  const cost = runCostUsd(dir);
  return {
    id,
    title: plan?.deckTitle ?? s.title,
    state: s.state,
    step: s.step,
    stepLabel: s.step && s.step !== 'done' ? STEP_WORDS[s.step].label : null,
    detail: s.detail ?? null,
    percent,
    elapsedSeconds: elapsed,
    remainingSeconds: s.state === 'running' ? Math.max(30, estimate - elapsed) : null,
    queuePosition: s.state === 'queued' ? queue.indexOf(id) + 1 + (current ? 1 : 0) : null,
    error: s.error ?? null,
    template: s.template,
    createdAt: s.createdAt,
    slides,
    errors: issues.filter((i) => i.level === 'error').length,
    warnings: issues.filter((i) => i.level === 'warning').length,
    issues,
    costUsd: cost,
    costJpy: Math.round(cost * settings.usdJpy),
    cover: existsSync(path.join(dir, 'pages', '01.png')) ? `/api/runs/${id}/pages/1.png?v=${Math.round(mtime(path.join(dir, 'pages', '01.png')))}` : null,
    pdfReady: mtime(path.join(dir, 'deck.pdf')) >= mtime(path.join(dir, 'deck.pptx')),
    canUndo: existsSync(path.join(dir, 'versions')) && readdirSync(path.join(dir, 'versions')).some((f) => f.endsWith('.json')),
  };
}

export function listRuns() {
  if (!existsSync(RUNS)) return [];
  return readdirSync(RUNS)
    .filter((id) => existsSync(path.join(RUNS, id, 'status.json')))
    .sort()
    .reverse()
    .map((id) => {
      const { issues: _omit, ...v } = runView(id);
      return v;
    });
}
