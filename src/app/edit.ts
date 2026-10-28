/**
 * 仕上げ：出来上がった資料を1ページずつ直す。
 *   文字を書き換える／AIに頼んで直す／ページの形（型）を替える／写真を替える／元に戻す。
 * 直すたびに、直す前の設計図を versions/ に残す（何度でも戻せる）。
 * 直したあとは、資料全体を組み立て直し（数秒）、直したページだけを描き直し（約10秒）、検査をやり直す。
 * PDF は、ダウンロードするときに古ければ作り直す（全ページの描画は数十秒かかるため、直すたびにはしない）。
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AiCallRecord, AiContext } from '../ai/call-json.js';
import { assembleDeck } from '../assemble/build-deck.js';
import type { Catalog, CatalogType } from '../catalog/build-catalog.js';
import { createHash } from 'node:crypto';
import { ConfigSchema, configPathFor, type TemplateConfig } from '../catalog/config.js';
import { canMirror } from '../plan/mirror-plan.js';
import { issue, sourceNumbers, type Issue } from '../check/content.js';
import { checkPage, type SlotCheckContext } from '../check/slots.js';
import { fitSlot } from '../fit/fit-slot.js';
import { imageSlots, textSlots } from '../plan/describe.js';
import { fixPage, type PlanArgs } from '../plan/plan.js';
import type { DeckPlan, Outline } from '../plan/schema.js';
import { processPhoto, resolveColor, type PhotoFit } from '../photos/prepare.js';
import { ensureVisibility, visKey, type VisibilityMap } from '../photos/visibility.js';
import type { PhotoRecord } from '../photos/plan-photos.js';
import { renderDeck } from '../render/render.js';
import { recheck } from '../run/build.js';
import { checkBudget, editedPages, presentIssues, runDir, writeJson } from './runs.js';
import { AppError, aiTransport, CACHE, ROOT } from './settings.js';
import { slotLabel } from './words.js';

type Page = DeckPlan['pages'][number];

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const resolveFile = (p: string) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

/** 1つの資料に対する直しは1つずつ（同時に直すと設計図を取り合う） */
const locks = new Map<string, Promise<unknown>>();
function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(id, next);
  return next.finally(() => {
    if (locks.get(id) === next) locks.delete(id);
  });
}

type Ctx = {
  id: string;
  dir: string;
  cfg: TemplateConfig;
  catalog: Catalog;
  plan: DeckPlan;
  manuscript: string;
  check: SlotCheckContext;
};

function load(id: string): Ctx {
  const dir = runDir(id);
  if (!existsSync(path.join(dir, 'deck.pptx'))) throw new AppError('この資料はまだ出来上がっていません', 409);
  const cfg = ConfigSchema.parse(readJson(path.join(dir, 'config.json')));
  const catalog = readJson<Catalog>(path.join(dir, 'catalog.json'));
  // 左右反転（D-042）より前に作った資料は、設定に mirror が無い。テンプレートが同じ中身なら、いまの設定の決まりを使う
  if (!Object.keys(cfg.mirror).length) cfg.mirror = currentMirrorRules(catalog);
  const manuscript = readFileSync(path.join(dir, 'input.md'), 'utf8');
  return {
    id,
    dir,
    cfg,
    catalog,
    plan: readJson<DeckPlan>(path.join(dir, 'deck-plan.json')),
    manuscript,
    check: {
      catalog,
      headlineMaxLines: cfg.headline.maxLines,
      manuscript,
      sourceNumbers: sourceNumbers(manuscript),
      nameIgnoreSlots: cfg.checks.nameIgnoreSlots,
      unitSlots: cfg.checks.unitSlots,
      resolveFile,
    },
  };
}

function currentMirrorRules(catalog: Catalog): TemplateConfig['mirror'] {
  try {
    const tpl = resolveFile(catalog.template.file);
    if (createHash('sha256').update(readFileSync(tpl)).digest('hex') !== catalog.template.sha256) return {};
    return ConfigSchema.parse(readJson(configPathFor(tpl))).mirror;
  } catch {
    return {};
  }
}

function pageAt(c: Ctx, n: number): Page {
  const p = c.plan.pages[n - 1];
  if (!p) throw new AppError(`${n}ページ目はありません`, 404);
  return p;
}
const typeOf = (c: Ctx, key: string): CatalogType => {
  const t = c.catalog.types.find((x) => x.key === key);
  if (!t) throw new AppError(`ページの形「${key}」はこのテンプレートにありません`);
  return t;
};
const pad = (n: number) => String(n).padStart(2, '0');
const mtime = (f: string) => (existsSync(f) ? Math.round(statSync(f).mtimeMs) : 0);

