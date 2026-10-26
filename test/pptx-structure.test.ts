import { readFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { checkPptxStructure } from '../src/check/pptx-structure.js';
import { sanitizePptx } from '../src/assemble/sanitize.js';

const TEMPLATE = readFileSync(path.join(import.meta.dirname, '../templates/probe/probe.pptx'));

async function mutate(fn: (zip: JSZip) => Promise<void>) {
  const zip = await JSZip.loadAsync(TEMPLATE);
  await fn(zip);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const codes = async (buf: Buffer) => (await checkPptxStructure(buf)).map((i) => i.code);

describe('PPTX_REPAIR 構造検査', () => {
  it('正しいテンプレートは通る', async () => {
    expect(await checkPptxStructure(TEMPLATE)).toEqual([]);
  });

  it('参照先の画像が無いと落ちる', async () => {
    const buf = await mutate(async (z) => {
      for (const n of Object.keys(z.files)) if (n.startsWith('ppt/media/')) z.remove(n);
    });
    expect(await codes(buf)).toContain('REL_TARGET_MISSING');
  });

  it('外したスライドとノートが互いに参照し合って残っていても、孤立として落ちる', async () => {
    const buf = await mutate(async (z) => {
      const p = 'ppt/_rels/presentation.xml.rels';
      const xml = await z.file(p)!.async('string');
      const id = xml.match(/Id="(rId\d+)"[^>]*Target="slides\/slide2\.xml"/)![1];
      z.file(p, xml.replace(new RegExp(`<Relationship Id="${id}"[^>]*/>`), ''));
      const pres = await z.file('ppt/presentation.xml')!.async('string');
      z.file('ppt/presentation.xml', pres.replace(new RegExp(`<p:sldId [^>]*r:id="${id}"/>`), ''));
    });
    const c = await codes(buf);
    expect(c).toContain('ORPHAN_PART');
    expect(c).not.toContain('REL_ID_UNDEFINED');
  });

  it('本文が rels に無い r:embed を使うと落ちる', async () => {
    const buf = await mutate(async (z) => {
      const s = await z.file('ppt/slides/slide1.xml')!.async('string');
      z.file('ppt/slides/slide1.xml', s.replace(/r:embed="[^"]+"/, 'r:embed="rId999"'));
    });
    expect(await codes(buf)).toContain('REL_ID_UNDEFINED');
  });

  it('図形IDが重複すると落ちる', async () => {
    const buf = await mutate(async (z) => {
      const s = await z.file('ppt/slides/slide1.xml')!.async('string');
      const ids = [...s.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
      z.file('ppt/slides/slide1.xml', s.replace(`<p:cNvPr id="${ids[2]}"`, `<p:cNvPr id="${ids[1]}"`));
    });
    expect(await codes(buf)).toContain('SHAPE_ID_DUPLICATE');
  });
});

describe('sanitizePptx', () => {
  it('孤立したスライド・ノート・宙に浮いた画像の関係を外し、検査を通す形にする', async () => {
    const broken = await mutate(async (z) => {
      // automizer の出力で実際に起きた2つの形を再現する
      const p = 'ppt/_rels/presentation.xml.rels';
      const xml = await z.file(p)!.async('string');
      const id = xml.match(/Id="(rId\d+)"[^>]*Target="slides\/slide2\.xml"/)![1];
      z.file(p, xml.replace(new RegExp(`<Relationship Id="${id}"[^>]*/>`), ''));
      const pres = await z.file('ppt/presentation.xml')!.async('string');
      z.file('ppt/presentation.xml', pres.replace(new RegExp(`<p:sldId [^>]*r:id="${id}"/>`), ''));
      const r1 = 'ppt/slides/_rels/slide1.xml.rels';
      const rels = await z.file(r1)!.async('string');
      z.file(r1, rels.replace('</Relationships>', '<Relationship Id="rIdGone" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/gone.png"/></Relationships>'));
    });
    expect((await codes(broken)).length).toBeGreaterThan(0);
    const { buffer } = await sanitizePptx(broken);
    expect(await checkPptxStructure(buffer)).toEqual([]);
    const z = await JSZip.loadAsync(buffer);
    // 使われているスライドの写真は消さない
    expect(Object.keys(z.files).some((n) => n.startsWith('ppt/media/') && !z.files[n].dir)).toBe(true);
    // 型の YAML（ノート）は成果物に残さない
    expect(Object.keys(z.files).some((n) => n.startsWith('ppt/notesSlides/') && !z.files[n].dir)).toBe(false);
  });
});
