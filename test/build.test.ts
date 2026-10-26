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
    const res = await build({ root: ROOT, outDir: tmp, input, template: TEMPLATE, transport: t, imageGenerator: fakeGenerator(), log: quiet });
    expect(res.errors).toBe(0);
    expect(existsSync(path.join(res.dir, 'deck.pptx'))).toBe(true);
    const slides = await readDeckTexts(readFileSync(path.join(res.dir, 'deck.pptx')));
    expect(slides).toHaveLength(5);
    // 強調は PPTX の中で下線の run になり、読み直すと [[ ]] に戻る
    expect(slides[0]['txt.headline']).toContain('[[');
    const report = JSON.parse(readFileSync(path.join(res.dir, 'report.json'), 'utf8'));
    expect(report.ai.calls).toBe(3);
    expect(report.ok).toBe(true);
  });

  it('原稿に無い数字を入れた不正な設計図を与えると、検査で止まる（逆側の試験）', async () => {
    const t = photoAwareFake([outline, draft]);
    const good = await build({ root: ROOT, outDir: tmp, input, template: TEMPLATE, transport: t, imageGenerator: fakeGenerator(), log: quiet });
    const bad = path.join(tmp, 'tampered');
    cpSync(good.dir, bad, { recursive: true });
    const plan: DeckPlan = JSON.parse(readFileSync(path.join(bad, 'deck-plan.json'), 'utf8'));
    const p = plan.pages.find((x) => x.type.startsWith('numbers'))!;
    p.slots['num.value.1'] = '95';
    p.slots['txt.note.2'] = '満足度は[[99%]]';
    writeFileSync(path.join(bad, 'deck-plan.json'), JSON.stringify(plan));
    // AI は呼ばない（A・B段の結果があるので D段と検査だけが動く）
    const res = await build({ root: ROOT, outDir: tmp, resume: bad, transport: photoAwareFake([]), imageGenerator: fakeGenerator(), log: quiet });
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
    await expect(build({ root: ROOT, outDir: tmp, input, template: TEMPLATE, transport: crashing, imageGenerator: fakeGenerator(), log: quiet })).rejects.toThrow('通信が切れた');
    const dirs = readdirSync(tmp).filter((d) => d.endsWith('manuscript-01-short')).sort();
    const dir = path.join(tmp, dirs[dirs.length - 1]);
    expect(existsSync(path.join(dir, 'outline.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'deck.pptx'))).toBe(false);
    // 2回目：続きから。A段は呼ばず、B段だけ呼ぶ
    const t = photoAwareFake([draft]);
    const res = await build({ root: ROOT, outDir: tmp, resume: dir, transport: t, imageGenerator: fakeGenerator(), log: quiet });
    expect(t.requests.map((r) => r.feature)).toEqual(['B段 下書き p1-5', 'C段 写真の割り当て']);
    expect(res.errors).toBe(0);
    expect(existsSync(path.join(dir, 'deck.pptx'))).toBe(true);
  });

  it('PPTX_REPAIR：壊れた .pptx は check で止まる（構造検査の配線）', async () => {
    const good = await build({ root: ROOT, outDir: tmp, input, template: TEMPLATE, transport: photoAwareFake([outline, draft]), imageGenerator: fakeGenerator(), log: quiet });
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
    const res = await build({ root: ROOT, outDir: tmp, input, template: TEMPLATE, transport: t, imageGenerator: fakeGenerator(), log: quiet });
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
    const res = await build({ root: ROOT, outDir: tmp, input, template: TEMPLATE, transport: t, imageGenerator: fakeGenerator(), log: quiet });
    expect(t.requests.map((r) => r.feature)).toEqual(['A段 原稿の構造化', 'B段 下書き p1-5', 'B段 書き直し p2', 'B段 書き直し p2', 'B段 型の替え p2', 'B段 書き直し p2', 'C段 写真の割り当て']);
    expect(t.requests[4].user).toMatch(/issues\/2/);
    const plan: DeckPlan = JSON.parse(readFileSync(path.join(res.dir, 'deck-plan.json'), 'utf8'));
    expect(plan.pages[1]).toMatchObject({ type: 'issues/2', retypedFrom: 'issues/3', trimmed: ['txt.item.1.body'] });
    expect(plan.pages[1].slots['txt.item.1.body']).toMatch(/…$/);
    expect(res.issues.filter((i) => i.code === 'OVERFLOW')).toEqual([]);
    expect(res.issues.filter((i) => i.code === 'TRIMMED').map((i) => i.level)).toEqual(['warning']);
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

