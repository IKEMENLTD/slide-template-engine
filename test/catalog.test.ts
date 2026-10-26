import { readFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/catalog/build-catalog.js';
import { loadConfig, type TemplateConfig } from '../src/catalog/config.js';
import { readTemplate } from '../src/catalog/read-template.js';
import { fitSlot } from '../src/fit/fit-slot.js';
import { splitEmphasis } from '../src/assemble/replace-text.js';

const ROOT = path.join(import.meta.dirname, '..');
const TPL = readFileSync(path.join(ROOT, 'templates/provisional.pptx'));
const CFG = loadConfig(path.join(ROOT, 'templates/provisional.config.json'));
const ctx = { file: 'templates/provisional.pptx', sha256: 'test', resolveFile: (p: string) => path.join(ROOT, p) };

async function build(buf: Buffer = TPL, cfg: TemplateConfig = CFG) {
  return buildCatalog(await readTemplate(buf), cfg, ctx);
}
async function mutate(fn: (z: JSZip) => Promise<void>) {
  const z = await JSZip.loadAsync(TPL);
  await fn(z);
  return z.generateAsync({ type: 'nodebuffer' });
}
const errors = (p: { level: string; message: string }[]) => p.filter((x) => x.level === 'error').map((x) => x.message);

describe('型カタログ', () => {
  it('仮テンプレートから15の型が出て、文字の欄すべてに最大字数と最大行数が入る', async () => {
    const { catalog, problems } = await build();
    expect(errors(problems)).toEqual([]);
    expect(catalog.types.map((t) => t.key)).toEqual(['cover', 'issues/2', 'issues/3', 'issues/4', 'numbers/3', 'attention', 'section', 'steps/3', 'steps/4', 'collage', 'toc/3', 'toc/4', 'toc/5', 'photo-text/a', 'photo-text/b']);
    for (const t of catalog.types)
      for (const s of t.slots) {
        if (s.kind === 'img') expect(s.aspect).toBeGreaterThan(0);
        else {
          expect(s.maxChars, `${t.key} ${s.name}`).toBeGreaterThan(0);
          expect(s.maxLines, `${t.key} ${s.name}`).toBeGreaterThan(0);
        }
      }
  });

  it('設定の上書きが効く。「型/変種」は「型」より優先し、他の変種には効かない', async () => {
    const cfg: TemplateConfig = structuredClone(CFG);
    cfg.slots = { issues: { 'txt.item.*.title': { maxChars: 12 } }, 'issues/4': { 'txt.item.*.title': { maxChars: 8, maxLines: 1 } } };
    const { catalog, problems } = await build(TPL, cfg);
    expect(errors(problems)).toEqual([]);
    const title = (key: string) => catalog.types.find((t) => t.key === key)!.slots.find((s) => s.name === 'txt.item.1.title')!;
    expect(title('issues/4')).toMatchObject({ maxChars: 8, maxLines: 1, override: { from: 'issues/4 › txt.item.*.title' } });
    expect(title('issues/2')).toMatchObject({ maxChars: 12, maxLines: 2, override: { from: 'issues › txt.item.*.title' } });
    // 上書きしても、測った値は残る
    expect(title('issues/4').measured!.maxLines).toBe(2);
  });

  it('どの欄にも当たらない上書きは止める（書き間違いに気づくため）', async () => {
    const cfg: TemplateConfig = structuredClone(CFG);
    cfg.slots = { 'issues/4': { 'txt.itme.*': { maxChars: 8 } } };
    expect(errors((await build(TPL, cfg)).problems).join()).toContain('どの型・欄にも当たらない');
  });

  it('ノートに型の情報が無いスライドは止める', async () => {
    const buf = await mutate(async (z) => {
      const n = Object.keys(z.files).find((f) => /notesSlide\d+\.xml$/.test(f))!;
      const x = await z.file(n)!.async('string');
      z.file(n, x.replace(/type: cover/, 'kata: cover'));
    });
    expect(errors((await build(buf)).problems).join()).toContain('type が無い');
  });

  it('文字を縮めて収める設定（自動縮小）が入った欄は止める', async () => {
    const buf = await mutate(async (z) => {
      const x = await z.file('ppt/slides/slide1.xml')!.async('string');
      z.file('ppt/slides/slide1.xml', x.replace('<a:noAutofit/>', '<a:normAutofit/>'));
    });
    expect(errors((await build(buf)).problems).join()).toContain('自動縮小');
  });

  it('字体の実フォントが設定に無いと止める', async () => {
    const cfg: TemplateConfig = structuredClone(CFG);
    delete cfg.fonts['Noto Serif JP'];
    expect(errors((await build(TPL, cfg)).problems).join()).toContain('Noto Serif JP');
  });

  it('同じ型が2つあると止める', async () => {
    const buf = await mutate(async (z) => {
      // 課題（3項目）のノートを「2」に書き換える
      const n = 'ppt/notesSlides/notesSlide3.xml';
      const x = await z.file(n)!.async('string');
      z.file(n, x.replace('<a:t>variant: "3"</a:t>', '<a:t>variant: "2"</a:t>'));
    });
    const { problems } = await build(buf);
    expect(errors(problems).join()).toContain('重複');
  });
});

describe('欄に収まるか（fitSlot）', () => {
  it('先方 PDF の文言は収まり、長すぎる文言は理由つきで落ちる', async () => {
    const { catalog } = await build();
    const t = catalog.types.find((x) => x.key === 'issues/4')!;
    const s = t.slots.find((x) => x.name === 'txt.headline')!;
    const ok = fitSlot(s, '経営の現場で、こんな限界を感じていませんか？', catalog.fit, ctx.resolveFile);
    expect(ok.ok).toBe(true);
    const ng = fitSlot(s, '経営の現場で、こんな限界を感じていませんか？毎日の業務に追われて', catalog.fit, ctx.resolveFile);
    expect(ng.ok).toBe(false);
    expect(ng.reason).toMatch(/最大\d+字×1行/);
  });

  it('折り返さない欄（斜めの英字）は、1行に入らなければ落ちる', async () => {
    const { catalog } = await build();
    const s = catalog.types.find((x) => x.key === 'issues/4')!.slots.find((x) => x.name === 'txt.eyebrow')!;
    expect(fitSlot(s, 'Company Issues', catalog.fit, ctx.resolveFile).ok).toBe(true);
    expect(fitSlot(s, 'Company Issues and Challenges', catalog.fit, ctx.resolveFile).ok).toBe(false);
  });
});

describe('強調の印', () => {
  it('[[語]] を分ける', () => {
    expect(splitEmphasis('こんな[[限界]]を')).toEqual([
      { text: 'こんな', emphasis: false },
      { text: '限界', emphasis: true },
      { text: 'を', emphasis: false },
    ]);
  });
  it('印の対応が崩れていたら例外（印を残したまま出さない）', () => {
    expect(() => splitEmphasis('こんな[[限界を')).toThrow();
  });
});
