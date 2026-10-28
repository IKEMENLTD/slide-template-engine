/**
 * 写真の顔が、上に重なる図形（色ベタ）に隠れない切り抜き（2026-10-27 先方の指摘「顔が上の色ベタで潰される」）。
 * 顔の検出・見えている部分の測り方・切り抜きの選び方・生成の構図の指示・FACE_COVERED の検査。
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { detectFaces, type Face } from '../src/photos/faces.js';
import { chooseCrop, processPhoto } from '../src/photos/prepare.js';
import { measure, openAreaHint, showsThroughIn, visibleIn, type VisGrid } from '../src/photos/visibility.js';
import { build, recheck } from '../src/run/build.js';
import type { DeckPlan } from '../src/plan/schema.js';
import { fakeGenerator, photoAwareFake, ROOT, TEMPLATE } from './helpers.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'slidegen-face-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** 左半分（u < 0.5）が図形に隠れている欄 */
const leftHidden: VisGrid = { cols: 40, rows: 40, v: Array.from({ length: 1600 }, (_, i) => (i % 40 < 20 ? 0 : 1)) };
/** 右半分が隠れている欄 */
const rightHidden: VisGrid = { cols: 40, rows: 40, v: Array.from({ length: 1600 }, (_, i) => (i % 40 < 20 ? 1 : 0)) };
const face = (x: number, y: number, w = 100, h = 120): Face => ({ x, y, w, h, score: 1 });

describe('顔の検出', () => {
  it('見本の写真（女性がパソコンに向かう）から、その顔の位置を返す', async () => {
    const f = await detectFaces(path.join(ROOT, 'templates/provisional-assets/cover.jpg'));
    expect(f.length).toBeGreaterThanOrEqual(1);
    const cx = (f[0].x + f[0].w / 2) / 1536;
    const cy = (f[0].y + f[0].h / 2) / 1024;
    expect(cx).toBeGreaterThan(0.33);
    expect(cx).toBeLessThan(0.52);
    expect(cy).toBeGreaterThan(0.1);
    expect(cy).toBeLessThan(0.4);
  });
  it('顔の無い画像（単色）は空', async () => {
    const plain = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#808080' } }).jpeg().toBuffer();
    expect(await detectFaces(plain)).toEqual([]);
  });
});

