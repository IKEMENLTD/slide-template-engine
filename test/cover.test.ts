/**
 * 表紙の型を内容で選ぶ（D-044）。先方の指摘「表紙のトピックス的な3項目の扱いが対応しきれない部分がありそう。
 * レイアウトのパターンを他に用意するといいのかも」への対応。
 * 要点の箱が3つある表紙は、原稿に柱となる要点が3つあるときだけ。無ければ見出しだけの表紙かコラージュ。
 */
import { describe, expect, it } from 'vitest';
import { draftProblems } from '../src/plan/plan.js';
import { outlineInstruction } from '../src/plan/prompts.js';
import type { Outline, PlanPage } from '../src/plan/schema.js';
import { buildFixtureCatalog, CONFIG } from './helpers.js';

const cover = (details: string[] | undefined): Outline['pages'][number] =>
  ({ purpose: '表紙', role: 'cover', catch: '題', sourceQuotes: ['題'], ...(details ? { details } : {}) }) as Outline['pages'][number];
const fill = (type: string, names: string[]): PlanPage => ({ type, slots: Object.fromEntries(names.map((n) => [n, '文言'])), photos: {} }) as PlanPage;

describe('表紙の型', () => {
  it('テンプレートに表紙が3通りある（要点3つ・見出しだけ・コラージュ）', async () => {
    const cat = await buildFixtureCatalog();
    const covers = cat.types.filter((t) => t.role.includes('cover')).map((t) => t.key).sort();
    expect(covers).toEqual(['collage', 'cover', 'cover/plain']);
    const plain = cat.types.find((t) => t.key === 'cover/plain')!;
    expect(plain.slots.some((s) => s.name.startsWith('txt.point.'))).toBe(false);
    expect(plain.slots.map((s) => s.name)).toEqual(expect.arrayContaining(['txt.headline', 'txt.subtitle', 'img.hero']));
  });

  it('原稿の要点が3つ無いのに要点の箱の表紙を選んだら、箱の無い表紙を選び直させる', async () => {
    const cat = await buildFixtureCatalog();
    const t = cat.types.find((x) => x.key === 'cover')!;
    const page = fill('cover', t.slots.filter((s) => s.kind !== 'img').map((s) => s.name));
    const msg = draftProblems([page], 1, cat, CONFIG, [], [cover(undefined)]);
    expect(msg).toMatch(/要点の箱の無い表紙（.*cover\/plain/);
    expect(draftProblems([page], 1, cat, CONFIG, [], [cover(['a', 'b'])])).toMatch(/要点（details）は 2 つ/);
    // 要点が3つあれば、要点の箱の表紙でよい
    expect(draftProblems([page], 1, cat, CONFIG, [], [cover(['a', 'b', 'c'])])).toBeNull();
  });

  it('見出しだけの表紙は、要点が無くても通る', async () => {
    const cat = await buildFixtureCatalog();
    const t = cat.types.find((x) => x.key === 'cover/plain')!;
    const page = fill('cover/plain', t.slots.filter((s) => s.kind !== 'img').map((s) => s.name));
    expect(draftProblems([page], 1, cat, CONFIG, [], [cover(undefined)])).toBeNull();
  });

  it('ページ割りの指示で、表紙の要点を作らせない', async () => {
    const cat = await buildFixtureCatalog();
    expect(outlineInstruction(cat, CONFIG)).toMatch(/要点がちょうど3つあるときだけ.*details は空にする/);
  });
});
