/**
 * E段：見た目の採点・白黒の比（REQUIREMENTS 11章 VISUAL_REVIEW・LIGHT_DARK_RATIO）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { checkLightDark, lightDarkRatio } from '../src/check/light-dark.js';
import { latestReview, pagesToRedo, reviewIssues, ReviewSchema } from '../src/review/visual.js';
import { renderIssues, untar } from '../src/render/render.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'slidegen-review-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** 左 w 割が黒、残りが白の画像 */
async function split(name: string, darkShare: number) {
  const f = path.join(tmp, name);
  const W = 100;
  await sharp({ create: { width: W, height: 10, channels: 3, background: '#ffffff' } })
    .composite(darkShare > 0 ? [{ input: await sharp({ create: { width: Math.round(W * darkShare), height: 10, channels: 3, background: '#111111' } }).png().toBuffer(), left: 0, top: 0 }] : [])
    .png()
    .toFile(f);
  return f;
}

describe('LIGHT_DARK_RATIO（白：黒）', () => {
  const cfg = { enabled: true, target: 1.5, tolerance: 0.3, darkBelow: 0.5 };
  it('白：黒＝3：2 は通り、1：1 や白だけは注意', async () => {
    expect(await lightDarkRatio(await split('a.png', 0.4), 0.5)).toBeCloseTo(1.5, 2);
    const ok = await checkLightDark([await split('b.png', 0.4)], cfg);
    expect(ok).toEqual([]);
    const bad = await checkLightDark([await split('c.png', 0.5), await split('d.png', 0)], cfg);
    expect(bad.map((i) => [i.code, i.level, i.page])).toEqual([
      ['LIGHT_DARK_RATIO', 'warning', 1],
      ['LIGHT_DARK_RATIO', 'warning', 2],
    ]);
  });
  it('設定で無効なら何も出さない（16章 #4 の回答まで）', async () => {
    expect(await checkLightDark([await split('e.png', 0.5)], { ...cfg, enabled: false })).toEqual([]);
  });
});

describe('見た目の採点の結果の扱い', () => {
  it('作り直すのは、redo で文言の指摘があるページだけ（写真だけの指摘は作り直さない）', () => {
    const r = ReviewSchema.parse({
      pages: [
        { page: 1, verdict: 'ok', problems: [] },
        { page: 2, verdict: 'redo', problems: [{ kind: 'text', slot: 'txt.headline', message: '弱い' }] },
        { page: 3, verdict: 'redo', problems: [{ kind: 'photo', message: '顔が切れている' }] },
        { page: 4, verdict: 'ok', problems: [{ kind: 'photo', message: '内容と合わない' }] },
      ],
    });
    expect(pagesToRedo(r.pages)).toEqual([2]);
  });
  it('VISUAL_REVIEW：残った指摘は注意としてレポートに出し、指摘が無ければ何も出さない', () => {
    const rounds = [
      { pages: [1, 2], review: [{ page: 1, verdict: 'ok' as const, problems: [] }, { page: 2, verdict: 'redo' as const, problems: [{ kind: 'text' as const, slot: 'txt.headline', message: '弱い' }] }] },
      { pages: [2], review: [{ page: 2, verdict: 'ok' as const, problems: [{ kind: 'photo' as const, message: '顔が切れている' }] }] },
    ];
    const last = latestReview(rounds);
    // 2回目の採点で p2 の文言の指摘は消え、写真の指摘だけが残る
    expect(reviewIssues(last).map((i) => [i.code, i.level, i.page, i.message])).toEqual([['VISUAL_REVIEW', 'warning', 2, '写真: 顔が切れている']]);
    expect(reviewIssues(latestReview([{ pages: [1], review: [{ page: 1, verdict: 'ok', problems: [] }] }]))).toEqual([]);
  });
});

describe('描画の結果の受け取り（tar）', () => {
  it('ustar を読む', () => {
    const hdr = (name: string, size: number) => {
      const h = Buffer.alloc(512);
      h.write(name, 0);
      h.write(size.toString(8).padStart(11, '0') + '\0', 124);
      h.write('0', 156);
      return h;
    };
    const body = Buffer.from('%PDF-1.7');
    const tar = Buffer.concat([hdr('./deck.pdf', body.length), body, Buffer.alloc(512 - body.length), Buffer.alloc(1024)]);
    expect(untar(tar).get('deck.pdf')?.toString()).toBe('%PDF-1.7');
  });
});

describe('描画の結果の検査', () => {
  it('代わりの字体（DejaVu）で描かれたら止める。テンプレートの字体だけなら何も出さない', () => {
    expect(renderIssues({ fonts: ['Barlow-Regular', 'NotoSansJP-Bold-VKana'], pages: ['1', '2'] }, 2)).toEqual([]);
    expect(renderIssues({ fonts: ['Barlow-Regular', 'DejaVuSans'], pages: ['1', '2'] }, 2).map((i) => [i.code, i.level])).toEqual([['PPTX_REPAIR', 'error']]);
    expect(renderIssues({ fonts: [], pages: ['1'] }, 2).map((i) => i.code)).toEqual(['SLIDE_COUNT']);
  });
});