describe('見えている部分の測り方', () => {
  it('描いた画像のうち、マゼンタのまま残った所が「見えている」', async () => {
    // 左半分マゼンタ・右半分が白（図形に覆われた）のページ
    const left = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ff00ff' } }).png().toBuffer();
    const png = path.join(tmp, 'probe.png');
    await sharp({ create: { width: 400, height: 200, channels: 3, background: '#ffffff' } }).composite([{ input: left, left: 0, top: 0 }]).png().toFile(png);
    const g = (await measure(png, [{ name: 'img.a', box: { x: 0, y: 0, w: 400, h: 200 } }], { w: 400, h: 200 }))['img.a'];
    expect(visibleIn(g, 0, 0, 0.45, 1)).toBeGreaterThan(0.95);
    expect(visibleIn(g, 0.55, 0, 1, 1)).toBeLessThan(0.05);
  });
  it('写真を2色で描いて比べ、半透明の図形の下（写真が透けて見える）と、不透明な図形の下（見えない）を分ける', async () => {
    // 左から：写真がそのまま（マゼンタ／緑）・半透明の青の下（色が混ざる）・不透明な白
    const strip = async (a: string, b: string, file: string) => {
      const parts = await Promise.all([a, b, '#ffffff'].map((bg) => sharp({ create: { width: 100, height: 100, channels: 3, background: bg } }).png().toBuffer()));
      await sharp({ create: { width: 300, height: 100, channels: 3, background: '#ffffff' } }).composite(parts.map((input, i) => ({ input, left: i * 100, top: 0 }))).png().toFile(file);
    };
    const a = path.join(tmp, 'p-a.png');
    const b = path.join(tmp, 'p-b.png');
    await strip('#ff00ff', '#8040e0', a); // 1枚目：マゼンタ・（マゼンタ＋青）
    await strip('#00ff00', '#20a0b0', b); // 2枚目：緑・（緑＋青）
    const g = (await measure(a, [{ name: 'img.a', box: { x: 0, y: 0, w: 300, h: 100 } }], { w: 300, h: 100 }, b))['img.a'];
    expect(visibleIn(g, 0, 0, 0.3, 1)).toBeGreaterThan(0.95);
    expect(visibleIn(g, 0.36, 0, 0.63, 1)).toBeLessThan(0.05);
    expect(showsThroughIn(g, 0.36, 0, 0.63, 1)).toBeGreaterThan(0.95); // 半透明の下は透けて見える
    expect(showsThroughIn(g, 0.7, 0, 1, 1)).toBeLessThan(0.05); // 不透明な白の下は見えない
  });
  it('構図の指示：ほぼ全部見えていれば出さない／見えている所を言う', () => {
    expect(openAreaHint({ cols: 4, rows: 4, v: Array(16).fill(1) })).toBeNull();
    const lowerLeft: VisGrid = { cols: 30, rows: 30, v: Array.from({ length: 900 }, (_, i) => (i % 30 < 10 && Math.floor(i / 30) >= 20 ? 1 : 0)) };
    expect(openAreaHint(lowerLeft)).toMatch(/lower left/);
    expect(openAreaHint(leftHidden)).toMatch(/right/);
  });
  it('構図の指示に「図形で隠れる」と書かない（書くと生成AIが写真に色ベタの図形を描き込む。2026-10-27 実例 11枚中6枚）', () => {
    for (const g of [leftHidden, rightHidden]) {
      const h = openAreaHint(g)!;
      expect(h).not.toMatch(/hidden|cover(ed)? (by|under)|graphic shapes? will|solid graphic shapes, so/i);
      expect(h).toMatch(/do not draw any graphic shapes/);
    }
  });
  it('見えている部分が半分未満の欄では、顔を1人にするよう指示する／半分以上なら言わない', () => {
    const narrow: VisGrid = { cols: 40, rows: 40, v: Array.from({ length: 1600 }, (_, i) => (i % 40 < 12 ? 1 : 0)) };
    expect(openAreaHint(narrow)).toMatch(/Only ONE person's face/);
    expect(openAreaHint(rightHidden)).not.toMatch(/Only ONE/);
  });
  it('作り直すとき（oneFace）は、欄が広くても顔を1人にするよう指示する（2026-10-28 実例：表紙で2人目の顔が帯に入り、2回とも直らなかった）', () => {
    expect(openAreaHint(rightHidden, { oneFace: true })).toMatch(/Only ONE person's face/);
    expect(openAreaHint(rightHidden, { oneFace: true })).toMatch(/do not draw any graphic shapes/);
  });
});

describe('切り抜きの選び方', () => {
  it('写真が横に長ければ、顔が見えている側に来る位置で切る（反転しない）', () => {
    // 1600x600 の写真の右寄り（x=1050）に顔。正方形の欄の右半分が隠れる → 顔を欄の左半分に入れる
    const c = chooseCrop(1600, 600, 1, [face(1050, 200)], { grid: rightHidden, allowFlip: true });
    expect(c.faceVisible).toBeGreaterThan(0.95);
    expect(c.flipped).toBe(false);
  });
  it('位置では逃がせないとき、生成写真なら左右反転で見えている側に入れる', () => {
    // 顔が写真の左端。欄の左半分が隠れる。動かしても顔は左半分から出られない
    const c = chooseCrop(1000, 600, 1, [face(100, 200)], { grid: leftHidden, allowFlip: true });
    expect(c.flipped).toBe(true);
    expect(c.faceVisible).toBeGreaterThan(0.95);
  });
  it('支給の写真（反転しない）で逃がせないなら、見えていない割合をそのまま返す（検査で知らせる）。半透明の色の図形の下の顔は「潰れた顔」', () => {
    // 左半分に半透明の色の図形（写真は色越しに透けて見える＝s は 1）
    const tinted: VisGrid = { ...leftHidden, s: Array(1600).fill(1) };
    const c = chooseCrop(1000, 600, 1, [face(100, 200)], { grid: tinted, allowFlip: false });
    expect(c.flipped).toBe(false);
    expect(c.faceVisible).toBeLessThan(0.6);
  });
  it('顔の見え方は目・鼻・口の部分で測る：おでこ（顔の箱の上 35%）だけが帯にかかるなら見えている、目元までかかれば隠れている', () => {
    // 上の 30% が帯に隠れる正方形の欄。写真も正方形（切り抜きは動かせない）
    const band = (to: number): VisGrid => ({ cols: 40, rows: 40, v: Array.from({ length: 1600 }, (_, i) => (Math.floor(i / 40) < to * 40 ? 0 : 1)) });
    const f = face(400, 250, 200, 200); // 箱は y=250〜450（25%〜45%）
    expect(chooseCrop(1000, 1000, 1, [f], { grid: band(0.3), minCropWidth: 1000 }).faceVisible).toBeGreaterThan(0.95); // 帯は 30% まで＝おでこだけ
    expect(chooseCrop(1000, 1000, 1, [f], { grid: band(0.4), minCropWidth: 1000 }).faceVisible).toBeLessThan(0.6); // 帯が目元（40%）まで
  });
  it('枠の外に外した顔は「隠れた顔」に数えない。枠に一部だけ入る顔は数える', () => {
    // 正方形の欄に、横長の写真。左右に1人ずつ。欄の右半分は図形に隠れる → 左の人を入れ、右の人は枠の外へ
    const two = [face(150, 200, 120, 140), face(1300, 200, 120, 140)];
    const c = chooseCrop(1600, 600, 1, two, { grid: rightHidden, allowFlip: false, minCropWidth: 600 });
    expect(c.left + c.width).toBeLessThan(1300); // 右の人は枠の外
    expect(c.faceVisible).toBeGreaterThan(0.9);
  });
  it('顔も体も白い切り抜きの向こうにいる人は数えない。顔だけ隠れて体が見える人（首から上が無い人）は数える', () => {
    // 正方形の欄・正方形の写真（切り抜きは動かせない）。主役は左下、もう1人は右上
    const main = face(150, 600, 150, 150);
    const other = face(700, 100, 150, 150);
    // 右側（u > 0.5）が全部見えない → もう1人は顔も体も見えない＝画面に出ていない
    const cut = chooseCrop(1000, 1000, 1, [main, other], { grid: rightHidden, minCropWidth: 1000 });
    expect(cut.faceVisible).toBeGreaterThan(0.9);
    // 右上の顔の所だけ帯で隠れ、体（その下）は見える → 首から上が無い人に見える＝隠れた顔
    const headBand: VisGrid = { cols: 40, rows: 40, v: Array.from({ length: 1600 }, (_, i) => (i % 40 >= 20 && Math.floor(i / 40) < 10 ? 0 : 1)) };
    expect(chooseCrop(1000, 1000, 1, [main, other], { grid: headBand, minCropWidth: 1000 }).faceVisible).toBeLessThan(0.1);
  });
  it('顔が半透明の帯の下で色越しに見えるなら、体が不透明な図形の下でも「潰れた顔」として数える', () => {
    const f = face(400, 100, 200, 200); // 正方形の写真・欄。顔は上の方
    // 顔の高さまで（上 30%）：半透明の帯（v=0・s=1）、その下（体）：不透明な図形（v=0・s=0）
    const g: VisGrid = { cols: 40, rows: 40, v: Array(1600).fill(0), s: Array.from({ length: 1600 }, (_, i) => (Math.floor(i / 40) < 12 ? 1 : 0)) };
    expect(chooseCrop(1000, 1000, 1, [f], { grid: g, minCropWidth: 1000 }).faceVisible).toBeLessThan(0.1);
  });
  it('見えている部分の指定が無くても、顔を枠の端で切らない', () => {
    const c = chooseCrop(1600, 600, 1, [face(560, 200, 120, 140)], {});
    expect(c.left).toBeLessThanOrEqual(560);
    expect(c.left + c.width).toBeGreaterThanOrEqual(680);
  });
  it('粗くなるほどは拡大しない（切り抜く幅の下限）', () => {
    const c = chooseCrop(1000, 600, 1, [face(100, 200)], { grid: leftHidden, allowFlip: false, minCropWidth: 600 });
    expect(c.zoom).toBe(1);
  });
  it('実際の写真でも、欄の左半分が隠れるなら顔を右半分に入れて加工する', async () => {
    const out = path.join(tmp, 'cover-fit.jpg');
    const { fit } = await processPhoto(path.join(ROOT, 'templates/provisional-assets/cover.jpg'), out, 1, { mono: true, multiply: null }, null, 800, { grid: leftHidden, allowFlip: false });
    expect(fit.faces).toBeGreaterThanOrEqual(1);
    expect(fit.faceVisible).toBeGreaterThan(0.9);
    const m = await sharp(out).metadata();
    expect(m.width).toBe(m.height);
  });
});

describe('FACE_COVERED：顔が隠れた写真を知らせる', () => {
  it('切り抜きの記録で顔の見えている割合が下限未満なら注意、足りていれば出さない', async () => {
    const outline = readFileSync(path.join(ROOT, 'test/fixtures/short/outline.json'), 'utf8');
    const draft = `{"pages": ${readFileSync(path.join(ROOT, 'test/fixtures/short/draft-01.json'), 'utf8')}}`;
    const good = await build({ root: ROOT, outDir: tmp, input: path.join(ROOT, 'samples/manuscript-01-short.md'), template: TEMPLATE, transport: photoAwareFake([outline, draft]), imageGenerator: fakeGenerator(), render: false, log: () => {} });
    const dir = path.join(tmp, 'face');
    cpSync(good.dir, dir, { recursive: true });
    const planPath = path.join(dir, 'deck-plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    const i = plan.pages.findIndex((p: { photoFiles?: Record<string, string> }) => Object.keys(p.photoFiles ?? {}).length);
    expect(i).toBeGreaterThanOrEqual(0);
    const slot = Object.keys(plan.pages[i].photoFiles)[0];
    const setFit = (v: number) => {
      plan.pages[i].photoFit = { [slot]: { faces: 1, faceVisible: v, flipped: false, zoom: 1, crop: null } };
      writeFileSync(planPath, JSON.stringify(plan));
    };
    setFit(0.3);
    const bad = (await recheck(dir, ROOT)).issues.filter((x) => x.code === 'FACE_COVERED');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ level: 'warning', page: i + 1, slot });
    // 目・鼻・口で測って 0.7 は欠けて見えた（2026-10-28）。0.75 未満は知らせる
    setFit(0.7);
    expect((await recheck(dir, ROOT)).issues.filter((x) => x.code === 'FACE_COVERED')).toHaveLength(1);
    setFit(0.78);
    expect((await recheck(dir, ROOT)).issues.filter((x) => x.code === 'FACE_COVERED')).toEqual([]);
  }, 180_000);
});

describe('写真を作れないとき（残高切れ・2026-10-27 実例）も資料は仕上げる', () => {
  it('2枚目から生成が失敗しても作成は止まらず、作れなかった欄は見本の写真のまま PHOTO_NOT_GENERATED（注意）で知らせる', async () => {
    const outline = readFileSync(path.join(ROOT, 'test/fixtures/short/outline.json'), 'utf8');
    const draft = `{"pages": ${readFileSync(path.join(ROOT, 'test/fixtures/short/draft-01.json'), 'utf8')}}`;
    const ok = fakeGenerator();
    let n = 0;
    const failing = async (req: { prompt: string; size: string; references: Buffer[] }) => {
      if (++n > 1) throw new Error('写真の生成に失敗した（HTTP 429）: {\n  "error": {\n    "message": "You have no credits remaining. Key sk-proj-abcdefgh1234 was used.",\n    "code": "credit_balance_exhausted"\n  }\n}');
      return ok(req);
    };
    const res = await build({ root: ROOT, outDir: tmp, input: path.join(ROOT, 'samples/manuscript-01-short.md'), template: TEMPLATE, transport: photoAwareFake([outline, draft]), imageGenerator: failing, render: false, log: () => {} });
    expect(res.errors).toBe(0);
    const miss = res.issues.filter((x) => x.code === 'PHOTO_NOT_GENERATED');
    expect(miss.length).toBeGreaterThanOrEqual(1);
    expect(miss[0].level).toBe('warning');
    expect(miss[0].message).toMatch(/no credits remaining/);
    expect(miss[0].message).not.toMatch(/sk-proj-abcdefgh/);
    // 作り直しの検査でも同じ注意が出る
    expect((await recheck(res.dir, ROOT)).issues.filter((x) => x.code === 'PHOTO_NOT_GENERATED')).toHaveLength(miss.length);
  });
});

describe('顔を入れない写真の欄（photos.faceless・D-042）', () => {
  it('割り当てで「顔を写さない」と伝え、生成でも顔を写さないよう指示する。顔が写ったら作り直し、顔の無い写真に替える', async () => {
    const { preparePhotos } = await import('../src/photos/plan-photos.js');
    const { NO_FACE_HINT } = await import('../src/photos/visibility.js');
    const { buildFixtureCatalog, CONFIG } = await import('./helpers.js');
    expect(CONFIG.photos.faceless['numbers/3']).toContain('img.side');
    const catalog = await buildFixtureCatalog();
    const page = (type: string) => ({ type, slots: {}, photos: {}, outlinePage: 1, trimmed: [], phraseBroken: [], rewrites: 0 });
    const plan: DeckPlan = { version: 1, deckTitle: 't', template: { file: 'x', sha256: 'x' }, pages: [page('numbers/3')] };
    const calls: string[] = [];
    // 1枚目は顔のある写真（見本の女性）、作り直しは顔の無い写真を返す
    const generator = async (req: { prompt: string; size: string; references: Buffer[] }) => {
      calls.push(req.prompt);
      const [w, h] = req.size.split('x').map(Number);
      const jpeg =
        calls.length === 1
          ? await sharp(path.join(ROOT, 'templates/provisional-assets/cover.jpg')).resize(w, h, { fit: 'cover' }).jpeg().toBuffer()
          : await sharp({ create: { width: w / 8, height: h / 8, channels: 3, background: '#8899aa' } }).jpeg().toBuffer();
      return { jpeg, usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.01, ms: 1, withReferences: req.references.length };
    };
    const { fakeTransport } = await import('./helpers.js');
    const t = fakeTransport([JSON.stringify({ cast: 'Japanese factory workers in grey uniforms.', assignments: [{ id: 'p01/img.side', use: 'gen:1', scene: 'A worker at a machine.' }] })]);
    const dir = path.join(tmp, 'faceless');
    await preparePhotos({ plan, catalog, cfg: CONFIG, manuscript: '原稿', library: null, dir, generator, ai: { transport: t, modelId: 'claude-sonnet-5-5', record: () => {} } });
    expect(t.requests[0].user).toMatch(/img\.side[^\n]*顔を写さない/);
    expect(calls[0]).toContain(NO_FACE_HINT);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain(NO_FACE_HINT);
    expect(plan.pages[0].photoFit!['img.side'].faces).toBe(0);
  }, 120_000);

  it('顔が隠れて作り直すときは、欄が広くても「顔は1人だけ」と生成に伝える（2026-10-28 表紙の実例）', async () => {
    const { preparePhotos } = await import('../src/photos/plan-photos.js');
    const { buildFixtureCatalog, CONFIG, fakeTransport } = await import('./helpers.js');
    const catalog = await buildFixtureCatalog();
    const page = (type: string) => ({ type, slots: {}, photos: {}, outlinePage: 1, trimmed: [], phraseBroken: [], rewrites: 0 });
    const plan: DeckPlan = { version: 1, deckTitle: 't', template: { file: 'x', sha256: 'x' }, pages: [page('attention')] };
    // 上の 45% が図形に隠れる欄（見えている部分は半分を超える＝狭い欄の決まりでは「1人」と言わない）
    const topHidden: VisGrid = { cols: 40, rows: 40, v: Array.from({ length: 1600 }, (_, i) => (Math.floor(i / 40) < 18 ? 0 : 1)) };
    expect(openAreaHint(topHidden)).not.toMatch(/Only ONE/);
    const calls: string[] = [];
    const generator = async (req: { prompt: string; size: string; references: Buffer[] }) => {
      calls.push(req.prompt);
      const [w, h] = req.size.split('x').map(Number);
      const jpeg = await sharp(path.join(ROOT, 'templates/provisional-assets/cover.jpg')).resize(w, h, { fit: 'cover' }).jpeg().toBuffer();
      return { jpeg, usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.01, ms: 1, withReferences: req.references.length };
    };
    const t = fakeTransport([JSON.stringify({ cast: 'Japanese office workers in a bright office.', assignments: [{ id: 'p01/img.hero', use: 'gen:1', scene: 'A woman works at a laptop.' }] })]);
    await preparePhotos({ plan, catalog, cfg: CONFIG, manuscript: '原稿', library: null, dir: path.join(tmp, 'oneface'), generator, visibility: { attention: { 'img.hero': topHidden } }, ai: { transport: t, modelId: 'claude-sonnet-5-5', record: () => {} } });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]).not.toMatch(/Only ONE/);
    expect(calls[1]).toMatch(/Only ONE person's face/);
  }, 120_000);

  it('割り当てが抜けた欄は、作った写真を使い回して埋める（同じページで重ねず、回数の上限を守る）。使える写真が無ければ見本のまま', async () => {
    const { fillMissing, TEMPLATE_PHOTO } = await import('../src/photos/plan-photos.js');
    const { CONFIG } = await import('./helpers.js');
    const req = (id: string, page: number) => ({ id, page, slot: id.split('/')[1], want: '', aspect: 1 });
    const reqs = [req('p01/img.a', 1), req('p01/img.b', 1), req('p02/img.a', 2), req('p03/img.a', 3)];
    const filled = fillMissing({ cast: 'x'.repeat(10), assignments: [{ id: 'p01/img.a', use: 'gen:1', scene: 's' }, { id: 'p02/img.a', use: 'gen:1' }] }, reqs, CONFIG);
    const by = Object.fromEntries(filled.assignments.map((x) => [x.id, x.use]));
    // gen:1 は2回使い切り（上限2）、p01 では使用済み → 使える写真が無い
    expect(by['p01/img.b']).toBe(TEMPLATE_PHOTO);
    expect(by['p03/img.a']).toBe(TEMPLATE_PHOTO);
    const filled2 = fillMissing({ cast: 'x'.repeat(10), assignments: [{ id: 'p01/img.a', use: 'gen:1', scene: 's' }, { id: 'p02/img.a', use: 'gen:2', scene: 's' }] }, reqs, CONFIG);
    const by2 = Object.fromEntries(filled2.assignments.map((x) => [x.id, x.use]));
    expect(by2['p01/img.b']).toBe('gen:2');
    expect(['gen:1', 'gen:2']).toContain(by2['p03/img.a']);
    // 場面は、その写真を最初に使う欄に置く（生成は最初に使う欄の場面で作る）
    const early = fillMissing({ cast: 'x'.repeat(10), assignments: [{ id: 'p03/img.a', use: 'gen:5', scene: 'late scene' }] }, [req('p01/img.a', 1), req('p03/img.a', 3)], CONFIG);
    expect(early.assignments.find((x) => x.id === 'p01/img.a')).toMatchObject({ use: 'gen:5', scene: 'late scene' });
    expect(early.assignments.find((x) => x.id === 'p03/img.a')!.scene).toBeUndefined();
  });
});