// ---------------------------------------------------------------- 画面に返すページの形

export function pagesView(id: string) {
  const c = load(id);
  return c.plan.pages.map((p, i) => pageView(c, i + 1, p));
}

function pageView(c: Ctx, n: number, p: Page) {
  const t = typeOf(c, p.type);
  const png = path.join(c.dir, 'pages', `${pad(n)}.png`);
  return {
    n,
    type: p.type,
    typeLabel: t.label,
    /** 左右を入れ替えた向きか／入れ替えられる形か（D-042） */
    mirrored: !!p.mirrored,
    canMirror: canMirror(c.cfg, p.type),
    image: existsSync(png) ? `/api/runs/${c.id}/pages/${n}.png?v=${mtime(png)}` : null,
    slots: textSlots(t).map((s) => ({
      name: s.name,
      label: slotLabel(s.name),
      kind: s.kind,
      text: p.slots[s.name] ?? '',
      maxChars: s.maxChars ?? null,
      maxLines: s.maxLines ?? null,
      perLine: s.maxCharsPerLine ?? null,
    })),
    photos: imageSlots(t).map((s) => {
      const f = p.photoFiles?.[s.name];
      return { name: s.name, label: slotLabel(s.name), image: f ? `/api/runs/${c.id}/photos/${encodeURIComponent(f)}?v=${mtime(path.join(c.dir, 'photos', f))}` : null, aspect: s.aspect ?? null };
    }),
  };
}

/** そのテンプレートで選べるページの形（いまの形と同じ役割のものを先に） */
export function typeChoices(id: string, n: number) {
  const c = load(id);
  const cur = typeOf(c, pageAt(c, n).type);
  return c.catalog.types
    .map((t) => ({ key: t.key, label: t.label, sameRole: t.role.some((r) => cur.role.includes(r)), current: t.key === cur.key }))
    .sort((a, b) => Number(b.sameRole) - Number(a.sameRole));
}

// ---------------------------------------------------------------- 打ちながらの検査

/** 書きかけの文言を測る（保存しない。打つたびに呼ばれる） */
export function checkDraft(id: string, n: number, slots: Record<string, string>) {
  const c = load(id);
  const t = typeOf(c, pageAt(c, n).type);
  const fits = Object.fromEntries(
    textSlots(t).map((s) => {
      const text = slots[s.name] ?? '';
      if (!s.style || !text.trim()) return [s.name, { ok: !!text.trim(), chars: [...text].length, maxChars: s.maxChars ?? null, lines: 0, maxLines: s.maxLines ?? null, reason: text.trim() ? null : '空です' }];
      const r = fitSlot(s, text, c.catalog.fit, resolveFile);
      return [s.name, { ok: r.ok, chars: r.chars, maxChars: r.maxChars, lines: r.lineCount, maxLines: r.maxLines, reason: r.reason ?? null }];
    })
  );
  return { fits, issues: presentIssues(checkPage(n, t, slots, c.check), []) };
}

// ---------------------------------------------------------------- 直す（共通の手順）

function snapshot(c: Ctx, label: string, page: number) {
  const vdir = path.join(c.dir, 'versions');
  mkdirSync(vdir, { recursive: true });
  const k = readdirSync(vdir).filter((f) => f.endsWith('.json')).length + 1;
  writeJson(path.join(vdir, `${String(k).padStart(3, '0')}.json`), { at: new Date().toISOString(), label, page, plan: readJson(path.join(c.dir, 'deck-plan.json')) });
}

function markEdited(c: Ctx, pages: number[]) {
  writeJson(path.join(c.dir, 'edited.json'), [...new Set([...editedPages(c.dir), ...pages])].sort((a, b) => a - b));
}

/** 組み立て直して、指定のページだけ描き直し、検査をやり直す */
async function commit(c: Ctx, pages: number[]) {
  writeJson(path.join(c.dir, 'deck-plan.json'), c.plan);
  await assembleDeck({ templatePath: path.join(c.dir, 'template.pptx'), catalog: c.catalog, cfg: c.cfg, plan: c.plan, photoDir: path.join(c.dir, 'photos'), outFile: path.join(c.dir, 'deck.pptx') });
  for (const n of pages) await renderPage(c, n);
  markEdited(c, pages);
  await recheck(c.dir, ROOT);
}

