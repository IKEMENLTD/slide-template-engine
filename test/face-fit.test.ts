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
import { measure, openAreaHint, visibleIn, type VisGrid } from '../src/photos/visibility.js';
import { build, recheck } from '../src/run/build.js';
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
  it('支給の写真（反転しない）で逃がせないなら、見えていない割合をそのまま返す（検査で知らせる）', () => {
    const c = chooseCrop(1000, 600, 1, [face(100, 200)], { grid: leftHidden, allowFlip: false });
    expect(c.flipped).toBe(false);
    expect(c.faceVisible).toBeLessThan(0.6);
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
    setFit(0.9);
    expect((await recheck(dir, ROOT)).issues.filter((x) => x.code === 'FACE_COVERED')).toEqual([]);
  });
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