describe('顔を入れない欄と、写真の使い回し', () => {
  it('写真に色を重ねる欄（乗算）は、顔を入れない欄として扱う（先方の見本でも青く着色した写真は建物）', async () => {
    const { isFaceless } = await import('../src/photos/plan-photos.js');
    const { CONFIG } = await import('./helpers.js');
    expect(CONFIG.images['img.left'].multiply).toBeTruthy();
    expect(isFaceless(CONFIG, 'photo-text/a', 'img.left')).toBe(true);
    expect(isFaceless(CONFIG, 'photo-text/a', 'img.right')).toBe(false);
    expect(isFaceless(CONFIG, 'cover', 'img.hero')).toBe(false);
  });
  it('顔を写さない欄と写してよい欄で、同じ写真を使い回すと割り当てをやり直させる。補うときも混ぜない', async () => {
    const { separateFaceless, fillMissing, TEMPLATE_PHOTO } = await import('../src/photos/plan-photos.js');
    const { CONFIG } = await import('./helpers.js');
    const req = (id: string, page: number) => ({ id, page, slot: id.split('/')[1], want: '', aspect: 1 });
    const reqs = [req('p01/img.hero', 1), req('p02/img.side', 2), req('p03/img.side', 3)];
    const faceless = (r: { slot: string }) => r.slot === 'img.side';
    const mixed = { cast: 'x'.repeat(10), assignments: [{ id: 'p01/img.hero', use: 'gen:1', scene: 's' }, { id: 'p02/img.side', use: 'gen:1' }, { id: 'p03/img.side', use: 'gen:2', scene: 's' }] };
    // 混ざった割り当ては、コードが分ける（顔を写さない欄の p02 は gen:1 から外れる）
    expect(separateFaceless(mixed, reqs, CONFIG, faceless).assignments.find((x) => x.id === 'p02/img.side')!.use).not.toBe('gen:1');
    const filled = fillMissing({ cast: 'x'.repeat(10), assignments: [{ id: 'p01/img.hero', use: 'gen:1', scene: 's' }, { id: 'p03/img.side', use: 'gen:2', scene: 's' }] }, reqs, CONFIG, faceless);
    expect(filled.assignments.find((x) => x.id === 'p02/img.side')!.use).toBe('gen:2');
    const none = fillMissing({ cast: 'x'.repeat(10), assignments: [{ id: 'p01/img.hero', use: 'gen:1', scene: 's' }, { id: 'p03/img.side', use: 'gen:3', scene: 's' }, { id: 'p04/img.side', use: 'gen:3' }] }, [...reqs, req('p04/img.side', 4)], CONFIG, faceless);
    expect(none.assignments.find((x) => x.id === 'p02/img.side')!.use).toBe(TEMPLATE_PHOTO);
  });
});