/** 1ページだけの資料を組み立てて描き、pages/NN.png を差し替える */
async function renderPage(c: Ctx, n: number) {
  const work = path.join(c.dir, '.page-render');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const one: DeckPlan = { ...c.plan, pages: [c.plan.pages[n - 1]] };
    const { buffer } = await assembleDeck({ templatePath: path.join(c.dir, 'template.pptx'), catalog: c.catalog, cfg: c.cfg, plan: one, photoDir: path.join(c.dir, 'photos'), outFile: path.join(work, 'page.pptx') });
    const r = await renderDeck(buffer, work, { dpi: c.cfg.review.dpi });
    if (!r.pages[0]) throw new Error('ページの画像ができなかった');
    mkdirSync(path.join(c.dir, 'pages'), { recursive: true });
    copyFileSync(r.pages[0], path.join(c.dir, 'pages', `${pad(n)}.png`));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function aiContext(c: Ctx): AiContext {
  const transport = aiTransport();
  return {
    transport,
    modelId: c.cfg.ai.model,
    effort: c.cfg.ai.effort,
    record: (r: AiCallRecord) => appendFileSync(path.join(c.dir, 'ai-calls.jsonl'), JSON.stringify({ at: new Date().toISOString(), transport: transport.name, ...r }) + '\n'),
  };
}

function planArgs(c: Ctx): PlanArgs {
  const outline = readJson<Outline>(path.join(c.dir, 'outline.json'));
  const mem = new Map<string, unknown>();
  return {
    catalog: c.catalog,
    cfg: c.cfg,
    manuscript: c.manuscript,
    outline,
    check: c.check,
    store: { get: <T>(k: string) => mem.get(k) as T | undefined, set: (k, v) => void mem.set(k, v) },
    log: (m) => appendFileSync(path.join(c.dir, 'log.txt'), `${new Date().toISOString()} 仕上げ ${m}\n`),
  };
}

const result = (c: Ctx, n: number) => ({ page: pageView(c, n, c.plan.pages[n - 1]) });

// ---------------------------------------------------------------- 文字を書き換える

export function saveText(id: string, n: number, slots: Record<string, string>) {
  return serial(id, async () => {
    const c = load(id);
    const p = pageAt(c, n);
    const t = typeOf(c, p.type);
    const next: Record<string, string> = {};
    for (const s of textSlots(t)) next[s.name] = (slots[s.name] ?? p.slots[s.name] ?? '').replace(/\r\n?/g, '\n');
    snapshot(c, `${n}ページ目の文字を直した`, n);
    c.plan.pages[n - 1] = { ...p, slots: next, trimmed: p.trimmed.filter((s) => next[s] === p.slots[s]) };
    await commit(c, [n]);
    return result(c, n);
  });
}

// ---------------------------------------------------------------- AI に頼んで直す

export function aiRevise(id: string, n: number, instruction: string) {
  if (!instruction.trim()) throw new AppError('どう直してほしいかを書いてください');
  checkBudget();
  return serial(id, async () => {
    const c = load(id);
    const p = pageAt(c, n);
    const ai = aiContext(c);
    const fixed = await fixPage(ai, planArgs(c), p.outlinePage ?? n, { type: p.type, slots: p.slots, photos: p.photos }, {
      allowRetype: false,
      stage: 'E段',
      forced: [issue('VISUAL_REVIEW', `使う人からの依頼：${instruction.trim()}`, { page: n })],
    });
    snapshot(c, `${n}ページ目をAIに直してもらった（${instruction.trim().slice(0, 30)}）`, n);
    // 文言だけを直す（型は替えない）ので、写真・元の写真・切り抜きの記録は引き継ぐ
    c.plan.pages[n - 1] = { ...fixed, photoFiles: p.photoFiles, photoSources: p.photoSources, photoFit: p.photoFit, rewrites: p.rewrites + fixed.rewrites };
    await commit(c, [n]);
    return result(c, n);
  });
}

// ---------------------------------------------------------------- ページの形を替える

export function changeType(id: string, n: number, typeKey: string) {
  checkBudget();
  return serial(id, async () => {
    const c = load(id);
    const p = pageAt(c, n);
    const from = typeOf(c, p.type);
    const to = typeOf(c, typeKey);
    if (from.key === to.key) return result(c, n);
    // 同じ名前の欄は文言を引き継ぎ、足りない欄は AI に埋めてもらう
    const draftSlots = Object.fromEntries(textSlots(to).map((s) => [s.name, p.slots[s.name] ?? '']));
    const fixed = await fixPage(aiContext(c), planArgs(c), p.outlinePage ?? n, { type: to.key, slots: draftSlots, photos: {} }, {
      allowRetype: false,
      stage: 'E段',
      forced: [issue('VISUAL_REVIEW', `ページの形を「${from.label}」から「${to.label}」に替えた。前の形の文言（${JSON.stringify(p.slots)}）を参考に、新しい形の全部の欄を、このページの内容で埋める`, { page: n })],
    });
    // 写真は、前の形で使っていた写真を順に引き継ぐ（枠の縦横比に合わせて切り抜き直す）
    const sources = imageSlots(from).map((s) => photoSource(c, n, s.name)).filter((x): x is string => !!x);
    const photoFiles: Record<string, string> = {};
    const photoSources: Record<string, string> = {};
    const photoFit: Record<string, PhotoFit> = {};
    const mirrored = !!p.mirrored && canMirror(c.cfg, to.key);
    for (const [i, s] of imageSlots(to).entries()) {
      const src = sources[i % Math.max(1, sources.length)];
      if (!src) continue;
      const placed = await placePhoto(c, n, to, s.name, src, mirrored);
      photoFiles[s.name] = placed.name;
      photoFit[s.name] = placed.fit;
      photoSources[s.name] = path.relative(c.dir, src);
    }
    snapshot(c, `${n}ページ目の形を「${to.label}」に替えた`, n);
    c.plan.pages[n - 1] = { ...fixed, photoFiles, photoSources, photoFit, retypedFrom: from.key, mirrored };
    await commit(c, [n]);
    return result(c, n);
  });
}

// ---------------------------------------------------------------- 写真を替える

/** そのページの写真の欄に、いま使っている写真の元（加工する前）のファイル */
function photoSource(c: Ctx, n: number, slot: string): string | null {
  const p = c.plan.pages[n - 1];
  const own = p.photoSources?.[slot];
  if (own) return path.join(c.dir, own);
  const done = path.join(c.dir, 'photos', 'done.json');
  if (!existsSync(done)) return null;
  const rec = (readJson<{ records?: PhotoRecord[] }>(done).records ?? []).find((r) => r.page === n && r.slot === slot);
  if (!rec?.file) return null;
  if (rec.source === 'generated') {
    const gen = readJson<Array<{ key: string; file: string }>>(path.join(c.dir, 'photos', 'generated.json')).find((g) => g.key === rec.file);
    return gen ? path.join(c.dir, 'photos', gen.file) : null;
  }
  const lib = readJson<{ photos: string | null }>(path.join(c.dir, 'run.json')).photos;
  return lib ? path.join(lib, rec.file) : null;
}

/** 欄の「図形に隠れず見えている部分」。測れなければ null（顔を枠に残すことだけ考えて切り抜く） */
async function visibilityOf(c: Ctx): Promise<VisibilityMap | null> {
  return ensureVisibility(path.join(c.dir, 'template.pptx'), c.catalog, CACHE, c.cfg.mirror).catch(() => null);
}

/** 写真を枠に合わせて加工し、photos/ に置く（名前に版を付けて、前の写真を上書きしない＝戻せる）。顔が図形に隠れない切り抜きを選ぶ */
async function placePhoto(c: Ctx, n: number, t: CatalogType, slot: string, src: string, mirrored = !!c.plan.pages[n - 1]?.mirrored): Promise<{ name: string; fit: PhotoFit }> {
  const s = t.slots.find((x) => x.name === slot && x.kind === 'img');
  if (!s?.aspect) throw new AppError('その写真の欄はありません');
  const proc = s.process ?? { mono: true, multiply: null };
  const name = `p${pad(n)}-${slot.replace(/[^\w.-]/g, '_')}-${Date.now()}.jpg`;
  const grid = (await visibilityOf(c))?.[visKey({ type: t.key, mirrored })]?.[slot] ?? null;
  // 左右の反転は、この資料のために生成した写真だけ（支給・人が選んだ写真は向きを変えない）
  const allowFlip = path.relative(path.join(c.dir, 'photos', 'generated'), src).split(path.sep)[0] !== '..';
  const { fit } = await processPhoto(src, path.join(c.dir, 'photos', name), s.aspect, proc, resolveColor(proc.multiply, c.catalog.theme.colors), 1600, { grid, allowFlip, minCropWidth: (s.box.w * 96) / 72 });
  return { name, fit };
}

export function replacePhoto(id: string, n: number, slot: string, upload: { name: string; data: Buffer }) {
  return serial(id, async () => {
    const c = load(id);
    const p = pageAt(c, n);
    const t = typeOf(c, p.type);
    const ext = (path.extname(upload.name).toLowerCase().match(/^\.(jpe?g|png|webp)$/) ?? [null])[0];
    if (!ext) throw new AppError('写真は JPEG・PNG・WebP のどれかにしてください');
    const up = path.join(c.dir, 'uploads');
    mkdirSync(up, { recursive: true });
    const src = path.join(up, `edit-p${pad(n)}-${Date.now()}${ext}`);
    writeFileSync(src, upload.data);
    let placed: { name: string; fit: PhotoFit };
    try {
      placed = await placePhoto(c, n, t, slot, src);
    } catch (e) {
      rmSync(src, { force: true });
      if (e instanceof AppError) throw e;
      throw new AppError('この写真は読み込めませんでした。別の写真を選んでください');
    }
    snapshot(c, `${n}ページ目の写真（${slotLabel(slot)}）を替えた`, n);
    c.plan.pages[n - 1] = {
      ...p,
      photoFiles: { ...p.photoFiles, [slot]: placed.name },
      photoSources: { ...p.photoSources, [slot]: path.relative(c.dir, src) },
      photoFit: { ...p.photoFit, [slot]: placed.fit },
    };
    await commit(c, [n]);
    return result(c, n);
  });
}

// ---------------------------------------------------------------- 左右を入れ替える（D-042）

/**
 * ページの左右を入れ替える。写真と図形のかたまりが反対側に移り、文字のそろいと順番は変わらない。
 * 写真は、新しい向きで図形に隠れる部分を測り直して切り抜き直す（顔が隠れないように）
 */
export function toggleMirror(id: string, n: number) {
  return serial(id, async () => {
    const c = load(id);
    const p = pageAt(c, n);
    if (!canMirror(c.cfg, p.type)) throw new AppError('このページの形は、左右を入れ替えられません');
    const t = typeOf(c, p.type);
    const mirrored = !p.mirrored;
    const photoFiles = { ...p.photoFiles };
    const photoSources = { ...p.photoSources };
    const photoFit = { ...p.photoFit };
    for (const s of imageSlots(t)) {
      const src = photoSource(c, n, s.name);
      if (!src || !p.photoFiles?.[s.name]) continue; // 見本の写真のままの欄は、そのまま
      const placed = await placePhoto(c, n, t, s.name, src, mirrored);
      photoFiles[s.name] = placed.name;
      photoFit[s.name] = placed.fit;
      photoSources[s.name] = path.relative(c.dir, src);
    }
    snapshot(c, `${n}ページ目の左右を入れ替えた`, n);
    c.plan.pages[n - 1] = { ...p, mirrored, photoFiles, photoSources, photoFit };
    await commit(c, [n]);
    return result(c, n);
  });
}

// ---------------------------------------------------------------- 元に戻す

export function versions(id: string) {
  const dir = runDir(id);
  const vdir = path.join(dir, 'versions');
  if (!existsSync(vdir)) return [];
  return readdirSync(vdir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .map((f) => {
      const v = readJson<{ at: string; label: string; page: number }>(path.join(vdir, f));
      return { at: v.at, label: v.label, page: v.page };
    });
}

/** いちばん最後の直しを取り消す */
export function undo(id: string) {
  return serial(id, async () => {
    const c = load(id);
    const vdir = path.join(c.dir, 'versions');
    const last = existsSync(vdir) ? readdirSync(vdir).filter((f) => f.endsWith('.json')).sort().pop() : undefined;
    if (!last) throw new AppError('戻せる直しがありません');
    const v = readJson<{ plan: DeckPlan; label: string }>(path.join(vdir, last));
    const changed = v.plan.pages.map((pg, i) => (JSON.stringify(pg) !== JSON.stringify(c.plan.pages[i]) ? i + 1 : 0)).filter(Boolean);
    c.plan = v.plan;
    await commit(c, changed);
    rmSync(path.join(vdir, last));
    return { undone: v.label, pages: changed };
  });
}

// ---------------------------------------------------------------- PDF

/** PDF が古ければ（直したあとなら）全ページを描き直して作る */
export function ensurePdf(id: string): Promise<string> {
  return serial(id, async () => {
    const c = load(id);
    const pdf = path.join(c.dir, 'deck.pdf');
    if (mtime(pdf) >= mtime(path.join(c.dir, 'deck.pptx'))) return pdf;
    const r = await renderDeck(readFileSync(path.join(c.dir, 'deck.pptx')), c.dir, { dpi: c.cfg.review.dpi });
    writeJson(path.join(c.dir, 'render.json'), { engine: r.engine, fonts: r.fonts, pages: r.pages.map((p) => path.relative(c.dir, p)), ms: r.ms });
    return pdf;
  });
}

export type { Issue };
