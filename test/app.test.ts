/**
 * アプリ（画面のサーバー）の層：画面に出す言葉・鍵の扱い・仕上げ（文字を直す→描き直す→元に戻す）。
 * 資料は偽物の AI で作り（build と同じ）、仕上げの描き直しは本物の描画（Docker）で確かめる。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// アプリの置き場所は読み込みの前に決まるので、import より先に別の場所へ向ける
const DATA = vi.hoisted(() => {
  const d = `${process.env.TMPDIR ?? '/tmp'}/slidegen-app-${process.pid}-${Date.now()}`;
  process.env.SLIDEGEN_DATA = d;
  delete process.env.SLIDEGEN_DEV_AI;
  return d;
});

import { build } from '../src/run/build.js';
import type { DeckPlan } from '../src/plan/schema.js';
import { buildCatalog } from '../src/catalog/build-catalog.js';
import { readTemplate } from '../src/catalog/read-template.js';
import { loadConfig } from '../src/catalog/config.js';
import { issue } from '../src/check/content.js';
import { checkDraft, saveText, undo, versions, pagesView } from '../src/app/edit.js';
import { createRun, presentIssues, recommendedSlides, runView } from '../src/app/runs.js';
import { AppError, publicSettings, readSettings, writeSettings } from '../src/app/settings.js';
import { plainText, slotLabel } from '../src/app/words.js';
import { fakeGenerator, photoAwareFake, ROOT, TEMPLATE } from './helpers.js';

afterAll(() => rmSync(DATA, { recursive: true, force: true }));

describe('画面に出す言葉', () => {
  it('テンプレートの欄の名前は、すべて日本語の名前になる', async () => {
    const { catalog: cat } = buildCatalog(await readTemplate(readFileSync(TEMPLATE)), loadConfig(TEMPLATE.replace(/\.pptx$/, '.config.json')), { file: 't', sha256: 'x', resolveFile: (p) => path.join(ROOT, p) });
    const names = [...new Set(cat.types.flatMap((t) => t.slots.map((s) => s.name)))];
    for (const n of names) expect(slotLabel(n), n).not.toBe(n);
    expect(slotLabel('txt.item.2.title')).toBe('項目2の題');
    expect(slotLabel('num.value.3')).toBe('数字3');
  });

  it('指摘の文の中の欄の名前を置き換え、頭の欄の名前は外す', () => {
    expect(plainText('txt.unit.1 は単位だけを入れる欄')).toBe('「数字1の単位」 は単位だけを入れる欄');
    const [i] = presentIssues([issue('OVERFLOW', 'txt.headline: この欄は最大22字×1行。いまは40字で2行になる', { page: 2, slot: 'txt.headline' })], []);
    expect(i.detail).toBe('この欄は最大22字×1行。いまは40字で2行になる');
    expect(i.title).toBe('文字が枠に収まっていません');
    expect(i.slotLabel).toBe('大見出し');
  });

  it('人が直したページの「見た目の指摘」は出さない（直す前の絵の話なので）', () => {
    const list = [issue('VISUAL_REVIEW', '読みにくい', { page: 3 }), issue('VISUAL_REVIEW', '読みにくい', { page: 4 })];
    expect(presentIssues(list, [3]).map((i) => i.page)).toEqual([4]);
  });

  it('おすすめの枚数は原稿の長さから（実測の3本に合う）', () => {
    expect(recommendedSlides('あ'.repeat(527))).toBe(6);
    expect(recommendedSlides('あ'.repeat(1005))).toBe(12);
    expect(recommendedSlides('あ'.repeat(1592))).toBe(19);
    expect(recommendedSlides('あ'.repeat(10))).toBe(4);
    expect(recommendedSlides('あ'.repeat(9000))).toBe(20);
  });
});

describe('鍵の扱い', () => {
  it('鍵が無ければ作成を始めない（日本語の理由で止める）', async () => {
    await expect(createRun({ title: 't', manuscript: 'あ'.repeat(200), template: 'provisional', targetSlides: 5, generatePhotos: false, photos: [] })).rejects.toThrow(AppError);
    await expect(createRun({ title: 't', manuscript: 'あ'.repeat(200), template: 'provisional', targetSlides: 5, generatePhotos: false, photos: [] })).rejects.toThrow(/設定/);
  });

  it('鍵は権限 600 のファイルにだけ置き、画面には末尾4文字しか返さない', () => {
    const key = 'sk-ant-api03-THIS-IS-A-TEST-VALUE-abcd';
    writeSettings({ anthropicKey: key, monthlyBudgetUsd: 10 });
    const f = path.join(DATA, 'settings.json');
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const pub = JSON.stringify(publicSettings());
    expect(pub).not.toContain('THIS-IS-A-TEST');
    expect(publicSettings().anthropicKey).toBe('…abcd');
    expect(publicSettings().aiReady).toBe(true);
    writeSettings({ anthropicKey: '' });
    expect(readSettings().anthropicKey).toBeUndefined();
    expect(publicSettings().aiReady).toBe(false);
  });
});

describe('仕上げ（文字を直す→そのページだけ描き直す→元に戻す）', () => {
  const id = '20990101-000000';
  let dir = '';
  beforeAll(async () => {
    const FIX = path.join(ROOT, 'test/fixtures/short');
    const t = photoAwareFake([readFileSync(path.join(FIX, 'outline.json'), 'utf8'), `{"pages": ${readFileSync(path.join(FIX, 'draft-01.json'), 'utf8')}}`]);
    const runs = path.join(DATA, 'runs');
    mkdirSync(runs, { recursive: true });
    const res = await build({ root: ROOT, outDir: runs, runId: id, input: path.join(ROOT, 'samples/manuscript-01-short.md'), template: TEMPLATE, transport: t, imageGenerator: fakeGenerator(), render: false, log: () => {} });
    dir = res.dir;
    writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ state: 'done', step: 'done', title: '試験', template: '仮', targetSlides: 5, createdAt: new Date().toISOString() }));
  }, 120_000);

  it('打ちながらの検査：はみ出すと ok=false と理由、収まれば ok=true', () => {
    const p = pagesView(id)[0];
    const slots = Object.fromEntries(p.slots.map((s) => [s.name, s.text]));
    const long = checkDraft(id, 1, { ...slots, 'txt.headline': 'あ'.repeat(80) });
    expect(long.fits['txt.headline'].ok).toBe(false);
    expect(long.fits['txt.headline'].reason).toMatch(/行/);
    expect(long.issues.some((i) => i.level === 'error')).toBe(true);
    const fine = checkDraft(id, 1, slots);
    expect(fine.fits['txt.headline'].ok).toBe(true);
  });

  it('反映すると設計図・PPTX・そのページの画像が変わり、版が残る。元に戻すと元の文言に戻る', async () => {
    const plan0 = JSON.parse(readFileSync(path.join(dir, 'deck-plan.json'), 'utf8')) as DeckPlan;
    const old = plan0.pages[1].slots['txt.headline'];
    const res = await saveText(id, 2, { 'txt.headline': '試験で直した見出し' });
    expect(res.page.slots.find((s) => s.name === 'txt.headline')!.text).toBe('試験で直した見出し');
    expect(existsSync(path.join(dir, 'pages', '02.png'))).toBe(true);
    const plan1 = JSON.parse(readFileSync(path.join(dir, 'deck-plan.json'), 'utf8')) as DeckPlan;
    expect(plan1.pages[1].slots['txt.headline']).toBe('試験で直した見出し');
    // ほかのページは1文字も変わらない
    expect(plan1.pages.filter((_, i) => i !== 1)).toEqual(plan0.pages.filter((_, i) => i !== 1));
    expect(versions(id)).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(dir, 'edited.json'), 'utf8'))).toEqual([2]);
    // PPTX の中身も新しい文言（読み直して確かめる）
    const { readDeckTexts } = await import('../src/check/deck-check.js');
    expect((await readDeckTexts(readFileSync(path.join(dir, 'deck.pptx'))))[1]['txt.headline']).toBe('試験で直した見出し');
    expect(runView(id).canUndo).toBe(true);
    expect(runView(id).pdfReady).toBe(false);

    const u = await undo(id);
    expect(u.pages).toEqual([2]);
    expect((JSON.parse(readFileSync(path.join(dir, 'deck-plan.json'), 'utf8')) as DeckPlan).pages[1].slots['txt.headline']).toBe(old);
    expect(versions(id)).toHaveLength(0);
    await expect(undo(id)).rejects.toThrow(/戻せる直しがありません/);
  }, 180_000);
});

