/**
 * C段：写真の用意（REQUIREMENTS 7章C・10章・15章 Phase 3）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import type { AiCallRecord } from '../src/ai/call-json.js';
import { photoPrompt, sizeFor } from '../src/photos/openai-image.js';
import { assignProblems, collectRequests, preparePhotos, type PhotoAssign, type PhotoRequest } from '../src/photos/plan-photos.js';
import { loadPhotoLibrary, processPhoto } from '../src/photos/prepare.js';
import type { DeckPlan } from '../src/plan/schema.js';
import { buildFixtureCatalog, CONFIG, fakeGenerator, photoAwareFake, ROOT } from './helpers.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'slidegen-photo-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const lib = loadPhotoLibrary(path.join(ROOT, 'assets/photos'));
const reqs: PhotoRequest[] = [
  { id: 'p01/img.a', page: 1, slot: 'img.a', want: '', aspect: 1 },
  { id: 'p01/img.b', page: 1, slot: 'img.b', want: '', aspect: 1 },
  { id: 'p02/img.a', page: 2, slot: 'img.a', want: '', aspect: 1 },
];
const A = (assignments: PhotoAssign['assignments']): PhotoAssign => ({ cast: 'A Japanese woman in a navy jacket.', assignments });

describe('写真の割り当ての決まり', () => {
  it('正しい割り当ては通る（生成写真を別のページで使い回すのは可）', () => {
    expect(assignProblems(A([{ id: 'p01/img.a', use: '01.jpg' }, { id: 'p01/img.b', use: 'gen:1', scene: 'x' }, { id: 'p02/img.a', use: 'gen:1' }]), reqs, lib, CONFIG)).toBeNull();
  });
  it('同じページで同じ写真・無いファイル・割り当て漏れ・場面の無い生成は止める', () => {
    expect(assignProblems(A([{ id: 'p01/img.a', use: '01.jpg' }, { id: 'p01/img.b', use: '01.jpg' }, { id: 'p02/img.a', use: '02.jpg' }]), reqs, lib, CONFIG)).toMatch(/同じページで2回/);
    expect(assignProblems(A([{ id: 'p01/img.a', use: '99.jpg' }, { id: 'p01/img.b', use: '01.jpg' }, { id: 'p02/img.a', use: '02.jpg' }]), reqs, lib, CONFIG)).toMatch(/支給の写真に無い/);
    expect(assignProblems(A([{ id: 'p01/img.a', use: '01.jpg' }]), reqs, lib, CONFIG)).toMatch(/割り当てが無い欄/);
    expect(assignProblems(A([{ id: 'p01/img.a', use: 'gen:1' }, { id: 'p01/img.b', use: '01.jpg' }, { id: 'p02/img.a', use: '02.jpg' }]), reqs, lib, CONFIG)).toMatch(/scene が無い/);
  });
  it('1枚を使う回数・生成の枚数の上限を超えると止める', () => {
    const cfg = { ...CONFIG, photos: { ...CONFIG.photos, maxUsesPerFile: 1, maxGenerate: 1 } };
    expect(assignProblems(A([{ id: 'p01/img.a', use: '01.jpg' }, { id: 'p01/img.b', use: '02.jpg' }, { id: 'p02/img.a', use: '01.jpg' }]), reqs, lib, cfg)).toMatch(/2 回使っている/);
    expect(assignProblems(A([{ id: 'p01/img.a', use: 'gen:1', scene: 'a' }, { id: 'p01/img.b', use: 'gen:2', scene: 'b' }, { id: 'p02/img.a', use: '01.jpg' }]), reqs, lib, cfg)).toMatch(/生成が 2 枚/);
  });
});

describe('写真の加工（枠の比・モノクロ・乗算）', () => {
  const src = path.join(ROOT, 'assets/photos/01.jpg');
  it('枠の縦横比に切り抜き、モノクロにする', async () => {
    const out = path.join(tmp, 'mono.jpg');
    await processPhoto(src, out, 0.4426, { mono: true, multiply: null }, null);
    const m = await sharp(out).metadata();
    expect(m.width! / m.height!).toBeCloseTo(0.4426, 2);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    if (info.channels >= 3) for (let i = 0; i < data.length; i += info.channels * 997) expect(Math.abs(data[i] - data[i + 2])).toBeLessThanOrEqual(3);
  });
  it('乗算：白いところはその色になり、暗いところは暗いまま（下の写真が透けて見える）', async () => {
    const grad = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#ffffff' } })
      .composite([{ input: await sharp({ create: { width: 100, height: 100, channels: 3, background: '#404040' } }).png().toBuffer(), left: 100, top: 0 }])
      .png()
      .toBuffer();
    const inFile = path.join(tmp, 'grad.png');
    await sharp(grad).toFile(inFile);
    const out = path.join(tmp, 'mul.jpg');
    await processPhoto(inFile, out, 2, { mono: true, multiply: 'accent1' }, '0064D6');
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
    const white = px(20, 50);
    const dark = px(info.width - 20, 50);
    // 白の上は accent1（#0064D6）に近い
    expect(white[0]).toBeLessThan(25);
    expect(Math.abs(white[1] - 0x64)).toBeLessThan(15);
    expect(Math.abs(white[2] - 0xd6)).toBeLessThan(15);
    // 暗いところはさらに暗い青（写真の濃淡が残る＝ベタ塗りではない）
    expect(dark[2]).toBeLessThan(white[2] - 80);
    expect(dark[2]).toBeGreaterThan(20);
  });
});

describe('写真の生成', () => {
  it('プロンプトに必須事項（文字を入れない・日本人・自然光・同じ人物と場所）が入る', () => {
    const p = photoPrompt('Same Japanese factory worker in a gray uniform.', 'Adjusting a machine.', true);
    expect(p).toMatch(/no text, letters, numbers, logos/);
    expect(p).toMatch(/All people are Japanese/);
    expect(p).toMatch(/Natural daylight/);
    expect(p).toMatch(/gray uniform/);
    expect(p).toMatch(/reference images only to keep the same people/);
    expect(photoPrompt('c', 's', false)).not.toMatch(/reference images/);
  });
  it('枠の形に近いサイズで作る', () => {
    expect(sizeFor(0.44)).toBe('1024x1536');
    expect(sizeFor(1)).toBe('1024x1024');
    expect(sizeFor(1.5)).toBe('1536x1024');
  });

  it('2枚目からは作った写真を見本に渡す。作った写真は保存し、再開しても作り直さない', async () => {
    const catalog = await buildFixtureCatalog();
    const page = (type: string, photos: Record<string, string>) => ({ type, slots: {}, photos, outlinePage: 1, trimmed: [], phraseBroken: [], rewrites: 0 });
    const mk = (): DeckPlan => ({ version: 1, deckTitle: 't', template: { file: 'x', sha256: 'x' }, pages: [page('steps/4', {}), page('issues/4', {}), page('photo-text/a', {})] });
    const dir = path.join(tmp, 'run');
    const records: AiCallRecord[] = [];
    const gen = fakeGenerator();
    const plan = mk();
    const args = { plan, catalog, cfg: CONFIG, manuscript: '原稿', library: path.join(ROOT, 'assets/photos'), dir, generator: gen, ai: { transport: photoAwareFake([]), modelId: 'claude-sonnet-5-5', record: (r: AiCallRecord) => records.push(r) } };
    const res = await preparePhotos(args);
    const slots = collectRequests(plan, catalog).length;
    expect(res.records).toHaveLength(slots);
    expect(res.records.every((r) => r.source !== 'template')).toBe(true);
    expect(gen.calls.length).toBe(res.generated.length);
    expect(gen.calls[0].references).toBe(0);
    expect(gen.calls.slice(1).every((c) => c.references >= 1)).toBe(true);
    expect(existsSync(path.join(dir, 'photos/generated-sheet.jpg'))).toBe(true);
    // 乗算を指定した欄（img.left）は、加工した写真が青みを帯びる
    const left = plan.pages[2].photoFiles!['img.left'];
    const { data } = await sharp(path.join(dir, 'photos', left)).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
    expect(data[2]).toBeGreaterThan(data[0] + 30);
    // 再開：生成も割り当ても呼び直さない
    const gen2 = fakeGenerator();
    const t2 = photoAwareFake([]);
    await preparePhotos({ ...args, plan: mk(), generator: gen2, ai: { ...args.ai, transport: t2 } });
    expect(gen2.calls).toHaveLength(0);
    expect(t2.requests).toHaveLength(0);
    expect(JSON.parse(readFileSync(path.join(dir, 'photos/generated.json'), 'utf8'))).toHaveLength(res.generated.length);
  });
});
