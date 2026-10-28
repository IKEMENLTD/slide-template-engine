/**
 * 原稿 → 設計図 → PPTX の通し（REQUIREMENTS 15章 Phase 2 の受け入れ条件）。
 * AI の応答は、短い原稿を実物の AI で通したときの出力（test/fixtures/short/）を偽物の呼び出し口から返す。
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import JSZip from 'jszip';
import { recheck } from '../src/run/build.js';
import { assembleDeck } from '../src/assemble/build-deck.js';
import { buildCatalog } from '../src/catalog/build-catalog.js';
import { readTemplate } from '../src/catalog/read-template.js';
import { CONFIG } from './helpers.js';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { build } from '../src/run/build.js';
import { readDeckTexts } from '../src/check/deck-check.js';
import type { DeckPlan } from '../src/plan/schema.js';
import { fakeGenerator, photoAwareFake, ROOT, TEMPLATE } from './helpers.js';

const FIX = path.join(ROOT, 'test/fixtures/short');
const outline = readFileSync(path.join(FIX, 'outline.json'), 'utf8');
const draft = `{"pages": ${readFileSync(path.join(FIX, 'draft-01.json'), 'utf8')}}`;
const input = path.join(ROOT, 'samples/manuscript-01-short.md');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'slidegen-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const quiet = () => {};

describe('slidegen build（偽物の AI で通す）', () => {
  it('原稿から .pptx が出て、止める指摘が 0 件', async () => {
    const t = photoAwareFake([outline, draft]);
    const res = await build({ root: ROOT, outDir: tmp, input, template: TEMPLATE, transport: t, imageGenerator: fakeGenerator(), render: false, log: quiet });
    expect(res.errors).toBe(0);
    expect(existsSync(path.join(res.dir, 'deck.pptx'))).toBe(true);
    const slides = await readDeckTexts(readFileSync(path.join(res.dir, 'deck.pptx')));
    expect(slides).toHaveLength(5);
    // 強調は PPTX の中で下線の run になり、読み直すと [[ ]] に戻る
    expect(slides[0]['txt.headline']).toContain('[[');
    const report = JSON.parse(readFileSync(path.join(res.dir, 'report.json'), 'utf8'));
    expect(report.ai.calls).toBe(3);
    expect(report.ok).toBe(true);
    // 丸めていない資料に TRIMMED は出ない（TRIMMED の通る側）
    expect(res.issues.filter((i) => i.code === 'TRIMMED')).toEqual([]);
  });

  it('原稿に無い数字を入れた不正な設計図を与えると、検査で止まる（逆側の試験）', async () => {
    const t = photoAwareFake([outline, draft]);
    const good = await build({ root: ROOT, outDir: tmp, input, template: TEMPLATE, transport: t, imageGenerator: fakeGenerator(), render: false, log: quiet });
    const bad = path.join(tmp, 'tampered');
    cpSync(good.dir, bad, { recursive: true });
    const plan: DeckPlan = JSON.parse(readFileSync(path.join(bad, 'deck-plan.json'), 'utf8'));
    const p = plan.pages.find((x) => x.type.startsWith('numbers'))!;
    p.slots['num.value.1'] = '95';
    p.slots['txt.note.2'] = '満足度は[[99%]]';
    writeFileSync(path.join(bad, 'deck-plan.json'), JSON.stringify(plan));
    // AI は呼ばない（A・B段の結果があるので D段と検査だけが動く）
    const res = await build({ root: ROOT, outDir: tmp, resume: bad, transport: photoAwareFake([]), imageGenerator: fakeGenerator(), render: false, log: quiet });
    const nums = res.issues.filter((i) => i.code === 'NUMBER_NOT_IN_SOURCE');
    expect(nums.map((i) => i.slot).sort()).toEqual(['num.value.1', 'txt.note.2']);
    expect(nums.every((i) => i.level === 'error')).toBe(true);
    expect(res.errors).toBeGreaterThan(0);
    expect(readFileSync(path.join(bad, 'report.md'), 'utf8')).toMatch(/止める指摘 \d+ 件/);
  });

  it('途中で落ちても --resume で続きから完了する（済んだ段の AI は呼び直さない）', async () => {
    // 1回目：A段のあと、B段の呼び出しで落ちる
    let n = 0;
    const crashing = photoAwareFake([outline]);
    const orig = crashing.complete.bind(crashing);
    crashing.complete = async (req) => {
      if (++n === 2) throw new Error('通信が切れた（試験）');
      return orig(req);
    };
    await expect(build({ root: ROOT, outDir: tmp, input, template: TEMPLATE, transport: crashing, imageGenerator: fakeGenerator(), render: false, log: quiet })).rejects.toThrow('通信が切れた');
    const dirs = readdirSync(tmp).filter((d) => d.endsWith('manuscript-01-short')).sort();
    const dir = path.join(tmp, dirs[dirs.length - 1]);
    expect(existsSync(path.join(dir, 'outline.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'deck.pptx'))).toBe(false);
    // 2回目：続きから。A段は呼ばず、B段だけ呼ぶ
    const t = photoAwareFake([draft]);
    const res = await build({ root: ROOT, outDir: tmp, resume: dir, transport: t, imageGenerator: fakeGenerator(), render: false, log: quiet });
    expect(t.requests.map((r) => r.feature)).toEqual(['B段 下書き p1-5', 'C段 写真の割り当て']);
    expect(res.errors).toBe(0);
    expect(existsSync(path.join(dir, 'deck.pptx'))).toBe(true);
  });

  it('PPTX_REPAIR：壊れた .pptx は check で止まる（構造検査の配線）', async () => {
    const good = await build({ root: ROOT, outDir: tmp, input, template: TEMPLATE, transport: photoAwareFake([outline, draft]), imageGenerator: fakeGenerator(), render: false, log: quiet });
    const bad = path.join(tmp, 'broken');
    cpSync(good.dir, bad, { recursive: true });
    const zip = await JSZip.loadAsync(readFileSync(path.join(bad, 'deck.pptx')));
    const media = Object.keys(zip.files).find((f) => f.startsWith('ppt/media/'))!;
    zip.remove(media);
    writeFileSync(path.join(bad, 'deck.pptx'), await zip.generateAsync({ type: 'nodebuffer' }));
    const res = await recheck(bad, ROOT);
    expect(res.issues.filter((i) => i.code === 'PPTX_REPAIR').length).toBeGreaterThan(0);
    expect(res.errors).toBeGreaterThan(0);
  });
});

describe('B段：入らない欄の書き直し・型の替え・丸め', () => {
  const pages = JSON.parse(readFileSync(path.join(FIX, 'draft-01.json'), 'utf8'));
  const long = 'あ'.repeat(70);
  const withP2 = (slots: Record<string, string>, type = 'issues/3') => JSON.stringify({ pages: pages.map((p: { type: string }, i: number) => (i === 1 ? { ...pages[1], type, slots: { ...pages[1].slots, ...slots } } : p)) });
  const page2 = (slots: Record<string, string>, type = 'issues/3') => JSON.stringify({ ...pages[1], type, slots: { ...pages[1].slots, ...slots } });

  it('欄に入らなければ、理由を添えて書き直させる（直れば丸めない）', async () => {
    const t = photoAwareFake([outline, withP2({ 'txt.item.1.body': long }), page2({ 'txt.item.1.body': '社長がいないと回らない' })]);
    const res = await build({ root: ROOT, outDir: tmp, input, template: TEMPLATE, transport: t, imageGenerator: fakeGenerator(), render: false, log: quiet });
    expect(t.requests.map((r) => r.feature)).toEqual(['A段 原稿の構造化', 'B段 下書き p1-5', 'B段 書き直し p2', 'C段 写真の割り当て']);
    expect(t.requests[2].user).toMatch(/txt\.item\.1\.body: この欄は最大\d+字×\d+行/);
    const plan: DeckPlan = JSON.parse(readFileSync(path.join(res.dir, 'deck-plan.json'), 'utf8'));
    expect(plan.pages[1]).toMatchObject({ rewrites: 1, trimmed: [] });
    expect(res.errors).toBe(0);
  });

  it('書き直しても入らなければ別の型に替え、それでも入らなければ丸めて TRIMMED を残す', async () => {
    const t = photoAwareFake([
      outline,
      withP2({ 'txt.item.1.body': long }),
      page2({ 'txt.item.1.body': long }),
      page2({ 'txt.item.1.body': long }),
      // 型の替え（同じ役割 problem の別の型）
      JSON.stringify({ type: 'issues/2', slots: { 'txt.eyebrow': 'Problems', 'txt.headline': 'こんなお悩み', 'txt.item.1.title': '属人化', 'txt.item.1.body': long, 'txt.item.2.title': '人件費', 'txt.item.2.body': '教育に時間がかかる' }, photos: {} }),
      JSON.stringify({ type: 'issues/2', slots: { 'txt.eyebrow': 'Problems', 'txt.headline': 'こんなお悩み', 'txt.item.1.title': '属人化', 'txt.item.1.body': long, 'txt.item.2.title': '人件費', 'txt.item.2.body': '教育に時間がかかる' }, photos: {} }),
    ]);
    const res = await build({ root: ROOT, outDir: tmp, input, template: TEMPLATE, transport: t, imageGenerator: fakeGenerator(), render: false, log: quiet });
    expect(t.requests.map((r) => r.feature)).toEqual(['A段 原稿の構造化', 'B段 下書き p1-5', 'B段 書き直し p2', 'B段 書き直し p2', 'B段 型の替え p2', 'B段 書き直し p2', 'C段 写真の割り当て']);
    expect(t.requests[4].user).toMatch(/issues\/2/);
    const plan: DeckPlan = JSON.parse(readFileSync(path.join(res.dir, 'deck-plan.json'), 'utf8'));
    expect(plan.pages[1]).toMatchObject({ type: 'issues/2', retypedFrom: 'issues/3', trimmed: ['txt.item.1.body'] });
    expect(plan.pages[1].slots['txt.item.1.body']).toMatch(/…$/);
    expect(res.issues.filter((i) => i.code === 'OVERFLOW')).toEqual([]);
    expect(res.issues.filter((i) => i.code === 'TRIMMED').map((i) => i.level)).toEqual(['warning']);
  });
});

describe('B段：同じ数字の繰り返し（NUMBER_REPEATED。2026-10-27 実例）', () => {
  const pages = JSON.parse(readFileSync(path.join(FIX, 'draft-01.json'), 'utf8'));
  const rep = { 'num.value.1': '8', 'txt.unit.1': '時間', 'num.value.2': '8', 'txt.unit.2': '時間', 'num.value.3': '8', 'txt.unit.3': '時間' };
  const p3 = JSON.stringify({ ...pages[2], slots: { ...pages[2].slots, ...rep } });
  const withP3 = JSON.stringify({ pages: pages.map((p: object, i: number) => (i === 2 ? JSON.parse(p3) : p)) });
  const attention = JSON.stringify({ type: 'attention', slots: { 'txt.eyebrow': 'Results', 'txt.headline': '請求書づくりが[[月8時間]]に', 'txt.body': '導入後は、請求書づくりにかかる時間が月8時間になりました。' }, photos: { 'img.hero': '事務所で請求書を確認する担当者' } });

  it('書き直しても同じ数字が並ぶなら、数字の欄を持たない型（attention など）に替える', async () => {
    const t = photoAwareFake([outline, withP3, p3, p3, attention]);
    const res = await build({ root: ROOT, outDir: tmp, input, template: TEMPLATE, transport: t, imageGenerator: fakeGenerator(), render: false, log: quiet });
    expect(t.requests.map((r) => r.feature)).toEqual(['A段 原稿の構造化', 'B段 下書き p1-5', 'B段 書き直し p3', 'B段 書き直し p3', 'B段 型の替え p3', 'C段 写真の割り当て']);
    expect(t.requests[2].user).toMatch(/num\.value\.2 が num\.value\.1 と同じ数字/);
    // 替え先の候補に数字の型は入れない
    expect(t.requests[4].user).toMatch(/attention/);
    expect(t.requests[4].user).not.toMatch(/型 numbers\/3 では下の指摘を直せませんでした。次の型のどれかに替えて[\s\S]*key: numbers\/3/);
    const plan: DeckPlan = JSON.parse(readFileSync(path.join(res.dir, 'deck-plan.json'), 'utf8'));
    expect(plan.pages[2]).toMatchObject({ type: 'attention', retypedFrom: 'numbers/3' });
    expect(res.issues.filter((i) => i.code === 'NUMBER_REPEATED')).toEqual([]);
    expect(res.errors).toBe(0);
  });

  it('替えずに出来上がった資料に同じ数字が並んでいれば、検査で止まる（逆側の試験）', async () => {
    const good = await build({ root: ROOT, outDir: tmp, input, template: TEMPLATE, transport: photoAwareFake([outline, draft]), imageGenerator: fakeGenerator(), render: false, log: quiet });
    const bad = path.join(tmp, 'repeated');
    cpSync(good.dir, bad, { recursive: true });
    const plan: DeckPlan = JSON.parse(readFileSync(path.join(bad, 'deck-plan.json'), 'utf8'));
    Object.assign(plan.pages.find((x) => x.type.startsWith('numbers'))!.slots, rep);
    writeFileSync(path.join(bad, 'deck-plan.json'), JSON.stringify(plan));
    const res = await build({ root: ROOT, outDir: tmp, resume: bad, transport: photoAwareFake([]), imageGenerator: fakeGenerator(), render: false, log: quiet });
    expect(res.issues.filter((i) => i.code === 'NUMBER_REPEATED').map((i) => i.slot)).toEqual(['num.value.2', 'num.value.3']);
    expect(res.errors).toBeGreaterThan(0);
  });
});

describe('大見出しの明朝（設定 headline.mincho。16章 #3）', () => {
  it('false なら、カタログはゴシックで測り、組み立てでテーマの本文用の字体（+mn）に差し替える', async () => {
    const cfg = { ...CONFIG, headline: { ...CONFIG.headline, mincho: false } };
    const raw = await readTemplate(readFileSync(TEMPLATE));
    const { catalog } = buildCatalog(raw, cfg, { file: 'x', sha256: 'x', resolveFile: (p) => path.join(ROOT, p) });
    const head = catalog.types.find((t) => t.key === 'cover')!.slots.find((x) => x.name === 'txt.headline')!;
    expect(head.style!.ea).toBe(raw.theme.fonts.minorEa);
    const minchoHead = (await (async () => buildCatalog(raw, CONFIG, { file: 'x', sha256: 'x', resolveFile: (p) => path.join(ROOT, p) }))()).catalog.types[0].slots.find((x) => x.name === 'txt.headline')!;
    expect(minchoHead.style!.ea).toBe(raw.theme.fonts.majorEa);
    const plan: DeckPlan = { version: 1, deckTitle: 't', template: { file: 'x', sha256: 'x' }, pages: [{ type: 'section', slots: { 'txt.headline': '中扉の見出し' }, photos: {}, outlinePage: 1, trimmed: [], phraseBroken: [], rewrites: 0 }, { type: 'attention', slots: { 'txt.eyebrow': 'Point', 'txt.headline': '大事なこと', 'txt.body': '説明' }, photos: {}, outlinePage: 2, trimmed: [], phraseBroken: [], rewrites: 0 }] };
    const out = path.join(tmp, 'gothic.pptx');
    await assembleDeck({ templatePath: TEMPLATE, catalog, cfg, plan, photoDir: tmp, outFile: out });
    // 「大事なこと」の run の書式（rPr）に、テーマの本文用の字体の参照が入る
    const headRun = async (file: string) => {
      const zip = await JSZip.loadAsync(readFileSync(file));
      const xmls = await Promise.all(Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).map((f) => zip.file(f)!.async('string')));
      return xmls.join('').match(/<a:r><a:rPr[^>]*>(?:(?!<\/a:rPr>)[\s\S])*<\/a:rPr><a:t>大事なこと<\/a:t>/)![0];
    };
    expect(await headRun(out)).toContain('typeface="+mn-ea"');
    // 明朝のまま（true）なら差し替えない
    await assembleDeck({ templatePath: TEMPLATE, catalog, cfg: CONFIG, plan, photoDir: tmp, outFile: out });
    expect(await headRun(out)).not.toContain('typeface="+mn-ea"');
  });
});

describe('E段：見た目の採点で指摘されたページだけを作り直す（描画は Docker）', () => {
  it('指摘のあったページだけが変わり、他のページはスライドの中身が1バイトも変わらない', async () => {
    const t = photoAwareFake([outline, draft]);
    const orig = t.complete.bind(t);
    const reviewCalls: string[] = [];
    t.complete = async (req) => {
      const usage = { feature: req.feature, model: req.modelId, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, cacheDeclared: false, cacheHit: false, cacheIneffective: false };
      if (req.feature.startsWith('E段 見た目の採点')) {
        t.requests.push(req);
        reviewCalls.push(req.feature);
        expect(req.images?.length).toBeGreaterThan(0);
        const pages = [...req.user.matchAll(/= p(\d+)（/g)].map((m) => Number(m[1]));
        const first = reviewCalls.length === 1;
        const body = { pages: pages.map((page) => (first && page === 2 ? { page, verdict: 'redo', problems: [{ kind: 'text', slot: 'txt.headline', message: '見出しが問いかけで弱い。結論を言い切る' }] } : { page, verdict: 'ok', problems: [] })) };
        return { text: JSON.stringify(body), stopReason: 'end_turn', model: req.modelId, ms: 1, usage };
      }
      if (req.feature === 'E段 書き直し p2') {
        t.requests.push(req);
        expect(req.user).toContain('結論を言い切る');
        const p2 = JSON.parse(readFileSync(path.join(FIX, 'draft-01.json'), 'utf8'))[1];
        return { text: JSON.stringify({ ...p2, slots: { ...p2.slots, 'txt.headline': '属人化・人件費・開発費の3つの壁' } }), stopReason: 'end_turn', model: req.modelId, ms: 1, usage };
      }
      return orig(req);
    };
    const res = await build({ root: ROOT, outDir: tmp, input, template: TEMPLATE, transport: t, imageGenerator: fakeGenerator(), log: quiet });
    expect(reviewCalls).toEqual(['E段 見た目の採点 r1 p1-5', 'E段 見た目の採点 r2 p2-2']);
    const changes = JSON.parse(readFileSync(path.join(res.dir, 'review/changes-1.json'), 'utf8'));
    expect(changes).toEqual({ redo: [2], changed: [2], unexpected: [] });
    const plan: DeckPlan = JSON.parse(readFileSync(path.join(res.dir, 'deck-plan.json'), 'utf8'));
    expect(plan.pages[1].slots['txt.headline']).toBe('属人化・人件費・開発費の3つの壁');
    expect(plan.pages.map((p) => p.revisedByReview ?? 0)).toEqual([0, 1, 0, 0, 0]);
    // 描画の結果（PDF と ページ画像）と、その中身
    expect(existsSync(path.join(res.dir, 'deck.pdf'))).toBe(true);
    expect(readdirSync(path.join(res.dir, 'pages'))).toEqual(['01.png', '02.png', '03.png', '04.png', '05.png']);
    const render = JSON.parse(readFileSync(path.join(res.dir, 'render.json'), 'utf8'));
    expect(render.fonts.some((f: string) => /^DejaVu/.test(f))).toBe(false);
    expect(res.errors).toBe(0);
    // 最後の採点で指摘が残っていないので VISUAL_REVIEW は出ない
    expect(res.issues.filter((i) => i.code === 'VISUAL_REVIEW')).toEqual([]);
    const report = JSON.parse(readFileSync(path.join(res.dir, 'report.json'), 'utf8'));
    expect(report.timingsMs['E段 描画']).toBeGreaterThan(0);
    expect(report.totalMs).toBeGreaterThan(0);
  }, 300_000);

  it('採点で「顔が隠れている」と指摘された写真は作り直し、次の採点で確かめる（顔の検出が見逃す横顔の受け皿・D-042）', async () => {
    const t = photoAwareFake([outline, draft]);
    const orig = t.complete.bind(t);
    const reviews: string[] = [];
    t.complete = async (req) => {
      const usage = { feature: req.feature, model: req.modelId, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, cacheDeclared: false, cacheHit: false, cacheIneffective: false };
      if (req.feature.startsWith('E段 見た目の採点')) {
        t.requests.push(req);
        reviews.push(req.feature);
        const pages = [...req.user.matchAll(/= p(\d+)（/g)].map((m) => Number(m[1]));
        const first = reviews.length === 1;
        const body = { pages: pages.map((page) => (first && page === 5 ? { page, verdict: 'ok', problems: [{ kind: 'photo', slot: 'img.hero', message: '主役の男性の顔がひし形の白い線に横切られて隠れている' }] } : { page, verdict: 'ok', problems: [] })) };
        return { text: JSON.stringify(body), stopReason: 'end_turn', model: req.modelId, ms: 1, usage };
      }
      return orig(req);
    };
    const gen = fakeGenerator();
    const res = await build({ root: ROOT, outDir: tmp, input, template: TEMPLATE, transport: t, imageGenerator: gen, log: quiet });
    expect(reviews).toEqual(['E段 見た目の採点 r1 p1-5', 'E段 見た目の採点 r2 p5-5']);
    const changes = JSON.parse(readFileSync(path.join(res.dir, 'review/changes-1.json'), 'utf8'));
    expect(changes).toEqual({ redo: [5], changed: [5], unexpected: [] });
    const plan: DeckPlan = JSON.parse(readFileSync(path.join(res.dir, 'deck-plan.json'), 'utf8'));
    expect(plan.pages[4].photoFiles!['img.hero']).toMatch(/-rv\d+\.jpg$/);
    // 支給の写真（1ページ目）は作り直さない＝この試験の写真は生成したもの
    expect(plan.pages[4].type).toBe('collage');
    const generated = JSON.parse(readFileSync(path.join(res.dir, 'photos/generated.json'), 'utf8')) as Array<{ key: string }>;
    expect(generated.filter((g) => /-rv\d+$/.test(g.key))).toHaveLength(1);
    // 最後の採点で指摘が残っていないので VISUAL_REVIEW は出ない
    expect(res.issues.filter((i) => i.code === 'VISUAL_REVIEW')).toEqual([]);
  }, 300_000);

  it('作り直しは1ページ2回まで。直らない指摘は VISUAL_REVIEW としてレポートに残す', async () => {
    const t = photoAwareFake([outline, draft]);
    const orig = t.complete.bind(t);
    const features: string[] = [];
    let n = 0;
    t.complete = async (req) => {
      const usage = { feature: req.feature, model: req.modelId, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, cacheDeclared: false, cacheHit: false, cacheIneffective: false };
      if (req.feature.startsWith('E段')) {
        t.requests.push(req);
        features.push(req.feature);
      }
      if (req.feature.startsWith('E段 見た目の採点')) {
        const pages = [...req.user.matchAll(/= p(\d+)（/g)].map((m) => Number(m[1]));
        const body = { pages: pages.map((page) => (page === 3 ? { page, verdict: 'redo', problems: [{ kind: 'text', slot: 'txt.footnote', message: '注記が本文と同じことを繰り返している' }] } : { page, verdict: 'ok', problems: [] })) };
        return { text: JSON.stringify(body), stopReason: 'end_turn', model: req.modelId, ms: 1, usage };
      }
      if (req.feature === 'E段 書き直し p3') {
        const p3 = JSON.parse(readFileSync(path.join(FIX, 'draft-01.json'), 'utf8'))[2];
        // 2回目の作り直しでは、原稿に無い数字を入れ続ける（決まりに反する版は採らず、元の版が残ること）
        const fn = ++n === 1 ? '数値は導入企業の結果です' : '満足度は99%です';
        return { text: JSON.stringify({ ...p3, slots: { ...p3.slots, 'txt.footnote': fn } }), stopReason: 'end_turn', model: req.modelId, ms: 1, usage };
      }
      return orig(req);
    };
    const res = await build({ root: ROOT, outDir: tmp, input, template: TEMPLATE, transport: t, imageGenerator: fakeGenerator(), log: quiet });
    expect(features).toEqual(['E段 見た目の採点 r1 p1-5', 'E段 書き直し p3', 'E段 見た目の採点 r2 p3-3', 'E段 書き直し p3', 'E段 書き直し p3', 'E段 見た目の採点 r3 p3-3']);
    expect(readdirSync(path.join(res.dir, 'review')).filter((f) => f.startsWith('changes')).sort()).toEqual(['changes-1.json', 'changes-2.json']);
    const plan: DeckPlan = JSON.parse(readFileSync(path.join(res.dir, 'deck-plan.json'), 'utf8'));
    expect(plan.pages[2].revisedByReview).toBe(1);
    expect(plan.pages[2].revertedByReview).toBe(1);
    expect(plan.pages[2].slots['txt.footnote']).toBe('数値は導入企業の結果です');
    expect(res.issues.filter((i) => i.code === 'NUMBER_NOT_IN_SOURCE')).toEqual([]);
    const vr = res.issues.filter((i) => i.code === 'VISUAL_REVIEW');
    expect(vr.map((i) => [i.page, i.level])).toEqual([[3, 'warning']]);
    expect(readFileSync(path.join(res.dir, 'report.md'), 'utf8')).toContain('[VISUAL_REVIEW] p3 txt.footnote');
  }, 300_000);
});