describe('割り当ての分けと、顔の向き', () => {
  it('顔を写さない欄と写してよい欄で使い回していたら、コードが顔を写さない欄の側を分ける（AI に3回やり直させて止めない）', async () => {
    const { separateFaceless, assignProblems } = await import('../src/photos/plan-photos.js');
    const { CONFIG } = await import('./helpers.js');
    const req = (id: string, page: number) => ({ id, page, slot: id.split('/')[1], want: '', aspect: 1 });
    const reqs = [req('p01/img.hero', 1), req('p02/img.side', 2), req('p03/img.side', 3)];
    const faceless = (r: { slot: string }) => r.slot === 'img.side';
    const mixed = { cast: 'x'.repeat(10), assignments: [{ id: 'p01/img.hero', use: 'gen:1', scene: 'two workers talk' }, { id: 'p02/img.side', use: 'gen:1' }, { id: 'p03/img.side', use: 'gen:2', scene: 'machines' }] };
    const fixed = separateFaceless(mixed, reqs, CONFIG, faceless);
    // 顔を写さない欄だけで使っている gen:2 を回す
    expect(fixed.assignments.find((x) => x.id === 'p02/img.side')!.use).toBe('gen:2');
    expect(assignProblems(fixed, reqs, [], CONFIG)).toBeNull();
    // 分けたあとは、どの生成写真も「顔を写さない欄だけ」か「写してよい欄だけ」で使う
    for (const u of new Set(fixed.assignments.map((x) => x.use))) expect(new Set(fixed.assignments.filter((x) => x.use === u).map((x) => faceless(reqs.find((r) => r.id === x.id)!))).size).toBe(1);
    // 回せる写真が無ければ、同じ場面で新しく作る
    const only = separateFaceless({ cast: 'x'.repeat(10), assignments: [{ id: 'p01/img.hero', use: 'gen:1', scene: 'two workers talk' }, { id: 'p02/img.side', use: 'gen:1' }] }, reqs.slice(0, 2), CONFIG, faceless);
    expect(only.assignments.find((x) => x.id === 'p02/img.side')).toMatchObject({ use: 'gen:2', scene: 'two workers talk' });
    // 生成の上限（maxGenerate）に達していても、見本の写真には戻さず新しく作る（工場の資料にオフィスの見本写真が入った）
    const full = { cast: 'x'.repeat(10), assignments: [{ id: 'p01/img.hero', use: 'gen:1', scene: 'two workers talk' }, { id: 'p02/img.side', use: 'gen:1' }] };
    const capped = separateFaceless(full, reqs.slice(0, 2), { ...CONFIG, photos: { ...CONFIG.photos, maxGenerate: 1 } }, faceless);
    expect(capped.assignments.find((x) => x.id === 'p02/img.side')!.use).toBe('gen:2');
  });
  it('構図の指示で、顔はカメラに向ける（横顔・うつむきにしない）と伝える。顔の検出が横顔を見逃すため', () => {
    expect(openAreaHint(leftHidden)).toMatch(/turned toward the camera[^.]*not in profile and not looking down/);
  });
});
