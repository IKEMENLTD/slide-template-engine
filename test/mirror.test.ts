/**
 * ページの左右反転（D-042）。先方の指摘「図形の配置はもっと自由になるかと思った」への対応。
 * 写真と図形のかたまりだけを反対側に移し、文字のそろい・順番・角のラベル・右下の三角は崩さないこと、
 * どのページを反転するかを決まり（写真の寄る側を交互に）で決めることを確かめる。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, describe, expect, it } from 'vitest';
import { mirrorPptx, mirrorSlideXml, orderedSlideParts, shapeBoxes, TEXT_MARGIN } from '../src/assemble/mirror.js';
import { chooseMirrors, photoSide } from '../src/plan/mirror-plan.js';
import type { DeckPlan } from '../src/plan/schema.js';
import { build } from '../src/run/build.js';
import { buildFixtureCatalog, CONFIG, fakeGenerator, photoAwareFake, ROOT, TEMPLATE } from './helpers.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'slidegen-mirror-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const W = 960;
const H = 540;
const EMU = 12700;
async function slideXml(n: number) {
  const zip = await JSZip.loadAsync(readFileSync(TEMPLATE));
  return zip.file(`ppt/slides/slide${n}.xml`)!.async('string');
}
const flip = (xml: string, fixed: string[] = []) => mirrorSlideXml(xml, W * EMU, H * EMU, new Set(fixed));
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.6);

describe('ページの左右反転：写真と図形のかたまりだけを写す', () => {
  it('写真の枠と飾りの図形は縦の中心線で写す。固定した角のラベルは動かさない（注意・強調の型）', async () => {
    const xml = await slideXml(6);
    const a = shapeBoxes(xml);
    const b = shapeBoxes(flip(xml, ['txt.eyebrow', 'deco.end-triangle']));
    near(b['img.hero'].x, W - a['img.hero'].x - a['img.hero'].w);
    near(b['deco.band'].x, W - a['deco.band'].x - a['deco.band'].w);
    expect(b['txt.eyebrow']).toEqual(a['txt.eyebrow']);
  });
  it('図形の形も左右に写す（flipH ではなく座標。写真そのものは鏡写しにしない）', async () => {
    const xml = await slideXml(6);
    const out = flip(xml);
    expect(out).not.toMatch(/flipH="1"/);
    const ptsA = [...xml.matchAll(/<a:pt x="(\d+)"/g)].map((m) => Number(m[1]));
    const ptsB = [...out.matchAll(/<a:pt x="(\d+)"/g)].map((m) => Number(m[1]));
    expect(ptsB).not.toEqual(ptsA);
    expect(ptsB).toHaveLength(ptsA.length);
  });
  it('固定した右下の三角でも、写した写真の上に乗るなら写真と一緒に写す（写真を三角で隠さない）', async () => {
    const xml = await slideXml(6);
    const a = shapeBoxes(xml);
    const b = shapeBoxes(flip(xml, ['txt.eyebrow', 'deco.end-triangle']));
    near(b['deco.end-triangle'].x, W - a['deco.end-triangle'].x - a['deco.end-triangle'].w);
    // 写真に乗らない型（数値の型で、写真が細い帯のとき）は確かめない：重なるかどうかは型の形で決まる
  });
  it('左端のそろった文字（見出しと本文）は、そろいを保ってひとかたまりで移し、端に寄りすぎない', async () => {
    const xml = await slideXml(6);
    const a = shapeBoxes(xml);
    const b = shapeBoxes(flip(xml, ['txt.eyebrow', 'deco.end-triangle']));
    near(b['txt.body'].x - b['txt.headline'].x, a['txt.body'].x - a['txt.headline'].x);
    expect(b['txt.headline'].x).toBeGreaterThanOrEqual(W * TEXT_MARGIN - 0.6);
    expect(b['txt.headline'].w).toBe(a['txt.headline'].w); // 幅は変えない（字の収まりを測り直さずに済む）
    expect(b['txt.headline'].x).toBeLessThan(W / 2); // 反対側に移った
  });
  it('見出しの下線は見出しの左端に付いたまま（写真＋本文A）', async () => {
    const xml = await slideXml(14);
    const a = shapeBoxes(xml);
    const b = shapeBoxes(flip(xml, ['deco.end-triangle']));
    near(b['deco.rule'].x - b['txt.headline'].x, a['deco.rule'].x - a['txt.headline'].x);
    expect(b['img.left'].x).toBeGreaterThan(W / 2);
  });
  it('横に並ぶ項目は順番（1→2→3 を左から）と、数字の下の線の位置を保つ（数値の型）', async () => {
    const xml = await slideXml(5);
    const a = shapeBoxes(xml);
    const b = shapeBoxes(flip(xml, ['deco.end-triangle']));
    expect(b['txt.label.1'].x).toBeLessThan(b['txt.label.2'].x);
    expect(b['txt.label.2'].x).toBeLessThan(b['txt.label.3'].x);
    for (const n of [1, 2, 3]) near(b[`deco.value-${n}-rule`].x - b[`num.value.${n}`].x, a[`deco.value-${n}-rule`].x - a[`num.value.${n}`].x);
    expect(b['img.side'].x).toBeGreaterThan(W / 2);
  });
  it('縦に並ぶ項目は、点が文字の左のまま、上から下の順も変わらない（写真＋本文B）', async () => {
    const xml = await slideXml(15);
    const b = shapeBoxes(flip(xml));
    for (const n of [1, 2, 3]) expect(b[`deco.point-${n}`].x).toBeLessThan(b[`txt.item.${n}`].x);
    expect(b['txt.item.1'].y).toBeLessThan(b['txt.item.2'].y);
    expect(b['img.hero'].x).toBeGreaterThan(W / 3);
  });
  it('斜めの文字（固定しないもの）は角度を逆にし、左揃えは右揃えに（ラベルが角の側に寄る）。中央揃えはそのまま', async () => {
    const pick = (x: string) => x.match(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*name="txt\.eyebrow"[\s\S]*?<\/p:sp>/)![0];
    const xml = await slideXml(5);
    const centered = pick(flip(xml, ['deco.end-triangle']));
    expect(centered).toMatch(/rot="2700000"/);
    expect(centered).toMatch(/algn="ctr"/);
    const left = pick(flip(xml.replace(/algn="ctr"/g, 'algn="l"'), ['deco.end-triangle']));
    expect(left).toMatch(/algn="r"/);
    expect(left).not.toMatch(/algn="l"/);
  });
  it('2回写すと元に戻る（文字の欄の端寄せが無い型）', async () => {
    const xml = await slideXml(7);
    expect(shapeBoxes(flip(flip(xml)))).toEqual(shapeBoxes(xml));
  });
});

describe('どのページを反転するか（決まりで決める。AI は関わらない）', () => {
  const page = (type: string) => ({ type, slots: {}, photos: {}, outlinePage: 1, trimmed: [], phraseBroken: [], rewrites: 0 });
  const plan = (types: string[]): DeckPlan => ({ version: 1, deckTitle: 't', template: { file: 'x', sha256: 'x' }, pages: types.map(page) });

  it('写真の寄る側が、写真のあるページ同士で左右交互になる。表紙と、反転を許していない型は反転しない', async () => {
    const catalog = await buildFixtureCatalog();
    const p = plan(['cover', 'numbers/3', 'attention', 'photo-text/a', 'issues/3', 'photo-text/b', 'attention']);
    chooseMirrors(p, catalog, CONFIG);
    expect(p.pages[0].mirrored).toBe(false);
    expect(p.pages[4].mirrored).toBe(false);
    const sides = p.pages
      .map((pg) => photoSide(catalog.types.find((t) => t.key === pg.type)!, W) * (pg.mirrored ? -1 : 1))
      .filter((s, i) => s !== 0 && CONFIG.mirror[p.pages[i].type]);
    for (let i = 1; i < sides.length; i++) expect(sides[i]).not.toBe(sides[i - 1]);
  });
  it('写真の寄らない型（中扉）は、前に出たときと向きを変える', async () => {
    const catalog = await buildFixtureCatalog();
    const p = plan(['cover', 'section', 'issues/3', 'section', 'issues/3', 'section']);
    chooseMirrors(p, catalog, CONFIG);
    expect(p.pages.filter((x) => x.type === 'section').map((x) => x.mirrored)).toEqual([false, true, false]);
  });
  it('人が仕上げの画面で決めたページ（keep）は変えない', async () => {
    const catalog = await buildFixtureCatalog();
    const p = plan(['cover', 'numbers/3', 'attention']);
    p.pages[1].mirrored = false;
    chooseMirrors(p, catalog, CONFIG, new Set([2]));
    expect(p.pages[1].mirrored).toBe(false);
  });
  it('設定に mirror が無いテンプレートでは、どのページも反転しない', async () => {
    const catalog = await buildFixtureCatalog();
    const p = plan(['cover', 'numbers/3', 'attention', 'section']);
    chooseMirrors(p, catalog, { mirror: {} });
    expect(p.pages.every((x) => x.mirrored === false)).toBe(true);
  });
});

describe('資料を作ると、決まりで選んだページが反転して組まれる', () => {
  it('写真が左の型が、写真が左の表紙の次に来たら反転し、出来上がりの PPTX の写真の枠が右へ移る', async () => {
    const FIX = path.join(ROOT, 'test/fixtures/short');
    const outline = readFileSync(path.join(FIX, 'outline.json'), 'utf8');
    const draft = `{"pages": ${readFileSync(path.join(FIX, 'draft-01.json'), 'utf8')}}`;
    const res = await build({ root: ROOT, outDir: tmp, input: path.join(ROOT, 'samples/manuscript-01-short.md'), template: TEMPLATE, transport: photoAwareFake([outline, draft]), imageGenerator: fakeGenerator(), render: false, log: () => {} });
    const plan = JSON.parse(readFileSync(path.join(res.dir, 'deck-plan.json'), 'utf8')) as DeckPlan;
    const n = plan.pages.findIndex((p) => p.type === 'numbers/3') + 1;
    expect(plan.pages[n - 1].mirrored).toBe(true);
    expect(plan.pages.filter((p) => p.mirrored).map((p) => p.type).every((t) => CONFIG.mirror[t])).toBe(true);
    const zip = await JSZip.loadAsync(readFileSync(path.join(res.dir, 'deck.pptx')));
    const parts = await orderedSlideParts(zip);
    const box = shapeBoxes(await zip.file(parts[n - 1])!.async('string'))['img.side'];
    near(box.x, W - box.w); // 見本では左端（x=0）
    expect(res.errors).toBe(0);
  }, 120_000);
  it('反転するページが無ければ、PPTX は1バイトも変えない', async () => {
    const buf = readFileSync(TEMPLATE);
    expect(await mirrorPptx(buf, [])).toBe(buf);
  });
});
